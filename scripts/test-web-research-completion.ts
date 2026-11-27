#!/usr/bin/env bun
// Disposable loopback HTTP service with recorded evidence; no real models, Lean, email or production data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebRun } from '../apps/web/shared';
import { readingEnvironment, readingRun } from '../tests/helpers/shareReadingFixture';
import { freePort, startBrowser } from './web-scenario';
import { openProblemHistory, openProblemSection } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/research-completion/browser');
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-research-completion-')), port = await freePort(), origin = `http://127.0.0.1:${port}`;
await fs.mkdir(output, { recursive: true });
let workers = 0, prohibited = 0;
const runner: WebRunner = { async readiness() { return { ready: true, nativeTeam: true, message: 'Disposable fixture: /private/path sk-do-not-expose' }; },
  async run(input, send) { workers++; const run = readingRun(input.id); run.observation!.inspection.configuration.environmentDigest = readingEnvironment;
    for (const check of run.observation!.checks) check.record = { passed: true };
    send({ type: 'observation', observation: run.observation! }); send({ type: 'result', result: run.result! }); },
  async check() { prohibited++; throw new Error('No compiler in this fixture'); },
  async formalize() { prohibited++; throw new Error('No model in this fixture'); },
  async explain() { prohibited++; throw new Error('No model in this fixture'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_SOURCE_COMMIT: 'a'.repeat(40), THEOREMOS_WEB_CLIENT_IP_HEADER: 'x-fixture-scenario' }), runner, { sample: null });
