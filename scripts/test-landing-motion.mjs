import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(path.join(root, 'out/site/index.html')).href;
const output = path.join(root, 'out/site-motion-checks');
await fs.mkdir(output, { recursive: true });
await fs.access(path.join(root, 'out/site/landing.js'));
const browser = await chromium.launch();
const errors = [];
const checks = [];
const screenshots = [];
const viewports = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 812 }];
let currentPage;
let currentCheck = '';
let apiRequests = 0;

function track(page) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (['warning', 'error'].includes(message.type())) errors.push(message.text());
  });
  page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('request', request => {
    if (/\/api\//.test(new URL(request.url()).pathname)) apiRequests++;
  });
}

async function visualState(page, selector) {
  return page.locator(selector).evaluate(node => {
    const style = getComputedStyle(node);
    return { opacity: Number(style.opacity), transform: style.transform };
  });
}

async function assertSelectionIndicator(page, selector) {
  const measure = () => page.locator(selector).evaluate(list => {
    const active = list.querySelector('[role="tab"][aria-selected="true"]');
    const indicator = list.querySelector('.selection-indicator');
    if (!active || !indicator) return null;
    const target = active.getBoundingClientRect(), surface = indicator.getBoundingClientRect();
    return { hidden: indicator.getAttribute('aria-hidden'), interactive: getComputedStyle(indicator).pointerEvents,
      offsets: ['left', 'top', 'width', 'height'].map(key => Math.abs(target[key] - surface[key])) };
  });
  let bounds = await measure();
  // Media-query and ResizeObserver callbacks settle on the rendering loop outside the mocked clock.
  for (let attempt = 0; bounds && bounds.offsets.some(offset => offset >= 1) && attempt < 20; attempt++) {
    await tick(page, 100);
    await page.waitForTimeout(16);
    bounds = await measure();
  }
  assert.ok(bounds, `${currentCheck}: ${selector} must have an active surface`);
  assert.equal(bounds.hidden, 'true');
  assert.equal(bounds.interactive, 'none', 'The active surface must not intercept controls');
  assert.ok(bounds.offsets.every(offset => offset < 1), `${currentCheck}: ${selector} surface must align with the selected tab: ${bounds.offsets}`);
}

async function tick(page, milliseconds = 800) {
  await page.clock.runFor(milliseconds);
}

async function emulateMotion(page, preference) {
  // Media-query change events use the browser's rendering loop, outside the mocked clock.
  await page.evaluate(preference => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    window.testMotionPreference = media.matches === (preference === 'reduce') ? Promise.resolve() :
      new Promise(resolve => media.addEventListener('change', resolve, { once: true }));
  }, preference);
  await page.emulateMedia({ reducedMotion: preference });
  await page.evaluate(() => window.testMotionPreference.then(() => { delete window.testMotionPreference; }));
}

async function screenshot(page, name, selector) {
  const target = selector ? page.locator(selector) : page;
  await target.screenshot({ path: path.join(output, name) });
  screenshots.push(name);
}

