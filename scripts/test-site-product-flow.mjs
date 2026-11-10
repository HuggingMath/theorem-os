import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'out/site');
const output = path.join(root, 'out/product-flow/site');
fs.mkdirSync(output, { recursive: true });
const receipt = JSON.parse(fs.readFileSync(path.join(site, 'assets/replay.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(site, 'data/catalog.json'), 'utf8'));
const evidenceRecord = catalog.records.find(record => record.id === 'dimitrov');
const errors = [];
const writes = [];
const unexpectedRequests = [];
const results = [];
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  let file = path.resolve(site, `.${pathname}`);
  if (!file.startsWith(site + path.sep)) { response.writeHead(404).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  response.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const newPage = async options => {
  const page = await browser.newPage({ reducedMotion: 'reduce', ...options });
  await page.route('https://cloud.umami.is/**', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  page.on('pageerror', error => errors.push(`${page.url()}: ${error.message}`));
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  page.on('request', request => {
    if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
    const url = new URL(request.url());
    if (url.origin !== origin && url.hostname !== 'cloud.umami.is') unexpectedRequests.push(request.url());
  });
  return page;
};
const checkWidth = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Horizontal overflow: ${label}`);

try {
  for (const locale of ['zh', 'en']) {
    const home = `${origin}/${locale === 'en' ? 'en/' : ''}index.html`;
    for (const width of [1440, 768, 390, 320]) {
      const page = await newPage({ viewport: { width, height: 1000 } });
      await page.goto(home);
      await page.waitForSelector('[data-decision-state="review"]');
      const example = page.locator('[data-human-decision]');
      const continuation = example.locator('[data-decision-continue]');
      const confirm = example.locator('[data-decision="confirm"]');
      const revise = example.locator('[data-decision="revise"]');
      const reset = example.locator('[data-decision="reset"]');
      const targets = await example.locator('.decision-targets li').allTextContents();
      assert.equal(targets.length, receipt.targets.length);
      receipt.targets.forEach((target, index) => {
        assert.ok(targets[index].includes(target.theorem), 'The example must use real tutorial targets');
        assert.ok(targets[index].includes(target.declaration.slice(target.declaration.lastIndexOf(' : ') + 3)), 'The mathematical goal must match the recorded tutorial');
      });
      assert.equal(await continuation.isVisible(), false, 'The next step stays unavailable before confirmation');
      await revise.focus();
      await page.keyboard.press('Enter');
      assert.equal(await example.getAttribute('data-decision-state'), 'revise');
      assert.equal(await continuation.isVisible(), false, 'Requesting changes must keep the proof stage locked');
      assert.equal(await revise.getAttribute('aria-pressed'), 'true');
      await confirm.focus();
      await page.keyboard.press('Space');
      assert.equal(await example.getAttribute('data-decision-state'), 'confirm');
      assert.equal(await continuation.isVisible(), true, 'Human confirmation must unlock an actual next action');
      assert.equal(await confirm.getAttribute('aria-pressed'), 'true');
      assert.match(await example.locator('[data-decision-description]').innerText(), /已有|recorded/);
      await checkWidth(page, `${locale}-${width}-confirmed`);
      await page.locator('.human-decision').screenshot({ path: path.join(output, `${locale}-${width}-human-confirmed.png`) });
      await revise.click();
      assert.equal(await continuation.isVisible(), false, 'Returning to review must close the next action again');
      await reset.click();
      assert.equal(await example.getAttribute('data-decision-state'), 'review');
      assert.equal(await confirm.evaluate(button => button === document.activeElement), true, 'Reset must return focus to an available control');
      await confirm.click();
      await continuation.click();
      await page.waitForSelector('#quickstart-view .replay-window');
      assert.equal(new URL(page.url()).hash, '#view=quickstart');
      assert.equal(await page.locator('#quickstart-view').isVisible(), true, 'The unlocked action must open the real tutorial replay');

      await page.goto(home);
      await page.waitForSelector('[data-decision-state="review"]');
      await page.locator('.case-guide').screenshot({ path: path.join(output, `${locale}-${width}-reading-guide.png`) });
      const destinations = {};
      for (const kind of ['intro', 'route', 'evidence']) {
        const link = page.locator(`[data-case-guide="${kind}"]`);
        assert.equal(await link.count(), 1);
        destinations[kind] = await link.getAttribute('href');
        const box = await link.boundingBox();
        assert.ok(box.height >= 44, 'Every reading path must provide a usable touch target');
      }
      await checkWidth(page, `${locale}-${width}-guide`);
      if (width === 1440 || width === 390) {
        await page.locator('[data-case-guide="intro"]').click();
        await page.waitForSelector('#quickstart-view .replay-window');
        assert.equal(await page.locator('#quickstart-view').isVisible(), true);
        await page.goto(home);
        await page.locator('[data-case-guide="route"]').click();
        await page.waitForSelector('[data-proof-walkthrough="openai_triangle_face"]');
        assert.equal(await page.locator('[data-tab="process"][aria-selected="true"]').count(), 1);
        assert.equal(await page.locator('.process-global-trajectory').isVisible(), true);
        assert.ok(await page.locator('[data-proof-route-step]').count() > 1, 'The complex case must include an interactive mathematical route');
        await page.goto(home);
        await page.locator('[data-case-guide="evidence"]').click();
        await page.waitForSelector('[data-tab="evidence"][aria-selected="true"]');
        assert.equal(await page.locator('.detail-id').innerText(), evidenceRecord.id);
        assert.equal(await page.locator('.official-result-link').getAttribute('href'), evidenceRecord.official.resultUrl);
      }
      results.push({ locale, width, destinations, confirmation: 'keyboard, revise, confirm, relock and reset passed' });
      await page.close();
    }

    const fallback = await newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 1000 } });
    await fallback.goto(home);
    assert.equal(await fallback.locator('.decision-fallback').isVisible(), true, 'The no-script explanation must remain readable');
    assert.equal(await fallback.locator('[data-decision-controls]').isVisible(), false);
    assert.equal(await fallback.locator('.decision-fallback a').getAttribute('href'), 'archive.html#view=quickstart');
    assert.equal(await fallback.locator('[data-case-guide]').count(), 3);
    await checkWidth(fallback, `${locale}-no-script`);
    await fallback.close();
  }
  assert.deepEqual(errors, [], 'The new flow must run without browser or HTTP errors');
  assert.deepEqual(writes, [], 'The demonstration must not write data or start research');
  assert.deepEqual(unexpectedRequests, [], 'The demonstration must not call models or workbench services');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, errors, writes, unexpectedRequests }, null, 2) + '\n');
  console.log(`Product homepage flow passed: ${results.length} locale/viewport combinations, real destinations, keyboard interaction and no-script fallbacks.`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
