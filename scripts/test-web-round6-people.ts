#!/usr/bin/env bun
// Session rollover regressions against disposable local accounts. No models, Lean, mail delivery or production.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page, Route } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { deferred, freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_ROUND6_PEOPLE_OUTPUT ?? path.join(root, 'out/web-round6-people');
await fs.access(path.join(root, 'out/web/research.js'));
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round6-people-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const mail: Array<{ to: string; text: string }> = [];
let runnerCalls = 0;
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Disposable session rollover fixture' }; },
  async run() { runnerCalls++; throw new Error('Session regressions must not start research runs'); } };
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_AUTH: 'email',
  THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'alice@example.org,bob@example.org' }), runner,
  { sample: null, mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
const browser = await startBrowser(service.server, port);
const contexts = await Promise.all([browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }),
  browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })]);
const pageErrors: string[] = [], external: string[] = [], checks: object[] = [], profileWrites: Array<Record<string, unknown>> = [];
for (const context of contexts) {
  context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
  await context.addInitScript(() => { try { localStorage.setItem('theorem-os.web-locale.v1', 'zh'); } catch { /* about:blank has no storage. */ } });
  await context.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  context.on('page', page => { page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0); page.on('pageerror', error => pageErrors.push(error.message)); });
}
const auth = await contexts[0].newPage(), people = await contexts[0].newPage(), secondDevice = await contexts[1].newPage();
people.on('request', request => {
  if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/research/profile') profileWrites.push(request.postDataJSON());
});
const password = 'Disposable-Session-Rollover-Only-2026';
async function http(page: Page, method: string, pathname: string, input?: unknown) {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  }, { method, pathname, input });
}
async function ok(page: Page, method: string, pathname: string, input?: unknown): Promise<any> {
  const response = await http(page, method, pathname, input);
  assert.ok(response.status >= 200 && response.status < 300, `${method} ${pathname}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}
async function register(page: Page, name: string, visibility: 'private' | 'public') {
  await page.goto(`${origin}/login.html`); const email = name.toLowerCase() + '@example.org';
  const captcha = await ok(page, 'POST', '/api/auth/captcha', {});
  await ok(page, 'POST', '/api/auth/code', { email, captchaId: captcha.id, captcha: '24680' });
  const code = mail.findLast(message => message.to === email)?.text.match(/\b\d{6}\b/u)?.[0]; assert.ok(code);
  await ok(page, 'POST', '/api/auth/verify', { email, code });
  await ok(page, 'PATCH', '/api/auth/password', { password });
  await ok(page, 'PUT', '/api/research/profile', { requestId: crypto.randomUUID(), expectedRevision: 0,
    displayName: name, fields: ['algebra'], bio: name + ' private biography', visibility });
  return ok(page, 'GET', '/api/session');
}
async function loginBob() {
  await ok(auth, 'POST', '/api/auth/password/login', { email: 'bob@example.org', password });
  const session = await ok(auth, 'GET', '/api/session'); assert.equal(session.account?.email, 'bob@example.org'); return session;
}
async function resume() {
  const response = people.waitForResponse(reply => new URL(reply.url()).pathname === '/api/session');
  await people.evaluate(() => window.dispatchEvent(new Event('focus'))); await response;
  await people.locator('main[aria-busy="false"]').waitFor();
}
async function editBob() {
  await people.getByRole('link', { name: '我的主页', exact: true }).click();
  await people.getByRole('heading', { name: 'Bob', exact: true }).waitFor();
  const summary = people.getByText('编辑我的资料', { exact: true });
  if (await summary.locator('..').getAttribute('open') === null) await summary.click();
  return people.getByLabel('简介', { exact: true });
}
const putResponse = () => people.waitForResponse(reply => reply.request().method() === 'PUT' && new URL(reply.url()).pathname === '/api/research/profile');
let phase = 'setup', failure: unknown;
try {
  const alice = await register(auth, 'Alice', 'private'); await register(secondDevice, 'Bob', 'public');

  phase = 'account-left cancels a delayed bootstrap before the page has a context';
  const reached = deferred(), release = deferred(); let firstBootstrap = true;
  const holdBootstrap = async (route: Route) => {
    if (!firstBootstrap) { await route.continue(); return; } firstBootstrap = false;
    const response = await route.fetch(); assert.equal((await response.json()).account.email, 'alice@example.org');
    reached.resolve(); await release.promise; await route.fulfill({ response });
  };
  await people.route('**/api/session', holdBootstrap);
  try {
    await people.goto(`${origin}/people.html`); await reached.promise;
    const aborted = people.waitForEvent('requestfailed', request => new URL(request.url()).pathname === '/api/session');
    await ok(auth, 'POST', '/api/auth/logout', {});
    await auth.evaluate(owner => localStorage.setItem('theorem-os.web-account-left.v1', JSON.stringify({ owner, at: Date.now() })), alice.draftOwner);
    await aborted; await loginBob(); release.resolve(); await resume();
    await people.getByRole('link', { name: '我的主页', exact: true }).click();
    await people.getByRole('heading', { name: 'Bob', exact: true }).waitFor();
    assert.equal((await ok(auth, 'GET', '/api/session')).account.email, 'bob@example.org');
    await people.screenshot({ path: path.join(output, 'bootstrap-next-login-preserved.png'), fullPage: true });
  } finally { release.resolve(); await people.unroute('**/api/session', holdBootstrap); }
  checks.push({ name: phase, passed: true, oldRequestAborted: true });

  phase = 'a late unbound old-session GET cannot replace a newer login before the page confirms it';
  const lateReached = deferred(), lateRelease = deferred();
  let interveningConfirmations = 0;
  const countConfirmations = (request: import('playwright').Request) => {
    if (new URL(request.url()).pathname === '/api/session') interveningConfirmations++;
  };
  const holdUnbound = async (route: Route) => {
    const response = await route.fetch(); assert.equal(response.status(), 200);
    assert.equal(response.headers()['set-cookie'], undefined, 'An existing authenticated read must not rewrite identity');
    lateReached.resolve(); await lateRelease.promise; await route.fulfill({ response });
  };
  await people.route('**/api/research/people?round6Late=1', holdUnbound);
  people.on('request', countConfirmations);
  try {
    // This real fetch has no session-bound AbortController, so its old response must actually be delivered.
    await people.evaluate(() => {
      (window as unknown as { latePeopleResponse: Promise<number> }).latePeopleResponse =
        fetch('/api/research/people?round6Late=1').then(async response => { await response.json(); return response.status; });
    });
    await lateReached.promise;
    const oldCookie = (await contexts[0].cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const next = await loginBob();
    const newCookie = (await contexts[0].cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    assert.notEqual(newCookie, oldCookie);
    lateRelease.resolve();
    assert.equal(await people.evaluate(() => (window as unknown as { latePeopleResponse: Promise<number> }).latePeopleResponse), 200);
    assert.equal(interveningConfirmations, 0, 'The old response must arrive before any page-side identity confirmation');
    assert.equal((await contexts[0].cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value, newCookie);
    const actual = await ok(auth, 'GET', '/api/session');
    assert.equal(actual.account.email, 'bob@example.org'); assert.equal(actual.csrfToken, next.csrfToken);
  } finally {
    lateRelease.resolve(); people.off('request', countConfirmations); await people.unroute('**/api/research/people?round6Late=1', holdUnbound);
  }
  await resume();
  checks.push({ name: phase, passed: true, unboundOldResponseDelivered: true, pageConfirmedNewSessionFirst: false, newIdentityCookiePreserved: true });

  phase = 'same-owner relogin cancels old reads while preserving the mounted draft and typing focus';
  const biography = people.getByLabel('简介', { exact: true });
  const previous = await ok(auth, 'GET', '/api/session');
  const readReached = deferred(), readRelease = deferred(); let feedReads = 0;
  const holdRead = async (route: Route) => {
    feedReads++;
    const response = await route.fetch(); readReached.resolve(); await readRelease.promise; await route.fulfill({ response });
  };
  await people.route('**/api/research/feed?*', holdRead);
  try {
    await editBob(); await biography.fill('UNSAVED DRAFT SURVIVES SAME OWNER LOGIN');
    await biography.evaluate(input => { input.dataset.draftMarker = 'original-editor'; }); await readReached.promise;
    const aborted = people.waitForEvent('requestfailed', request => new URL(request.url()).pathname === '/api/research/feed');
    const recovered = people.waitForResponse(reply => new URL(reply.url()).pathname === '/api/research/feed');
    const next = await loginBob(); assert.equal(next.draftOwner, previous.draftOwner); assert.notEqual(next.csrfToken, previous.csrfToken);
    await biography.focus(); await resume(); await aborted; readRelease.resolve(); await recovered;
    assert.equal(await biography.inputValue(), 'UNSAVED DRAFT SURVIVES SAME OWNER LOGIN');
    assert.equal(await biography.getAttribute('data-draft-marker'), 'original-editor');
    assert.equal(await biography.evaluate(input => document.activeElement === input), true);
    assert.equal((await ok(auth, 'GET', '/api/session')).account.email, 'bob@example.org');
    await people.getByText('暂时没有动态。关注数学家或定理后，相关进展会出现在这里。', { exact: true }).waitFor();
    assert.ok(feedReads >= 2, 'The cancelled unchanged-URL following feed must reload automatically');
    await people.screenshot({ path: path.join(output, 'same-owner-draft-preserved.png'), fullPage: true });
  } finally { readRelease.resolve(); await people.unroute('**/api/research/feed?*', holdRead); }
  checks.push({ name: phase, passed: true, ownerRetained: true, oldSessionRequestAborted: true });

  phase = 'an accepted old-session write is cancelled and an explicit retry recovers its original receipt once';
  await biography.fill('SAVED BEFORE SESSION ROTATION');
  const writeReached = deferred(), writeRelease = deferred(); let writtenRevision = 0;
  const holdWrite = async (route: Route) => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    const response = await route.fetch(); assert.equal(response.status(), 200); writtenRevision = (await response.json()).item.revision;
    writeReached.resolve(); await writeRelease.promise; await route.fulfill({ response });
  };
  await people.route('**/api/research/profile', holdWrite);
  const before = profileWrites.length;
  try {
    await people.getByRole('button', { name: '保存资料', exact: true }).click(); await writeReached.promise;
    const aborted = people.waitForEvent('requestfailed', request => request.method() === 'PUT' && new URL(request.url()).pathname === '/api/research/profile');
    await loginBob(); await resume(); await aborted; writeRelease.resolve();
    await people.getByRole('button', { name: '保存资料', exact: true }).waitFor();
    assert.equal(await biography.inputValue(), 'SAVED BEFORE SESSION ROTATION');
  } finally { writeRelease.resolve(); await people.unroute('**/api/research/profile', holdWrite); }
  // The saved receipt advanced the profile. Review its new version before retrying the retained intent.
  const latestProfile = people.getByRole('region', { name: '核对最新资料', exact: true });
  await latestProfile.waitFor();
  assert.match(await latestProfile.textContent() ?? '', /SAVED BEFORE SESSION ROTATION/u);
  assert.equal(await biography.inputValue(), 'SAVED BEFORE SESSION ROTATION');
  await latestProfile.getByRole('button', { name: '已核对，保留我的编辑', exact: true }).click();
  const replay = putResponse(); await people.getByRole('button', { name: '保存资料', exact: true }).click(); assert.equal((await replay).status(), 200);
  assert.equal(profileWrites.length, before + 2);
  assert.equal(profileWrites[before].requestId, profileWrites[before + 1].requestId);
  const saved = (await ok(auth, 'GET', '/api/research/session')).profile;
  assert.equal(saved.bio, 'SAVED BEFORE SESSION ROTATION'); assert.equal(saved.revision, writtenRevision);
  assert.equal((await ok(auth, 'GET', '/api/session')).account.email, 'bob@example.org');
  checks.push({ name: phase, passed: true, sameRequestId: true, revisionIncrementedOnce: true });

  phase = 'a write preflight that discovers same-owner relogin keeps input and asks for an explicit retry';
  await biography.fill('RETAINED AFTER PREFLIGHT ROTATION'); await loginBob();
  const writesBeforeConfirmation = profileWrites.length;
  await people.getByRole('button', { name: '保存资料', exact: true }).click();
  await people.getByText('登录状态已更新，请重试。当前输入已保留。', { exact: true }).waitFor();
  assert.equal(profileWrites.length, writesBeforeConfirmation);
  assert.equal(await biography.inputValue(), 'RETAINED AFTER PREFLIGHT ROTATION');
  const confirmed = putResponse(); await people.getByRole('button', { name: '保存资料', exact: true }).click(); assert.equal((await confirmed).status(), 200);
  assert.equal((await ok(auth, 'GET', '/api/research/session')).profile.bio, 'RETAINED AFTER PREFLIGHT ROTATION');
  checks.push({ name: phase, passed: true, staleWriteSent: false });

  phase = 'routine same-session confirmation and a temporary failure retain the existing editor';
  await biography.fill('TEMPORARY NETWORK FAILURE RETAINS THIS DRAFT'); await biography.focus(); await resume();
  assert.equal(await biography.evaluate(input => document.activeElement === input), true);
  const outage = async (route: Route) => route.fulfill({ status: 503, json: { error: 'Temporary session fixture outage' } });
  await people.route('**/api/session', outage);
  try {
    await people.evaluate(() => window.dispatchEvent(new Event('focus')));
    await people.getByText('Temporary session fixture outage', { exact: true }).waitFor();
    assert.equal(await biography.inputValue(), 'TEMPORARY NETWORK FAILURE RETAINS THIS DRAFT'); assert.equal(await biography.isVisible(), false);
  } finally { await people.unroute('**/api/session', outage); }
  await people.getByRole('button', { name: '重新连接', exact: true }).click(); await biography.waitFor();
  assert.equal(await biography.inputValue(), 'TEMPORARY NETWORK FAILURE RETAINS THIS DRAFT');
  assert.equal(await biography.getAttribute('data-draft-marker'), 'original-editor');
  checks.push({ name: phase, passed: true });
  assert.deepEqual(pageErrors, []); assert.deepEqual(external, []); assert.equal(runnerCalls, 0);
} catch (error) { failure = error; await people.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
finally {
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    phase, ...(failure ? { error: String(failure) } : {}), checks, pageErrors, externalRequests: external, runnerCalls,
    realModelCalls: 0, realLeanCalls: 0, realMail: false, interceptedMailCount: mail.length, productionWrites: false,
    disposableFixturesRemoved: true }, null, 2) + '\n');
}
