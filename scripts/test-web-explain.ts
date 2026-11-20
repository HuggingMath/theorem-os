#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { webSampleRunId, type WebExplanationDocument, type WebRunInput, type WorkerExplanationInput, type WorkerExplanationMessage } from '../apps/web/shared';
import { localeStorageKey } from '../apps/web/i18n';
import { themeStorageKey } from '../apps/web/client/themePreference';
import { leanGutter, refLines, stepAtLine } from '../apps/web/client/explainText';
import { webExplanationEvidence, type FixtureUnit } from '../tests/helpers/webExplanationFixture';
import { audit } from './web-a11y';
import { contrastProblems } from './web-contrast';
import { printedPages, printLayout } from './web-print';
import { openTab, selectHistoryRun } from './web-ui-controls';
import { freePort, postRun, readRun, settled, startBrowser, ready } from './web-scenario';

// The proof explanation page against a fake runner: preset proof and preset approved evidence, no model or container.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.THEOREMOS_TEST_OUTPUT || path.join(root, 'out/web-explain'));
await fs.access(path.join(root, 'out/web/explain.js')).catch(() => { throw new Error('Run bun run build:web before the explanation check.'); });
await fs.mkdir(output, { recursive: true });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const credential = 'sk-theoremos-explain-fixture';

// Six helper lemmas and a target long enough that both panes scroll at 1440×900.
const helper = (index: number) => [`theorem step_${index} (a b : Nat) : a + b + ${index} = b + a + ${index} := by`,
  ...Array.from({ length: 10 }, (_, line) => `  have h${line} : a + b = b + a := Nat.add_comm a b`), '  omega'].join('\n');
const helpers = Array.from({ length: 6 }, (_, index) => helper(index + 1));
const target = ['theorem target_thm (a b : Nat) : a + b + 1 = b + a + 1 := by', ...helpers.map((_, index) => `  have k${index + 1} := step_${index + 1} a b`), '  omega'].join('\n');
const proof = [...helpers, target, ''].join('\n\n');
// Each lemma cites Nat.add_comm, written in its Lean, and Nat.add_assoc, which is not; the target's steps skip `have k4`.
const units: FixtureUnit[] = [
  ...helpers.map((snippet, index) => ({ name: `step_${index + 1}`, kind: 'theorem' as const, snippet,
    external: ['Nat.add_comm', 'Nat.add_assoc'], cites: [['Nat.add_comm'], ['Nat.add_assoc']],
    steps: [snippet.split('\n').slice(1, 6), snippet.split('\n').slice(6)],
    texts: [`对任意 $a, b \\in \\mathbb{N}$，加法交换律给出 $a + b = b + a$，这一步重复写了 ${index + 1} 次。`,
      `两边同时加上 $${index + 1}$，由 $\\frac{a+b}{1} = a + b$ 得到 $a + b + ${index + 1} = b + a + ${index + 1}$。`] })),
  { name: 'target_thm', kind: 'theorem', snippet: target, uses: helpers.map((_, index) => `step_${index + 1}`),
    steps: [target.split('\n').slice(1, 4), target.split('\n').slice(5)],
    texts: ['先用 **前三个引理** 得到 $\\sum_{i=1}^{3} (a + b + i) = \\sum_{i=1}^{3} (b + a + i)$，其中 `step_1` 给出第一项。',
      '其余引理同理；未闭合的 $x^{$ 按原文显示，最后由 `omega` 结束：'
        + '$a + b + 1 = \\mathrm{succ}\\,(a + b) = \\mathrm{succ}\\,(b + a) = b + a + 1$。'] },
];
// Lean's goals around each tactic of the target: `have k<i>` adds a hypothesis, `omega` closes the goal.
const goalAfter = (count: number) => ['a b : Nat', ...Array.from({ length: count }, (_, index) =>
  `k${index + 1} : a + b + ${index + 1} = b + a + ${index + 1}`), '⊢ a + b + 1 = b + a + 1'].join('\n');
units[units.length - 1]!.goals = [...helpers.map((_, index) => ({ snippet: `have k${index + 1} := step_${index + 1} a b`,
  before: [goalAfter(index)], after: [goalAfter(index + 1)] })), { snippet: 'omega', before: [goalAfter(helpers.length)], after: [] }];
const lineCount = proof.replace(/\n$/u, '').split('\n').length;
const shortProof = 'theorem viewport_target (n : Nat) : n + 0 = n := by\n  simp\n';
const input: WebRunInput = { providerId: 'sub2api', apiKey: credential, model: 'deepseek-flash', effort: 'xhigh', environment: 'standard',
  autoExplain: false,
  source: 'theorem target_thm (a b : Nat) : a + b + 1 = b + a + 1 := by\n  sorry\n', task: 'Explain fixture',
  maxTurns: 1, maxRunSeconds: 60, workers: 1, coordination: 'cooperative' };

type Explain = { input: WorkerExplanationInput; send(message: WorkerExplanationMessage): void; resolve(): void };
const explains: Explain[] = [];
const runner: WebRunner = {
  async readiness() { return { ready: true, message: '本地讲解验证环境' }; },
  async run(value, send) { send({ type: 'result', result: { status: value.input.task === 'Unaccepted fixture' ? 'limit_reached' : 'evaluated_passed',
    proof: value.input.task === 'Short viewport fixture' ? shortProof : proof, report: {} } }); },
  explain(value, send, signal) {
    if (value.target === 'viewport_target') {
      send({ type: 'result', status: 'approved', evidence: JSON.parse(JSON.stringify(webExplanationEvidence({ proof: shortProof, target: value.target,
        units: [{ name: value.target, kind: 'theorem', snippet: shortProof.trim(), steps: [['simp']],
          statement: '对任意自然数，右侧加零不改变它的值。', texts: ['由自然数加法的定义，$n + 0 = n$。'] }] }))) });
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      explains.push({ input: { ...value }, send, resolve });
      signal.addEventListener('abort', () => reject(new Error('explanation_cancelled')), { once: true });
    });
  },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), runner);
const mark = (check: string) => console.log(`PASS ${check}`);
const errors: string[] = [];
async function until(check: () => Promise<boolean> | boolean, label: string, seconds = 20) {
  for (const started = Date.now(); Date.now() - started < seconds * 1000;) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
async function open(browser: Browser, url: string, options: { locale?: 'zh' | 'en'; theme?: 'light' | 'dark'; width?: number;
  height?: number; storageState?: Awaited<ReturnType<BrowserContext['storageState']>> } = {}) {
  const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    ...(options.storageState ? { storageState: options.storageState } : {}) });
  await context.addInitScript(([localeKey, locale, themeKey, theme]) => {
    if (locale) localStorage.setItem(localeKey, locale);
    if (theme) localStorage.setItem(themeKey, theme);
  }, [localeStorageKey, options.locale ?? '', themeStorageKey, options.theme ?? ''] as const);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url);
  return { context, page };
}
const explainReady = (page: Page) => page.locator('#explain-content:not([hidden])').waitFor();
const mathReady = async (page: Page) => {
  await page.waitForFunction(() => {
    const formulas = [...document.querySelectorAll<HTMLElement>('.explain-document .math')];
    return formulas.length > 0 && formulas.every(formula => ['ready', 'source'].includes(formula.dataset.mathState ?? ''));
  });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
};
/** Proof lines carrying a mark, as 1-based numbers. */
const marked = (page: Page, kind: string) => page.locator(`#explain-lean-code .lean-row.is-${kind}`)
  .evaluateAll(rows => rows.map(row => Number((row as HTMLElement).dataset.line)));
/** Whether the element is inside its scrolling pane's visible area. */
const shown = (page: Page, selector: string) => page.locator(selector).first().evaluate(node => {
  const pane = node.closest('.explain-scroll')!.getBoundingClientRect(), box = node.getBoundingClientRect();
  return box.bottom > pane.top && box.top < pane.bottom;
});
const range = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, index) => start + index);

