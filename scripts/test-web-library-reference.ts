#!/usr/bin/env bun
// Real local HTTP/catalog reads and a disposable conversation record; no model or Lean execution.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator, type Page, type Response as BrowserResponse } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebSession } from '../apps/web/shared';
import type { WebConversation } from '../apps/web/conversationTypes';
import type { InstalledLibraryDetail, InstalledLibraryDirectory, InstalledLibraryEntry } from '../apps/web/installedLibraryTypes';
import { audit } from './web-a11y';
import { freePort } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), output = path.join(root, 'out/web-library-reference');
await fs.mkdir(output, { recursive: true });
await fs.access(path.join(root, 'out/web/app.js')); await fs.access(path.join(root, 'out/web/research.js'));
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-library-reference-'));
const forbiddenCalls: string[] = [];
const forbidden = (operation: string): never => { forbiddenCalls.push(operation); throw new Error(`Library references must not call runner.${operation}`); };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Read-only local Library reference regression' }; },
  async run() { return forbidden('run'); }, async check() { return forbidden('check'); }, async command() { return forbidden('command'); },
  async formalize() { return forbidden('formalize'); }, async explain() { return forbidden('explain'); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_PROVIDERS: '[{"id":"fixture","name":"Local fixture","baseUrl":"https://fixture.invalid/v1"}]' }), runner, { sample: null });