async function assertWidth(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${currentCheck}: page overflows horizontally`);
}

try {
  for (const viewport of viewports) for (const reducedMotion of ['no-preference', 'reduce']) {
    currentCheck = `${viewport.width}px ${reducedMotion}`;
    const context = await browser.newContext({ viewport, reducedMotion });
    const page = await context.newPage();
    currentPage = page;
    page.setDefaultTimeout(6000);
    track(page);
    // Advance every animation frame on a controlled clock so entrance motion is measurable.
    const start = new Date('2026-10-17T04:00:00Z');
    await page.clock.install({ time: start });
    await page.clock.pauseAt(start);
    await page.goto(url);
    await page.waitForFunction(() => document.documentElement.dataset.landingReady === 'true');
    const heroSelectors = ['#hero-title', '#workbench-preview'];
    if (reducedMotion === 'reduce') {
      for (const selector of heroSelectors)
        assert.deepEqual(await visualState(page, selector), { opacity: 1, transform: 'none' });
    }
    await tick(page, 1300);
    for (const selector of heroSelectors)
      assert.deepEqual(await visualState(page, selector), { opacity: 1, transform: 'none' });
    assert.deepEqual(await visualState(page, '.hero-actions'), { opacity: 1, transform: 'none' });
    // The four-step replay lives in the archive only; the homepage must not embed or load it.
    assert.equal(await page.locator('#demo, .replay-window, .product-demo').count(), 0);
    const navReplay = page.locator('.desktop-nav a[href="archive.html#view=quickstart"], .mobile-nav a[href="archive.html#view=quickstart"]');
    assert.equal(await navReplay.count(), 2, `${currentCheck}: desktop and mobile navigation must link to the archive replay`);
    await screenshot(page, `hero-${viewport.width}-${reducedMotion}.png`);

    await page.locator('#tab-m3').evaluate(node => node.scrollIntoView({ behavior: 'instant', block: 'center' }));
    await tick(page);
    await page.locator('#tab-m3').focus();
    await page.keyboard.press('End');
    assert.equal(await page.locator('#component-panel').getAttribute('aria-labelledby'), 'tab-m5');
    assert.equal(await page.locator('#tab-m5').evaluate(node => node === document.activeElement), true);
    if (reducedMotion === 'reduce') assert.deepEqual(await visualState(page, '.module-details'), { opacity: 1, transform: 'none' });
    if (reducedMotion === 'reduce') await assertSelectionIndicator(page, '.component-tabs');
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#component-panel').getAttribute('aria-labelledby'), 'tab-m1');
    await tick(page, 500);
    assert.deepEqual(await visualState(page, '.module-details'), { opacity: 1, transform: 'none' });
    await assertSelectionIndicator(page, '.component-tabs');
    // Interrupt an in-flight selection and finish on the full-width mobile grid cell.
    await page.evaluate(() => {
      for (const id of ['m2', 'm4', 'm1', 'm5']) document.querySelector(`#tab-${id}`).click();
    });
    await tick(page, 500);
    await assertSelectionIndicator(page, '.component-tabs');
    await assertWidth(page);

    if (viewport.width === 1440 && reducedMotion === 'no-preference') {
      await page.locator('#tab-m5').evaluate(node => node.scrollIntoView({ behavior: 'instant', block: 'center' }));
      await tick(page);
      await page.locator('#tab-m2').click();
      await tick(page, 80);
      // Preference changes must finish the active selection, including mid-flight motion.
      await emulateMotion(page, 'reduce');
      await tick(page, 100);
      await assertSelectionIndicator(page, '.component-tabs');
      await emulateMotion(page, 'no-preference');
      await tick(page, 100);
      // Resize one live document through both responsive grid breakpoints.
      for (const width of [768, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        // ResizeObserver also runs on the browser's rendering loop, outside the mocked clock.
        await page.waitForTimeout(150);
        await tick(page, 500);
        await assertSelectionIndicator(page, '.component-tabs');
        await assertWidth(page);
      }
    }
    checks.push(currentCheck);
    console.log(`Passed ${currentCheck}: hero entrance, module controls and keyboard interruption, responsive layout.`);
    await context.close();
    currentPage = undefined;
  }

  for (const viewport of viewports) {
    currentCheck = `${viewport.width}px JavaScript disabled`;
    const context = await browser.newContext({ viewport, javaScriptEnabled: false });
    const page = await context.newPage();
    currentPage = page;
    track(page);
    await page.goto(url);
    assert.equal(await page.locator('#demo, .replay-window, .product-demo').count(), 0, 'No replay without scripts either');
    assert.equal(await page.locator('#tab-m3').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#component-panel').getAttribute('aria-labelledby'), 'tab-m3');
    assert.ok((await page.locator('#component-panel').innerText()).trim(), 'No-script readers retain the selected module explanation');
    assert.ok(await page.locator('#workbench-preview .workflow-steps li').count() > 0, 'The workflow steps remain without screenshots');
    assert.equal(await page.locator('.workbench-image-link, #workbench-dialog').count(), 0, 'No screenshot or zoom dialog remains');
    checks.push(currentCheck);
    await context.close();
    currentPage = undefined;
  }
  assert.equal(apiRequests, 0, 'The static homepage must never invoke an API');
  assert.deepEqual(errors, [], 'The website must not log warnings or errors');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, screenshots, apiRequests, errors }, null, 2) + '\n');
  console.log(`Landing motion checks passed: ${checks.length} viewport/preference cases; hero entrance, module controls, no replay on the homepage and no API calls.`);
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  }
  console.error(`Failed ${currentCheck}`);
  throw error;
} finally {
  await browser.close();
}