let browser: Browser | undefined;
try {
  browser = await startBrowser(service.server, port);
  const owner = await open(browser, `${origin}/`);
  const { page } = owner;
  await ready(page);
  const run = await postRun({ page }, input);
  await until(async () => (await readRun({ page }, run.id)).status === 'completed', 'the fixture run finishes');

  // Open directly from the proof, without depending on the report's outline or display mode.
  await page.reload();
  await ready(page);
  // The acceptance report, with the proof's structure, is part of 结果, where a run opens.
  await selectHistoryRun(page, run.id);
  const proofLink = page.locator('#detail-panel .result-proof [data-proof-explanation]');
  await proofLink.waitFor();
  const proofHref = `explain.html?${new URLSearchParams({ run: run.id })}`;
  assert.equal(await proofLink.innerText(), 'Lean → 自然语言');
  assert.equal(await proofLink.getAttribute('href'), proofHref);
  assert.equal(await proofLink.getAttribute('target'), '_blank');
  await page.locator('[data-report-view="json"]').click();
  assert.equal(await proofLink.getAttribute('href'), proofHref, 'raw report mode keeps the direct entry');
  await page.locator('#detail-tab-source').click();
  const sourceLink = page.locator('#detail-panel .source-actions [data-proof-explanation]');
  await sourceLink.waitFor();
  assert.equal(await sourceLink.getAttribute('href'), proofHref, 'the source toolbar opens the same proof explanation');
  await page.locator('#detail-tab-result').click();
  await page.locator('[data-report-view="summary"]').click();
  const link = page.locator('#detail-panel .report-outline a[href^="explain.html"]');
  await link.waitFor();
  assert.equal(await link.count(), 1, 'one explanation link, on the target');
  const href = await link.getAttribute('href');
  assert.equal(href, `explain.html?${new URLSearchParams({ run: run.id, target: 'target_thm' })}`);
  assert.equal(await link.getAttribute('target'), '_blank');
  await proofLink.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'explain-workbench-entry-1440.png') });
  mark('an accepted proof and its source toolbar link directly to natural-language explanation, including with the raw report open');

  // Sample readers can discover the page too; opening it never starts generation and Back returns to the sample.
  const sample = await open(browser, `${origin}/?sample`);
  await sample.page.locator('body[data-view="run"] .detail-heading[data-run]').waitFor({ state: 'attached' });
  await openTab(sample.page, 'result');
  const sampleLink = sample.page.locator('#detail-panel .result-proof [data-proof-explanation]');
  await sampleLink.waitFor();
  assert.equal(await sampleLink.getAttribute('href'), `explain.html?${new URLSearchParams({ run: webSampleRunId })}`);
  const popup = sample.context.waitForEvent('page');
  await sampleLink.click();
  const sampleExplanation = await popup;
  await explainReady(sampleExplanation);
  assert.ok(await sampleExplanation.locator('#explain-lean-code .lean-row').count() > 0);
  assert.match(await sampleExplanation.locator('#explain-prose').innerText(), /示例运行只读，不能生成讲解/u);
  assert.equal(await sampleExplanation.locator('[data-action="generate"]').count(), 0);
  assert.equal(explains.length, 0, 'opening an explanation does not start the runner');
  assert.equal(await sampleExplanation.locator('#explain-back').getAttribute('href'), './?sample');
  await sampleExplanation.locator('#explain-back').click();
  // The sample reopens on its chat; the proof with its explanation link is in the run panel's 结果.
  await sampleExplanation.locator('body[data-view="run"] .detail-heading[data-run]').waitFor({ state: 'attached' });
  await openTab(sampleExplanation, 'result');
  await sampleExplanation.locator('#detail-panel .result-proof [data-proof-explanation]').waitFor();
  await sample.context.close();
  mark('the sample exposes the explanation entry, stays read-only and returns to the sample');

  const unaccepted = await postRun({ page }, { ...input, task: 'Unaccepted fixture' });
  await until(async () => (await readRun({ page }, unaccepted.id)).status === 'completed', 'the unaccepted fixture finishes');
  await page.reload();
  await selectHistoryRun(page, unaccepted.id);
  await page.locator('.result-proof.candidate').waitFor();
  assert.equal(await page.locator('#detail-panel a[href^="explain.html"]').count(), 0);
  await page.locator('#detail-tab-source').click();
  await page.locator('.source-status.candidate').waitFor();
  assert.equal(await page.locator('[data-proof-explanation]').count(), 0);
  mark('an unaccepted candidate does not offer an accepted-proof explanation');

  await page.goto(`${origin}/${proofHref}`);
  await explainReady(page);
  assert.equal(await page.locator('#explain-lean-code .lean-row').count(), lineCount, 'one Lean row per proof line');
  assert.equal(await page.locator('#explain-lean-code .lean-row[data-line="1"] .lean-tok-keyword').first().innerText(), 'theorem');
  assert.equal(await page.locator('#explain-back').getAttribute('href'), `./?run=${run.id}`);
  const card = page.locator('#explain-prose .explain-card');
  await card.locator('[data-action="generate"]').waitFor();
  assert.deepEqual(await page.locator('#locale-switch').evaluate(node => {
    const style = getComputedStyle(node); return { decoration: style.textDecorationLine, height: node.getBoundingClientRect().height };
  }), { decoration: 'none', height: 32 }, 'the locale switch is a compact topbar control');
  assert.deepEqual(await contrastProblems(page, '.explain-topbar'), [], 'explanation topbar contrast below WCAG AA (light)');
  assert.match(await card.locator('.explain-estimate').innerText(), /^预计约 [\d.]+ 小时，约 [\d.]+ 万 Token。$/u);
  assert.equal(await page.locator('#explain-lean-legend').isVisible(), false, 'no margin legend before there is an explanation');
  assert.equal(await page.locator('#explain-prose .solution-route').count(), 0, 'an unapproved source does not install a mathematical explanation graph');
  mark('the page opens on the full Lean proof with an estimate and a generate button, nothing generated yet');

  // Generation asks for a Key, shows the run's model, and never echoes the Key.
  await card.locator('[data-action="generate"]').click();
  const dialog = page.locator('#explain-dialog[open]');
  await dialog.waitFor();
  const facts = await dialog.innerText();
  assert.ok(facts.includes('deepseek-flash') && facts.includes('按 7 个声明估算'), `the dialog names the model and the declarations: ${facts}`);
  await dialog.locator('button[type="submit"]').click();
  await settled(page);
  assert.equal(explains.length, 0, 'an empty Key does not submit');
  await dialog.locator('#explain-api-key').fill(credential);
  await dialog.locator('button[type="submit"]').click();
  await page.locator('#explain-toast:not([hidden])').filter({ hasText: '已开始生成讲解' }).waitFor();
  await until(() => explains.length === 1, 'the runner receives the explanation');
  assert.equal(await page.locator('#explain-dialog[open]').count(), 0, 'the dialog closes once accepted');
  assert.deepEqual({ apiKey: explains[0]!.input.apiKey, target: explains[0]!.input.target, language: explains[0]!.input.language,
    model: explains[0]!.input.model, proof: explains[0]!.input.proof },
  { apiKey: credential, target: 'target_thm', language: 'zh', model: 'deepseek-flash', proof });
  assert.equal((await page.content()).includes(credential), false, 'the Key never reaches the page');
  await page.locator('#explain-prose .explain-progress').waitFor();
  assert.equal(await page.locator('#explain-prose .solution-route').count(), 0, 'generation progress is not a completed derivation');
  explains[0]!.send({ type: 'progress', progress: { phase: 'auditing', batches: 2, approvedBatches: 1, round: 1, tokens: 1234 } });
  const progress = page.locator('.explain-progress');
  await progress.getByRole('heading', { name: '正在逐步审核' }).waitFor({ timeout: 15_000 });
  const batches = progress.getByRole('progressbar', { name: '已通过批次' });
  assert.equal(await batches.getAttribute('value'), '1');
  assert.equal(await batches.getAttribute('max'), '2');
  assert.equal(await progress.getByText('Token 用量', { exact: true }).isVisible(), false);
  await page.screenshot({ path: path.join(output, 'explain-progress-1440.png') });
  await progress.getByText('用量与上限', { exact: true }).click();
  assert.equal(await progress.getByText('Token 用量', { exact: true }).isVisible(), true);
  mark('generation shows the current phase and actual batch progress, with usage available on demand');
  const modelRequestFailures = page.locator('.explain-facts > div').filter({ hasText: '模型请求失败次数' });
  assert.equal(await modelRequestFailures.count(), 0, 'previous workers do not report a failure count');
  explains[0]!.send({ type: 'progress', progress: { phase: 'retrying', round: 1, modelRequestFailures: 2 } });
  await progress.getByRole('heading', { name: '模型调用失败，正在重试' }).waitFor();
  assert.equal(await modelRequestFailures.locator('dd').innerText(), '2');
  assert.equal(await page.locator('.explain-facts > div').filter({ hasText: '审核轮次' }).locator('dd').innerText(), '第 1 轮');

  // Stopping asks first; a stopped explanation can be generated again.
  await page.locator('#explain-prose [data-action="cancel"]').click();
  await page.locator('#explain-dialog[open] [data-action="confirm-cancel"]').click();
  await page.locator('#explain-toast:not([hidden])').filter({ hasText: '已停止生成' }).waitFor();
  await page.locator('#explain-prose [data-action="generate"]').waitFor();
  mark('stopping asks for confirmation and offers to generate again');

  const generateAgain = async (calls: number) => {
    await page.locator('#explain-prose [data-action="generate"]').click();
    await page.locator('#explain-dialog[open] #explain-api-key').fill(credential);
    await page.locator('#explain-dialog[open] button[type="submit"]').click();
    await until(() => explains.length === calls, `explanation ${calls} starts`);
    return explains.at(-1)!;
  };
  const interrupted = await generateAgain(2);
  interrupted.send({ type: 'progress', progress: { phase: 'auditing', round: 1, modelRequestFailures: 3 } });
  interrupted.send({ type: 'result', status: 'error', reason: 'informalization_role_retries_exhausted' });
  interrupted.resolve();
  const stopped = page.locator('#explain-prose .result-banner.failed');
  await stopped.getByText('模型请求反复失败，自动重试已停止。').waitFor();
  assert.equal(await stopped.getByText('模型请求失败 3 次').isVisible(), true);
  await page.reload();
  await stopped.getByText('模型请求失败 3 次').waitFor();
  mark('model request failures are separate from review rounds, and the stop reason and final count survive reload');

  // Generate again and approve: the page polls, then shows the document in reading mode.
  const completed = await generateAgain(3);
  completed.send({ type: 'result', status: 'approved', evidence: JSON.parse(JSON.stringify(webExplanationEvidence({ proof, target: 'target_thm', units, outlined: true }))) });
  completed.resolve();
  await page.locator('#explain-prose .explain-document').waitFor({ timeout: 20_000 });
  const split = page.locator('#explain-split');
  const readLayout = page.locator('[data-action="layout"][data-layout="read"]');
  const compareLayout = page.locator('[data-action="layout"][data-layout="compare"]');
  assert.equal(await split.getAttribute('data-layout'), 'read');
  assert.equal(await page.locator('#explain-lean').isVisible(), false, 'saved proofs start with one reading column');
  const item = `/api/runs/${run.id}/explanations/item?${new URLSearchParams({ target: 'target_thm', language: 'zh' })}`;
  const explained = await page.evaluate(async url => (await (await fetch(url)).json()).explanation.document as WebExplanationDocument, item);
  assert.deepEqual(explained.sections.map(section => section.name), [...helpers.map((_, index) => `step_${index + 1}`), 'target_thm']);
  assert.equal(await page.locator('.explain-section').count(), 7);
  assert.equal(await page.locator('.explain-section.is-target').count(), 1);
  assert.equal(await page.locator('.explain-steps > li').count(), 14);
  mark('an approved explanation appears without a reload: one section per declaration, the target marked');

  // Mathematics finishes loading before its semantic MathML and source fallback are checked.
  await mathReady(page);
  const lead = page.locator('.explain-lead'), overviewJump = lead.getByRole('button', { name: '读主定理证明' });
  assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), explained.sections.at(-1)!.title);
  assert.equal(await page.locator('.explain-document > :first-child').getAttribute('class'), 'explain-lead');
  assert.equal(await lead.locator('h1').innerText(), explained.sections.at(-1)!.title);
  assert.equal(await page.getByRole('heading', { level: 2, name: '证明主线' }).count(), 1);
  assert.equal(await lead.locator('.explain-lead-statement').innerText(), explained.sections.at(-1)!.statement);
  assert.equal(await page.locator('.explain-section.is-target .explain-statement').isVisible(), false, 'the repeated statement is folded in the proof chapter');
  assert.equal(await page.locator('.explain-summary').count(), 0, 'the full proof reads straight through without outline summaries');
  await page.screenshot({ path: path.join(output, 'explain-overview-1440.png') });
  // A reader can jump directly from the conclusion to the full main proof, even from the folded view.
  await page.locator('[data-action="detail"][data-detail="outline"]').click();
  await overviewJump.focus();
  await overviewJump.press('Enter');
  await page.locator('.explain-section.is-active.is-target .explain-steps').waitFor();
  await until(() => shown(page, '.explain-section.is-active.is-target header'), 'the main proof jump reveals the target');
  assert.equal(await split.getAttribute('data-layout'), 'read', 'the main proof jump stays in reading mode');
  await until(() => page.evaluate(() => document.activeElement?.id === 'explain-section-6'), 'the main proof receives keyboard focus');
  await page.locator('[data-action="return"]').click();
  await until(() => overviewJump.evaluate(node => document.activeElement === node
    && node.closest('.explain-scroll')!.scrollTop === 0), 'return restores the overview position and keyboard focus');
  mark('the theorem and its conclusion lead, with a direct keyboard jump to the main proof and back');

  // Readers can find a declaration without leaving the outline or losing their place.
  const contents = page.getByRole('button', { name: '证明目录' });
  const directory = page.getByRole('dialog', { name: '证明目录' });
  const search = directory.getByRole('searchbox'), entries = directory.locator('[data-action="contents-jump"]');
  const scroll = page.locator('#explain-prose');
  const folded = await page.locator('.explain-unfold').count();
  await contents.focus();
  await page.keyboard.press('Enter');
  await directory.waitFor();
  assert.deepEqual(await directory.getByRole('heading', { level: 3 }).allInnerTexts(), ['主定理', '辅助声明']);
  assert.equal(await directory.locator('[aria-current]').count(), 0, 'the overview is outside the numbered sections');
  await search.fill(explained.sections[4]!.title);
  assert.equal(await entries.count(), 1);
  await search.fill('no declaration has this name');
  await directory.getByText('没有匹配的声明').waitFor();
  await search.fill('');
  await page.keyboard.press('Escape');
  await directory.waitFor({ state: 'hidden' });
  await until(() => contents.evaluate(node => node === document.activeElement), 'Escape restores focus to the directory button');
  const previousScroll = await scroll.evaluate(node => { node.scrollTop = 200; return node.scrollTop; });
  assert.ok(previousScroll > 0);
  await contents.click();
  await search.fill('STEP_5');
  assert.equal(await entries.count(), 1);
  await entries.press('Enter');
  await directory.waitFor({ state: 'hidden' });
  await page.locator('.explain-section.is-active .explain-steps > li[data-anchor="4"]').first().waitFor();
  await until(() => shown(page, '.explain-section.is-active #explain-section-4'), 'the directory reveals the chosen declaration');
  assert.equal(await split.getAttribute('data-layout'), 'read', 'the directory stays in reading mode');
  await until(() => page.evaluate(() => document.activeElement?.id === 'explain-section-4'), 'the directory focuses the chosen declaration');
  assert.match(page.url(), /#at=step_5&view=outline$/u);

  const next = page.getByRole('button', { name: `下一节 ${explained.sections[5]!.title}` });
  await next.scrollIntoViewIfNeeded();
  await next.focus();
  await page.screenshot({ path: path.join(output, 'explain-next-1440.png') });
  const nextOrigin = await scroll.evaluate(node => node.scrollTop);
  await page.keyboard.press('Enter');
  await until(() => page.evaluate(() => document.activeElement?.id === 'explain-section-5'), 'Next focuses the following section');
  await until(() => shown(page, '#explain-section-5'), 'Next reveals the following section');
  assert.equal(new URL(page.url()).hash, '#at=step_6&view=outline');
  assert.equal(await page.locator('.explain-unfold').count(), folded - 2, 'Next unfolds the destination');
  await page.goBack();
  await until(async () => await next.evaluate(node => node === document.activeElement)
    && await scroll.evaluate((node, position) => node.scrollTop === position, nextOrigin), 'Back restores focus and scroll at Next');
  assert.equal(await page.locator('.explain-unfold').count(), folded - 1, 'Back restores the single unfolded section');

  await page.locator('[data-reading-section="2"]').evaluate(section => {
    const pane = section.closest('.explain-scroll')!;
    pane.scrollTop += section.getBoundingClientRect().top - pane.getBoundingClientRect().top + 28;
  });
  await contents.click();
  const reading = directory.locator('[aria-current="location"]');
  await reading.getByText('正在读').waitFor();
  assert.equal(await reading.getAttribute('data-target'), '2', 'the directory follows reading rather than the former Lean selection');
  assert.equal(new URL(page.url()).hash, '#at=step_5&view=outline');
  await page.keyboard.press('Escape');
  await directory.waitFor({ state: 'hidden' });
  await page.locator('[data-action="detail"][data-detail="steps"]').click();
  await page.locator('[data-action="return"]').click();
  await until(async () => await contents.evaluate(node => node === document.activeElement)
      && await scroll.evaluate((node, previous) => node.scrollTop === previous, previousScroll),
    'return from the directory restores reading position and focus');
  assert.equal(await page.locator('.explain-unfold').count(), folded, 'the outline folds back to its previous chapters');
  await page.locator('[data-action="detail"][data-detail="steps"]').click();
  mark('the directory marks the visible section; directory and Next jumps restore scroll, folded chapters and keyboard focus');

  const rail = page.getByRole('navigation', { name: '证明章节' });
  const railCurrent = rail.locator('[aria-current="location"]');
  const railEntry = rail.locator('[data-target="5"]');
  assert.deepEqual(await rail.locator('.explain-rail-title').allInnerTexts(), explained.sections.map(section => section.title));
  await page.locator('[data-action="detail"][data-detail="outline"]').click();
  const railOrigin = await page.locator('[data-reading-section="2"]').evaluate(section => {
    const pane = section.closest('.explain-scroll')!;
    pane.scrollTop += section.getBoundingClientRect().top - pane.getBoundingClientRect().top + 28;
    return pane.scrollTop;
  });
  const beforeRail = new URL(page.url()).hash;
  await railCurrent.and(rail.locator('[data-target="2"]')).waitFor();
  assert.equal(new URL(page.url()).hash, beforeRail, 'scrolling changes the reading marker without changing the link');
  await railEntry.press('Enter');
  await page.locator('#explain-section-5:focus').waitFor();
  await railCurrent.and(railEntry).waitFor();
  assert.match(page.url(), /#at=step_6&view=outline$/u);
  assert.equal(await split.getAttribute('data-layout'), 'read');
  await page.screenshot({ path: path.join(output, 'explain-chapters-1440.png') });
  await page.goBack();
  await until(async () => await railEntry.evaluate(node => node === document.activeElement)
    && await scroll.evaluate((node, position) => node.scrollTop === position, railOrigin), 'Back restores the reading position and rail focus');
  await railCurrent.and(rail.locator('[data-target="2"]')).waitFor();
  await page.setViewportSize({ width: 1440, height: 390 });
  await scroll.evaluate(node => {
    node.focus({ preventScroll: true });
    node.scrollTop = node.scrollHeight;
  });
  const lastRailEntry = railCurrent.and(rail.locator('[data-target="6"]'));
  await lastRailEntry.waitFor();
  assert.equal(await lastRailEntry.evaluate(item => {
    const list = item.closest('.explain-rail-list')!, bounds = list.getBoundingClientRect(), row = item.getBoundingClientRect();
    return list.scrollTop > 0 && row.top >= bounds.top && row.bottom <= bounds.bottom;
  }), true, 'the short viewport scrolls the last chapter into the directory');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-action="pane"][data-pane="lean"]').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  const previousAnchor = page.locator('[data-anchor="4"]:not([data-step])');
  const previousOffset = await previousAnchor.evaluate(node => {
    const pane = node.closest('.explain-scroll')!;
    pane.scrollTop += node.getBoundingClientRect().top - pane.getBoundingClientRect().top + 24;
    return node.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  });
  await railCurrent.and(rail.locator('[data-target="4"]')).waitFor();
  await railEntry.click();
  await page.locator('#explain-section-5:focus').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await rail.isVisible(), false, 'the chapters leave room for the proof at a narrower width');
  await page.locator('[data-action="return"]').click();
  await until(async () => await contents.evaluate(node => node === document.activeElement)
    && await previousAnchor.evaluate((node, offset) => {
      const pane = node.closest('.explain-scroll')!;
      return Math.abs(node.getBoundingClientRect().top - pane.getBoundingClientRect().top - offset) <= 2;
    }, previousOffset), 'after resizing, return restores the same chapter and focuses the directory button');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-action="detail"][data-detail="steps"]').click();
  await scroll.evaluate(node => { node.scrollTop = 0; });
  mark('the wide chapter list tracks scrolling, reaches the last section and restores focus after jumps');

  const legacy = await open(browser, page.url().split('#')[0] + '#explain-section-2', { storageState: await owner.context.storageState() });
  try {
    await legacy.page.locator('.explain-section.is-active').filter({ has: legacy.page.locator('#explain-section-2') }).waitFor();
    await until(() => shown(legacy.page, '#explain-section-2'), 'a legacy workbench link still opens its declaration');
    assert.equal(await legacy.page.locator('#explain-split').getAttribute('data-layout'), 'read');
    assert.equal(new URL(legacy.page.url()).hash, '#at=step_3');
  } finally { await legacy.context.close(); }
  mark('older links open the named chapter and are updated to its stable address');

  assert.equal(await page.locator('.explain-section .math-source').count(), 1, 'only the unclosed formula falls back in the prose sections');
  assert.equal(await page.locator('.explain-section .math-source').innerText(), 'x^{');
  assert.equal(await page.locator('.explain-section .math-source').getAttribute('data-math-state'), 'source');
  assert.equal(await page.locator('.explain-section .math-source').getAttribute('title'), 'x^{');
  assert.equal(await page.locator('.explain-section math mfrac').count(), 6, 'each saved fraction has a MathML numerator and denominator');
  const sums = await page.locator('.explain-section math').evaluateAll(nodes => nodes.flatMap(node =>
    [...node.querySelectorAll('msubsup, munderover')].filter(script => script.firstElementChild?.textContent?.includes('∑'))
      .map(script => [...script.children].slice(1).map(limit => limit.textContent?.replace(/\s/gu, '')))));
  assert.deepEqual(sums, [['i=1', '3'], ['i=1', '3']], 'both sums carry their actual lower and upper limits');
  const titled = await page.locator('.explain-section .math').evaluateAll(nodes => nodes.map(node => ({ title: node.getAttribute('title'),
    membership: [...node.querySelectorAll('math mo')].some(operator => operator.textContent === '∈'),
    naturals: [...node.querySelectorAll('math mi')].some(identifier => identifier.textContent === 'ℕ'
      || (identifier.textContent === 'N' && identifier.getAttribute('mathvariant') === 'double-struck')) })));
  assert.ok(titled.some(formula => formula.title === 'a, b \\in \\mathbb{N}' && formula.membership && formula.naturals),
    'a formula keeps its source as the title and renders set membership in the natural numbers');
  assert.equal(await page.locator('.explain-section strong').filter({ hasText: '前三个引理' }).count(), 1);
  mark('formulas, bold and code render as elements and an unparseable formula shows its source');

  const route = page.locator('#explain-prose .solution-route');
  const routeDisclosure = page.locator('[data-explain-route]');
  assert.equal(await routeDisclosure.getAttribute('open'), null);
  assert.equal(await route.count(), 0, 'the graph is only drawn after it is opened');
  const mainline = page.getByRole('region', { name: '证明主线' });
  assert.deepEqual(await mainline.locator('.explain-mainline-claim').allInnerTexts(), explained.route!.map(stage => stage.claim));
  const overviewDetail = page.locator('.explain-overview-detail');
  assert.equal(await overviewDetail.locator('p').isVisible(), false);
  await overviewDetail.locator('summary').click();
  assert.equal(await overviewDetail.locator('p').innerText(), explained.overview);
  await overviewDetail.locator('summary').click();
  const stage = mainline.locator('.explain-mainline > li').first();
  const declaration = stage.getByRole('button', { name: explained.sections[2]!.title });
  assert.equal(await declaration.count(), 0, 'the long declaration list is folded');
  await stage.locator('summary').click();
  await declaration.scrollIntoViewIfNeeded();
  await declaration.focus();
  const mainlinePosition = await page.locator('#explain-prose').evaluate(pane => pane.scrollTop);
  await page.keyboard.press('Enter');
  await page.locator('.explain-section.is-active #explain-section-2').waitFor();
  await until(() => shown(page, '.explain-section.is-active #explain-section-2'), 'the stage link reveals the declaration');
  assert.equal(await split.getAttribute('data-layout'), 'read', 'the stage link stays in reading mode');
  await until(() => page.evaluate(() => document.activeElement?.id === 'explain-section-2'), 'the stage link focuses the declaration');
  assert.match(page.url(), /#at=step_3$/u);
  await page.locator('[data-action="return"]').click();
  await until(async () => await declaration.evaluate(node => node === document.activeElement)
    && await page.locator('#explain-prose').evaluate((pane, offset) => pane.scrollTop === offset, mainlinePosition),
  'return restores the stage link focus and scroll position');
  mark('the saved main line keeps its claim order and jumps to an associated declaration and back');
  await routeDisclosure.locator(':scope > summary').click();
  await route.waitFor();
  assert.equal(await page.locator('.explain-provenance').getAttribute('open'), null, 'source and review context starts folded');
  assert.equal(await route.locator('.solution-route-overview').isVisible(), true, 'the proof outline stays available with the mathematical route');
  assert.equal(await route.getAttribute('data-solution-route-basis'), 'explanation');
  assert.equal(await route.locator('[data-solution-edge="dependency"][data-to="declaration:target_thm"]').count(), 6,
    'the common graph connects each cited helper to the target');
  assert.equal(await route.locator('[data-solution-node="derivation:target_thm:0"]').getAttribute('aria-pressed'), 'true',
    'an approved explanation opens on a visible mathematical step');
  assert.match(await route.locator('[data-solution-inspector]').innerText(), /前三个引理/u, 'the graph retains the full saved derivation');
  assert.equal(await route.locator('.solution-route-evidence').getAttribute('open'), null, 'technical evidence starts folded');
  await route.locator('.solution-route-evidence > summary').click();
  assert.match(await route.locator('[data-solution-inspector]').innerText(), /have k1 := step_1 a b/u, 'the graph shows the exact source of this step');
  await route.locator('[data-solution-open]').click();
  const graphLines = explained.sections.at(-1)!.steps[0]!.lines.flatMap(item => range(item.start, item.end));
  await until(async () => JSON.stringify(await marked(page, 'active')) === JSON.stringify(graphLines), 'the graph selects its exact Lean step');
  assert.equal(await page.locator('.explain-steps > li.is-active[data-step="0"]').getAttribute('data-anchor'), '6');
  await until(() => page.evaluate(() => document.activeElement?.id === 'explain-section-6'), 'opening a graph step focuses its prose section');
  await until(() => shown(page, '.explain-steps > li.is-active'), 'opening a graph step reveals its saved prose');
  assert.equal(await split.getAttribute('data-layout'), 'read', 'the graph stays in reading mode');
  await route.locator('[data-solution-node="declaration:target_thm"]').click();
  await route.locator('[data-solution-zoom="in"]').click();
  const routeZoom = await route.locator('[data-solution-zoom="reset"]').innerText();
  await routeDisclosure.locator(':scope > summary').click();
  await page.locator('[data-action="detail"][data-detail="outline"]').click();
  await page.locator('[data-action="detail"][data-detail="steps"]').click();
  assert.equal(await routeDisclosure.getAttribute('open'), null, 'a reader redraw keeps the optional route folded');
  await routeDisclosure.locator(':scope > summary').click();
  assert.equal(await route.locator('[data-solution-zoom="reset"]').innerText(), routeZoom, 'collapsing and reopening preserves graph zoom');
  assert.equal(await route.locator('[data-solution-node="declaration:target_thm"]').getAttribute('aria-pressed'), 'true', 'collapsing and reopening preserves graph selection');
  mark('the explanation starts with saved prose; its optional graph preserves selection and zoom and opens the exact prose section and Lean lines');

  // At a width where prose wraps differently in each layout, keep a partially visible step in place.
  await page.setViewportSize({ width: 1024, height: 900 });
  const readingStep = page.locator('.explain-steps > li[data-anchor="3"][data-step="1"]');
  const position = () => readingStep.evaluate(step =>
    step.getBoundingClientRect().top - step.closest('.explain-scroll')!.getBoundingClientRect().top);
  await readingStep.evaluate(step => {
    const pane = step.closest('.explain-scroll')!;
    pane.scrollTop += step.getBoundingClientRect().top - pane.getBoundingClientRect().top + 12;
  });
  const beforeLayout = await position();
  assert.ok(Math.abs(beforeLayout + 12) <= 2, 'the test step starts partly above the pane');
  await compareLayout.click();
  assert.equal(await split.getAttribute('data-layout'), 'compare');
  await until(async () => Math.abs(await position() - beforeLayout) <= 2, 'comparison keeps the same step at the top');
  await readLayout.click();
  assert.equal(await split.getAttribute('data-layout'), 'read');
  await until(async () => Math.abs(await position() - beforeLayout) <= 2, 'reading keeps the same step at the top');
  await page.setViewportSize({ width: 1440, height: 900 });
  mark('switching between reading and comparison preserves the visible proof step as the prose reflows');

  // Clicking a step's line chip opens comparison at its exact Lean lines; clicking a Lean line does the reverse.
  const sections = explained.sections, last = sections.length - 1;
  await page.locator(`[data-action="lines"][data-section="${last}"][data-step="0"]`).click();
  assert.equal(await split.getAttribute('data-layout'), 'compare', 'the line chip opens comparison');
  const quoted = sections[last]!.steps[0]!.lines.flatMap(item => range(item.start, item.end));
  await until(async () => JSON.stringify(await marked(page, 'active')) === JSON.stringify(quoted), 'the step lines are marked');
  assert.deepEqual(await marked(page, 'section'), range(sections[last]!.lines.start, sections[last]!.lines.end));
  await until(() => shown(page, `.lean-row[data-line="${quoted[0]}"]`), 'the Lean pane scrolls to the step');
  const line = sections[1]!.steps[0]!.lines[0]!.start;
  await page.locator(`.lean-row[data-line="${line}"]`).click();
  await page.locator('.explain-steps > li.is-active[data-anchor="1"][data-step="0"]').waitFor();
  await until(() => shown(page, '.explain-steps > li.is-active'), 'the prose pane scrolls to the step of the clicked line');
  mark('a step and its Lean lines select each other and each brings the other into view');

  // A cited lemma jumps to its own section; Back, the head's button or the browser's, returns to the citation.
  const cite = page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="0"] [data-action="use"]`).filter({ hasText: 'step_3' });
  const back = page.locator('#explain-prose-head [data-action="return"]'), address = page.url();
  // Where the reader is: both panes' scroll, once settled, and the chosen step.
  const place = async () => {
    let previous = '';
    for (;;) {
      const now = JSON.stringify(await page.evaluate(() => [document.querySelector('#explain-prose')!.scrollTop, document.querySelector('#explain-lean')!.scrollTop,
        [...document.querySelectorAll<HTMLElement>('.explain-steps > li.is-active, .explain-section.is-active > .explain-statement-block')].map(item => `${item.dataset.anchor}:${item.dataset.step ?? ''}`)]));
      if (now === previous) return now;
      previous = now;
      await page.waitForTimeout(150);
    }
  };
  const citedSection = async () => {
    await page.locator('.explain-section.is-active').filter({ hasText: 'step_3' }).waitFor();
    await until(async () => JSON.stringify(await marked(page, 'active')) === JSON.stringify(range(sections[2]!.lines.start, sections[2]!.lines.end)), 'the cited declaration is marked');
    await until(() => shown(page, '.explain-section.is-active header'), 'the cited section scrolls into view');
  };
  await cite.scrollIntoViewIfNeeded();
  const before = await place();
  assert.equal(await back.count(), 0, 'nothing to go back to before a jump');
  await cite.click();
  await citedSection();
  assert.equal(await back.innerText(), '返回阅读位置');
  assert.notEqual(await place(), before, 'the jump moved the prose');
  // The reader looks around the cited lemma's Lean before going back.
  await page.locator('#explain-lean').evaluate(pane => { pane.scrollTop += 240; });
  mark('a cited lemma jumps to its section and marks the whole declaration');
  await back.click();
  await back.waitFor({ state: 'detached' });
  assert.equal(await place(), before, 'the button returns to the same scroll and step');
  assert.ok(await cite.evaluate(node => node === document.activeElement), 'focus is back on the cited name');
  assert.equal(page.url(), address, 'the address never changes');
  await cite.click();
  await citedSection();
  await page.evaluate(() => history.back());
  await back.waitFor({ state: 'detached' });
  assert.equal(await place(), before, 'the browser\'s Back returns the same way');
  await page.evaluate(() => history.forward());
  await citedSection();
  await back.waitFor();
  await page.evaluate(() => history.back());
  await back.waitFor({ state: 'detached' });
  assert.equal(await place(), before);
  // From the keyboard, focus follows the jump to the section's heading and comes back with Back.
  await cite.focus();
  await page.keyboard.press('Enter');
  await citedSection();
  await until(() => page.evaluate(() => document.activeElement?.id === 'explain-section-2'), 'focus moves to the cited section');
  await page.evaluate(() => history.back());
  await back.waitFor({ state: 'detached' });
  assert.equal(await place(), before);
  await until(() => cite.evaluate(node => node === document.activeElement), 'focus returns to the cited name');
  assert.equal(page.url(), address);
  // Two jumps deep, each press of the button undoes one, the button staying until the first citation.
  const second = page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="0"] [data-action="use"]`).filter({ hasText: 'step_1' });
  await cite.click();
  await citedSection();
  await second.scrollIntoViewIfNeeded();
  const middle = await place();
  await second.click();
  await page.locator('.explain-section.is-active').filter({ hasText: 'step_1' }).waitFor();
  await back.click();
  await until(async () => await place() === middle, 'the first press returns to the second citation');
  assert.ok(await second.evaluate(node => node === document.activeElement), 'focus is on the second citation');
  await back.click();
  await back.waitFor({ state: 'detached' });
  assert.equal(await place(), before, 'the second press returns to the first citation');
  assert.ok(await cite.evaluate(node => node === document.activeElement));
  mark('back from a cited lemma (the button, the browser\'s Back and Forward, or the keyboard, one jump at a time) restores the scroll, step and focus');

  // The margin beside the line numbers: each step's number on its first line, a bar for the statement, a ring where no step quotes the line.
  const gutter = await page.locator('#explain-lean-code .lean-row').evaluateAll(rows => rows.flatMap(row => {
    const margin = row.children[1] as HTMLElement, kind = /\bis-(step|statement|unexplained)\b/u.exec(margin.className)?.[1];
    return kind ? [`${(row as HTMLElement).dataset.line}:${kind}${margin.classList.contains('is-first') ? '*' : ''}${margin.textContent ? '=' + margin.textContent : ''}`] : [];
  }));
  assert.deepEqual(gutter, [...leanGutter(explained)].sort(([a], [b]) => a - b)
    .map(([at, item]) => `${at}:${item.kind}${item.first ? '*' : ''}${item.kind === 'step' && item.first ? '=' + (item.step + 1) : ''}`));
  const gap = sections[last]!.unexplained;
  assert.deepEqual(gap, [sections[last]!.lines.start + 4], 'the target leaves `have k4` to no step');
  assert.ok(gutter.includes(`${gap[0]}:unexplained*`) && gutter.includes(`${sections[last]!.lines.start + 1}:step*=1`), 'the skipped line is ringed, the first step numbered');
  assert.equal(await page.locator('#explain-lean-legend').evaluate(node => node.textContent), '1讲解步骤由陈述讲解没有单独讲解 (1 行)');
  assert.deepEqual(explained.metrics, { ...explained.metrics, proofLines: 73, explainedLines: 72, ambiguousExcerpts: 0 });
  const provenance = await page.locator('.explain-provenance .explain-facts').textContent();
  assert.ok(provenance.includes('72/73') && !provenance.includes('重复出现的引用片段'), `the review details count explained proof lines: ${provenance}`);
  mark('the margin numbers each step on its lines, bars the statement and rings the line no step explains, with a legend');

  // A theorem's statement is tied to its signature, both ways.
  const signature = (index: number) => range(sections[index]!.signature.start, sections[index]!.signature.end);
  await page.locator('.explain-statement-block[data-anchor="1"] [data-statement]').click();
  await until(async () => JSON.stringify(await marked(page, 'active')) === JSON.stringify(signature(1)), 'the statement marks the signature');
  await page.locator('.explain-statement-block.is-active[data-anchor="1"]').waitFor();
  await page.locator(`.lean-row[data-line="${sections[last]!.signature.start}"]`).click();
  await page.locator(`.explain-statement-block.is-active[data-anchor="${last}"]`).waitFor();
  await until(async () => JSON.stringify(await marked(page, 'active')) === JSON.stringify(signature(last)), 'the signature line selects the statement');
  await page.locator('.explain-section.is-target .explain-statement-details[open] .explain-statement').waitFor();
  await until(() => shown(page, `.explain-statement-block[data-anchor="${last}"]`), 'the prose shows the statement');
  assert.equal(await page.locator('.explain-statement-block.is-active').count(), 1);
  await page.locator('.explain-section.is-target .explain-statement-details > summary').click();
  mark('a statement and its signature lines select each other');

  // A line no step quotes opens its declaration with a note that says so; opening auditor notes keeps the selection.
  await page.locator(`.lean-row[data-line="${gap[0]}"]`).click();
  await page.locator('.explain-section.is-active.is-target .explain-gap-note').filter({ hasText: `第 ${gap[0]} 行没有单独的讲解步骤` }).waitFor();
  assert.deepEqual(await marked(page, 'active'), gap);
  assert.equal(await page.locator('.explain-steps > li.is-active, .explain-statement-block.is-active').count(), 0);
  mark('a line no step quotes opens its declaration with a note');

  // A single disclosure shows the auditor notes and any recorded goals together.
  assert.deepEqual(sections.map(section => section.steps.filter(step => step.goals).length), [0, 0, 0, 0, 0, 0, 2]);
  assert.equal(await page.locator('.explain-section .explain-review-notes').count(), 21, 'all recorded auditor notes remain in the document');
  assert.equal(await page.locator('.explain-goals').count(), 2);
  assert.equal(await page.locator('.explain-goals:visible').count(), 0);
  const panel = page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="1"] > details`);
  assert.equal(await panel.locator('summary').innerText(), '核对这一步');
  await panel.locator('summary').click();
  assert.equal(await panel.locator('.explain-goals .explain-evidence-label').innerText(), `Lean 目标 · 第 ${gap[0]! + 1}–${gap[0]! + 3} 行`);
  assert.equal(await panel.locator('.explain-review-notes li').innerText(), 'Step 2 is what the quoted Lean does.');
  assert.deepEqual(await panel.locator('pre.explain-goal').allTextContents(), [goalAfter(4)]);
  assert.deepEqual(await panel.locator('.explain-goal-label, .explain-goal-none').allTextContents(), ['之前', '之后', '没有剩余目标']);
  assert.equal(await panel.locator('pre.explain-goal').getAttribute('translate'), 'no');
  assert.deepEqual(await marked(page, 'active'), gap, 'opening the evidence keeps the selection');
  const first = page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="0"] > details`);
  await first.locator('summary').click();
  assert.deepEqual(await first.locator('pre.explain-goal').allTextContents(), [goalAfter(0), goalAfter(3)]);
  await first.locator('summary').click();
  await panel.screenshot({ path: path.join(output, 'explain-goals-1440.png') });
  mark('one disclosure opens the step’s goals and auditor notes without changing the Lean selection');

  // Choices within one section each redraw it: the whole declaration drops the gap note, then its statement, then each step.
  const own = (selector: string) => page.locator(`.explain-section:has(#explain-section-${last}) ${selector}`);
  await own('.explain-section-meta [data-action="lines"]').click();
  await own('.explain-gap-note').waitFor({ state: 'detached' });
  await page.locator('.explain-section.is-active').filter({ has: page.locator(`#explain-section-${last}`) }).waitFor();
  assert.deepEqual(await marked(page, 'active'), range(sections[last]!.lines.start, sections[last]!.lines.end));
  await own('.explain-statement-details > summary').click();
  await own('.explain-statement-block [data-action="lines"][data-statement]').click();
  await page.locator(`.explain-statement-block.is-active[data-anchor="${last}"]`).waitFor();
  assert.equal(await page.locator('.explain-section.is-active').count(), 0, 'the statement replaces the whole declaration');
  for (const step of [0, 1]) {
    await own(`.explain-steps > li[data-step="${step}"] [data-action="lines"]`).click();
    await page.locator(`.explain-steps > li.is-active[data-anchor="${last}"][data-step="${step}"]`).waitFor();
    assert.equal(await page.locator('.explain-steps > li.is-active, .explain-statement-block.is-active').count(), 1, `only step ${step + 1} is chosen`);
    assert.deepEqual(await marked(page, 'active'), sections[last]!.steps[step]!.lines.flatMap(item => range(item.start, item.end)));
  }
  mark('choosing the declaration, its statement and each of its steps in turn redraws the section each time');

  // A cited library name is marked where the Lean writes it; one the Lean does not write stays plain text.
  const written = sections[0]!.steps[0]!.uses[0]!;
  assert.deepEqual([written.name, written.place, written.spans.length], ['Nat.add_comm', 'step', 5]);
  const highlighted = () => page.evaluate(() => [...(CSS.highlights.get('explain-use') ?? [])].map(item => (item as Range).toString()));
  const chip = page.locator('.explain-steps > li[data-anchor="0"][data-step="0"] [data-action="use-lean"]');
  await readLayout.click();
  await chip.hover();
  await until(async () => JSON.stringify(await marked(page, 'use')) === JSON.stringify(written.spans.map(span => span.line)), 'pointing at the name marks its lines');
  assert.equal(await split.getAttribute('data-layout'), 'read', 'hovering does not open comparison');
  await chip.click();
  assert.equal(await split.getAttribute('data-layout'), 'compare', 'an explicit Lean citation opens comparison');
  await until(async () => (await highlighted()).length === 5, 'clicking the name highlights each place it is written');
  assert.deepEqual([...new Set(await highlighted())], ['Nat.add_comm']);
  await until(() => shown(page, `.lean-row[data-line="${written.spans[0]!.line}"]`), 'the Lean pane scrolls to the name');
  await page.locator('#explain-lean').hover();
  assert.equal((await highlighted()).length, 5, 'the clicked name stays marked when the pointer leaves');
  await page.locator(`.lean-row[data-line="${sections[0]!.lines.start + 1}"]`).click();
  await until(async () => (await highlighted()).length === 0 && (await marked(page, 'use')).length === 0, 'choosing a line clears the name marks');
  const plain = page.locator('.explain-steps > li[data-anchor="0"][data-step="1"] code.explain-use.place-implicit');
  assert.equal(await plain.evaluate(node => node.firstChild?.textContent), 'Nat.add_assoc');
  assert.match(await plain.getAttribute('title') ?? '', /没有直接写出/u);
  // An owned lemma cited on a line its step does not quote still links to the lemma.
  assert.equal(await page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="0"] [data-action="use"].place-declaration`).filter({ hasText: 'step_4' }).count(), 1);
  mark('a cited name is marked where the Lean writes it, an unwritten one stays plain, and an owned one links to its section');

  // Scroll sync, both ways, and off.
  const visibleRows = () => page.locator('#explain-lean-code .lean-row').evaluateAll(rows => {
    const pane = document.querySelector('#explain-lean')!.getBoundingClientRect();
    return rows.filter(row => { const box = row.getBoundingClientRect(); return box.bottom > pane.top && box.top < pane.bottom; })
      .map(row => Number((row as HTMLElement).dataset.line));
  });
  const firstAnchor = () => page.locator('#explain-prose [data-anchor]').evaluateAll(anchors => {
    const top = document.querySelector('#explain-prose')!.getBoundingClientRect().top;
    const anchor = (anchors as HTMLElement[]).find(item => item.getBoundingClientRect().bottom > top + 8)!;
    return { section: Number(anchor.dataset.anchor), ...(anchor.dataset.step ? { step: Number(anchor.dataset.step) } : {}) };
  });
  const scrollTop = (selector: string) => page.locator(selector).evaluate(node => node.scrollTop);
  await page.waitForTimeout(900);
  await page.locator('#explain-prose').hover();
  await page.mouse.wheel(0, 1400);
  await page.waitForTimeout(600);
  const ref = await firstAnchor(), lines = refLines(explained, ref).flatMap(item => range(item.start, item.end)), rows = await visibleRows();
  assert.ok(lines.some(item => rows.includes(item)), `the Lean pane follows the prose: ${JSON.stringify({ ref, rows: [rows[0], rows.at(-1)] })}`);
  await page.locator('#explain-lean').hover();
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(600);
  const top = (await visibleRows())[1]!, step = stepAtLine(explained, top);
  assert.ok(step, `line ${top} belongs to a declaration`);
  assert.ok(await shown(page, step.step === undefined ? `[data-anchor="${step.section}"]:not([data-step])` : `[data-anchor="${step.section}"][data-step="${step.step}"]`),
    `the prose follows the Lean pane to ${JSON.stringify(step)}`);
  await page.locator('#explain-sync').uncheck();
  const still = await scrollTop('#explain-lean');
  await page.locator('#explain-prose').hover();
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(600);
  assert.equal(await scrollTop('#explain-lean'), still, 'with sync off the Lean pane stays put');
  await page.locator('#explain-sync').check();
  mark('the panes scroll together in both directions, and not when sync is off');

  // The route names where each declaration comes from, the overview shows the Lean statement and what Lean checked.
  assert.deepEqual(await route.locator('.solution-route-legend i[data-origin]').evaluateAll(items => items.map(item => item.getAttribute('data-origin'))), ['target', 'lemma']);
  assert.ok((await route.locator('.solution-route-legend i[data-edge]').evaluateAll(items => items.map(item => item.getAttribute('data-edge')))).includes('dependency'),
    'the legend names each kind of line on the map');
  // Library results the steps cite are nodes of their own, shown on request; choosing one is kept in the address.
  assert.equal(await route.locator('[data-solution-node^="library:"]').count(), 0, 'library results stay out of the map until asked for');
  await route.locator('[data-solution-library]').click();
  assert.equal(await route.locator('[data-solution-node^="library:"]').count(), 2);
  assert.equal(await route.locator('[data-solution-edge="reference"][data-from="library:Nat.add_comm"]').count(), 6, 'a library result points at each declaration citing it');
  await route.locator('[data-solution-node="library:Nat.add_comm"]').click();
  await until(async () => new URLSearchParams(new URL(page.url()).hash.slice(1)).get('node') === 'library:Nat.add_comm', 'the address names the chosen route node');
  await route.locator('[data-solution-node="declaration:step_1"]').click();
  await route.locator('[data-solution-library]').click();
  assert.equal(await route.locator('[data-solution-node^="library:"]').count(), 0);
  // The audited route gives the main line.
  assert.deepEqual(await route.locator('.solution-route-stages button > span:last-child').allInnerTexts(), ['First the lemmas.', 'Then the target follows.']);
  assert.equal(await route.locator('[data-solution-node="declaration:step_1"]').getAttribute('data-origin'), 'lemma');
  assert.match(await route.locator('.solution-route-overview pre').first().innerText(), /^theorem target_thm/u, 'the overview shows the Lean statement of the target');
  assert.match(await route.locator('.solution-route-overview').innerText(), /目标定理已通过 Lean 检查，不依赖 sorry/u);
  assert.ok(await route.locator('.solution-route-stages button').count() >= 2, 'the main line of the proof is offered as stages');
  // The outline keeps one statement per declaration; a section unfolds on request, and the address names the chosen step.
  await page.locator(`[data-action="lines"][data-section="${last}"][data-step="0"]`).click();
  await page.locator('[data-action="detail"][data-detail="outline"]').click();
  await until(async () => await page.locator('.explain-steps').count() === 1, 'the outline folds every step but the chosen one');
  assert.equal(await page.locator('.explain-unfold').count(), sections.length - 1);
  assert.equal(await page.locator('.explain-summary').count(), sections.length - 1, 'summaries are shown for folded sections');
  await page.locator('.explain-unfold[data-section="1"]').click();
  await page.locator('.explain-steps > li[data-anchor="1"][data-step="1"] [data-action="lines"]').first().click();
  await until(async () => new URL(page.url()).hash === '#at=step_2&step=2&view=outline&node=declaration%3Astep_1', 'the address names the declaration, the step, the outline and the route node');
  assert.equal(await page.locator('.explain-section').nth(3).locator('.explain-statement').count(), 0, 'a folded declaration shows its summary in place of the full statement');
  await page.reload();
  assert.equal(await routeDisclosure.getAttribute('open'), '', 'a route-node deep link opens the optional route');
  await until(async () => await route.locator('[data-solution-node="declaration:step_1"]').getAttribute('aria-pressed') === 'true', 'a link reopens its route node');
  await page.locator('.explain-steps > li.is-active[data-anchor="1"][data-step="1"]').waitFor();
  assert.equal(await split.getAttribute('data-layout'), 'read', 'a link to a prose step starts in reading mode');
  assert.equal(await page.locator('[data-action="detail"][data-detail="outline"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.explain-steps').count(), 1, 'a link opens the outline with only its own declaration unfolded');
  await page.locator('[data-action="detail"][data-detail="steps"]').click();
  await until(async () => await page.locator('.explain-steps').count() === sections.length, 'step by step shows every step again');
  assert.equal(new URL(page.url()).hash, '#at=step_2&step=2&node=declaration%3Astep_1');
  mark('the route shows origins, line kinds, library results, the audited main line, the Lean statement and the verification status; the outline folds to summaries; a copied link reopens the same step and route node');

  // The Markdown download is the same explanation as a file.
  const download = await page.locator('#explain-prose-head a[download]').getAttribute('href');
  const file = await page.evaluate(async url => { const response = await fetch(url!);
    return { status: response.status, disposition: response.headers.get('content-disposition'), text: await response.text() }; }, download);
  assert.equal(file.status, 200);
  assert.match(file.disposition ?? '', /^attachment;/u);
  assert.ok(file.text.includes('target_thm') && file.text.includes('前三个引理'), 'the file carries the explanation');
  await page.locator('#explain-prose').evaluate(node => { node.scrollTop = 0; });
  await page.locator(`[data-action="lines"][data-section="${last}"][data-step="0"]`).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(output, 'explain-document-1440.png') });
  await page.locator('.explain-section').first().screenshot({ path: path.join(output, 'explain-lemma-section-1440.png') });
  // The gap note and an opened auditor note are on screen for the checks.
  await page.locator(`.lean-row[data-line="${gap[0]}"]`).click();
  await page.locator(`.explain-statement-block[data-anchor="${last}"] .explain-reviews summary`).click();
  await page.waitForTimeout(800);
  await page.locator('.explain-section.is-target').screenshot({ path: path.join(output, 'explain-target-section-1440.png') });
  assert.deepEqual(await audit(page), [], 'accessibility problems on the explanation page');
  assert.deepEqual(await contrastProblems(page, '#explain-content'), [], 'explanation contrast below WCAG AA (light)');
  mark('the Markdown download works and the page passes the accessibility and contrast checks');

  const storageState = await owner.context.storageState(), cleanAddress = new URL(page.url());
  cleanAddress.hash = '';
  const url = cleanAddress.href;
  const dark = await open(browser, url, { theme: 'dark', storageState });
  await dark.page.locator('#explain-prose .explain-document').waitFor();
  assert.deepEqual(await contrastProblems(dark.page, '.explain-topbar'), [], 'explanation topbar contrast below WCAG AA (dark)');
  await mathReady(dark.page);
  await dark.page.locator(`[data-action="lines"][data-section="${last}"][data-step="1"]`).click();
  await dark.page.locator('.explain-steps > li[data-anchor="0"][data-step="0"] [data-action="use-lean"]').click();
  await dark.page.waitForTimeout(800);
  await dark.page.screenshot({ path: path.join(output, 'explain-use-dark-1440.png') });
  await dark.page.locator(`.lean-row[data-line="${gap[0]}"]`).click();
  await dark.page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="1"] > details > summary`).click();
  await dark.page.waitForTimeout(800);
  assert.deepEqual(await contrastProblems(dark.page, '#explain-content'), [], 'explanation contrast below WCAG AA (dark)');
  await dark.page.screenshot({ path: path.join(output, 'explain-document-dark-1440.png') });
  // Printed, the served page drops its own controls too (back, language, sync, download, delete) and prints in light colours.
  await dark.page.locator('[data-action="layout"][data-layout="read"]').click();
  assert.equal(await dark.page.locator('#explain-split').getAttribute('data-layout'), 'read');
  assert.deepEqual(await printLayout(dark.page), { clipped: [], panes: ['prose', 'lean'], leanBreak: 'page', wrap: 'pre-wrap', lines: 1, wide: 0,
    controls: [], paper: 'rgb(245, 244, 238)' }, 'the explanation printed (dark)');
  assert.ok(await printedPages(dark.page) >= 2, 'the Lean prints on a page of its own');
  await dark.context.close();
  mark('the dark theme passes the contrast check and prints as one light document without controls');

  // Phones show one pane at a time; a step's line chip switches to the proof.
  const phone = await open(browser, url, { width: 390, height: 844, storageState });
  await phone.page.locator('#explain-prose .explain-document').waitFor();
  await mathReady(phone.page);
  assert.equal(await phone.page.locator('#explain-split').getAttribute('data-pane'), 'prose');
  assert.equal(await phone.page.locator('#explain-lean').isVisible(), false, 'the proof pane waits behind the switch');
  assert.equal(await phone.page.locator('#explain-sync').isVisible(), false, 'sync has no meaning with one pane');
  assert.equal(await phone.page.locator('[data-explain-route]').getAttribute('open'), null, 'the phone opens directly on prose');
  assert.equal(await phone.page.locator('.solution-route').isVisible(), false);
  await phone.page.screenshot({ path: path.join(output, 'explain-prose-390.png') });

  await phone.page.setViewportSize({ width: 320, height: 520 });
  await phone.page.locator('[data-reading-section="5"]').evaluate(section => {
    const pane = section.closest('.explain-scroll')!;
    pane.scrollTop += section.getBoundingClientRect().top - pane.getBoundingClientRect().top + 28;
  });
  await phone.page.getByRole('button', { name: '证明目录' }).click();
  const phoneDirectory = phone.page.getByRole('dialog', { name: '证明目录' });
  const phoneCurrent = phoneDirectory.locator('[aria-current="location"][data-target="5"]');
  assert.equal(await phoneCurrent.evaluate(row => {
    const list = row.closest('.explain-contents-list')!, listBox = list.getBoundingClientRect(), box = row.getBoundingClientRect();
    return list.scrollTop > 0 && box.top >= listBox.top && box.bottom <= listBox.bottom + 1 && list.scrollWidth <= list.clientWidth;
  }), true, 'the phone directory scrolls to the current entry within the modal without horizontal overflow');
  await phone.page.screenshot({ path: path.join(output, 'explain-contents-320.png') });
  await phone.page.keyboard.press('Escape');
  await phoneDirectory.waitFor({ state: 'hidden' });
  await phone.page.setViewportSize({ width: 390, height: 844 });

  // Long formulas stay within the phone pane; an indivisible expression can scroll inside its own box when needed.
  const formulas = await phone.page.locator('#explain-prose').evaluate(pane => {
    const style = getComputedStyle(pane), bounds = pane.getBoundingClientRect();
    const left = bounds.left + parseFloat(style.paddingLeft), right = bounds.left + pane.clientWidth - parseFloat(style.paddingRight);
    const all = [...pane.querySelectorAll<HTMLElement>('.explain-section .math')], long = all.find(item => item.getAttribute('title')?.includes('succ'))!;
    const over = all.filter(item => [...item.getClientRects()].some(rect => rect.left < left - 1 || rect.right > right + 1)).length;
    const source = long.title, width = long.style.width, maxWidth = long.style.maxWidth;
    long.style.width = '3em'; long.style.maxWidth = '3em';
    const overflow = long.scrollWidth > long.clientWidth + 1, scrollable = /auto|scroll/u.test(getComputedStyle(long).overflowX);
    long.scrollLeft = long.scrollWidth;
    const scrolled = long.scrollLeft > 0;
    long.style.width = width; long.style.maxWidth = maxWidth; long.scrollLeft = 0;
    return { over, paneWide: pane.scrollWidth > pane.clientWidth + 1, pageWide: document.documentElement.scrollWidth > innerWidth + 1,
      ready: long.dataset.mathState === 'ready', semantic: Boolean(long.querySelector('math')), overflow, scrollable, scrolled, source };
  });
  assert.deepEqual(formulas, { over: 0, paneWide: false, pageWide: false, ready: true, semantic: true,
    overflow: true, scrollable: true, scrolled: true,
    source: 'a + b + 1 = \\mathrm{succ}\\,(a + b) = \\mathrm{succ}\\,(b + a) = b + a + 1' });
  const phoneGoals = phone.page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="0"] > details`);
  await phoneGoals.locator('summary').click();
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'open goals do not widen the phone page');
  await phoneGoals.screenshot({ path: path.join(output, 'explain-goals-390.png') });
  const phoneProse = () => phone.page.locator('#explain-prose').evaluate(pane => Math.round(pane.scrollTop));
  const lineChip = phone.page.locator(`[data-action="lines"][data-section="${last}"][data-step="0"]`);
  await lineChip.scrollIntoViewIfNeeded();
  await lineChip.focus();
  const beforeLean = await phoneProse();
  await phone.page.keyboard.press('Enter');
  await phone.page.locator('#explain-split[data-pane="lean"]').waitFor();
  await until(() => shown(phone.page, `.lean-row[data-line="${quoted[0]}"]`), 'the phone proof pane shows the step');
  await phone.page.locator('#explain-lean:focus').waitFor();
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'nothing widens the phone page');
  // Long lines wrap rather than run off the pane, and each row's indentation reaches the style under the page's policy.
  assert.equal(await phone.page.locator('#explain-lean').evaluate(pane => pane.scrollWidth <= pane.clientWidth + 1), true, 'the phone Lean pane wraps');
  const hangs = await phone.page.locator('#explain-lean-code .lean-row:is([data-line="1"],[data-line="2"]) .lean-text').evaluateAll(texts =>
    texts.map(text => -parseFloat(getComputedStyle(text).textIndent)));
  assert.ok(hangs[0]! > 0 && Math.abs(hangs[1]! / hangs[0]! - 1.5) < 0.01, `hangs ${hangs.join(', ')}`);
  await phone.page.screenshot({ path: path.join(output, 'explain-lean-390.png') });
  // A cited name opens the proof at the line that writes it.
  await phone.page.locator('[data-action="pane"][data-pane="prose"]').click();
  await until(async () => await phoneProse() === beforeLean, 'returning from Lean retains the prose position');
  await phone.page.locator('.explain-steps > li[data-anchor="0"][data-step="0"] [data-action="use-lean"]').click();
  await phone.page.locator('#explain-split[data-pane="lean"]').waitFor();
  await until(() => shown(phone.page, `.lean-row[data-line="${written.spans[0]!.line}"]`), 'the phone proof pane shows the name');
  assert.deepEqual(await audit(phone.page), [], 'accessibility problems on the phone layout');
  await phone.page.locator('[data-action="pane"][data-pane="prose"]').click();
  await phone.page.locator('#explain-split[data-pane="prose"]').waitFor();
  // Back after a cited lemma (the phone's back gesture) returns to the citation, even from the proof pane.
  const phoneCite = phone.page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="0"] [data-action="use"]`).filter({ hasText: 'step_3' });
  await phoneCite.scrollIntoViewIfNeeded();
  const phoneBefore = await phoneProse();
  await phoneCite.click();
  await phone.page.locator('#explain-prose-head [data-action="return"]').waitFor();
  await phone.page.locator('[data-action="pane"][data-pane="lean"]').click();
  await phone.page.evaluate(() => history.back());
  await phone.page.locator('#explain-split[data-pane="prose"]').waitFor();
  await until(async () => await phoneProse() === phoneBefore, 'the phone explanation is back at the citation');
  await phone.context.close();
  mark('on a 390 pixel phone the panes switch, long Lean lines wrap and formulas stay within their own scrollable boxes, a line chip or a cited name opens the proof there, and Back after a cited lemma returns to the citation from either pane');

  // In English the page chrome is English; the explanation keeps its own language and English has its own empty card.
  const english = await open(browser, url, { locale: 'en', storageState });
  await english.page.locator('#explain-prose .explain-document').waitFor();
  assert.equal(await english.page.locator('#explain-prose-heading').innerText(), 'Natural-language proof');
  assert.equal(await english.page.locator('#explain-lean-heading').innerText(), 'Lean proof');
  assert.equal(await english.page.locator('[data-explain-route] > summary').innerText(), 'Dependency graph');
  assert.equal(await english.page.locator('#explain-mainline-heading').innerText(), 'Main line of proof');
  assert.equal(await english.page.locator('[data-explain-route]').getAttribute('open'), null);
  for (const width of [320, 390, 430, 1024]) {
    await english.page.setViewportSize({ width, height: 844 });
    await english.page.getByRole('button', { name: 'Read the main proof' }).click();
    const returnToReading = english.page.getByRole('button', { name: 'Back to where you were' });
    await returnToReading.waitFor();
    for (const selector of ['.explain-topbar-inner', '.explain-controls-inner']) {
      const clipped = await english.page.locator(selector).evaluate(header => {
        const bounds = header.getBoundingClientRect();
        return [...header.querySelectorAll('button,a,input')].filter(control => control.getClientRects().length)
          .some(control => {
            const box = control.getBoundingClientRect();
            return box.left < bounds.left - 1 || box.right > bounds.right + 1;
          });
      });
      assert.equal(clipped, false, `All controls in ${selector} fit at ${width}px after a jump`);
    }
    await returnToReading.click();
    await returnToReading.waitFor({ state: 'detached' });
  }
  await english.page.setViewportSize({ width: 1440, height: 900 });
  const chrome = await english.page.evaluate(() => {
    const han = /\p{Script=Han}/u, found: string[] = [];
    for (const scope of document.querySelectorAll('.explain-topbar, .explain-controls, .explain-pane-head, #explain-lean-legend, .explain-provenance, .explain-section-meta'))
      for (const element of scope.querySelectorAll('*')) {
        if (element.closest('[lang="zh-CN"]') || element.children.length) continue;
        const text = element.textContent?.trim() ?? '';
        if (han.test(text)) found.push(text.slice(0, 60));
      }
    return found;
  });
  assert.deepEqual(chrome, [], 'English chrome has no Chinese text');
  assert.doesNotMatch(await english.page.locator('#explain-lean-legend').innerText(), /\p{Script=Han}/u, 'the margin legend is English');
  const englishGoals = english.page.locator('.explain-steps > li > details:has(.explain-goals)').first();
  assert.equal(await englishGoals.locator('summary').innerText(), 'Check this step');
  await englishGoals.locator('summary').click();
  assert.match(await englishGoals.locator('.explain-goals .explain-evidence-label').innerText(), /^Lean goals · Lines \d+–\d+$/u);
  assert.deepEqual(await englishGoals.locator('.explain-goal-label').allTextContents(), ['Before', 'After']);
  // The report's link names no language: it opens the explanation that exists, here the Chinese one.
  await english.page.goto(`${origin}/${href}`);
  await english.page.locator('#explain-prose .explain-document').waitFor();
  assert.equal(new URL(english.page.url()).searchParams.get('language'), 'zh');
  // Back after a cited lemma and a language switch opens the language it was cited in; Forward, the switched one.
  const englishCite = english.page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="0"] [data-action="use"]`).filter({ hasText: 'step_3' });
  await englishCite.click();
  await english.page.locator('#explain-prose-head [data-action="return"]').waitFor();
  await english.page.locator('[data-action="language"][data-language="en"]').click();
  await english.page.locator('#explain-prose [data-action="generate"]').waitFor();
  await english.page.evaluate(() => history.back());
  await english.page.locator('[data-action="language"][data-language="zh"][aria-pressed="true"]').waitFor();
  await englishCite.waitFor();
  assert.equal(new URL(english.page.url()).searchParams.get('language'), 'zh');
  await english.page.evaluate(() => history.forward());
  await english.page.locator('#explain-prose [data-action="generate"]').waitFor();
  assert.equal(new URL(english.page.url()).searchParams.get('language'), 'en');
  await english.page.evaluate(() => history.back());
  await englishCite.waitFor();
  await english.page.locator('[data-action="language"][data-language="en"]').click();
  await english.page.locator('#explain-prose [data-action="generate"]').waitFor();
  assert.equal(new URL(english.page.url()).searchParams.get('language'), 'en');
  await english.page.screenshot({ path: path.join(output, 'explain-english-empty-1440.png') });
  await english.context.close();
  mark('English chrome is English, a link without a language opens the existing explanation, English is a separate one, and Back after a cited lemma crosses a language switch');

  // A short completed proof leaves its technical metadata available without expanding it in the reading flow.
  const shortRun = await postRun({ page }, { ...input, task: 'Short viewport fixture', source: shortProof.replace('simp', 'sorry') });
  await until(async () => (await readRun({ page }, shortRun.id)).status === 'completed', 'the short fixture run finishes');
  const shortPage = await owner.context.newPage();
  await shortPage.goto(`${origin}/explain.html?run=${shortRun.id}`);
  await shortPage.locator('.explain-card').waitFor();
  assert.ok(await shortPage.locator('.explain-card').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight - 16), 'The initial explanation card fits above the desktop fold');
  await shortPage.locator('#explain-prose [data-action="generate"]').click();
  await shortPage.locator('#explain-dialog[open] #explain-api-key').fill(credential);
  await shortPage.locator('#explain-dialog[open] button[type="submit"]').click();
  await shortPage.locator('#explain-prose .explain-document').waitFor();
  await mathReady(shortPage);
  const shortFacts = shortPage.locator('.explain-provenance');
  const disclosure = shortFacts.locator('summary');
  assert.equal(await shortFacts.getAttribute('open'), null);
  assert.equal(await shortFacts.getByText('Lean 工具链', { exact: true }).isVisible(), false);
  assert.ok(await disclosure.evaluate(node => node.getBoundingClientRect().bottom <= innerHeight - 16),
    'The metadata disclosure fits above the desktop fold');
  await disclosure.click();
  assert.equal(await shortFacts.getByText('Lean 工具链', { exact: true }).isVisible(), true);
  await shortPage.screenshot({ path: path.join(output, 'explain-short-metadata-1440.png') });
  await shortPage.close();
  mark('technical metadata stays folded until requested, with its disclosure above the fold on a short proof');

  // Deleting asks first and leaves the page ready to generate again.
  await page.locator('#explain-prose-head [data-action="delete"]').click();
  await page.locator('#explain-dialog[open] [data-action="confirm-delete"]').click();
  await page.locator('#explain-toast:not([hidden])').filter({ hasText: '讲解已删除' }).waitFor();
  await page.locator('#explain-prose [data-action="generate"]').waitFor();
  assert.equal(await page.evaluate(async url => (await fetch(url)).status, item), 404);
  mark('deleting asks for confirmation and returns the page to its empty state');

  // Another account, a malformed link and an unknown run all end on a plain message.
  const stranger = await open(browser, url);
  await stranger.page.locator('#explain-missing:not([hidden])').filter({ hasText: '运行不存在，或不属于当前账号。' }).waitFor();
  await stranger.page.goto(`${origin}/explain.html?run=nope`);
  await stranger.page.locator('#explain-missing:not([hidden])').filter({ hasText: '链接不完整' }).waitFor();
  await stranger.context.close();
  mark('another session sees no trace of the run, and a malformed link explains itself');

  const unexpected = errors.filter(text => !/status of 404/u.test(text));
  assert.deepEqual(unexpected, [], 'no page or console errors (CSP included)');
  console.log('Explanation checks passed: report link, generate/stop/regenerate, approved document, formulas, two-way selection, line margin, statement and signature, unexplained line, auditor notes, Lean goals, cited names in Lean, back from cited lemmas, scroll sync, download, a11y, contrast in both themes, printing, phone panes, English, delete and foreign access.');
} finally {
  await browser?.close();
  await service.close();
}