service.server.requestTimeout = 0; service.server.headersTimeout = 0; service.server.keepAliveTimeout = 0; service.server.setTimeout(0);
await new Promise<void>((resolve, reject) => { service.server.once('error', reject); service.server.listen(port, '127.0.0.1', resolve); });
const browser = await chromium.launch({ headless: true, timeout: 0 });
const requests: { scenario: string; method: string; pathname: string; search: string }[] = [];
const errors: string[] = [], external: string[] = [], writes: string[] = [], expectedConsoleErrors: string[] = [];
const checks: { scenario: string; assertions: string[]; screenshots: string[]; catalogDigest?: string; declaration?: string; fixtureConversation?: string }[] = [];
let active: Page | undefined, phase = 'setup', scenarioName = '', failure: unknown, failedUrl = '', expectedDigestError = false;
const visible = (locator: Locator) => locator.waitFor({ state: 'visible', timeout: 0 });
const composer = (page: Page) => page.locator('#formalize-original');
const directory = (page: Page) => page.locator('[data-installed-library-directory]');
const detail = (page: Page) => page.locator('[data-installed-library-detail]');
const libraryKeys = ['libraryModule', 'libraryCatalog', 'libraryDeclaration'];
function step(description: string) { phase = `${scenarioName}: ${description}`; console.log(`CHECK ${phase}`); }
async function settled(page: Page) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
}
function responseFor(page: Page, pathname: string, query: Record<string, string> = {}) {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === pathname
      && Object.entries(query).every(([key, value]) => url.searchParams.get(key) === value);
  }, { timeout: 0 });
}
async function received<T>(pending: Promise<BrowserResponse>, status = 200): Promise<T> {
  const response = await pending;
  assert.equal(response.status(), status, `${phase}: ${response.url()}`);
  if (new URL(response.url()).pathname.startsWith('/api/research/')) assert(response.headers()['x-theoremos-owner'], 'module reads carry the real owner binding');
  return await response.json() as T;
}
async function draftEquals(page: Page, text: string) {
  await page.waitForFunction(text => document.querySelector<HTMLTextAreaElement>('#formalize-original')?.value === text, text, { timeout: 0 });
  assert.equal(await composer(page).inputValue(), text);
}
async function healthy(page: Page) {
  await settled(page);
  assert.deepEqual(await audit(page), [], `${phase}: accessibility`);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${phase}: no horizontal page overflow`);
  assert.deepEqual(errors, [], `${phase}: no unexpected browser errors`);
  assert.deepEqual(external, [], `${phase}: local network only`);
  assert.deepEqual(writes, [], `${phase}: no API writes or automatic submission`);
  assert.deepEqual(forbiddenCalls, [], `${phase}: no model, Lean or research runner calls`);
  assert.equal(requests.filter(request => request.scenario === scenarioName && request.pathname === '/api/research/library/installed/module'
    && new URLSearchParams(request.search).has('view')).length, 0, 'reference flow needs metadata and never eagerly reads full source');
}
async function screenshot(page: Page, check: typeof checks[number], name: string, target?: Locator) {
  await healthy(page);
  if (target) await target.scrollIntoViewIfNeeded({ timeout: 0 }); else await page.evaluate(() => scrollTo(0, 0));
  await settled(page);
  const filename = `${check.scenario}-${name}.png`;
  await page.screenshot({ path: path.join(output, filename), animations: 'disabled', timeout: 0 }); check.screenshots.push(filename);
}
function metadataRequests() {
  return requests.filter(request => request.scenario === scenarioName && request.pathname === '/api/research/library/installed/module');
}
async function openLibrary(page: Page, chat = '') {
  let link = page.locator('[data-workbench-library]');
  if (!await link.isVisible()) {
    const menu = page.locator('[data-research-mobile-navigation]');
    if (!await menu.evaluate(node => (node as HTMLDetailsElement).open)) await menu.locator('summary').click({ timeout: 0 });
    link = menu.locator('[data-research-mobile-link="library"]');
  }
  await visible(link);
  const url = new URL(await link.getAttribute('href') ?? '', page.url());
  assert.equal(url.pathname, '/library.html'); assert.equal(url.searchParams.get('workbenchChat') ?? '', chat);
  const loaded = responseFor(page, '/api/research/library/installed');
  await link.focus(); await page.keyboard.press('Enter');
  const catalog = await received<InstalledLibraryDirectory>(loaded); await visible(directory(page));
  assert.equal(new URL(page.url()).searchParams.get('workbenchChat') ?? '', chat);
  return catalog;
}
async function openModule(page: Page, file: string, digest: string, chat = '') {
  const loaded = responseFor(page, '/api/research/library/installed/module', { file, catalogDigest: digest });
  await directory(page).locator(`[data-installed-library-module="${file}"] [data-installed-library-open]`).click({ timeout: 0 });
  const metadata = (await received<{ item: InstalledLibraryDetail }>(loaded)).item;
  await visible(detail(page));
  assert.equal(new URL(page.url()).searchParams.get('workbenchChat') ?? '', chat);
  assert.equal(metadata.module.file, file); assert.equal(metadata.library.catalogDigest, digest);
  return metadata;
}
async function addReference(page: Page, metadata: InstalledLibraryDetail, entry: InstalledLibraryEntry, previous: string, chat: string, en: boolean) {
  const link = detail(page).locator(`[data-installed-library-reference="${entry.name}"]`);
  await visible(link);
  assert.equal(await link.getAttribute('aria-label'), en ? `Reference in workbench: ${entry.name}` : `在工作台引用：${entry.name}`);
  const target = new URL(await link.getAttribute('href') ?? '', page.url());
  assert.equal(target.origin, origin); assert.equal(target.pathname, '/');
  for (const [key, value] of Object.entries({ libraryModule: metadata.module.file, libraryCatalog: metadata.library.catalogDigest, libraryDeclaration: entry.name })) {
    assert.equal(target.searchParams.get(key), value, `reference link pins ${key}`);
  }
  assert.equal(target.searchParams.get('chat') ?? '', chat);
  const loaded = responseFor(page, '/api/research/library/installed/module', { file: metadata.module.file, catalogDigest: metadata.library.catalogDigest });
  await link.focus(); await page.keyboard.press('Enter');
  const reread = (await received<{ item: InstalledLibraryDetail }>(loaded)).item;
  assert.deepEqual(reread, metadata, 'workbench reads the same real pinned declaration metadata');
  await visible(composer(page));
  await page.waitForFunction(({ name, type, keys }) => {
    const text = document.querySelector<HTMLTextAreaElement>('#formalize-original')?.value ?? '';
    return text.includes(`#check ${name}`) && text.includes(type) && keys.every(key => !new URL(location.href).searchParams.has(key));
  }, { name: entry.name, type: entry.type, keys: libraryKeys }, { timeout: 0 });
  const text = await composer(page).inputValue();
  assert(text.startsWith(`${previous}\n\n`), 'reference appends after the exact existing draft, preserving its whitespace');
  assert(text.includes(`\n${metadata.module.import}\n`), 'draft contains the real module import');
  assert.equal(text.split(`#check ${entry.name}`).length - 1, 1, 'draft contains exactly one check of the complete real declaration name');
  assert(text.includes(`\n${entry.type}\n`), 'draft contains the exact real declaration type');
  const sourceLine = text.split('\n').find(line => line.includes(`${origin}/library.html?`));
  assert(sourceLine, 'draft includes a source permalink');
  const source = new URL(sourceLine.match(/https?:\/\/\S+/u)![0]);
  assert.equal(source.searchParams.get('module'), metadata.module.file);
  assert.equal(source.searchParams.get('catalogDigest'), metadata.library.catalogDigest);
  assert.equal(source.hash, `#declaration-${encodeURIComponent(entry.name)}`);
  assert.equal(new URL(page.url()).searchParams.get('chat') ?? '', chat);
  assert.equal(await page.locator('#formalize-error:visible').count(), 0, 'successful reference shows no error');
  const beforeReload = metadataRequests().length;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 0 }); await visible(composer(page)); await draftEquals(page, text); await settled(page);
  assert.equal(metadataRequests().length, beforeReload, 'refresh after consuming the URL does not read or append the reference again');
  for (const key of libraryKeys) assert.equal(new URL(page.url()).searchParams.has(key), false);
  assert.equal(new URL(page.url()).searchParams.get('chat') ?? '', chat);
  return text;
}

