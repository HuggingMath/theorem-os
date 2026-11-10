#!/usr/bin/env bun
// Disposable recorded HTTP/browser fixtures; no model, Lean, mail or production access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { loadWebSample } from '../apps/web/sample';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebResearchCollections } from '../apps/web/researchCollections';
import { freePort, startBrowser } from './web-scenario';
const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/product-continuity/research-lifecycle/reuse');
await fs.mkdir(output, { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-collections-lifecycle-'));
const sample = loadWebSample()!, port = await freePort(), origin = `http://127.0.0.1:${port}`;
let recorded = 0, prohibited = 0;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: temp }), {
  async readiness() { return { ready: true, message: 'Recorded collection lifecycle fixture' }; },
  async run(input, send) {
    recorded++;
    for (const saved of sample.observations) {
      const observation = structuredClone(saved); observation.webRunId = input.id;
      observation.inspection.tasks[0].informalProof = '推导 / Derivation: $\\frac{1}{n(n+1)}=\\frac{1}{n}-\\frac{1}{n+1}$; $\\sum_{k=1}^{n}\\frac{1}{k(k+1)}=1-\\frac{1}{n+1}$. $\\int_0^1 x^2\\,dx=\\frac{1}{3}$; $\\mathbb{R}$; $\\mathbf{x}$.';
      send({ type: 'observation', observation });
    }
    send({ type: 'result', result: { status: 'evaluated_passed', proof: sample.run.result!.proof, report: { usage: { totalTokens: 100 } } } });
  },
  async check() { prohibited++; throw new Error('No real Lean'); }, async formalize() { prohibited++; throw new Error('No model'); },
}, { mailer: async () => { prohibited++; throw new Error('No mail'); } });
const browser = await startBrowser(service.server, port), fixtures = new WebResearchAssets(service.storage, { identity: owner => service.research.projects.identity(owner) });
const collections = new WebResearchCollections({ storage: service.storage, projects: service.research.projects, assets: service.research.assets });
const errors: string[] = [], external: string[] = [], checks: object[] = [], exports: { file: string; language: string; width: number; title: string }[] = [];
let phase = 'setup', active: Page | undefined, failure: unknown, serviceClosed = false;
const read = (page: Page, url: string) => page.evaluate(async url => { const response = await fetch(url); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }, url);
async function fits(page: Page) {
  const result = await page.evaluate(() => ({ width: innerWidth, body: document.body.scrollWidth, root: document.documentElement.scrollWidth }));
  assert.ok(Math.max(result.body, result.root) <= result.width + 1, JSON.stringify(result)); return result;
}
try {
  for (const { language, width } of [{ language: 'zh', width: 1440 }, { language: 'en', width: 390 }]) {
    const text = (zh: string, en: string) => language === 'zh' ? zh : en;
    phase = `collections-${language}-${width}`;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: language === 'zh' ? 'zh-CN' : 'en-US', reducedMotion: 'reduce' });
    await context.addInitScript(language => localStorage.setItem('theorem-os.locale.v1', language), language);
    await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(12_000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/workspace.html?tab=collections'); await page.getByRole('heading', { name: text('专题资料夹', 'Research collections'), exact: true }).waitFor();
    const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const first = collections.create(owner, { requestId: `first-${width}`, title: text('正在整理的数论材料', 'Number theory notes') });
    const second = collections.create(owner, { requestId: `second-${width}`, title: text('另一个资料夹', 'Another collection') });
    const skill = fixtures.create(owner, { requestId: `skill-${width}`, type: 'skill', name: 'Induction review', content: { instructions: 'Check assumptions', steps: ['Check assumptions'], slots: ['M1'] } });
    const preview = await fixtures.preview(owner, skill.id), queued = await fixtures.publish(owner, skill.id, { requestId: `publish-${width}`, expectedRevision: skill.revision,
      previewDigest: preview.previewDigest, version: 'v1', license: 'MIT', visibility: 'public' });
    await fixtures.waitForPublication(owner, queued.id);
    collections.saveItem(owner, first.id, { requestId: `note-${width}`, expectedRevision: first.revision, target: { kind: 'release', assetId: skill.id, version: 'v1' }, note: 'Private derivation notes / 私人推导笔记' });
    await page.reload(); const choice = page.getByRole('combobox', { name: text('打开资料夹', 'Open collection'), exact: true }); await choice.waitFor();
    await choice.selectOption(second.id); await choice.selectOption(first.id);
    assert.equal(new URL(page.url()).searchParams.get('collection'), first.id);
    await page.reload(); await page.locator(`[data-collection-id="${first.id}"]`).waitFor();
    await page.locator('.workspace-tabs a[href*="tab=search"]').click(); await page.locator('.workspace-tabs a[href*="tab=collections"]').click();
    await page.locator(`[data-collection-id="${first.id}"]`).waitFor();
    const copy = await context.newPage(); await copy.goto(page.url()); await copy.locator(`[data-collection-id="${first.id}"]`).waitFor(); await copy.close();
    await choice.selectOption(second.id); await page.goBack(); await page.locator(`[data-collection-id="${first.id}"]`).waitFor();
    await page.goForward(); await page.locator(`[data-collection-id="${second.id}"]`).waitFor();
    await page.goto(`${origin}/workspace.html?tab=collections&collection=collection_${'f'.repeat(32)}`);
    await page.locator('[data-collection-unavailable]').waitFor(); assert.equal(await page.locator('[data-collection-id]').count(), 0);
    await page.screenshot({ path: path.join(output, `unavailable-${language}-${width}.png`), fullPage: true }); await fits(page);
    await choice.selectOption(first.id); const detail = page.locator(`[data-collection-id="${first.id}"]`); await detail.waitFor();
    let deletes = 0; page.on('request', request => { if (request.method() === 'DELETE' && request.url().endsWith('/collections/' + first.id)) deletes++; });
    await detail.getByText(text('编辑资料夹', 'Edit collection'), { exact: true }).click();
    await detail.getByRole('button', { name: text('删除资料夹', 'Delete collection'), exact: true }).click();
    const confirm = detail.locator('[data-collection-delete-confirm]'); await confirm.waitFor(); assert.ok((await confirm.textContent())!.includes(first.title));
    assert.ok((await confirm.textContent())!.includes(text('含私人备注：1', 'With private notes: 1'))); assert.equal(deletes, 0);
    await confirm.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, `delete-confirm-${language}-${width}.png`) }); await fits(page);
    await confirm.getByRole('button', { name: text('取消', 'Cancel'), exact: true }).click(); assert.equal(await confirm.count(), 0); assert.equal(deletes, 0);
    assert.equal(collections.get(owner, first.id).items[0].note, 'Private derivation notes / 私人推导笔记');
    await detail.getByRole('button', { name: text('删除资料夹', 'Delete collection'), exact: true }).click();
    const deleted = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith('/collections/' + first.id));
    await confirm.getByRole('button', { name: text('确认删除资料夹与备注', 'Delete collection and notes'), exact: true }).click(); assert.equal((await deleted).status(), 200);
    await page.locator('[data-collection-deleted]').waitFor(); assert.equal(deletes, 1); assert.equal(await page.locator('[data-collection-id]').count(), 0);
    await page.reload(); await page.locator('[data-collection-unavailable]').waitFor(); assert.equal(await page.locator('[data-collection-id]').count(), 0);
    await choice.selectOption(second.id); await page.locator(`[data-collection-id="${second.id}"]`).waitFor();
    // A new collection selects its actual new identity and survives refresh.
    await page.getByRole('textbox', { name: text('新资料夹名称', 'New collection name'), exact: true }).fill('Fresh saved collection');
    await page.getByRole('button', { name: text('新建资料夹', 'New collection'), exact: true }).click(); await page.getByRole('heading', { name: 'Fresh saved collection', exact: true }).waitFor();
    const createdId = new URL(page.url()).searchParams.get('collection'); assert.ok(createdId); await page.reload(); await page.locator(`[data-collection-id="${createdId}"]`).waitFor();
    const session = await read(page, '/api/session'), provider = session.providers[0];
    const title = text('已通过的求和证明', 'Accepted summation proof');
    const run = service.jobs.create(owner, { providerId: provider.id, apiKey: 'sk-disposable-never-used', model: 'fixture', effort: 'high', environment: sample.run.environment,
      source: sample.run.source.trim(), task: title, maxTurns: 2, maxRunSeconds: 60, maxTotalTokens: 10000, workers: 2, coordination: 'cooperative' }, provider);
    await page.waitForFunction(async id => (await (await fetch('/api/runs/' + id)).json()).run.status === 'completed', run.id);
    phase = `export-${language}-${width}`; await page.goto(`${origin}/workspace.html?tab=brief&run=${run.id}`); const brief = page.locator('[data-research-brief]'); await brief.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-research-brief] .katex').length > 0 && !document.querySelector('[data-math-state="loading"]'));
    const downloaded = page.waitForEvent('download'); await brief.getByRole('button', { name: 'HTML', exact: true }).click(); const download = await downloaded;
    const file = path.join(output, `brief-${language}-${width}.html`); await download.saveAs(file); const html = await fs.readFile(file, 'utf8');
    assert.ok(html.includes('charset="utf-8"')); assert.ok(!/url\(["']?https?:/u.test(html)); assert.ok(!html.includes('<script'));
    assert.ok(html.includes('data:font/woff2;base64,')); assert.ok(!html.includes('sk-disposable-never-used'));
    const faces = html.match(/@font-face/gu)?.length ?? 0; assert.ok(faces > 0 && faces < 20, `Only used fonts: ${faces}`);
    exports.push({ file, language, width, title }); checks.push({ language, width, collectionHistoryAndReload: true, exactLinkInSecondWindow: true, invalidLinkIsExplicit: true,
      cancelDeletesNothing: true, confirmedDeletes: deletes, deletedLinkDoesNotSwitchCollection: true, newCollectionSurvivesReload: true, embeddedFaces: faces, exportBytes: html.length });
    await context.close(); active = undefined;
  }
  await fixtures.close(); await service.close(); serviceClosed = true;
  // Reopen the unmodified downloads using file:// after the server is actually stopped.
  for (const item of exports) {
    phase = `offline-${item.language}-${item.width}`;
    const context = await browser.newContext({ viewport: { width: item.width, height: 1000 }, locale: item.language === 'zh' ? 'zh-CN' : 'en-US', offline: true });
    const requests: string[] = []; await context.route(/^https?:\/\//u, route => { requests.push(route.request().url()); return route.abort(); });
    const page = await context.newPage(); active = page; await page.goto('file://' + item.file); await page.evaluate(() => document.fonts.ready);
    const state = await page.evaluate(() => ({ encoding: document.characterSet, heading: document.querySelector('h2')?.textContent,
      fonts: Array.from(document.fonts).filter(font => font.status !== 'unloaded').map(font => ({ family: font.family, status: font.status })),
      math: document.querySelectorAll('.katex').length, closedDetails: document.querySelectorAll('details:not([open])').length }));
    assert.equal(state.heading, item.title); assert.equal(state.encoding, 'UTF-8'); assert.equal(state.closedDetails, 0); assert.ok(state.math >= 5);
    assert.ok(state.fonts.some(font => font.family === 'KaTeX_Main')); assert.ok(state.fonts.every(font => font.status === 'loaded')); assert.deepEqual(requests, []);
    const layout = await fits(page); await page.locator('.workspace-derivation').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `offline-${item.language}-${item.width}-viewport.png`) });
    await page.screenshot({ path: path.join(output, `offline-${item.language}-${item.width}.png`), fullPage: true });
    checks.push({ language: item.language, width: item.width, offline: true, serverStopped: serviceClosed, requests, state, layout }); await context.close(); active = undefined;
  }
  assert.equal(prohibited, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) { failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, build: JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8')),
    checks, errors, external, recorded, prohibited, ...(failure ? { error: String(failure) } : {}) }, null, 2));
  await browser.close(); if (!serviceClosed) { await fixtures.close(); await service.close(); } await fs.rm(temp, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(JSON.stringify({ status: 'passed', workflows: checks.length, recorded, prohibited, output }));
