#!/usr/bin/env bun
// Disposable loopback fixtures only; mail is captured in memory and no model or Lean process is called.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { WebResearchAssets } from '../apps/web/researchAssets';
import type { WebRunner } from '../apps/web/runner';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { readingRun, readingCommit, readingProof, readingEnvironment } from '../tests/helpers/shareReadingFixture';
import { freePort, preferFullCollaboration, settled, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/research-discovery-invites');
await fs.access(path.join(root, 'out/web/invite.html')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-browser-discovery-invites-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const mail: { to: string; text: string }[] = [], errors: string[] = [], external: string[] = [], checks: object[] = [];
let recordedRuns = 0, runtimeCalls = 0;
const forbidden = async () => { runtimeCalls++; throw new Error('Discovery and invitations must not call a runtime'); };
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Recorded discovery fixture' }; },
  async run(input, send) {
    recordedRuns++; const record = readingRun(input.id);
    record.observation!.inspection.configuration.environmentDigest = readingEnvironment;
    send({ type: 'observation', observation: record.observation! });
    send({ type: 'result', result: record.result! });
  }, check: forbidden, command: forbidden };
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:',
  THEOREMOS_WEB_ALLOWLIST: ['owner-1440', 'peer-1440', 'owner-390', 'peer-390'].map(name => `${name}@example.org`).join(',') }), runner,
{ sample: null, mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
const fixtures = new WebResearchAssets(service.storage, { identity: owner => service.research.projects.identity(owner),
  async resolveMathematics(_owner, source) {
    const environment = source.kind === 'run' && source.runId.includes('mathlib') ? 'mathlib' : 'standard';
    return { environment, environmentDigest: getLeanTaskEnvironment(environment).dependencyDigest,
      declarations: [{ name: 'Shared.duplicate', type: '∀ n : Nat, duplicate n = n + n', file: 'Submission/Library/Shared.lean' }],
      pack: { schema: 'theorem-os.library-pack.v1', modules: [{ file: 'Submission/Library/Shared.lean', source: readingProof,
        origin: { kind: 'run', runId: 'recorded-publication', commit: readingCommit, file: 'Submission.lean' } }] } };
  }, async validateMathematics() { return { passed: true, receiptRefs: ['fixture-recorded-publication'] }; } });
const browser = await startBrowser(service.server, port);
let active: Page | undefined, phase = 'setup';
async function context(width: number, language: 'zh' | 'en') {
  const actor = await browser.newContext({ viewport: { width, height: 1000 }, locale: language === 'zh' ? 'zh-CN' : 'en-US', reducedMotion: 'reduce' });
  await preferFullCollaboration(actor);
  await actor.addInitScript(value => { try { localStorage.setItem('theorem-os.web-locale.v1', value); } catch {} }, language);
  actor.on('page', page => { page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message)); });
  await actor.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
  });
  return actor;
}
async function login(page: Page, email: string) {
  await page.locator('#send-code:enabled').waitFor();
  await page.locator('#login-email').fill(email); await page.locator('#login-captcha').fill('24680');
  if (await page.locator('#accept-terms').isVisible()) await page.locator('#accept-terms').check();
  await page.locator('#send-code').click(); await page.locator('#code-step:not([hidden])').waitFor();
  const code = mail.findLast(item => item.to === email)?.text.match(/\b\d{6}\b/u)?.[0]; assert.ok(code);
  await page.locator('#login-code').fill(code); await page.locator('#verify-code').click();
  await page.waitForURL(url => url.pathname !== '/login.html');
  return `account:${service.auth!.getAccount(email)!.id}`;
}
async function publish(owner: string, environment: 'standard' | 'mathlib', width: number) {
  const asset = fixtures.create(owner, { requestId: `${environment}-${width}`, type: 'mathematics', name: `Duplicate ${environment} ${width}`,
    description: 'Unfold duplicate for natural numbers.', area: 'algebra', content: { source: { kind: 'run', runId: `${environment}-publication`, commit: readingCommit } } });
  const preview = await fixtures.preview(owner, asset.id), queued = await fixtures.publish(owner, asset.id,
    { requestId: `publish-${environment}-${width}`, expectedRevision: asset.revision, previewDigest: preview.previewDigest, version: 'v1', license: 'MIT', visibility: 'public' });
  const complete = await fixtures.waitForPublication(owner, queued.id); assert.equal(complete.status, 'completed', complete.reason); return asset;
}
async function noOverflow(page: Page, label: string) {
  await settled(page);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} overflows the viewport`);
}
try {
  for (let index = 0; index < 105; index++) service.research.projects.saveProfile(`fixture-directory-${index}`,
    { requestId: 'profile', expectedRevision: 0, displayName: `Directory ${String(index).padStart(3, '0')}`, visibility: 'public' });
  const farColleague = service.research.projects.saveProfile('fixture-directory-last',
    { requestId: 'profile', expectedRevision: 0, displayName: 'Zebra colleague beyond first hundred', visibility: 'public' });
  for (const [width, language] of [[1440, 'zh'], [390, 'en']] as const) {
    const tx = (zh: string, en: string) => language === 'zh' ? zh : en;
    const ownerContext = await context(width, language), peerContext = await context(width, language), guestContext = await context(width, language);
    const page = await ownerContext.newPage(), peer = await peerContext.newPage(), guest = await guestContext.newPage(); active = page;
    phase = `owner-login-${width}`; await page.goto(`${origin}/login.html?returnTo=library&lang=${language}`);
    const owner = await login(page, `owner-${width}@example.org`);
    service.research.projects.saveProfile(owner, { requestId: 'profile', expectedRevision: 0, displayName: `Private owner ${width}`, visibility: 'private' });
    service.auth!.setCompletionEmail(`owner-${width}@example.org`, false);
    const run = service.jobs.create(owner, { providerId: 'openai', apiKey: 'sk-DISPOSABLE-DISCOVERY-FIXTURE', model: 'fixture-no-model', effort: 'high', environment: 'standard',
      source: readingProof.replace('rw [duplicate_eq]', 'sorry').trim(), task: 'Recorded duplicate identity', maxTurns: 1, maxRunSeconds: 30, workers: 1, coordination: 'independent' },
    { id: 'openai', name: 'Fixture', baseUrl: 'http://127.0.0.1/never-called' });
    for (let attempt = 0; attempt < 30 && run.status !== 'completed'; attempt++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(run.status, 'completed');
    let project = service.research.projects.create(owner, { requestId: 'project', title: `Duplicate research ${width}`, visibility: 'private' });
    project = service.research.projects.addVersion(owner, project.id, { requestId: 'statement', expectedRevision: project.revision, statement: 'Duplicate identity', source: run.source, environment: 'standard' });
    project = service.research.projects.bindRun(owner, project.id, { requestId: 'bind', expectedRevision: project.revision,
      runId: run.id, statementVersionId: project.versions[0].id, exposure: 'members' });
    const before = JSON.stringify(run), originalGrants = structuredClone(project.runs[0].grants);
    const standard = await publish(owner, 'standard', width), mathlib = await publish(owner, 'mathlib', width);
    const task = run.observation!.inspection.tasks.find(item => item.id === 'normalization')!;
    const entry = new URLSearchParams({ run: run.id, project: project.id, task: task.id, taskVersion: task.version, commit: readingCommit, lang: language });
    phase = `task-discovery-${width}`; await page.goto(`${origin}/library.html?${entry}`);
    const discovery = page.locator('[data-library-discovery]'); await discovery.waitFor();
    await discovery.getByRole('heading', { name: tx('这一步已有的前提', 'Premises recorded for this step'), exact: true }).waitFor();
    await discovery.locator('.katex').first().waitFor();
    assert.equal(await page.locator('[data-library-environment]').inputValue(), 'target');
    await page.locator(`[data-library-match="${standard.id}"]`).waitFor();
    assert.equal(await page.locator(`[data-library-match="${mathlib.id}"]`).count(), 0, 'Mathlib asset stays outside the standard task environment');
    await page.locator(`[data-library-match="${standard.id}"]`).getByText(/Shared\.duplicate/u).waitFor();
    await discovery.getByRole('button', { name: 'duplicate', exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('q') === 'duplicate');
    assert.equal(new URL(page.url()).searchParams.get('q'), 'duplicate');
    await page.locator('[data-library-environment]').selectOption('');
    await page.locator(`[data-library-match="${mathlib.id}"]`).waitFor();
    await page.waitForURL(url => url.searchParams.get('environment') === 'all');
    assert.equal(new URL(page.url()).searchParams.get('environment'), 'all');
    await noOverflow(page, `Library ${width}`);
    await page.screenshot({ path: path.join(output, `discovery-${width}-${language}.png`), fullPage: true });
    await page.locator('.research-directory-card').getByRole('link', { name: standard.name, exact: true }).click();
    await page.getByRole('heading', { name: standard.name, exact: true }).waitFor();
    for (const [key, value] of entry) assert.equal(new URL(page.url()).searchParams.get(key), value);
    assert.equal(new URL(page.url()).searchParams.get('q'), 'duplicate');
    await page.reload(); await discovery.waitFor(); assert.equal(new URL(page.url()).searchParams.get('environment'), 'all');
    const returnHref = new URL((await page.locator('[data-return-library-target]').getAttribute('href'))!, origin);
    for (const key of ['run', 'project', 'task', 'taskVersion', 'commit']) assert.equal(returnHref.searchParams.get(key), entry.get(key));
    await page.locator('.research-breadcrumb a').click(); await discovery.waitFor();
    assert.equal(await page.locator('[data-library-environment]').inputValue(), '');
    const rememberedLibrary = page.url(), savedCookies = await ownerContext.cookies(origin);
    await page.goto('about:blank'); await ownerContext.clearCookies(); await page.goto(rememberedLibrary);
    await page.locator('[data-library-discovery-login]').click(); await page.locator('#send-code:enabled').waitFor();
    const loginReturn = new URL(new URL(page.url()).searchParams.get('returnTo')!, origin);
    assert.equal(loginReturn.pathname, '/library.html');
    assert.equal(loginReturn.searchParams.get('q'), 'duplicate'); assert.equal(loginReturn.searchParams.get('environment'), 'all');
    await ownerContext.addCookies(savedCookies); await page.reload(); await page.waitForURL(url => url.pathname === '/library.html');
    await discovery.waitFor(); assert.equal(new URL(page.url()).searchParams.get('environment'), 'all');
    assert.equal(new URL(page.url()).searchParams.get('taskVersion'), task.version);

    phase = `invitation-owner-${width}`; await page.goto(`${origin}/theorems.html?id=${project.id}&lang=${language}`);
    const membership = page.locator('#collaboration-members'); await membership.waitFor();
    await membership.getByText(tx('邀请同行参与', 'Invite a colleague'), { exact: true }).click();
    const colleagueSearch = membership.getByRole('searchbox'); await colleagueSearch.fill('Zebra'); await colleagueSearch.press('Enter');
    const colleagueSelect = membership.getByRole('combobox', { name: tx('选择数学家', 'Choose a mathematician'), exact: true });
    await colleagueSelect.locator(`option[value="${farColleague.id}"]`).waitFor({ state: 'attached' });
    await membership.getByText(tx('用链接邀请同事', 'Invite a colleague with a link'), { exact: true }).click();
    const invitations = membership.locator('[data-invitation-links]'), create = invitations.locator('[data-create-invitation-link]');
    assert.equal(await create.isDisabled(), true); await invitations.locator('[data-confirm-invitation-link]').check(); await create.click();
    const address = invitations.locator('.research-invitation-address').first(); await address.waitFor(); const href = await address.inputValue();
    await invitations.locator('[data-copy-invitation-link]').first().click();
    await noOverflow(page, `Invitation management ${width}`);
    const token = new URL(href).searchParams.get('invite')!; assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
    phase = `invite-registration-${width}`; active = peer; await peer.goto(href);
    await peer.getByRole('heading', { name: project.title, exact: true }).waitFor();
    await peer.getByText(`Private owner ${width}`, { exact: false }).waitFor();
    assert.equal(await peer.locator('[data-accept-invitation-link]').count(), 0);
    await noOverflow(peer, `Invitation preview ${width}`);
    await peer.screenshot({ path: path.join(output, `invite-preview-${width}-${language}.png`), fullPage: true });
    await peer.locator('[data-invitation-login]').click(); await peer.locator('#send-code:enabled').waitFor();
    assert.equal(new URL(peer.url()).searchParams.get('invite'), token);
    const peerOwner = await login(peer, `peer-${width}@example.org`);
    assert.equal(new URL(peer.url()).pathname, '/invite.html'); assert.equal(new URL(peer.url()).searchParams.get('invite'), token);
    service.research.projects.saveProfile(peerOwner, { requestId: 'profile', expectedRevision: 0, displayName: `Private colleague ${width}`, visibility: 'private' });
    const accept = peer.locator('[data-accept-invitation-link]'); await accept.waitFor(); assert.equal(await accept.isDisabled(), true);
    await peer.locator('[data-confirm-invitation-accept]').check(); await accept.click(); await peer.locator('[data-invitation-member]').waitFor();
    const joined = service.research.projects.detail(owner, project.id);
    assert.equal(joined.members.find(item => item.researcherId === service.research.projects.identity(peerOwner))?.role, 'reader');
    assert.equal(joined.visibility, 'members'); assert.deepEqual(joined.runs[0].grants, originalGrants);
    assert.equal(service.research.projects.directory('public', { q: `Private colleague ${width}` }).items.length, 0);
    await peer.locator('[data-open-invited-project]').click(); await peer.waitForURL(url => url.pathname === '/theorems.html');
    await peer.getByRole('heading', { name: project.title, exact: true }).waitFor();
    await guest.goto(href); await guest.locator('[data-invitation-unavailable]').waitFor();
    assert.equal(await guest.getByRole('heading', { name: project.title, exact: true }).count(), 0, 'Used link reveals no project details to another recipient');
    active = page; await page.reload(); await membership.waitFor();
    await membership.getByText(tx('用链接邀请同事', 'Invite a colleague with a link'), { exact: true }).click();
    await invitations.locator('[data-confirm-invitation-link]').check(); await create.click(); await address.waitFor();
    const revokedHref = await address.inputValue(); assert.notEqual(revokedHref, href);
    await invitations.locator('[data-revoke-invitation-link]').click(); await address.waitFor({ state: 'detached' });
    await guest.goto(revokedHref); await guest.locator('[data-invitation-unavailable]').filter({ hasText: tx('撤销', 'revoked') }).waitFor();
    assert.equal(JSON.stringify(run), before, 'Discovery and membership leave the recorded run unchanged');
    checks.push({ width, language, exactGoalAndPremises: true, environmentFilter: true, literalMatchReasons: true, editableKeywords: true,
      detailReloadAndLoginKeepContext: true, directoryBeyondFirstHundred: true, explicitPrivateProfileRegistrationAndAcceptance: true,
      singleUseAndRevocation: true, runtimeGrantsUnchanged: true, runUnchanged: true });
    await Promise.all([ownerContext.close(), peerContext.close(), guestContext.close()]); active = undefined;
    console.log(`PASS discovery and invitations ${width} ${language}`);
  }
  assert.equal(runtimeCalls, 0); assert.equal(recordedRuns, 2); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', fixtureOnly: true, checks, recordedRuns, runtimeCalls, capturedMail: mail.length, errors, external }, null, 2));
  console.log(JSON.stringify({ status: 'passed', output, scenarios: checks.length }));
} catch (error) {
  await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  const state = await active?.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(-12000) })).catch(() => undefined);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', phase, error: String(error), state, checks, errors, external }, null, 2)); throw error;
} finally { await browser.close(); await fixtures.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
