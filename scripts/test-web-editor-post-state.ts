import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { WebStorage } from '../apps/web/storage';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readingRun } from '../tests/helpers/shareReadingFixture';
import { freePort, startBrowser, settled } from '../scripts/web-scenario';
import { enterLean } from '../scripts/web-ui-controls';
import { localeStorageKey } from '../apps/web/i18n';
import { installedLibraryDetail, installedLibraryDirectory } from '../apps/web/installedLibrary';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/post-state-20261111/editor');
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-entry-state-audit-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: data,
  THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'entry-state@example.org',
  THEOREMOS_WEB_PROVIDERS: JSON.stringify([{ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1' }]) });
const storage = new WebStorage(data), account = { id: crypto.randomUUID(), email: 'entry-state@example.org', completionEmail: false,
  createdAt: new Date().toISOString(), termsAt: new Date().toISOString(), termsVersion: config.auth!.termsVersion };
storage.saveRecord(['accounts', `${mathDigest(account.email)}.json`], account);
const session = { id: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''), csrf: mathDigest(crypto.randomUUID()), touchedAt: Date.now(), account: { id: account.id, email: account.email } };
storage.saveSession(session);
const run = readingRun(crypto.randomUUID()), otherRun = readingRun(crypto.randomUUID());
otherRun.source = 'theorem another_problem (n : Nat) : n = n := by rfl\n';
otherRun.title = 'A separate reflexivity problem';
storage.saveRun(`account:${account.id}`, run); storage.saveRun(`account:${account.id}`, otherRun);
let prohibited = 0;
const service = createWebService(config, { async readiness() { return { ready: true, message: 'Disposable editor continuity fixture' }; },
  async run() { prohibited++; throw new Error('Execution prohibited'); }, async formalize() { prohibited++; throw new Error('Models prohibited'); },
  async check() { throw new Error('Automatic precheck blocked; no Lean executed'); } },
  { sample: null, mailer: async () => { prohibited++; throw new Error('Mail prohibited'); } });
const owner = `account:${account.id}`;
const createdProject = service.research.projects.create(owner, { requestId: 'explicit-project', title: 'Explicit project problem' });
const project = service.research.projects.addVersion(owner, createdProject.id, { requestId: 'explicit-statement', expectedRevision: createdProject.revision,
  statement: 'Prove reflexivity for a natural number.', source: otherRun.source, environment: 'standard' });
const statement = project.versions[0];
const installed = installedLibraryDirectory({ q: 'TheoremOS.Probability.Concentration', limit: 1 });
const module = installedLibraryDetail(installed.items[0].file, installed.library.catalogDigest), declaration = module.module.entries[0];
const browser = await startBrowser(service.server, port), checks: object[] = [], errors: string[] = [], external: string[] = [];
let active: Page | undefined, phase = 'setup', failure: unknown;
async function actor(language: 'zh' | 'en', width: number) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', locale: language === 'zh' ? 'zh-CN' : 'en-US' });
  await context.addCookies([{ name: 'theoremos_session', value: session.id, url: origin }]);
  await context.addInitScript(({ language, key }) => localStorage.setItem(key, language), { language, key: localeStorageKey });
  await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message)); active = page;
  return { page, context };
}
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const { page, context } = await actor(language, width);
    phase = `natural-refresh-control-${language}`;
    await page.goto(origin); await page.locator('#formalize-original').waitFor();
    const natural = `Natural draft ${language}: prove the result and retain the assumptions.`;
    await page.locator('#formalize-original').fill(natural); await page.reload(); await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('#formalize-original').inputValue(), natural);
    checks.push({ id: 'natural-refresh-control', language, width, originalAndVisibleModePreserved: true });

    phase = `lean-refresh-${language}`;
    await enterLean(page); const lean = `theorem user_draft_${language} (n : Nat) : n + 0 = n := by\n  sorry\n`;
    await page.locator('#source').fill(lean); await page.locator('#task').fill('Keep this exact Lean draft and continue here.');
    await page.waitForFunction(text => Object.values(sessionStorage).some(raw => { try { return JSON.parse(raw)?.draft?.source === text; } catch { return false; } }), lean);
    await page.reload(); await page.locator('#source').waitFor({ state: 'visible' });
    const after = { mode: await page.locator('body').getAttribute('data-entry'), sourceVisible: await page.locator('#source').isVisible(),
      leanSource: await page.locator('#source').inputValue(), naturalText: await page.locator('#formalize-original').inputValue() };
    assert.equal(after.mode, 'lean'); assert.equal(after.sourceVisible, true); assert.equal(after.leanSource, lean);
    await page.screenshot({ path: path.join(output, `lean-refresh-visible-${language}.png`), fullPage: true });
    assert.equal(await page.locator('#source').inputValue(), lean);
    checks.push({ id: 'E1-lean-draft-resumes-on-refresh', language, width, after, editorVisibleWithoutSwitching: true });

    phase = `account-lean-refresh-${language}`;
    assert.equal(await page.locator('[data-problem-account-drafts]:visible').count(), 0);
    const draft = await page.evaluate(async ({ source, task, title }) => {
      const session = await (await fetch('/api/session')).json();
      const response = await fetch('/api/research/personal/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
        body: JSON.stringify({
          requestId: crypto.randomUUID(), expectedRevision: 0,
          scope: { kind: 'problem', draftKey: crypto.randomUUID() },
          value: { mode: 'lean', draft: { providerId: '', model: '', source, task, maxTurns: '20', maxRunSeconds: '0', workers: '1', effort: 'high', environment: 'mathlib', coordination: 'cooperative', templateId: '' } },
          summary: title, deviceId: 'test-device', deviceName: 'Desktop browser', clientUpdatedAt: new Date().toISOString(),
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()).item;
    }, { source: lean, task: 'Keep this exact Lean draft and continue here.', title: `Lean continuation ${language}` });
    const other = await actor(language, width);
    await other.page.goto(`${origin}/?accountDraft=${draft.draft.id}&draftVersion=${draft.version.id}`);
    await other.page.locator(`[data-problem-draft-version="${draft.version.id}"] [data-restore-problem-draft]`).click();
    await other.page.locator('#source').waitFor({ state: 'visible' }); assert.equal(await other.page.locator('#source').inputValue(), lean);
    assert.equal(await other.page.locator('[data-problem-account-drafts]:visible').count(), 0);
    await other.page.reload(); await other.page.locator('#source').waitFor({ state: 'visible' });
    assert.equal(await other.page.locator('#source').isVisible(), true); assert.equal(await other.page.locator('#source').inputValue(), lean);
    await other.page.screenshot({ path: path.join(output, `account-lean-refresh-visible-${language}.png`), fullPage: true });
    checks.push({ id: 'E1-account-lean-restore-resumes-after-refresh', language, width, restoredVisible: true, afterRefreshMode: 'lean', sourcePreserved: true });
    await other.context.close(); active = page;

    phase = `explicit-project-entry-${language}`;
    await page.goto(`${origin}/?${new URLSearchParams({ researchProject: project.id, statementVersion: statement.id, statementSource: statement.sourceDigest })}`);
    const candidate = page.locator('[data-problem-draft-candidate]');
    await candidate.locator('[data-problem-draft-include]').waitFor(); await page.locator('#formalize-original').waitFor(); await settled(page);
    assert.equal(await page.locator('body').getAttribute('data-entry'), 'natural');
    assert.equal(await candidate.locator('[data-problem-draft-source]').textContent(), statement.source);
    checks.push({ id: 'E1-explicit-project-source-overrides-saved-lean-mode', language, width, fixedSourcePreserved: true });

    await enterLean(page); await page.locator('#source').fill(lean);
    phase = `explicit-library-reference-${language}`;
    await page.goto(`${origin}/?${new URLSearchParams({ libraryModule: module.module.file, libraryCatalog: module.library.catalogDigest, libraryDeclaration: declaration.name })}`);
    await page.locator(`[data-chat-library-reference="${declaration.name}"]`).waitFor(); await page.locator('#formalize-original').waitFor(); await settled(page);
    assert.equal(await page.locator('body').getAttribute('data-entry'), 'natural');
    checks.push({ id: 'E1-explicit-library-reference-overrides-saved-lean-mode', language, width, declaration: declaration.name });

    await enterLean(page); await page.locator('#source').fill(lean);
    phase = `explicit-edited-problem-${language}`;
    const editId = `post-state-independent-${language}`, edited = `Independent explicit question ${language}`;
    await page.goto(`${origin}/?editProblem=${editId}`); await page.locator('[data-chat-return-home]').waitFor();
    await page.locator('#formalize-original').waitFor(); await settled(page);
    assert.equal(await page.locator('body').getAttribute('data-entry'), 'natural');
    await page.locator('#formalize-original').fill(edited); await page.reload(); await page.locator('#formalize-original').waitFor(); await settled(page);
    assert.equal(await page.locator('body').getAttribute('data-entry'), 'natural');
    assert.equal(await page.locator('#formalize-original').inputValue(), edited);
    checks.push({ id: 'E1-explicit-independent-edit-overrides-saved-lean-mode', language, width, afterReloadPreserved: true });

    await page.goto(origin); await page.locator('#formalize-original').waitFor({ state: 'attached' });
    await enterLean(page); await page.locator('#source').fill(lean);
    await page.goto(`${origin}/?entry=statement&template=add-zero&environment=standard&lang=${language}`);
    await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('body').getAttribute('data-entry'), 'natural');
    await page.reload(); await page.locator('#formalize-original').waitFor();
    assert.equal(await page.locator('body').getAttribute('data-entry'), 'natural');
    checks.push({ id: 'E1-explicit-statement-entry-overrides-previous-lean-mode', language, width });

    phase = `organization-save-race-${language}`;
    await page.goto(`${origin}/problem.html?run=${run.id}`);
    let organization = page.locator('[data-personal-problem]'); await organization.locator(':scope > summary').click();
    await organization.locator('[data-save-personal-problem]:enabled').waitFor();
    const label = language === 'zh' ? '下次从这里继续' : 'Next time, start here';
    const note = organization.getByLabel(label, { exact: true });
    const savedText = `Version A ${language}: inspect the next lemma.`, newerText = `Version B ${language}: a new derivation typed while A is saving.`;
    await note.fill(savedText);
    let release!: () => void, routed!: () => void; const gate = new Promise<void>(resolve => release = resolve), reached = new Promise<void>(resolve => routed = resolve);
    const pattern = '**/api/research/personal/problems?runId=*';
    await page.route(pattern, async route => { if (route.request().method() !== 'PUT') { await route.continue(); return; }
      const reply = await route.fetch(); routed(); await gate; await route.fulfill({ response: reply }); });
    await organization.locator('[data-save-personal-problem]').click(); await reached;
    assert.equal(await note.isEnabled(), true); await note.fill(newerText); release();
    await organization.locator('[data-save-personal-problem]:enabled').waitFor(); await settled(page);
    const notice = await organization.locator('[data-personal-notice]').innerText();
    const server = await page.evaluate(async id => (await (await fetch(`/api/research/personal/problems?runId=${id}`)).json()).item, run.id);
    assert.equal(await note.inputValue(), newerText); assert.equal(server.nextNote, savedText);
    assert.match(notice, language === 'zh' ? /还有新修改未保存/ : /new edits are not saved yet/);
    await organization.locator('[data-personal-unsaved]').waitFor();
    await organization.screenshot({ path: path.join(output, `new-edits-after-save-notice-${language}.png`) });
    await page.unroute(pattern); await page.reload(); organization = page.locator('[data-personal-problem]'); await organization.locator(':scope > summary').click();
    await organization.locator('[data-save-personal-problem]:enabled').waitFor(); assert.equal(await organization.getByLabel(label, { exact: true }).inputValue(), newerText);
    await organization.locator('[data-personal-unsaved]').waitFor();
    checks.push({ id: 'N4-save-race-keeps-new-edits-with-accurate-status', language, width, savedSnapshot: savedText, newerUnsavedEdits: newerText, notice, afterReload: newerText });
    await organization.getByLabel(label, { exact: true }).fill(newerText);
    const normalSave = page.waitForResponse(reply => reply.request().method() === 'PUT' && new URL(reply.url()).pathname === '/api/research/personal/problems');
    await organization.locator('[data-save-personal-problem]').click(); assert.equal((await normalSave).status(), 200);
    await organization.locator('[data-save-personal-problem]:enabled').waitFor(); await page.reload(); organization = page.locator('[data-personal-problem]'); await organization.locator(':scope > summary').click();
    await organization.locator('[data-save-personal-problem]:enabled').waitFor(); assert.equal(await organization.getByLabel(label, { exact: true }).inputValue(), newerText);
    assert.equal(await organization.locator('[data-personal-unsaved]').count(), 0);
    checks.push({ id: 'personal-organization-normal-save-control', language, width, savedAndReloaded: true, pendingDraftCleared: true });

    await organization.getByLabel(label, { exact: true }).fill(`Private unfinished note ${language}`);
    await page.goto(`${origin}/problem.html?run=${otherRun.id}`);
    organization = page.locator('[data-personal-problem]'); await organization.locator(':scope > summary').click();
    await organization.locator('[data-save-personal-problem]:enabled').waitFor();
    assert.equal(await organization.getByLabel(label, { exact: true }).inputValue(), '');
    await page.goto(`${origin}/problem.html?run=${run.id}`);
    organization = page.locator('[data-personal-problem]'); await organization.locator(':scope > summary').click();
    await organization.locator('[data-save-personal-problem]:enabled').waitFor();
    assert.equal(await organization.getByLabel(label, { exact: true }).inputValue(), `Private unfinished note ${language}`);
    checks.push({ id: 'N4-drafts-stay-with-their-problem-on-return', language, width, isolated: true });

    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      (window as unknown as { organizationOriginalSetItem: typeof original }).organizationOriginalSetItem = original;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('theorem-os.organization-draft.v1:')) throw new DOMException('Disposable storage failure', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    const unbacked = `Unbacked work ${language}: keep this page until saved.`;
    await organization.getByLabel(label, { exact: true }).fill(unbacked);
    await organization.getByRole('alert').filter({ hasText: language === 'zh' ? '本机备份未保存' : 'local backup could not be saved' }).waitFor();
    const leaving = page.waitForEvent('dialog'), reload = page.reload().catch(() => undefined);
    const dialog = await leaving; assert.equal(dialog.type(), 'beforeunload'); await dialog.dismiss(); await reload;
    assert.equal(await organization.getByLabel(label, { exact: true }).inputValue(), unbacked);
    await organization.screenshot({ path: path.join(output, `unsaved-backup-warning-${language}.png`) });
    checks.push({ id: 'N4-storage-failure-is-visible-and-keeps-page-open', language, width });
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibited, 0);
} catch (error) { failure = error; await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally { await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'probe-failed' : 'completed', phase,
  build: JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8')), checks, errors, external, prohibited,
  realModelCalls: 0, realLeanCalls: 0, realMailCalls: 0, ...(failure ? { error: String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(data, { recursive: true, force: true }); }
if (failure) throw failure;
console.log(`Editor continuity verified ${checks.length} workflows`);
