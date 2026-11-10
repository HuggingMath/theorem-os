#!/usr/bin/env bun
// Disposable account lifecycle and contribution regressions. No model, Lean, external mail or production.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page, Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchAsset, ResearchPublication, ResearchSkillDraft } from '../apps/web/researchAssetTypes';
import type { ResearcherProfile, ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import { deferred, freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_ROUND5_PEOPLE_OUTPUT ?? path.join(root, 'out/web-round5-people');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round5-people-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let runnerCalls = 0;
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Disposable People regression fixture' }; },
  async run() { runnerCalls++; throw new Error('People regressions must not start research runs'); } };
const mail: Array<{ to: string; text: string }> = [];
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:',
  THEOREMOS_WEB_ALLOWLIST: 'alice@example.org,bob@example.org,carol@example.org' }), runner,
  { sample: null, mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
const browser = await startBrowser(service.server, port);
const contexts = await Promise.all([browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }),
  browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })]);
const pageErrors: string[] = [], external: string[] = [], checks: object[] = [];
const writes: Array<{ page: string; method: string; pathname: string }> = [];
for (const context of contexts) {
  context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
  await context.addInitScript(() => { try { localStorage.setItem('theorem-os.locale.v1', 'zh'); } catch { /* about:blank has no storage. */ } });
  await context.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  context.on('page', page => {
    page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0); page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => {
      if (request.method() !== 'GET') writes.push({ page: page.url(), method: request.method(), pathname: new URL(request.url()).pathname });
    });
  });
}
const auth = await contexts[0].newPage(), people = await contexts[0].newPage(), theorems = await contexts[0].newPage(),
  library = await contexts[0].newPage(), viewer = await contexts[1].newPage();
