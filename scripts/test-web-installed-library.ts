#!/usr/bin/env bun
// Real local HTTP service and repository catalog; no published assets, model calls or Lean execution.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator, type Page, type Response as BrowserResponse } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchAsset } from '../apps/web/researchAssetTypes';
import type { InstalledLibraryDetail, InstalledLibraryDirectory, InstalledLibrarySource } from '../apps/web/installedLibraryTypes';
import { installedLibraryLabels } from '../apps/web/installedLibraryLabels';
import { installedLibraryMathematics } from '../apps/web/installedLibraryMathematics';
import { matchesInstalledLibraryInterface } from '../apps/web/installedLibraryInterfaceSearch';
import { proseSegments } from '../apps/web/client/explainText';
import { audit } from './web-a11y';
import { freePort } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-installed-library');
await fs.mkdir(output, { recursive: true });
await fs.access(path.join(root, 'out/web/research.js'));
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-installed-library-browser-'));
const forbiddenCalls: string[] = [];
const forbidden = (operation: string): never => { forbiddenCalls.push(operation); throw new Error(`Installed-library browsing must not call runner.${operation}`); };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Read-only local installed-library browser regression' }; },
  async run() { return forbidden('run'); }, async check() { return forbidden('check'); }, async command() { return forbidden('command'); },
  async explain() { return forbidden('explain'); }, async formalize() { return forbidden('formalize'); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_CLIENT_IP_HEADER: 'x-test-visitor',
  THEOREMOS_WEB_PROVIDERS: '[{"id":"fixture","name":"Local fixture","baseUrl":"https://fixture.invalid/v1"}]' }), runner, { sample: null });
service.server.requestTimeout = 0; service.server.headersTimeout = 0;
await new Promise<void>((resolve, reject) => { service.server.once('error', reject); service.server.listen(port, '127.0.0.1', resolve); });
const browser = await chromium.launch({ headless: true, timeout: 0 });
const requests: { scenario: string; method: string; pathname: string; search: string }[] = [];
const errors: string[] = [], external: string[] = [], writes: string[] = [], problemIndexRequests: string[] = [];
const checks: { scenario: string; assertions: string[]; screenshots: string[]; catalogDigest?: string; moduleCount?: number; declarationCount?: number;
  fieldOptions?: string[];
  firstModuleCard?: { top: number; viewportHeight: number; visibleOnEntry: boolean };
  firstModuleTitle?: { top: number; bottom: number; viewportHeight: number; visibleOnEntry: boolean } }[] = [];
let active: Page | undefined, phase = 'setup', scenarioName = '', failure: unknown;
const visible = (locator: Locator) => locator.waitFor({ state: 'visible', timeout: 0 });
const directory = (page: Page) => page.locator('[data-installed-library-directory]');
const detail = (page: Page) => page.locator('[data-installed-library-detail]');
const cards = (page: Page) => directory(page).locator('[data-installed-library-module]');
const openModule = (page: Page, name: string) => directory(page).locator(`[data-installed-library-open="${name}"]`);
async function settled(page: Page) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
}
async function get<T>(page: Page, pathname: string): Promise<T> {
  const response = await page.evaluate(async pathname => {
    const result = await fetch(pathname);
    return { status: result.status, owner: result.headers.get('X-Theoremos-Owner'), body: await result.json() };
  }, pathname);
  assert.equal(response.status, 200, `${pathname}: ${JSON.stringify(response.body)}`);
  assert(response.owner, 'research HTTP response includes its owner binding');
  return response.body as T;
}
async function healthy(page: Page) {
  await settled(page);
  assert.deepEqual(await audit(page), [], `${phase}: accessibility`);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${phase}: no horizontal page overflow`);
  assert.equal(await page.locator('.research-error:visible').count(), 0, `${phase}: no API error visible`);
  assert.deepEqual(errors, [], `${phase}: no browser errors`);
  assert.deepEqual(external, [], `${phase}: local network only`);
  assert.deepEqual(writes, [], `${phase}: no browser mutations`);
  assert.deepEqual(forbiddenCalls, [], `${phase}: no model, Lean or research runner calls`);
  assert.deepEqual(problemIndexRequests, [], `${phase}: reusable Library does not load the solved-problem index`);
}
function urlFilters(page: Page, values: Record<string, string>, removed: string[] = []) {
  const parameters = new URL(page.url()).searchParams;
  for (const [name, value] of Object.entries(values)) assert.equal(parameters.get(name), value, `${phase}: URL ${name}`);
  for (const name of removed) assert.equal(parameters.has(name), false, `${phase}: URL clears ${name}`);
}
function responseFor(page: Page, pathname: string, query: Record<string, string> = {}) {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === pathname && Object.entries(query).every(([name, value]) =>
      (url.searchParams.get(name) ?? (name === 'offset' ? '0' : '')) === value);
  }, { timeout: 0 });
}
async function received<T>(response: Promise<BrowserResponse>) {
  const result = await response; assert.equal(result.status(), 200); assert(result.headers()['x-theoremos-owner']); return await result.json() as T;
}
async function changeDirectory(page: Page, query: Record<string, string>, action: () => Promise<unknown>) {
  const response = responseFor(page, '/api/research/library/installed', query);
  await action(); const value = await received<InstalledLibraryDirectory>(response); await settled(page); return value;
}
async function screenshot(page: Page, check: typeof checks[number], name: string, target?: Locator) {
  await healthy(page);
  if (target) await target.scrollIntoViewIfNeeded({ timeout: 0 }); else await page.evaluate(() => scrollTo(0, 0));
  await settled(page);
  const filename = `${check.scenario}-${name}.png`;
  await page.screenshot({ path: path.join(output, filename), animations: 'disabled', timeout: 0 }); check.screenshots.push(filename);
}
const sourceRequests = () => requests.filter(request => request.scenario === scenarioName && request.pathname === '/api/research/library/installed/module'
  && new URLSearchParams(request.search).get('view') === 'source');
async function expandModuleTools(target: Locator) {
  const tools = target.locator('details.research-installed-module-tools');
  if (await tools.count() && !await tools.evaluate(element => (element as HTMLDetailsElement).open)) await tools.locator('summary').click({ timeout: 0 });
}
async function copyImport(page: Page, target: Locator, name: string, value: string, en: boolean) {
  await expandModuleTools(target);
  const moduleImport = target.locator('details.research-installed-module-import');
  if (await moduleImport.count() && !await moduleImport.evaluate(element => (element as HTMLDetailsElement).open)) await moduleImport.locator('summary').click({ timeout: 0 });
  const button = target.getByRole('button', { name: en ? `Copy import: ${name}` : `复制导入语句：${name}`, exact: true });
  await button.focus(); assert(await button.evaluate(element => element === document.activeElement), 'copy import receives keyboard focus');
  await page.keyboard.press('Enter');
  await visible(page.getByText(en ? 'Import copied.' : '导入语句已复制。', { exact: true }));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), value, 'keyboard copy writes the exact real import statement to Chromium clipboard');
}
async function firstConclusion(page: Page, check: typeof checks[number]) {
  await page.evaluate(() => scrollTo(0, 0)); await settled(page);
  const geometry = await detail(page).locator('[data-installed-library-conclusion]').first().evaluate(element => {
    const box = element.getBoundingClientRect(), label = element.closest('dd')!.previousElementSibling!;
    const labelText = document.createRange(); labelText.selectNodeContents(label);
    return { top: box.top, bottom: box.bottom, viewport: innerHeight,
      labelRight: labelText.getBoundingClientRect().right, valueLeft: box.left };
  });
  assert(geometry.top >= 0 && geometry.bottom <= geometry.viewport, `the first mathematical conclusion is visible when a phone opens a module: ${JSON.stringify(geometry)}`);
  assert(geometry.valueLeft - geometry.labelRight >= 4, `the conclusion label stays separate from its expression: ${JSON.stringify(geometry)}`);
  assert.equal(await detail(page).locator('details.research-installed-module-import').evaluate(element => (element as HTMLDetailsElement).open), false);
  await screenshot(page, check, 'module-entry');
  check.assertions.push('A phone module entry shows its first mathematical conclusion before scrolling; module import remains folded and available.');
}
async function definitionProjection(page: Page, check: typeof checks[number], digest: string, en: boolean) {
  const previous = page.url(), file = 'Submission/Library/TheoremOS/Analysis/AsymptoticModuli.lean';
  const loaded = responseFor(page, '/api/research/library/installed/module', { file, catalogDigest: digest });
  await page.goto(`${origin}/library.html?${new URLSearchParams({ source: 'installed', module: file, catalogDigest: digest, interfaceKind: 'definition' })}`, { waitUntil: 'domcontentloaded', timeout: 0 });
  const metadata = (await received<{ item: InstalledLibraryDetail }>(loaded)).item;
  const entries = metadata.module.entries.filter(entry => entry.kind === 'definition'); assert.equal(entries.length, 8);
  await visible(detail(page).locator('[data-installed-library-declaration]').first());
  assert.equal(await detail(page).locator('[data-installed-library-declaration]').count(), entries.length);
  for (const entry of entries) {
    const definition = metadata.definitions[entry.name], article = detail(page).locator(`[data-installed-library-declaration="${entry.name}"]`);
    assert(definition.documentation.length > 0 && definition.body.length > 0);
    assert.equal(await article.locator('[data-installed-library-conclusion]').textContent(), definition.body);
    const summary = installedLibraryMathematics(entry, metadata.module.import, definition).summary[en ? 'en' : 'zh'];
    assert.equal((await article.locator('.research-installed-math-summary').innerText()).replace(/\s+/gu, ' ').trim(), summary.replaceAll('`', '').replace(/\s+/gu, ' ').trim(), 'the original documentation supplies the uncurated mathematical description');
    assert.equal(await article.locator('details.research-installed-definition-source').evaluate(element => (element as HTMLDetailsElement).open), false);
  }
  const name = 'TheoremOS.Analysis.IsCofinite', article = detail(page).locator(`[data-installed-library-declaration="${name}"]`);
  assert.equal(await article.locator('[data-installed-library-conclusion]').textContent(), 'IsClosed (F : Set X) ∧ FiniteDimensional ℝ (X ⧸ F)');
  assert((await article.innerText()).includes('NormedSpace ℝ X'), 'module input structures are visible alongside declaration inputs');
  const before = requests.length, source = article.locator('details.research-installed-definition-source');
  await source.locator('summary').click({ timeout: 0 });
  assert.equal(await article.locator('[data-installed-definition-source]').textContent(), [...metadata.definitions[name].context, metadata.definitions[name].source].join('\n\n'));
  assert.equal(requests.length, before, 'opening one exact definition snippet makes no full-module source request');
  await screenshot(page, check, 'definition-source', article);
  await source.locator('summary').click({ timeout: 0 });
  const search = detail(page).getByRole('searchbox', { name: en ? 'Search module interfaces' : '搜索模块接口', exact: true });
  await search.fill('closed linear subspace', { timeout: 0 });
  await page.waitForFunction(name => document.querySelectorAll('[data-installed-library-declaration]').length === 1
    && document.querySelector('[data-installed-library-declaration]')?.getAttribute('data-installed-library-declaration') === name, name, { timeout: 0 });
  await screenshot(page, check, 'definition-mathematics', article);
  assert.equal(requests.length, before, 'the source documentation is searchable locally');
  check.assertions.push('Uncurated definitions display exact pinned bodies and original mathematical documentation, declaration and module parameters; original source folds locally and documentation search needs no request.');
  await page.goto(previous, { waitUntil: 'domcontentloaded', timeout: 0 }); await visible(directory(page));
}
async function copyDeclaration(page: Page, target: Locator, name: string, kind: 'name' | 'link', en: boolean) {
  const label = kind === 'name' ? (en ? `Copy Lean name: ${name}` : `复制 Lean 名称：${name}`)
    : (en ? `Copy declaration permalink: ${name}` : `复制接口固定链接：${name}`);
  const message = kind === 'name' ? (en ? 'Lean name copied.' : 'Lean 名称已复制。')
    : (en ? 'Declaration permalink copied.' : '接口固定链接已复制。');
  const button = target.getByRole('button', { name: label, exact: true });
  await button.focus(); assert(await button.evaluate(element => element === document.activeElement), `copy declaration ${kind} receives keyboard focus`);
  await page.keyboard.press('Enter'); await visible(target.getByText(message, { exact: true }));
  return await page.evaluate(() => navigator.clipboard.readText());
}
async function declarationAtAnchor(page: Page, name: string) {
  await visible(detail(page).locator('[data-installed-library-declaration]').filter({ has: page.getByRole('heading', { level: 3, name, exact: true }) }));
  await settled(page);
  const position = await page.locator(`[id="declaration-${name}"] h3`).evaluate(element => {
    const bounds = element.getBoundingClientRect(), hit = document.elementFromPoint(bounds.left + Math.min(30, bounds.width / 2), bounds.top + bounds.height / 2);
    return { top: bounds.top, bottom: bounds.bottom, viewport: innerHeight, unobscured: Boolean(hit && element.contains(hit)) };
  });
  assert(position.top >= 0 && position.bottom <= position.viewport, `declaration heading is visible at its anchor: ${JSON.stringify(position)}`);
  assert(position.unobscured, `the topbar and sticky search do not cover the declaration: ${JSON.stringify(position)}`);
}
async function stickyInterfaceSearch(page: Page) {
  await detail(page).locator('[data-installed-library-declaration]').last().evaluate(element => element.scrollIntoView({ block: 'end' }));
  await settled(page);
  const geometry = await detail(page).locator('[data-installed-interface-toolbar]').evaluate(element => {
    const bounds = element.getBoundingClientRect(), header = document.querySelector('.research-page .topbar')!.getBoundingClientRect();
    const input = element.querySelector('input')!, search = input.getBoundingClientRect();
    const hit = document.elementFromPoint(search.left + search.width / 2, search.top + search.height / 2);
    return { top: bounds.top, bottom: bounds.bottom, headerBottom: header.bottom, viewport: innerHeight, searchReceivesPointer: hit === input };
  });
  assert(geometry.top >= geometry.headerBottom && geometry.bottom <= geometry.viewport && geometry.searchReceivesPointer,
    `search remains visible and usable while reading the last interface: ${JSON.stringify(geometry)}`);
}

