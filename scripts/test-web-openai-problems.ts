#!/usr/bin/env bun
// Real static archive + local HTTP service, checked against the independent accepted-proof manifest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import type { ArchiveIndex, ArchiveIndexRecord, ArchiveProcess } from '../docs/web/types';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { audit } from './web-a11y';
import { freePort } from './web-scenario';
import { clickWorkbenchAction } from './web-ui-controls';

type AcceptedRecord = Pick<ArchiveIndexRecord, 'id' | 'title' | 'subtitle' | 'area' | 'summary' | 'en' | 'status' | 'updatedAt'> & {
  directory: string; files: Record<string, string>; campaign: NonNullable<ArchiveIndexRecord['campaign']>;
};
type Acceptance = { target: string; runId: string; proofSha256: string; proofCommit: string; status: string; kernelStatus: string; comparatorExitCode: number };
type TitleBounds = { top: number; bottom: number; viewportHeight: number; fullyVisible: boolean };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-openai-problems'), staticRoot = path.join(root, 'out/web');
await fs.mkdir(output, { recursive: true });
const manifestPath = path.join(root, 'research/openai-math/manifest.json');
const manifestText = await fs.readFile(manifestPath, 'utf8');
const manifest = JSON.parse(manifestText) as { schema: string; records: AcceptedRecord[] };
assert.equal(manifest.schema, 'theoremos.campaign-archive.v1');
const expected = manifest.records.filter(record => record.status === 'locally_verified')
  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
const expectedIds = expected.map(record => record.id);
assert(expectedIds.length > 0); assert.equal(new Set(expectedIds).size, expectedIds.length);
const newest = expected.find(record => record.campaign.target === 'ThreeStateTreeClauses');
const historical = expected.find(record => record.campaign.target === 'CharacterVarietiesAllSeamsSupport');
const explained = expected.find(record => record.campaign.target === 'TriangleFace');
assert(newest, 'The latest accepted ThreeStateTreeClauses proof is included in the manifest.');
assert(historical, 'The independently accepted historical CharacterVarietiesAllSeamsSupport proof is included.');
assert(explained, 'An accepted proof with an existing mathematical walkthrough is available.');
assert.equal(expectedIds[0], newest.id, 'The latest newly accepted problem sorts first.');
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const evidenceFiles = ['Challenge.lean', 'Submission.lean', 'verification.json', 'process.json'] as const;
for (const record of expected) {
  for (const file of evidenceFiles) {
    const bytes = await fs.readFile(path.join(root, 'research/openai-math', record.directory, file));
    assert.equal(digest(bytes), record.files[file], `independent manifest binding: ${record.id}/${file}`);
  }
  const acceptance: Acceptance = JSON.parse(await fs.readFile(path.join(root, 'research/openai-math', record.directory, 'verification.json'), 'utf8'));
  assert.equal(acceptance.status, 'evaluated_passed'); assert.equal(acceptance.kernelStatus, 'kernel_verified'); assert.equal(acceptance.comparatorExitCode, 0);
  assert.equal(acceptance.runId, record.campaign.runId); assert.equal(acceptance.proofSha256, record.files['Submission.lean']);
  const process: ArchiveProcess = JSON.parse(await fs.readFile(path.join(root, 'research/openai-math', record.directory, 'process.json'), 'utf8'));
  assert(process.runs.some(run => run.runId === record.campaign.runId && run.resultStatus === 'evaluated_passed'), `manifest process has accepted run: ${record.id}`);
}

const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-openai-directory-browser-'));
const forbiddenCalls: string[] = [], errors: string[] = [], external: string[] = [], writes: string[] = [], aggregateRequests: string[] = [];
const forbidden = (name: string): never => { forbiddenCalls.push(name); throw new Error(`Read-only OpenAI browsing must not call runner.${name}`); };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Read-only OpenAI problem archive regression' }; },
  async run() { return forbidden('run'); }, async check() { return forbidden('check'); }, async command() { return forbidden('command'); },
  async explain() { return forbidden('explain'); }, async formalize() { return forbidden('formalize'); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_PROVIDERS: '[{"id":"fixture","name":"Local fixture","baseUrl":"https://fixture.invalid/v1"}]' }), runner, { sample: null });
