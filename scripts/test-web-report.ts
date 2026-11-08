#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { explanationDocument } from '../apps/web/explanation';
import type { WebFormalizationReport } from '../apps/web/shared';
import { formalizationReport } from '../apps/web/formalizationReport';
import { writeStaticReport } from '../apps/web/staticReport';
import { localeStorageKey } from '../apps/web/i18n';
import { themeStorageKey } from '../apps/web/client/themePreference';
import { formalizationDigest, readFormalizationArtifact } from '../src/math/formalization';
import { assertInformalizationEvidence } from '../src/math/informalization';
import { formalize } from './mathematics/formalize';
import { ADDITION_PROOF, approvedFormalization } from '../tests/helpers/approvedFormalizationFixture';
import { fixtureStatement } from '../tests/helpers/formalizationFixture';
import { webExplanationEvidence, type FixtureUnit } from '../tests/helpers/webExplanationFixture';
import { audit } from './web-a11y';
import { contrastProblems } from './web-contrast';
import { printedPages, printLayout } from './web-print';

// The offline report pages (formalize/informalize --phase report) opened from disk: a preset-approved formalization and
// a preset aligned explanation bound to it, no model, Lean or server. Screenshots go to out/web-report-check.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const file of ['out/web/explain.js', 'out/web-report/formalization.js'])
  if (!fs.existsSync(path.join(root, file))) throw new Error('Run bun run build:web before the report check.');
const shots = path.join(root, 'out/web-report-check');
fs.mkdirSync(shots, { recursive: true });
const roots: string[] = [];
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-web-report-'))); roots.push(work);
const mark = (check: string) => console.log(`PASS ${check}`);
const errors: string[] = [];

// The comparison page through the CLI, as a user writes it.
const formalized = await approvedFormalization(roots);
const formalization = readFormalizationArtifact(path.join(formalized, 'artifact'));
const formalFile = path.join(work, 'formalization.html');
const printed: string[] = [], log = console.log;
console.log = (...items: unknown[]) => { printed.push(items.map(String).join(' ')); };
try { assert.equal(await formalize(['--phase', 'report', '--directory', formalized, '--output', formalFile]), 0); }
finally { console.log = log; }
const formalData: WebFormalizationReport = formalizationReport(formalization);
assert.deepEqual(JSON.parse(printed.at(-1)!), { schema: 'theorem-os.formalization-cli.v1', phase: 'report', directory: formalized,
  modelInvoked: false, requestDigest: formalization.requestDigest, output: formalFile, bytes: fs.statSync(formalFile).size,
  targets: ['addition'], correspondences: 6, locatedCorrespondences: 5 });
// The explanation page: ADDITION_PROOF proves the formalization's `addition` through a helper with the same statement.
// Links cover a whole formula, a phrase and a formula together, inline code, and a tactic's argument.
const units: FixtureUnit[] = [
  { name: 'helper', kind: 'theorem', snippet: 'theorem helper (n : Nat) : n + 0 = n := rfl',
    statement: '对每个自然数 $n$，有 $n + 0 = n$。', statementLinks: [{ text: 'n + 0', lean: 'n + 0 = n' }],
    texts: ['由加法的定义，`rfl` 直接给出这个等式。'], links: [[{ text: '`rfl`', lean: 'rfl' }]] },
  { name: 'addition', kind: 'theorem', snippet: 'theorem addition (n : Nat) : n + 0 = n := by\n  exact helper n', uses: ['helper'],
    statement: '对任意自然数 $n$，$n + 0 = n$。', statementLinks: [{ text: '自然数 $n$', lean: '(n : Nat)' }],
    steps: [['exact helper n']], texts: ['把引理 helper 用在 $n$ 上就得到结论，目标随之关闭。'],
    links: [[{ text: '引理 helper 用在 $n$ 上', lean: 'helper n' }]],
    goals: [{ snippet: 'exact helper n', before: ['n : Nat\n⊢ n + 0 = n'], after: [] }] },
];
const evidence = webExplanationEvidence({ proof: ADDITION_PROOF, target: 'addition', units, aligned: true, formalization });
const { markdown } = assertInformalizationEvidence(evidence);
const explained = explanationDocument(evidence, ADDITION_PROOF, formalization);
const explainFile = writeStaticReport(root, path.join(work, 'addition.html'), { page: 'explain', data: {
  schema: 'theorem-os.web-explanation-report.v1', title: 'synthetic_addition', environment: 'standard', proof: ADDITION_PROOF,
  document: explained, markdown, filename: 'addition.md' } });
const lines = ADDITION_PROOF.replace(/\n$/u, '').split('\n').length;

