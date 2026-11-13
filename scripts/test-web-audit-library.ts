#!/usr/bin/env bun
// Library audit regressions. Disposable email accounts and a fake runner; no model, Lean or real mail.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebSession } from '../apps/web/shared';
import type { FrozenResearchConfiguration, ResearchAsset, ResearchPublication, ResearchSkillDraft } from '../apps/web/researchAssetTypes';
import { freePort, ready, startBrowser } from './web-scenario';
import { clickWorkbenchAction } from './web-ui-controls';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-audit-library');
await fs.access(path.join(root, 'out/web/research.js')).catch(() => { throw new Error('Run bun run build:web before the Library audit check.'); });
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-library-audit-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const runtimeCalls: string[] = [], mail: { to: string; text: string }[] = [];
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable Library browser fixture' }; },
  async run() { runtimeCalls.push('run'); throw new Error('Library preparation must not start a worker'); },
  async check() { runtimeCalls.push('check'); throw new Error('Library preparation must not compile Lean'); },
  async formalize() { runtimeCalls.push('formalize'); throw new Error('Library preparation must not call a model'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:',
  THEOREMOS_WEB_ALLOWLIST: 'alice@example.org,bob@example.org' }), runner,
{ mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680', sample: null });
const checks: { name: string; elapsedMs: number }[] = [], errors: string[] = [], external: string[] = [];
const requests: { method: string; pathname: string }[] = [];
const configurations: { environment?: string }[] = [];
let browser: Browser | undefined, page: Page | undefined, currentCheck = 'sign in', failure: unknown;
const originalInstructions = 'List every premise before proving the target.';

async function http<T>(method: string, pathname: string, input?: unknown): Promise<T> {
  return page!.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Fixture HTTP ${response.status}: ${payload.error}`);
    return payload;
  }, { method, pathname, input }) as Promise<T>;
}
async function signIn(email: string) {
  await page!.locator('#send-code:enabled').waitFor();
  await page!.fill('#login-email', email); await page!.fill('#login-captcha', '24680');
  if (await page!.locator('#accept-terms').isVisible()) await page!.locator('#accept-terms').check();
  await page!.click('#send-code'); await page!.locator('#code-step:not([hidden])').waitFor();
  const code = mail.findLast(message => message.to === email)?.text.match(/\b\d{6}\b/u)?.[0];
  assert.ok(code, `The stub mailer received the code for ${email}`);
  await page!.fill('#login-code', code); await page!.click('#verify-code');
  await page!.waitForURL(url => url.origin === origin && url.pathname === '/');
  await ready(page!);
  assert.equal(await page!.locator('#open-account').getAttribute('title'), email);
}
async function check(name: string, run: () => Promise<void>) {
  currentCheck = name; const started = performance.now();
  await run(); assert.deepEqual(runtimeCalls, [], 'Library preparation never invokes the runtime');
  checks.push({ name, elapsedMs: Math.round(performance.now() - started) }); console.log(`PASS ${name}`);
}

try {
  browser = await startBrowser(service.server, port);
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/')) requests.push({ method: request.method(), pathname });
    if (request.method() === 'POST' && pathname === '/api/research/configuration') configurations.push(request.postDataJSON());
  });
  await page.goto(origin); await page.waitForURL(/\/login\.html/u); await signIn('alice@example.org');
  const alice = await http<{ researcherId: string }>('GET', '/api/research/session');

  await check('C01 create: collapsing and reopening preserves the unsaved Skill', async () => {
    await page!.goto(`${origin}/library.html`);
    await page!.getByRole('button', { name: '创建成果 / 工具', exact: true }).click();
    const creator = page!.locator('.research-panel').filter({ has: page!.getByRole('heading', { name: '创建草稿', exact: true }) });
    await creator.getByRole('combobox', { name: '内容类型', exact: true }).selectOption('skill');
    await creator.getByLabel('名称', { exact: true }).fill('Unsent reasoning Skill');
    await creator.getByLabel('适用情境与执行要求', { exact: true }).fill('Keep every premise explicit.\nDerive each transformation from the preceding claim.');
    await creator.getByLabel('执行步骤，每行一步', { exact: true }).fill('List the assumptions\nConnect each step to the next');
    const writeStart = requests.length;
    await page!.getByRole('button', { name: '收起创建表单', exact: true }).click();
    await page!.getByRole('button', { name: '创建成果 / 工具', exact: true }).click();
    assert.equal(await creator.getByRole('combobox', { name: '内容类型', exact: true }).inputValue(), 'skill');
    assert.equal(await creator.getByLabel('名称', { exact: true }).inputValue(), 'Unsent reasoning Skill');
    assert.equal(await creator.getByLabel('适用情境与执行要求', { exact: true }).inputValue(), 'Keep every premise explicit.\nDerive each transformation from the preceding claim.');
    assert.equal(await creator.getByLabel('执行步骤，每行一步', { exact: true }).inputValue(), 'List the assumptions\nConnect each step to the next');
    assert.deepEqual(requests.slice(writeStart).filter(request => request.method !== 'GET' && request.pathname === '/api/research/library'), [], 'Collapsing does not save or create an asset');
    await page!.screenshot({ path: path.join(output, 'creator-reopened.png'), fullPage: true });
  });

  const { item: asset } = await http<{ item: ResearchAsset }>('POST', '/api/research/library', { requestId: crypto.randomUUID(),
    type: 'skill', name: 'Alice private reasoning Skill', description: 'Disposable Library audit fixture', area: 'logic', visibility: 'private',
    content: { instructions: originalInstructions, steps: ['List the premises', 'Prove the target'], inputs: [], outputs: [], slots: ['M1'], roles: [], mode: 'append', dependencies: [], examples: [] } });
  const assetPath = `/api/research/library/${asset.id}`;
  const { item: publication } = await http<{ item: ResearchPublication }>('POST', `${assetPath}/publish`, {
    requestId: crypto.randomUUID(), expectedRevision: asset.revision, version: 'v1', license: 'MIT', visibility: 'private' });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { item } = await http<{ item: ResearchPublication }>('GET', `/api/research/publications/${publication.id}`);
    if (item.status === 'completed') break;
    assert.notEqual(item.status, 'failed', item.reason);
    assert.ok(Date.now() < deadline, 'The local Skill publication completes');
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  await check('C01 edit: collapsing and reopening preserves unsaved edits', async () => {
    await page!.goto(`${origin}/library.html?entry=${asset.id}&version=v1`);
    await page!.getByRole('button', { name: '编辑草稿', exact: true }).click();
    const editor = page!.locator('.research-panel').filter({ has: page!.getByRole('heading', { name: '编辑草稿', exact: true }) });
    const unsaved = 'UNSAVED: explain how each premise leads to the next deduction.';
    await editor.getByLabel('适用情境与执行要求', { exact: true }).fill(unsaved);
    await page!.getByRole('button', { name: '收起编辑器', exact: true }).click();
    await page!.getByRole('button', { name: '编辑草稿', exact: true }).click();
    assert.equal(await editor.getByLabel('适用情境与执行要求', { exact: true }).inputValue(), unsaved);
    const { item: saved } = await http<{ item: ResearchAsset }>('GET', assetPath);
    assert.equal((saved.draft as ResearchSkillDraft).instructions, originalInstructions, 'The preserved input remains an unsaved edit');
    await page!.screenshot({ path: path.join(output, 'editor-reopened.png'), fullPage: true });
  });

  await check('C02 a checked Skill-only standard environment reaches the workbench', async () => {
    await page!.goto(`${origin}/library.html?entry=${asset.id}&version=v1`);
    await page!.getByRole('button', { name: '加入配置选择', exact: true }).click();
    const selection = page!.locator('.research-selection-panel');
    await selection.getByRole('combobox', { name: '目标环境', exact: true }).selectOption('standard');
    const checked = page!.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/research/configuration');
    await selection.getByRole('button', { name: '检查组合', exact: true }).click();
    const response = await checked; assert.equal(response.status(), 200);
    const { item: configuration } = await response.json() as { item: FrozenResearchConfiguration };
    assert.equal(configuration.environment, 'standard'); assert.equal(configuration.agent, undefined); assert.equal(configuration.libraries.length, 0);
    assert.equal(configuration.skills[0]?.ref.assetId, asset.id);
    await selection.getByText('组合检查通过，版本与依赖已固定。', { exact: true }).waitFor();
    const beforeOpen = configurations.length;
    await selection.getByRole('button', { name: '带入工作台', exact: true }).click();
    await page!.waitForURL(url => url.origin === origin && url.pathname === '/');
    await page!.locator('.composer-research-selection strong').waitFor();
    assert.equal(await page!.locator('#environment').inputValue(), 'standard', 'The workbench retains the checked target environment');
    for (const request of configurations.slice(beforeOpen)) assert.equal(request.environment, 'standard', 'Any rebuilt workbench configuration uses the selected environment');
    await page!.screenshot({ path: path.join(output, 'standard-workbench.png'), fullPage: true });
  });

  await check('C03 the English Library selection panel has English controls', async () => {
    await clickWorkbenchAction(page!, '#locale-switch'); await page!.locator('html[lang^="en"]').waitFor({ state: 'attached' });
    const panel = page!.locator('.composer-research-selection'); await panel.locator('strong').waitFor();
    assert.ok((await panel.innerText()).includes(asset.name), 'The selected version survives changing language');
    assert.equal(/\p{Script=Han}/u.test(await panel.innerText()), false, 'The English panel has no hardcoded Chinese text');
    const label = await panel.getAttribute('aria-label'); assert.ok(label); assert.equal(/\p{Script=Han}/u.test(label), false);
    assert.ok((await panel.getByRole('button').innerText()).trim(), 'The clear action has a visible English name');
    assert.ok((await panel.getByRole('link').innerText()).trim(), 'The Library link has a visible English name');
    await page!.screenshot({ path: path.join(output, 'english-selection.png'), fullPage: true });
  });

  await check('C04 UI email logout and login do not inherit another account’s selection', async () => {
    await clickWorkbenchAction(page!, '#open-account'); await page!.locator('#logout').click(); await page!.waitForURL(/\/login\.html/u);
    const bobStart = requests.length; await signIn('bob@example.org');
    const bob = await http<{ researcherId: string }>('GET', '/api/research/session');
    assert.notEqual(bob.researcherId, alice.researcherId);
    const session = await http<WebSession>('GET', '/api/session'); assert.equal(session.account?.email, 'bob@example.org');
    assert.equal(await page!.locator('.composer-research-selection').isVisible(), false, 'Bob starts with his own empty selection');
    assert.equal(requests.slice(bobStart).some(request => request.pathname === `${assetPath}/releases/v1`), false, 'Bob never attempts to restore Alice’s private selection');
    const privateRelease = await page!.request.get(origin + `${assetPath}/releases/v1`);
    assert.equal(privateRelease.status(), 404, 'The private release remains inaccessible to Bob');
    await page!.screenshot({ path: path.join(output, 'bob-after-login.png'), fullPage: true });
  });

  assert.deepEqual(errors, [], 'No uncaught browser errors'); assert.deepEqual(external, [], 'All browser requests stay on the disposable local service');
  assert.deepEqual(runtimeCalls, [], 'No worker, model or Lean invocation');
} catch (error) {
  failure = error;
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'execution.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    checks, ...(failure ? { failedCheck: currentCheck, error: failure instanceof Error ? failure.message : String(failure), screenshot: 'failure.png' } : {}),
    configurations, pageErrors: errors, externalRequests: external, runtimeCalls, workerCalls: runtimeCalls.filter(call => call === 'run').length,
    modelCalls: 0, leanCalls: 0, realMail: false, productionWrites: false, fixturesRemoved: true }, null, 2) + '\n');
}