async function fieldPicker(page: Page, check: typeof checks[number], initial: InstalledLibraryDirectory, en: boolean, mobile: boolean) {
  phase = `${check.scenario}: every catalog field is directly selectable`;
  const select = directory(page).locator('[data-installed-field-select]'), group = directory(page).locator('.research-installed-areas');
  const options = await select.locator('option').evaluateAll(elements => elements.map(element => ({ value: (element as HTMLOptionElement).value, text: element.textContent ?? '' })));
  assert.deepEqual(options.map(option => option.value), ['', ...initial.areas], 'native selector includes every real catalog field in catalog order');
  assert.equal(options[0].text, en ? 'All fields' : '全部领域');
  const labels: Record<string, [string, string]> = {
    Algebra: ['代数', 'Algebra'], Analysis: ['分析', 'Analysis'], BooleanCube: ['布尔立方体', 'Boolean cube'], Combinatorics: ['组合数学', 'Combinatorics'],
    Geometry: ['几何', 'Geometry'], InformationTheory: ['信息论', 'Information theory'], LinearAlgebra: ['线性代数', 'Linear algebra'],
    NumberTheory: ['数论', 'Number theory'], Probability: ['概率', 'Probability'], RepresentationTheory: ['表示论', 'Representation theory'],
  };
  for (const option of options.slice(1)) assert.equal(option.text, labels[option.value]?.[en ? 1 : 0] ?? option.value,
    'field names are concise Chinese or spaced English while option values retain the catalog identifier');
  const tabs = await page.locator('.research-library-type-tabs').boundingBox(), collections = await page.locator('.research-library-collections').boundingBox();
  const controls = await page.locator('.research-library-controls').boundingBox();
  assert(tabs && collections && controls);
  assert(collections.y >= tabs.y + tabs.height + 8, 'collection filters occupy a separate row below the primary tabs');
  assert(Math.abs(tabs.width - controls.width) <= 1, 'the primary tab bar spans the full navigation width');
  assert.equal(await select.inputValue(), '');
  assert.equal(await select.isVisible(), mobile, 'native selector is visible on phone widths');
  assert.equal(await group.isVisible(), !mobile, 'desktop field buttons are hidden on phone widths');
  assert.equal(await group.locator('button').count(), initial.areas.length + 1);
  check.fieldOptions = options.map(option => option.value);
  check.assertions.push('Primary tabs and secondary collections occupy separate rows; concise Chinese/spaced English labels preserve catalog option values, with native phone selection and desktop field buttons.');
  if (!mobile) return;
  assert.equal(await directory(page).getByRole('combobox', { name: en ? 'Fields of mathematics' : '数学领域', exact: true }).count(), 1);
  const last = initial.areas.at(-1)!; assert(last);
  await select.focus(); assert(await select.evaluate(element => element === document.activeElement));
  const filtered = await changeDirectory(page, { q: '', area: last, environment: '', offset: '0' }, () => select.selectOption(last, { timeout: 0 }));
  assert(filtered.total > 0 && filtered.items.length > 0 && filtered.items.every(module => module.area === last), 'the last native option filters actual catalog modules');
  await visible(openModule(page, filtered.items[0].name));
  assert.equal(await select.inputValue(), last); assert.equal(await select.locator('option:checked').textContent(), options.at(-1)!.text);
  urlFilters(page, { collection: 'lean', area: last }, ['offset']);
  await screenshot(page, check, 'last-field');
  const title = await cards(page).first().locator('.research-installed-title').boundingBox();
  assert(title && title.y >= 0 && title.y + title.height <= page.viewportSize()!.height, 'the first real filtered module title remains fully visible on the first screen');
  const restored = await changeDirectory(page, { q: '', area: '', environment: '', offset: '0' }, () => select.selectOption('', { timeout: 0 }));
  await visible(openModule(page, initial.items[0].name));
  assert.equal(restored.total, initial.total); assert.deepEqual(restored.items.map(module => module.file), initial.items.map(module => module.file));
  assert.equal(await select.inputValue(), ''); assert.equal(await select.locator('option:checked').textContent(), en ? 'All fields' : '全部领域');
  urlFilters(page, { collection: 'lean' }, ['area', 'offset']);
  await screenshot(page, check, 'all-fields-restored');
  check.assertions.push('On phones, keyboard focus reaches the native selector; selecting the last catalog field shows its selected label and real matching modules, then choosing All fields restores the original page without horizontal scrolling.');
}

