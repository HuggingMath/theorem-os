#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { ResearchAsset } from '../apps/web/researchAssetTypes';
import type { WebRunner } from '../apps/web/runner';
import { deferred, freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_ROUND6_LIBRARY_OUTPUT ?? path.join(root, 'out/web-round6-library');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round6-library-'));
let runnerCalls = 0;
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Disposable Library save regressions' }; },
  async run() { runnerCalls++; throw new Error('Library save regressions must not start research'); } };
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner, { sample: null });
const browser = await startBrowser(service.server, port);
const pageErrors: string[] = [], externalRequests: string[] = [], checks: object[] = [];
const libraryPath = '/api/research/library';
type Attempt = { method: string; path: string; input: Record<string, unknown>; status: number; item: ResearchAsset };
const instructionsOf = (asset: ResearchAsset) => {
  assert.ok(asset.draft && 'instructions' in asset.draft); return asset.draft.instructions;
};
const panel = (page: Page, name: string) => page.locator('section.research-panel').filter({ has: page.getByRole('heading', { name, exact: true }) });
async function http<T>(page: Page, pathname: string): Promise<T> {
  const result = await page.evaluate(async pathname => {
    const response = await fetch(pathname);
    return { status: response.status, body: await response.json() };
  }, pathname);
  assert.equal(result.status, 200, `${pathname}: ${JSON.stringify(result)}`); return result.body;
}
async function saved(page: Page, id: string) { return (await http<{ item: ResearchAsset }>(page, `${libraryPath}/${id}`)).item; }
async function ownSkills(page: Page) { return (await http<{ items: ResearchAsset[] }>(page, libraryPath + '?type=skill&mine=1')).items; }
async function capture(page: Page, method: string, pathname: string, click: () => Promise<unknown>) {
  const delivered = deferred(); let captured: Attempt | undefined;
  // Read the real write response before delivery: a normal successful create navigates immediately.
  await page.route('**' + pathname, async route => {
    if (route.request().method() !== method) { await route.continue(); return; }
    const response = await route.fetch();
    captured = { method, path: pathname, input: route.request().postDataJSON(), status: response.status(),
      item: (await response.json()).item as ResearchAsset };
    await route.fulfill({ response }); delivered.resolve();
  });
  try { await click(); await delivered.promise; assert.ok(captured); return captured; }
  finally { await page.unroute('**' + pathname); }
}
const layoutEvidence: object[] = [];
async function shot(form: Locator, name: string) {
  const page = form.page();
  await page.evaluate(() => window.scrollTo(0, 0));
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width + 1, `${name}: horizontal overflow ${JSON.stringify(dimensions)}`);
  layoutEvidence.push({ screenshot: name, ...dimensions });
  // Keep document origin fixed: scrolling a tall locator can capture an offscreen fixed skip link in its clip.
  await page.screenshot({ path: path.join(output, name), fullPage: true });
}
let phase = 'setup', active: Page | undefined, failure: unknown;
try {
  for (const locale of ['zh', 'en'] as const) {
    const en = locale === 'en', label = en ? 'en-390' : 'zh-1440';
    const text = (zh: string, english: string) => en ? english : zh;
    const context = await browser.newContext({ locale: en ? 'en-US' : 'zh-CN', viewport: { width: en ? 390 : 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(locale => { try { localStorage.setItem('theorem-os.locale.v1', locale); } catch { /* The initial blank document has no storage. */ } }, locale);
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { externalRequests.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    context.on('page', page => { page.setDefaultTimeout(15_000); page.on('pageerror', error => pageErrors.push(label + ': ' + error.message)); });
    const page = await context.newPage(), control = await context.newPage(); active = page;
    const nameInput = (form: Locator) => form.getByRole('textbox', { name: text('名称', 'Name'), exact: true });
    const instructions = (form: Locator) => form.getByRole('textbox', { name: text('适用情境与执行要求', 'When to use and instructions'), exact: true });
    const saveButton = (form: Locator) => form.getByRole('button', { name: text('保存草稿', 'Save draft'), exact: true });
    const createButton = (form: Locator) => form.getByRole('button', { name: text('创建私有草稿', 'Create draft'), exact: true });
    async function creator(name: string, body: string) {
      await page.goto(origin + '/library.html?create=1');
      const form = panel(page, text('创建草稿', 'Create a draft'));
      await form.getByRole('combobox', { name: text('内容类型', 'Content type'), exact: true }).selectOption('skill');
      await nameInput(form).fill(name); await instructions(form).fill(body); return form;
    }
    try {
      await control.goto(origin + '/library.html');
      phase = `${label}: edits made during creation stay in the editor and save to the same asset`;
      const form = await creator(label + ' first saved name', 'FIRST SAVED INSTRUCTIONS');
      const reached = deferred(), release = deferred();
      let created: Attempt | undefined;
      await page.route('**' + libraryPath, async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        const response = await route.fetch();
        created = { method: 'POST', path: libraryPath, input: route.request().postDataJSON(), status: response.status(), item: (await response.json()).item };
        reached.resolve(); await release.promise; await route.fulfill({ response });
      });
      try {
        await createButton(form).click(); await reached.promise;
        assert.equal(await form.getByRole('combobox', { name: text('内容类型', 'Content type'), exact: true }).isEnabled(), false);
        await nameInput(form).fill(label + ' newer name');
        await instructions(form).fill('NEWER INSTRUCTIONS RETAINED AFTER CREATION');
        await form.getByRole('textbox', { name: text('用途与说明', 'Purpose and description'), exact: true }).fill('NEWER DESCRIPTION');
        await form.getByRole('textbox', { name: text('执行步骤，每行一步', 'Steps, one per line'), exact: true }).fill('NEWER STEP ONE\nNEWER STEP TWO');
        release.resolve(); await saveButton(form).waitFor();
        assert.ok(created); assert.equal(created.status, 201);
        assert.equal(new URL(page.url()).searchParams.get('entry'), null);
        assert.equal(await nameInput(form).inputValue(), label + ' newer name');
        assert.equal(await instructions(form).inputValue(), 'NEWER INSTRUCTIONS RETAINED AFTER CREATION');
        assert.match(await form.getByRole('status').innerText(), en ? /later edits.*save again/iu : /修改已保留.*继续保存/u);
        const firstStored = await saved(control, created.item.id);
        assert.equal(firstStored.name, label + ' first saved name');
        assert.equal(instructionsOf(firstStored), 'FIRST SAVED INSTRUCTIONS');
        await shot(form, label + '-newer-input-retained.png');
        const updated = await capture(page, 'PATCH', `${libraryPath}/${created.item.id}`, () => saveButton(form).click());
        assert.equal(updated.status, 200); assert.equal(updated.input.expectedRevision, created.item.revision);
        assert.equal(updated.item.id, created.item.id);
        await page.waitForURL(url => url.searchParams.get('entry') === created!.item.id);
        const stored = await saved(control, created.item.id);
        assert.equal(stored.name, label + ' newer name');
        assert.equal(stored.description, 'NEWER DESCRIPTION');
        assert.equal(instructionsOf(stored), 'NEWER INSTRUCTIONS RETAINED AFTER CREATION');
        assert.ok(stored.draft && 'steps' in stored.draft); assert.deepEqual(stored.draft.steps, ['NEWER STEP ONE', 'NEWER STEP TWO']);
        assert.equal((await ownSkills(control)).length, 1);
        checks.push({ name: phase, created, updated, oneAsset: true, newerInputRetained: true, persisted: stored }); console.log('PASS ' + phase);
      } finally { release.resolve(); await page.unroute('**' + libraryPath); }

      phase = `${label}: existing-asset PATCH keeps later input and advances the next save revision`;
      assert.ok(created);
      await page.getByRole('button', { name: text('编辑草稿', 'Edit draft'), exact: true }).click();
      const editor = panel(page, text('编辑草稿', 'Edit draft'));
      await instructions(editor).fill('FIRST PATCH CONTENT');
      const patchReached = deferred(), patchRelease = deferred(), assetPath = `${libraryPath}/${created.item.id}`;
      let firstPatch: Attempt | undefined;
      await page.route('**' + assetPath, async route => {
        if (route.request().method() !== 'PATCH') { await route.continue(); return; }
        const response = await route.fetch();
        firstPatch = { method: 'PATCH', path: assetPath, input: route.request().postDataJSON(), status: response.status(), item: (await response.json()).item };
        patchReached.resolve(); await patchRelease.promise; await route.fulfill({ response });
      });
      try {
        await saveButton(editor).click(); await patchReached.promise;
        await instructions(editor).fill('NEWER PATCH CONTENT');
        patchRelease.resolve();
        await editor.getByRole('status').waitFor();
        assert.match(await editor.getByRole('status').innerText(), en ? /later edits/iu : /修改已保留/u);
        assert.equal(await instructions(editor).inputValue(), 'NEWER PATCH CONTENT');
        assert.ok(firstPatch); assert.equal(firstPatch.status, 200);
        assert.equal(instructionsOf(await saved(control, created.item.id)), 'FIRST PATCH CONTENT');
        await shot(editor, label + '-patch-newer-input-retained.png');
      } finally { patchRelease.resolve(); await page.unroute('**' + assetPath); }
      assert.ok(firstPatch);
      const secondPatch = await capture(page, 'PATCH', assetPath, () => saveButton(editor).click());
      assert.equal(secondPatch.status, 200); assert.equal(secondPatch.input.expectedRevision, firstPatch.item.revision);
      assert.equal(secondPatch.item.id, created.item.id);
      assert.equal(instructionsOf(await saved(control, created.item.id)), 'NEWER PATCH CONTENT');
      assert.equal(await instructions(editor).inputValue(), 'NEWER PATCH CONTENT');
      checks.push({ name: phase, firstPatch, secondPatch, sameAsset: true, newerInputRetained: true }); console.log('PASS ' + phase);

      phase = `${label}: an incomplete real 201 response retries the original request and creates only one asset`;
      const retryName = label + ' incomplete receipt', retryForm = await creator(retryName, 'ONE RETRY INTENT');
      const attempts: Attempt[] = [];
      await page.route('**' + libraryPath, async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        const response = await route.fetch(), body = await response.json();
        attempts.push({ method: 'POST', path: libraryPath, input: route.request().postDataJSON(), status: response.status(), item: body.item });
        if (attempts.length === 1) {
          const headers = { ...response.headers() }; delete headers['content-length'];
          await route.fulfill({ status: response.status(), headers, body: JSON.stringify(body).slice(0, 20) });
        } else await route.fulfill({ response });
      });
      try {
        await createButton(retryForm).click(); await retryForm.getByRole('alert').waitFor();
        const message = await retryForm.getByRole('alert').innerText();
        assert.match(message, en ? /response.*read completely.*retry.*input.*preserved/iu : /响应未能完整读取.*重试.*输入已保留/u);
        assert.doesNotMatch(message, /Cannot read|undefined|SyntaxError|Unexpected token/iu);
        assert.equal(new URL(page.url()).searchParams.get('entry'), null);
        assert.equal(await nameInput(retryForm).inputValue(), retryName);
        assert.equal(await instructions(retryForm).inputValue(), 'ONE RETRY INTENT');
        assert.equal(attempts.length, 1); assert.equal(attempts[0]!.status, 201);
        assert.equal((await ownSkills(control)).filter(asset => asset.name === retryName).length, 1);
        await shot(retryForm, label + '-incomplete-response-human-message.png');
        await createButton(retryForm).click();
        await page.waitForURL(url => url.searchParams.get('entry') === attempts[0]!.item.id);
        assert.equal(attempts.length, 2); assert.equal(attempts[1]!.status, 201);
        assert.deepEqual(attempts[1]!.input, attempts[0]!.input);
        assert.equal(attempts[1]!.item.id, attempts[0]!.item.id);
        const assets = (await ownSkills(control)).filter(asset => asset.name === retryName);
        assert.equal(assets.length, 1); assert.equal(assets[0]!.id, attempts[0]!.item.id);
        assert.equal(instructionsOf(assets[0]!), 'ONE RETRY INTENT');
        checks.push({ name: phase, message, attempts, sameRequestId: attempts[0]!.input.requestId, oneAsset: true }); console.log('PASS ' + phase);
      } finally { await page.unroute('**' + libraryPath); }

      phase = `${label}: an intact 201 response creates one asset and opens its details normally`;
      const normalName = label + ' readable receipt', normal = await creator(normalName, 'NORMAL CREATION');
      const normalReply = await capture(page, 'POST', libraryPath, () => createButton(normal).click());
      assert.equal(normalReply.status, 201);
      await page.waitForURL(url => url.searchParams.get('entry') === normalReply.item.id);
      await page.getByRole('button', { name: text('编辑草稿', 'Edit draft'), exact: true }).waitFor();
      const normalAssets = (await ownSkills(control)).filter(asset => asset.name === normalName);
      assert.equal(normalAssets.length, 1); assert.equal(instructionsOf(normalAssets[0]!), 'NORMAL CREATION');
      assert.equal((await ownSkills(control)).length, 3);
      checks.push({ name: phase, response: normalReply, oneAsset: true, normalNavigation: true }); console.log('PASS ' + phase);
    } catch (cause) {
      await page.screenshot({ path: path.join(output, label + '-failure.png'), fullPage: true }).catch(() => {}); throw cause;
    } finally { await context.close(); active = undefined; }
  }
  assert.equal(checks.length, 8); assert.equal(runnerCalls, 0); assert.deepEqual(pageErrors, []); assert.deepEqual(externalRequests, []);
} catch (cause) {
  failure = cause; await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw cause;
} finally {
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    checks, layoutEvidence, pageErrors, externalRequests, runnerCalls, realModelCalls: 0, realLeanCalls: 0, productionWrites: false, fixturesRemoved: true,
    ...(failure ? { failedPhase: phase, error: String(failure) } : {}) }, null, 2) + '\n');
}
console.log(`Library round 6 passed ${checks.length} browser cases. Evidence: ${output}`);