service.server.requestTimeout = 0; service.server.headersTimeout = 0;
await new Promise<void>((resolve, reject) => { service.server.once('error', reject); service.server.listen(port, '127.0.0.1', resolve); });
const browser = await chromium.launch({ headless: true, timeout: 0 });
const requests: { scenario: string; method: string; pathname: string; search: string }[] = [];
const downloads: { id: string; files: { name: string; sha256: string; bytes: number }[]; runId: string; acceptedRun: boolean }[] = [];
const checks: { scenario: string; displayedIds: string[]; firstTitle?: TitleBounds; indexBytes?: number; screenshots: string[]; assertions: string[] }[] = [];
let active: Page | undefined, phase = 'setup', scenarioName = '', failure: unknown;
const visible = (locator: Locator) => locator.waitFor({ state: 'visible', timeout: 0 });
const directory = (page: Page) => page.locator('[data-openai-problems-directory]');
const cards = (page: Page) => directory(page).locator('[data-openai-problem]');
const card = (page: Page, id: string) => directory(page).locator(`[data-openai-problem="${id}"]`);
async function settled(page: Page) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
}
async function healthy(page: Page) {
  await settled(page); assert.deepEqual(await audit(page), [], `${phase}: strict accessibility`);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${phase}: no horizontal page overflow`);
  assert.equal(await page.locator('.research-error:visible').count(), 0);
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []); assert.deepEqual(aggregateRequests, []); assert.deepEqual(forbiddenCalls, []);
}
async function waitIds(page: Page, ids: string[]) {
  await page.waitForFunction(ids => JSON.stringify([...document.querySelectorAll('[data-openai-problem]')].map(element => element.getAttribute('data-openai-problem'))) === JSON.stringify(ids), ids, { timeout: 0 });
  await settled(page);
}
async function fieldFacets(page: Page, matches: AcceptedRecord[], en: boolean, selectedArea = '') {
  const group = directory(page).locator('.research-openai-areas');
  const picker = directory(page).locator('[data-problem-field-select]');
  const mobile = page.viewportSize()!.width <= 740;
  assert.equal(await picker.isVisible(), mobile, 'the full native field picker is visible on mobile');
  assert.equal(await group.isVisible(), !mobile, 'the complete field button list remains visible on desktop');
  if (mobile) assert.equal(await page.getByRole('combobox', { name: en ? 'Fields of mathematics' : '数学领域', exact: true }).count(), 1);
  const areas = [...new Map(expected.map(record => [record.area, record])).values()];
  assert.equal(await group.locator('button').count(), areas.length + 1, 'field choices retain every independent manifest area');
  const all = group.getByRole('button', { name: en ? 'All fields' : '全部领域', exact: true, includeHidden: true });
  assert.equal(await all.locator('small').innerText(), String(matches.length), 'all-fields count uses the text-query match set');
  assert.equal(await all.isDisabled(), false, 'all fields remains available even for a no-match query');
  assert.equal(await all.getAttribute('aria-pressed'), String(!selectedArea));
  assert.equal(await picker.inputValue(), selectedArea, 'the native picker preserves the current field, including zero-match selection');
  const label = (record: AcceptedRecord) => en ? record.en?.area ?? record.area : record.area;
  const counts = areas.map(area => ({ value: area.area, label: label(area),
    count: matches.filter(record => `${record.area} ${record.en?.area ?? ''}`.toLocaleLowerCase().includes(area.area.toLocaleLowerCase())).length }))
    .sort((a, b) => a.value.localeCompare(b.value, 'en'));
  const options = await picker.locator('option').evaluateAll(options => (options as HTMLOptionElement[]).map(option => ({ value: option.value, text: option.textContent, disabled: option.disabled })));
  assert.deepEqual([options[0], ...options.slice(1).sort((a, b) => a.value.localeCompare(b.value, 'en'))],
    [{ value: '', text: `${en ? 'All fields' : '全部领域'} · ${matches.length}`, disabled: false },
      ...counts.map(area => ({ value: area.value, text: `${area.label} · ${area.count}`, disabled: area.count === 0 && selectedArea !== area.value }))],
    'every native option and disabled state follows the independent manifest and current query');
  for (const area of areas) {
    const count = matches.filter(record => `${record.area} ${record.en?.area ?? ''}`.toLocaleLowerCase().includes(area.area.toLocaleLowerCase())).length;
    const button = group.getByRole('button', { name: label(area), exact: true, includeHidden: true });
    assert.equal(await button.locator('small').innerText(), String(count), `${area.area}: independent query-matched field count`);
    assert.equal(await button.isDisabled(), count === 0 && selectedArea !== area.area, `${area.area}: only unselected zero-match fields are disabled`);
    assert.equal(await button.getAttribute('aria-pressed'), String(selectedArea === area.area));
  }
}
async function chooseField(page: Page, value: string, en: boolean) {
  const picker = directory(page).locator('[data-problem-field-select]');
  if (await picker.isVisible()) await picker.selectOption(value, { timeout: 0 });
  else {
    const area = expected.find(record => record.area === value);
    const label = value ? en ? area?.en?.area ?? value : value : en ? 'All fields' : '全部领域';
    await directory(page).locator('.research-openai-areas').getByRole('button', { name: label, exact: true }).click({ timeout: 0 });
  }
}
async function screenshot(page: Page, check: typeof checks[number], name: string, target?: Locator) {
  await healthy(page);
  if (target) await target.scrollIntoViewIfNeeded({ timeout: 0 }); else await page.evaluate(() => scrollTo(0, 0));
  await settled(page); const filename = `${check.scenario}-${name}.png`;
  await page.screenshot({ path: path.join(output, filename), animations: 'disabled', timeout: 0 }); check.screenshots.push(filename);
}
async function firstReadingStep(page: Page, check: typeof checks[number]) {
  await healthy(page); await page.evaluate(() => scrollTo(0, 0)); await settled(page);
  const first = page.locator('[data-proof-derivation]').first();
  assert.equal(await page.locator('.proof-reading-intro').count(), 0, 'mathematical context is not hidden in a closed disclosure');
  const introduction = page.locator('.proof-walkthrough-intro');
  assert(await introduction.locator('.proof-walkthrough-strategy').isVisible(), 'the proof strategy is visible without a disclosure');
  assert(await introduction.locator('.proof-walkthrough-goal').isVisible(), 'the complete problem is visible without a disclosure');
  assert(await introduction.locator('.proof-walkthrough-notation').isVisible(), 'notation is visible before the mathematical steps');
  assert.equal(await introduction.locator('details.proof-walkthrough-problem').count(), 0, 'problem and notation need no second disclosure');
  await first.locator('.proof-walkthrough-given').evaluate(element => element.scrollIntoView({ block: 'center' })); await settled(page);
  assert(await first.locator('.proof-walkthrough-given').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 0 && bounds.top + Math.min(bounds.height, 40) <= innerHeight;
  }), `${check.scenario}: actual first-step premises are readable after the visible mathematical context`);
  assert(await first.locator('.proof-walkthrough-claim').evaluate(element => {
    const bounds = element.getBoundingClientRect(); return bounds.top >= 0 && bounds.top + 32 <= innerHeight;
  }), `${check.scenario}: the first mathematical claim is readable after the visible mathematical context`);
  const evidence = first.locator('.proof-walkthrough-source');
  assert.equal(await evidence.getAttribute('open'), null, 'technical proof evidence starts collapsed');
  assert.equal(await evidence.locator('.proof-walkthrough-source-open').isVisible(), false, 'technical links stay within the collapsed evidence');
  await evidence.locator(':scope > summary').click({ timeout: 0 });
  assert(await evidence.locator('.proof-walkthrough-source-open').isVisible(), 'proof evidence reveals the original checked-source action');
  await evidence.locator(':scope > summary').click({ timeout: 0 });
  check.assertions.push('Accepted mathematical reading shows its strategy, problem and notation directly, followed by readable premises and claims; checked source and research evidence remain available in one disclosure.');
}
async function checkReadingLocation(page: Page, check: typeof checks[number], anchor: string) {
  const section = page.locator(`#${anchor}`);
  await page.waitForFunction(anchor => new URLSearchParams(location.hash.slice(1)).get('reading') === anchor, anchor, { timeout: 0 });
  const proofSha = await page.locator('[data-proof-solution]').getAttribute('data-proof-solution-sha');
  const original = new URLSearchParams(new URL(page.url()).hash.slice(1));
  assert.equal(original.get('readingSha'), proofSha);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { (window as unknown as { copiedReading: string }).copiedReading = text; },
  } }));
  await section.locator(`[data-proof-copy-reading="${anchor}"]`).click({ timeout: 0 });
  const copied = await page.evaluate(() => (window as unknown as { copiedReading: string }).copiedReading);
  const copiedParameters = new URLSearchParams(new URL(copied).hash.slice(1));
  assert.equal(copiedParameters.get('reading'), anchor); assert.equal(copiedParameters.get('readingSha'), proofSha);
  assert.equal(copiedParameters.get('return'), original.get('return'), 'copy preserves the original filtered directory');
  const restored = async () => {
    await visible(section);
    await page.waitForFunction(anchor => {
      const section = document.getElementById(anchor), heading = section?.querySelector('h5, summary');
      if (!section || !heading || document.activeElement !== heading) return false;
      const bounds = heading.getBoundingClientRect(); return bounds.top >= 0 && bounds.top < innerHeight;
    }, anchor, { timeout: 0 });
    const parameters = new URLSearchParams(new URL(page.url()).hash.slice(1));
    assert.equal(parameters.get('reading'), anchor); assert.equal(parameters.get('readingSha'), proofSha);
    assert.equal(parameters.get('return'), original.get('return'));
  };
  await page.goto(copied, { waitUntil: 'domcontentloaded', timeout: 0 }); await restored();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 0 }); await restored();
  await page.locator('a.lang-link').click({ timeout: 0 }); await restored();
  await page.locator('a.lang-link').click({ timeout: 0 }); await restored();
  await page.locator('#tab-overview').click({ timeout: 0 }); await visible(page.locator('#detail-panel'));
  await page.locator('#tab-reading').click({ timeout: 0 }); await restored();
  if (anchor.startsWith('proof-source-helper-')) {
    assert.equal(await section.getAttribute('open'), '', 'shared helper location opens its declaration');
    assert.equal(await section.locator('xpath=..').getAttribute('open'), '', 'shared helper location opens its definitions group');
  }
  await screenshot(page, check, anchor.startsWith('proof-source-') ? 'reading-position-source' : 'reading-position-step', section.locator('h5, summary').first());
  check.assertions.push('An exact accepted step or supporting declaration is written to the URL with its proof digest. Its copied link, reload, both language changes and tab return restore the same focused reading location and retain the original directory.');
}
async function researchDraftFlow(page: Page, check: typeof checks[number], record: AcceptedRecord, en: boolean) {
  const readingUrl = page.url(), composer = page.locator('#formalize-original');
  const readingParameters = new URLSearchParams(new URL(readingUrl).hash.slice(1)), position = readingParameters.get('reading');
  const start = () => position ? page.locator(`[data-proof-position-research="${position}"]`) : page.locator('[data-proof-start-research]');
  const previous = en ? '  Keep this unsent research question.\n\nPreserve its spaces.  ' : '  保留这道尚未发送的研究题目。\n\n保留原有空格。  ';
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 0 }); await visible(composer);
  await composer.fill(previous, { timeout: 0 });
  await page.goto(readingUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
  await visible(page.locator(`[data-proof-solution="${record.id}"]`));
  if (position) assert((await start().innerText()).includes(en
    ? position.startsWith('proof-derivation-') ? 'Research this step' : 'Research this declaration'
    : position.startsWith('proof-derivation-') ? '围绕这一步研究' : '围绕此处研究'), 'the archive action describes research, rather than promising an immediate explanation');
  await start().click({ timeout: 0 });
  const candidate = page.locator('[data-problem-draft-candidate]'); await visible(candidate); await visible(composer);
  assert.equal(await composer.inputValue(), previous, 'opening a problem candidate preserves the exact unsent home draft');
  const originalSource = await fs.readFile(path.join(root, 'research/openai-math', record.directory, 'Challenge.lean'), 'utf8');
  assert.equal(await candidate.locator('h3').textContent(), en ? record.en?.subtitle ?? record.title : record.subtitle ?? record.title);
  assert((await candidate.locator('[data-problem-draft-source]').textContent())!.includes(originalSource), 'the candidate retains the complete original statement source');
  assert.equal(new URL(page.url()).searchParams.get('archiveProblem'), record.id, 'identity remains pending until the user chooses');
  const sourceHref = await candidate.getByRole('link', { name: en ? 'View the problem source' : '查看题目来源', exact: true }).getAttribute('href'); assert(sourceHref);
  const sourceParameters = new URLSearchParams(new URL(sourceHref).hash.slice(1));
  assert.equal(sourceParameters.get('proof'), record.id); assert.equal(sourceParameters.get('reading'), position);
  assert.equal(sourceParameters.get('return'), readingParameters.get('return'), 'research source retains the original directory return');
  if (position) {
    assert.equal(await candidate.locator('h2').innerText(), en ? 'Research the selected step' : '围绕所选步骤研究');
    assert.equal(new URL(page.url()).searchParams.get('archiveFocus'), position, 'the follow-up identifies the selected step without URL-supplied text');
    await visible(candidate.locator('[data-problem-draft-focus]'));
    const contextResponse = await page.request.get(`${origin}/classics/data/reading/${record.id}.json`, { timeout: 0 });
    assert.equal(contextResponse.status(), 200);
    const contexts = await contextResponse.json();
    const selected = contexts.positions[position]; assert(selected);
    const quote = await candidate.locator('[data-problem-draft-focus]').innerText();
    assert(quote.includes(selected.title[en ? 'en' : 'zh'])); assert(quote.includes(selected.claim[en ? 'en' : 'zh']));
    if (selected.definition) assert(quote.includes(selected.definition), 'a selected definition includes its body, beyond its declaration name');
    for (const use of selected.uses) assert(quote.includes(use), 'the step quote carries its used conclusions');
    assert.equal(sourceParameters.get('readingSha'), record.campaign.proofSha256);
    const popupEvent = page.waitForEvent('popup', { timeout: 0 });
    await candidate.getByRole('link', { name: en ? 'View the problem source' : '查看题目来源', exact: true }).click({ timeout: 0 });
    const popup = await popupEvent; popup.setDefaultTimeout(0); popup.setDefaultNavigationTimeout(0);
    await visible(popup.locator(`#${position}`));
    await popup.waitForFunction(anchor => document.activeElement === document.getElementById(anchor)?.querySelector('h5, summary'), position, { timeout: 0 });
    assert.equal(new URLSearchParams(new URL(popup.url()).hash.slice(1)).get('return'), readingParameters.get('return'));
    await healthy(popup); await popup.close();
  }
  await screenshot(page, check, 'research-draft-choice', candidate);
  await candidate.locator('[data-problem-draft-dismiss]').click({ timeout: 0 });
  await candidate.waitFor({ state: 'hidden', timeout: 0 });
  assert.equal(await composer.inputValue(), previous, 'dismissing the candidate preserves the original input');
  assert.equal(new URL(page.url()).searchParams.has('archiveProblem'), false, 'dismiss clears the pending handoff');
  await page.goto(readingUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
  await visible(page.locator(`[data-proof-solution="${record.id}"]`)); await start().click({ timeout: 0 });
  await visible(candidate); assert.equal(await composer.inputValue(), previous);
  await candidate.locator('[data-problem-draft-include]').click({ timeout: 0 });
  await candidate.waitFor({ state: 'hidden', timeout: 0 });
  const added = await composer.inputValue();
  assert(!added.includes(previous), 'the default independent draft contains this problem without the unrelated home question');
  const independentId = new URL(page.url()).searchParams.get('editProblem'); assert.match(independentId ?? '', /^research-[a-f0-9]{64}$/u);
  assert((await page.locator('[data-chat-editing-problem]').innerText()).includes(en ? 'Independent research draft' : '独立研究草稿'));
  assert(added.includes(originalSource), 'this small original statement is included in full after confirmation');
  assert(added.includes(record.files['Challenge.lean']), 'the new editable question retains its original source digest');
  assert(added.includes(sourceHref), 'the included draft retains the precise reading-source URL');
  assert(added.includes(`/classics/data/proofs/${record.id}/Challenge.lean`), 'the draft links to the original statement, separately from accepted proof reading');
  for (const target of record.campaign.targets) assert(added.includes(target), 'every accepted problem target remains part of the new question context');
  for (const key of ['archiveProblem', 'archiveSource', 'archiveReading', 'archiveFocus']) assert.equal(new URL(page.url()).searchParams.has(key), false, `including clears ${key}`);
  assert.equal(new URL(page.url()).searchParams.has('run'), false, 'the new draft does not resume the archived accepted run');
  await screenshot(page, check, 'research-draft-included', composer);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 0 }); await visible(composer);
  assert.equal(await composer.inputValue(), added, 'refresh restores the included draft without duplicating the statement');
  await Promise.all([page.waitForEvent('domcontentloaded', { timeout: 0 }), clickWorkbenchAction(page, '#locale-switch')]); await visible(composer);
  assert.equal(await composer.inputValue(), added, 'switching locale preserves the new editable question');
  await Promise.all([page.waitForEvent('domcontentloaded', { timeout: 0 }), clickWorkbenchAction(page, '#locale-switch')]); await visible(composer);
  assert.equal(await composer.inputValue(), added);
  const edited = added + (en ? '\n\nKeep my revised research direction.' : '\n\n保留我修改后的研究方向。');
  await composer.fill(edited, { timeout: 0 });
  await page.locator('[data-chat-return-home]').click({ timeout: 0 });
  assert.equal(await composer.inputValue(), previous, 'returning home restores the exact unrelated question');
  await page.goto(readingUrl, { waitUntil: 'domcontentloaded', timeout: 0 }); await visible(page.locator(`[data-proof-solution="${record.id}"]`));
  await start().click({ timeout: 0 }); await visible(candidate);
  await candidate.locator('[data-problem-draft-include]').click({ timeout: 0 }); await candidate.waitFor({ state: 'hidden', timeout: 0 });
  assert.equal(new URL(page.url()).searchParams.get('editProblem'), independentId);
  assert.equal(await composer.inputValue(), edited, 'reopening the same source and step restores edits instead of replacing them');
  await page.locator('[data-chat-return-home]').click({ timeout: 0 });
  assert.equal(await composer.inputValue(), previous);
  await page.goto(readingUrl, { waitUntil: 'domcontentloaded', timeout: 0 }); await visible(page.locator(`[data-proof-solution="${record.id}"]`));
  await start().click({ timeout: 0 }); await visible(candidate);
  await candidate.locator('[data-problem-draft-append]').click({ timeout: 0 }); await candidate.waitFor({ state: 'hidden', timeout: 0 });
  assert((await composer.inputValue()).startsWith(previous + '\n\n'), 'appending requires its own explicit secondary action');
  assert.equal(new URL(page.url()).searchParams.has('editProblem'), false);
  await composer.fill(previous, { timeout: 0 });
  await healthy(page);
  check.assertions.push('Research this problem reads the pinned Challenge source into a candidate, creates an independent draft by default, restores its edits on refresh/language/re-entry, and preserves the exact home question. Appending is a separate explicit action. Neither action sends or creates a run.');
  await page.goto(readingUrl, { waitUntil: 'domcontentloaded', timeout: 0 }); await visible(page.locator(`[data-proof-solution="${record.id}"]`));
}
async function rawDownloads(context: BrowserContext) {
  phase = 'all accepted problems: real Challenge/Submission/verification/process HTTP downloads match the independent manifest';
  for (const record of expected) {
    const files: typeof downloads[number]['files'] = [], payload = new Map<string, Buffer>();
    for (const name of evidenceFiles) {
      const response = await context.request.get(`${origin}/classics/data/proofs/${record.id}/${name}`, { timeout: 0 });
      assert.equal(response.status(), 200, `${record.id}/${name}`);
      const bytes = await response.body(); assert.equal(digest(bytes), record.files[name], `${record.id}/${name}: real HTTP SHA-256`);
      assert.match(response.headers()['content-type'] ?? '', name.endsWith('.lean') ? /^text\/plain(?:;|$)/u : /^application\/json(?:;|$)/u);
      files.push({ name, sha256: digest(bytes), bytes: bytes.length }); payload.set(name, bytes);
      await response.dispose();
    }
    const acceptance = JSON.parse(payload.get('verification.json')!.toString('utf8')) as Acceptance;
    assert.equal(acceptance.target, record.campaign.target); assert.equal(acceptance.runId, record.campaign.runId);
    assert.equal(acceptance.proofCommit, record.campaign.proofCommit); assert.equal(acceptance.proofSha256, files.find(file => file.name === 'Submission.lean')!.sha256);
    assert.equal(acceptance.status, 'evaluated_passed'); assert.equal(acceptance.kernelStatus, 'kernel_verified'); assert.equal(acceptance.comparatorExitCode, 0);
    const process = JSON.parse(payload.get('process.json')!.toString('utf8')) as ArchiveProcess;
    const acceptedRun = process.runs.some(run => run.runId === record.campaign.runId && run.resultStatus === 'evaluated_passed');
    assert(acceptedRun, `${record.id}: archived process retains the independently accepted run`);
    downloads.push({ id: record.id, files, runId: acceptance.runId, acceptedRun });
  }
}

