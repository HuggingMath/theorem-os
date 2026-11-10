#!/usr/bin/env bun
// Disposable local project and login regressions; no model, Lean, Docker or external delivery.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_PARTICIPATION_OUTPUT ?? path.join(root, 'out/web-project-participation');
await fs.access(path.join(root, 'out/web/research.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-project-participation-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const mail: { to: string; text: string }[] = [], errors: string[] = [], external: string[] = [], forbiddenCalls: string[] = [];
const checks: string[] = [], screenshots: string[] = [], directoryReads: string[] = [];
const mark = (label: string) => { checks.push(label); console.log(`PASS ${label}`); };
const forbidden = (name: string): never => { forbiddenCalls.push(name); throw new Error(`Participation cannot invoke runner.${name}`); };
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable project participation fixture' }; },
  async run() { return forbidden('run'); }, async formalize() { return forbidden('formalize'); },
  async check() { return forbidden('check'); }, async command() { return forbidden('command'); }, async explain() { return forbidden('explain'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'bob@example.org,carol@example.org' }), runner,
  { sample: null, captchaAnswer: () => '24680', mailer: async message => { mail.push(message); } });
const password = 'Disposable-participation-only-2026';
async function account(name: string) {
  const email = name.toLowerCase() + '@example.org', captcha = service.auth!.captcha(name);
  await service.auth!.requestCode(name, { email, captchaId: captcha.id, captcha: '24680' });
  const code = mail.findLast(item => item.to === email)?.text.match(/\b\d{6}\b/u)?.[0]; assert.ok(code);
  const value = service.auth!.verifyCode({ email, code });
  await service.auth!.setPassword(email, password, undefined, true);
  const owner = `account:${value.id}`;
  const profile = service.research.projects.saveProfile(owner, { requestId: 'profile', expectedRevision: 0, displayName: name,
    bio: name + ' public biography', fields: ['Algebra'], visibility: 'public' });
  return { owner, profile, email };
}
const bob = await account('Bob'), carol = await account('Carol'), projectOwner = 'participation-owner';
service.research.projects.saveProfile(projectOwner, { requestId: 'owner', expectedRevision: 0, displayName: 'Alice', visibility: 'public' });
const hidden = service.research.projects.saveProfile('participation-hidden', { requestId: 'hidden', expectedRevision: 0,
  displayName: 'PRIVATE_MEMBER_NAME', bio: 'PRIVATE_MEMBER_BIO', visibility: 'private' });
let project = service.research.projects.create(projectOwner, { requestId: 'project', title: '有限和合作研究', fields: ['Algebra'], visibility: 'public' });
for (const [id, role] of [[bob.profile.id, 'collaborator'], [carol.profile.id, 'reader'], [hidden.id, 'reader']] as const) {
  project = service.research.projects.setMember(projectOwner, project.id, id,
    { requestId: `add-${id}`, expectedRevision: project.revision, role });
}
const addVersion = (owner: string, requestId: string) => {
  project = service.research.projects.addVersion(owner, project.id, { requestId, expectedRevision: project.revision,
    statement: `Prove True (${requestId})`, source: `theorem ${requestId} : True := by sorry`, environment: 'standard', confirmation: { confirmed: true } });
  return project.currentStatementVersionId!;
};
const originalVersion = addVersion(projectOwner, 'original_statement');
const ownerFeedback = service.research.projects.submitFeedback(projectOwner, project.id, { requestId: 'owner-feedback', kind: 'discussion',
  text: 'A precise update on the original statement', statementVersionId: originalVersion, visibility: 'public' });
const bobFeedback = service.research.projects.submitFeedback(bob.owner, project.id, { requestId: 'bob-feedback', kind: 'discussion',
  text: 'Bob original contribution', statementVersionId: originalVersion, visibility: 'public' });
project = service.research.projects.detail(projectOwner, project.id);
const contributedVersion = addVersion(bob.owner, 'contributed_statement'); addVersion(projectOwner, 'newest_statement');
const notificationEvent = project.activity.find(event => event.feedbackId === ownerFeedback.id)!;
const oldStatementEvent = project.activity.find(event => event.statementVersionId === originalVersion && event.type === 'statement-created')!;
const feedbackContribution = project.contributions.find(item => item.feedbackId === bobFeedback.id)!;
const statementContribution = project.contributions.find(item => item.statementVersionId === contributedVersion)!;
const chat = crypto.randomUUID(), target = `/theorems.html?${new URLSearchParams({ id: project.id, collection: 'research',
  q: 'finite sums', field: 'Algebra', workbenchChat: chat })}#research-discussion`;
const browser = await startBrowser(service.server, port);
async function context(locale: 'zh' | 'en', width: number) {
  const value = await browser.newContext({ locale: locale === 'zh' ? 'zh-CN' : 'en-US', viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  value.setDefaultTimeout(0); value.setDefaultNavigationTimeout(0);
  await value.addInitScript(({ key, locale }) => {
    try { localStorage.setItem(key, locale); } catch { /* about:blank has no origin storage. */ }
  }, { key: localeStorageKey, locale });
  await value.route(/^https?:\/\//u, async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
    if (url.pathname === '/api/research/people') directoryReads.push(url.href);
    await route.continue();
  });
  value.on('page', page => { page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0); page.on('pageerror', error => errors.push(error.message)); });
  return value;
}
async function shot(page: Page, name: string) {
  await settled(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, name + ' fits viewport');
  await page.screenshot({ path: path.join(output, name), fullPage: true, timeout: 0 }); screenshots.push(name);
}
async function names(page: Page, ownName?: string) {
  const members = page.locator('#research-members'); await members.getByText('Bob', { exact: true }).waitFor({ timeout: 0 });
  await members.getByText('Carol', { exact: true }).waitFor({ timeout: 0 });
  const content = await members.textContent(); assert.ok(content?.includes('Alice'));
  assert.ok(!content?.includes('PRIVATE_MEMBER_NAME')); assert.ok(!content?.includes('PRIVATE_MEMBER_BIO'));
  if (ownName) assert.ok(content?.includes(`${ownName} · ${ownName === 'Carol' ? 'Me' : '我'}`));
}
async function signIn(value: BrowserContext, email: string) {
  const session = await (await value.request.get(origin + '/api/session', { timeout: 0 })).json();
  const response = await value.request.post(origin + '/api/auth/password/login', { timeout: 0,
    headers: { 'X-CSRF-Token': session.csrfToken }, data: { email, password } });
  assert.equal(response.status(), 200);
}
let failure: unknown;
try {
  const anonymous = await context('zh', 390), page = await anonymous.newPage();
  await page.goto(origin + target, { timeout: 0 });
  const login = page.locator('[data-discussion-login]'); await login.waitFor({ timeout: 0 });
  const current = new URL(page.url()), returnTo = current.pathname + current.search + '#research-discussion';
  const href = new URL(await login.getAttribute('href') ?? '', origin);
  assert.equal(href.searchParams.get('returnTo'), returnTo); assert.ok(returnTo.includes('workbenchChat=' + chat));
  assert.equal(await page.locator('#research-discussion').getByText('当前账号只有查看权限。', { exact: true }).count(), 0);
  await shot(page, 'zh-390-anonymous-discussion.png'); mark('anonymous discussion explains sign-in and preserves exact project, filters, workbench and discussion return');
  await names(page); await page.locator('a[href="#research-members"]').click();
  await shot(page, 'zh-390-anonymous-members.png'); mark('public visitors see public member names without private profile details or directory requests');
  await login.click(); await page.locator('#use-password').click();
  await page.locator('#password-email').fill(bob.email); await page.locator('#login-password').fill(password);
  await page.locator('#password-submit').click();
  await page.waitForURL(url => url.pathname + url.search + url.hash === returnTo, { timeout: 0 });
  await page.locator('#research-discussion').getByRole('textbox', { name: '讨论内容', exact: true }).waitFor({ timeout: 0 }); await settled(page);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('#research-discussion') !== null), true);
  assert.equal(await page.locator('[data-discussion-login]').count(), 0);
  const position = await page.locator('#research-discussion').boundingBox(); assert.ok(position && position.y >= 0 && position.y < 500);
  await shot(page, 'zh-390-login-return-discussion.png'); mark('real password login returns to the exact discussion and focuses the newly available editor');
  await names(page, 'Bob'); await page.locator('a[href="#research-members"]').click();
  await page.setViewportSize({ width: 1440, height: 1000 }); await shot(page, 'zh-1440-collaborator-members.png');
  mark('collaborators identify public peers and themselves without administrator directory access');
  const reader = await context('en', 390); await signIn(reader, carol.email);
  const readerPage = await reader.newPage(); await readerPage.goto(origin + target.replace('#research-discussion', '#research-members'), { timeout: 0 });
  await names(readerPage, 'Carol'); await readerPage.locator('a[href="#research-members"]').click();
  await shot(readerPage, 'en-390-reader-members.png'); mark('read-only members see public peer names, own identity and Reader role');
  assert.ok((await readerPage.locator('#research-members').textContent())?.includes('Reader'));
  assert.deepEqual(directoryReads, []);

  const peopleParameters = new URLSearchParams({ id: bob.profile.id, q: 'finite sums', field: 'Algebra', offset: '12', workbenchChat: chat, inbox: 'progress' });
  const peopleSource = `/people.html?${peopleParameters}`, updatesSource = peopleSource + '#collaboration-inbox';
  await page.goto(origin + updatesSource, { timeout: 0 });
  const update = page.locator(`#collaboration-inbox [data-inbox-item="update:${notificationEvent.id}"] a.button`);
  await update.waitFor({ timeout: 0 });
  let destination = new URL(await update.getAttribute('href') ?? '', origin);
  assert.equal(destination.searchParams.get('id'), project.id); assert.equal(destination.searchParams.get('version'), originalVersion);
  assert.equal(destination.searchParams.get('workbenchChat'), chat); assert.equal(destination.hash, `#feedback-${ownerFeedback.id}`);
  assert.equal(destination.searchParams.get('peopleReturn'), updatesSource);
  await update.click(); await page.locator(`#feedback-${ownerFeedback.id}`).waitFor({ timeout: 0 }); await settled(page);
  assert.equal(await page.getByRole('combobox', { name: '当前查看的陈述', exact: true }).inputValue(), originalVersion);
  assert.equal(await page.evaluate(() => document.activeElement?.id), `feedback-${ownerFeedback.id}`);
  await page.reload({ timeout: 0 }); await page.locator('[data-research-people-return]').waitFor({ timeout: 0 });
  assert.equal(await page.locator('[data-research-people-return]').getAttribute('href'), updatesSource);
  await shot(page, 'zh-1440-exact-update-return.png');
  await page.locator('[data-research-people-return]').click(); await page.waitForURL(origin + updatesSource, { timeout: 0 });
  await page.locator(`#collaboration-inbox [data-inbox-item="update:${notificationEvent.id}"]`).waitFor({ timeout: 0 });
  mark('unified inbox updates open the exact older statement and feedback, with a refresh-safe return to the original filtered updates');

  const contribution = page.locator(`[data-research-contribution="${feedbackContribution.id}"]`);
  await contribution.waitFor({ timeout: 0 }); destination = new URL(await contribution.getAttribute('href') ?? '', origin);
  assert.equal(destination.hash, `#feedback-${bobFeedback.id}`); assert.equal(destination.searchParams.get('peopleReturn'), peopleSource + '#research-contributions');
  await contribution.click(); await page.locator(`#feedback-${bobFeedback.id}`).waitFor({ timeout: 0 });
  await page.locator('[data-research-people-return]').click(); await page.waitForURL(origin + peopleSource + '#research-contributions', { timeout: 0 });
  const statementLink = page.locator(`[data-research-contribution="${statementContribution.id}"]`); await statementLink.waitFor({ timeout: 0 });
  destination = new URL(await statementLink.getAttribute('href') ?? '', origin);
  assert.equal(destination.searchParams.get('version'), contributedVersion); assert.equal(destination.hash, '#statement-versions');
  await statementLink.click();
  await page.getByRole('combobox', { name: '当前查看的陈述', exact: true }).waitFor({ timeout: 0 });
  assert.equal(await page.getByRole('combobox', { name: '当前查看的陈述', exact: true }).inputValue(), contributedVersion);
  await page.locator('[data-research-people-return]').click(); await page.waitForURL(origin + peopleSource + '#research-contributions', { timeout: 0 });
  mark('feedback and formalization contributions open their own precise records instead of the newest project state');

  const feed = page.locator('#research-feed'); await feed.getByRole('textbox', { name: '按领域筛选', exact: true }).fill('Algebra'); await settled(page);
  const activityLink = feed.locator(`[data-research-feed-event="${oldStatementEvent.id}"] p a`); await activityLink.waitFor({ timeout: 0 });
  destination = new URL(await activityLink.getAttribute('href') ?? '', origin);
  assert.equal(destination.searchParams.get('version'), originalVersion); assert.equal(destination.hash, '#statement-versions');
  const feedSource = new URL(destination.searchParams.get('peopleReturn')!, origin);
  assert.equal(feedSource.searchParams.get('feedField'), 'Algebra'); assert.equal(feedSource.hash, '#research-feed');
  await activityLink.click(); await page.locator('[data-research-people-return]').waitFor({ timeout: 0 });
  await page.locator('[data-research-people-return]').click(); await page.waitForURL(feedSource.href, { timeout: 0 });
  await page.locator('#research-feed').getByRole('textbox', { name: '按领域筛选', exact: true }).waitFor({ timeout: 0 });
  assert.equal(await page.locator('#research-feed').getByRole('textbox', { name: '按领域筛选', exact: true }).inputValue(), 'Algebra');
  await shot(page, 'zh-1440-return-to-filtered-feed.png');
  mark('activity opens its precise statement and returns to the source feed with its field and workbench context');

  await page.goto(`${origin}/people.html?${new URLSearchParams({ id: carol.profile.id, workbenchChat: chat })}`, { timeout: 0 });
  await page.locator(`[data-add-researcher="${carol.profile.id}"]`).click();
  const createLink = page.locator('[data-researcher-project-picker]').getByRole('link', { name: '创建题目 →', exact: true });
  await createLink.waitFor({ timeout: 0 }); const createTarget = new URL(await createLink.getAttribute('href') ?? '', origin);
  assert.equal(createTarget.searchParams.get('create'), '1'); assert.equal(createTarget.searchParams.get('addResearcher'), carol.profile.id);
  assert.equal(createTarget.searchParams.get('workbenchChat'), chat);
  assert.equal(service.research.projects.list(bob.owner, { author: bob.profile.id }).items.filter(item => item.permissions.manage).length, 0);

  const creatorContext = await context('zh', 390), creator = await creatorContext.newPage();
  await creator.goto(createTarget.href, { timeout: 0 });
  const createLogin = creator.getByRole('link', { name: '登录后创建定理', exact: true }); await createLogin.waitFor({ timeout: 0 });
  const createReturn = new URL(await createLogin.getAttribute('href') ?? '', origin).searchParams.get('returnTo');
  assert.ok(createReturn); const createReturnUrl = new URL(createReturn, origin);
  assert.equal(createReturnUrl.pathname, createTarget.pathname);
  assert.deepEqual([...createReturnUrl.searchParams].sort(), [...createTarget.searchParams].sort());
  await createLogin.click(); await creator.locator('#use-password').click();
  await creator.locator('#password-email').fill(bob.email); await creator.locator('#login-password').fill(password);
  await creator.locator('#password-submit').click();
  await creator.waitForURL(url => url.searchParams.get('create') === '1' && url.searchParams.get('addResearcher') === carol.profile.id, { timeout: 0 });
  await creator.getByRole('textbox', { name: '定理名称', exact: true }).fill('Create first, review Carol membership next');
  await creator.getByRole('textbox', { name: '研究描述', exact: true }).fill('A local fixture for explicit member confirmation');
  await creator.getByRole('button', { name: '创建定理', exact: true }).click();
  await creator.waitForURL(url => url.pathname === '/theorems.html' && Boolean(url.searchParams.get('id')) && url.hash === '#research-members', { timeout: 0 });
  const createdId = new URL(creator.url()).searchParams.get('id')!;
  const memberInput = creator.locator('[data-project-member-person]'); await memberInput.waitFor({ timeout: 0 }); await settled(creator);
  assert.equal(await memberInput.inputValue(), carol.profile.id); assert.equal(new URL(creator.url()).searchParams.get('workbenchChat'), chat);
  assert.equal(await memberInput.evaluate(node => node === document.activeElement), true);
  assert.deepEqual(service.research.projects.detail(bob.owner, createdId).members, []);
  await creator.reload({ timeout: 0 }); await creator.locator('[data-project-member-person]').waitFor({ timeout: 0 });
  assert.equal(await creator.locator('[data-project-member-person]').inputValue(), carol.profile.id);
  assert.deepEqual(service.research.projects.detail(bob.owner, createdId).members, []);
  await shot(creator, 'zh-390-create-with-prefilled-member.png');
  mark('the no-project path carries its chosen researcher through real login, creation and refresh into the focused member form without adding them');
  const memberReceipt = creator.waitForResponse(response => response.request().method() === 'PUT' &&
    new URL(response.url()).pathname === `/api/research/theorems/${createdId}/members/${carol.profile.id}`, { timeout: 0 });
  await creator.locator('[data-project-member-form]').getByRole('button', { name: '保存成员', exact: true }).click();
  assert.equal((await memberReceipt).status(), 200);
  await creator.waitForFunction(() => (document.querySelector('[data-project-member-person]') as HTMLInputElement)?.value === '');
  assert.deepEqual(service.research.projects.detail(bob.owner, createdId).members, [{ researcherId: carol.profile.id, role: 'collaborator' }]);
  assert.equal(new URL(creator.url()).searchParams.has('addResearcher'), false);
  mark('only explicit Save member adds the chosen collaborator and clears the completed prefill intent');
  await creatorContext.close();
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(forbiddenCalls, []);
  await reader.close(); await anonymous.close();
} catch (error) { failure = error; }
finally {
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    checks, screenshots, errors, external, forbiddenCalls, directoryReads, executionDeadline: null, browserTimeouts: 0,
    realModelCalls: 0, realLeanProcesses: 0, temporaryDataRemoved: true,
    ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) }, null, 2) + '\n');
}
if (failure) throw failure;
console.log(JSON.stringify({ status: 'passed', checks: checks.length, screenshots: screenshots.length, output }));