async function open(browser: Browser, file: string, options: { locale?: 'zh' | 'en'; theme?: 'light' | 'dark'; width?: number;
  height?: number } = {}) {
  const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: options.height ?? 900 }, acceptDownloads: true });
  await context.addInitScript(([localeKey, locale, themeKey, theme]) => {
    if (locale) localStorage.setItem(localeKey, locale);
    if (theme) localStorage.setItem(themeKey, theme);
  }, [localeStorageKey, options.locale ?? '', themeStorageKey, options.theme ?? ''] as const);
  const page = await context.newPage(), requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => requests.push(request.url()));
  await page.goto(pathToFileURL(file).href);
  await page.locator('.explain-content:not([hidden])').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.math')]
    .every(formula => ['ready', 'source'].includes(formula.dataset.mathState ?? '')));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return { context, page, requests };
}
/** The text of each range of a CSS highlight. */
const highlighted = (page: Page, name: string) => page.evaluate(key => {
  const texts: string[] = [];
  CSS.highlights.get(key)?.forEach(range => { texts.push((range as Range).toString()); });
  return texts;
}, name);
/** The tinted text of the original problem, one entry per stretch of marked text, spacing collapsed. */
const tinted = (page: Page) => page.locator('.formal-original').first().evaluate(original => {
  const stretches: string[] = [];
  let open = false;
  const walker = document.createTreeWalker(original, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const marked = Boolean(node.parentElement?.closest('mark.explain-chosen'));
    if (marked && open) stretches[stretches.length - 1] += node.textContent ?? '';
    else if (marked) stretches.push(node.textContent ?? '');
    if (marked || (node.textContent ?? '').length) open = marked;
  }
  return stretches.map(text => text.replace(/\s+/gu, ' ').trim());
});
/** Proof lines carrying a row class, as 1-based numbers. */
const rowsWith = (page: Page, code: string, kind: string) => page.locator(`${code} .lean-row.${kind}`)
  .evaluateAll(rows => rows.map(row => Number((row as HTMLElement).dataset.line)));
