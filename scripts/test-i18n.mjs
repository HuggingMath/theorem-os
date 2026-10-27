import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// The English pages share the root bundles; check that every visible string they render is English.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'out/site');
const output = path.join(root, 'out/i18n-checks');
fs.mkdirSync(output, { recursive: true });
const base = '/theorem-os-site/';
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  if (!pathname.startsWith(base)) { response.writeHead(404).end(); return; }
  let file = path.resolve(site, pathname.slice(base.length));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!(file + path.sep).startsWith(site + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain' };
  response.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const hosted = `http://127.0.0.1:${server.address().port}${base}`;
const browser = await chromium.launch();
const problems = [];

// Visible text plus accessible names; Lean source is excluded because it is data, not interface copy.
const cjkIn = page => page.evaluate(() => {
  const cjk = /[　-〿一-鿿＀-￯]/;
  const allowed = new Set(['中文', '中文版']);
  const found = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest('.source-code, script, style, noscript, #feedback-markdown')) continue;
    const value = node.textContent.trim();
    if (value && cjk.test(value) && !allowed.has(value) && parent.getClientRects().length) found.push(value);
  }
  for (const element of document.querySelectorAll('[aria-label], [title], [alt], [placeholder], [aria-valuetext]')) {
    for (const name of ['aria-label', 'title', 'alt', 'placeholder', 'aria-valuetext']) {
      const value = element.getAttribute(name);
      if (value && cjk.test(value) && !allowed.has(value)) found.push(`${name}=${value}`);
    }
  }
  if (cjk.test(document.title)) found.push(`title=${document.title}`);
  return found;
});
const open = async (page, url, ready) => {
  await page.goto(url);
  if (ready) await page.waitForFunction(flag => document.documentElement.dataset[flag] === 'true', ready);
  else await page.waitForSelector('.proof-row', { state: 'attached' });
};
const checkOverflow = async (page, label) => {
  const { overflow, widest } = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('body *')].filter(element => !element.closest('pre') && element.getBoundingClientRect().right > limit + 1);
    return { overflow: document.documentElement.scrollWidth - limit, widest: wide.slice(0, 3).map(element => `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}: ${(element.textContent ?? '').trim().slice(0, 40)}`) };
  });
  assert.ok(overflow <= 1, `${label} must not scroll horizontally (${overflow}px): ${widest.join(' | ')}`);
};
const newPage = async width => {
  // Entrance motion is covered by test-landing-motion; this test checks the settled layout.
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => problems.push(`${page.url()}: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') problems.push(`${page.url()}: ${message.text()}`); });
  page.on('response', response => { if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
  return page;
};

try {
  for (const width of [1440, 390, 320]) {
    const page = await newPage(width);

    await open(page, `${hosted}en/`, 'landingReady');
    assert.equal(await page.getAttribute('html', 'lang'), 'en');
    for (const id of ['m1', 'm2', 'm4', 'm5']) await page.locator(`[data-component="${id}"]`).click();
    await page.locator('[data-module-preview="library"]').click();
    await page.locator('#replay-next').scrollIntoViewIfNeeded();
    await page.locator('[data-replay-stage]').first().click();
    await page.locator('.faq-list summary').first().click();
    if (width < 900) await page.locator('.menu-toggle').click();
    assert.deepEqual(await cjkIn(page), [], `English homepage at ${width}px`);
    assert.equal(await page.locator('#module-preview-panel img').getAttribute('src'), '../assets/workbench-library-desktop.png');
    assert.equal(await page.locator('#start .start-links a.button').getAttribute('href'), 'https://app.theoremos.top/');
    const apply = page.locator('#start .start-links a[data-umami-event="apply-github"]');
    assert.equal(await apply.getAttribute('href'), 'https://github.com/LikC1606/theorem-os-site/issues/new?template=early-access.yml');
    assert.equal(await page.locator('#start .start-note a').getAttribute('href'), 'mailto:liuzhenhao@westlake.edu.cn?subject=TheoremOS%20early%20access');
    assert.equal(await page.locator('[data-accepted-proof]').count(), 6);
    assert.match(await page.locator('.proof-table').innerText(), /Discrete geometry/);
    await checkOverflow(page, `English homepage at ${width}px`);
    await page.screenshot({ path: path.join(output, `en-index-${width}.png`), fullPage: true });
    if (width < 900) await page.locator('.menu-toggle').click();

    await open(page, `${hosted}en/archive.html#proof=hopf_rinow&tab=evidence`);
    assert.equal(await page.getAttribute('html', 'lang'), 'en');
    assert.match(await page.locator('#inspector').innerText(), /Lean-Eval official result/);
    assert.deepEqual(await cjkIn(page), [], `English archive evidence at ${width}px`);
    for (const tab of ['source', 'overview']) {
      await page.locator(`.detail-tabs [data-tab="${tab}"], .detail-tabs #tab-${tab}`).first().click();
      assert.deepEqual(await cjkIn(page), [], `English archive ${tab} at ${width}px`);
    }
    await page.locator('#search').fill('geometry');
    assert.match(await page.locator('#result-count').innerText(), /^2 records · “geometry”$/);
    await page.locator('#search').fill('');
    await page.locator('input[name="status"][value="progress"]').check({ force: true });
    assert.deepEqual(await cjkIn(page), [], `English archive snapshot at ${width}px`);
    await checkOverflow(page, `English archive at ${width}px`);
    await page.screenshot({ path: path.join(output, `en-archive-${width}.png`), fullPage: true });
    await open(page, `${hosted}en/archive.html#view=quickstart`);
    assert.deepEqual(await cjkIn(page), [], `English replay view at ${width}px`);

    await open(page, `${hosted}en/feedback.html`, 'feedbackReady');
    assert.equal(await page.getAttribute('html', 'lang'), 'en');
    await page.locator('#feedback-preview').click();
    await page.locator('#feedback-area').selectOption('workbench');
    await page.locator('#feedback-subject').fill('Replay button');
    await page.locator('#feedback-description').fill('It does not pause.');
    await page.locator('#feedback-preview').click();
    const markdown = await page.locator('#feedback-markdown').inputValue();
    assert.match(markdown, /### Type\nBug report\n\n### Area\nWeb workbench\n\n### Description\nIt does not pause\./);
    assert.doesNotMatch(markdown, /[一-鿿]/);
    assert.deepEqual(await cjkIn(page), [], `English feedback review at ${width}px`);
    await page.locator('#feedback-review-close').click();
    await checkOverflow(page, `English feedback at ${width}px`);
    await page.screenshot({ path: path.join(output, `en-feedback-${width}.png`), fullPage: true });

    for (const [prefix, lang] of [['en/', 'en'], ['', 'zh-CN']]) {
      await open(page, `${hosted}${prefix}privacy.html#terms`, 'legalReady');
      assert.equal(await page.getAttribute('html', 'lang'), lang);
      if (lang === 'en') assert.deepEqual(await cjkIn(page), [], `English privacy page at ${width}px`);
      assert.equal(await page.locator('h1').count(), 1);
      await checkOverflow(page, `${lang} privacy page at ${width}px`);
      await page.screenshot({ path: path.join(output, `${lang}-privacy-${width}.png`), fullPage: true });
    }
    await page.close();
  }

  // Language links point at each other, and switching keeps the section or record in view.
  const page = await newPage(1440);
  for (const [zh, en] of [['', 'en/'], ['archive.html', 'en/archive.html'], ['feedback.html', 'en/feedback.html'], ['privacy.html', 'en/privacy.html']]) {
    await page.goto(hosted + zh);
    // Every page links to the privacy and terms page in both languages.
    if (zh !== 'privacy.html') assert.ok(await page.locator('a[href="privacy.html"]').count() > 0, `${zh || 'index'} must link to privacy.html`);
    const toEnglish = new URL(await page.locator('a.lang-link').getAttribute('href'), page.url()).pathname;
    assert.equal(toEnglish.replace(/index\.html$/, ''), base + en);
    assert.equal(await page.locator(`link[rel="alternate"][hreflang="en"]`).getAttribute('href'), `https://theoremos.top/${en}`);
    await page.goto(hosted + en);
    if (zh !== 'privacy.html') assert.ok(await page.locator('a[href="privacy.html"]').count() > 0, `${en} must link to privacy.html`);
    const toChinese = new URL(await page.locator('a.lang-link').getAttribute('href'), page.url()).pathname;
    assert.equal(toChinese.replace(/index\.html$/, ''), base + zh);
  }
  await open(page, `${hosted}archive.html#proof=dimitrov&tab=source`);
  await page.locator('a.lang-link').click();
  await page.waitForSelector('.proof-row', { state: 'attached' });
  assert.equal(new URL(page.url()).hash, '#proof=dimitrov&tab=source');
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  await page.goto(`${hosted}en/#components`);
  await page.locator('a.lang-link').click();
  await page.waitForLoadState('load');
  assert.equal(new URL(page.url()).hash, '#components');
  assert.equal(await page.getAttribute('html', 'lang'), 'zh-CN');
  await page.close();

  assert.deepEqual(problems, [], 'Pages must load without errors or missing files');
  console.log('i18n checks passed: English homepage, archive (overview, source, evidence, snapshot, replay), feedback and privacy at 3 widths, no CJK interface text, English search and Markdown, reciprocal language links and hreflang, hash kept on switch, Pages subpath with directory index, no missing files or console errors.');
  console.log(`Screenshots: ${path.relative(root, output)}`);
} finally {
  await browser.close();
  server.close();
}