async function mathematicalAliasesAndReset(page: Page, check: typeof checks[number], initial: InstalledLibraryDirectory, en: boolean) {
  const returnUrl = page.url(), workbenchChat = crypto.randomUUID();
  const scope = { type: 'mathematics', collection: 'lean', mine: '1', workbenchChat };
  const scopeUrl = `${origin}/library.html?${new URLSearchParams(scope)}`;
  const opening = responseFor(page, '/api/research/library/installed', { q: '', area: '', environment: '', offset: '0' });
  await page.goto(scopeUrl, { waitUntil: 'domcontentloaded', timeout: 0 }); await received<InstalledLibraryDirectory>(opening);
  await visible(cards(page).first());
  const searchBox = (zh: string, english: string) => page.getByRole('searchbox', { name: en ? english : zh, exact: true });
  const search = searchBox('Lean 名称或数学主题', 'Lean name or math topic');
  for (const alias of [
    { query: en ? 'independent tail bounds' : '尾概率 独立', module: 'TheoremOS.Probability.Concentration', screenshot: 'tail-probability' },
    { query: en ? 'sums of recurrences' : '求递推数列的和', module: 'TheoremOS.Algebra.FiniteSums', screenshot: 'recurrence-sums' },
    { query: en ? 'recurrence sums' : '递推数列求和', module: 'TheoremOS.Algebra.FiniteSums', screenshot: 'recurrence-word-order' },
  ]) {
    phase = `${check.scenario}: mathematical alias ${alias.query}`;
    const matches = await changeDirectory(page, { q: alias.query, area: '', environment: '', offset: '0' }, async () => {
      await search.fill(alias.query, { timeout: 0 }); await search.press('Enter', { timeout: 0 });
    });
    const module = matches.items.find(item => item.name === alias.module); assert(module, `${alias.query} returns the real ${alias.module} module`);
    assert.equal(matches.library.catalogDigest, initial.library.catalogDigest); assert(module.preview.length > 0);
    const card = directory(page).locator(`[data-installed-library-module="${module.file}"]`);
    await visible(openModule(page, module.name));
    const labels = installedLibraryLabels(module.name); assert(labels);
    assert.equal(await card.locator('.research-installed-title>a>span').innerText(), en ? labels.en.title : labels.zh.title);
    assert.equal(await card.locator('details.research-installed-module-tools').evaluate(element => (element as HTMLDetailsElement).open), false, 'imports and real interface previews are folded by default');
    await expandModuleTools(card);
    assert.equal(await card.locator('.research-installed-preview-label').innerText(), en ? 'Interface preview' : '接口预览');
    const preview = card.locator('.research-installed-preview>div');
    assert.equal(await preview.count(), Math.min(2, module.preview.length));
    for (const [index, entry] of module.preview.slice(0, 2).entries()) {
      const shown = preview.nth(index);
      assert.equal(await shown.locator('a').textContent(), entry.name); assert.equal(await shown.locator('pre').textContent(), entry.type);
      assert.equal(new URL((await shown.locator('a').getAttribute('href'))!, page.url()).hash, `#declaration-${encodeURIComponent(entry.name)}`);
    }
    const href = new URL((await openModule(page, module.name).getAttribute('href'))!, page.url());
    assert.equal(href.hash, '', 'module alias search opens the module overview without a declaration hash');
    assert.equal(href.searchParams.get('module'), module.file); assert.equal(href.searchParams.get('catalogDigest'), initial.library.catalogDigest);
    assert.equal(href.searchParams.get('workbenchChat'), workbenchChat);
    await screenshot(page, check, alias.screenshot);
    const loaded = responseFor(page, '/api/research/library/installed/module', { file: module.file, catalogDigest: initial.library.catalogDigest });
    await openModule(page, module.name).click({ timeout: 0 });
    const metadata = (await received<{ item: InstalledLibraryDetail }>(loaded)).item;
    await visible(detail(page).locator('.research-installed-detail-heading h2'));
    assert.equal(new URL(page.url()).hash, ''); assert.equal(metadata.module.name, alias.module);
    assert.equal(await detail(page).locator('.research-installed-detail-heading h2').innerText(), en ? labels.en.title : labels.zh.title);
    for (const link of await page.locator('.research-library-type-tabs>a').all()) {
      assert.equal(new URL((await link.getAttribute('href'))!, page.url()).searchParams.get('workbenchChat'), workbenchChat, 'every type-switch link retains the originating workbench chat');
    }
    for (const entry of module.preview) assert.deepEqual(metadata.module.entries.find(item => item.name === entry.name), entry, 'alias previews come from the pinned real module interfaces');
    urlFilters(page, { ...scope, q: alias.query, source: 'installed', module: module.file, catalogDigest: initial.library.catalogDigest });
    const returning = responseFor(page, '/api/research/library/installed', { q: alias.query, area: '', environment: '', offset: '0' });
    await page.locator('.research-breadcrumb a').click({ timeout: 0 }); await received<InstalledLibraryDirectory>(returning);
    await visible(openModule(page, module.name));
    urlFilters(page, { ...scope, q: alias.query }, ['source', 'module', 'catalogDigest']);
    assert.equal(new URL(page.url()).hash, `#${encodeURIComponent(`installed-module-${module.file}`)}`, 'returning to the directory locates the originating module');
  }
  check.assertions.push('Chinese segmentation, synonyms and reordered English/Chinese recurrence/tail topics find Concentration/FiniteSums with folded real previews; pinned overviews and type links retain workbenchChat, and directory return locates the originating module.');

  phase = `${check.scenario}: each Library category remembers its own filters`;
  const rememberedQuery = en ? 'recurrence sums' : '递推数列求和';
  const countBeforeRepeat = requests.length;
  await page.locator('.research-library-type-tabs button').first().click({ timeout: 0 });
  await page.locator('[data-library-collection="lean"]').click({ timeout: 0 }); await settled(page);
  assert.equal(await search.inputValue(), rememberedQuery); urlFilters(page, { ...scope, q: rememberedQuery });
  assert.equal(requests.length, countBeforeRepeat, 're-clicking current type and collection preserves filters without another directory request');
  const agentQuery = 'remember-agent-query', skillQuery = 'remember-skill-query', sharedQuery = 'remember-shared-query';
  const agentSearch = searchBox('搜索 Agent', 'Search Agents'), skillSearch = searchBox('搜索 Skill', 'Search Skills'),
    sharedSearch = searchBox('搜索共享数学库', 'Search shared libraries');
  const assetChange = async (type: string, q: string, action: () => Promise<unknown>) => {
    const loaded = responseFor(page, '/api/research/library', { type, q });
    await action(); await received<{ items: ResearchAsset[] }>(loaded); await settled(page);
  };
  await assetChange('agent', '', () => page.locator('.research-library-type-tabs button').nth(1).click({ timeout: 0 }));
  await assetChange('agent', agentQuery, async () => { await agentSearch.fill(agentQuery, { timeout: 0 }); await agentSearch.press('Enter', { timeout: 0 }); });
  await page.locator('.research-library-type-tabs button').nth(1).click({ timeout: 0 }); await settled(page);
  assert.equal(await agentSearch.inputValue(), agentQuery, 're-clicking Agent preserves its query');
  await assetChange('skill', '', () => page.locator('.research-library-type-tabs button').nth(2).click({ timeout: 0 }));
  await assetChange('skill', skillQuery, async () => { await skillSearch.fill(skillQuery, { timeout: 0 }); await skillSearch.press('Enter', { timeout: 0 }); });
  await assetChange('agent', agentQuery, () => page.locator('.research-library-type-tabs button').nth(1).click({ timeout: 0 }));
  assert.equal(await agentSearch.inputValue(), agentQuery);
  await changeDirectory(page, { q: rememberedQuery }, () => page.locator('.research-library-type-tabs button').first().click({ timeout: 0 }));
  assert.equal(await search.inputValue(), rememberedQuery); urlFilters(page, { ...scope, q: rememberedQuery });
  await assetChange('mathematics', '', () => page.locator('[data-library-collection="shared"]').click({ timeout: 0 }));
  await assetChange('mathematics', sharedQuery, async () => { await sharedSearch.fill(sharedQuery, { timeout: 0 }); await sharedSearch.press('Enter', { timeout: 0 }); });
  await changeDirectory(page, { q: rememberedQuery }, () => page.locator('[data-library-collection="lean"]').click({ timeout: 0 }));
  await assetChange('mathematics', sharedQuery, () => page.locator('[data-library-collection="shared"]').click({ timeout: 0 }));
  assert.equal(await sharedSearch.inputValue(), sharedQuery, 'shared mathematics remembers its own query');
  await changeDirectory(page, { q: rememberedQuery }, () => page.locator('[data-library-collection="lean"]').click({ timeout: 0 }));
  await assetChange('skill', skillQuery, () => page.locator('.research-library-type-tabs button').nth(2).click({ timeout: 0 }));
  assert.equal(await skillSearch.inputValue(), skillQuery);
  await changeDirectory(page, { q: rememberedQuery }, () => page.locator('.research-library-type-tabs button').first().click({ timeout: 0 }));
  urlFilters(page, { ...scope, q: rememberedQuery });
  check.assertions.push('Repeated active tabs preserve filters; Lean, shared mathematics, Agent and Skill restore their own queries when switching categories, while workbenchChat remains attached.');

  phase = `${check.scenario}: keyboard clear restores an empty filtered catalog`;
  const filters = { q: 'NoSuchInstalledModuleForFilterRecovery', area: initial.areas.at(-1)!, author: 'no-such-library-author', environment: 'standard', offset: String(initial.limit) };
  const emptyLoaded = responseFor(page, '/api/research/library/installed', { q: filters.q, area: filters.area, environment: filters.environment, offset: filters.offset });
  // Author belongs to the library URL, while the installed public catalog is filtered only by mathematics, environment and page.
  await page.goto(`${scopeUrl}&${new URLSearchParams(filters)}`, { waitUntil: 'domcontentloaded', timeout: 0 });
  const empty = await received<InstalledLibraryDirectory>(emptyLoaded);
  assert.equal(empty.total, 0); assert.equal(empty.items.length, 0); assert.equal(empty.offset, initial.limit);
  const clear = directory(page).locator('[data-installed-reset]');
  await visible(clear); assert.equal(await cards(page).count(), 0);
  assert.equal(await directory(page).locator('.research-installed-pagination').count(), 0, 'empty results do not show a stale pagination offset');
  assert.equal(await search.inputValue(), filters.q);
  assert.equal(await directory(page).locator('[data-installed-field-select]').inputValue(), filters.area);
  const area = page.getByRole('textbox', { name: en ? 'Research field' : '研究领域', exact: true, includeHidden: true });
  const environment = page.getByRole('combobox', { name: new RegExp(en ? 'Filter by proof environment' : '按证明环境筛选', 'u'), includeHidden: true });
  assert.equal(await area.inputValue(), filters.area); assert.equal(await environment.inputValue(), filters.environment);
  urlFilters(page, { ...scope, ...filters });
  await visible(directory(page).getByText(en ? 'Try a related mathematical topic:' : '试试相关数学主题：', { exact: true }));
  await screenshot(page, check, 'directory-empty');
  const suggestion = directory(page).locator('[data-installed-library-query]').first();
  const suggestionQuery = (await suggestion.getAttribute('data-installed-library-query'))!;
  const suggested = await changeDirectory(page, { q: suggestionQuery, area: '', environment: '', offset: '0' }, () => suggestion.click({ timeout: 0 }));
  assert(suggested.total > 0); assert.equal(await search.inputValue(), suggestionQuery);
  urlFilters(page, { ...scope, q: suggestionQuery }, ['area', 'author', 'environment', 'offset']);
  const emptyAgain = responseFor(page, '/api/research/library/installed', { q: filters.q, area: filters.area, environment: filters.environment, offset: filters.offset });
  await page.goto(`${scopeUrl}&${new URLSearchParams(filters)}`, { waitUntil: 'domcontentloaded', timeout: 0 }); await received<InstalledLibraryDirectory>(emptyAgain);
  await visible(clear);
  await clear.focus(); assert(await clear.evaluate(element => element === document.activeElement));
  const restored = await changeDirectory(page, { q: '', area: '', environment: '', offset: '0' }, () => page.keyboard.press('Enter'));
  await visible(openModule(page, initial.items[0].name));
  assert.equal(restored.total, initial.total); assert.equal(restored.offset, 0);
  assert.deepEqual(restored.items.map(module => module.file), initial.items.map(module => module.file));
  assert.equal(await search.inputValue(), ''); assert.equal(await area.inputValue(), ''); assert.equal(await environment.inputValue(), '');
  assert.equal(await directory(page).locator('[data-installed-field-select]').inputValue(), '');
  await page.waitForFunction(() => document.querySelector('.research-library-searchbar input[type="search"]') === document.activeElement, undefined, { timeout: 0 });
  urlFilters(page, scope, ['q', 'area', 'author', 'environment', 'offset']);
  assert.equal(await clear.count(), 0, 'clear action disappears once all filters are empty');
  await screenshot(page, check, 'directory-reset');
  check.assertions.push('Empty results provide clickable related queries that clear incompatible filters and return real modules; keyboard Clear filters restores the first page and search focus, preserving mine/workbenchChat.');
  assert.equal(sourceRequests().length, 0, 'search, previews, overviews and clear filters never request full source');
  const returned = responseFor(page, '/api/research/library/installed', { q: '', area: '', environment: '', offset: '0' });
  await page.goto(returnUrl, { waitUntil: 'domcontentloaded', timeout: 0 }); await received<InstalledLibraryDirectory>(returned);
  await visible(cards(page).first());
}