const password = 'Disposable-People-Regression-Only-2026';
async function http<T = any>(page: Page, method: string, pathname: string, input?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  }, { method, pathname, input });
}
async function ok<T = any>(page: Page, method: string, pathname: string, input?: unknown): Promise<T> {
  const response = await http<T>(page, method, pathname, input);
  assert.ok(response.status >= 200 && response.status < 300, `${method} ${pathname}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}
async function register(page: Page, name: string, visibility: 'private' | 'public') {
  await page.goto(`${origin}/login.html`);
  const email = name.toLowerCase() + '@example.org', captcha = await ok(page, 'POST', '/api/auth/captcha', {});
  await ok(page, 'POST', '/api/auth/code', { email, captchaId: captcha.id, captcha: '24680' });
  const code = mail.findLast(message => message.to === email)?.text.match(/\b\d{6}\b/u)?.[0]; assert.ok(code);
  await ok(page, 'POST', '/api/auth/verify', { email, code });
  await ok(page, 'PATCH', '/api/auth/password', { password });
  const session = await ok(page, 'GET', '/api/research/session');
  const profile = (await ok<{ item: ResearcherProfile }>(page, 'PUT', '/api/research/profile', { requestId: crypto.randomUUID(),
    expectedRevision: 0, displayName: name, bio: name + ' PRIVATE BIO', fields: ['algebra'], visibility })).item;
  return { id: session.researcherId as string, profile };
}
async function switchTo(name: string) {
  await ok(auth, 'POST', '/api/auth/password/login', { email: name.toLowerCase() + '@example.org', password });
}
async function resume(page: Page) {
  const reply = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await reply;
  await page.locator('main[aria-busy="false"]').waitFor();
}
async function editProfile(page: Page, name: string) {
  await page.getByRole('link', { name: '我的主页', exact: true }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
  const summary = page.getByText('编辑我的资料', { exact: true });
  if (await summary.locator('..').getAttribute('open') === null) await summary.click();
  return page.getByLabel('简介', { exact: true });
}
const skill = (instructions: string): ResearchSkillDraft => ({ instructions, steps: [], inputs: [], outputs: [], slots: ['M1'],
  roles: [], mode: 'append', dependencies: [], examples: [] });
async function createAsset(name: string) {
  return (await ok<{ item: ResearchAsset }>(auth, 'POST', '/api/research/library', { requestId: crypto.randomUUID(),
    type: 'skill', name, visibility: 'private', content: skill('Private author draft') })).item;
}
async function publish(asset: ResearchAsset, version: string) {
  const current = (await ok<{ item: ResearchAsset }>(auth, 'GET', `/api/research/library/${asset.id}`)).item;
  const initial = (await ok<{ item: ResearchPublication }>(auth, 'POST', `/api/research/library/${asset.id}/publish`, {
    requestId: crypto.randomUUID(), expectedRevision: current.revision, version, license: 'MIT', visibility: 'public' })).item;
  for (;;) {
    const publication = (await ok<{ item: ResearchPublication }>(auth, 'GET', `/api/research/publications/${initial.id}`)).item;
    if (publication.status === 'completed') return publication;
    assert.notEqual(publication.status, 'failed', publication.reason);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
let phase = 'setup', failure: unknown, active = people;
try {
  const alice = await register(auth, 'Alice', 'private');
  await ok(auth, 'POST', '/api/auth/logout', {});
  const bob = await register(auth, 'Bob', 'public');
  const carol = await register(viewer, 'Carol', 'public');
  await switchTo('Alice');

  phase = 'same-owner focus and failed identity confirmation retain the mounted draft';
  await people.goto(`${origin}/people.html`); const biography = await editProfile(people, 'Alice');
  await biography.fill('ALICE UNSAVED LOCAL DRAFT');
  await biography.evaluate(input => { input.dataset.retained = 'same-owner-editor'; });
  await biography.focus();
  await resume(people);
  assert.equal(await biography.inputValue(), 'ALICE UNSAVED LOCAL DRAFT');
  assert.equal(await biography.getAttribute('data-retained'), 'same-owner-editor');
  assert.equal(await biography.evaluate(input => document.activeElement === input), true, 'A routine identity check must retain typing focus');
  const outage = async (route: Route) => route.fulfill({ status: 503, json: { error: 'Fixture session confirmation unavailable' } });
  await people.route('**/api/session', outage);
  await people.evaluate(() => window.dispatchEvent(new Event('focus')));
  await people.getByText('Fixture session confirmation unavailable', { exact: true }).waitFor();
  assert.equal(await biography.inputValue(), 'ALICE UNSAVED LOCAL DRAFT');
  assert.equal(await biography.isVisible(), false);
  await people.screenshot({ path: path.join(output, 'same-owner-confirmation-outage.png'), fullPage: true });
  await people.unroute('**/api/session', outage);
  await people.getByRole('button', { name: '重新连接', exact: true }).click();
  await biography.waitFor();
  assert.equal(await biography.inputValue(), 'ALICE UNSAVED LOCAL DRAFT');
  assert.equal(await biography.getAttribute('data-retained'), 'same-owner-editor');
  checks.push({ name: phase, passed: true });

  phase = 'account-left notifications clear old private content and focus loads the next owner';
  const owner = (await ok(auth, 'GET', '/api/session')).draftOwner;
  await ok(auth, 'POST', '/api/auth/logout', {});
  await auth.evaluate(owner => localStorage.setItem('theorem-os.web-account-left.v1', JSON.stringify({ owner, at: Date.now() })), owner);
  await people.getByRole('heading', { name: 'Alice', exact: true }).waitFor({ state: 'detached' });
  await switchTo('Bob'); await resume(people);
  const nextBiography = await editProfile(people, 'Bob');
  assert.equal(await people.getByText('Alice PRIVATE BIO', { exact: true }).count(), 0);
  assert.equal(await nextBiography.inputValue(), 'Bob PRIVATE BIO');
  checks.push({ name: phase, passed: true });

  phase = 'a delayed private GET cannot refill the next owner page';
  await switchTo('Alice'); await people.goto(`${origin}/people.html`);
  const getReached = deferred(), getRelease = deferred(); let oldDirectory: any, firstDirectory = true;
  const heldDirectory = async (route: Route) => {
    if (!firstDirectory || !new URL(route.request().url()).searchParams.get('field')) { await route.continue(); return; }
    firstDirectory = false;
    const reply = await route.fetch(); oldDirectory = await reply.json(); getReached.resolve(); await getRelease.promise;
    await route.fulfill({ response: reply });
  };
  await people.route('**/api/research/people?*', heldDirectory);
  try {
    await people.getByLabel('按研究领域筛选', { exact: true }).fill('algebra'); await getReached.promise;
    assert.ok(oldDirectory.items.some((profile: ResearcherProfile) => profile.id === alice.id));
    await switchTo('Bob'); await resume(people);
    await people.getByRole('heading', { name: 'Bob', exact: true }).waitFor(); getRelease.resolve();
    await people.locator('.research-directory-card').filter({ hasText: 'Bob' }).waitFor();
    assert.equal(await people.locator('.research-directory-card').filter({ hasText: 'Alice' }).count(), 0);
    await people.screenshot({ path: path.join(output, 'late-private-get-rejected.png'), fullPage: true });
  } finally { getRelease.resolve(); await people.unroute('**/api/research/people?*', heldDirectory); }
  checks.push({ name: phase, passed: true });

  phase = 'a pending write whose identity confirmation belongs to the previous owner is never posted';
  const bobBiography = await editProfile(people, 'Bob'); await bobBiography.fill('BOB STALE UNSENT EDIT');
  const confirmReached = deferred(), confirmRelease = deferred(); let firstConfirmation = true;
  const heldConfirmation = async (route: Route) => {
    if (!firstConfirmation) { await route.continue(); return; }
    firstConfirmation = false; const reply = await route.fetch(); confirmReached.resolve(); await confirmRelease.promise;
    await route.fulfill({ response: reply });
  };
  await people.route('**/api/session', heldConfirmation);
  const beforeWrites = writes.filter(item => item.pathname === '/api/research/profile').length;
  try {
    await people.getByRole('button', { name: '保存资料', exact: true }).click(); await confirmReached.promise;
    const aborted = people.waitForEvent('requestfailed', request => new URL(request.url()).pathname === '/api/session');
    await switchTo('Alice'); await resume(people); await aborted;
    await editProfile(people, 'Alice'); confirmRelease.resolve();
    await people.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(writes.filter(item => item.pathname === '/api/research/profile').length, beforeWrites);
    assert.equal((await ok(auth, 'GET', '/api/research/session')).profile.bio, 'Alice PRIVATE BIO');
  } finally { confirmRelease.resolve(); await people.unroute('**/api/session', heldConfirmation); }
  checks.push({ name: phase, passed: true, oldFormWriteSent: false });

  phase = 'an accepted old-owner write cannot navigate or update the new theorem workspace when its response arrives';
  active = theorems;
  await theorems.goto(`${origin}/theorems.html`); await theorems.getByRole('button', { name: '新建定理', exact: true }).click();
  const createWorkspaceUrl = theorems.url();
  await theorems.getByLabel('定理名称', { exact: true }).fill('ALICE PENDING PRIVATE PROJECT');
  const writeReached = deferred(), writeRelease = deferred(); let acceptedProject: ResearchProjectDetail | undefined;
  const heldWrite = async (route: Route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const reply = await route.fetch(); assert.equal(reply.status(), 201); acceptedProject = (await reply.json()).item;
    writeReached.resolve(); await writeRelease.promise; await route.fulfill({ response: reply });
  };
  await theorems.route('**/api/research/theorems', heldWrite);
  try {
    await theorems.getByRole('button', { name: '创建定理', exact: true }).click(); await writeReached.promise;
    const aborted = theorems.waitForEvent('requestfailed', request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/research/theorems');
    await switchTo('Bob'); await resume(theorems);
    const title = theorems.getByLabel('定理名称', { exact: true });
    if (!await title.isVisible()) await theorems.getByRole('button', { name: '新建定理', exact: true }).click();
    await title.waitFor(); assert.equal(await title.inputValue(), '');
    await aborted; writeRelease.resolve();
    await theorems.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(theorems.url(), createWorkspaceUrl, 'Old completed() callback must not navigate to the previous owner project');
    assert.equal(await title.inputValue(), ''); assert.ok(acceptedProject);
    assert.equal((await http(auth, 'GET', `/api/research/theorems/${acceptedProject.id}`)).status, 404);
    await theorems.screenshot({ path: path.join(output, 'late-write-does-not-navigate.png'), fullPage: true });
  } finally { writeRelease.resolve(); await theorems.unroute('**/api/research/theorems', heldWrite); }
  checks.push({ name: phase, passed: true });

  phase = 'Library uses the same owner lifecycle and removes the previous owner private editor';
  active = library; await switchTo('Alice'); const privateAsset = await createAsset('ALICE PRIVATE ASSET');
  await library.goto(`${origin}/library.html?entry=${privateAsset.id}`);
  await library.getByRole('button', { name: '编辑草稿', exact: true }).click();
  await library.getByLabel('适用情境与执行要求', { exact: true }).fill('ALICE PRIVATE UNSAVED SKILL');
  await switchTo('Bob'); await resume(library);
  await library.getByRole('heading', { name: 'ALICE PRIVATE ASSET', exact: true }).waitFor({ state: 'detached' });
  await library.locator('.research-content').getByRole('alert').waitFor();
  assert.equal(await library.getByRole('button', { name: '保存草稿', exact: true }).count(), 0);
  checks.push({ name: phase, passed: true });

  phase = 'withdrawing v1 retains the public v2 contribution in the author page and following feed';
  active = viewer; const asset = await createAsset('People active version contribution');
  await publish(asset, 'v1'); const v2 = await publish(asset, 'v2');
  const profilePath = `/api/research/people/${bob.id}`, assetPath = `/api/research/library/${asset.id}`;
  const contributions = async () => (await ok(viewer, 'GET', profilePath)).item.contributions.filter((entry: any) => entry.assetId === asset.id);
  assert.equal((await contributions()).length, 2);
  await ok(viewer, 'POST', `/api/research/follows/person/${bob.id}`, { requestId: crypto.randomUUID(), following: true });
  const current = (await ok<{ item: ResearchAsset }>(auth, 'GET', assetPath)).item;
  await ok(auth, 'POST', assetPath + '/releases/v1/withdraw', { requestId: crypto.randomUUID(), expectedRevision: current.revision });
  assert.equal((await http(viewer, 'GET', assetPath + '/releases/v2')).status, 200);
  await ok(auth, 'GET', `/api/research/publications/${v2.id}`);
  assert.deepEqual((await contributions()).map((entry: any) => entry.assetVersion), ['v2']);
  const feed = await ok(viewer, 'GET', '/api/research/feed');
  assert.deepEqual(feed.items.filter((entry: any) => entry.assetId === asset.id).map((entry: any) => entry.assetVersion), ['v2']);
  await viewer.goto(`${origin}/people.html?id=${bob.id}`);
  await viewer.locator(`a[href="library.html?entry=${asset.id}&version=v2"]`).waitFor();
  assert.equal(await viewer.locator(`a[href="library.html?entry=${asset.id}&version=v1"]`).count(), 0);
  await viewer.screenshot({ path: path.join(output, 'active-v2-contribution-preserved.png'), fullPage: true });
  checks.push({ name: phase, passed: true, viewerId: carol.id, activeVersion: 'v2' });
  assert.deepEqual(pageErrors, []); assert.deepEqual(external, []); assert.equal(runnerCalls, 0);
} catch (error) {
  failure = error; await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error;
} finally {
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    phase, ...(failure ? { error: String(failure) } : {}), checks, pageErrors, externalRequests: external,
    runnerCalls, realModelCalls: 0, realLeanCalls: 0, realMail: false, interceptedMailCount: mail.length, productionWrites: false,
    disposableFixturesRemoved: true }, null, 2) + '\n');
}
