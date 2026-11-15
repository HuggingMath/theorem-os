import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Exercise the actual page's bubbling click handlers in both published archive builds.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/proof-reading-navigation');
const staticRoot = path.join(root, 'out');
fs.mkdirSync(output, { recursive: true });
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = path.resolve(staticRoot, `.${pathname}`);
  if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404).end(); return;
  }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const results = [], errors = [], writes = [];
let active, failure;
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

try {
  for (const archive of ['site', 'web/classics']) for (const locale of ['zh', 'en']) {
    const label = `${archive.replaceAll('/', '-')}-${locale}`;
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    active = page;
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
    page.on('response', response => { if (response.url().startsWith(origin) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.route('**/*', route => {
      const request = route.request();
      if (request.method() !== 'GET') { writes.push(`${request.method()} ${request.url()}`); return route.abort(); }
      return new URL(request.url()).origin === origin ? route.continue()
        : route.fulfill({ contentType: 'text/javascript', body: '' });
    });
    await page.goto(`${origin}/${archive}/${locale === 'en' ? 'en/' : ''}archive.html#proof=openai_triangle_face&tab=reading`);
    const walkthrough = page.locator('[data-proof-walkthrough="openai_triangle_face"]');
    await walkthrough.waitFor();
    await page.evaluate(() => document.fonts.ready);
    const steps = await walkthrough.locator('[data-proof-derivation]').evaluateAll(elements => elements.map(element => element.dataset.proofDerivation));
    assert.ok(steps.length > 2);
    const proofSha = await walkthrough.getAttribute('data-proof-sha');
    const previous = walkthrough.locator('[data-proof-reader="previous"]');
    const next = walkthrough.locator('[data-proof-reader="next"]');
    const checkStep = async (index, focused = true) => {
      await settle(page);
      assert.equal(await walkthrough.getAttribute('data-proof-active'), steps[index], `${label}: expected step ${index + 1}`);
      assert.equal(await page.locator('.proof-reading-bar [data-proof-reading-count]').textContent(),
        `${String(index + 1).padStart(2, '0')} / ${String(steps.length).padStart(2, '0')}`);
      assert.equal(await walkthrough.locator('[data-proof-route-step][aria-current="step"]').getAttribute('data-proof-route-step'), steps[index]);
      const params = new URLSearchParams(new URL(page.url()).hash.slice(1));
      assert.equal(params.get('reading'), `proof-derivation-${steps[index]}`);
      assert.equal(params.get('readingSha'), proofSha);
      const heading = page.locator(`#proof-derivation-${steps[index]} h5`);
      if (focused) assert.equal(await heading.evaluate(element => element === document.activeElement), true);
      assert.ok(await heading.evaluate(element => { const box = element.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }));
    };

    await page.locator(`#proof-derivation-${steps[0]}`).evaluate(element => element.scrollIntoView({ block: 'start' }));
    await checkStep(0, false);
    assert.equal(await previous.isDisabled(), true);
    for (let index = 1; index < steps.length; index++) {
      await next.click();
      await checkStep(index);
      if (index === 1) await page.screenshot({ path: path.join(output, `${label}-next.png`) });
    }
    assert.equal(await next.getAttribute('data-global-scroll'), 'global-review');
    assert.equal(await next.getAttribute('aria-label'), await next.getAttribute('data-acceptance-label'));
    await next.click();
    await settle(page);
    assert.ok(await page.locator('#global-review').evaluate(element => { const box = element.getBoundingClientRect(); return box.top >= 0 && box.top < innerHeight; }));
    await page.locator(`#proof-derivation-${steps.at(-1)}`).evaluate(element => element.scrollIntoView({ block: 'start' }));
    await checkStep(steps.length - 1, false);
    for (let index = steps.length - 2; index >= 0; index--) {
      await previous.click();
      await checkStep(index);
    }
    assert.equal(await previous.isDisabled(), true);
    await page.locator(`#proof-derivation-${steps[0]} .proof-walkthrough-next > button`).click();
    await checkStep(1);
    await page.reload();
    await walkthrough.waitFor();
    await checkStep(1);

    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    const panel = walkthrough.locator('.proof-route-panel');
    assert.equal(await panel.evaluate(element => element.open), false);
    await panel.locator('summary').click();
    await panel.locator(`[data-proof-route-step="${steps[2]}"]`).click();
    await checkStep(2);
    assert.equal(await panel.evaluate(element => element.open), false);
    // Anchor clicks briefly preserve their URL while the reading layout settles.
    await page.waitForTimeout(250);
    await page.locator(`#proof-derivation-${steps[1]}`).evaluate(element => element.scrollIntoView({ block: 'start' }));
    await checkStep(1, false);
    await page.screenshot({ path: path.join(output, `${label}-mobile.png`) });
    results.push({ archive, locale, steps: steps.length, forward: steps.length - 1, backward: steps.length - 1,
      acceptance: true, inlineContinue: true, restoredLocation: true, mobileRouteAndScroll: true });
    await page.close(); active = undefined;
    console.log(`PASS ${label}: single-step navigation, acceptance, reload and mobile route`);
  }
  // The published website's linear reader puts the route directly in the content.
  // Exercise that supported layout as well as the current sidebar with real touch input.
  for (const layout of ['inline', 'sidebar']) for (const locale of ['zh', 'en']) for (const width of [390, 768, 1100]) {
    const label = `touch-${layout}-${locale}-${width}`;
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    active = page;
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
    await page.route('**/*', route => {
      const request = route.request();
      if (request.method() !== 'GET') { writes.push(`${request.method()} ${request.url()}`); return route.abort(); }
      return new URL(request.url()).origin === origin ? route.continue()
        : route.fulfill({ contentType: 'text/javascript', body: '' });
    });
    await page.goto(`${origin}/site/${locale === 'en' ? 'en/' : ''}archive.html#proof=openai_triangle_face&tab=reading`);
    const walkthrough = page.locator('[data-proof-walkthrough="openai_triangle_face"]');
    await walkthrough.waitFor();
    await page.evaluate(() => document.fonts.ready);
    if (layout === 'inline') await walkthrough.evaluate(root => {
      const content = root.querySelector('.proof-reading-content');
      content.prepend(root.querySelector('.proof-walkthrough-route'));
      root.querySelector('.proof-reading-layout').replaceWith(content);
    });
    const panel = walkthrough.locator('.proof-route-panel');
    const steps = await walkthrough.locator('[data-proof-derivation]').evaluateAll(elements => elements.map(element => element.dataset.proofDerivation));
    await page.locator(`#proof-derivation-${steps[0]}`).evaluate(element => element.scrollIntoView({ block: 'start' }));
    await settle(page);
    const moves = [];
    for (const index of [1, steps.length - 1, 0]) {
      await panel.locator('summary').tap();
      assert.equal(await panel.evaluate(element => element.open), true);
      if (index === 1) await page.screenshot({ path: path.join(output, `${label}-expanded.png`) });
      await panel.locator(`[data-proof-route-step="${steps[index]}"]`).tap();
      await settle(page);
      assert.equal(await panel.evaluate(element => element.open), false);
      assert.equal(await panel.locator('summary').getAttribute('aria-expanded'), 'false');
      assert.equal(await walkthrough.getAttribute('data-proof-active'), steps[index]);
      const count = `${String(index + 1).padStart(2, '0')} / ${String(steps.length).padStart(2, '0')}`;
      assert.ok((await walkthrough.locator('[data-proof-reading-count]').allTextContents()).every(text => text === count));
      assert.equal(await walkthrough.locator('[data-proof-route-step][aria-current="step"]').getAttribute('data-proof-route-step'), steps[index]);
      const heading = page.locator(`#proof-derivation-${steps[index]} h5`);
      assert.equal(await heading.evaluate(element => element === document.activeElement), true);
      assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('reading'), `proof-derivation-${steps[index]}`);
      assert.ok(await heading.evaluate(element => { const box = element.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      moves.push(index + 1);
    }
    await panel.locator('summary').tap();
    await page.keyboard.press('Escape');
    assert.equal(await panel.evaluate(element => element.open), false);
    assert.equal(await panel.locator('summary').evaluate(element => element === document.activeElement), true);
    if (layout === 'sidebar' && width === 1100) {
      await page.setViewportSize({ width: 1101, height: 844 });
      await settle(page);
      assert.equal(await panel.evaluate(element => element.open), true);
      assert.equal(await walkthrough.locator('[data-proof-reader="next"]').isVisible(), true);
      await page.setViewportSize({ width: 1100, height: 844 });
      await settle(page);
      assert.equal(await panel.evaluate(element => element.open), false);
    }
    results.push({ layout, locale, width, touchRoute: true, moves, autoCollapse: true, focusAndLocation: true, escape: true });
    await page.close(); active = undefined;
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
} catch (error) {
  failure = error;
  await active?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, errors, writes,
    ...(failure ? { failure: String(failure) } : {}) }, null, 2) + '\n');
}
if (failure) throw failure;
console.log(`Proof reading navigation passed ${results.length} archive/language/layout scenarios without models or writes.`);
