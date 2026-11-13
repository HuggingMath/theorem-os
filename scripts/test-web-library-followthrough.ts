#!/usr/bin/env bun
// Synthetic loopback accounts and recorded evidence only. No model, Lean, SMTP or production calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { WebResearchAssets } from '../apps/web/researchAssets';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchCollection } from '../apps/web/researchCollectionTypes';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readingRun, readingProof, readingCommit } from '../tests/helpers/shareReadingFixture';
import { freePort, preferFullCollaboration, settled, startBrowser } from './web-scenario';
import { openNavigationMenu } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/product-continuity/research-followthrough/reuse');
await fs.access(path.join(root, 'out/web/library.html')); await fs.mkdir(output, { recursive: true });
const build = JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8'));
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-library-followthrough-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`, mail: { to: string; text: string }[] = [];
const errors: string[] = [], external: string[] = [], starts: string[] = [], checks: object[] = [], views: object[] = [];
let recordedRuns = 0, runtimeCalls = 0;
const forbidden = async () => { runtimeCalls++; throw new Error('A Library entry must not start a runtime'); };
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Recorded Library fixture' }; },
  async run(input, send) { recordedRuns++; const run = readingRun(input.id); run.result!.report.solution_commit = readingCommit;
    send({ type: 'observation', observation: run.observation! }); send({ type: 'result', result: run.result! }); }, check: forbidden, command: forbidden };
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:',
  THEOREMOS_WEB_ALLOWLIST: ['owner-1440', 'reader-1440', 'combination-1440', 'owner-390', 'reader-390', 'combination-390'].map(name => `${name}@example.org`).join(',') }), runner,
{ sample: null, mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
const fixtures = new WebResearchAssets(service.storage, { identity: owner => service.research.projects.identity(owner),
  async resolveMathematics(_owner, source) { return { environment: 'standard', environmentDigest: getLeanTaskEnvironment('standard').dependencyDigest,
    declarations: [{ name: 'duplicate_eq', type: '∀ n : Nat, duplicate n = n + n', file: 'Submission/Library/Duplicate.lean' }],
    pack: { schema: 'theorem-os.library-pack.v1', modules: [{ file: 'Submission/Library/Duplicate.lean', source: readingProof,
      origin: { kind: 'run', runId: source.kind === 'run' ? source.runId : 'fixture', commit: readingCommit, file: 'Submission.lean' } }] } }; },
  async validateMathematics() { return { passed: true, receiptRefs: ['recorded-library-check'] }; } });
const browser = await startBrowser(service.server, port);
let active: Page | undefined, phase = 'setup';
async function actor(width: number, language: 'zh' | 'en') {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: language === 'zh' ? 'zh-CN' : 'en-US', reducedMotion: 'reduce' });
  await preferFullCollaboration(context);
  await context.addInitScript(value => { try { localStorage.setItem('theorem-os.web-locale.v1', value); } catch {} }, language);
  await context.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
  });
  context.on('request', request => { if (new URL(request.url()).pathname === '/api/runs' && request.method() === 'POST') starts.push(request.url()); });
  const page = await context.newPage(); page.setDefaultTimeout(12_000); page.on('pageerror', error => errors.push(error.message)); return page;
}
async function login(page: Page, email: string) {
  await page.locator('#send-code:enabled').waitFor(); await page.locator('#login-email').fill(email); await page.locator('#login-captcha').fill('24680');
  if (await page.locator('#accept-terms').isVisible()) await page.locator('#accept-terms').check();
  await page.locator('#send-code').click(); await page.locator('#code-step:not([hidden])').waitFor();
  const code = mail.findLast(item => item.to === email)?.text.match(/\b\d{6}\b/u)?.[0]; assert.ok(code);
  await page.locator('#login-code').fill(code); await page.locator('#verify-code').click(); await page.waitForURL(url => url.pathname !== '/login.html');
  service.auth!.setCompletionEmail(email, false); return `account:${service.auth!.getAccount(email)!.id}`;
}
async function publish(owner: string, assetId: string, version = 'v1') {
  const asset = fixtures.get(owner, assetId), preview = await fixtures.preview(owner, assetId);
  const queued = await fixtures.publish(owner, assetId, { requestId: `publish-${assetId}-${version}`, expectedRevision: asset.revision,
    previewDigest: preview.previewDigest, version, license: 'MIT', visibility: 'public' });
  const complete = await fixtures.waitForPublication(owner, queued.id); assert.equal(complete.status, 'completed', complete.reason);
  return fixtures.release(owner, assetId, version);
}
async function json<T>(page: Page, pathname: string): Promise<T> {
  const response = await page.request.get(origin + pathname); assert.equal(response.status(), 200); return response.json();
}
async function screenshot(page: Page, name: string) {
  const accountLayout = name.startsWith('single-reuse') || name.startsWith('combined-reuse');
  if (accountLayout) await openNavigationMenu(page);
  await settled(page);
  const dimensions = await page.evaluate(() => {
    const account = document.querySelector('#open-account')?.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, rootWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth, rootHeight: document.documentElement.scrollHeight, bodyHeight: document.body.scrollHeight, scrollY,
      ...(account ? { account: { left: account.left, right: account.right, width: account.width } } : {}) };
  });
  assert.ok(dimensions.rootWidth <= dimensions.width && dimensions.bodyWidth <= dimensions.width, `${name} overflows`);
  if (accountLayout)
    assert.ok(dimensions.account && dimensions.account.left >= 0 && dimensions.account.right <= dimensions.width, 'The account control fits within the viewport');
  if (name.startsWith('member-fixed-source')) assert.ok(Math.abs(dimensions.rootHeight - dimensions.bodyHeight) <= 1, 'The source scroll region does not create empty page space');
  views.push({ name, ...dimensions });
  if (accountLayout) await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(output, `${name}-viewport.png`), fullPage: false });
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
}
try {
  for (const [width, language] of [[1440, 'zh'], [390, 'en']] as const) {
    const tx = (zh: string, en: string) => language === 'zh' ? zh : en;
    const ownerPage = await actor(width, language), reader = await actor(width, language), combination = await actor(width, language), bookmark = await actor(width, language), visitor = await actor(width, language);
    active = ownerPage; phase = `seed-${width}`; await ownerPage.goto(`${origin}/login.html?returnTo=library&lang=${language}`);
    const owner = await login(ownerPage, `owner-${width}@example.org`);
    const run = service.jobs.create(owner, { providerId: 'openai', apiKey: 'DISPOSABLE-FIXTURE-NOT-A-KEY', model: 'fixture', effort: 'high', environment: 'standard',
      source: readingProof.replace('rw [duplicate_eq]', 'sorry').trim(), task: 'Recorded duplicate identity', maxTurns: 1, maxRunSeconds: 30, workers: 1, coordination: 'independent' },
    { id: 'openai', name: 'Local fixture', baseUrl: 'http://127.0.0.1/never-called' });
    for (let attempt = 0; attempt < 30 && run.status !== 'completed'; attempt++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(run.status, 'completed'); const before = JSON.stringify(run), task = run.observation!.sources[0];
    const math = fixtures.create(owner, { requestId: `math-${width}`, type: 'mathematics', name: `Fixed duplicate ${width}`,
      content: { source: { kind: 'run', runId: run.id, scope: 'original-proof', commit: readingCommit, proofDigest: mathDigest(run.result!.proof) } } });
    const release = await publish(owner, math.id); await publish(owner, math.id, 'v2');
    const step = fixtures.create(owner, { requestId: `step-${width}`, type: 'mathematics', name: `Fixed lemma ${width}`,
      content: { source: { kind: 'run', runId: run.id, scope: 'checked-task', taskId: task.taskId, taskVersion: task.taskVersion, commit: task.commit } } });
    await publish(owner, step.id);
    const skill = fixtures.create(owner, { requestId: `skill-${width}`, type: 'skill', name: `Premise review ${width}`,
      content: { instructions: 'Check the current goal and premises.', steps: ['Read the exact goal', 'Review dependencies'], slots: ['M1'] } });
    await publish(owner, skill.id);
    const assetUrl = `${origin}/library.html?entry=${math.id}&version=v1&lang=${language}`;

    active = reader; phase = `anonymous-single-registration-${width}`; await reader.goto(assetUrl);
    await reader.getByRole('button', { name: tx('用于新研究', 'Use in new research'), exact: true }).click();
    await reader.waitForURL(url => url.pathname === '/login.html');
    assert.equal(new URL(reader.url()).searchParams.get('researchVersion'), 'v1');
    const readerOwner = await login(reader, `reader-${width}@example.org`);
    const selected = reader.locator('.composer-research-selection'); await selected.filter({ hasText: math.name }).waitFor();
    assert.match(await selected.innerText(), /v1/u); assert.doesNotMatch(await selected.innerText(), /v2/u);
    assert.equal(new URL(reader.url()).searchParams.get('libraryReturn'), null);
    assert.match(await reader.locator('#source').inputValue(), /import Submission\.Library\.Duplicate/u);
    await screenshot(reader, `single-reuse-${width}-${language}`);
    await reader.reload(); await selected.filter({ hasText: math.name }).waitFor();

    active = combination; phase = `anonymous-combination-registration-${width}`; await combination.goto(assetUrl);
    await combination.getByRole('button', { name: tx('加入配置选择', 'Add to configuration'), exact: true }).click();
    await combination.goto(`${origin}/library.html?entry=${skill.id}&version=v1&lang=${language}`);
    await combination.getByRole('button', { name: tx('加入配置选择', 'Add to configuration'), exact: true }).click();
    const choices = combination.locator('.research-selection-panel'); await choices.getByRole('combobox').selectOption('standard');
    await choices.getByRole('button', { name: tx('带入工作台', 'Open in workbench'), exact: true }).click();
    await combination.waitForURL(url => url.pathname === '/login.html');
    await login(combination, `combination-${width}@example.org`);
    const combined = combination.locator('.composer-research-selection'); await combined.filter({ hasText: math.name }).filter({ hasText: skill.name }).waitFor();
    await screenshot(combination, `combined-reuse-${width}-${language}`);
    await combination.reload(); await combined.filter({ hasText: math.name }).filter({ hasText: skill.name }).waitFor();

    active = bookmark; phase = `anonymous-bookmark-existing-login-${width}`; await bookmark.goto(assetUrl);
    await bookmark.getByRole('link', { name: tx('登录后收藏', 'Sign in to save'), exact: true }).click();
    await bookmark.waitForURL(url => url.pathname === '/login.html');
    assert.equal(new URL(bookmark.url()).searchParams.get('action'), 'bookmark');
    await login(bookmark, `reader-${width}@example.org`);
    assert.equal(new URL(bookmark.url()).pathname, '/library.html'); assert.equal(new URL(bookmark.url()).searchParams.get('version'), 'v1');
    const form = bookmark.locator('[data-bookmark-control][open]');
    const name = form.getByRole('textbox', { name: tx('资料夹名称', 'Collection name'), exact: true }); await name.waitFor();
    assert.equal((await json<{ items: ResearchCollection[] }>(bookmark, '/api/research/collections')).items.length, 0, 'Login never saves a bookmark automatically');
    await bookmark.waitForFunction(() => Boolean(document.querySelector('[data-bookmark-control]')?.contains(document.activeElement)));
    assert.ok((await name.boundingBox())!.y < 1000, 'The pending bookmark action is visible after login');
    await name.fill(`Fixed collection ${width}`); await form.getByRole('button', { name: tx('保存收藏', 'Save bookmark'), exact: true }).click();
    await form.getByText(tx('已保存到你的资料夹。', 'Saved to your collection.'), { exact: true }).waitFor();
    const collection = (await json<{ items: ResearchCollection[] }>(bookmark, '/api/research/collections')).items[0];
    assert.deepEqual(collection.items[0].target, { kind: 'release', assetId: math.id, version: 'v1', digest: release.digest });
    assert.equal(new URL(bookmark.url()).searchParams.get('action'), null); await screenshot(bookmark, `bookmark-return-${width}-${language}`);

    active = visitor; phase = `source-no-access-${width}`; await visitor.goto(assetUrl);
    await visitor.locator('[data-library-source-private]').waitFor(); assert.equal(await visitor.locator('[data-library-source-link]').count(), 0);
    await visitor.getByText(tx('查看完整源码与来源', 'View complete source and provenance'), { exact: true }).click();
    await visitor.getByText(readingProof, { exact: true }).waitFor(); await screenshot(visitor, `published-evidence-${width}-${language}`);
    active = ownerPage; phase = `owner-source-${width}`; await ownerPage.goto(assetUrl); await ownerPage.locator('[data-library-source-link]').click();
    await ownerPage.waitForURL(url => url.pathname === '/' && url.searchParams.get('run') === run.id);
    await ownerPage.locator('#open-account').waitFor({ state: 'attached' }); assert.equal(await ownerPage.locator('#toast').filter({ hasText: '没有找到链接里的研究记录' }).count(), 0);

    let project = service.research.projects.create(owner, { requestId: `project-${width}`, title: `Fixed proof project ${width}`, visibility: 'members' });
    project = service.research.projects.setMember(owner, project.id, service.research.projects.identity(readerOwner), { requestId: 'member', expectedRevision: project.revision, role: 'reader' });
    project = service.research.projects.addVersion(owner, project.id, { requestId: 'version', expectedRevision: project.revision, statement: 'Duplicate identity', source: run.source, environment: 'standard' });
    project = service.research.projects.bindRun(owner, project.id, { requestId: 'bind', expectedRevision: project.revision, runId: run.id, statementVersionId: project.versions[0].id, exposure: 'members' });
    active = reader; phase = `member-fixed-task-${width}`;
    await reader.goto(`${origin}/library.html?entry=${step.id}&version=v1&lang=${language}`); const link = reader.locator('[data-library-source-link]'); await link.waitFor();
    const address = new URL((await link.getAttribute('href'))!, origin);
    assert.equal(address.searchParams.get('taskVersion'), task.taskVersion); assert.equal(address.searchParams.get('commit'), task.commit); assert.equal(address.searchParams.get('id'), project.id);
    await link.click(); await reader.locator('[data-task-source-code]').waitFor();
    assert.match(await reader.locator('[data-task-source-code]').innerText(), /theorem duplicate_eq/u);
    await screenshot(reader, `member-fixed-source-${width}-${language}`);
    project = service.research.projects.setMember(owner, project.id, service.research.projects.identity(readerOwner), { requestId: 'remove', expectedRevision: project.revision, role: null });
    await reader.goto(`${origin}/library.html?entry=${step.id}&version=v1&lang=${language}`);
    await reader.locator('[data-library-source-private]').waitFor(); assert.equal(await reader.locator('[data-library-source-link]').count(), 0);

    active = visitor; phase = `public-source-${width}`;
    project = service.research.projects.update(owner, project.id, { requestId: 'public', expectedRevision: project.revision, visibility: 'public' });
    project = service.research.projects.bindRun(owner, project.id, { requestId: 'public-run', expectedRevision: project.revision, runId: run.id, statementVersionId: project.versions[0].id, exposure: 'public' });
    await visitor.goto(assetUrl); await visitor.locator('[data-library-source-link]').filter({ hasText: tx('查看公开的原题证明', 'View the public proof') }).click();
    await visitor.waitForURL(url => url.pathname === '/theorems.html' && url.searchParams.get('id') === project.id);
    await visitor.getByRole('heading', { name: project.title, exact: true }).waitFor(); await screenshot(visitor, `public-source-${width}-${language}`);
    assert.equal(JSON.stringify(run), before, 'Reuse, collections and source navigation do not alter the recorded run');
    checks.push({ width, language, fixedVersionAfterRegistration: true, combinationAfterRegistrationAndReload: true, explicitBookmarkAfterLogin: true,
      bookmarkVisibleAndFocused: true, noAutomaticSubmission: true, ownerSource: true, projectExactTask: true, revokedMemberFallback: true, publishedEvidenceFallback: true, authorizedPublicResult: true });
    for (const page of [ownerPage, reader, combination, bookmark, visitor]) await page.context().close(); active = undefined;
    console.log(`PASS Library follow-through ${width} ${language}`);
  }
  assert.equal(recordedRuns, 2); assert.equal(runtimeCalls, 0); assert.deepEqual(starts, []); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await fs.rm(path.join(output, 'failure.png'), { force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', fixtureOnly: true, build, checks, views, recordedRuns, runtimeCalls, starts, errors, external }, null, 2));
  console.log(JSON.stringify({ status: 'passed', output, scenarios: checks.length }));
} catch (error) {
  await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  const state = await active?.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(-14000) })).catch(() => undefined);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', build, phase, error: String(error), state, checks, errors, external }, null, 2)); throw error;
} finally { await browser.close(); await fixtures.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
