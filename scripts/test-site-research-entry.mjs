import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), site = path.join(root, 'out/site');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/site');
fs.mkdirSync(output, { recursive: true });
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  let file = path.resolve(site, `.${pathname}`);
  if (!file.startsWith(site + path.sep)) { response.writeHead(404).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { response.writeHead(404).end(); return; }
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  response.writeHead(200, { 'Content-Type': type[path.extname(file)] ?? 'application/octet-stream' }); fs.createReadStream(file).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const errors = [], writes = [], landings = [], results = [];
let failure;
try {
  for (const language of ['zh', 'en']) for (const width of [1440, 768, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.route('https://app.theoremos.top/**', route => {
      landings.push(route.request().url()); return route.fulfill({ contentType: 'text/html', body: '<h1>Fixed template destination captured locally</h1>' });
    });
    const home = `${origin}/${language === 'en' ? 'en/' : ''}index.html`;
    await page.goto(home); await page.waitForSelector('[data-decision-state=review]');
    const section = page.locator('.research-scenarios');
    await section.scrollIntoViewIfNeeded();
    assert.equal(await section.locator('[data-research-entry]').count(), 2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${language}-${width} overflow`);
    await section.screenshot({ path: path.join(output, `${language}-${width}-scenarios.png`) });
    for (const kind of ['statement', 'lean']) {
      const link = page.locator(`[data-research-entry=${kind}]`);
      const bounds = await link.boundingBox(); assert.ok(bounds.height >= 44);
      await link.click();
      const actual = new URL(page.url());
      assert.equal(actual.origin, 'https://app.theoremos.top'); assert.equal(actual.searchParams.get('entry'), kind);
      assert.equal(actual.searchParams.get('template'), kind === 'statement' ? 'add-zero' : 'polynomial');
      assert.equal(actual.searchParams.get('environment'), kind === 'statement' ? 'standard' : 'mathlib');
      assert.equal(actual.searchParams.get('lang'), language);
      assert.deepEqual([...actual.searchParams.keys()].sort(), ['entry', 'environment', 'lang', 'template']);
      await page.goto(home); await page.waitForSelector('[data-decision-state=review]');
    }
    await page.locator('[data-research-practice]').click();
    assert.equal(new URL(page.url()).pathname, '/practice.html'); assert.equal(new URL(page.url()).searchParams.get('lang'), language);
    results.push({ language, width, scenarioLinks: 2, recordedPracticeLink: true }); await page.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.equal(landings.length, 24);
} catch (error) { failure = error; }
finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, errors, writes, landings, ...(failure ? { failure: String(failure) } : {}) }, null, 2));
}
if (failure) throw failure;
console.log('Homepage research entries passed eight viewports. App destinations were captured locally.');
