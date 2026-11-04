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
const output = path.join(root, 'out/web-explain');
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
const input: WebRunInput = { providerId: 'sub2api', apiKey: credential, model: 'deepseek-flash', effort: 'xhigh', environment: 'standard',
  source: 'theorem target_thm (a b : Nat) : a + b + 1 = b + a + 1 := by\n  sorry\n', task: 'Explain fixture',
  maxTurns: 1, maxRunSeconds: 60, workers: 1, coordination: 'cooperative' };

type Explain = { input: WorkerExplanationInput; send(message: WorkerExplanationMessage): void; resolve(): void };
const explains: Explain[] = [];
const runner: WebRunner = {
  async readiness() { return { ready: true, message: '本地讲解验证环境' }; },
  async run(value, send) { send({ type: 'result', result: { status: value.input.task === 'Unaccepted fixture' ? 'limit_reached' : 'evaluated_passed', proof, report: {} } }); },
  explain(value, send, signal) {
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
  assert.match(await card.locator('.explain-estimate').innerText(), /^预计约 [\d.]+ 小时，约 [\d.]+ 万 Token。$/u);
  assert.equal(await page.locator('#explain-lean-legend').isVisible(), false, 'no margin legend before there is an explanation');
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
  explains[0]!.send({ type: 'progress', progress: { phase: 'auditing', batches: 1, approvedBatches: 0, round: 1, tokens: 1234 } });
  await page.locator('.explain-phases li.active').filter({ hasText: '正在审核' }).waitFor({ timeout: 15_000 });
  await page.screenshot({ path: path.join(output, 'explain-progress-1440.png') });
  mark('generation needs a Key, starts the runner with the run model and shows its phase while running');

  // Stopping asks first; a stopped explanation can be generated again.
  await page.locator('#explain-prose [data-action="cancel"]').click();
  await page.locator('#explain-dialog[open] [data-action="confirm-cancel"]').click();
  await page.locator('#explain-toast:not([hidden])').filter({ hasText: '已停止生成' }).waitFor();
  await page.locator('#explain-prose [data-action="generate"]').waitFor();
  mark('stopping asks for confirmation and offers to generate again');

  // Generate again and approve: the page polls, then shows the document beside the proof.
  await page.locator('#explain-prose [data-action="generate"]').click();
  await page.locator('#explain-dialog[open] #explain-api-key').fill(credential);
  await page.locator('#explain-dialog[open] button[type="submit"]').click();
  await until(() => explains.length === 2, 'the second explanation starts');
  explains[1]!.send({ type: 'result', status: 'approved', evidence: JSON.parse(JSON.stringify(webExplanationEvidence({ proof, target: 'target_thm', units }))) });
  explains[1]!.resolve();
  await page.locator('#explain-prose .explain-document').waitFor({ timeout: 20_000 });
  const item = `/api/runs/${run.id}/explanations/item?${new URLSearchParams({ target: 'target_thm', language: 'zh' })}`;
  const explained = await page.evaluate(async url => (await (await fetch(url)).json()).explanation.document as WebExplanationDocument, item);
  assert.deepEqual(explained.sections.map(section => section.name), [...helpers.map((_, index) => `step_${index + 1}`), 'target_thm']);
  assert.equal(await page.locator('.explain-section').count(), 7);
  assert.equal(await page.locator('.explain-section.is-target').count(), 1);
  assert.equal(await page.locator('.explain-steps > li').count(), 14);
  mark('an approved explanation appears without a reload: one section per declaration, the target marked');

  // Mathematics is drawn with elements; what does not parse stays as written.
  assert.equal(await page.locator('.explain-document .math-source').count(), 1, 'only the unclosed formula falls back');
  assert.equal(await page.locator('.explain-document .math-source').innerText(), 'x^{');
  assert.equal(await page.locator('.explain-document .math-frac').count(), 6);
  assert.ok(await page.locator('.explain-document .math-scripts').count() >= 2, 'the sums carry both limits');
  const titled = await page.locator('.explain-document .math').evaluateAll(nodes => nodes.map(node => [node.getAttribute('title'), node.textContent]));
  assert.ok(titled.some(([title, text]) => title === 'a, b \\in \\mathbb{N}' && text?.includes('ℕ') && text.includes('∈')), 'a formula keeps its source as the title');
  assert.equal(await page.locator('.explain-document strong').filter({ hasText: '前三个引理' }).count(), 1);
  mark('formulas, bold and code render as elements and an unparseable formula shows its source');

  // Clicking a step marks its Lean lines and scrolls the proof to them; clicking a Lean line does the reverse.
  const sections = explained.sections, last = sections.length - 1;
  await page.locator(`[data-action="lines"][data-section="${last}"][data-step="0"]`).click();
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
  assert.equal(await back.innerText(), '回到引用处');
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
  const footer = await page.locator('.explain-footer').innerText();
  assert.ok(footer.includes('72/73') && !footer.includes('重复出现的引用片段'), `the footer counts explained proof lines: ${footer}`);
  mark('the margin numbers each step on its lines, bars the statement and rings the line no step explains, with a legend');

  // A theorem's statement is tied to its signature, both ways.
  const signature = (index: number) => range(sections[index]!.signature.start, sections[index]!.signature.end);
  await page.locator('.explain-statement-block[data-anchor="1"] [data-statement]').click();
  await until(async () => JSON.stringify(await marked(page, 'active')) === JSON.stringify(signature(1)), 'the statement marks the signature');
  await page.locator('.explain-statement-block.is-active[data-anchor="1"]').waitFor();
  await page.locator(`.lean-row[data-line="${sections[last]!.signature.start}"]`).click();
  await page.locator(`.explain-statement-block.is-active[data-anchor="${last}"]`).waitFor();
  await until(async () => JSON.stringify(await marked(page, 'active')) === JSON.stringify(signature(last)), 'the signature line selects the statement');
  await until(() => shown(page, `.explain-statement-block[data-anchor="${last}"]`), 'the prose shows the statement');
  assert.equal(await page.locator('.explain-statement-block.is-active').count(), 1);
  mark('a statement and its signature lines select each other');

  // A line no step quotes opens its declaration with a note that says so; opening auditor notes keeps the selection.
  await page.locator(`.lean-row[data-line="${gap[0]}"]`).click();
  await page.locator('.explain-section.is-active.is-target .explain-gap-note').filter({ hasText: `第 ${gap[0]} 行没有单独的讲解步骤` }).waitFor();
  assert.deepEqual(await marked(page, 'active'), gap);
  assert.equal(await page.locator('.explain-steps > li.is-active, .explain-statement-block.is-active').count(), 0);
  const notes = page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="1"] .explain-reviews:not(.explain-goals)`);
  await notes.locator('summary').click();
  assert.equal(await notes.evaluate(node => (node as HTMLDetailsElement).open), true);
  assert.equal(await notes.locator('li').innerText(), 'Step 2 is what the quoted Lean does.');
  assert.deepEqual(await marked(page, 'active'), gap, 'opening the notes keeps the selection');
  assert.equal(await page.locator('.explain-reviews:not(.explain-goals)').count(), 21, 'one note for each statement and step the first auditor explained');
  mark('a line no step quotes opens its declaration with a note, and auditor notes open without changing the selection');

  // Each target step shows, folded, Lean's goal before its first quoted tactic and after its last; the lemmas have no recorded goals.
  assert.deepEqual(sections.map(section => section.steps.filter(step => step.goals).length), [0, 0, 0, 0, 0, 0, 2]);
  const goals = page.locator('.explain-goals');
  assert.equal(await goals.count(), 2);
  assert.deepEqual(await goals.evaluateAll(nodes => nodes.map(node => (node as HTMLDetailsElement).open)), [false, false]);
  const panel = page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="1"] .explain-goals`);
  assert.equal(await panel.locator('summary').evaluate(node => node.textContent), `Lean 目标 · 第 ${gap[0]! + 1}–${gap[0]! + 3} 行`);
  await panel.locator('summary').click();
  assert.deepEqual(await panel.locator('pre.explain-goal').allTextContents(), [goalAfter(4)]);
  assert.deepEqual(await panel.locator('.explain-goal-label, .explain-goal-none').allTextContents(), ['之前', '之后', '没有剩余目标']);
  assert.equal(await panel.locator('pre.explain-goal').getAttribute('translate'), 'no');
  assert.deepEqual(await marked(page, 'active'), gap, 'opening the goals keeps the selection');
  const first = page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="0"] .explain-goals`);
  await first.locator('summary').click();
  assert.deepEqual(await first.locator('pre.explain-goal').allTextContents(), [goalAfter(0), goalAfter(3)]);
  await first.locator('summary').click();
  await panel.screenshot({ path: path.join(output, 'explain-goals-1440.png') });
  mark('a target step shows the Lean goals around its quoted tactics, folded, without changing the selection');

  // Choices within one section each redraw it: the whole declaration drops the gap note, then its statement, then each step.
  const own = (selector: string) => page.locator(`.explain-section:has(#explain-section-${last}) ${selector}`);
  await own('.explain-section-meta [data-action="lines"]').click();
  await own('.explain-gap-note').waitFor({ state: 'detached' });
  await page.locator('.explain-section.is-active').filter({ has: page.locator(`#explain-section-${last}`) }).waitFor();
  assert.deepEqual(await marked(page, 'active'), range(sections[last]!.lines.start, sections[last]!.lines.end));
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
  await chip.hover();
  await until(async () => JSON.stringify(await marked(page, 'use')) === JSON.stringify(written.spans.map(span => span.line)), 'pointing at the name marks its lines');
  await chip.click();
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

  const storageState = await owner.context.storageState(), url = page.url();
  const dark = await open(browser, url, { theme: 'dark', storageState });
  await dark.page.locator('#explain-prose .explain-document').waitFor();
  await dark.page.locator(`[data-action="lines"][data-section="${last}"][data-step="1"]`).click();
  await dark.page.locator('.explain-steps > li[data-anchor="0"][data-step="0"] [data-action="use-lean"]').click();
  await dark.page.waitForTimeout(800);
  await dark.page.screenshot({ path: path.join(output, 'explain-use-dark-1440.png') });
  await dark.page.locator(`.lean-row[data-line="${gap[0]}"]`).click();
  await dark.page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="1"] .explain-reviews:not(.explain-goals) summary`).click();
  await dark.page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="1"] .explain-goals summary`).click();
  await dark.page.waitForTimeout(800);
  assert.deepEqual(await contrastProblems(dark.page, '#explain-content'), [], 'explanation contrast below WCAG AA (dark)');
  await dark.page.screenshot({ path: path.join(output, 'explain-document-dark-1440.png') });
  // Printed, the served page drops its own controls too (back, language, sync, download, delete) and prints in light colours.
  assert.deepEqual(await printLayout(dark.page), { clipped: [], panes: ['prose', 'lean'], leanBreak: 'page', wrap: 'pre-wrap', lines: 1, wide: 0,
    controls: [], paper: 'rgb(245, 244, 238)' }, 'the explanation printed (dark)');
  assert.ok(await printedPages(dark.page) >= 2, 'the Lean prints on a page of its own');
  await dark.context.close();
  mark('the dark theme passes the contrast check and prints as one light document without controls');

  // Phones show one pane at a time; a step's line chip switches to the proof.
  const phone = await open(browser, url, { width: 390, height: 844, storageState });
  await phone.page.locator('#explain-prose .explain-document').waitFor();
  assert.equal(await phone.page.locator('#explain-split').getAttribute('data-pane'), 'prose');
  assert.equal(await phone.page.locator('#explain-lean').isVisible(), false, 'the proof pane waits behind the switch');
  assert.equal(await phone.page.locator('#explain-sync').isVisible(), false, 'sync has no meaning with one pane');
  await phone.page.screenshot({ path: path.join(output, 'explain-prose-390.png') });
  // A long inline formula wraps only after its relations and operators: it stays inside the phone's width, and in a step
  // too narrow for anything it takes every break it has, one line per piece, without splitting a piece. Chromium also breaks
  // at the margins of operators, so the <wbr>s, which every browser honors, are counted rather than seen.
  const formulas = await phone.page.locator('#explain-prose').evaluate(pane => {
    const lines = (element: Element) => new Set([...element.getClientRects()].map(rect => Math.round(rect.top))).size;
    const right = pane.getBoundingClientRect().left + pane.clientWidth - parseFloat(getComputedStyle(pane).paddingRight);
    const all = [...pane.querySelectorAll('.math')], long = all.find(item => item.getAttribute('title')?.includes('succ'))!, step = long.closest('li')!;
    const over = all.filter(item => Math.max(...[...item.getClientRects()].map(rect => rect.right)) > right + 1).length;
    step.style.width = '1px';
    const pieces = [...long.querySelectorAll('.math-piece')], narrow = { lines: lines(long), pieces: pieces.length, split: pieces.filter(piece => lines(piece) > 1).length };
    step.style.width = '';
    return { over, ...narrow, breaks: long.querySelectorAll(':scope > wbr').length, wraps: getComputedStyle(long).whiteSpace, text: long.textContent!.replace(/\s/gu, '') === 'a+b+1=succ(a+b)=succ(b+a)=b+a+1' };
  });
  assert.deepEqual(formulas, { over: 0, lines: 8, pieces: 8, split: 0, breaks: 7, wraps: 'normal', text: true });
  const phoneGoals = phone.page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="0"] .explain-goals`);
  await phoneGoals.locator('summary').click();
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'open goals do not widen the phone page');
  await phoneGoals.screenshot({ path: path.join(output, 'explain-goals-390.png') });
  await phone.page.locator(`[data-action="lines"][data-section="${last}"][data-step="0"]`).click();
  await phone.page.locator('#explain-split[data-pane="lean"]').waitFor();
  await until(() => shown(phone.page, `.lean-row[data-line="${quoted[0]}"]`), 'the phone proof pane shows the step');
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'nothing widens the phone page');
  // Long lines wrap rather than run off the pane, and each row's indentation reaches the style under the page's policy.
  assert.equal(await phone.page.locator('#explain-lean').evaluate(pane => pane.scrollWidth <= pane.clientWidth + 1), true, 'the phone Lean pane wraps');
  const hangs = await phone.page.locator('#explain-lean-code .lean-row:is([data-line="1"],[data-line="2"]) .lean-text').evaluateAll(texts =>
    texts.map(text => -parseFloat(getComputedStyle(text).textIndent)));
  assert.ok(hangs[0]! > 0 && Math.abs(hangs[1]! / hangs[0]! - 1.5) < 0.01, `hangs ${hangs.join(', ')}`);
  await phone.page.screenshot({ path: path.join(output, 'explain-lean-390.png') });
  // A cited name opens the proof at the line that writes it.
  await phone.page.locator('[data-action="pane"][data-pane="prose"]').click();
  await phone.page.locator('.explain-steps > li[data-anchor="0"][data-step="0"] [data-action="use-lean"]').click();
  await phone.page.locator('#explain-split[data-pane="lean"]').waitFor();
  await until(() => shown(phone.page, `.lean-row[data-line="${written.spans[0]!.line}"]`), 'the phone proof pane shows the name');
  assert.deepEqual(await audit(phone.page), [], 'accessibility problems on the phone layout');
  await phone.page.locator('[data-action="pane"][data-pane="prose"]').click();
  await phone.page.locator('#explain-split[data-pane="prose"]').waitFor();
  // Back after a cited lemma (the phone's back gesture) returns to the citation, even from the proof pane.
  const phoneCite = phone.page.locator(`.explain-steps > li[data-anchor="${last}"][data-step="0"] [data-action="use"]`).filter({ hasText: 'step_3' });
  const phoneProse = () => phone.page.locator('#explain-prose').evaluate(pane => Math.round(pane.scrollTop));
  await phoneCite.scrollIntoViewIfNeeded();
  const phoneBefore = await phoneProse();
  await phoneCite.click();
  await phone.page.locator('#explain-prose-head [data-action="return"]').waitFor();
  await phone.page.locator('[data-action="pane"][data-pane="lean"]').click();
  await phone.page.evaluate(() => history.back());
  await phone.page.locator('#explain-split[data-pane="prose"]').waitFor();
  await until(async () => await phoneProse() === phoneBefore, 'the phone explanation is back at the citation');
  await phone.context.close();
  mark('on a 390 pixel phone the panes switch, long Lean lines and formulas wrap, a line chip or a cited name opens the proof there, and Back after a cited lemma returns to the citation from either pane');

  // In English the page chrome is English; the explanation keeps its own language and English has its own empty card.
  const english = await open(browser, url, { locale: 'en', storageState });
  await english.page.locator('#explain-prose .explain-document').waitFor();
  assert.equal(await english.page.locator('#explain-prose-heading').innerText(), 'Natural-language proof');
  assert.equal(await english.page.locator('#explain-lean-heading').innerText(), 'Lean proof');
  const chrome = await english.page.evaluate(() => {
    const han = /\p{Script=Han}/u, found: string[] = [];
    for (const scope of document.querySelectorAll('.explain-topbar, #explain-toolbar, .explain-pane-head, #explain-lean-legend, .explain-notice, .explain-footer, .explain-section-meta'))
      for (const element of scope.querySelectorAll('*')) {
        if (element.closest('[lang="zh-CN"]') || element.children.length) continue;
        const text = element.textContent?.trim() ?? '';
        if (han.test(text)) found.push(text.slice(0, 60));
      }
    return found;
  });
  assert.deepEqual(chrome, [], 'English chrome has no Chinese text');
  assert.doesNotMatch(await english.page.locator('#explain-lean-legend').innerText(), /\p{Script=Han}/u, 'the margin legend is English');
  const englishGoals = english.page.locator('.explain-goals').first();
  assert.match(await englishGoals.locator('summary').evaluate(node => node.textContent ?? ''), /^Lean goals · Lines \d+–\d+$/u);
  await englishGoals.locator('summary').click();
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