async function mathematicalInterfaceMatches(page: Page, check: typeof checks[number], digest: string, en: boolean) {
  const returnUrl = page.url(), moduleName = 'TheoremOS.Probability.Concentration';
  for (const [index, q] of [en ? 'nonnegative weights' : '非负权重', en ? 'finite type with an enumeration' : '有限类型及其枚举'].entries()) {
    phase = `${check.scenario}: whole-library mathematical interface search ${q}`;
    const scope = index === 0 ? { workbenchChat: crypto.randomUUID() } : { workbenchEdit: 'local-library-search-edit' };
    const filters = { type: 'mathematics', collection: 'lean', area: 'Probability', q, ...scope };
    const loaded = responseFor(page, '/api/research/library/installed', { q, area: 'Probability' });
    await page.goto(`${origin}/library.html?${new URLSearchParams(filters)}`, { waitUntil: 'domcontentloaded', timeout: 0 });
    const result = await received<InstalledLibraryDirectory>(loaded);
    assert.equal(result.library.catalogDigest, digest);
    const module = result.items.find(item => item.name === moduleName); assert(module && module.matchingInterfaces.length > 0);
    const card = directory(page).locator(`[data-installed-library-module="${module.file}"]`);
    const match = module.matchingInterfaces[0], link = card.locator(`[data-installed-library-match="${match.name}"]`);
    await visible(link);
    const summary = link.locator('..').locator('.solution-route-prose');
    await visible(summary);
    const visibleSummary = (await summary.innerText()).replace(/\s+/gu, '');
    for (const segment of proseSegments(match.summary[en ? 'en' : 'zh'])) {
      if (segment.kind === 'math' || segment.kind === 'display') {
        const rendered = summary.locator(`.math[title=${JSON.stringify(segment.text)}][data-math-state="ready"]`);
        await visible(rendered);
      } else assert(visibleSummary.includes(segment.text.replace(/\s+/gu, '')),
        `the matching summary text is visible without expanding import tools: ${segment.text}`);
    }
    assert.equal(await card.locator('details.research-installed-module-tools').evaluate(element => (element as HTMLDetailsElement).open), false);
    const target = new URL(await link.getAttribute('href') ?? '', page.url());
    assert.equal(target.hash, `#declaration-${encodeURIComponent(match.name)}`);
    assert.equal(target.searchParams.get('catalogDigest'), digest); assert.equal(target.searchParams.get('interfaceQuery'), q);
    await screenshot(page, check, `interface-matches-${index}`, card.locator('[data-installed-library-matches]'));
    const opened = responseFor(page, '/api/research/library/installed/module', { file: module.file, catalogDigest: digest });
    await link.click({ timeout: 0 });
    const metadata = (await received<{ item: InstalledLibraryDetail }>(opened)).item;
    const article = detail(page).locator(`[data-installed-library-declaration="${match.name}"]`);
    await visible(article);
    urlFilters(page, { ...filters, interfaceQuery: q, source: 'installed', module: module.file, catalogDigest: digest });
    assert.equal(new URL(page.url()).hash, target.hash);
    const local = metadata.module.entries.filter(entry => matchesInstalledLibraryInterface(entry, metadata.module.import, q,
      metadata.definitions[entry.name], metadata.contexts[entry.name]));
    assert.equal(module.matchingInterfaceCount, local.length, 'directory and module searches use the same displayed mathematics and conditions');
    assert.equal(await detail(page).locator('[data-installed-library-declaration]').count(), local.length);
    if (index === 1) assert((await article.locator('[data-installed-library-scope]').innerText()).includes('Fintype'), 'the matching scope condition remains readable at the destination');
    const returned = responseFor(page, '/api/research/library/installed', { q, area: 'Probability' });
    await page.locator('.research-breadcrumb a').click({ timeout: 0 });
    await received<InstalledLibraryDirectory>(returned); await visible(directory(page));
    urlFilters(page, filters, ['source', 'module', 'catalogDigest', 'interfaceQuery']);
    assert.equal(await page.locator('.research-library-searchbar input[type="search"]').inputValue(), q);
    await visible(directory(page).locator(`[data-installed-library-match="${match.name}"]`));
  }
  assert.equal(sourceRequests().length, 0, 'mathematical directory matching and direct links never fetch a full source view');
  check.assertions.push('Whole-library Chinese/English mathematical meanings and finite-type scope conditions expose matching interface summaries directly; their pinned links filter and jump to the same declarations, and directory return keeps the query and chat/edit identity.');
  const restored = responseFor(page, '/api/research/library/installed');
  await page.goto(returnUrl, { waitUntil: 'domcontentloaded', timeout: 0 }); await received<InstalledLibraryDirectory>(restored);
  await visible(cards(page).first());
}

