#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = import.meta.dirname;
const output = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'theoremos-e02-prototype'));
await fs.mkdir(output, { recursive: true });
const checks = [], errors = [], external = [], writes = [], unavailable = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Read only', { status: 405 });
  const relative = decodeURIComponent(new URL(request.url).pathname).replace(/^\//u, '') || 'index.html';
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${root}/`)) return new Response('Not found', { status: 404 });
  const body = Bun.file(file);
  return await body.exists() ? new Response(request.method === 'HEAD' ? null : body) : new Response('Not found', { status: 404 });
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ headless: true });
let page, failure, phase = 'setup';
const example = JSON.parse(await fs.readFile(path.join(root, 'case.json'), 'utf8'));
const recorded = JSON.parse(await fs.readFile(path.join(root, 'recorded-checks.json'), 'utf8'));
const record = (id, width, details = {}) => checks.push({ id, width, ...details });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.route(/^https?:\/\//u, async route => {
      const request = route.request();
      if (new URL(request.url()).origin !== origin) { external.push(request.url()); await route.abort(); return; }
      if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${request.url()}`);
      await route.continue();
    });
    page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) unavailable.push(`${response.status()} ${response.url()}`); });
    phase = `${width}-initial`;
    await page.goto(origin); await page.locator('#workspace').waitFor({ state: 'visible' });
    assert.match(await page.locator('.intro-note').innerText(), /已保存的真实 Lean/);
    assert.equal(await page.locator('#view-check').isDisabled(), true);
    assert.equal(await page.locator('#attempt-panel').isVisible(), false);
    assert.equal(await page.locator('#acceptance-status').innerText(), '未执行');
    record('initial-no-attempt-no-acceptance', width);

    phase = `${width}-source-and-reference`;
    await page.locator('.source-details > summary').click();
    assert.ok((await page.locator('#source-metadata').innerText()).includes(example.entry.version));
    assert.ok((await page.locator('#full-type').innerText()).includes('PosMulReflectLT'));
    for (const selector of ['#target-source', '#entry-source', '#entry-license']) {
      const href = await page.locator(selector).getAttribute('href');
      const response = await context.request.get(new URL(href, origin).href);
      assert.equal(response.ok(), true, selector);
    }
    await page.getByRole('button', { name: '加入参考', exact: true }).click();
    assert.equal(await page.locator('#reference-status').innerText(), '已固定版本');
    assert.equal(await page.locator('#attempt-status').innerText(), '未创建');
    assert.equal(await page.locator('#view-check').isDisabled(), true);
    assert.equal(await page.locator('#application-status').innerText(), '未查看');
    record('reference-pins-version-without-attempt', width);

    phase = `${width}-positive-attempt`;
    await page.getByRole('button', { name: '尝试应用', exact: true }).click();
    const positiveId = await page.locator('#attempt-id').innerText();
    assert.match(positiveId, /^e02-local-/);
    assert.equal(await page.locator('#check-panel').isVisible(), false);
    assert.equal(await page.locator('#application-status').innerText(), '未查看');
    await page.getByRole('button', { name: '查看检查结果', exact: true }).click();
    assert.equal(await page.locator('#check-badge').innerText(), 'elaborated');
    assert.ok((await page.locator('#check-versions').innerText()).includes(recorded.checks.find(check => check.branchId === 'positive').projectionDigest));
    assert.match(await page.locator('#declaration-use').innerText(), /确实包含/);
    for (const href of await page.locator('#check-artifacts a').evaluateAll(anchors => anchors.map(anchor => anchor.href)))
      assert.equal((await context.request.get(href)).ok(), true, href);
    assert.equal(await page.locator('#obligations li[data-status="open"]').count(), 0);
    assert.equal(await page.locator('#acceptance-status').innerText(), '未执行');
    await page.screenshot({ path: path.join(output, `positive-${width}.png`), fullPage: true });
    record('positive-real-check-without-S3', width, { attemptId: positiveId });

    phase = `${width}-weak-isolation`;
    await page.locator('input[value="nonnegative"]').check();
    assert.equal(await page.locator('#attempt-status').innerText(), '未创建');
    assert.equal(await page.locator('#reference-status').innerText(), '未加入');
    assert.equal(await page.locator('#application-status').innerText(), '未查看');
    assert.equal(await page.locator('#view-check').isDisabled(), true);
    assert.equal(await page.locator('#check-panel').isVisible(), false);
    assert.ok((await page.locator('#assumptions').innerText()).includes('≤'));
    await page.getByRole('button', { name: '尝试应用', exact: true }).click();
    const weakId = await page.locator('#attempt-id').innerText();
    assert.notEqual(weakId, positiveId);
    await page.getByRole('button', { name: '查看检查结果', exact: true }).click();
    assert.equal(await page.locator('#check-badge').innerText(), 'failed');
    assert.equal(await page.locator('#obligations li[data-status="open"]').count() > 0, true);
    assert.match(await page.locator('#diagnostic').innerText(), /0 < b/);
    for (const href of await page.locator('#check-artifacts a').evaluateAll(anchors => anchors.map(anchor => anchor.href)))
      assert.equal((await context.request.get(href)).ok(), true, href);
    assert.equal(await page.locator('#counterexample').isVisible(), true);
    assert.equal(await page.locator('#counterexample-status').innerText(), 'Lean 编译退出 0');
    assert.equal(await page.locator('#acceptance-status').innerText(), '未执行');
    const counterexampleHref = await page.locator('#counterexample-source').getAttribute('href');
    assert.equal((await context.request.get(new URL(counterexampleHref, origin).href)).ok(), true);
    await page.screenshot({ path: path.join(output, `nonnegative-${width}.png`), fullPage: true });
    record('insufficient-premise-isolated-with-verified-counterexample', width, { attemptId: weakId });

    phase = `${width}-refresh-and-history`;
    await page.reload(); await page.locator('#workspace').waitFor({ state: 'visible' });
    assert.equal(await page.locator('input[value="nonnegative"]').isChecked(), true);
    assert.equal(await page.locator('#attempt-id').innerText(), weakId);
    assert.equal(await page.locator('#check-badge').innerText(), 'failed');
    await page.locator('input[value="positive"]').check();
    assert.equal(await page.locator('#attempt-id').innerText(), positiveId);
    assert.equal(await page.locator('#application-status').innerText(), '表达式检查通过');
    assert.equal(await page.locator('#reference-status').innerText(), '已固定版本');
    assert.equal(await page.locator('#counterexample').isVisible(), false);
    record('refresh-preserves-per-target-history', width);

    phase = `${width}-search-and-keyboard`;
    await page.locator('#search').fill('nothing-is-here');
    assert.equal(await page.locator('#no-results').isVisible(), true);
    assert.equal(await page.locator('#search-result').isVisible(), false);
    await page.locator('#search').fill('倒数不等式');
    assert.equal(await page.locator('#search-result').isVisible(), true);
    await page.locator('#search').fill('reciprocal');
    assert.equal(await page.locator('#search-result').isVisible(), true);
    await page.locator('#search-result').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'math-card');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    record('search-no-results-and-keyboard-card-navigation', width);
    await context.close(); page = undefined;
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []); assert.deepEqual(unavailable, []);
} catch (error) {
  failure = error;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify({ status: failure ? 'failed' : 'passed', phase,
    checks, errors, external, writes, unavailable, caseId: example.caseId, packageDigest: example.package.digest,
    liveBackendTasks: 0, liveModelCalls: 0, wholeProblemAcceptance: 'not-run', ...(failure ? { error: String(failure) } : {}) }, null, 2)}\n`);
  await browser.close(); await server.stop(true);
}
if (failure) throw failure;
console.log(`E02 prototype: ${checks.length} desktop/mobile behavioral checks passed; 0 external requests.`);
