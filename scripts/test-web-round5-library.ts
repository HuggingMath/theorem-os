#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchAsset, ResearchPublication, ResearchSkillDraft } from '../apps/web/researchAssetTypes';
import { deferred, freePort, preferFullCollaboration, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_ROUND5_LIBRARY_OUTPUT ?? path.join(root, 'out/web-round5-library');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round5-library-'));
let runnerCalls = 0;
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Disposable Library retry regressions' }; },
  async run() { runnerCalls++; throw new Error('Library retry regressions must not start research'); } };
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner);
const browser = await startBrowser(service.server, port);
const contexts = await Promise.all([browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } }),
  browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })]);
const pageErrors: string[] = [], externalRequests: string[] = [];
for (const context of contexts) {
  await preferFullCollaboration(context);
  await context.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { externalRequests.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  context.on('page', page => { page.setDefaultTimeout(15_000); page.on('pageerror', cause => pageErrors.push(cause.message)); });
}
const owner = await contexts[0].newPage(), control = await contexts[0].newPage(), consumer = await contexts[1].newPage();
async function http<T>(page: Page, method: string, pathname: string, input?: unknown): Promise<T> {
  const result = await page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  }, { method, pathname, input });
  assert.ok(result.status >= 200 && result.status < 300, `${method} ${pathname}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}
async function received(page: Page, method: string, pathname: string, action: () => Promise<unknown>) {
  const next = page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === pathname)
    .then(async response => ({ status: response.status(), output: await response.json() }));
  await action(); return next;
}
type Write<T> = { status: number; input: Record<string, unknown>; output: T };
// Read the real response before delivering it: a successful fork immediately navigates the page.
async function write<T>(page: Page, pathname: string, action: () => Promise<unknown>, dropResponse = false): Promise<Write<T>> {
  const delivered = deferred(); let captured: Write<T> | undefined;
  await page.route('**' + pathname, async route => {
    const result = await route.fetch(); captured = { status: result.status(), input: route.request().postDataJSON(), output: await result.json() };
    if (dropResponse) await route.abort(); else await route.fulfill({ response: result });
    delivered.resolve();
  });
  try { await action(); await delivered.promise; assert.ok(captured); return captured; }
  finally { await page.unroute('**' + pathname); }
}
const skill = (instructions: string): ResearchSkillDraft => ({ instructions, steps: [], inputs: [], outputs: [], slots: ['M1'], roles: [], mode: 'append', dependencies: [], examples: [] });
async function create(name: string, instructions: string) {
  return (await http<{ item: ResearchAsset }>(owner, 'POST', '/api/research/library', { requestId: crypto.randomUUID(), type: 'skill', name,
    description: 'Disposable Library retry regression', visibility: 'public', content: skill(instructions) })).item;
}
async function completed(id: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const item = (await http<{ item: ResearchPublication }>(control, 'GET', `/api/research/publications/${id}`)).item;
    if (item.status === 'completed') return item;
    assert.notEqual(item.status, 'failed', item.reason); assert.ok(Date.now() < deadline, 'Publication did not complete');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function publish(asset: ResearchAsset, version: string) {
  const item = (await http<{ item: ResearchPublication }>(owner, 'POST', `/api/research/library/${asset.id}/publish`,
    { requestId: crypto.randomUUID(), expectedRevision: asset.revision, version, license: 'MIT', visibility: 'public' })).item;
  return completed(item.id);
}
const panel = (page: Page, name: string) => page.locator('section.research-panel').filter({ has: page.getByRole('heading', { name, exact: true }) });
const review = (page: Page) => page.getByRole('checkbox', { name: '我已审阅保存的草稿及发布范围', exact: true });
const submit = (page: Page) => page.getByRole('button', { name: '发布并检查', exact: true });
const recover = (page: Page) => page.getByRole('button', { name: '恢复上次已审阅的发布', exact: true });
const preview = (page: Page) => page.getByRole('button', { name: '预览将公开的内容', exact: true });
const visibleFork = (page: Page) => page.locator('details:visible').filter({ has: page.getByText('复制到个人空间并修改', { exact: true }) });
async function openFork(page: Page) {
  const form = visibleFork(page); await form.waitFor();
  if (!await form.evaluate(node => (node as HTMLDetailsElement).open)) await form.getByText('复制到个人空间并修改', { exact: true }).click();
  return form;
}
async function reviewedDraft(asset: ResearchAsset) {
  const assetPath = `/api/research/library/${asset.id}`;
  await owner.goto(`${origin}/library.html?entry=${asset.id}`);
  await preview(owner).waitFor();
  assert.equal(await review(owner).isEnabled(), false); assert.equal(await submit(owner).isEnabled(), false);
  assert.equal(await recover(owner).count(), 0);
  const result = await received(owner, 'GET', assetPath + '/preview', () => preview(owner).click());
  await owner.getByRole('textbox', { name: '许可证', exact: true }).fill('MIT');
  await owner.getByRole('combobox', { name: /^发布范围/u }).selectOption('public');
  assert.equal(await submit(owner).isEnabled(), false); await review(owner).check();
  return result;
}
const checks: object[] = [];
let phase = 'setup', active = owner, failure: unknown;
try {
  await Promise.all([owner.goto(`${origin}/library.html`), control.goto(`${origin}/library.html`), consumer.goto(`${origin}/library.html`)]);

  phase = 'a lost saved publication response can recover the original reviewed request after a fresh preview';
  const draft = await create('Saved publication recovery', 'PUBLISH EXACTLY ONCE'), assetPath = `/api/research/library/${draft.id}`;
  const firstPreview = await reviewedDraft(draft);
  const first = await write<{ item: ResearchPublication }>(owner, assetPath + '/publish', () => submit(owner).click(), true);
  assert.equal(first.status, 202); await panel(owner, '发布固定版本').getByRole('alert').waitFor();
  const originalPublication = await completed(first.output.item.id);
  await recover(owner).waitFor();
  assert.equal(await owner.getByRole('textbox', { name: '许可证', exact: true }).inputValue(), 'MIT');
  const freshPreview = await received(owner, 'GET', assetPath + '/preview', () => preview(owner).click());
  assert.ok(freshPreview.output.item.revision > firstPreview.output.item.revision);
  assert.equal(await review(owner).isEnabled(), false); assert.equal(await submit(owner).isEnabled(), false);
  // Recovery must replay the original reviewed body, even after the user edits new-publication fields.
  await owner.getByRole('textbox', { name: '版本号', exact: true }).fill('v-next');
  await owner.getByRole('textbox', { name: '许可证', exact: true }).fill('Apache-2.0');
  await owner.getByRole('combobox', { name: /^发布范围/u }).selectOption('private');
  const replay = await write<{ item: ResearchPublication }>(owner, assetPath + '/publish', () => recover(owner).click());
  assert.equal(replay.status, 202); assert.deepEqual(replay.input, first.input);
  assert.equal(replay.output.item.id, originalPublication.id);
  await owner.getByText('PUBLISH EXACTLY ONCE', { exact: true }).waitFor();
  const saved = (await http<{ item: ResearchAsset }>(control, 'GET', assetPath)).item;
  assert.equal(saved.releases.length, 1); assert.equal(saved.releases[0]!.version, 'v1');
  assert.equal(saved.releases[0]!.license, 'MIT'); assert.equal(saved.releases[0]!.visibility, 'public');
  await recover(owner).waitFor({ state: 'hidden' });
  assert.equal(await review(owner).isChecked(), false); assert.equal(await submit(owner).isEnabled(), false);
  assert.equal(await owner.getByRole('textbox', { name: '版本号', exact: true }).inputValue(), 'v-next');
  assert.equal(await owner.getByRole('textbox', { name: '许可证', exact: true }).inputValue(), 'Apache-2.0');
  await panel(owner, '发布固定版本').screenshot({ path: path.join(output, 'recovered-publication.png') });
  checks.push({ name: phase, firstPreview, firstLostResponse: first, freshPreview, replay, releaseCount: saved.releases.length,
    originalPublicationId: originalPublication.id, newPublicationStillRequiresReview: true, editedInputsRetained: true }); console.log(`PASS ${phase}`);

  phase = 'an unsent publication recovery preserves revision checks and clears recovery after a definitive rejection';
  const stale = await create('Unsent publication revision guard', 'ORIGINAL REVIEWED CONTENT'), stalePath = `/api/research/library/${stale.id}`;
  await reviewedDraft(stale);
  const dropped = deferred(); let unsent: Record<string, unknown> | undefined;
  await owner.route('**' + stalePath + '/publish', async route => { unsent = route.request().postDataJSON(); await route.abort(); dropped.resolve(); });
  await submit(owner).click(); await dropped.promise; await owner.unroute('**' + stalePath + '/publish'); await recover(owner).waitFor();
  const changed = (await http<{ item: ResearchAsset }>(control, 'PATCH', stalePath, { requestId: crypto.randomUUID(), expectedRevision: stale.revision,
    content: skill('CHANGED AFTER REVIEW') })).item;
  const stalePreview = await received(owner, 'GET', stalePath + '/preview', () => preview(owner).click());
  assert.equal(stalePreview.output.item.revision, changed.revision);
  assert.equal(await review(owner).isEnabled(), false); assert.equal(await submit(owner).isEnabled(), false);
  const rejected = await write<{ error: string }>(owner, stalePath + '/publish', () => recover(owner).click());
  assert.equal(rejected.status, 409); assert.deepEqual(rejected.input, unsent);
  await panel(owner, '发布固定版本').getByRole('alert').waitFor(); await recover(owner).waitFor({ state: 'hidden' });
  assert.equal(await review(owner).isChecked(), false); assert.equal(await submit(owner).isEnabled(), false);
  assert.equal(await owner.getByRole('textbox', { name: '许可证', exact: true }).inputValue(), 'MIT');
  const unpublished = (await http<{ item: ResearchAsset }>(control, 'GET', stalePath)).item;
  assert.equal(unpublished.releases.length, 0); assert.equal(unpublished.revision, changed.revision);
  checks.push({ name: phase, unsentRequest: unsent, changedRevision: changed.revision, stalePreview, rejected,
    recoveryCleared: true, releaseCount: unpublished.releases.length, inputsRetained: true }); console.log(`PASS ${phase}`);

  phase = 'uncertain forks survive version browsing with separate per-version identities and no duplicate drafts'; active = consumer;
  let source = await create('Versioned fork recovery', 'FIXED V1 CONTENT'); await publish(source, 'v1');
  const sourcePath = `/api/research/library/${source.id}`;
  source = (await http<{ item: ResearchAsset }>(owner, 'GET', sourcePath)).item;
  source = (await http<{ item: ResearchAsset }>(owner, 'PATCH', sourcePath, { requestId: crypto.randomUUID(), expectedRevision: source.revision,
    content: skill('FIXED V2 CONTENT') })).item;
  await publish(source, 'v2');
  const forkPath = sourcePath + '/fork', fixedName = 'One intended fork per version';
  await consumer.goto(`${origin}/library.html?entry=${source.id}&version=v2`); await consumer.getByText('FIXED V2 CONTENT', { exact: true }).waitFor();
  let form = await openFork(consumer);
  await form.getByRole('textbox', { name: '新名称（可选）', exact: true }).fill(fixedName);
  const firstV2 = await write<{ item: ResearchAsset }>(consumer, forkPath, () => form.getByRole('button', { name: '创建私有派生草稿', exact: true }).click(), true);
  assert.equal(firstV2.status, 201); assert.equal(firstV2.input.version, 'v2'); await form.getByRole('alert').waitFor();
  const v1Path = sourcePath + '/releases/v1', started = deferred(), gate = deferred(); let allowV1 = false;
  await consumer.route('**' + v1Path, async route => {
    if (allowV1) { await route.continue(); return; }
    started.resolve(); await gate.promise;
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture release unavailable' }) });
  });
  try {
    await consumer.getByRole('combobox', { name: '查看固定版本', exact: true }).selectOption('v1'); await started.promise;
    assert.equal(await visibleFork(consumer).count(), 0, 'loading another version must hide the retained form');
    assert.equal(await consumer.getByRole('button', { name: '创建私有派生草稿', exact: true }).count(), 0);
    gate.resolve(); await consumer.getByText('Fixture release unavailable', { exact: true }).waitFor();
    assert.equal(await visibleFork(consumer).count(), 0, 'a 404 must not expose a retained fork operation');
    allowV1 = true;
    await received(consumer, 'GET', v1Path, () => consumer.getByRole('button', { name: '重新读取版本', exact: true }).click());
    await consumer.getByText('FIXED V1 CONTENT', { exact: true }).waitFor();
  } finally { gate.resolve(); await consumer.unroute('**' + v1Path); }
  form = await openFork(consumer);
  assert.equal(await form.getByRole('textbox', { name: '新名称（可选）', exact: true }).inputValue(), '', 'a different version has its own form');
  await form.getByRole('textbox', { name: '新名称（可选）', exact: true }).fill(fixedName);
  const firstV1 = await write<{ item: ResearchAsset }>(consumer, forkPath, () => form.getByRole('button', { name: '创建私有派生草稿', exact: true }).click(), true);
  assert.equal(firstV1.status, 201); assert.equal(firstV1.input.version, 'v1'); await form.getByRole('alert').waitFor();
  assert.notEqual(firstV1.input.requestId, firstV2.input.requestId); assert.notEqual(firstV1.output.item.id, firstV2.output.item.id);
  await consumer.getByRole('combobox', { name: '查看固定版本', exact: true }).selectOption('v2');
  await consumer.getByText('FIXED V2 CONTENT', { exact: true }).waitFor(); form = await openFork(consumer);
  assert.equal(await form.getByRole('textbox', { name: '新名称（可选）', exact: true }).inputValue(), fixedName);
  await form.getByRole('alert').waitFor();
  await consumer.locator('#research-library-asset').screenshot({ path: path.join(output, 'retained-fork-after-version-browse.png') });
  const replayV2 = await write<{ item: ResearchAsset }>(consumer, forkPath, () => form.getByRole('button', { name: '创建私有派生草稿', exact: true }).click());
  assert.equal(replayV2.status, 201); assert.deepEqual(replayV2.input, firstV2.input); assert.equal(replayV2.output.item.id, firstV2.output.item.id);
  await consumer.waitForURL(url => url.searchParams.get('entry') === firstV2.output.item.id);
  const own = await http<{ items: ResearchAsset[] }>(consumer, 'GET', '/api/research/library?type=skill&mine=1');
  const derived = own.items.filter(item => item.derivedFrom?.assetId === source.id), v2 = derived.filter(item => item.derivedFrom!.version === 'v2'), v1 = derived.filter(item => item.derivedFrom!.version === 'v1');
  assert.equal(derived.length, 2); assert.equal(v2.length, 1); assert.equal(v1.length, 1);
  assert.equal(v2[0]!.id, firstV2.output.item.id); assert.equal(v1[0]!.id, firstV1.output.item.id);
  for (const [item, content] of [[v2[0]!, 'FIXED V2 CONTENT'], [v1[0]!, 'FIXED V1 CONTENT']] as const) {
    assert.equal(item.name, fixedName); assert.ok(item.draft && 'instructions' in item.draft && item.draft.instructions === content);
  }
  await panel(consumer, fixedName).screenshot({ path: path.join(output, 'recovered-original-fork.png') });
  checks.push({ name: phase, sourceAssetId: source.id, firstLostV2Response: firstV2, differentVersionLostResponse: firstV1, replayV2,
    nameRetained: fixedName, loadingAnd404HideActions: true, ownDerivedAssets: derived, v2DraftCount: v2.length, v1DraftCount: v1.length }); console.log(`PASS ${phase}`);
  assert.equal(runnerCalls, 0); assert.deepEqual(pageErrors, []); assert.deepEqual(externalRequests, []);
} catch (cause) {
  failure = cause; await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw cause;
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    checks, pageErrors, externalRequests, runnerCalls, realModelCalls: 0, realLeanCalls: 0,
    ...(failure ? { failedPhase: phase, error: String(failure) } : {}) }, null, 2) + '\n');
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