try {
  for (const scenario of [{ name: 'zh-1440', locale: 'zh', width: 1440, height: 1000, narrow: false },
    { name: 'en-1440', locale: 'en', width: 1440, height: 1000, narrow: false },
    { name: 'zh-390', locale: 'zh', width: 390, height: 844, narrow: false }, { name: 'en-390', locale: 'en', width: 390, height: 844, narrow: false },
    { name: 'zh-320', locale: 'zh', width: 320, height: 844, narrow: true }, { name: 'en-320', locale: 'en', width: 320, height: 844, narrow: true }]) {
    scenarioName = scenario.name;
    const en = scenario.locale === 'en', text = (zh: string, english: string) => en ? english : zh;
    const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, locale: en ? 'en-US' : 'zh-CN',
      // Each viewport is an independent visitor; keep the real per-visitor request limit enabled.
      extraHTTPHeaders: { 'x-test-visitor': scenario.name },
      reducedMotion: 'reduce', serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
    context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
    await context.addInitScript(locale => localStorage.setItem('theorem-os.web-locale.v1', locale), scenario.locale);
    await context.route(/^https?:\/\//u, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(request.url()); await route.abort(); return; }
      if (url.pathname.startsWith('/api/') && request.method() !== 'GET') { writes.push(`${request.method()} ${url.pathname}`); await route.abort(); return; }
      await route.continue();
    });
    const page = await context.newPage(); active = page;
    page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0);
    page.on('pageerror', error => errors.push(`${scenario.name}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`${scenario.name}: ${message.text()}`); });
    page.on('request', request => { const url = new URL(request.url());
      if (url.pathname === '/classics/data/index.json') problemIndexRequests.push(url.pathname);
      if (url.pathname.startsWith('/api/')) requests.push({ scenario: scenario.name, method: request.method(), pathname: url.pathname, search: url.search }); });
    const check: typeof checks[number] = { scenario: scenario.name, assertions: [], screenshots: [] };

    phase = `${scenario.name}: real installed release remains visible without published assets`;
    const loaded = responseFor(page, '/api/research/library/installed');
    await page.goto(`${origin}/library.html`, { waitUntil: 'domcontentloaded', timeout: 0 });
    const initial = await received<InstalledLibraryDirectory>(loaded);
    assert.equal(initial.library.moduleCount, 53); assert.equal(initial.library.declarationCount, 1964); assert.equal(initial.total, 53);
    assert.match(initial.library.catalogDigest, /^[a-f0-9]{64}$/u); assert.equal(initial.library.environment, 'mathlib');
    check.catalogDigest = initial.library.catalogDigest; check.moduleCount = initial.library.moduleCount; check.declarationCount = initial.library.declarationCount;
    await visible(directory(page)); await visible(cards(page).first()); await settled(page);
    urlFilters(page, { collection: 'lean' });
    assert.equal(await page.locator('[data-openai-problems-directory],[data-library-collection="openai"]').count(), 0, 'Library contains reusable mathematical libraries and no solved-problem collection');
    await visible(page.getByRole('heading', { level: 1, name: text('数学库', 'Library'), exact: true }));
    await visible(page.getByRole('heading', { name: text('现有 Lean 库', 'Existing Lean library'), exact: true }));
    const published = await get<{ items: ResearchAsset[] }>(page, '/api/research/library?type=mathematics');
    assert.deepEqual(published.items, []); assert.equal(await cards(page).count(), initial.items.length);
    const installedText = await directory(page).innerText();
    assert(installedText.includes('53') && installedText.includes('1964'), 'directory shows installed release size');
    assert((await cards(page).first().textContent())?.includes(initial.items[0].name), 'the exact module identity remains available inside its folded tools');
    assert.deepEqual(await cards(page).locator('details.research-installed-module-tools').evaluateAll(elements => elements.map(element => (element as HTMLDetailsElement).open)), initial.items.map(() => false), 'directory defaults to compact title, purpose, field and count rows');
    assert.equal(sourceRequests().length, 0, 'directory does not eagerly load module source');
    check.firstModuleCard = await cards(page).first().evaluate(element => ({ top: Math.round(element.getBoundingClientRect().top),
      viewportHeight: innerHeight, visibleOnEntry: element.getBoundingClientRect().top < innerHeight }));
    check.firstModuleTitle = await cards(page).first().locator('.research-installed-title').evaluate(element => ({ top: Math.round(element.getBoundingClientRect().top),
      bottom: Math.round(element.getBoundingClientRect().bottom), viewportHeight: innerHeight,
      visibleOnEntry: element.getBoundingClientRect().top >= 0 && element.getBoundingClientRect().bottom <= innerHeight }));
    console.log(`LAYOUT ${scenario.name}: first module card=${check.firstModuleCard.top}, title=${check.firstModuleTitle.top}, viewport=${check.firstModuleTitle.viewportHeight}`);
    await screenshot(page, check, 'directory');
    assert(check.firstModuleTitle.visibleOnEntry, `${phase}: first real module title is fully visible on initial entry (${JSON.stringify(check.firstModuleTitle)})`);
    assert(await cards(page).first().locator('.research-installed-title').evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && parseFloat(getComputedStyle(element).fontSize) >= 16 && element.scrollWidth <= element.clientWidth;
    }), `${scenario.name}: the first module heading remains readable within the viewport width`);
    await fieldPicker(page, check, initial, en, scenario.width <= 740);
    await copyImport(page, cards(page).first(), initial.items[0].name, initial.items[0].import, en);
    check.assertions.push('Directory copying uses the real module import through the keyboard and Chromium clipboard.');
    await definitionProjection(page, check, initial.library.catalogDigest, en);
    if (scenario.narrow) {
      const narrowModule = initial.items[0], moduleLoaded = responseFor(page, '/api/research/library/installed/module', { file: narrowModule.file, catalogDigest: initial.library.catalogDigest });
      await openModule(page, narrowModule.name).click({ timeout: 0 });
      await received<{ item: InstalledLibraryDetail }>(moduleLoaded); await visible(detail(page).locator('[data-installed-library-declaration]').first());
      await firstConclusion(page, check);
      await stickyInterfaceSearch(page);
      await screenshot(page, check, 'interface-navigation', detail(page).locator('[data-installed-interface-toolbar]'));
      await healthy(page); check.assertions.push('At 320px the real first module title is readable, and the module search remains usable at the end of the interface list without horizontal page overflow.');
      checks.push(check); console.log(`PASS ${scenario.name}: narrow installed directory and keyboard import copy`);
      await context.close(); active = undefined; continue;
    }
    const mineLoaded = responseFor(page, '/api/research/library', { type: 'mathematics', mine: '1' });
    await page.getByRole('button', { name: text('我的资源', 'My resources'), exact: true }).click({ timeout: 0 });
    assert.deepEqual((await received<{ items: ResearchAsset[] }>(mineLoaded)).items, []);
    urlFilters(page, { collection: 'shared', mine: '1' });
    await visible(page.getByRole('searchbox', { name: text('搜索我的数学库', 'Search my libraries'), exact: true }));
    assert.equal(await directory(page).count(), 0, 'My resources opens the personal shared-asset view');
    await changeDirectory(page, { q: '', area: '', environment: '', offset: '0' }, () => page.locator('[data-library-collection="lean"]').click({ timeout: 0 }));
    await visible(cards(page).first()); urlFilters(page, { collection: 'lean' });
    const ownUrlLoaded = responseFor(page, '/api/research/library/installed');
    await page.goto(`${origin}/library.html?collection=lean&mine=1`, { waitUntil: 'domcontentloaded', timeout: 0 });
    await received<InstalledLibraryDirectory>(ownUrlLoaded); await visible(cards(page).first());
    assert.equal(await cards(page).count(), initial.items.length, 'an explicit personal URL does not hide the public installed release');
    urlFilters(page, { collection: 'lean', mine: '1' });
    check.assertions.push('Real repository release: 53 modules and 1964 declarations remain visible with zero published/personal assets.');
    await mathematicalAliasesAndReset(page, check, initial, en);
    await mathematicalInterfaceMatches(page, check, initial.library.catalogDigest, en);

    phase = `${scenario.name}: search real module and theorem names, filter area and environment`;
    const picked = initial.items.find(module => module.preview.length > 0)!; assert(picked, 'catalog includes interface previews');
    const search = page.getByRole('searchbox', { name: text('Lean 名称或数学主题', 'Lean name or math topic'), exact: true });
    const labels = installedLibraryLabels(picked.name); assert(labels);
    const mathematicalQuery = en ? labels.en.title : labels.zh.title;
    const localizedMatches = await changeDirectory(page, { q: mathematicalQuery }, async () => { await search.fill(mathematicalQuery, { timeout: 0 }); await search.press('Enter', { timeout: 0 }); });
    const localizedModule = localizedMatches.items.find(item => item.file === picked.file); assert(localizedModule);
    const localizedCard = directory(page).locator(`[data-installed-library-module="${picked.file}"]`);
    assert.equal(await localizedCard.locator('.research-installed-title>a>span').innerText(), mathematicalQuery);
    assert.equal(await localizedCard.locator('.research-installed-module-description').innerText(), en ? labels.en.description : labels.zh.description);
    assert((await openModule(page, picked.name).getAttribute('aria-label'))?.includes(mathematicalQuery), 'visible mathematical title is part of the accessible name');
    assert(localizedModule.preview.length > 0, 'mathematical-name matches keep actual interface previews');
    assert.equal(new URL((await openModule(page, picked.name).getAttribute('href'))!, page.url()).hash, '', 'a module-level mathematical match opens its overview');
    await screenshot(page, check, 'mathematical-search');
    const moduleMatches = await changeDirectory(page, { q: picked.name }, async () => { await search.fill(picked.name, { timeout: 0 }); await search.press('Enter', { timeout: 0 }); });
    assert(moduleMatches.items.some(module => module.file === picked.file));
    await visible(openModule(page, picked.name));
    const theoremName = picked.preview[0].name;
    const theoremMatches = await changeDirectory(page, { q: theoremName }, async () => { await search.fill(theoremName, { timeout: 0 }); await search.press('Enter', { timeout: 0 }); });
    assert(theoremMatches.items.some(module => module.file === picked.file && module.preview.some(entry => entry.name === theoremName)));
    assert.equal(new URL((await openModule(page, picked.name).getAttribute('href'))!, page.url()).hash, `#declaration-${encodeURIComponent(theoremName)}`, 'an exact interface search links directly to its actual declaration');
    const area = page.getByRole('textbox', { name: text('研究领域', 'Research field'), exact: true });
    if (!await area.isVisible()) await page.getByText(text('更多筛选', 'More filters'), { exact: true }).click({ timeout: 0 });
    const areaMatches = await changeDirectory(page, { q: theoremName, area: picked.area }, () => area.fill(picked.area, { timeout: 0 }));
    assert(areaMatches.items.length > 0 && areaMatches.items.every(module => module.area === picked.area));
    const environment = page.getByRole('combobox', { name: new RegExp(text('按证明环境筛选', 'Filter by proof environment'), 'u') });
    if (!await environment.isVisible()) await page.getByText(text('更多筛选', 'More filters'), { exact: true }).click({ timeout: 0 });
    const filtered = await changeDirectory(page, { q: theoremName, area: picked.area, environment: 'mathlib' }, () => environment.selectOption('mathlib', { timeout: 0 }));
    assert.equal(filtered.library.catalogDigest, initial.library.catalogDigest); assert(filtered.items.some(module => module.file === picked.file));
    await visible(openModule(page, picked.name));
    const preserved = { type: 'mathematics', collection: 'lean', q: theoremName, area: picked.area, environment: 'mathlib', mine: '1' };
    urlFilters(page, preserved);
    check.assertions.push('Bilingual mathematical module titles/descriptions are searchable and retain true interface previews; exact interface results link directly to their real declaration and preserve release identity.');

    phase = `${scenario.name}: pinned module detail and on-demand full source`;
    const moduleLoaded = responseFor(page, '/api/research/library/installed/module', { file: picked.file, catalogDigest: initial.library.catalogDigest });
    await openModule(page, picked.name).click({ timeout: 0 });
    const metadata = (await received<{ item: InstalledLibraryDetail }>(moduleLoaded)).item;
    await visible(detail(page).locator('.research-installed-detail-heading h2'));
    urlFilters(page, { ...preserved, source: 'installed', module: picked.file, catalogDigest: initial.library.catalogDigest });
    assert.equal(metadata.module.file, picked.file); assert.equal(metadata.library.catalogDigest, initial.library.catalogDigest);
    assert.equal(await detail(page).locator('.research-installed-detail-heading > div > code').textContent(), metadata.module.name);
    assert.equal(await detail(page).locator('.research-installed-detail-heading h2').innerText(), mathematicalQuery);
    if (scenario.width <= 740) {
      const overview = new URL(page.url()); overview.hash = '';
      await page.goto(overview.href, { waitUntil: 'domcontentloaded', timeout: 0 });
      await firstConclusion(page, check);
    }
    await declarationAtAnchor(page, theoremName);
    await detail(page).locator('.research-installed-detail-heading h2').evaluate(element => element.scrollIntoView());
    assert.equal(await detail(page).locator('.research-installed-detail-import pre').textContent(), metadata.module.import);
    assert((await detail(page).textContent())?.includes(theoremName), 'detail includes actual declaration interfaces');
    assert(!(await detail(page).innerText()).includes('Frozen library declaration from '), 'generic provenance boilerplate is not presented as an independent declaration description');
    for (const entry of metadata.module.entries) {
      const article = detail(page).locator(`[data-installed-library-declaration="${entry.name}"]`);
      const mathematics = installedLibraryMathematics(entry, metadata.module.import);
      assert.equal(await article.locator('[data-installed-library-conclusion]').textContent(), mathematics.expression);
      assert.equal(await article.locator('[data-installed-library-usage]').textContent(), mathematics.usage);
      assert.equal(await article.locator('details.research-installed-usage').evaluate(element => (element as HTMLDetailsElement).open), false, 'Lean usage is folded so mathematics stays first');
      assert.equal(await article.locator('details.research-installed-signature').evaluate(element => (element as HTMLDetailsElement).open), false);
      assert.equal(await article.locator('[data-installed-library-signature]').textContent(), entry.type, 'the exact original type is retained behind an optional disclosure');
    }
    check.assertions.push('Every displayed declaration prioritizes mathematics and conditions; exact import/#check usage and the unchanged original Lean type are both opt-in.');
    assert.equal(sourceRequests().length, 0, 'opening module metadata does not fetch full source');
    await screenshot(page, check, 'module');
    await copyImport(page, detail(page), metadata.module.name, metadata.module.import, en);

    phase = `${scenario.name}: module interface search and kind filter stay local`;
    const interfaceSearch = detail(page).getByRole('searchbox', { name: text('搜索模块接口', 'Search module interfaces'), exact: true });
    const interfaceKind = detail(page).getByRole('combobox', { name: text('接口类型', 'Interface type'), exact: true });
    const clearInterfaces = detail(page).getByRole('button', { name: text('清除筛选', 'Clear filters'), exact: true });
    const declarationIds = () => detail(page).locator('.research-installed-declaration').evaluateAll(elements => elements.map(element => element.id.slice('declaration-'.length)));
    const waitDeclarations = async (names: string[]) => {
      await page.waitForFunction(names => JSON.stringify([...document.querySelectorAll('[data-installed-library-detail] .research-installed-declaration')].map(element => element.id.slice('declaration-'.length))) === JSON.stringify(names), names, { timeout: 0 });
      assert.deepEqual(await declarationIds(), names);
    };
    await waitDeclarations(metadata.module.entries.map(entry => entry.name));
    await stickyInterfaceSearch(page);
    await screenshot(page, check, 'interface-navigation', detail(page).locator('[data-installed-interface-toolbar]'));
    const backToSearch = detail(page).getByRole('button', { name: text('返回接口搜索', 'Back to interface search'), exact: true });
    await backToSearch.focus(); await page.keyboard.press('Enter');
    assert(await interfaceSearch.evaluate(element => element === document.activeElement), 'module footer returns keyboard focus to interface search');
    check.assertions.push('Sticky interface search remains visible and receives pointer input at the last declaration; the footer returns keyboard focus to search.');
    assert.equal(await clearInterfaces.count(), 0, 'clear filters is absent when both local filters are empty');
    assert.equal(await interfaceKind.locator('option:checked').textContent(), text('全部接口', 'All'), 'the all-types option fits the mobile selector');
    const localRequests = requests.length, entry = metadata.module.entries.find(entry => entry.name === theoremName)!; assert(entry);
    const telescoping = metadata.module.entries.find(item => item.name.endsWith('.sum_forward_differences'))!; assert(telescoping);
    for (const query of [text('望远镜', 'telescoping'), text('前 n 个相邻差', 'first n successive differences')]) {
      await interfaceSearch.fill(query, { timeout: 0 }); await waitDeclarations([telescoping.name]);
      await page.waitForFunction(value => new URL(location.href).searchParams.get('interfaceQuery') === value, query, { timeout: 0 });
      assert.equal(new URL(page.url()).searchParams.get('interfaceQuery'), query);
    }
    await interfaceSearch.fill(text('加法交换群', 'additive commutative group'), { timeout: 0 });
    await waitDeclarations(metadata.module.entries.filter(item => item.type.includes('[AddCommGroup A]')).map(item => item.name));
    const conditionRows = detail(page).locator(`[data-installed-library-declaration="${telescoping.name}"] .research-installed-math-conditions li`);
    for (const row of await conditionRows.all()) {
      const separated = await row.evaluate(element => {
        const description = element.querySelector('.research-installed-math-condition-description')!.getBoundingClientRect();
        const expression = element.querySelector('.research-installed-math-expression')!.getBoundingClientRect();
        return expression.top >= description.bottom;
      });
      assert(separated, 'each mathematical condition expression starts on a separate line');
    }
    {
      const article = detail(page).locator(`[data-installed-library-declaration="${telescoping.name}"]`);
      const usage = article.locator('details.research-installed-usage');
      await usage.locator('summary').click({ timeout: 0 }); await visible(article.locator('[data-installed-library-usage]'));
      assert.equal(await article.locator('[data-installed-library-usage]').innerText(), installedLibraryMathematics(telescoping, metadata.module.import).usage);
      await usage.locator('summary').click({ timeout: 0 });
      assert.equal(await article.locator('[data-installed-library-usage]').isVisible(), false);
    }
    check.assertions.push('Local interface search finds the displayed bilingual mathematical summaries and conditions without HTTP requests; conditions have separate expression lines and minimal Lean usage expands and folds.');
    await interfaceSearch.fill(entry.name, { timeout: 0 });
    const matchingEntries = metadata.module.entries.filter(item => `${item.name} ${item.type} ${item.description}`.toLocaleLowerCase().includes(entry.name.toLocaleLowerCase()));
    await waitDeclarations(matchingEntries.map(item => item.name));
    await visible(clearInterfaces);
    await interfaceSearch.focus(); await page.keyboard.press('Tab');
    assert(await interfaceKind.evaluate(element => element === document.activeElement), 'Tab reaches the adjacent interface type selector');
    await interfaceKind.selectOption(entry.kind, { timeout: 0 }); await waitDeclarations(matchingEntries.filter(item => item.kind === entry.kind).map(item => item.name));
    const otherKind = entry.kind === 'lemma' ? 'definition' : 'lemma';
    await interfaceKind.selectOption(otherKind, { timeout: 0 }); await waitDeclarations(matchingEntries.filter(item => item.kind === otherKind).map(item => item.name));
    await interfaceKind.selectOption(entry.kind, { timeout: 0 }); await waitDeclarations(matchingEntries.filter(item => item.kind === entry.kind).map(item => item.name));
    await interfaceSearch.fill('NoSuchInstalledDeclaration', { timeout: 0 }); await waitDeclarations([]);
    await screenshot(page, check, 'interfaces-empty', detail(page).locator('.research-installed-declarations').locator('..'));
    await interfaceKind.focus(); await page.keyboard.press('Tab');
    assert(await clearInterfaces.evaluate(element => element === document.activeElement), 'Tab reaches clear filters after the type selector');
    await page.keyboard.press('Enter'); await waitDeclarations(metadata.module.entries.map(item => item.name));
    assert.equal(await interfaceSearch.inputValue(), ''); assert.equal(await interfaceKind.inputValue(), '');
    assert(await interfaceSearch.evaluate(element => element === document.activeElement), 'clearing both filters returns focus to interface search');
    assert.equal(await clearInterfaces.count(), 0);
    await interfaceKind.selectOption(entry.kind, { timeout: 0 });
    await waitDeclarations(metadata.module.entries.filter(item => item.kind === entry.kind).map(item => item.name));
    await visible(clearInterfaces); await clearInterfaces.focus(); await page.keyboard.press('Enter');
    await waitDeclarations(metadata.module.entries.map(item => item.name));
    assert.equal(await interfaceSearch.inputValue(), ''); assert.equal(await interfaceKind.inputValue(), '');
    assert(await interfaceSearch.evaluate(element => element === document.activeElement), 'clearing a type-only filter returns focus to interface search');
    assert.equal(await clearInterfaces.count(), 0);
    assert.equal(requests.length, localRequests, 'interface search/type/no-match/reset make no HTTP requests');
    assert.equal(sourceRequests().length, 0, 'local interface browsing never fetches full source');
    check.assertions.push('Module interface search/type/no-match/clear match real metadata, clear both filters and restore search focus by keyboard, and make zero HTTP/source requests.');

    phase = `${scenario.name}: copy complete declaration names and pinned permalinks by keyboard`;
    const declaration = detail(page).locator('[data-installed-library-declaration]').filter({ has: page.getByRole('heading', { level: 3, name: entry.name, exact: true }) });
    assert.equal(await copyDeclaration(page, declaration, entry.name, 'name', en), entry.name, 'clipboard contains the complete real Lean declaration name');
    const permalink = await copyDeclaration(page, declaration, entry.name, 'link', en), copiedUrl = new URL(permalink);
    assert.equal(copiedUrl.origin, origin); assert.equal(copiedUrl.pathname, '/library.html');
    for (const [key, value] of Object.entries({ ...preserved, source: 'installed', module: picked.file, catalogDigest: initial.library.catalogDigest })) {
      assert.equal(copiedUrl.searchParams.get(key), value, `copied declaration permalink pins ${key}`);
    }
    assert.equal(copiedUrl.hash, `#declaration-${encodeURIComponent(entry.name)}`);
    assert.equal(new URL(await declaration.getByRole('link', { name: entry.name, exact: true }).getAttribute('href') ?? '', origin).href, permalink, 'declaration title exposes the same pinned address as the copied link');
    const writeText = await page.evaluateHandle(() => navigator.clipboard.writeText);
    try {
      await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new DOMException('Clipboard denied by regression', 'NotAllowedError'); }; });
      await declaration.getByRole('button', { name: text(`复制 Lean 名称：${entry.name}`, `Copy Lean name: ${entry.name}`), exact: true }).focus();
      await page.keyboard.press('Enter');
      const failedCopy = declaration.locator('[data-installed-library-copy="name"]').locator('..');
      await visible(failedCopy.locator('[data-copy-state="failed"]'));
      assert.equal(await failedCopy.locator('[data-copy-state="copied"]').count(), 0, 'rejected copying never leaves a success message');
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), permalink, 'rejected copying leaves the real clipboard unchanged');
    } finally {
      await writeText.evaluate(original => { navigator.clipboard.writeText = original; }); await writeText.dispose();
    }
    assert.equal(requests.length, localRequests, 'declaration copy success and failure make no HTTP requests');
    check.assertions.push('Keyboard copying writes the exact full Lean name and absolute version-pinned declaration URL to the real clipboard; rejected copying reports failure without a false success.');

    phase = `${scenario.name}: copied permalink navigation and reload position the declaration anchor`;
    const beforeAnchorNavigation = requests.length;
    await page.goto(permalink, { waitUntil: 'domcontentloaded', timeout: 0 });
    await declarationAtAnchor(page, entry.name);
    assert.equal(requests.length, beforeAnchorNavigation, 'same-document declaration navigation keeps the loaded module and makes no HTTP requests');
    await page.goto(`${origin}/library.html`, { waitUntil: 'domcontentloaded', timeout: 0 });
    await visible(cards(page).first());
    const permalinkLoaded = responseFor(page, '/api/research/library/installed/module', { file: picked.file, catalogDigest: initial.library.catalogDigest });
    await page.goto(permalink, { waitUntil: 'domcontentloaded', timeout: 0 });
    assert.equal((await received<{ item: InstalledLibraryDetail }>(permalinkLoaded)).item.library.catalogDigest, initial.library.catalogDigest);
    await declarationAtAnchor(page, entry.name);
    const permalinkReloaded = responseFor(page, '/api/research/library/installed/module', { file: picked.file, catalogDigest: initial.library.catalogDigest });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 0 });
    assert.equal((await received<{ item: InstalledLibraryDetail }>(permalinkReloaded)).item.library.catalogDigest, initial.library.catalogDigest);
    await declarationAtAnchor(page, entry.name);
    urlFilters(page, { ...preserved, source: 'installed', module: picked.file, catalogDigest: initial.library.catalogDigest });
    assert.equal(new URL(page.url()).hash, copiedUrl.hash);
    assert.equal(sourceRequests().length, 0, 'opening and reloading a declaration permalink never eagerly loads source');
    check.assertions.push('Copied declaration permalinks position the heading with no requests for a same-document jump; opening from the directory and reloading fetch the pinned module, retain filters and visibly locate the declaration without loading full source.');

    phase = `${scenario.name}: module interface filters survive reload independently of directory filters`;
    await interfaceSearch.fill('NoSuchInstalledDeclaration', { timeout: 0 }); await waitDeclarations([]); await settled(page);
    assert.equal(new URL(page.url()).hash, '', 'filtering out the anchored declaration clears the hidden target from the URL');
    const localQuery = entry.name.split('.').at(-1)!;
    await interfaceSearch.fill(localQuery, { timeout: 0 }); await interfaceKind.selectOption(entry.kind, { timeout: 0 });
    const persistedEntries = metadata.module.entries.filter(item => item.kind === entry.kind && `${item.name} ${item.type} ${item.description}`.toLocaleLowerCase().includes(localQuery.toLocaleLowerCase())).map(item => item.name);
    await waitDeclarations(persistedEntries); await settled(page);
    urlFilters(page, { ...preserved, interfaceQuery: localQuery, interfaceKind: entry.kind });
    const filtersReloaded = responseFor(page, '/api/research/library/installed/module', { file: picked.file, catalogDigest: initial.library.catalogDigest });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 0 }); await received<{ item: InstalledLibraryDetail }>(filtersReloaded);
    await waitDeclarations(persistedEntries);
    assert.equal(await interfaceSearch.inputValue(), localQuery); assert.equal(await interfaceKind.inputValue(), entry.kind);
    urlFilters(page, { ...preserved, interfaceQuery: localQuery, interfaceKind: entry.kind });
    await screenshot(page, check, 'interface-filters', detail(page).locator('[data-installed-interface-toolbar]'));
    const filteredArticle = detail(page).locator(`[data-installed-library-declaration="${entry.name}"]`);
    const filteredPermalink = await copyDeclaration(page, filteredArticle, entry.name, 'link', en), filteredAddress = new URL(filteredPermalink);
    assert.equal(filteredAddress.searchParams.get('interfaceQuery'), localQuery); assert.equal(filteredAddress.searchParams.get('interfaceKind'), entry.kind);
    const beforeTitle = requests.length;
    await filteredArticle.getByRole('link', { name: entry.name, exact: true }).click({ timeout: 0 });
    await declarationAtAnchor(page, entry.name); await waitDeclarations(persistedEntries);
    urlFilters(page, { ...preserved, interfaceQuery: localQuery, interfaceKind: entry.kind });
    assert.equal(requests.length, beforeTitle, 'clicking a filtered declaration title is a same-document jump');
    const copiedReload = responseFor(page, '/api/research/library/installed/module', { file: picked.file, catalogDigest: initial.library.catalogDigest });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 0 }); await received<{ item: InstalledLibraryDetail }>(copiedReload);
    await declarationAtAnchor(page, entry.name); await waitDeclarations(persistedEntries);
    urlFilters(page, { ...preserved, interfaceQuery: localQuery, interfaceKind: entry.kind });
    check.assertions.push('A filtered declaration title and copied permalink retain interfaceQuery/interfaceKind, and a title jump is local while reloading the copied address restores the filtered declarations.');
    const beforeFilterClear = requests.length;
    await clearInterfaces.focus(); await page.keyboard.press('Enter'); await waitDeclarations(metadata.module.entries.map(item => item.name)); await settled(page);
    urlFilters(page, preserved, ['interfaceQuery', 'interfaceKind']);
    assert(await interfaceSearch.evaluate(element => element === document.activeElement));
    assert.equal(requests.length, beforeFilterClear, 'clearing persisted local filters makes no HTTP requests');
    assert.equal(sourceRequests().length, 0);
    check.assertions.push('Interface query/kind and matching real declarations survive reload independently of directory filters; clearing removes both URL keys, restores focus and makes no HTTP/source requests.');

    phase = `${scenario.name}: full source remains pinned and lazy after local interface browsing`;
    const sourceLoaded = responseFor(page, '/api/research/library/installed/module', { file: picked.file, catalogDigest: initial.library.catalogDigest, view: 'source' });
    await detail(page).getByText(text('查看完整源码', 'View full source'), { exact: true }).click({ timeout: 0 });
    const source = (await received<{ item: InstalledLibrarySource }>(sourceLoaded)).item;
    const sourceCode = page.locator('[data-installed-library-source] pre'); await visible(sourceCode);
    assert.equal(source.file, picked.file); assert.equal(source.library.catalogDigest, initial.library.catalogDigest);
    assert.equal(source.sourceDigest, metadata.module.sha256);
    assert.equal(createHash('sha256').update(source.source).digest('hex'), source.sourceDigest);
    assert.equal(await sourceCode.textContent(), source.source, 'UI displays the exact pinned HTTP source');
    assert.equal(sourceRequests().length, 1, 'full source is requested only when expanded');
    await screenshot(page, check, 'source', page.locator('[data-installed-library-source]'));
    await page.locator('.research-breadcrumb a').click({ timeout: 0 }); await visible(directory(page)); await visible(cards(page).first());
    urlFilters(page, preserved, ['source', 'module', 'catalogDigest']);
    assert.equal(await search.inputValue(), theoremName); assert.equal(await area.inputValue(), picked.area); assert.equal(await environment.inputValue(), 'mathlib');
    check.assertions.push('Module and full source stay pinned to catalog/source digests; source loads only on expansion; returning preserves search/area/environment/mine.');

    phase = `${scenario.name}: installed module pagination and return keep offset`;
    await changeDirectory(page, { q: theoremName, area: '', environment: 'mathlib' }, () => area.fill('', { timeout: 0 }));
    const reset = await changeDirectory(page, { q: '', area: '', environment: 'mathlib', offset: '0' }, async () => { await search.fill('', { timeout: 0 }); await search.press('Enter', { timeout: 0 }); });
    assert.equal(reset.total, 53); assert(reset.nextOffset && reset.nextOffset > 0);
    const next = await changeDirectory(page, { q: '', area: '', environment: 'mathlib', offset: String(reset.nextOffset) },
      () => directory(page).getByRole('button', { name: text('下一页', 'Next page'), exact: true }).click({ timeout: 0 }));
    assert.equal(next.offset, reset.nextOffset); assert(next.items.length > 0);
    assert(next.items.every(module => !reset.items.some(previous => previous.file === module.file)), 'pages contain distinct modules');
    const nextModule = next.items[0]; await visible(openModule(page, nextModule.name));
    await openModule(page, nextModule.name).click({ timeout: 0 });
    await visible(detail(page).locator('.research-installed-detail-heading h2'));
    assert.equal(await detail(page).locator('.research-installed-detail-heading > div > code').textContent(), nextModule.name);
    urlFilters(page, { type: 'mathematics', collection: 'lean', environment: 'mathlib', mine: '1', offset: String(next.offset), module: nextModule.file });
    await page.locator('.research-breadcrumb a').click({ timeout: 0 }); await visible(openModule(page, nextModule.name));
    urlFilters(page, { type: 'mathematics', collection: 'lean', environment: 'mathlib', mine: '1', offset: String(next.offset) }, ['source', 'module', 'catalogDigest']);
    const mismatch = await changeDirectory(page, { environment: 'standard', offset: '0' }, () => environment.selectOption('standard', { timeout: 0 }));
    assert.equal(mismatch.total, 0); assert.equal(mismatch.items.length, 0); assert.equal(await cards(page).count(), 0);
    check.assertions.push('Pagination reads distinct real catalog pages, detail/return preserves offset, and mismatched proof environment produces no installed modules.');
    await healthy(page); checks.push(check); console.log(`PASS ${scenario.name}: real release, zero assets, search/filter/page/detail/source`);
    await context.close(); active = undefined;
  }
} catch (error) {
  failure = error; process.exitCode = 1; console.error(error);
  await active?.screenshot({ path: path.join(output, `${scenarioName}-failure.png`), animations: 'disabled', timeout: 0 }).catch(() => {});
} finally {
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    mode: 'real local HTTP service + repository catalog + disposable empty research storage', checks, requests, errors, external, writes, forbiddenCalls, problemIndexRequests,
    realModelCalls: 0, realLeanProcesses: 0, browserTimeouts: 0, deadline: null, tokenLimit: null, roundLimit: null, fixturesRemoved: true,
    ...(failure ? { failedPhase: phase, error: failure instanceof Error ? failure.stack ?? failure.message : String(failure) } : {}) }, null, 2) + '\n');
}
