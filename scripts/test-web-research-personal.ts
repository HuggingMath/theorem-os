#!/usr/bin/env bun
// Temporary loopback accounts, controlled runner and Chromium only; no model, Lean or mail calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { WebStorage } from '../apps/web/storage';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { loadWebSample } from '../apps/web/sample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchAccountDraftResult } from '../apps/web/researchPersonalTypes';
import { freePort, preferFullCollaboration, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/personal');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.access(path.join(staticRoot, 'research.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-personal-browser-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`, sample = loadWebSample()!;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin, THEOREMOS_WEB_STATIC_ROOT: staticRoot,
  THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'alice@example.org,bob@example.org' });
const seed = new WebStorage(dataRoot), accounts = ['alice', 'bob'].map(name => ({ id: crypto.randomUUID(), email: `${name}@example.org`,
  createdAt: new Date().toISOString(), termsAt: new Date().toISOString(), termsVersion: config.auth!.termsVersion }));
for (const account of accounts) seed.saveRecord(['accounts', `${mathDigest(account.email)}.json`], account);
const sessions = [accounts[0], accounts[0], accounts[1]].map(account => ({ id: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''),
  csrf: mathDigest(crypto.randomUUID()), touchedAt: Date.now(), account: { id: account.id, email: account.email } }));
sessions.forEach(session => seed.saveSession(session));
let prohibited = 0, workers = 0;
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Disposable personal research fixture' }; },
  async run(input, send, signal) {
    workers++; const observation = structuredClone(sample.observations.at(-1)!); observation.webRunId = input.id;
    send({ type: 'observation', observation }); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  },
  async check() { prohibited++; throw new Error('No Lean calls in personal draft verification'); },
  async command() { prohibited++; throw new Error('Drafts must never submit runtime commands'); },
  async formalize() { prohibited++; throw new Error('No model calls in personal draft verification'); },
};
const service = createWebService(config, runner, { sample: null, mailer: async () => { prohibited++; throw new Error('No mail in this fixture'); } });
const owner = `account:${accounts[0].id}`;
const provider = config.providers[0];
const run = service.jobs.create(owner, { providerId: provider.id, apiKey: 'sk-disposable-never-used', model: 'fixture-model', effort: 'high',
  environment: sample.run.environment, source: sample.run.source.trim(), task: 'Personal organization and draft fixture', maxTurns: 2, maxRunSeconds: 600,
  workers: 1, coordination: 'independent' }, provider);
for (let attempt = 0; attempt < 80 && !run.observation; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
assert.ok(run.observation);
let project = service.research.projects.create(owner, { requestId: 'project', title: 'My long-term theorem', visibility: 'members' });
project = service.research.projects.addVersion(owner, project.id, { requestId: 'statement', expectedRevision: project.revision,
  statement: 'A reusable addition problem', source: run.source, environment: run.environment });
project = service.research.projects.bindRun(owner, project.id, { requestId: 'binding', expectedRevision: project.revision,
  runId: run.id, statementVersionId: project.versions[0].id, exposure: 'members', grants: { proof: true } });
const browser = await startBrowser(service.server, port), contexts: BrowserContext[] = [], errors: string[] = [], external: string[] = [], checks: object[] = [];
let phase = 'setup', active: Page | undefined;
async function actor(index: number, width: number, language: 'zh' | 'en') {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: language === 'zh' ? 'zh-CN' : 'en-US', reducedMotion: 'reduce' }); contexts.push(context);
  await context.addCookies([{ name: 'theoremos_session', value: sessions[index].id, url: origin }]);
  await preferFullCollaboration(context);
  await context.addInitScript(language => localStorage.setItem('theorem-os.web-locale.v1', language), language);
  await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
  const page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message)); return page;
}
const noOverflow = async (page: Page) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page fits its viewport');
const href = `${origin}/theorems.html?${new URLSearchParams({ id: project.id, version: project.versions[0].id, run: run.id })}`;
const candidateRoot = (page: Page) => page.locator('[data-candidate-composer]');
async function composer(page: Page) {
  await page.goto(href); const root = candidateRoot(page); await root.locator(':scope>summary').click();
  await root.getByRole('combobox', { name: /选择带有源码快照的任务|Select a task with a source snapshot/u }).waitFor(); return root;
}
const responseTo = (page: Page, method: string, pathname: string) => page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === pathname);
try {
  const desktop = await actor(0, 1440, 'zh'), phone = await actor(1, 390, 'en'), other = await actor(2, 390, 'en'); active = desktop;
  phase = 'explicit-account-save-and-uncertain-response';
  const editor = await composer(desktop), sourceChoice = editor.getByRole('combobox').first();
  await sourceChoice.selectOption({ index: 1 });
  const source = editor.getByRole('textbox', { name: '修改后的候选源码', exact: true }), description = editor.getByRole('textbox', { name: '修改说明', exact: true });
  await source.fill(await source.inputValue() + '\n-- saved human draft'); await description.fill('Desktop reasoning version one');
  assert.equal(service.research.projects.detail(owner, project.id).feedback.length, 0);
  const local = editor.locator('[data-human-drafts]>details'); await local.locator(':scope>summary').click();
  let lose = true; const requests: object[] = [];
  await desktop.route('**/api/research/personal/drafts', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    requests.push(route.request().postDataJSON()); const response = await route.fetch();
    if (lose) { lose = false; await route.fulfill({ status: 503, json: { error: 'Fixture save response lost' } }); } else await route.fulfill({ response });
  });
  await local.locator('[data-save-account-draft]').click(); await editor.getByRole('alert').filter({ hasText: 'Fixture save response lost' }).waitFor();
  const savedResponse = responseTo(desktop, 'POST', '/api/research/personal/drafts'); await local.locator('[data-save-account-draft]').click();
  const savedHttp = await savedResponse; assert.equal(savedHttp.status(), 201, await savedHttp.text());
  const first = (await savedHttp.json() as { item: ResearchAccountDraftResult }).item;
  await editor.locator('[data-account-draft-notice]').waitFor(); assert.deepEqual(requests[0], requests[1]); assert.equal(first.draft.revision, 1);
  await desktop.unroute('**/api/research/personal/drafts');
  checks.push({ name: phase, retryIdentityPreserved: true, noFeedbackCreated: true });

  phase = 'phone-restore-and-concurrent-edit-conflict'; active = phone;
  const phoneEditor = await composer(phone), remote = phoneEditor.locator('[data-account-drafts]>details'); await remote.locator(':scope>summary').click();
  await remote.locator('[data-restore-account-draft]').click();
  const phoneText = phoneEditor.getByRole('textbox', { name: 'Change description', exact: true });
  await phone.waitForFunction(() => [...document.querySelectorAll<HTMLTextAreaElement>('[data-candidate-composer] textarea')].some(field => field.value === 'Desktop reasoning version one'));
  assert.equal(await phoneText.inputValue(), 'Desktop reasoning version one');
  await phoneText.fill('Phone alternative argument');
  await description.fill('Desktop concurrent alternative');
  const phoneLocal = phoneEditor.locator('[data-human-drafts]>details'); await phoneLocal.locator(':scope>summary').click();
  await phoneLocal.locator('[data-save-account-draft]').click(); await phoneEditor.locator('[data-account-draft-notice]').waitFor();
  const conflictResponse = responseTo(desktop, 'POST', '/api/research/personal/drafts'); await local.locator('[data-save-account-draft]').click();
  const conflict = (await (await conflictResponse).json() as { item: ResearchAccountDraftResult }).item;
  assert.equal(conflict.conflict, true); assert.equal(conflict.draft.versions.length, 3);
  await editor.locator('[data-account-draft-notice]').filter({ hasText: '两份版本都已保留' }).waitFor();
  assert.equal(service.research.projects.detail(owner, project.id).feedback.length, 0); await noOverflow(phone);
  await phone.screenshot({ path: path.join(output, 'phone-drafts.png'), fullPage: true });
  checks.push({ name: phase, accountSharedAcrossDevices: true, allThreeVersionsPreserved: true, restoreDoesNotSubmit: true });

  phase = 'restoring-retains-local-backup-and-account-isolation'; active = desktop;
  await description.fill('Local unsaved reasoning to preserve');
  const desktopRemote = editor.locator('[data-account-drafts]>details'); await desktopRemote.locator(':scope>summary').click();
  await desktopRemote.locator(`[data-account-draft-version="${first.version.id}"] [data-restore-account-draft]`).click();
  await desktop.waitForFunction(() => [...document.querySelectorAll<HTMLTextAreaElement>('[data-candidate-composer] textarea')].some(field => field.value === 'Desktop reasoning version one'));
  assert.equal(await description.inputValue(), 'Desktop reasoning version one');
  await local.getByText('Local unsaved reasoning to preserve', { exact: false }).waitFor();
  await other.goto(`${origin}/workspace.html?tab=drafts`);
  assert.equal(await other.evaluate(async () => (await (await fetch('/api/research/personal/drafts')).json()).items.length), 0);
  checks.push({ name: phase, localAlternativePreserved: true, otherAccountDraftCount: 0 });

  phase = 'problem-private-organization-across-devices'; active = phone;
  await phone.goto(`${origin}/problem.html?run=${run.id}&project=${project.id}`);
  const organization = phone.locator('[data-personal-problem]'); await organization.locator(':scope>summary').click();
  await organization.locator('[data-personal-pinned]').check(); await organization.locator('[data-personal-status]').selectOption('parked');
  await organization.getByRole('textbox', { name: 'Tags', exact: true }).fill('number theory, next lemma');
  await organization.getByRole('textbox', { name: 'Next time, start here', exact: true }).fill('Complete the final cancellation argument.');
  await organization.locator('[data-save-personal-problem]').click(); await organization.locator('[data-personal-notice]').waitFor();
  assert.equal(run.status, 'running'); assert.equal(service.research.projects.detail(owner, project.id).feedback.length, 0);
  await desktop.goto(origin); await desktop.locator('[data-overview-personal-tools]').waitFor();
  await desktop.locator('[data-overview-organization]').selectOption('parked');
  const card = desktop.locator(`[data-overview-card="project:${project.id}"]`); await card.waitFor();
  await card.getByText('Complete the final cancellation argument.', { exact: false }).waitFor();
  await desktop.locator('[data-overview-tag]').selectOption('next lemma'); await card.waitFor();
  await desktop.locator('[data-overview-sort]').selectOption('organization');
  await noOverflow(desktop); await desktop.screenshot({ path: path.join(output, 'organized-overview.png'), fullPage: true });
  checks.push({ name: phase, pinnedParkedTagsAndNotePersist: true, runStatusUnchanged: true, homepageFiltersAndSort: true });

  phase = 'archived-problem-is-recoverable-and-not-run-acceptance';
  await organization.locator('[data-personal-status]').selectOption('archived'); await organization.locator('[data-save-personal-problem]').click();
  await organization.locator('[data-personal-notice]').waitFor(); await desktop.reload();
  assert.equal(await desktop.locator(`[data-overview-card="project:${project.id}"]`).count(), 0);
  await desktop.locator('[data-overview-organization]').selectOption('archived'); await card.waitFor();
  assert.equal(run.status, 'running'); await noOverflow(phone);
  checks.push({ name: phase, hiddenFromDefaultAndRecoverableInArchive: true });

  phase = 'signed-out-account-draft-keeps-exact-editor-through-login';
  const signedOut = await actor(0, 390, 'en'); active = signedOut; await signedOut.context().clearCookies();
  const restoreParameters = new URLSearchParams({ id: project.id, version: project.versions[0].id, run: run.id,
    task: first.draft.scope.taskId!, taskVersion: first.draft.scope.taskVersion!, commit: first.draft.scope.commit!,
    accountDraft: first.draft.id, draftVersion: first.version.id });
  await signedOut.goto(`${origin}/theorems.html?${restoreParameters}`);
  const signIn = signedOut.locator('[data-account-draft-login]'); await signIn.waitFor();
  const loginTarget = new URL(await signIn.getAttribute('href') ?? '', origin);
  const draftReturn = new URL(loginTarget.searchParams.get('returnTo')!, origin);
  assert.equal(draftReturn.pathname, '/theorems.html');
  for (const [name, value] of restoreParameters) assert.equal(draftReturn.searchParams.get(name), value);
  await signIn.click(); await signedOut.waitForURL(url => url.pathname === '/login.html');
  await signedOut.context().addCookies([{ name: 'theoremos_session', value: sessions[0].id, url: origin }]);
  await signedOut.reload(); await signedOut.waitForURL(url => url.pathname === '/theorems.html');
  const returned = new URL(signedOut.url());
  for (const [name, value] of restoreParameters) assert.equal(returned.searchParams.get(name), value);
  const requestedVersion = signedOut.locator(`[data-account-draft-version="${first.version.id}"][data-requested="true"]`);
  await requestedVersion.locator('[data-restore-account-draft]').click();
  await signedOut.waitForFunction(() => [...document.querySelectorAll<HTMLTextAreaElement>('[data-candidate-composer] textarea')].some(field => field.value === 'Desktop reasoning version one'));
  assert.equal(service.research.projects.detail(owner, project.id).feedback.length, 0); await noOverflow(signedOut);
  checks.push({ name: phase, exactDraftAndVersionRetained: true, frozenTaskRetained: true, restoredWithoutSubmission: true });
  assert.equal(workers, 1); assert.equal(prohibited, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', fixtureOnly: true, checks, workers, prohibited, errors, external }, null, 2));
  console.log(JSON.stringify({ status: 'passed', output, checks: checks.length }));
} catch (cause) {
  await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  const failureState = await active?.evaluate(() => ({ alerts: [...document.querySelectorAll('[role=alert]')].map(node => node.textContent),
    localDrafts: Object.keys(localStorage).filter(key => key.startsWith('theoremos:human-draft')).map(key => JSON.parse(localStorage.getItem(key)!)) })).catch(() => undefined);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', phase, error: String(cause), url: active?.url(), failureState, checks, workers, prohibited, errors, external }, null, 2)); throw cause;
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
