#!/usr/bin/env bun
// Temporary HTTP/browser fixtures only. No production data, model, Lean process or email is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { loadWebSample } from '../apps/web/sample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { WebRunner } from '../apps/web/runner';
import type { WebConversation } from '../apps/web/conversationTypes';
import type { WebFormalization } from '../apps/web/formalizationTypes';
import type { ResearchCollaborationInbox } from '../apps/web/researchCollaborationTypes';
import { localeStorageKey } from '../apps/web/i18n';
import { statementConfirmation } from '../apps/web/presentation';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/workspace');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-workspace-'));
const sample = loadWebSample()!, port = await freePort(), origin = `http://127.0.0.1:${port}`;
let fixtureRuns = 0, prohibitedCalls = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Recorded disposable workspace fixture' }; },
  async run(input, send) {
    fixtureRuns++;
    for (const saved of sample.observations) {
      const observation = structuredClone(saved); observation.webRunId = input.id;
      observation.inspection.usage = {};
      observation.inspection.tasks[0].informalProof = 'Telescoping marker: from $a + b = c$ subtract $b$ to obtain $a = c - b$.';
      send({ type: 'observation', observation });
    }
    send({ type: 'result', result: { status: input.input.task.startsWith('Accepted') ? 'evaluated_passed' : 'limit_reached',
      proof: sample.run.result!.proof, report: { usage: input.input.task.startsWith('Unknown') ? {} : { totalTokens: input.input.task.startsWith('Accepted') ? 2400 : 1200 } } } });
  },
  async check() { prohibitedCalls++; throw new Error('Workspace checks may not run Lean'); },
  async formalize() { prohibitedCalls++; throw new Error('Workspace checks may not call a model'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner,
{ mailer: async () => { prohibitedCalls++; throw new Error('Workspace checks may not send mail'); } });
const browser = await startBrowser(service.server, port), errors: string[] = [], external: string[] = [], checks: object[] = [];
let active: Page | undefined, phase = 'setup', failure: unknown;
const read = async (page: Page, pathname: string) => page.evaluate(async pathname => {
  const response = await fetch(pathname); const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
}, pathname);
try {
  for (const language of ['zh', 'en'] as const) for (const width of [1440, 390]) {
    phase = `${language}-${width}`;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: language === 'zh' ? 'zh-CN' : 'en-US', reducedMotion: 'reduce' });
    await context.addInitScript(({ key, language }) => localStorage.setItem(key, language), { key: localeStorageKey, language });
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/workspace.html?tab=search');
    await page.locator('[data-workspace-page]').waitFor();
    const owner = (await context.cookies(origin)).find(item => item.name === 'theoremos_session')!.value;
    const provider = (await read(page, '/api/session')).providers[0];
    const created = ['First attempt', 'Accepted attempt', 'Unknown usage'].map(task => service.jobs.create(owner, {
      providerId: provider.id, apiKey: 'sk-disposable-never-used', model: 'fixture-model', effort: 'high', environment: sample.run.environment,
      source: sample.run.source.trim(), task, maxTurns: 2, maxRunSeconds: 60, maxTotalTokens: 10000, workers: 2, coordination: 'cooperative',
    }, provider));
    await page.waitForFunction(async () => {
      const response = await fetch('/api/runs'); const body = await response.json(); return body.runs.length === 3 && body.runs.every((run: { status: string }) => run.status === 'completed');
    });
    const selected = service.jobs.get(owner, created[1].id)!;
    const formalizationId = crypto.randomUUID(), messageId = crypto.randomUUID();
    const formalization: WebFormalization = { id: formalizationId, original: 'A recorded natural problem', model: selected.model,
      providerId: selected.providerId, environment: selected.environment, effort: 'high', status: 'confirmed', createdAt: selected.createdAt,
      updatedAt: selected.updatedAt, runId: selected.id, progress: { phase: 'finishing', tokens: 100 } };
    service.storage.saveRecord(['owners', mathDigest(owner), 'formalizations', formalizationId, 'record.json'], { formalization });
    service.storage.saveExplanation(owner, 'c'.repeat(64), { id: crypto.randomUUID(), runId: selected.id, target: 'Recorded proof', language,
      status: 'approved', model: selected.model, effort: 'high', createdAt: selected.createdAt, updatedAt: selected.updatedAt,
      maxRunSeconds: 60, maxTotalTokens: 10000, progress: { phase: 'finishing', tokens: 40, updatedAt: selected.updatedAt } });
    const conversation: WebConversation = { id: crypto.randomUUID(), title: 'Follow-up with exact location', runId: selected.id,
      createdAt: selected.createdAt, updatedAt: selected.updatedAt, messages: [
        { id: crypto.randomUUID(), role: 'user', kind: 'text', text: 'How does the proof continue?', status: 'complete', createdAt: selected.createdAt },
        { id: messageId, role: 'assistant', kind: 'text', text: 'Searchable telescoping message with $x^2 + y^2$.', status: 'complete', createdAt: selected.createdAt },
      ] };
    service.storage.saveRecord(['owners', mathDigest(owner), 'conversations', `${conversation.id}.json`], conversation);

    phase = `inbox-empty-${language}-${width}`;
    await page.goto(`${origin}/workspace.html?tab=inbox`);
    const inbox = page.locator('[data-collaboration-inbox]');
    await page.locator('#asset-updates').getByText(language === 'zh' ? '在数学库版本页关注成果，新版本会显示在这里。' : 'Follow an asset in Library to see new releases here.', { exact: true }).waitFor();
    await inbox.getByText(language === 'zh' ? '暂无待办' : 'No to-dos yet').waitFor();
    assert.equal(await inbox.locator('header > span').count(), 0);
    assert.equal(await inbox.getByRole('group', { name: language === 'zh' ? '筛选消息' : 'Filter messages' }).count(), 0);
    await page.locator('.workspace-tabs-more').getByText(language === 'zh' ? '更多页面' : 'More pages', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, `inbox-empty-${language}-${width}.png`), fullPage: true });
    await inbox.getByRole('link', { name: language === 'zh' ? '查找已有研究' : 'Find existing research', exact: true }).click();
    await page.locator('#workspace-query').waitFor();

    phase = `inbox-controls-${language}-${width}`;
    const progressOnly: ResearchCollaborationInbox = {
      pending: 0, unread: 1, counts: { decision: 0, reply: 0, progress: 1 }, items: [{
        id: 'fixture-progress', kind: 'update', category: 'progress', projectId: 'fixture-project', projectTitle: 'Fixture project',
        title: 'A recorded research update', createdAt: selected.createdAt, href: '', read: false, resolved: false, processed: false,
      }],
    };
    await page.route('**/api/research/collaboration/inbox', async route => {
      await route.fulfill({ response: await route.fetch(), json: progressOnly });
    });
    await page.goto(`${origin}/workspace.html?tab=inbox`);
    await inbox.getByText(language === 'zh' ? '当前范围内没有协作事项。' : 'No collaboration items in this view.', { exact: true }).waitFor();
    const more = inbox.getByRole('combobox', { name: language === 'zh' ? '其他消息范围' : 'Other message views', exact: true });
    assert.equal(await more.inputValue(), '');
    const inactiveWidth = (await more.boundingBox())!.width;
    await more.selectOption('processed');
    assert.ok((await more.boundingBox())!.width > inactiveWidth, 'The select expands for the selected message range');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'The inbox filters fit the viewport');
    await page.screenshot({ path: path.join(output, `inbox-controls-${language}-${width}.png`), fullPage: true });
    await inbox.locator('[data-inbox-filter="progress"]').click();
    await inbox.locator('[data-inbox-item="fixture-progress"]').waitFor();
    await page.unroute('**/api/research/collaboration/inbox');

    phase = `search-${language}-${width}`;
    await page.goto(`${origin}/workspace.html?tab=search`);
    await page.locator('#workspace-query').fill('Searchable telescoping');
    await page.locator('.workspace-search button').click();
    const result = page.locator('.workspace-result').filter({ hasText: conversation.title }); await result.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-math-state="ready"]').length > 0);
    await page.screenshot({ path: path.join(output, `search-${language}-${width}.png`), fullPage: true });
    await result.getByRole('link').first().click();
    await page.locator(`[data-message-id="${messageId}"].chat-search-target`).waitFor();
    assert.equal(await page.locator(`[data-message-id="${messageId}"]`).evaluate(element => document.activeElement === element), true);

    phase = `usage-${language}-${width}`;
    await page.goto(`${origin}/workspace.html?tab=usage`);
    await page.locator('.workspace-usage-group').waitFor();
    const ledger = await read(page, '/api/research/workspace/usage');
    assert.equal(ledger.knownTokens, 3740); assert.equal(ledger.missingEntries, 1); assert.equal(ledger.entryCount, 5);
    assert.equal(ledger.groups.length, 1); assert.equal(ledger.groups[0].attempts, 3);
    const rates = page.locator('.research-panel').filter({ has: page.getByRole('heading', { name: language === 'zh' ? '模型单价' : 'Model rates', exact: true }) });
    await rates.locator('summary').click();
    await rates.locator('input[type=number]').fill('2.5');
    await rates.getByRole('button', { name: language === 'zh' ? '保存单价' : 'Save rate', exact: true }).click();
    await page.waitForFunction(async () => (await (await fetch('/api/research/workspace/usage')).json()).estimates.length === 1);
    await page.screenshot({ path: path.join(output, `usage-${language}-${width}.png`), fullPage: true });
    const priced = await read(page, '/api/research/workspace/usage'); assert.equal(priced.rates[0].perMillion, 2.5);
    assert.ok(Math.abs(priced.estimates[0].amount - 3740 / 1e6 * 2.5) < 1e-10);
    await page.reload(); await page.getByText(language === 'zh' ? '按你填写的单价估算' : 'Estimate using your rates', { exact: false }).waitFor();

    phase = `brief-${language}-${width}`;
    await page.goto(`${origin}/workspace.html?tab=brief&run=${selected.id}`);
    const brief = page.locator('[data-research-brief]'); await brief.waitFor();
    const briefRecord = (await read(page, `/api/research/workspace/brief/${selected.id}`)).item;
    assert.equal(await brief.getByRole('heading', { name: language === 'zh' ? '证明路线与推导' : 'Proof routes and derivations', exact: true }).count(), 0);
    if (briefRecord.tasks.length || briefRecord.routes.length)
      await brief.getByRole('heading', { name: language === 'zh' ? '记录的计划与尝试' : 'Recorded plans and attempts', exact: true }).waitFor();
    if (!briefRecord.decisions.length)
      assert.equal(await brief.getByRole('heading', { name: language === 'zh' ? '人工决定与处理' : 'Human decisions and responses', exact: true }).count(), 0);
    assert.equal(await brief.getByText(language === 'zh' ? '尚未关联已发布成果。' : 'No published outcome is linked yet.', { exact: true }).count(), 0);
    const runChoice = page.locator('.workspace-select select');
    await page.waitForFunction(() => document.querySelector('.workspace-select select option:checked')?.textContent?.includes('Accepted attempt'));
    assert.equal(await runChoice.inputValue(), selected.id);
    await brief.getByText('Telescoping marker:', { exact: false }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-research-brief] [data-math-state="loading"]'));
    assert.ok(await brief.locator('.katex').count() > 0);
    const mdEvent = page.waitForEvent('download'); await brief.getByRole('button', { name: 'Markdown', exact: true }).click();
    const md = await mdEvent, mdPath = path.join(output, `brief-${language}-${width}.md`); await md.saveAs(mdPath);
    const markdown = await fs.readFile(mdPath, 'utf8'); assert.ok(markdown.includes('Telescoping marker')); assert.ok(markdown.includes(selected.source));
    assert.ok(!markdown.includes('sk-disposable')); assert.ok(!markdown.includes(owner));
    const htmlEvent = page.waitForEvent('download'); await brief.getByRole('button', { name: 'HTML', exact: true }).click();
    const html = await htmlEvent, htmlPath = path.join(output, `brief-${language}-${width}.html`); await html.saveAs(htmlPath);
    const htmlText = await fs.readFile(htmlPath, 'utf8'); assert.ok(htmlText.includes('katex-mathml')); assert.ok(!htmlText.includes('<script')); assert.ok(!htmlText.includes(owner));
    await page.screenshot({ path: path.join(output, `brief-${language}-${width}.png`), fullPage: true });
    await page.emulateMedia({ media: 'print' }); await page.pdf({ path: path.join(output, `brief-${language}-${width}.pdf`), printBackground: true }); await page.emulateMedia({ media: 'screen' });
    const layout = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
    assert.ok(layout.content <= layout.viewport + 1, `Workspace overflow: ${JSON.stringify(layout)}`);

    phase = `frozen-source-${language}-${width}`;
    const saved = sample.observations.find(observation => observation.sources.length)!.sources[0];
    await page.goto(`${origin}/?${new URLSearchParams({ run: selected.id, task: saved.taskId, taskVersion: saved.taskVersion, commit: saved.commit })}`);
    const frozen = page.locator('[data-frozen-task]'); await frozen.waitFor(); await frozen.locator('pre').waitFor();
    assert.equal(await frozen.locator('pre code').textContent(), saved.source);
    assert.ok(await frozen.getByRole('link', { name: language === 'zh' ? '收藏这个版本' : 'Save this version', exact: true }).count());

    phase = `candidate-overview-${language}-${width}`;
    const savedBinding = selected.formalization;
    for (const confirmation of ['pending', 'rejected', 'superseded'] as const) {
      selected.formalization = { id: formalizationId, original: formalization.original, candidateDigest: 'd'.repeat(64), confirmation, reviewMode: 'direct' };
      service.storage.saveRun(owner, selected);
      await page.goto(origin); await page.locator('[data-chat-research-overview] > summary').click();
      const status = page.locator(`[data-overview-run-status="${selected.id}"]`); await status.waitFor();
      assert.equal(await status.innerText(), language === 'zh' ? '最新尝试 · 候选 Lean 陈述证明通过' : 'Latest attempt · Candidate Lean statement proved');
      const card = page.locator('[data-overview-card]').filter({ has: status });
      assert.ok((await card.locator('[data-overview-progress]').innerText()).includes(statementConfirmation(confirmation, false, 'direct', language)));
      assert.equal(await card.locator('[data-overview-run-status]').count(), 1, 'The latest status appears once together with its progress');
      assert.equal(await card.locator(`[data-overview-verified-run="${selected.id}"]`).count(), 1, 'Candidate acceptance keeps its readable proof record');
      const recordLayout = await card.locator('[data-overview-verified]').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
      assert.ok(recordLayout.content <= recordLayout.width + 1, `Candidate proof record fits its card: ${JSON.stringify(recordLayout)}`);
      assert.doesNotMatch(await card.innerText(), /原题已验收|Original problem accepted/u);
      const filters = page.locator('[data-overview-more-filters]');
      assert.equal(await filters.getAttribute('open'), null);
      assert.equal(await page.locator('[data-overview-personal-tools]').isVisible(), false);
      await filters.locator(':scope > summary').click();
      assert.equal(await page.locator('[data-overview-personal-tools]').isVisible(), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await page.locator('[data-overview-more-filters] > summary').click();
    const candidateCard = page.locator('[data-overview-card]').filter({ has: page.locator(`[data-overview-run-status="${selected.id}"]`) });
    await candidateCard.screenshot({ path: path.join(output, `candidate-card-${language}-${width}.png`) });
    await page.screenshot({ path: path.join(output, `candidate-overview-${language}-${width}.png`), fullPage: true });
    selected.formalization = savedBinding; service.storage.saveRun(owner, selected);

    if (language === 'zh' && width === 390) {
      phase = 'brief-without-optional-records';
      await page.route(`**/api/research/workspace/brief/${selected.id}`, async route => {
        const response = await route.fetch(), body = await response.json();
        await route.fulfill({ response, json: { ...body, item: { ...body.item, attempts: [], routes: [], tasks: [], decisions: [], outcomes: [],
          acceptance: { ...body.item.acceptance, checks: [] } } } });
      }, { times: 1 });
      await page.goto(`${origin}/workspace.html?tab=brief&run=${selected.id}`); await brief.waitFor();
      const headings = await brief.locator('section > h3').allTextContents();
      assert.deepEqual(headings, ['问题', '独立验收', '用量与成果']);
      assert.equal(await brief.locator('details').filter({ hasText: '全部任务检查' }).count(), 0);
      assert.equal(await brief.getByText('这次研究没有保存任务路线。', { exact: true }).count(), 0);
      await page.screenshot({ path: path.join(output, 'brief-no-empty-sections-390.png'), fullPage: true });
    }
    await context.close(); checks.push({ language, width, inbox: 'empty state links to search; empty filters retain access to unread progress',
      search: 'exact message focus', usage: 'all attempts; null distinct from zero; rates persist',
      brief: 'math and HTML/Markdown/PDF; plans labeled and empty sections omitted', source: 'exact frozen commit',
      overview: 'candidate meaning retained for pending/rejected/superseded; filters disclosed; status not repeated' });
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibitedCalls, 0); assert.equal(fixtureRuns, 12);
} catch (error) {
  failure = error;
  if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(), phase,
    checks, errors, external, fixtureRuns, prohibitedCalls, ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Research workspace: ${checks.length} bilingual desktop/mobile workflows passed`);
