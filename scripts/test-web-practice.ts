#!/usr/bin/env bun
// A disposable static server: no account, API, model, Lean or production data is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { practiceStorageKey, recordedPracticeEvidence } from '../apps/web/client/researchPracticeModel';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/practice');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-practice-'));
await fs.mkdir(output, { recursive: true });
await Promise.all(['practice', 'theme', 'math'].map(entry => build({ entryPoints: [path.join(root, `apps/web/client/${entry}.ts`)],
  outfile: path.join(temporary, `${entry}.js`), bundle: true, target: 'es2023', platform: 'browser', jsx: 'automatic', jsxImportSource: 'preact', format: 'iife' })));
const mime: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const errors: string[] = [], unexpected: string[] = [], writes: string[] = [], results: unknown[] = [];
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    if (pathname === '/app.css') {
      response.writeHead(200, { 'Content-Type': 'text/css' });
      response.end(await fs.readFile(path.join(root, 'apps/web/client/app.css'), 'utf8') + '\n' + await fs.readFile(path.join(root, 'apps/web/math.css'), 'utf8')); return;
    }
    let file: string;
    if (/^\/(?:practice|theme|math)\.js$/u.test(pathname)) file = path.join(temporary, pathname.slice(1));
    else if (pathname.startsWith('/assets/katex/')) file = path.join(root, 'node_modules/katex/dist', pathname.slice('/assets/katex/'.length));
    else if (pathname.startsWith('/assets/')) file = path.join(root, 'docs', pathname);
    else if (['/practice.html', '/researchPractice.css'].includes(pathname)) file = path.join(root, 'apps/web/client', pathname);
    else { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' }); response.end(await fs.readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true });
let failure: unknown;
try {
  for (const language of ['zh', 'en']) for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage(), label = `${language}-${width}`;
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.route('**/*', route => {
      const request = route.request();
      if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
      if (new URL(request.url()).origin !== origin || new URL(request.url()).pathname.startsWith('/api/')) {
        unexpected.push(request.url()); return route.abort();
      }
      return route.continue();
    });
    const checkWidth = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Overflow: ${label}`);
    await page.goto(`${origin}/practice.html?lang=${language}`);
    await page.waitForSelector('[data-research-practice]');
    await page.waitForSelector('[data-math-state="ready"]');
    assert.equal(await page.locator('[data-practice-node=evidence]').isDisabled(), true);
    await page.locator('[value=split][name=practice-route]').check();
    await page.locator('#practice-plan-note').fill('保留原题两个目标 / keep both goals');
    assert.equal(await page.locator('[data-practice-approve]').isDisabled(), true);
    await page.locator('[data-practice-save-plan]').click();
    await page.waitForSelector('[data-practice-revision="2"]');
    await checkWidth(); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: path.join(output, `${label}-plan.png`), fullPage: true });
    await page.locator('[data-practice-approve]').focus(); await page.keyboard.press('Enter');
    await page.waitForSelector('[data-practice-panel=right]');
    await page.locator('[data-practice-next]').click();
    await page.locator('[value=drop-goal][name=practice-guidance]').check();
    await page.locator('#practice-guidance-note').fill('This should preserve the original problem.');
    await page.locator('[data-practice-send-guidance]').click();
    await page.waitForSelector('[data-practice-guidance=declined]');
    assert.equal(await page.locator('[data-practice-node=evidence]').isDisabled(), true);
    await page.locator('[value=use-lemma][name=practice-guidance]').check();
    await page.locator('#practice-guidance-note').fill('Use the standard-library lemma.');
    await page.locator('[data-practice-send-guidance]').click();
    await page.waitForSelector('[data-practice-guidance=accepted]');
    assert.equal(await page.locator('[data-practice-guidance=declined]').count(), 1);
    assert.equal(await page.locator('[data-practice-node=evidence]').isDisabled(), false);
    assert.match(await page.locator('.practice-source code').innerText(), /exact Nat.zero_add n/u);
    await checkWidth(); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: path.join(output, `${label}-guidance.png`), fullPage: true });
    await page.locator('[data-practice-open-evidence]').click();
    for (const target of recordedPracticeEvidence.targets) assert.ok((await page.locator('.practice-receipts').innerText()).includes(target.receiptId));
    await page.locator('[data-practice-save-receipt]').click();
    await page.waitForSelector('[data-practice-saved]');
    const downloadWait = page.waitForEvent('download'); await page.locator('[data-practice-download]').click();
    const download = await downloadWait, downloadFile = await download.path();
    const record = JSON.parse(await fs.readFile(downloadFile!, 'utf8'));
    assert.equal(record.mode, 'recorded-practice'); assert.equal(record.modelInvoked, false); assert.equal(record.leanInvoked, false);
    assert.equal(record.exercise.revision, 2); assert.equal(record.exercise.guidance.length, 2);
    assert.equal(record.originalRecording.evidence.checkedAt, recordedPracticeEvidence.checkedAt);
    await checkWidth(); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: path.join(output, `${label}-evidence.png`), fullPage: true });
    await page.reload(); await page.waitForSelector('[data-practice-panel=evidence] [data-practice-saved]');
    await page.locator('[data-practice-node=plan]').click();
    await page.locator('[value=direct][name=practice-route]').check();
    await page.locator('[data-practice-save-plan]').click();
    await page.waitForSelector('[data-practice-revision="3"]');
    assert.equal(await page.locator('[data-practice-node=right]').isDisabled(), true);
    assert.equal(await page.locator('[data-practice-node=evidence]').isDisabled(), true);
    const current = JSON.parse(await page.evaluate(key => localStorage.getItem(key)!, practiceStorageKey));
    assert.equal(current.approvedRevision, null); assert.equal(current.savedReceipt, undefined); assert.equal(current.guidance.length, 2);
    await page.locator('[data-practice-reset]').click(); await page.waitForSelector('[data-practice-revision="1"]');
    assert.equal(await page.locator('[data-practice-node=right]').isDisabled(), true);
    results.push({ language, width, planRevision: 2, guidance: ['declined', 'accepted'], receiptIds: recordedPracticeEvidence.targets.map(item => item.receiptId), reload: 'restored', editedPlan: 'requires new approval' });
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => { Storage.prototype.setItem = () => { throw new Error('Storage unavailable in fixture'); }; });
  const page = await context.newPage(); await page.goto(`${origin}/practice.html?lang=en`);
  await page.waitForSelector('.practice-history [role=alert]');
  await page.locator('[data-practice-approve]').click(); await page.locator('[data-practice-next]').click();
  await page.locator('[data-practice-send-guidance]').click(); await page.locator('[data-practice-open-evidence]').click();
  await page.locator('[data-practice-save-receipt]').click();
  assert.equal(await page.locator('[data-practice-saved]').count(), 1);
  results.push({ language: 'en', width: 390, storageUnavailable: 'exercise remains usable with an explicit notice' });
  await context.close();
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(writes, []);
} catch (error) {
  failure = error;
  await browser.contexts().at(-1)?.pages().at(-1)?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
}
finally {
  await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(temporary, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ results, errors, unexpected, writes, ...(failure ? { failure: String(failure) } : {}) }, null, 2));
}
if (failure) throw failure;
console.log(`Recorded research exercise passed ${results.length} scenarios. No API, model, Lean or write requests.`);