const browser = await startBrowser(service.server, port), checks: object[] = [], errors: string[] = [], external: string[] = [];
let phase = 'public status', failure: unknown, active: Page | undefined;
try {
  const response = await fetch(`${origin}/api/product/status`), status = await response.json();
  assert.ok(response.ok); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(status.release.commit, 'a'.repeat(40)); assert.match(status.release.frontend.digest, /^[a-f0-9]{64}$/u);
  assert.equal(status.service.runtimeReady, true); assert.doesNotMatch(JSON.stringify(status), /private\/path|sk-do-not-expose/);
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-fixture-scenario': `${language}-${width}` } });
    await context.addInitScript(language => localStorage.setItem('theorem-os.web-locale.v1', language), language);
    await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    phase = `help-${language}`;
    await page.goto(`${origin}/workspace.html?tab=help`); const help = page.locator('[data-product-status]'); await help.waitFor();
    await help.locator('.research-facts').waitFor();
    assert.ok(await page.locator('.workspace-tabs [aria-current=page]').evaluate(item => {
      const nav = item.parentElement!.getBoundingClientRect(), current = item.getBoundingClientRect();
      return current.left >= nav.left - 1 && current.right <= nav.right + 1;
    }), 'The current tab is visible on direct mobile entry');
    await help.locator('[data-diagnostics-preview] summary').click();
    const diagnostics = JSON.parse(await help.locator('[data-diagnostics-preview] pre').innerText());
    assert.equal(diagnostics.release.frontend.digest, status.release.frontend.digest); assert.ok(diagnostics.environment.includes(status.release.frontend.digest.slice(0, 12)));
    assert.doesNotMatch(JSON.stringify(diagnostics), /sk-do-not-expose|private\/path|csrf|provider|email/);
    assert.ok(new URL((await help.locator('a[href*="feedback"]').getAttribute('href'))!).searchParams.get('environment')?.includes(status.release.frontend.digest.slice(0, 12)));
    await page.screenshot({ path: path.join(output, `help-${language}.png`), fullPage: true });
    await page.goto(`${origin}/guide.html#service-status`); await page.locator('[data-product-status] .research-facts').waitFor();
    const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const session = await page.evaluate(async () => (await fetch('/api/session')).json()), provider = session.providers[0], recorded = readingRun();
    const created = service.jobs.create(owner, { providerId: provider.id, apiKey: 'sk-disposable-not-sent', model: 'fixture', effort: 'high', source: recorded.source,
      task: recorded.task, environment: recorded.environment, maxTurns: 1, maxRunSeconds: 60, workers: 1, coordination: 'independent' }, provider);
    await page.waitForFunction(async () => (await (await fetch('/api/runs')).json()).runs.every((run: WebRun) => run.status === 'completed'));
    const run = service.jobs.get(owner, created.id)!, task = run.observation!.inspection.tasks[1], runBefore = JSON.stringify(run);
    phase = `route-switch-${language}`;
    await page.goto(`${origin}/problem.html?${new URLSearchParams({ run: run.id, tab: 'route', task: task.id, taskVersion: task.version, commit: task.proof.commit! })}`);
    await page.locator('[data-problem-route-workspace] [data-solution-heading="task:conclusion"]').waitFor();
    assert.equal(await page.locator('[data-problem-route-workspace] .solution-route').count(), 1);
    await openProblemHistory(page); await page.locator('[data-problem-map=global]').click(); await page.locator('[data-journey-task="conclusion"][aria-pressed=true]').waitFor();
    assert.equal(await page.locator('[data-problem-route-workspace] .solution-route').count(), 1);
    await page.locator('[data-journey-task="normalization"]').click();
    assert.equal(new URL(page.url()).searchParams.get('task'), 'normalization');
    await page.locator('[data-problem-map=attempt]').click(); await page.locator('[data-solution-heading="task:normalization"]').waitFor();
    await page.locator('[data-problem-open-source]').click(); await page.locator('[data-journey-source-reader] pre').first().waitFor();
    assert.match(await page.locator('[data-journey-source-reader]').innerText(), /duplicate_eq/);
    await page.waitForFunction(() => document.querySelectorAll('.solution-route-heading .katex').length > 0);
    await page.screenshot({ path: path.join(output, `route-${language}.png`), fullPage: true });
    phase = `outcome-delivery-${language}`;
    await openProblemSection(page, 'outcomes'); const delivery = page.locator('[data-outcome-delivery]'); await delivery.waitFor();
    const expected = (zh: string, en: string) => language === 'zh' ? zh : en;
    const explanation = delivery.getByRole('link', { name: expected('阅读或生成证明讲解', 'Read or create a proof explanation'), exact: true });
    assert.equal(new URL((await explanation.getAttribute('href'))!, origin).searchParams.get('run'), run.id);
    const library = delivery.locator('a[href*="fromRun="]'); assert.equal(new URL((await library.getAttribute('href'))!, origin).searchParams.get('scope'), 'original-proof');
    const downloaded = page.waitForEvent('download'); await delivery.locator('a[href$="/download"]').click(); assert.match((await downloaded).suggestedFilename(), /\.json$/u);
    await delivery.getByRole('button', { name: expected('创建只读分享', 'Create a read-only share'), exact: true }).click();
    const share = page.locator('[data-outcome-share]'); await share.locator('input[type=checkbox]').check();
    await share.locator('[data-create-outcome-share]').click(); const link = share.locator('input[readonly]'); await link.waitFor();
    const shareUrl = await link.inputValue(), token = new URL(shareUrl).hash.slice(1);
    assert.ok(token); assert.equal((await fetch(`${origin}/api/share/${token}`)).status, 200);
    await share.getByRole('button', { name: expected('停止分享', 'Stop sharing'), exact: true }).click(); await share.locator('[data-create-outcome-share]').waitFor();
    assert.equal((await fetch(`${origin}/api/share/${token}`)).status, 404);
    await delivery.getByRole('button', { name: expected('预览与导出研究简报', 'Preview and export the research brief'), exact: true }).click();
    await page.locator('[data-brief-controls]').waitFor(); const briefDownload = page.waitForEvent('download'); await page.getByRole('button', { name: 'Markdown', exact: true }).click(); assert.match((await briefDownload).suggestedFilename(), /\.md$/u);
    phase = `personal-to-project-${language}`;
    await openProblemSection(page, 'overview'); const projectStart = page.locator('[data-project-from-problem]'); await projectStart.locator('summary').first().click();
    await projectStart.locator('input[type=checkbox]').check(); await projectStart.locator('button[type=submit]').click();
    await page.waitForURL(url => Boolean(url.searchParams.get('project'))); const projectId = new URL(page.url()).searchParams.get('project')!;
    await page.waitForFunction(() => !document.querySelector('[data-project-from-problem]'));
    const project = service.research.projects.detail(owner, projectId); assert.equal(project.visibility, 'private'); assert.equal(project.runs[0].runId, run.id);
    assert.equal(project.versions[0].source, run.source); assert.equal(JSON.stringify(service.jobs.get(owner, run.id)), runBefore);
    await page.reload(); await page.locator('[data-problem-page] .problem-tabs').waitFor(); assert.equal(new URL(page.url()).searchParams.get('project'), project.id);
    const widthResult = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth })); assert.ok(widthResult.width <= widthResult.viewport + 1, JSON.stringify(widthResult));
    await page.screenshot({ path: path.join(output, `project-${language}.png`), fullPage: true });
    checks.push({ language, width, publicBuildAndSafeDiagnostics: true, oneMapAndSharedSelection: true, inlineFrozenSource: true, acceptedShareCreateRevoke: true, archiveAndBriefDownloads: true, privateProjectFromExactRun: true });
    await context.close();
  }
  assert.equal(workers, 2); assert.equal(prohibited, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) { failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(), phase, checks, errors, external, workers, prohibited,
  ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) }, null, 2)); await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
if (failure) throw failure;
console.log(`Research completion: ${checks.length} desktop/mobile workflows passed`);
