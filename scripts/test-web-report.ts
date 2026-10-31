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
import { webExplanationEvidence, type FixtureUnit } from '../tests/helpers/webExplanationFixture';
import { audit } from './web-a11y';
import { contrastProblems } from './web-contrast';

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
  return { context, page, requests };
}
/** The text of each range of a CSS highlight. */
const highlighted = (page: Page, name: string) => page.evaluate(key => {
  const texts: string[] = [];
  CSS.highlights.get(key)?.forEach(range => { texts.push((range as Range).toString()); });
  return texts;
}, name);
/** Proof lines carrying a row class, as 1-based numbers. */
const rowsWith = (page: Page, code: string, kind: string) => page.locator(`${code} .lean-row.${kind}`)
  .evaluateAll(rows => rows.map(row => Number((row as HTMLElement).dataset.line)));
/** Every request a page made, without the data: and blob: URLs it builds itself. */
const outside = (requests: readonly string[]) => requests.filter(url => !/^(?:data|blob):/u.test(url));
let browser: Browser | undefined;
try {
  // Chromium takes its UI language from LANG; the page's own language comes from the stored locale.
  browser = await chromium.launch({ headless: true, env: { ...process.env, LANG: 'zh_CN.UTF-8' } });
  const { page, requests } = await open(browser, explainFile, { locale: 'zh' });
  await page.locator('#explain-content:not([hidden])').waitFor();
  await page.locator('#explain-prose .explain-document').waitFor();
  assert.deepEqual(outside(requests), [pathToFileURL(explainFile).href], 'the page loads nothing but itself');
  assert.equal(await page.title(), 'synthetic_addition · 证明讲解 · TheoremOS');
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

  // 原题: the reviewers' fragments are marked in the original problem; each marks its Lean in the proof.
  const problem = page.locator('.formal-problem');
  assert.equal(await problem.locator('#explain-problem-heading').innerText(), '原题');
  assert.equal(await problem.locator('.formal-original').innerText(), formalization.request.statement);
  const correspondences = explained.problem!.correspondences;
  const marks = problem.locator('.formal-original [data-action="correspondence"]');
  const aspects = async (scope: typeof marks) => (await scope.evaluateAll(items =>
    items.map(item => Number((item as HTMLElement).dataset.correspondence)))).map(index => correspondences[index]!.aspect);
  // quantifierScope overlaps the earlier assumptions fragment and instanceCoherence the conclusion, so they are not marked.
  assert.deepEqual(await aspects(marks), ['assumptions', 'domains', 'conclusions']);
  await marks.filter({ hasText: 'n + 0 = n' }).click();
  await page.locator('#explain-lean-code .lean-row.is-use').first().waitFor();
  assert.deepEqual(await rowsWith(page, '#explain-lean-code', 'is-use'), [3]);
  assert.deepEqual(await highlighted(page, 'explain-use'), ['n + 0 = n']);
  await problem.locator('.formal-problem-details > summary').click();
  assert.equal(await problem.locator('.formal-correspondence').count(), correspondences.length);
  assert.deepEqual(await problem.locator('.formal-lean.is-unplaced').allInnerTexts(), ['forall (n : Nat), n + 0 = n']);
  await problem.locator(`button.formal-lean[data-correspondence="${correspondences.findIndex(item => item.aspect === 'domains')}"]`).click();
  assert.deepEqual(await highlighted(page, 'explain-use'), ['(n : Nat)']);
  mark('原题 marks the reviewers\' fragments; each, and each placed pair in the list, marks its Lean in the proof');
  // Linked phrases: each chooses its statement or step and marks where its Lean is written.
  const section = (name: string) =>
    page.locator(`.explain-section:has(#explain-section-${explained.sections.findIndex(item => item.name === name)})`);
  const addition = section('addition'), helper = section('helper');
  const statementLink = addition.locator('.explain-statement [data-action="link"]');
  assert.equal(await statementLink.count(), 1);
  assert.equal(await statementLink.locator('.math').count(), 1, 'a phrase and a formula form one link');
  assert.equal((await statementLink.innerText()).replace(/\s+/gu, ' '), '自然数 n');
  await statementLink.click();
  assert.deepEqual(await highlighted(page, 'explain-use'), ['(n : Nat)']);
  assert.deepEqual(await rowsWith(page, '#explain-lean-code', 'is-active'), [3]);
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

  assert.deepEqual(await audit(page), [], 'accessibility problems on the explanation report');
  assert.deepEqual(await contrastProblems(page), [], 'contrast problems on the explanation report');
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
  await phone.page.locator('#explain-prose .explain-document').waitFor();
  assert.equal(await split.getAttribute('data-pane'), 'prose');
  await phone.page.locator(`.explain-section:has(#explain-section-1) .explain-steps [data-action="link"]`).click();
  assert.equal(await split.getAttribute('data-pane'), 'lean');
  await phone.page.locator('#explain-lean-code .lean-row[data-line="4"]').waitFor({ state: 'visible' });
  await phone.page.locator('#explain-toolbar [data-action="pane"][data-pane="prose"]').click();
  await phone.page.locator('.formal-original [data-action="correspondence"]').first().click();
  assert.equal(await split.getAttribute('data-pane'), 'lean');
  assert.deepEqual(await audit(phone.page), [], 'accessibility problems on the phone layout');
  await phone.page.screenshot({ path: path.join(shots, 'explain-report-390.png') });
  await phone.context.close();
  mark('on a 390 pixel phone a linked phrase or an original fragment switches to the proof');

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
  assert.deepEqual((await fmarks.evaluateAll(items => items.map(item => Number((item as HTMLElement).dataset.correspondence))))
    .map(index => formalData.correspondences[index]!.aspect), ['assumptions', 'domains', 'conclusions']);
  mark('the comparison report opens from disk, bars the target and underlines every Lean fragment a reviewer matched');

  const active = () => fpage.locator('.formal-correspondence.is-active').evaluateAll(items =>
    items.map(item => Number((item as HTMLElement).dataset.item)));
  await fmarks.filter({ hasText: 'n + 0 = n' }).click();
  assert.deepEqual(await active(), [formalData.correspondences.findIndex(item => item.aspect === 'conclusions')]);
  assert.deepEqual(await highlighted(fpage, 'explain-use'), ['n + 0 = n']);
  assert.deepEqual(await rowsWith(fpage, '#formal-lean-code', 'is-active'), [1]);
  await fpage.locator('#formal-lean-code .lean-row[data-line="1"]').click();
  assert.deepEqual(await active(), formalData.correspondences.flatMap((item, index) => item.lean.length ? [index] : []));
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
  assert.equal(await fpage.locator('#formal-prose section[aria-label^="审核 "]').count(), formalData.reviews.length);
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
  await formalPhone.page.locator('#formal-lean-code .lean-row[data-line="1"]').click();
  assert.equal(await formalSplit.getAttribute('data-pane'), 'prose');
  assert.deepEqual(await audit(formalPhone.page), [], 'accessibility problems on the phone comparison');
  await formalPhone.page.screenshot({ path: path.join(shots, 'formalization-report-390.png') });
  await formalPhone.context.close();
  const formalEnglish = await open(browser, formalFile, { locale: 'en' });
  await formalEnglish.page.locator('#formal-content:not([hidden])').waitFor();
  assert.equal(await formalEnglish.page.title(), 'synthetic_addition · Formalization comparison · TheoremOS');
  assert.equal(await formalEnglish.page.locator('#formal-back-heading').innerText(), 'Blind back-translation');
  await formalEnglish.context.close();
  mark('on a phone a fragment opens the statement and a line returns to its pairs; English chrome is English');

  assert.deepEqual(errors, [], 'no page errors or console errors');
  console.log('Report checks passed: both offline pages load nothing from outside, 原题 fragments, linked phrases, goal checks, '
    + 'Markdown download, keyboard, a11y, contrast in both themes, phone panes and English.');
} finally {
  await browser?.close();
  for (const item of roots) fs.rmSync(item, { recursive: true, force: true });
}