/** Whether the target name and the Lean/讲解 switch share one row of the toolbar. */
const oneRow = (page: Page, toolbar: string) => page.locator(toolbar).evaluate(bar => {
  const name = bar.querySelector('.explain-target code')!.getBoundingClientRect(), pane = bar.querySelector('.explain-pane-switch')!.getBoundingClientRect();
  return name.top < pane.bottom && pane.top < name.bottom;
});
/** How much of the screen's height the shown pane's scroll box takes, 0 to 1. */
const paneShare = (page: Page) => page.evaluate(() => {
  const pane = [...document.querySelectorAll('.explain-scroll')].find(item => item.getClientRects().length)!;
  return (innerHeight - pane.getBoundingClientRect().top) / innerHeight;
});
/** Every request a page made, without the data: and blob: URLs it builds itself. */
const outside = (requests: readonly string[]) => requests.filter(url => !/^(?:data|blob):/u.test(url));
let browser: Browser | undefined;
try {
  // Chromium takes its UI language from LANG; the page's own language comes from the stored locale.
  browser = await chromium.launch({ headless: true, env: { ...process.env, LANG: 'zh_CN.UTF-8' } });
  const { page, requests } = await open(browser, explainFile, { locale: 'zh' });
  await page.locator('#explain-content:not([hidden])').waitFor();
  await page.locator('#explain-prose .explain-document').waitFor();
  assert.ok(await page.locator('.explain-document .math[data-math-state="ready"] math').count() > 0, 'offline formulas render semantic MathML');
  assert.equal(await page.locator('.explain-document .math-source').count(), 0, 'the report has all the assets needed to render its formulas');
  assert.deepEqual(outside(requests), [pathToFileURL(explainFile).href], 'the page loads nothing but itself');
  assert.equal(await page.title(), 'synthetic_addition · 证明讲解 · TheoremOS');
  assert.equal(await page.locator('#explain-run-title').innerText(), 'synthetic_addition');
  assert.equal(await page.locator('#explain-lean-code .lean-row').count(), lines);
  assert.equal(await page.locator('#explain-back').isVisible(), false);
  assert.equal(await page.locator('.brand').getAttribute('href'), null);
  assert.equal(await page.locator('[data-action="generate"], [data-action="delete"], [aria-label="讲解语言"]').count(), 0);
  const download = page.locator('#explain-prose-head a[download]');
  assert.equal(await download.getAttribute('download'), 'addition.md');
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  assert.equal(file.suggestedFilename(), 'addition.md');
  assert.equal(fs.readFileSync((await file.path())!, 'utf8'), markdown);
  mark('the explanation report opens from disk with nothing to fetch, no workbench links, and downloads its Markdown');
  // A proof id informalize derived from the target (`addition`) says nothing the toolbar does not, so the top bar leaves it out.
  const derivedFile = writeStaticReport(root, path.join(work, 'addition-derived.html'), { page: 'explain', data: {
    schema: 'theorem-os.web-explanation-report.v1', title: 'addition', environment: 'standard', proof: ADDITION_PROOF,
    document: explained, markdown, filename: 'addition.md' } });
  const derived = await open(browser, derivedFile, { locale: 'zh' });
  await derived.page.locator('#explain-prose .explain-document').waitFor();
  assert.equal(await derived.page.locator('#explain-run-title').isHidden(), true);
  assert.equal(await derived.page.title(), 'addition · 证明讲解 · TheoremOS');
  await derived.context.close();
  // A Lean name may wrap only after a `.` or `_`.
  assert.equal(await page.locator('.formal-problem .explain-section-meta code wbr').count(), 1);
  mark('the top bar names the proof only when its id was chosen, and a Lean name wraps only after a dot or underscore');

  // 原题: the reviewers' fragments are marked in the original problem; each marks its Lean in the proof.
  const problem = page.locator('.formal-problem');
  assert.equal(await problem.locator('#explain-problem-heading').innerText(), '原题');
  assert.equal(await problem.locator('.formal-original').innerText(), formalization.request.statement);
  const correspondences = explained.problem!.correspondences;
  const marks = problem.locator('.formal-original [data-action="correspondence"]');
  const aspects = async (scope: typeof marks) => (await scope.evaluateAll(items => items.map(item => (item as HTMLElement).dataset.correspondence!)))
    .map(list => list.split(' ').map(index => correspondences[Number(index)]!.aspect).join('+'));
  // A fragment inside another underlines its own words: quantifierScope is left with no words of its own, the conclusion
  // keeps what '+' does not take but its lone 'n', too narrow to tap, and instanceCoherence ('n + 0'), whose Lean is not in
  // the proof, goes with the conclusion, so a click on its '0' marks the conclusion's Lean and lists both.
  assert.deepEqual(await aspects(marks), ['assumptions', 'domains', 'definitions', 'conclusions+instanceCoherence']);
  assert.deepEqual(await marks.allInnerTexts(), ['For every', 'natural number n', '+', '0 = n']);
  // The chosen pair's text is tinted, '+' inside it too, and the pieces standing for it are underlined solid.
  const chosen = problem.locator('.formal-original .explain-link.is-active');
  await marks.filter({ hasText: '0 = n' }).click();
  await page.locator('#explain-lean-code .lean-row.is-use').first().waitFor();
  assert.deepEqual(await rowsWith(page, '#explain-lean-code', 'is-use'), [3]);
  assert.deepEqual(await highlighted(page, 'explain-use'), ['n + 0 = n']);
  assert.deepEqual(await chosen.allInnerTexts(), ['0 = n']);
  assert.deepEqual(await tinted(page), ['n + 0 = n']);
  await marks.filter({ hasText: /^\+$/u }).click();
  assert.deepEqual(await highlighted(page, 'explain-use'), ['+']);
  assert.deepEqual(await chosen.allInnerTexts(), ['+']);
  assert.deepEqual(await tinted(page), ['+']);
  // quantifierScope has no words of its own left: a second click on a fragment inside it steps out to it, a third back.
  const every = marks.filter({ hasText: 'For every' });
  assert.equal(await every.getAttribute('title'), '假设 · 直接对应\n再点一次，选中包含它的更长片段');
  await every.click();
  assert.deepEqual(await highlighted(page, 'explain-use'), ['addition (n : Nat) :']);
  await every.click();
  assert.deepEqual(await highlighted(page, 'explain-use'), ['theorem addition (n : Nat)']);
  assert.deepEqual(await tinted(page), ['For every natural number n']);
  assert.equal(await chosen.count(), 0, 'no piece is its own fragment');
  await every.click();
  assert.deepEqual(await tinted(page), ['For every']);
  assert.equal(await page.locator('#explain-chosen').isVisible(), false, 'the fragment strip above the Lean is for phones');
  await problem.locator('.formal-problem-details > summary').click();
  assert.equal(await problem.locator('.formal-correspondence').count(), correspondences.length);
  assert.deepEqual(await problem.locator('.formal-lean.is-unplaced').allInnerTexts(), ['forall (n : Nat), n + 0 = n']);
  await problem.locator(`button.formal-lean[data-correspondence="${correspondences.findIndex(item => item.aspect === 'domains')}"]`).click();
  assert.deepEqual(await highlighted(page, 'explain-use'), ['(n : Nat)']);
  assert.deepEqual(await chosen.allInnerTexts(), ['natural number n']);
  assert.deepEqual(await tinted(page), ['natural number n']);
  assert.equal(await problem.locator('.formal-correspondence.is-active').count(), 1);
  mark('原题 marks the reviewers\' fragments; each, and each placed pair in the list, marks its Lean in the proof and is shown as chosen');
  // Linked phrases: each chooses its statement or step and marks where its Lean is written.
  const section = (name: string) =>
    page.locator(`.explain-section:has(#explain-section-${explained.sections.findIndex(item => item.name === name)})`);
  const addition = section('addition'), helper = section('helper');
  const statementLink = addition.locator('.explain-statement [data-action="link"]');
  assert.equal(await statementLink.count(), 1);
  assert.equal(await statementLink.locator('.math').count(), 1, 'a phrase and a formula form one link');
  assert.equal(await statementLink.evaluate(link => {
    const prose = link.cloneNode(true) as HTMLElement;
    for (const formula of prose.querySelectorAll('.math')) formula.replaceWith(document.createTextNode(formula.getAttribute('title') ?? ''));
    return prose.textContent?.replace(/\s+/gu, ' ');
  }), '自然数 n', 'the linked phrase retains its original text and formula');
  await statementLink.click();
  assert.deepEqual(await highlighted(page, 'explain-use'), ['(n : Nat)']);
  assert.deepEqual(await rowsWith(page, '#explain-lean-code', 'is-active'), [3]);
  assert.equal(await chosen.count(), 0, 'choosing a statement clears the chosen 原题 fragment');
  assert.deepEqual(await tinted(page), []);
  const formula = helper.locator('.explain-statement [data-action="link"]');
  assert.equal(await formula.locator('.math').getAttribute('title'), 'n + 0 = n', 'a link into a formula takes the whole formula');
  await formula.click();
  assert.deepEqual(await highlighted(page, 'explain-use'), ['n + 0 = n']);
  assert.deepEqual(await rowsWith(page, '#explain-lean-code', 'is-active'), [1]);
  const code = helper.locator('.explain-steps [data-action="link"]');
  assert.equal(await code.locator('code').innerText(), 'rfl');
  await code.click();
  assert.deepEqual(await highlighted(page, 'explain-use'), ['rfl']);
  mark('linked phrases (a phrase with its formula, a whole formula, inline code) mark exactly their Lean');

  // The keyboard reaches a link; Enter chooses it like a click. The target's step shows its goals, checked by both auditors.
  const step = addition.locator('.explain-steps [data-action="link"]');
  // Off the prose pane first, so only focus decides what is previewed.
  await page.mouse.move(4, 4);
  await step.focus();
  assert.deepEqual(await highlighted(page, 'explain-use'), ['helper n'], 'focus previews the link');
  assert.deepEqual(await rowsWith(page, '#explain-lean-code', 'is-active'), [1], 'focus alone chooses nothing');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#explain-lean-code .lean-row[data-line="4"]')?.classList.contains('is-active'));
  assert.deepEqual(await rowsWith(page, '#explain-lean-code', 'is-active'), [4]);
  assert.equal(await addition.locator('.explain-goal-checked').innerText(), '2 个审核模型对照过');
  assert.equal(await helper.locator('.explain-goals').count(), 0, 'no goals were recorded for the helper');
  assert.ok(await page.locator('.explain-overview .formal-note').isVisible());
  mark('Enter chooses a focused link; the target step\'s goals say both auditors checked them; the page explains the dotted phrases');

  // A cited lemma jumps within the file; Back returns to the citation instead of leaving the report.
  const cite = addition.locator('[data-action="use"]').filter({ hasText: 'helper' }), back = page.locator('#explain-prose-head [data-action="return"]');
  await cite.click();
  await page.locator('.explain-section.is-active').filter({ has: page.locator(`#explain-section-${explained.sections.findIndex(item => item.name === 'helper')}`) }).waitFor();
  await back.waitFor();
  // Checked with the way back shown.
  assert.deepEqual(await audit(page), [], 'accessibility problems on the explanation report');
  assert.deepEqual(await contrastProblems(page), [], 'contrast problems on the explanation report');
  await page.evaluate(() => history.back());
  await back.waitFor({ state: 'detached' });
  assert.equal(page.url(), pathToFileURL(explainFile).href, 'Back stays in the report');
  assert.deepEqual(await rowsWith(page, '#explain-lean-code', 'is-active'), [4], 'Back chooses the step it left');
  assert.ok(await cite.evaluate(node => node === document.activeElement));
  mark('in the report, Back after a cited lemma returns to the citation and stays on the page');
  await page.screenshot({ path: path.join(shots, 'explain-report-1440.png') });
  const dark = await open(browser, explainFile, { locale: 'zh', theme: 'dark' });
  await dark.page.locator('#explain-prose .explain-document').waitFor();
  await dark.page.locator('.formal-problem-details > summary').click();
  assert.deepEqual(await contrastProblems(dark.page), [], 'contrast problems on the dark explanation report');
  await dark.page.screenshot({ path: path.join(shots, 'explain-report-dark.png') });
  await dark.context.close();
  mark('the explanation report passes the accessibility check and the contrast check in both themes');
  // On a phone the panes switch: a linked phrase or an original fragment opens the proof at its Lean.
  const phone = await open(browser, explainFile, { locale: 'zh', width: 390, height: 844 });
  const split = phone.page.locator('#explain-split');
  assert.equal(await oneRow(phone.page, '#explain-toolbar'), true, 'the target and the Lean/讲解 switch share a row');
  await phone.page.locator('#explain-prose .explain-document').waitFor();
  assert.equal(await split.getAttribute('data-pane'), 'prose');
  await phone.page.locator(`.explain-section:has(#explain-section-1) .explain-steps [data-action="link"]`).click();
  assert.equal(await split.getAttribute('data-pane'), 'lean');
  await phone.page.locator('#explain-lean-code .lean-row[data-line="4"]').waitFor({ state: 'visible' });
  // A line wider than the phone wraps, hanging 4 characters inside its own indentation (line 4 has 2 spaces, line 3 none).
  assert.equal(await phone.page.locator('#explain-lean').evaluate(pane => pane.scrollWidth <= pane.clientWidth + 1), true, 'the phone Lean pane wraps');
  const hangs = await phone.page.locator('#explain-lean-code .lean-row:is([data-line="3"],[data-line="4"]) .lean-text').evaluateAll(texts =>
    texts.map(text => -parseFloat(getComputedStyle(text).textIndent)));
  assert.ok(hangs[0]! > 0 && Math.abs(hangs[1]! / hangs[0]! - 1.5) < 0.01, `hangs ${hangs.join(', ')}`);
  await phone.page.locator('#explain-toolbar [data-action="pane"][data-pane="prose"]').click();
  await phone.page.locator('.formal-original [data-action="correspondence"]').first().click();
  assert.equal(await split.getAttribute('data-pane'), 'lean');
  // Above the Lean, where the original is out of sight: the fragment, its aspects and relations, and a step out.
  const strip = phone.page.locator('#explain-chosen');
  assert.equal(await strip.innerText(), '原题\nFor every\n直接对应：假设\n选中更长的片段');
  await strip.locator('[data-action="wider"]').click();
  assert.equal(await split.getAttribute('data-pane'), 'lean');
  assert.equal(await strip.innerText(), '原题\nFor every natural number n\n直接对应：量词范围\n回到最短的片段');
  assert.deepEqual(await highlighted(phone.page, 'explain-use'), ['theorem addition (n : Nat)']);
  assert.deepEqual(await audit(phone.page), [], 'accessibility problems on the phone layout');
  assert.deepEqual(await contrastProblems(phone.page), [], 'contrast problems on the phone layout');
  await phone.page.locator('#explain-lean-code .lean-row[data-line="4"]').click();
  assert.equal(await strip.evaluate(element => element.childElementCount), 0, 'choosing a step clears the strip');
  await phone.page.screenshot({ path: path.join(shots, 'explain-report-390.png') });
  await phone.context.close();
  mark('on a 390 pixel phone a linked phrase or an original fragment switches to the proof, which names the fragment and steps out from it');
  // Held sideways, the bars above the panes leave them about two thirds of the height (60% before they were made shorter).
  for (const file of [explainFile, formalFile]) {
    const sideways = await open(browser, file, { locale: 'zh', width: 844, height: 390 });
    await sideways.page.locator('#explain-content:not([hidden]), #formal-content:not([hidden])').first().waitFor();
    const share = await paneShare(sideways.page);
    assert.ok(share >= 0.64, `the pane takes ${(share * 100).toFixed(1)}% of a sideways phone`);
    await sideways.context.close();
  }
  mark('on a phone held sideways the panes keep about two thirds of the height');

  const english = await open(browser, explainFile, { locale: 'en' });
  await english.page.locator('#explain-prose .explain-document').waitFor();
  assert.equal(await english.page.title(), 'synthetic_addition · Proof explanation · TheoremOS');
  assert.equal(await english.page.locator('#explain-problem-heading').innerText(), 'Original problem');
  assert.match(await english.page.locator('.explain-overview .formal-note').innerText(), /^Each phrase with a dotted underline/u);
  assert.match(await english.page.locator('.explain-goal-checked').innerText(), /^checked by 2 auditors$/u);
  await english.context.close();
  mark('English chrome is English on the explanation report');
  // The comparison page: the frozen statement on the left, the original and what the reviewers matched on the right.
  const formal = await open(browser, formalFile, { locale: 'zh' });
  const fpage = formal.page;
  await fpage.locator('#formal-content:not([hidden])').waitFor();
  assert.deepEqual(outside(formal.requests), [pathToFileURL(formalFile).href], 'the page loads nothing but itself');
  assert.equal(await fpage.title(), 'synthetic_addition · 形式化对照 · TheoremOS');
  assert.equal(await fpage.locator('#formal-lean-count').innerText(), '1 行');
  assert.equal(await fpage.locator('#formal-lean-code .lean-row .lean-mark.is-statement').count(), 1, 'the target is barred in the margin');
  assert.deepEqual(await rowsWith(fpage, '#formal-lean-code', 'is-quoted'), [1]);
  const placed = formalData.correspondences.filter(item => item.lean.length);
  assert.deepEqual(await highlighted(fpage, 'formal-matched'), placed.flatMap(item => item.lean.map(span =>
    formalData.statement.split('\n')[span.line - 1]!.slice(span.start, span.end))));
  const fmarks = fpage.locator('.formal-original [data-action="correspondence"]');
  assert.deepEqual((await fmarks.evaluateAll(items => items.map(item => (item as HTMLElement).dataset.correspondence!)))
    .map(list => list.split(' ').map(index => formalData.correspondences[Number(index)]!.aspect).join('+')),
  ['assumptions', 'domains', 'definitions', 'conclusions+instanceCoherence']);
  mark('the comparison report opens from disk, bars the target and underlines every Lean fragment a reviewer matched');

  const active = () => fpage.locator('.formal-correspondence.is-active').evaluateAll(items =>
    items.map(item => Number((item as HTMLElement).dataset.item)));
  const fchosen = fpage.locator('.formal-original .explain-link.is-active');
  // The conclusion's '0 = n' also carries instanceCoherence ('n + 0'), whose Lean is not in the proof: both are listed.
  await fmarks.filter({ hasText: '0 = n' }).click();
  assert.deepEqual(await active(), ['conclusions', 'instanceCoherence']
    .map(aspect => formalData.correspondences.findIndex(item => item.aspect === aspect)));
  assert.deepEqual(await highlighted(fpage, 'explain-use'), ['n + 0 = n']);
  assert.deepEqual(await rowsWith(fpage, '#formal-lean-code', 'is-active'), [1]);
  assert.deepEqual(await fchosen.allInnerTexts(), ['0 = n']);
  assert.deepEqual(await tinted(fpage), ['n + 0 = n']);
  // A second click on a fragment inside quantifierScope steps out to it; a Lean line then starts again.
  const fevery = fmarks.filter({ hasText: 'For every' });
  await fevery.click();
  await fevery.click();
  assert.deepEqual(await active(), [formalData.correspondences.findIndex(item => item.aspect === 'quantifierScope')]);
  assert.deepEqual(await highlighted(fpage, 'explain-use'), ['theorem addition (n : Nat)']);
  assert.deepEqual(await tinted(fpage), ['For every natural number n']);
  // A Lean line tints, in the original, all the text of the pairs written on it.
  await fpage.locator('#formal-lean-code .lean-row[data-line="1"]').click();
  assert.deepEqual(await active(), formalData.correspondences.flatMap((item, index) => item.lean.length ? [index] : []));
  assert.deepEqual(await fchosen.allInnerTexts(), await fmarks.allInnerTexts());
  assert.deepEqual(await tinted(fpage), ['For every natural number n', 'n + 0 = n']);
  await fevery.click();
  assert.deepEqual(await tinted(fpage), ['For every'], 'after a Lean line a fragment starts from its own pair');
  assert.deepEqual(await fpage.locator('.formal-lean.is-unplaced').allInnerTexts(), ['forall (n : Nat), n + 0 = n']);
  const scope = formalData.correspondences.findIndex(item => item.aspect === 'quantifierScope');
  await fpage.locator(`button.formal-lean[data-correspondence="${scope}"]`).click();
  assert.deepEqual(await active(), [scope]);
  assert.deepEqual(await highlighted(fpage, 'explain-use'), ['theorem addition (n : Nat)']);
  await fpage.mouse.move(4, 4);
  await fmarks.first().focus();
  await fpage.keyboard.press(' ');
  assert.deepEqual(await active(), [formalData.correspondences.findIndex(item => item.aspect === 'assumptions')]);
  mark('a fragment, a pair or Space on a focused fragment marks its Lean; a Lean line finds every pair written on it');
  for (const heading of ['盲回译', '形式化计划', '原文覆盖'])
    assert.equal(await fpage.locator('#formal-prose h3').filter({ hasText: heading }).count(), 1, `the ${heading} section`);
  // Reviews are numbered, and each heading names its section.
  assert.deepEqual(await fpage.locator('#formal-prose section[aria-labelledby^="formal-review-"] h3').allTextContents(),
    formalData.reviews.map((_review, index) => `审核 ${index + 1}`));
  assert.equal(await fpage.getByRole('region', { name: '审核 1', exact: true }).count(), 1);
  assert.ok((await fpage.locator('.explain-footer').innerText()).includes(formalizationDigest(formalization)));
  assert.deepEqual(await audit(fpage), [], 'accessibility problems on the comparison report');
  assert.deepEqual(await contrastProblems(fpage), [], 'contrast problems on the comparison report');
  await fmarks.filter({ hasText: 'natural number n' }).hover();
  assert.deepEqual(await rowsWith(fpage, '#formal-lean-code', 'is-hover'), [1]);
  assert.deepEqual(await contrastProblems(fpage), [], 'contrast problems while a fragment is pointed at');
  await fpage.screenshot({ path: path.join(shots, 'formalization-report-1440.png') });
  const formalDark = await open(browser, formalFile, { locale: 'zh', theme: 'dark' });
  await formalDark.page.locator('#formal-content:not([hidden])').waitFor();
  assert.deepEqual(await contrastProblems(formalDark.page), [], 'contrast problems on the dark comparison report');
  await formalDark.context.close();
  mark('the comparison report shows the back-translation, plan, coverage, each review and the evidence digest, and passes a11y and contrast');

  const formalPhone = await open(browser, formalFile, { locale: 'zh', width: 390, height: 844 });
  const formalSplit = formalPhone.page.locator('#formal-split');
  await formalPhone.page.locator('#formal-content:not([hidden])').waitFor();
  assert.equal(await formalSplit.getAttribute('data-pane'), 'prose');
  await formalPhone.page.locator('.formal-original [data-action="correspondence"]').first().click();
  assert.equal(await formalSplit.getAttribute('data-pane'), 'lean');
  const fstrip = formalPhone.page.locator('#formal-chosen');
  assert.equal(await fstrip.innerText(), '原题\nFor every\n直接对应：假设\n选中更长的片段');
  await fstrip.locator('[data-action="wider"]').click();
  assert.equal(await fstrip.innerText(), '原题\nFor every natural number n\n直接对应：量词范围\n回到最短的片段');
  assert.deepEqual(await highlighted(formalPhone.page, 'explain-use'), ['theorem addition (n : Nat)']);
  assert.deepEqual(await contrastProblems(formalPhone.page), [], 'contrast problems on the phone strip');
  await fstrip.locator('[data-action="wider"]').click();
  assert.equal(await fstrip.innerText(), '原题\nFor every\n直接对应：假设\n选中更长的片段', 'it wraps round');
  await formalPhone.page.locator('#formal-lean-code .lean-row[data-line="1"]').click();
  assert.equal(await formalSplit.getAttribute('data-pane'), 'prose');
  assert.equal(await fstrip.evaluate(element => element.childElementCount), 0, 'a Lean line clears the strip');
  assert.deepEqual(await audit(formalPhone.page), [], 'accessibility problems on the phone comparison');
  await formalPhone.page.screenshot({ path: path.join(shots, 'formalization-report-390.png') });
  await formalPhone.context.close();
  const formalEnglish = await open(browser, formalFile, { locale: 'en' });
  await formalEnglish.page.locator('#formal-content:not([hidden])').waitFor();
  assert.equal(await formalEnglish.page.title(), 'synthetic_addition · Formalization comparison · TheoremOS');
  assert.equal(await formalEnglish.page.locator('#formal-back-heading').innerText(), 'Blind back-translation');
  await formalEnglish.context.close();
  mark('on a phone a fragment opens the statement, named above it with a step out, and a line returns to its pairs; English chrome is English');

  // A derived page: a statement line wider than a phone, two aspects quoting the same words, a pair quoting the whole
  // problem and one quoting a long elaborated type. One click on the words finds both pairs, and the unplaced
  // instanceCoherence of 'n + 0' with them, whose Lean is not in the source; the line wraps on a phone.
  const long = structuredClone(formalization), at = fixtureStatement.indexOf('n + 0 = n');
  const elaborated = 'forall (n : Nat),\n  Eq.{1} Nat\n    (HAdd.hAdd.{0, 0, 0} Nat Nat Nat (instHAdd.{0} Nat instAddNat) n\n'
    + '      (OfNat.ofNat.{0} Nat 0 (instOfNatNat 0)))\n    n';
  long.candidate.source = 'theorem addition (a b c d e f g h i j k l m : Nat) (n : Nat) : n + 0 = n := by sorry\n';
  const reviewed = long.workflow!.reviews[0]!.review;
  assert.ok('correspondences' in reviewed);
  const template = reviewed.correspondences[0]!;
  reviewed.correspondences.push({ ...template, aspect: 'instanceCoherence', originalFragment: 'n + 0 = n.', candidateFragment: '0' },
    { ...template, aspect: 'conclusions', originalFragment: fixtureStatement, candidateFragment: 'n + 0 = n' },
    { ...template, aspect: 'quantifierScope', originalFragment: 'For every natural number n', candidateFragment: long.candidate.source.trim() },
    { ...template, aspect: 'definitions', originalFragment: 'prove', candidateFragment: elaborated },
    { ...template, aspect: 'domains', originalFragment: 'For every natural number n', candidateFragment: 'theorem addition (a b c d e f g h i j k l m : Nat) (n : Nat)' });
  const longData = formalizationReport(long);
  const pair = [longData.correspondences.findIndex(item => item.aspect === 'conclusions' && item.original === 'n + 0 = n'),
    longData.correspondences.findIndex(item => item.aspect === 'instanceCoherence' && item.leanText === '0')];
  assert.ok(at > 0 && pair.every(index => index >= 0 && longData.correspondences[index]!.lean.length === 1));
  const unplaced = longData.correspondences.findIndex(item => item.aspect === 'instanceCoherence' && item.original === 'n + 0');
  assert.ok(unplaced >= 0 && !longData.correspondences[unplaced]!.lean.length);
  const found = [...pair, unplaced];
  const longFile = writeStaticReport(root, path.join(work, 'formalization-long.html'), { page: 'formalization', data: longData });
  for (const width of [390, 1440]) {
    const opened = await open(browser, longFile, { locale: 'zh', width, height: 844 }), lpage = opened.page;
    await lpage.locator('#formal-content:not([hidden])').waitFor();
    const words = lpage.locator('.formal-original [data-action="correspondence"]').filter({ hasText: '0 = n' });
    assert.equal(await words.getAttribute('data-correspondence'), found.join(' '));
    assert.equal(await words.getAttribute('title'), '结论 · 直接对应\n类型类实例 · 直接对应\n再点一次，选中包含它的更长片段');
    await words.click();
    assert.deepEqual(await lpage.locator('.formal-correspondence.is-active').evaluateAll(items =>
      items.map(item => Number((item as HTMLElement).dataset.item)).sort((a, b) => a - b)), found.toSorted((a, b) => a - b));
    assert.deepEqual(await highlighted(lpage, 'explain-use'), ['n + 0 = n', '0']);
    if (width === 390) assert.equal(await lpage.locator('#formal-chosen').innerText(), '原题\nn + 0 = n\n直接对应：结论、类型类实例\n选中更长的片段');
    if (width === 390) assert.equal(await oneRow(lpage, '#formal-toolbar'), true, 'the target and the Lean/原题 switch share a row');
    // The marked Lean ends up between the sticky line numbers and the pane's right edge.
    await lpage.waitForFunction(() => {
      const range = [...CSS.highlights.get('explain-use') ?? []][0] as Range | undefined, pane = document.querySelector('#formal-lean')!;
      const box = range?.getBoundingClientRect(), gutter = document.querySelector('#formal-lean-code .lean-mark')!.getBoundingClientRect();
      return Boolean(box && box.width > 0 && box.left >= gutter.right && box.right <= pane.getBoundingClientRect().left + pane.clientWidth);
    });
    if (width === 390) {
      // On a phone the long line wraps instead, so there is nothing to scroll across; the wrapped part hangs inside its start.
      const wrap = await lpage.locator('#formal-lean').evaluate(pane => {
        const text = pane.querySelector('.lean-row[data-line="1"] .lean-text')!, range = document.createRange(), starts = new Map<number, number>();
        range.selectNodeContents(text);
        for (const rect of range.getClientRects()) starts.set(Math.round(rect.top), Math.min(starts.get(Math.round(rect.top)) ?? Infinity, rect.left));
        const lefts = [...starts.values()];
        return { across: pane.scrollWidth > pane.clientWidth + 1, lines: lefts.length, hang: Math.round(lefts[1]! - lefts[0]!),
          indent: Math.round(-parseFloat(getComputedStyle(text).textIndent)), first: Math.round(lefts[0]! - text.getBoundingClientRect().left) };
      });
      assert.equal(wrap.across, false, 'the phone pane wraps instead of scrolling across');
      // The first line starts where it does unwrapped, 8 pixels after the margin; the rest hang under it.
      assert.ok(wrap.lines >= 2 && wrap.first === 8 && wrap.indent > 0 && Math.abs(wrap.hang - wrap.indent) <= 1, JSON.stringify(wrap));
    } else assert.equal(await lpage.locator('#formal-lean').evaluate(pane => pane.scrollLeft), 0, 'a fragment in view does not scroll');
    assert.deepEqual(await lpage.locator('.formal-whole').allInnerTexts(), ['整段原题']);
    if (width === 1440) {
      // The pair quoting the whole problem is not underlined, but a second click on words inside it reaches it.
      await words.click();
      const whole = longData.correspondences.findIndex(item => item.aspect === 'conclusions' && item.original === fixtureStatement);
      assert.deepEqual(await lpage.locator('.formal-correspondence.is-active').evaluateAll(items =>
        items.map(item => Number((item as HTMLElement).dataset.item))), [whole]);
      assert.deepEqual(await tinted(lpage), [fixtureStatement.replace(/\.$/u, '')]);
    }
    assert.equal(await lpage.locator('.formal-lean').filter({ hasText: '整份 Lean 陈述' }).count(), 1);
    if (width === 390) await lpage.locator('[data-action="pane"][data-pane="prose"]').click();
    // Each Lean label sits by the first line of its fragment, also when the fragment wraps.
    const offsets = await lpage.locator('.formal-pair:has(button.formal-lean)').evaluateAll(pairs => pairs.map(pair => {
      const button = pair.querySelector('button.formal-lean')!, label = button.parentElement!.previousElementSibling!;
      return { lines: Math.round(button.getBoundingClientRect().height / parseFloat(getComputedStyle(button).lineHeight)),
        offset: Math.round(label.getBoundingClientRect().top - button.getBoundingClientRect().top) };
    }));
    if (width === 390) assert.ok(offsets.some(item => item.lines > 1), 'a fragment wraps on a phone');
    assert.ok(offsets.every(item => Math.abs(item.offset) <= 4), JSON.stringify(offsets));
    // A long Lean fragment the source does not write is folded to its first line and says so in words.
    const fold = lpage.locator('details.formal-unplaced'), folded = fold.locator('summary');
    assert.equal(await fold.count(), 1);
    assert.equal(await folded.innerText(), 'forall (n : Nat), …\n源码里没有原样写出\n展开');
    assert.ok((await fold.boundingBox())!.height < 64, 'the folded fragment takes at most two short lines');
    await folded.click();
    assert.equal(await fold.locator('.formal-lean.is-unplaced').innerText(), elaborated);
    assert.equal(await fold.locator('.formal-lean.is-preview').isVisible(), false);
    assert.equal(await fold.locator('.formal-unplaced-toggle').innerText(), '收起');
    assert.equal(await lpage.locator('.formal-correspondence.is-active').count(), width === 1440 ? 1 : found.length, 'opening it chooses nothing');
    assert.deepEqual(await audit(lpage), [], 'accessibility problems with the fold open');
    assert.deepEqual(await contrastProblems(lpage), [], 'contrast problems with the fold open');
    await opened.context.close();
  }
  const longDark = await open(browser, longFile, { locale: 'zh', theme: 'dark' });
  await longDark.page.locator('#formal-content:not([hidden])').waitFor();
  await longDark.page.locator('details.formal-unplaced > summary').click();
  assert.deepEqual(await contrastProblems(longDark.page), [], 'contrast problems with the fold open, dark');
  await longDark.context.close();
  mark('one click on words several pairs quote finds them all and shows their Lean, wrapped on a phone, a second the whole problem; whole-problem and whole-statement quotes are named; a long unwritten Lean fragment is folded; labels sit by first lines');

  // Printed, either report is one document in the light colours: the prose, then the whole Lean on a new page, wrapped
  // also on paper wider than a phone, and no controls.
  for (const width of [600, 1100]) for (const theme of ['light', 'dark'] as const) for (const file of [longFile, explainFile]) {
    const printed = await open(browser, file, { locale: 'zh', theme, width });
    await printed.page.locator('.explain-content:not([hidden])').waitFor();
    const layout = await printLayout(printed.page), long = file === longFile && width === 600;
    assert.deepEqual({ ...layout, lines: long ? layout.lines >= 2 : true }, { clipped: [], panes: ['prose', 'lean'], leanBreak: 'page',
      wrap: 'pre-wrap', lines: true, wide: 0, controls: [], paper: 'rgb(245, 244, 238)' }, `${path.basename(file)} printed at ${width} (${theme})`);
    assert.ok(await printedPages(printed.page) >= 2, 'the Lean prints on a page of its own');
    await printed.context.close();
  }
  mark('printed, both reports are one document in the light colours, the whole Lean on its own pages and wrapped, without controls');

  assert.deepEqual(outside(requests), [pathToFileURL(explainFile).href], 'explanation interactions keep the report self-contained');
  assert.deepEqual(outside(formal.requests), [pathToFileURL(formalFile).href], 'formalization interactions keep the report self-contained');
  assert.deepEqual(errors, [], 'no page errors or console errors');
  console.log('Report checks passed: both offline pages load nothing from outside, 原题 fragments, linked phrases, goal checks, '
    + 'Markdown download, keyboard, Back after a jump, a11y, contrast in both themes, phone panes, printing and English.');
} finally {
  await browser?.close();
  for (const item of roots) fs.rmSync(item, { recursive: true, force: true });
}