try {
  for (const scenario of [{ name: 'zh-1440', locale: 'zh', width: 1440, height: 1000 }, { name: 'en-390', locale: 'en', width: 390, height: 844 }]) {
    scenarioName = scenario.name; expectedDigestError = false;
    const en = scenario.locale === 'en';
    const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, locale: en ? 'en-US' : 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' });
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
    page.on('console', message => {
      if (message.type() !== 'error') return;
      if (expectedDigestError && /status of 409\b/u.test(message.text())) expectedConsoleErrors.push(`${scenario.name}: ${message.text()}`);
      else errors.push(`${scenario.name}: ${message.text()}`);
    });
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) requests.push({ scenario: scenario.name, method: request.method(), pathname: url.pathname, search: url.search });
    });
    const check: typeof checks[number] = { scenario: scenario.name, assertions: [], screenshots: [] };

    step('reference a real installed declaration into the existing home draft');
    const sessionLoaded = responseFor(page, '/api/session');
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 0 });
    const session = await received<WebSession>(sessionLoaded); assert.match(session.draftOwner ?? '', /^[a-f0-9]{64}$/u);
    await visible(composer(page));
    const homeDraft = en ? '  Keep this unfinished mathematical question.\n\nPreserve its spaces and line breaks.  '
      : '  保留这道尚未发送的数学题。\n\n保留原有空格和换行。  ';
    await composer(page).fill(homeDraft, { timeout: 0 });
    const catalog = await openLibrary(page);
    assert.equal(catalog.library.moduleCount, 53); assert.equal(catalog.library.declarationCount, 1964);
    const picked = catalog.items.find(module => module.preview.length > 0); assert(picked, 'real installed catalog includes a declaration');
    const metadata = await openModule(page, picked.file, catalog.library.catalogDigest), entry = metadata.module.entries[0]; assert(entry);
    check.catalogDigest = metadata.library.catalogDigest; check.declaration = entry.name;
    await screenshot(page, check, 'home-reference-choice', detail(page).locator(`[data-installed-library-reference="${entry.name}"]`));
    const homeWithReference = await addReference(page, metadata, entry, homeDraft, '', en);
    await screenshot(page, check, 'home-reference-restored', composer(page));
    check.assertions.push('Keyboard Library reference preserves the exact home draft, reads pinned metadata, appends the real import, full #check, declaration type and source permalink, and survives refresh without duplication or new reference reads.');

    step('reject a stale catalog digest without changing the home draft');
    const badDigest = '0'.repeat(64); assert.notEqual(badDigest, metadata.library.catalogDigest);
    const badUrl = new URL('/', origin);
    badUrl.search = new URLSearchParams({ libraryModule: picked.file, libraryCatalog: badDigest, libraryDeclaration: entry.name }).toString();
    expectedDigestError = true;
    const rejected = responseFor(page, '/api/research/library/installed/module', { file: picked.file, catalogDigest: badDigest });
    await page.goto(badUrl.href, { waitUntil: 'domcontentloaded', timeout: 0 });
    const rejection = await received<{ error: string }>(rejected, 409); assert(rejection.error);
    await visible(composer(page)); await visible(page.locator('#formalize-error'));
    assert.match(await page.locator('#formalize-error').innerText(), en ? /Could not reference the library:/u : /引用数学库失败：/u);
    await draftEquals(page, homeWithReference);
    assert.equal(new URL(page.url()).searchParams.get('libraryCatalog'), badDigest, `failed reference keeps its parameters for refresh/retry: ${page.url()}`);
    await screenshot(page, check, 'stale-digest-preserves-draft', composer(page));
    check.assertions.push('A real HTTP 409 for an incorrect catalog digest leaves the exact existing draft intact, displays a reference error without adding content, and retains the URL parameters for refresh/retry.');

    step('return a Library reference to the original conversation and its separate draft');
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 0 }); await visible(composer(page)); await draftEquals(page, homeWithReference);
    expectedDigestError = false;
    const at = new Date().toISOString(), fixture: WebConversation = { id: randomUUID(), title: en ? 'Local reference fixture' : '本地引用测试对话',
      createdAt: at, updatedAt: at, messages: [{ id: randomUUID(), role: 'user', kind: 'text', text: en ? 'Recorded local fixture question.' : '已保存的本地测试题目。', createdAt: at, status: 'complete' }] };
    // The only test-data write is a disposable server-side fixture. Browser/API traffic remains GET-only.
    const fixtureKey = ['owners', session.draftOwner!, 'conversations', `${fixture.id}.json`];
    service.storage.saveRecord(fixtureKey, fixture); check.fixtureConversation = fixture.id;
    const conversationLoaded = responseFor(page, `/api/conversations/${fixture.id}`);
    await page.goto(`${origin}/?chat=${fixture.id}`, { waitUntil: 'domcontentloaded', timeout: 0 });
    assert.deepEqual((await received<{ conversation: WebConversation }>(conversationLoaded)).conversation, fixture);
    await visible(composer(page));
    const chatDraft = en ? '  Keep this conversation follow-up.\nUse the library fact below.  ' : '  保留这段对话的后续问题。\n下面引用数学库条目。  ';
    await composer(page).fill(chatDraft, { timeout: 0 });
    const chatCatalog = await openLibrary(page, fixture.id); assert.equal(chatCatalog.library.catalogDigest, metadata.library.catalogDigest);
    await openModule(page, picked.file, metadata.library.catalogDigest, fixture.id);
    const backLoaded = responseFor(page, '/api/research/library/installed');
    await page.locator('.research-breadcrumb a').click({ timeout: 0 }); await received<InstalledLibraryDirectory>(backLoaded); await visible(directory(page));
    assert.equal(new URL(page.url()).searchParams.get('workbenchChat'), fixture.id, 'returning from detail retains the originating conversation');
    const chatMetadata = await openModule(page, picked.file, metadata.library.catalogDigest, fixture.id);
    const chatWithReference = await addReference(page, chatMetadata, entry, chatDraft, fixture.id, en);
    assert(!chatWithReference.includes(homeDraft), 'conversation references never import the home draft');
    await screenshot(page, check, 'conversation-reference-restored', composer(page));
    assert.deepEqual(service.storage.getRecord<WebConversation>(fixtureKey), fixture, 'reference and refresh never send a message or change the recorded conversation');
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 0 }); await visible(composer(page)); await draftEquals(page, homeWithReference);
    assert(!(await composer(page).inputValue()).includes(chatDraft), 'home and conversation drafts remain isolated');
    check.assertions.push('A disposable real conversation is read over HTTP; workbench→Library→detail→directory→detail→reference retains its chat identity and draft, refresh is idempotent, the home draft stays separate, and the server conversation receives no messages.');
    await healthy(page); checks.push(check); console.log(`PASS ${scenario.name}: home/chat reference, exact pinned metadata, refresh and stale-digest failure`);
    await context.close(); active = undefined;
  }
} catch (error) {
  failure = error; failedUrl = active?.url() ?? ''; process.exitCode = 1; console.error(error);
  await active?.screenshot({ path: path.join(output, `${scenarioName}-failure.png`), animations: 'disabled', timeout: 0 }).catch(() => {});
} finally {
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    mode: 'real local HTTP service + repository catalog + disposable local conversation fixture', checks, requests, errors, expectedConsoleErrors, external, writes, forbiddenCalls,
    realModelCalls: 0, realLeanProcesses: 0, browserTimeouts: 0, deadline: null, fixturesRemoved: true,
    ...(failure ? { failedPhase: phase, failedUrl, error: failure instanceof Error ? failure.stack ?? failure.message : String(failure) } : {}) }, null, 2) + '\n');
}
