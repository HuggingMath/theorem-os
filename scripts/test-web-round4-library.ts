#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchAsset, ResearchAssetPreview, ResearchAssetRelease, ResearchPublication, ResearchSkillDraft } from '../apps/web/researchAssetTypes';
import { deferred, freePort, preferFullCollaboration, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_ROUND4_LIBRARY_OUTPUT ?? path.join(root, 'out/web-round4-library');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-library-regression-'));
let runnerCalls = 0;
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Disposable Library UI regression fixture' }; },
  async run() { runnerCalls++; throw new Error('Library regressions must not start a research run'); } };
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
  context.on('page', page => { page.setDefaultTimeout(15_000); page.on('pageerror', error => pageErrors.push(error.message)); });
}
const owner = await contexts[0].newPage(), other = await contexts[0].newPage(), viewer = await contexts[1].newPage();
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
  const next = page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === pathname);
  await action(); const response = await next;
  return { status: response.status(), input: method === 'GET' ? undefined : response.request().postDataJSON(), output: await response.json() };
}
const skill = (instructions: string): ResearchSkillDraft => ({ instructions, steps: [], inputs: [], outputs: [], slots: ['M1'], roles: [], mode: 'append', dependencies: [], examples: [] });
async function create(name: string, instructions: string) {
  return (await http<{ item: ResearchAsset }>(owner, 'POST', '/api/research/library', { requestId: crypto.randomUUID(), type: 'skill', name,
    description: 'Disposable Library regression fixture', visibility: 'public', content: skill(instructions) })).item;
}
async function publish(asset: ResearchAsset) {
  const initial = (await http<{ item: ResearchPublication }>(owner, 'POST', `/api/research/library/${asset.id}/publish`,
    { requestId: crypto.randomUUID(), expectedRevision: asset.revision, version: 'v1', license: 'MIT', visibility: 'public' })).item;
  return completed(initial);
}
async function completed(initial: ResearchPublication) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = (await http<{ item: ResearchPublication }>(owner, 'GET', `/api/research/publications/${initial.id}`)).item;
    if (result.status === 'completed') return result;
    assert.notEqual(result.status, 'failed', result.reason); assert.ok(Date.now() < deadline, 'Publication did not complete');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const panel = (page: Page, name: string) => page.locator('section.research-panel').filter({ has: page.getByRole('heading', { name, exact: true }) });