try {
  for (const scenario of [{ name: 'zh-1440', locale: 'zh', width: 1440, height: 1000, narrow: false },
    { name: 'en-1440', locale: 'en', width: 1440, height: 1000, narrow: false },
    { name: 'zh-390', locale: 'zh', width: 390, height: 844, narrow: false }, { name: 'en-390', locale: 'en', width: 390, height: 844, narrow: false },
    { name: 'zh-320', locale: 'zh', width: 320, height: 844, narrow: true }, { name: 'en-320', locale: 'en', width: 320, height: 844, narrow: true }]) {
    scenarioName = scenario.name; const en = scenario.locale === 'en', text = (zh: string, english: string) => en ? english : zh;
    const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, locale: en ? 'en-US' : 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
    context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
    await context.addInitScript(locale => localStorage.setItem('theorem-os.web-locale.v1', locale), scenario.locale);
    await context.route(/^https?:\/\//u, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(request.url()); await route.abort(); return; }
      if (request.method() !== 'GET') { writes.push(`${request.method()} ${url.pathname}`); await route.abort(); return; }
      if (url.pathname.endsWith('/classics/data/catalog.json')) { aggregateRequests.push(url.pathname); await route.abort(); return; }
      await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0);
    page.on('pageerror', error => errors.push(`${scenario.name}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`${scenario.name}: ${message.text()}`); });
    page.on('request', request => { const url = new URL(request.url()); requests.push({ scenario: scenario.name, method: request.method(), pathname: url.pathname, search: url.search }); });
    const check: typeof checks[number] = { scenario: scenario.name, displayedIds: [], screenshots: [], assertions: [] };

    phase = `${scenario.name}: default Theorems displays every accepted OpenAI problem, newest first, without full catalog/source/process payloads`;
    console.log(`CHECK ${phase}`);
    const indexResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/classics/data/index.json', { timeout: 0 });
    await page.goto(`${origin}/theorems.html`, { waitUntil: 'domcontentloaded', timeout: 0 });
    const response = await indexResponse; assert.equal(response.status(), 200);
    const indexBody = await response.body(), index = JSON.parse(indexBody.toString('utf8')) as ArchiveIndex; check.indexBytes = indexBody.length;
    assert.deepEqual(index.records.map(record => record.id).sort(), [...expectedIds].sort(), 'lightweight index matches the independently accepted manifest IDs');
    for (const record of index.records) {
      const independent = expected.find(item => item.id === record.id)!;
      assert.equal(record.status, 'locally_verified'); assert.equal(record.campaign?.runId, independent.campaign.runId);
      assert.equal(record.updatedAt, independent.updatedAt); assert.equal('process' in record, false, 'directory index does not embed process payloads');
      assert.equal(record.readingMode, [newest.id, historical.id].includes(record.id) ? 'source' : 'derivation', 'reading format describes this accepted proof');
      for (const source of record.sources) { assert.equal('code' in source, false, 'directory index does not embed source code'); assert.equal(source.sha256, independent.files[source.name]); }
    }
    assert.equal(index.records.filter(record => record.readingMode === 'derivation').length, 16);
    assert.equal(index.records.filter(record => record.readingMode === 'source').length, 2);
    await visible(directory(page)); await waitIds(page, expectedIds); check.displayedIds = await cards(page).evaluateAll(elements => elements.map(element => element.getAttribute('data-openai-problem')!));
    await fieldFacets(page, expected, en);
    assert.equal(await page.getByRole('heading', { name: text('已解决的 OpenAI 题目', 'Solved OpenAI problems'), exact: true }).count(), 1);
    assert.equal(await page.locator('[data-openai-problems-snapshot]').getAttribute('datetime'), index.snapshotAt);
    for (const record of expected) {
      const item = card(page, record.id), title = en ? record.en?.subtitle || record.title : record.subtitle || record.title;
      assert.equal(await item.locator('.research-card-heading').innerText(), title, `${record.id}: correct locale title`);
      assert.equal(await item.getAttribute('data-openai-problem-status'), 'locally_verified');
      const sourceReading = [newest.id, historical.id].includes(record.id), format = item.locator('[data-openai-problem-reading-mode]');
      assert.equal(await format.getAttribute('data-openai-problem-reading-mode'), sourceReading ? 'source' : 'derivation');
      assert.equal(await format.innerText(), sourceReading ? text('Lean 源码阅读', 'Lean source reading') : text('逐步数学讲解', 'Step-by-step explanation'));
      assert(await format.isVisible(), 'the reading format is disclosed before opening the solution');
      assert.equal(await item.locator('[data-openai-problem-updated]').getAttribute('datetime'), record.updatedAt);
      assert.deepEqual(await item.locator('[data-openai-problem-target]').evaluateAll(elements => elements.map(element => element.getAttribute('data-openai-problem-target'))), record.campaign.targets,
        `${record.id}: overview displays exactly the independent accepted proof targets`);
      assert.equal(await item.locator('[data-openai-problem-overview]').getAttribute('open'), null, 'overviews start collapsed');
      const statementLink = item.locator('[data-openai-problem-statement]');
      assert.equal(new URL((await statementLink.getAttribute('href'))!, page.url()).pathname, `/classics/data/proofs/${record.id}/Challenge.lean`);
      assert.equal(await statementLink.getAttribute('target'), '_blank', 'opening the original statement keeps the filtered directory available');
      for (const [tab, label] of [['reading', text('阅读解答', 'Read solution')], ['source', text('Lean 证明', 'Lean proof')], ['evidence', text('验收记录', 'Acceptance')]]) {
        const link = item.locator(`[data-openai-problem-link="${tab}"]`);
        assert.equal(await item.getByRole('link', { name: label, exact: true }).getAttribute('data-openai-problem-link'), tab);
        const href = await link.getAttribute('href'); assert(href);
        const url = new URL(href, page.url()), parameters = new URLSearchParams(url.hash.slice(1));
        assert.equal(url.pathname, en ? '/classics/en/archive.html' : '/classics/archive.html'); assert.equal(parameters.get('proof'), record.id); assert.equal(parameters.get('tab'), tab);
        const destination = new URL(parameters.get('return')!, origin);
        assert.equal(destination.origin, origin); assert.equal(destination.pathname, '/theorems.html');
        assert.equal(destination.searchParams.get('collection'), 'solved'); assert.equal(destination.hash, `#problem-${record.id}`);
      }
    }
    assert.equal(requests.filter(request => request.scenario === scenario.name && /^\/classics\/data\/(?:sources|process|proofs)\//u.test(request.pathname)).length, 0, 'directory leaves complete sources and research processes lazy');
    check.firstTitle = await cards(page).first().locator('.research-card-heading').evaluate(element => ({ top: Math.round(element.getBoundingClientRect().top),
      bottom: Math.round(element.getBoundingClientRect().bottom), viewportHeight: innerHeight, fullyVisible: element.getBoundingClientRect().top >= 0 && element.getBoundingClientRect().bottom <= innerHeight }));
    console.log(`LAYOUT ${scenario.name}: first problem title=${check.firstTitle.top}–${check.firstTitle.bottom}, viewport=${check.firstTitle.viewportHeight}, accepted=${expectedIds.length}`);
    await screenshot(page, check, 'directory'); assert(check.firstTitle.fullyVisible, `first accepted problem title is fully inside the initial viewport: ${JSON.stringify(check.firstTitle)}`);
    if (!scenario.narrow) assert(check.firstTitle.top < 600, `first accepted problem title begins before 600px with the shared research navigation: ${JSON.stringify(check.firstTitle)}`);
    assert(await cards(page).first().locator('.research-card-heading').evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && parseFloat(getComputedStyle(element).fontSize) >= 16 && element.scrollWidth <= element.clientWidth;
    }), `${scenario.name}: first title stays readable and fits the page width`);
    assert(await page.locator('.research-problem-fields').evaluate((element, desktop) => {
      const fields = element.getBoundingClientRect(), results = document.querySelector('.research-problem-results')!.getBoundingClientRect();
      const group = element.querySelector('.research-openai-areas')!.getBoundingClientRect(), picker = element.querySelector('[data-problem-field-select]')!.getBoundingClientRect();
      return desktop ? fields.right <= results.left && group.width > 0 && picker.width === 0
        : fields.bottom <= results.top && group.width === 0 && picker.width > 0 && picker.left >= 0 && picker.right <= innerWidth;
    }, scenario.width > 740), 'desktop fields sit beside the results; mobile offers the full native picker above them without horizontal browsing');
    assert(await cards(page).evaluateAll(elements => {
      const first = elements[0].getBoundingClientRect(), next = elements[1].getBoundingClientRect();
      return Math.abs(first.left - next.left) < 1 && Math.abs(first.width - next.width) < 1 && next.top >= first.bottom;
    }), 'accepted problems form one aligned vertical results column');
    check.assertions.push('Default view lists exactly the independent accepted manifest, by descending update date, including the latest TreeClauses and historical Character result; localized titles and all archive links match.');
    assert.equal(requests.filter(request => request.scenario === scenario.name && request.pathname === '/api/research/theorems').length, 0,
      'solved-problem browsing does not request personal research projects');
    phase = `${scenario.name}: keyboard problem overview shows the full mathematical summary and accepted goals without network reads`;
    const overview = card(page, newest.id).locator('[data-openai-problem-overview]'), overviewToggle = overview.locator(':scope > summary');
    const beforeOverviewReads = requests.length;
    await overviewToggle.focus(); await page.keyboard.press('Enter');
    assert.equal(await overview.getAttribute('open'), '');
    assert.equal(await overview.locator('.solution-route-prose').innerText(), en ? newest.en!.summary : newest.summary);
    assert(await overview.locator('[data-openai-problem-target]').last().isVisible());
    await screenshot(page, check, 'overview', overviewToggle);
    assert.equal(requests.length, beforeOverviewReads, 'overview expands entirely from the light directory index');
    await overviewToggle.focus(); await page.keyboard.press('Space');
    assert.equal(await overview.getAttribute('open'), null);
    assert(await overviewToggle.evaluate(element => element === document.activeElement), 'closing the overview keeps keyboard focus');
    check.assertions.push('Each overview matches the independently accepted target list and original Challenge.lean link; keyboard opening reveals the full localized mathematical summary without extra HTTP requests.');
    phase = `${scenario.name}: all fields are directly selectable, including later options, with no-match recovery`;
    const orderedAreas = [...new Map(expected.map(record => [record.area, record])).values()]
      .sort((a, b) => (en ? a.en?.area ?? a.area : a.area).localeCompare(en ? b.en?.area ?? b.area : b.area, en ? 'en' : 'zh-CN'));
    assert(orderedAreas.length > 4);
    const laterArea = orderedAreas.at(-1)!.area;
    await chooseField(page, laterArea, en);
    const laterIds = expected.filter(record => `${record.area} ${record.en?.area ?? ''}`.toLocaleLowerCase().includes(laterArea.toLocaleLowerCase())).map(record => record.id);
    await waitIds(page, laterIds); await fieldFacets(page, expected, en, laterArea);
    await screenshot(page, check, 'later-field');
    const fieldSearch = page.getByRole('searchbox', { name: text('关键词或 Lean 名称', 'Keyword or Lean name'), exact: true });
    await fieldSearch.fill('NoSuchIndependentAcceptedFieldProblem', { timeout: 0 }); await fieldSearch.press('Enter', { timeout: 0 }); await waitIds(page, []);
    await fieldFacets(page, [], en, laterArea); await chooseField(page, laterArea, en);
    await chooseField(page, '', en); await waitIds(page, []); await fieldFacets(page, [], en);
    await page.getByRole('button', { name: text('清除筛选', 'Clear filters'), exact: true }).click({ timeout: 0 }); await waitIds(page, expectedIds);
    await fieldFacets(page, expected, en); assert.equal(await fieldSearch.inputValue(), '');
    check.assertions.push('Every real field is present in the mobile picker and desktop list; a field after the initially visible choices can be selected, query counts update, the current zero-match choice stays usable and clear restores all accepted problems.');
    if (scenario.narrow) {
      const read = cards(page).first().locator('[data-openai-problem-link="reading"]');
      await read.focus(); assert(await read.evaluate(element => element === document.activeElement), 'narrow-screen primary action receives keyboard focus');
      await page.keyboard.press('Tab');
      assert(await page.evaluate(() => document.activeElement?.getAttribute('data-openai-problem-link') === 'source'), 'Tab reaches the adjacent Lean proof action');
      phase = `${scenario.name}: first accepted mathematical step fits the narrow initial reading viewport`;
      const explainedHref = await card(page, explained.id).locator('[data-openai-problem-link="reading"]').getAttribute('href'); assert(explainedHref);
      await page.goto(new URL(explainedHref, page.url()).href, { waitUntil: 'domcontentloaded', timeout: 0 });
      await visible(page.locator(`[data-proof-solution="${explained.id}"]`)); await firstReadingStep(page, check);
      await screenshot(page, check, 'reading-derivation');
      const nextStep = page.locator('[data-proof-derivation]').first().locator('.proof-walkthrough-next > button');
      const nextAnchor = await nextStep.getAttribute('data-global-scroll'); assert(nextAnchor);
      await nextStep.click({ timeout: 0 }); await checkReadingLocation(page, check, nextAnchor);
      phase = `${scenario.name}: narrow reading starts a draft only after explicit inclusion`;
      await researchDraftFlow(page, check, explained, en);
      await healthy(page); check.assertions.push('At 320px the title remains readable, the page has no horizontal overflow and primary archive actions are keyboard reachable.');
      checks.push(check); console.log(`PASS ${scenario.name}: narrow entry, ${expectedIds.length} accepted problems, keyboard actions`);
      await context.close(); active = undefined; continue;
    }
    await page.getByRole('button', { name: text('新建定理', 'New theorem'), exact: true }).click({ timeout: 0 });
    await page.getByLabel(text('定理名称', 'Theorem title'), { exact: true }).fill('Retained draft from solved problems', { timeout: 0 });
    await page.getByRole('button', { name: text('返回定理目录', 'Back to theorems'), exact: true }).click({ timeout: 0 });
    await visible(directory(page)); assert.equal(new URL(page.url()).searchParams.get('collection'), 'solved');
    await page.getByRole('button', { name: text('新建定理', 'New theorem'), exact: true }).click({ timeout: 0 });
    assert.equal(await page.getByLabel(text('定理名称', 'Theorem title'), { exact: true }).inputValue(), 'Retained draft from solved problems');
    await page.getByRole('button', { name: text('返回定理目录', 'Back to theorems'), exact: true }).click({ timeout: 0 }); await visible(directory(page));
    phase = `${scenario.name}: solved/research collection switching and legacy Library link migration`;
    const researchResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/research/theorems', { timeout: 0 });
    await page.locator('[data-theorem-collection="research"]').click({ timeout: 0 });
    assert.equal((await researchResponse).status(), 200);
    await visible(page.getByRole('heading', { name: text('定理目录', 'Theorem directory'), exact: true }));
    assert.equal(await directory(page).count(), 0); assert.equal(new URL(page.url()).searchParams.get('collection'), 'research');
    await page.locator('[data-theorem-collection="solved"]').click({ timeout: 0 }); await waitIds(page, expectedIds);
    assert.equal(new URL(page.url()).searchParams.get('collection'), 'solved');

    phase = `${scenario.name}: each collection retains its own query, field, page and sort during in-page switching`;
    const researchQuery = 'Retained research description', researchField = 'Retained research field';
    const researchUrl = new URL(`${origin}/theorems.html`);
    researchUrl.search = new URLSearchParams({ collection: 'research', q: researchQuery, field: researchField, offset: '14' }).toString();
    await page.goto(researchUrl.href, { waitUntil: 'domcontentloaded', timeout: 0 });
    await visible(page.getByRole('heading', { name: text('定理目录', 'Theorem directory'), exact: true }));
    const researchSearch = page.getByRole('searchbox', { name: text('搜索定理与研究描述', 'Search theorems and descriptions'), exact: true });
    const researchFieldInput = page.getByLabel(text('按领域筛选', 'Filter by field'), { exact: true });
    assert.equal(await researchSearch.inputValue(), researchQuery); assert.equal(await researchFieldInput.inputValue(), researchField);
    await page.locator('[data-theorem-collection="research"]').click({ timeout: 0 }); await settled(page);
    for (const [key, value] of [['q', researchQuery], ['field', researchField], ['offset', '14']])
      assert.equal(new URL(page.url()).searchParams.get(key), value, `clicking the current research collection retains ${key}`);
    await page.locator('[data-theorem-collection="solved"]').click({ timeout: 0 }); await waitIds(page, expectedIds);
    const retainedProblem = expected.find(record => record.area === laterArea)!;
    const retainedSearch = page.getByRole('searchbox', { name: text('关键词或 Lean 名称', 'Keyword or Lean name'), exact: true });
    const retainedSort = page.getByRole('combobox', { name: text('排列方式', 'Sort problems'), exact: true });
    await retainedSort.selectOption('title', { timeout: 0 }); await chooseField(page, laterArea, en);
    await retainedSearch.fill(retainedProblem.id, { timeout: 0 }); await retainedSearch.press('Enter', { timeout: 0 }); await waitIds(page, [retainedProblem.id]);
    await page.locator('[data-theorem-collection="solved"]').click({ timeout: 0 }); await waitIds(page, [retainedProblem.id]);
    assert.equal(await retainedSearch.inputValue(), retainedProblem.id); assert.equal(await retainedSort.inputValue(), 'title');
    assert.equal(new URL(page.url()).searchParams.get('field'), laterArea, 'clicking the current solved collection retains its field');
    await page.locator('[data-theorem-collection="research"]').click({ timeout: 0 });
    await visible(page.getByRole('heading', { name: text('定理目录', 'Theorem directory'), exact: true })); await settled(page);
    assert.equal(await researchSearch.inputValue(), researchQuery); assert.equal(await researchFieldInput.inputValue(), researchField);
    for (const [key, value] of [['q', researchQuery], ['field', researchField], ['offset', '14']])
      assert.equal(new URL(page.url()).searchParams.get(key), value, `returning to research restores its own ${key}`);
    assert(await page.getByRole('button', { name: text('上一页', 'Previous'), exact: true }).isVisible(), 'the retained nonzero research page still offers Previous');
    await page.locator('[data-theorem-collection="solved"]').click({ timeout: 0 }); await waitIds(page, [retainedProblem.id]);
    assert.equal(await retainedSearch.inputValue(), retainedProblem.id); assert.equal(await retainedSort.inputValue(), 'title');
    const restoredSolved = new URL(page.url()).searchParams;
    assert.equal(restoredSolved.get('q'), retainedProblem.id); assert.equal(restoredSolved.get('field'), laterArea);
    assert.equal(restoredSolved.get('sort'), 'title'); assert.equal(restoredSolved.has('offset'), false, 'research pagination does not leak into solved problems');
    await fieldFacets(page, [retainedProblem], en, laterArea);
    await screenshot(page, check, 'collection-restored');
    check.assertions.push('Solved and research collections restore separate applied searches and fields; research retains its nonzero page while solved retains title sort and its own page. Clicking either current collection preserves the conditions.');

    const legacy = new URL(`${origin}/library.html`); legacy.searchParams.set('collection', 'openai');
    legacy.searchParams.set('q', newest.campaign.target); legacy.searchParams.set('area', newest.area);
    await page.goto(legacy.href, { waitUntil: 'domcontentloaded', timeout: 0 });
    await page.waitForURL(url => url.pathname === '/theorems.html' && url.searchParams.get('collection') === 'solved', { timeout: 0 });
    await waitIds(page, [newest.id]);
    const migrated = new URL(page.url()); assert.equal(migrated.searchParams.get('q'), newest.campaign.target);
    assert.equal(migrated.searchParams.get('field'), newest.area); assert.equal(migrated.searchParams.has('area'), false);
    await healthy(page);
    await page.goto(`${origin}/theorems.html?collection=solved`, { waitUntil: 'domcontentloaded', timeout: 0 }); await waitIds(page, expectedIds);
    check.assertions.push('Theorems switches between solved problems and research projects; legacy Library OpenAI links migrate query and area into solved query/field.');

    phase = `${scenario.name}: localized title ordering, no-match recovery and keyboard filter reset`;
    const search = page.getByRole('searchbox', { name: text('关键词或 Lean 名称', 'Keyword or Lean name'), exact: true });
    const sort = page.getByRole('combobox', { name: text('排列方式', 'Sort problems'), exact: true });
    const descriptionQuery = en ? 'offspring probability' : '概率性质';
    const descriptionRecords = expected.filter(record => descriptionQuery.toLocaleLowerCase().split(/\s+/u).every(token =>
      `${record.summary} ${record.en?.summary ?? ''}`.toLocaleLowerCase().includes(token)));
    const descriptionMatches = descriptionRecords.map(record => record.id);
    assert(descriptionMatches.includes(newest.id));
    await search.fill(descriptionQuery, { timeout: 0 }); await search.press('Enter', { timeout: 0 }); await waitIds(page, descriptionMatches);
    await fieldFacets(page, descriptionRecords, en);
    await chooseField(page, newest.area, en);
    await waitIds(page, descriptionMatches); await fieldFacets(page, descriptionRecords, en, newest.area);
    await chooseField(page, '', en);
    await waitIds(page, descriptionMatches); await fieldFacets(page, descriptionRecords, en);
    await search.fill('', { timeout: 0 }); await search.press('Enter', { timeout: 0 }); await waitIds(page, expectedIds);
    await fieldFacets(page, expected, en);
    check.assertions.push('Natural mathematical phrases from Chinese and English summaries find their independently matching solved problems; every facet count follows that query set, unselected zero-match fields are disabled and all-fields remains available.');
    const titleIds = [...expected].sort((a, b) => (en ? a.en?.subtitle || a.title : a.subtitle || a.title)
      .localeCompare(en ? b.en?.subtitle || b.title : b.subtitle || b.title, en ? 'en' : 'zh-CN') || a.id.localeCompare(b.id)).map(record => record.id);
    assert.equal(await sort.inputValue(), 'newest'); assert.equal(new URL(page.url()).searchParams.has('sort'), false);
    await sort.selectOption('title', { timeout: 0 }); await waitIds(page, titleIds);
    assert.equal(new URL(page.url()).searchParams.get('sort'), 'title');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 0 }); await waitIds(page, titleIds);
    assert.equal(await sort.inputValue(), 'title');
    await chooseField(page, newest.area, en);
    await search.fill('NoSuchIndependentAcceptedProblem', { timeout: 0 }); await search.press('Enter', { timeout: 0 }); await waitIds(page, []);
    await fieldFacets(page, [], en, newest.area);
    const reset = page.getByRole('button', { name: text('清除筛选', 'Clear filters'), exact: true });
    await reset.focus(); await page.keyboard.press('Enter'); await waitIds(page, titleIds);
    await fieldFacets(page, expected, en);
    assert.equal(await search.inputValue(), ''); assert.equal(await reset.count(), 0);
    assert(await search.evaluate(element => element === document.activeElement), 'keyboard reset returns focus to the cleared search field');
    const cleared = new URL(page.url()).searchParams; assert.equal(cleared.get('sort'), 'title');
    for (const key of ['q', 'field', 'offset']) assert.equal(cleared.has(key), false, `keyboard clear removes ${key}`);
    await page.locator('[data-theorem-collection="research"]').click({ timeout: 0 });
    await visible(page.getByRole('heading', { name: text('定理目录', 'Theorem directory'), exact: true }));
    await page.locator('[data-theorem-collection="solved"]').click({ timeout: 0 }); await waitIds(page, titleIds);
    assert.equal(await sort.inputValue(), 'title'); assert.equal(new URL(page.url()).searchParams.get('sort'), 'title');
    await sort.selectOption('newest', { timeout: 0 }); await waitIds(page, expectedIds);
    assert.equal(new URL(page.url()).searchParams.has('sort'), false);
    check.assertions.push('Localized title sort matches independent manifest titles and survives reload/collection switching; no-match search keeps the selected zero-count field available, and keyboard clear restores every problem and facet, clears query/field/offset and retains sort.');

    phase = `${scenario.name}: new ID/target search, field filtering and URL reload preservation`;
    await search.fill(newest.id, { timeout: 0 }); await search.press('Enter', { timeout: 0 }); await waitIds(page, [newest.id]);
    await search.fill(newest.campaign.target, { timeout: 0 }); await search.press('Enter', { timeout: 0 }); await waitIds(page, [newest.id]);
    await search.fill('', { timeout: 0 }); await search.press('Enter', { timeout: 0 }); await waitIds(page, expectedIds);
    await chooseField(page, newest.area, en);
    const filteredIds = expected.filter(record => `${record.area} ${record.en?.area ?? ''}`.toLocaleLowerCase().includes(newest.area.toLocaleLowerCase())).map(record => record.id);
    await waitIds(page, filteredIds); await fieldFacets(page, expected, en, newest.area);
    await search.fill(newest.campaign.target, { timeout: 0 }); await search.press('Enter', { timeout: 0 }); await waitIds(page, [newest.id]);
    await fieldFacets(page, [newest], en, newest.area);
    const before = new URL(page.url()); assert.equal(before.searchParams.get('collection'), 'solved'); assert.equal(before.searchParams.get('q'), newest.campaign.target); assert.equal(before.searchParams.get('field'), newest.area);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 0 }); await waitIds(page, [newest.id]);
    const after = new URL(page.url()); for (const key of ['collection', 'q', 'field']) assert.equal(after.searchParams.get(key), before.searchParams.get(key));
    assert.equal(await search.inputValue(), newest.campaign.target); await healthy(page);
    const returnBrowse = new URL(page.url()); returnBrowse.searchParams.set('sort', 'title'); returnBrowse.searchParams.set('offset', '14');
    await page.goto(returnBrowse.href, { waitUntil: 'domcontentloaded', timeout: 0 }); await waitIds(page, [newest.id]);
    const links = Object.fromEntries(await Promise.all(['reading', 'source', 'evidence'].map(async tab => [tab, new URL((await card(page, newest.id).locator(`[data-openai-problem-link="${tab}"]`).getAttribute('href'))!, page.url()).href])));
    const returnPath = new URLSearchParams(new URL(links.reading).hash.slice(1)).get('return'); assert(returnPath);
    const returnDestination = new URL(returnPath, origin);
    for (const key of ['collection', 'q', 'field', 'sort', 'offset']) assert.equal(returnDestination.searchParams.get(key), returnBrowse.searchParams.get(key), `reading carries the original ${key}`);
    check.assertions.push('New problem ID and target are searchable; real field filters and solved collection/search/field persist through refresh.');
    if (!downloads.length) await rawDownloads(context);

    phase = `${scenario.name}: read solution starts from the accepted proof and localized problem title`;
    await card(page, newest.id).locator('[data-openai-problem-link="reading"]').click({ timeout: 0 });
    const reading = page.locator(`[data-proof-solution="${newest.id}"]`); await visible(reading);
    assert.equal(await page.locator('#tab-reading').getAttribute('aria-selected'), 'true');
    assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('tab'), 'reading');
    assert.equal(await page.locator('.detail-title').innerText(), en ? newest.en?.subtitle ?? newest.title : newest.subtitle ?? newest.title);
    assert.equal(await reading.getAttribute('data-proof-solution-run'), newest.campaign.runId);
    assert.equal(await reading.getAttribute('data-proof-solution-sha'), newest.campaign.proofSha256);
    assert.equal(await reading.getAttribute('data-proof-solution-mode'), 'source');
    const startResearch = reading.locator('[data-proof-start-research]');
    const newResearchHref = new URL((await startResearch.getAttribute('href'))!, page.url());
    assert.equal(newResearchHref.origin, origin); assert.equal(newResearchHref.pathname, '/');
    assert.equal(newResearchHref.searchParams.get('archiveProblem'), newest.id);
    assert.equal(newResearchHref.searchParams.get('archiveSource'), newest.files['Challenge.lean']);
    assert.equal(newResearchHref.searchParams.has('run'), false, 'starting new research never names the accepted run as a resumable identity');
    assert.equal(await startResearch.innerText(), text('以此题开始研究', 'Research this problem'));
    assert.equal(await reading.locator('[data-proof-solution-summary]').innerText(), en ? newest.en?.summary ?? newest.summary : newest.summary);
    assert.deepEqual(await reading.locator('[data-proof-source-declaration]').evaluateAll(elements => elements.map(element => element.getAttribute('data-proof-source-declaration'))), newest.campaign.targets);
    assert.equal(await page.locator('.global-history-panel, [data-solution-route-record]').count(), 0, 'history and route canvases do not precede proof reading');
    const acceptedSource = await fs.readFile(path.join(root, 'research/openai-math', newest.directory, 'Submission.lean'), 'utf8');
    for (const code of await reading.locator('[data-proof-source-declaration] [data-proof-source-code]').allTextContents()) {
      assert(code.trim()); assert(acceptedSource.includes(code), 'visible target proof is an exact excerpt of the independent accepted Submission.lean');
    }
    for (const target of newest.campaign.targets) {
      assert.equal(await reading.locator(`[data-proof-source-declaration="${target}"] h5`).innerText(), target.split('.').at(-1), 'source headings use real declaration names');
    }
    const setup = reading.locator('[data-proof-math-setup]');
    await visible(setup);
    assert((await setup.innerText()).includes(text('后验分布', 'posterior distribution')), 'source reading begins with the mathematical problem before the Lean proofs');
    await screenshot(page, check, 'reading', page.locator('.detail-title'));
    const localDefinitions = reading.locator('[data-proof-source-declaration]').first().locator('[data-proof-used-definitions]');
    assert.deepEqual(await localDefinitions.locator('[data-proof-used-definition]').evaluateAll(elements => elements.map(element => element.getAttribute('data-proof-used-definition')).sort()),
      ['OAI.ThreeState.TreeClauses.Admissible', 'OAI.ThreeState.TreeClauses.Spin', 'OAI.ThreeState.TreeClauses.channelWeight'].sort(), 'the target exposes its actual local definitions');
    const admissible = localDefinitions.locator('[data-proof-used-definition="OAI.ThreeState.TreeClauses.Admissible"]');
    await admissible.locator(':scope > summary').click({ timeout: 0 });
    assert((await admissible.locator('code').last().textContent())!.includes('-(1 / 2 : ℝ) ≤ lam ∧ lam ≤ 1'), 'the complete admissibility definition is readable beside the target');
    await screenshot(page, check, 'reading-local-definition', admissible);
    const definitionJump = admissible.locator('[data-proof-definition-jump]');
    await definitionJump.scrollIntoViewIfNeeded({ timeout: 0 });
    const originScroll = await page.evaluate(() => scrollY), readingHistory = await page.evaluate(() => window.history.length);
    await definitionJump.click({ timeout: 0 });
    const selectedDefinition = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('reading');
    assert(selectedDefinition?.startsWith('proof-source-helper-'), 'the local definition links to its exact immutable reading position');
    const definitionReturn = reading.locator(`#${selectedDefinition} [data-proof-definition-return]`);
    await visible(definitionReturn); await screenshot(page, check, 'reading-definition-return', definitionReturn);
    await definitionReturn.click({ timeout: 0 });
    assert(await definitionJump.evaluate(element => element === document.activeElement), 'return restores focus to the exact definition link beside the original target');
    assert(Math.abs(await page.evaluate(() => scrollY) - originScroll) <= 1, 'return restores the previous reading position');
    assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('reading'), 'proof-source-target-1');
    assert.equal(await page.evaluate(() => window.history.length), readingHistory, 'reading and returning never add browser history entries');
    const sourceIndex = reading.locator('.proof-source-index');
    await sourceIndex.locator(':scope > summary').click({ timeout: 0 });
    const helperJump = sourceIndex.locator('[data-global-scroll^="proof-source-helper-"]').first();
    if (await helperJump.count()) {
      const helperId = await helperJump.getAttribute('data-global-scroll'); assert(helperId);
      await helperJump.click({ timeout: 0 });
      const helper = page.locator(`#${helperId}`);
      assert.equal(await helper.getAttribute('open'), '', 'index expands the exact supporting declaration');
      assert.equal(await helper.locator('xpath=..').getAttribute('open'), '', 'the enclosing definitions section also opens');
      assert(await helper.locator(':scope > summary').evaluate(element => element === document.activeElement), 'source index puts keyboard focus on the definition');
      assert(acceptedSource.includes(await helper.locator('[data-proof-source-code]').innerText()));
    }

    phase = `${scenario.name}: browser Back and explicit return preserve the original filtered theorem directory`;
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 0 }); await waitIds(page, [newest.id]);
    for (const key of ['collection', 'q', 'field', 'sort', 'offset']) assert.equal(new URL(page.url()).searchParams.get(key), returnBrowse.searchParams.get(key), `browser Back retains ${key}`);
    await card(page, newest.id).locator('[data-openai-problem-link="reading"]').click({ timeout: 0 }); await visible(reading);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 0 }); await visible(reading);
    assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('return'), returnPath, 'reload retains the return destination');
    await page.locator('a.lang-link').click({ timeout: 0 }); await visible(reading);
    assert.equal(new URL(page.url()).pathname, en ? '/classics/archive.html' : '/classics/en/archive.html');
    assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('return'), returnPath, 'language switching retains the return destination');
    assert.equal(await page.locator('[data-theorem-directory-return]').first().getAttribute('href'), returnPath);
    await page.locator('a.lang-link').click({ timeout: 0 }); await visible(reading);
    await page.locator('#tab-evidence').click({ timeout: 0 }); await visible(page.locator('.campaign-evidence'));
    assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('return'), returnPath, 'changing archive tabs retains the return destination');
    await page.locator('#tab-reading').click({ timeout: 0 }); await visible(reading);
    await page.locator('[data-theorem-directory-return]').first().click({ timeout: 0 }); await waitIds(page, [newest.id]);
    for (const key of ['collection', 'q', 'field', 'sort', 'offset']) assert.equal(new URL(page.url()).searchParams.get(key), returnBrowse.searchParams.get(key), `explicit return restores ${key}`);
    assert.equal(await search.inputValue(), newest.campaign.target); assert.equal(await sort.inputValue(), 'title');
    await fieldFacets(page, [newest], en, newest.area);
    await page.waitForFunction(id => document.activeElement?.id === `problem-${id}`, newest.id, { timeout: 0 });
    assert.equal(new URL(page.url()).hash, `#problem-${newest.id}`);
    assert(await card(page, newest.id).evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.top < innerHeight && bounds.bottom > 0; }), 'explicit return reveals the original card');
    await screenshot(page, check, 'reading-return', card(page, newest.id));
    check.assertions.push('Browser Back keeps the originating filters; explicit Back to theorems restores collection/query/field/sort/nonzero offset and focuses the exact card. Refresh, language switches and archive tabs retain the safe same-site return.');
    await card(page, newest.id).locator('[data-openai-problem-link="reading"]').click({ timeout: 0 }); await visible(reading);
    phase = `${scenario.name}: accepted problem opens a draft candidate and preserves prior input until the user includes it`;
    const sourcePositionIndex = reading.locator('.proof-source-index');
    await sourcePositionIndex.locator(':scope > summary').click({ timeout: 0 });
    const sourcePositionJump = sourcePositionIndex.locator('[data-global-scroll^="proof-source-helper-"]').first();
    const sourceAnchor = await sourcePositionJump.getAttribute('data-global-scroll'); assert(sourceAnchor);
    await sourcePositionJump.click({ timeout: 0 }); await checkReadingLocation(page, check, sourceAnchor);
    await researchDraftFlow(page, check, newest, en);
    await page.getByRole('button', { name: text('历史轮次与路线图', 'Recorded runs and route maps'), exact: true }).click({ timeout: 0 });
    await visible(page.locator('.global-workflow'));
    assert.equal(await page.locator('#tab-process').getAttribute('aria-selected'), 'true', 'research history remains reachable from accepted reading');

    phase = `${scenario.name}: existing mathematical walkthrough and historical accepted proof use the same direct reading path`;
    for (const record of [explained, historical]) {
      const url = new URL(links.reading); url.hash = new URLSearchParams({ proof: record.id, tab: 'reading', status: 'verified' }).toString();
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 0 });
      const solution = page.locator(`[data-proof-solution="${record.id}"]`); await visible(solution);
      assert.equal(await solution.getAttribute('data-proof-solution-run'), record.campaign.runId);
      assert.equal(await solution.getAttribute('data-proof-solution-sha'), record.campaign.proofSha256);
      const researchHref = new URL((await solution.locator('[data-proof-start-research]').getAttribute('href'))!, page.url());
      assert.equal(researchHref.searchParams.get('archiveProblem'), record.id);
      assert.equal(researchHref.searchParams.get('archiveSource'), record.files['Challenge.lean']);
      assert.equal(await page.locator('.detail-title').innerText(), en ? record.en?.subtitle ?? record.title : record.subtitle ?? record.title);
      assert.equal(await page.locator('.global-history-panel, [data-solution-route-record]').count(), 0);
      if (record.id === explained.id) {
        assert.equal(await solution.getAttribute('data-proof-solution-mode'), 'derivation');
        assert.equal(await solution.locator('[data-proof-walkthrough]').getAttribute('data-proof-sha'), record.campaign.proofSha256);
        assert(await solution.locator('[data-proof-derivation]').first().isVisible());
        assert.equal(await solution.locator('.proof-route-panel').getAttribute('open'), null, 'the proof diagram starts collapsed');
        await firstReadingStep(page, check);
        await screenshot(page, check, 'reading-derivation');
        assert(await solution.locator('.proof-walkthrough-strategy').isVisible(), 'the unchanged mathematical strategy remains visible');
        const next = solution.locator('[data-proof-derivation]').first().locator('.proof-walkthrough-next > button');
        const nextTarget = await next.getAttribute('data-global-scroll'); assert(nextTarget);
        await next.click({ timeout: 0 });
        assert(await page.locator(`#${nextTarget} h5`).evaluate(element => document.activeElement === element), 'Continue follows the existing linear proof steps');
        await checkReadingLocation(page, check, nextTarget);
      } else {
        assert.equal(await solution.getAttribute('data-proof-solution-mode'), 'source');
        assert.deepEqual(await solution.locator('[data-proof-source-declaration]').evaluateAll(elements => elements.map(element => element.getAttribute('data-proof-source-declaration'))), record.campaign.targets);
        const mathematics = solution.locator(`[data-proof-source-mathematics="${record.id}"]`);
        await visible(mathematics.locator('[data-proof-math-setup]'));
        const notes = mathematics.locator('[data-proof-math-details]');
        assert.equal(await notes.getAttribute('open'), null, 'full notes start collapsed after a readable mathematical setup');
        await notes.locator(':scope > summary').click({ timeout: 0 });
        assert.deepEqual(await notes.locator('[data-proof-math-target]').evaluateAll(elements => elements.map(element => element.getAttribute('data-proof-math-target'))), record.campaign.targets);
        const prose = await notes.innerText();
        assert(prose.includes(text('完整假设', 'Full assumptions')));
        assert(prose.includes(text('核心证明思路', 'Core proof outline')));
        assert(prose.includes(record.id === newest.id ? 'Aₙ' : 'SameFramedFlag'));
        await screenshot(page, check, 'source-mathematical-notes', mathematics);
        await notes.locator('[data-global-scroll="proof-source-target-1"]').first().click({ timeout: 0 });
        assert(await solution.locator('#proof-source-target-1 h5').evaluate(element => element === document.activeElement), 'mathematical target meaning links to its exact accepted Lean proof');
      }
      if (record.id !== explained.id) await screenshot(page, check, 'reading-historical', page.locator('.detail-title'));
      assert.equal(await page.locator('[data-theorem-directory-return]').count(), 0, 'classic-only entry keeps its original return behavior');
      await page.locator('[data-action="back-list"]').first().click({ timeout: 0 }); await visible(page.locator('.catalog'));
      assert(await page.locator(`[data-proof-id="${record.id}"]`).evaluate(element => element === document.activeElement), 'classic Back to results focuses the selected classic row');
    }
    check.assertions.push('Read solution opens accepted linear reading with localized titles: the newest and historical proofs show exact accepted target source, while an existing walkthrough keeps its derivations and Continue controls. History and graphs are available separately.');

    phase = `${scenario.name}: the explanation route opens on mathematical reasoning with its context and stage connections`;
    const explainedRoute = new URL(links.reading);
    explainedRoute.hash = new URLSearchParams({ proof: explained.id, tab: 'process', mode: 'global', status: 'verified' }).toString();
    await page.goto(explainedRoute.href, { waitUntil: 'domcontentloaded', timeout: 0 });
    await visible(page.locator(`[data-solution-route-record="${explained.id}"][data-solution-route-state="ready"]`));
    const mathematicalRoute = page.locator('.solution-route');
    assert.equal(await mathematicalRoute.getAttribute('data-solution-route-basis'), 'explanation', 'an available explanation is the initial route');
    assert(await mathematicalRoute.locator('.solution-route-overview').isVisible(), 'goal, notation and strategy are visible above the graph');
    const stages = mathematicalRoute.locator('.solution-route-stages button');
    assert(await stages.count() > 0, 'the mathematical stages remain interactive');
    assert(await mathematicalRoute.locator('.solution-route-reason').first().isVisible(), 'each transformation retains its reason');
    const proofEvidence = mathematicalRoute.locator('.solution-route-evidence');
    assert.equal(await proofEvidence.getAttribute('open'), null, 'technical evidence starts folded');
    assert.equal(await proofEvidence.locator('pre').isVisible(), false);
    await stages.last().click({ timeout: 0 });
    const selectedStep = await stages.last().getAttribute('data-solution-select');
    assert.equal(await mathematicalRoute.locator(`[data-solution-node="${selectedStep}"]`).getAttribute('aria-pressed'), 'true');
    await stages.first().click({ timeout: 0 });
    await proofEvidence.locator(':scope > summary').click({ timeout: 0 });
    assert(await proofEvidence.locator('pre').isVisible(), 'the original Lean excerpt stays available on demand');
    await proofEvidence.locator(':scope > summary').click({ timeout: 0 });
    await screenshot(page, check, 'mathematical-route', mathematicalRoute.locator('.solution-route-heading'));
    check.assertions.push('The shared explanation route defaults to mathematics and retains the goal, notation, strategy, interactive stages, individual reasons and folded exact source.');

    phase = `${scenario.name}: newest problem source link opens its real static proof and SHA binding`;
    await page.goto(links.source, { waitUntil: 'domcontentloaded', timeout: 0 }); await visible(page.locator('#source-file'));
    await page.locator('#source-file').selectOption('Submission.lean', { timeout: 0 });
    const proof = page.locator(`.source-code[data-source-name="Submission.lean"][data-source-digest="${newest.files['Submission.lean']}"]`); await visible(proof);
    assert((await page.locator('.source-facts').innerText()).includes(newest.files['Submission.lean']));
    assert.equal(await page.locator('.detail-id').innerText(), newest.id); await screenshot(page, check, 'source', page.locator('.detail-title'));

    phase = `${scenario.name}: newest problem evidence link opens its real local acceptance`;
    await page.goto(links.evidence, { waitUntil: 'domcontentloaded', timeout: 0 }); await visible(page.locator('.campaign-evidence'));
    assert.deepEqual(await page.locator('[data-accepted-target]').evaluateAll(elements => elements.map(element => element.getAttribute('data-accepted-target'))), newest.campaign.targets);
    const receiptDetails = page.locator('[data-acceptance-receipts]');
    assert.equal(await receiptDetails.getAttribute('open'), null, 'technical receipts begin collapsed, after the original problem and conclusions');
    assert(await page.locator('[data-acceptance-mathematics]').isVisible());
    await page.locator('[data-action="view-statement"]').click({ timeout: 0 });
    await visible(page.locator('.source-code[data-source-name="Challenge.lean"]'));
    assert.equal(await page.locator('#source-file').inputValue(), 'Challenge.lean', 'acceptance opens the complete original problem');
    await page.locator('#tab-evidence').click({ timeout: 0 }); await visible(page.locator('[data-acceptance-mathematics]'));
    await screenshot(page, check, 'evidence-conclusions', page.locator('.detail-title'));
    await receiptDetails.locator('summary').click({ timeout: 0 });
    const acceptance = await page.locator('.campaign-evidence').innerText();
    for (const token of [newest.campaign.runId, newest.campaign.proofSha256, 'kernel_verified', 'evaluated_passed']) assert(acceptance.includes(token));
    const evidenceLink = page.locator('.campaign-evidence').getByRole('link', { name: 'verification.json', exact: true });
    assert.equal(new URL((await evidenceLink.getAttribute('href'))!, page.url()).pathname, `/classics/data/proofs/${newest.id}/verification.json`);
    await screenshot(page, check, 'evidence', page.locator('.detail-title'));

    phase = `${scenario.name}: newest problem process link opens the accepted run and real trajectory`;
    const legacyProcess = new URL(links.reading); legacyProcess.hash = new URLSearchParams({ proof: newest.id, tab: 'process', status: 'verified' }).toString();
    await page.goto(legacyProcess.href, { waitUntil: 'domcontentloaded', timeout: 0 }); await visible(page.locator('.global-workflow'));
    await visible(page.locator('[data-solution-route-state="ready"]'));
    const history = page.locator('.global-history-panel'); await history.locator(':scope > summary').click({ timeout: 0 });
    await visible(page.locator(`.global-run-lane[data-global-run-id="${newest.campaign.runId}"][data-final="true"]`));
    assert.equal(await page.locator('.detail-id').innerText(), newest.id); await screenshot(page, check, 'process', page.locator('.detail-title'));
    check.assertions.push('Legacy source, evidence and process deep links still open the real static archive; newest proof SHA, acceptance and accepted research run stay bound.');
    checks.push(check); console.log(`PASS ${scenario.name}: ${expectedIds.length} accepted OpenAI problems, lazy directory, search, field and static archive links`);
    await context.close(); active = undefined;
  }
  assert.deepEqual(downloads.map(record => record.id).sort(), [...expectedIds].sort());
} catch (error) {
  failure = error; process.exitCode = 1; console.error(error);
  await active?.screenshot({ path: path.join(output, `${scenarioName}-failure.png`), animations: 'disabled', timeout: 0 }).catch(() => {});
} finally {
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    expectedFrom: 'research/openai-math/manifest.json + each accepted verification/process and source SHA', manifestSha256: digest(manifestText),
    expectedIds, latestId: newest.id, historicalId: historical.id, checks, downloads, requests, errors, external, writes, aggregateRequests, forbiddenCalls,
    realModelCalls: 0, realLeanProcesses: 0, browserTimeouts: 0, deadline: null, fixturesRemoved: true,
    ...(failure ? { failedPhase: phase, error: failure instanceof Error ? failure.stack ?? failure.message : String(failure) } : {}) }, null, 2) + '\n');
}
