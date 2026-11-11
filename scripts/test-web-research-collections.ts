#!/usr/bin/env bun
// Disposable HTTP/browser fixtures. No models, real Lean checks or mail are invoked.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebResearchCollections } from '../apps/web/researchCollections';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchCollection, ResearchCollectionPreparation } from '../apps/web/researchCollectionTypes';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/research-collections');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.access(path.join(staticRoot, 'workspace.html')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-browser-collections-'));
let runnerCalls = 0, mailCalls = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable collection fixture' }; },
  async run() { runnerCalls++; throw new Error('Collections must not start research'); },
  async check() { runnerCalls++; throw new Error('Collections must not run Lean'); },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner,
{ sample: null, mailer: async () => { mailCalls++; throw new Error('Collections must not send mail'); } });
const fixtures = new WebResearchAssets(service.storage, { identity: owner => service.research.projects.identity(owner),
  async resolveMathematics() {
    return { environment: 'standard', environmentDigest: getLeanTaskEnvironment('standard').dependencyDigest,
      declarations: [{ name: 'Shared.zero', type: '(n : Nat) : n + 0 = n', file: 'Submission/Library/Shared.lean' }],
      pack: { schema: 'theorem-os.library-pack.v1', modules: [{ file: 'Submission/Library/Shared.lean',
        source: 'namespace Shared\ntheorem zero (n : Nat) : n + 0 = n := by simp\nend Shared\n',
        origin: { kind: 'run', runId: 'browser-fixture', commit: 'a'.repeat(40), file: 'Main.lean' } }] } };
  }, async validateMathematics() { return { passed: true, receiptRefs: ['fixture-only-check'] }; },
});
const collectionFixtures = new WebResearchCollections({ storage: service.storage, projects: service.research.projects, assets: service.research.assets });
const browser = await startBrowser(service.server, port), errors: string[] = [], external: string[] = [], checks: object[] = [];
let phase = 'setup', active: Page | undefined;
const reply = (page: Page, method: string, pathname: string) => page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === pathname);
async function http<T>(page: Page, pathname: string): Promise<T> {
  return page.evaluate(async pathname => { const response = await fetch(pathname); const body = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error}`); return body; }, pathname);
}
async function publish(owner: string, id: string, version: string, releaseNotes: string) {
  const current = fixtures.get(owner, id), preview = await fixtures.preview(owner, id);
  const queued = await fixtures.publish(owner, id, { requestId: `publish-${id}-${version}`, expectedRevision: current.revision,
    previewDigest: preview.previewDigest, version, license: 'MIT', visibility: 'public', releaseNotes });
  const settled = await fixtures.waitForPublication(owner, queued.id); assert.equal(settled.status, 'completed', settled.reason);
  return fixtures.release(owner, id, version);
}
try {
  for (const width of [1440, 390]) {
    phase = `collections-${width}`;
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => { try { localStorage.setItem('theorem-os.locale.v1', 'zh'); } catch { /* The initial blank page has no storage. */ } });
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
    });
    context.on('page', page => { page.setDefaultTimeout(12_000); page.on('pageerror', error => errors.push(error.message)); });
    const page = await context.newPage(); active = page;
    await page.goto(origin + '/library.html'); await page.getByRole('heading', { name: '数学库', exact: true }).waitFor();
    const owner = (await context.cookies(origin)).find(item => item.name === 'theoremos_session')!.value;
    const skill = fixtures.create(owner, { requestId: `skill-${width}`, type: 'skill', name: `推导核对 ${width}`, content: {
      instructions: '核对当前目标及前提', steps: ['读取精确目标', '核对依赖'], slots: ['M1'] } });
    await publish(owner, skill.id, 'v1', '第一版：核对目标');
    const math = fixtures.create(owner, { requestId: `math-${width}`, type: 'mathematics', name: `自然数加法 ${width}`,
      content: { source: { kind: 'run', runId: 'browser-fixture', commit: 'a'.repeat(40) } } });
    const mathRelease = await publish(owner, math.id, 'v1', '可复用的加法引理');
    await page.goto(`${origin}/library.html?entry=${skill.id}&version=v1`);
    await page.getByRole('button', { name: '关注新版本', exact: true }).click();
    await page.getByRole('button', { name: '已关注新版本', exact: true }).waitFor();

    const bookmark = page.locator('[data-bookmark-control]'); await bookmark.locator('summary').click();
    await bookmark.getByRole('textbox', { name: '资料夹名称', exact: true }).fill(`加法研究资料 ${width}`);
    await bookmark.getByRole('textbox', { name: '私人备注（可选）', exact: true }).fill('先核对前提，再采用这个方法');
    let uncertain = true; const attempts: Record<string, unknown>[] = [];
    await page.route('**/api/research/collections/*/items', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      attempts.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (uncertain) { uncertain = false; assert.equal(response.status(), 200);
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '保存确认中断，请重试' }) });
      } else await route.fulfill({ response });
    });
    await bookmark.getByRole('button', { name: '保存收藏', exact: true }).click();
    await bookmark.getByRole('alert').filter({ hasText: '保存确认中断' }).waitFor();
    await bookmark.getByRole('button', { name: '保存收藏', exact: true }).click();
    await bookmark.getByText('已保存到你的资料夹。', { exact: true }).waitFor();
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1], 'An uncertain save retry reuses the original request body');
    await page.unroute('**/api/research/collections/*/items');
    let collection = (await http<{ items: ResearchCollection[] }>(page, '/api/research/collections')).items[0];
    assert.equal(collection.items.length, 1); assert.equal(collection.items[0].target.kind, 'release');
    await bookmark.getByRole('link', { name: '管理资料夹', exact: true }).click();
    await page.waitForURL('**/workspace.html?tab=collections');
    const detail = page.locator(`[data-collection-id="${collection.id}"]`);
    await detail.getByText('先核对前提，再采用这个方法', { exact: true }).waitFor();
    await detail.getByText('编辑私人备注与收藏', { exact: true }).click();
    await detail.getByRole('textbox', { name: '私人备注', exact: true }).fill('已人工核对：这个方法适用于后续推导');
    const noteSaved = reply(page, 'PATCH', `/api/research/collections/${collection.id}/items/${collection.items[0].id}`);
    await detail.getByRole('button', { name: '保存备注', exact: true }).click(); assert.equal((await noteSaved).status(), 200);
    await detail.getByText('已人工核对：这个方法适用于后续推导', { exact: true }).waitFor();
    // A newer collection revision must not discard the note or force the user to retype it.
    await page.goto(`${origin}/library.html?entry=${skill.id}&version=v1`);
    const duplicate = page.locator('[data-bookmark-control]'); await duplicate.locator('summary').click();
    await duplicate.getByRole('combobox', { name: '资料夹', exact: true }).waitFor();
    const latest = collectionFixtures.get(owner, collection.id);
    collectionFixtures.update(owner, collection.id, { requestId: `external-rename-${width}`, expectedRevision: latest.revision,
      title: latest.title + ' · 已复核', description: latest.description });
    await duplicate.getByRole('button', { name: '保存收藏', exact: true }).click();
    await duplicate.getByRole('alert').filter({ hasText: '资料夹已更新' }).waitFor();
    const reloaded = reply(page, 'GET', '/api/research/collections');
    await duplicate.getByRole('button', { name: '重新读取资料夹后重试', exact: true }).click(); await (await reloaded).finished();
    await duplicate.getByRole('button', { name: '保存收藏', exact: true }).click();
    await duplicate.getByText('已保存到你的资料夹。', { exact: true }).waitFor();
    const preservedNote = (await http<{ items: ResearchCollection[] }>(page, '/api/research/collections')).items[0];
    assert.equal(preservedNote.items.length, 1); assert.equal(preservedNote.items[0].note, '已人工核对：这个方法适用于后续推导');

    const current = fixtures.get(owner, skill.id);
    fixtures.update(owner, skill.id, { requestId: `revise-${width}`, expectedRevision: current.revision,
      content: { instructions: '核对当前目标及前提，并记录下一步如何推出', steps: ['读取精确目标', '核对依赖', '写出承接关系'], slots: ['M1'] } });
    await page.goto(`${origin}/library.html?entry=${skill.id}&version=v1`);
    const publication = page.locator('section.research-panel').filter({ has: page.getByRole('heading', { name: '发布固定版本', exact: true }) });
    await publication.getByRole('textbox', { name: '版本号', exact: true }).fill('v2');
    await publication.getByRole('textbox', { name: '许可证', exact: true }).fill('MIT');
    await publication.getByRole('textbox', { name: '此版本的更新说明（可选）', exact: true }).fill('第二版：补充下一步推导');
    await publication.getByRole('combobox', { name: '发布范围', exact: true }).selectOption('public');
    await publication.getByRole('button', { name: '预览将公开的内容', exact: true }).click();
    const reviewed = publication.getByRole('checkbox', { name: '我已审阅保存的草稿及发布范围', exact: true });
    await reviewed.check(); const publishButton = publication.getByRole('button', { name: '发布并检查', exact: true });
    assert.equal(await publishButton.isEnabled(), true);
    await publication.getByRole('textbox', { name: '此版本的更新说明（可选）', exact: true }).fill('第二版：补充下一步推导的承接关系');
    assert.equal(await reviewed.isChecked(), false); assert.equal(await publishButton.isDisabled(), true);
    await reviewed.check(); const submitted = reply(page, 'POST', `/api/research/library/${skill.id}/publish`);
    await publishButton.click(); const released = await submitted; assert.equal(released.status(), 202);
    assert.equal(released.request().postDataJSON().releaseNotes, '第二版：补充下一步推导的承接关系');
    await publication.getByRole('link', { name: '查看发布版本', exact: true }).waitFor();
    assert.equal(fixtures.release(owner, skill.id, 'v2').releaseNotes, '第二版：补充下一步推导的承接关系');
    await page.goto(origin + '/workspace.html?tab=inbox#asset-updates');
    const updates = page.locator('#asset-updates'); await updates.getByText('第二版：补充下一步推导的承接关系', { exact: true }).waitFor();
    await updates.getByRole('link', { name: '查看版本差异', exact: true }).click();
    const comparison = page.locator('[data-release-comparison]'); await comparison.getByRole('heading', { name: 'v1 → v2', exact: true }).waitFor();
    await comparison.getByText('第二版：补充下一步推导的承接关系', { exact: true }).waitFor();
    await comparison.locator('summary').filter({ hasText: 'instructions' }).click();
    await comparison.getByLabel('逐行内容差异', { exact: true }).filter({ hasText: '记录下一步如何推出' }).waitFor();
    await page.screenshot({ path: path.join(output, `release-comparison-${width}.png`), fullPage: true });
    await page.goto(origin + '/workspace.html?tab=inbox#asset-updates');
    await page.locator('#asset-updates').getByRole('button', { name: '标为已读', exact: true }).click();
    await page.locator('#asset-updates').getByText('关注成果暂时没有未读更新。', { exact: true }).waitFor();

    await page.goto(`${origin}/library.html?entry=${math.id}&version=v1`);
    await page.locator('[data-bookmark-control]>summary').click();
    await page.locator('[data-bookmark-control]').getByRole('textbox', { name: '私人备注（可选）', exact: true }).fill('后续研究采用这个精确数学版本');
    await page.locator('[data-bookmark-control]').getByRole('button', { name: '保存收藏', exact: true }).click();
    await page.locator('[data-bookmark-control]').getByText('已保存到你的资料夹。', { exact: true }).waitFor();
    await page.locator('[data-bookmark-control]').getByRole('link', { name: '管理资料夹', exact: true }).click();
    await page.getByRole('checkbox', { name: '选择此数学成果', exact: true }).check();
    const checkbox = await page.getByRole('checkbox', { name: '选择此数学成果', exact: true }).boundingBox();
    assert.ok(checkbox && checkbox.width <= 20 && checkbox.height <= 20, `Checkbox must retain its compact size: ${JSON.stringify(checkbox)}`);
    const layout = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
    assert.ok(layout.content <= layout.viewport + 1, `Collection overflow: ${JSON.stringify(layout)}`);
    await page.screenshot({ path: path.join(output, `mixed-collection-${width}.png`), fullPage: true });
    let finishPrepare!: (result: { status: number; body: { item: ResearchCollectionPreparation } }) => void;
    const preparation = new Promise<{ status: number; body: { item: ResearchCollectionPreparation } }>(resolve => { finishPrepare = resolve; });
    await page.route(`**/api/research/collections/${collection.id}/prepare`, async route => {
      const response = await route.fetch();
      const body = await response.json(); finishPrepare({ status: response.status(), body });
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '用选中的数学成果准备研究', exact: true }).click();
    const prepared = await preparation; assert.equal(prepared.status, 200);
    const body = prepared.body; assert.deepEqual(body.item.refs, [{ assetId: math.id, version: 'v1', digest: mathRelease.digest }]);
    await page.waitForURL(url => url.pathname === '/' && url.searchParams.get('researchAsset') === math.id);
    await page.locator('.composer-research-selection').getByText(`自然数加法 ${width} · v1`, { exact: true }).waitFor();
    const selected = await page.evaluate(() => JSON.parse(sessionStorage.getItem('theoremos.research.selection') ?? '[]'));
    assert.deepEqual(selected, body.item.refs); assert.equal(runnerCalls, 0);
    collection = (await http<{ items: ResearchCollection[] }>(page, '/api/research/collections')).items[0];
    assert.equal(collection.items.length, 2);
    checks.push({ width, layout, uncertainSaveAttempts: attempts.length, bookmarks: collection.items.length,
      collectionId: collection.id, fixedVersion: body.item.refs[0], prepareStatus: prepared.status });
    await context.close(); active = undefined;
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(runnerCalls, 0); assert.equal(mailCalls, 0);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, runnerCalls, mailCalls, errors, external }, null, 2));
  console.log(JSON.stringify({ status: 'passed', output, checks: checks.length, runnerCalls, mailCalls }));
} catch (error) {
  if (active) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', phase, error: String(error), checks, runnerCalls, mailCalls, errors, external }, null, 2));
  throw error;
} finally {
  await browser.close(); await fixtures.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