async function noReleaseActions(page: Page) {
  assert.equal(await page.getByRole('button', { name: '加入配置选择', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '用于新研究', exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: '下载版本', exact: true }).count(), 0);
}
const checks: object[] = [];
let phase = 'setup', active = owner, failure: unknown;
try {
  await Promise.all([owner.goto(`${origin}/library.html`), other.goto(`${origin}/library.html`), viewer.goto(`${origin}/library.html`)]);

  phase = 'a rejected draft reload fetches its new baseline and preserves input if that fetch fails';
  const draft = await create('Draft reload regression', 'INITIAL DRAFT CONTENT'), draftPath = `/api/research/library/${draft.id}`;
  await owner.goto(`${origin}/library.html?entry=${draft.id}`); await owner.getByRole('button', { name: '编辑草稿', exact: true }).click();
  const instructions = owner.getByRole('textbox', { name: '适用情境与执行要求', exact: true });
  await instructions.fill('UNSAVED LOCAL DRAFT');
  await http(other, 'PATCH', draftPath, { requestId: crypto.randomUUID(), expectedRevision: draft.revision, content: skill('NEW SERVER DRAFT CONTENT') });
  const rejected = await received(owner, 'PATCH', draftPath, () => owner.getByRole('button', { name: '保存草稿', exact: true }).click());
  assert.equal(rejected.status, 409);
  await owner.route('**' + draftPath, async route => {
    if (route.request().method() === 'GET') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture draft reload unavailable' }) });
    else await route.continue();
  });
  const failedRead = await received(owner, 'GET', draftPath, () => owner.getByRole('button', { name: '载入最新草稿', exact: true }).click());
  assert.equal(failedRead.status, 503); await owner.getByText('Fixture draft reload unavailable', { exact: true }).waitFor();
  assert.equal(await instructions.inputValue(), 'UNSAVED LOCAL DRAFT', 'a failed reload must keep the editable draft');
  await owner.unroute('**' + draftPath);
  const freshRead = await received(owner, 'GET', draftPath, () => owner.getByRole('button', { name: '载入最新草稿', exact: true }).click());
  assert.equal(freshRead.status, 200);
  await owner.waitForFunction(() => [...document.querySelectorAll('textarea')].some(node => node.value === 'NEW SERVER DRAFT CONTENT'));
  await instructions.fill('EDITED AFTER LOADING NEW BASELINE');
  const saved = await received(owner, 'PATCH', draftPath, () => owner.getByRole('button', { name: '保存草稿', exact: true }).click());
  assert.equal(saved.status, 200); assert.equal(saved.input.expectedRevision, 2); assert.equal(saved.output.item.draft.instructions, 'EDITED AFTER LOADING NEW BASELINE');
  checks.push({ name: phase, rejected, failedReadStatus: failedRead.status, freshReadRevision: freshRead.output.item.revision, saved }); console.log(`PASS ${phase}`);

  phase = 'an author withdrawal between detail and release reads removes actionable stale content'; active = viewer;
  const withdrawn = await create('Withdrawn release regression', 'WITHDRAWN RELEASE CONTENT'), publication = await publish(withdrawn);
  const assetPath = `/api/research/library/${withdrawn.id}`, releasePath = `${assetPath}/releases/v1`;
  let withdrew = false;
  await viewer.route('**' + assetPath, async route => {
    const result = await route.fetch();
    if (!withdrew) {
      withdrew = true; const latest = (await http<{ item: ResearchAsset }>(owner, 'GET', assetPath)).item;
      await http(owner, 'POST', releasePath + '/withdraw', { requestId: crypto.randomUUID(), expectedRevision: latest.revision });
    }
    await route.fulfill({ response: result });
  });
  const unavailable = await received(viewer, 'GET', releasePath, () => viewer.goto(`${origin}/library.html?entry=${withdrawn.id}&version=v1`));
  assert.equal(unavailable.status, 404); await viewer.getByText('发布版本不存在或不可访问。', { exact: true }).waitFor();
  assert.equal(await viewer.getByText('WITHDRAWN RELEASE CONTENT', { exact: true }).count(), 0); await noReleaseActions(viewer);
  assert.equal(await viewer.evaluate(() => sessionStorage.getItem('theoremos.research.selection')), null);
  await panel(viewer, '已发布版本').screenshot({ path: path.join(output, 'withdrawn-release.png') });
  await viewer.unroute('**' + assetPath);
  checks.push({ name: phase, publicationId: publication.id, unavailable, selectedUnavailableVersion: false }); console.log(`PASS ${phase}`);

  const available = await create('Release recovery regression', 'AVAILABLE RELEASE CONTENT'); await publish(available);
  const availableRelease = `/api/research/library/${available.id}/releases/v1`;
  for (const issue of [401, 403, 500, 'network'] as const) {
    phase = `release ${issue} distinguishes unavailable content from recoverable reads`; active = viewer;
    let recover = false;
    await viewer.route('**' + availableRelease, async route => {
      if (recover) await route.continue();
      else if (issue === 'network') await route.abort();
      else await route.fulfill({ status: issue, contentType: 'application/json', body: JSON.stringify({ error: `Fixture release ${issue}` }) });
    });
    await viewer.goto(`${origin}/library.html?entry=${available.id}&version=v1`);
    await panel(viewer, '已发布版本').getByRole('alert').waitFor();
    if (issue === 401 || issue === 403) {
      assert.equal(await viewer.getByText('AVAILABLE RELEASE CONTENT', { exact: true }).count(), 0); await noReleaseActions(viewer);
    } else {
      assert.equal(await viewer.getByText('AVAILABLE RELEASE CONTENT', { exact: true }).isVisible(), true);
      assert.equal(await viewer.getByRole('button', { name: '用于新研究', exact: true }).isEnabled(), true);
    }
    recover = true;
    const restored = await received(viewer, 'GET', availableRelease, () => viewer.getByRole('button', { name: '重新读取版本', exact: true }).click());
    assert.equal(restored.status, 200); await panel(viewer, '已发布版本').getByRole('alert').waitFor({ state: 'hidden' });
    assert.equal(await viewer.getByText('AVAILABLE RELEASE CONTENT', { exact: true }).isVisible(), true);
    assert.equal(await viewer.getByRole('button', { name: '用于新研究', exact: true }).isEnabled(), true);
    await viewer.unroute('**' + availableRelease);
    checks.push({ name: phase, unavailable: issue === 401 || issue === 403, recoveredStatus: restored.status }); console.log(`PASS ${phase}`);
  }

  phase = 'preview refresh clears review during requests and after errors, and stale digest rejection recovers'; active = owner;
  const publishable = await create('Preview binding regression', 'REVIEWED CONTENT'), publishPath = `/api/research/library/${publishable.id}/publish`;
  const previewPath = `/api/research/library/${publishable.id}/preview`;
  await owner.goto(`${origin}/library.html?entry=${publishable.id}`);
  const previewButton = owner.getByRole('button', { name: '预览将公开的内容', exact: true });
  const review = owner.getByRole('checkbox', { name: '我已审阅保存的草稿及发布范围', exact: true });
  const publishButton = owner.getByRole('button', { name: '发布并检查', exact: true });
  assert.equal(await review.isEnabled(), false); assert.equal(await publishButton.isEnabled(), false);
  const first = await received(owner, 'GET', previewPath, () => previewButton.click());
  const initialPreview = first.output.item as ResearchAssetPreview;
  assert.match(initialPreview.previewDigest, /^[a-f0-9]{64}$/u);
  await owner.getByRole('textbox', { name: '许可证', exact: true }).fill('MIT');
  await owner.getByRole('combobox', { name: /^发布范围/u }).selectOption('public'); await review.check();
  const gate = deferred(), started = deferred();
  let held = true;
  await owner.route('**' + previewPath + '?*', async route => {
    if (held) { started.resolve(); await gate.promise; }
    await route.continue();
  });
  try {
    await previewButton.click(); await started.promise;
    assert.equal(await review.isChecked(), false); assert.equal(await review.isEnabled(), false); assert.equal(await publishButton.isEnabled(), false);
    assert.equal(await owner.getByRole('region', { name: '发布内容预览', exact: true }).count(), 0);
    const fresh = owner.waitForResponse(response => new URL(response.url()).pathname === previewPath);
    held = false; gate.resolve(); await fresh;
    await owner.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].some(node => !node.disabled && node.parentElement?.textContent?.includes('我已审阅保存的草稿')));
    assert.equal(await review.isChecked(), false, 'an unchanged asset revision and digest do not restore earlier review');
  } finally { gate.resolve(); await owner.unroute('**' + previewPath + '?*'); }
  await review.check();
  await owner.route('**' + previewPath + '?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture preview unavailable' }) }));
  await received(owner, 'GET', previewPath, () => previewButton.click()); await owner.getByText('Fixture preview unavailable', { exact: true }).waitFor();
  assert.equal(await review.isChecked(), false); assert.equal(await review.isEnabled(), false); assert.equal(await publishButton.isEnabled(), false);
  await owner.unroute('**' + previewPath + '?*');
  // Simulate a preview whose fixed content identity became stale without changing the draft revision.
  await owner.route('**' + previewPath + '?*', async route => {
    const result = await route.fetch(), body = await result.json(); body.item.previewDigest = '0'.repeat(64);
    await route.fulfill({ response: result, json: body });
  });
  await received(owner, 'GET', previewPath, () => previewButton.click());
  await review.check();
  const rejectedPublication = await received(owner, 'POST', publishPath, () => publishButton.click());
  assert.equal(rejectedPublication.status, 409); assert.equal(rejectedPublication.input.previewDigest, '0'.repeat(64));
  assert.equal(await review.isChecked(), false, 'a rejected publication cannot retain its confirmation');
  await owner.unroute('**' + previewPath + '?*');
  const current = await received(owner, 'GET', previewPath, () => previewButton.click());
  assert.equal(current.output.item.revision, initialPreview.revision); assert.equal(await review.isChecked(), false);
  await review.check();
  const accepted = await received(owner, 'POST', publishPath, () => publishButton.click());
  assert.equal(accepted.status, 202); assert.equal(accepted.input.previewDigest, current.output.item.previewDigest);
  const release = await completed(accepted.output.item);
  const publishedRelease = (await http<{ item: ResearchAssetRelease }>(owner, 'GET', `/api/research/library/${publishable.id}/releases/${release.version}`)).item;
  assert.equal('instructions' in publishedRelease.content ? publishedRelease.content.instructions : undefined, 'REVIEWED CONTENT');
  checks.push({ name: phase, previewStalenessSimulated: true, initialPreview, rejectedPublication, accepted, completedPublicationId: release.id }); console.log(`PASS ${phase}`);
  assert.equal(runnerCalls, 0); assert.deepEqual(pageErrors, []); assert.deepEqual(externalRequests, []);
} catch (cause) {
  failure = cause; await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw cause;
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    checks, pageErrors, externalRequests, runnerCalls, realModelCalls: 0, realLeanCalls: 0,
    ...(failure ? { failedPhase: phase, error: String(failure) } : {}) }, null, 2) + '\n');
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
