import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { checkArchiveReplay, checkStaticArchiveReceipt } from './archive-replay-checks.mjs';

// The English pages share the root bundles; check that every visible string they render is English.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'out/site');
const catalog = JSON.parse(fs.readFileSync(path.join(site, 'data/catalog.json'), 'utf8'));
const replayEvidence = JSON.parse(fs.readFileSync(path.join(site, 'assets/replay.json'), 'utf8'));
const output = path.join(root, 'out/i18n-checks');
fs.mkdirSync(output, { recursive: true });
const base = '/TheoremOS/';
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
// Screenshots and evidence may sit in native disclosures in either layout.
const reveal = async locator => {
  for (const ancestor of await locator.locator('xpath=ancestor::details').all()) {
    if (await ancestor.getAttribute('open') !== null) continue;
    await ancestor.locator(':scope > summary').click();
    assert.notEqual(await ancestor.getAttribute('open'), null, 'The disclosure must expose its content');
  }
};
const checkRetinaImage = async (image, label) => {
  await image.scrollIntoViewIfNeeded();
  const picture = await image.evaluate(async node => {
    await node.decode();
    const bounds = node.getBoundingClientRect();
    return { source: node.currentSrc, width: node.naturalWidth, height: node.naturalHeight,
      renderedWidth: bounds.width, renderedHeight: bounds.height };
  });
  const asset = path.basename(new URL(picture.source).pathname);
  const png = fs.readFileSync(path.join(site, 'assets', asset));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual([picture.width, picture.height], [png.readUInt32BE(16), png.readUInt32BE(20)],
    `The browser must load the original PNG dimensions: ${asset}, ${label}`);
  assert.ok(picture.renderedWidth > 0 && picture.renderedHeight > 0, `Product picture must be visible: ${asset}, ${label}`);
  assert.ok(picture.width + 1 >= picture.renderedWidth * 2 && picture.height + 1 >= picture.renderedHeight * 2,
    `Product picture must supply two image pixels per CSS pixel: ${asset}, ${label}; PNG ${picture.width}×${picture.height}, CSS ${picture.renderedWidth}×${picture.renderedHeight}`);
  assert.ok(Math.abs(picture.width / picture.height - picture.renderedWidth / picture.renderedHeight) < .01,
    `Product picture must preserve its actual proportions: ${asset}, ${label}`);
  return picture;
};
const checkEnglishWorkbench = async (page, width) => {
  const image = page.locator('.workbench-image-link img');
  const picture = await checkRetinaImage(image, `${width}px English entry`);
  assert.equal(path.basename(new URL(picture.source).pathname), `workbench-${width <= 900 ? 'mobile' : 'desktop'}-en.png`);
  assert.equal(await page.locator('.workbench-image-link source').getAttribute('media'), '(max-width: 900px)');
  assert.match(await image.getAttribute('alt'), /natural.language|problem.*input|workbench/i);
  const dialog = page.locator('#workbench-dialog');
  await page.locator('.workbench-image-link').click();
  assert.equal(await dialog.isVisible(), true);
  const full = await checkRetinaImage(dialog.locator('img'), `${width}px English full preview`);
  const expected = `workbench-full-${width <= 600 ? 'mobile' : 'desktop'}-en.png`;
  assert.equal(path.basename(new URL(full.source).pathname), expected);
  for (const selector of ['.workbench-image-link', '.preview-original'])
    assert.equal(path.basename(new URL(await page.locator(selector).getAttribute('href'), page.url()).pathname), expected);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#workbench-dialog').open);
};
const componentMeaning = {
  m1: /proof|candidate|construct|build/i, m2: /check|diagnos|feedback/i, m3: /search|task|next|budget/i,
  m4: /context|retriev|evidence/i, m5: /collaborat|role|review/i,
};
const graphOrder = ['m5', 'm3', 'm4', 'm1', 'm2'];
const graphEdges = ['m5->m3', 'm5->m4', 'm3->m4', 'm4->m1', 'm1->m2', 'm2->m3', 'm2->s3'];
const checkGraphSelection = async (page, id) => {
  assert.equal(await page.locator('[data-component][aria-selected="true"]').getAttribute('data-component'), id);
  assert.equal(await page.locator('[data-graph-component][aria-pressed="true"]').getAttribute('data-graph-component'), id);
  assert.equal(await page.locator('[data-component][aria-selected="true"]').count(), 1);
  assert.equal(await page.locator('[data-graph-component][aria-pressed="true"]').count(), 1);
  assert.equal(await page.locator('#component-panel').getAttribute('aria-labelledby'), `tab-${id}`);
  assert.match(await page.locator('#module-kicker').innerText(), new RegExp(id.toUpperCase()));
  const content = [];
  for (const field of ['title', 'description', 'input', 'output']) {
    const value = (await page.locator(`#module-${field}`).innerText()).trim();
    assert.ok(value, `Graph selection ${id} must update the component ${field}`);
    content.push(value);
  }
  assert.match(content.join(' '), componentMeaning[id], `The graph selection explains ${id}`);
  const active = await page.locator('path[data-graph-from][data-graph-to][data-active="true"]').evaluateAll(paths =>
    paths.map(path => `${path.dataset.graphFrom}->${path.dataset.graphTo}`).sort());
  assert.deepEqual(active, graphEdges.filter(edge => edge.split('->').includes(id)).sort(), `Only directly related graph edges are active for ${id}`);
  const route = (await page.locator('#module-graph-route').innerText()).trim();
  assert.ok(route, `Graph selection ${id} has a readable route`);
  return { content, route };
};
const checkGraphReadability = async (page, label, interactive = true) => {
  const graph = page.locator('.module-graph');
  assert.equal(await graph.isVisible(), true);
  assert.notEqual(await graph.getAttribute('data-ui'), null, 'The module map is a real interface');
  const buttons = graph.locator('[data-graph-component]');
  assert.deepEqual(await buttons.evaluateAll(nodes => nodes.map(node => node.dataset.graphComponent)), graphOrder);
  const description = await graph.locator('#module-graph-description').textContent();
  for (const id of [...graphOrder, 's3']) assert.match(description, new RegExp(id.toUpperCase()));
  for (const button of await buttons.all()) {
    assert.equal(await button.evaluate(node => node.tagName), 'BUTTON');
    assert.equal(await button.getAttribute('aria-controls'), 'component-panel');
    assert.equal(await button.isEnabled(), interactive);
    assert.ok((await button.innerText()).trim(), 'Every graph node has a readable label');
    const fits = await button.evaluate(node => {
      const box = node.getBoundingClientRect(), canvas = node.closest('.module-graph-canvas').getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(node);
      return box.width >= 44 && box.height >= 44 && node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1 &&
        box.left >= Math.max(0, canvas.left) - 1 && box.right <= Math.min(innerWidth, canvas.right) + 1 &&
        box.top >= canvas.top - 1 && box.bottom <= canvas.bottom + 1 && [...range.getClientRects()].every(text =>
          text.width === 0 || text.left >= box.left - 1 && text.right <= box.right + 1 && text.top >= box.top - 1 && text.bottom <= box.bottom + 1);
    });
    assert.ok(fits, `Graph nodes and labels fit with at least 44px touch targets: ${label}`);
  }
  const clipped = await graph.evaluate(node => {
    const box = node.getBoundingClientRect(), walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), clipped = [];
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const parent = text.parentElement;
      if (!text.textContent.trim() || parent.closest('.sr-only, svg') || !parent.getClientRects().length) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      if ([...range.getClientRects()].some(rect => rect.width > 0 && (rect.left < Math.max(0, box.left) - 1 ||
        rect.right > Math.min(innerWidth, box.right) + 1 || rect.top < box.top - 1 || rect.bottom > box.bottom + 1))) clipped.push(text.textContent.trim());
    }
    return clipped;
  });
  assert.deepEqual(clipped, [], `Graph text must remain readable: ${label}`);
};
const checkGraphVerification = async page => {
  const disclosure = page.locator('details.graph-verification');
  const summary = disclosure.locator('summary');
  const paragraph = disclosure.locator('p');
  const wasOpen = await disclosure.getAttribute('open') !== null;
  if (!wasOpen) await summary.click();
  assert.equal(await paragraph.isVisible(), true);
  const explanation = await disclosure.innerText();
  for (const meaning of [/S3/, /full.*(?:problem|statement)|complete.*(?:problem|statement)/i, /independent/i, /Lean/]) assert.match(explanation, meaning);
  assert.deepEqual(await cjkIn(page), [], 'The expanded English verification disclosure has no Chinese interface copy');
  await summary.focus();
  await page.keyboard.press('Enter');
  assert.equal(await paragraph.isVisible(), false, 'Native verification disclosure closes with Enter');
  await page.keyboard.press('Space');
  assert.equal(await paragraph.isVisible(), true, 'Native verification disclosure opens with Space');
  if (!wasOpen) await summary.click();
};
const checkModuleGraph = async (page, width) => {
  await page.locator('.module-graph-edges[data-ready="true"]').waitFor({ state: 'attached' });
  const edges = await page.locator('path[data-graph-from][data-graph-to]').evaluateAll(paths =>
    paths.map(path => `${path.dataset.graphFrom}->${path.dataset.graphTo}`).sort());
  assert.deepEqual(edges, [...graphEdges].sort());
  await checkGraphReadability(page, `${width}px module map`);
  await checkGraphSelection(page, 'm3');
  const routes = new Set();
  for (const id of graphOrder) {
    await page.locator(`[data-component="${id}"]`).click();
    const fromTab = await checkGraphSelection(page, id);
    await page.locator(`[data-graph-component="${graphOrder[(graphOrder.indexOf(id) + 1) % graphOrder.length]}"]`).click();
    await page.locator(`[data-graph-component="${id}"]`).click();
    const fromGraph = await checkGraphSelection(page, id);
    assert.deepEqual(fromGraph, fromTab, `Graph and left tab select the same component ${id}`);
    routes.add(fromGraph.route);
  }
  assert.equal(routes.size, 5, 'Each graph selection explains its own route');
  await page.locator('[data-graph-component="m5"]').focus();
  for (const [key, id] of [['ArrowRight', 'm3'], ['ArrowDown', 'm4'], ['ArrowLeft', 'm3'], ['ArrowUp', 'm5'],
    ['End', 'm2'], ['ArrowRight', 'm5'], ['ArrowUp', 'm2'], ['Home', 'm5']]) {
    await page.keyboard.press(key);
    await checkGraphSelection(page, id);
    assert.equal(await page.locator(`[data-graph-component="${id}"]`).evaluate(node => node === document.activeElement), true,
      `${key} moves focus through graph DOM order`);
  }
  for (const [key, id] of [['Enter', 'm4'], ['Space', 'm1']]) {
    await page.locator(`[data-graph-component="${id}"]`).focus();
    await page.keyboard.press(key);
    await checkGraphSelection(page, id);
  }
  await page.locator('#tab-m5').focus();
  for (const [key, id] of [['ArrowDown', 'm1'], ['End', 'm5'], ['Home', 'm1']]) {
    await page.keyboard.press(key);
    await checkGraphSelection(page, id);
  }
  await checkGraphVerification(page);
  await page.locator('[data-component="m3"]').click();
  await checkGraphSelection(page, 'm3');
};
const checkEnglishAdvancedWorkbench = async (page, width) => {
  const requests = [];
  const trackRequest = request => {
    if (['fetch', 'xhr'].includes(request.resourceType()) || !['GET', 'HEAD'].includes(request.method())) {
      requests.push({ type: request.resourceType(), method: request.method(), url: request.url() });
    }
  };
  page.on('request', trackRequest);
  try {
    const device = width <= 600 ? 'mobile' : 'desktop';
    assert.equal(await page.locator('.module-media').isVisible(), true);
    assert.equal(await page.locator('#module-preview-tab-modules').getAttribute('aria-selected'), 'true');
    await checkEnglishProductImages(page, width);
    await checkModuleGraph(page, width);
    for (const id of ['modules', 'library']) {
      const tab = page.locator(`[data-module-preview="${id}"]`);
      await tab.click();
      assert.equal(await tab.getAttribute('aria-selected'), 'true');
      assert.equal(await tab.getAttribute('tabindex'), '0');
      assert.equal(await page.locator('#module-preview-panel').getAttribute('aria-labelledby'), `module-preview-tab-${id}`);
      assert.equal(await page.locator('[data-module-preview][aria-selected="true"]').count(), 1);
      assert.equal(await page.locator('.module-graph').isVisible(), id === 'modules');
      assert.equal(await page.locator('.module-library').isVisible(), id === 'library');
      assert.deepEqual(await cjkIn(page), [], `${width}px English ${id} view`);
      await checkGraphSelection(page, 'm3');
      if (id === 'library') {
        const image = page.locator('.module-library img');
        const picture = await checkRetinaImage(image, `${width}px English strategy library`);
        const expected = `workbench-library-${device}-en.png`;
        assert.equal(path.basename(new URL(picture.source).pathname), expected);
        assert.equal(await image.getAttribute('src'), '../assets/workbench-library-desktop-en.png');
        assert.equal(path.basename(new URL(await page.locator('.module-preview-link').getAttribute('href'), page.url()).pathname), expected);
        assert.match(await image.getAttribute('alt'), /module|strateg|Mathlib/i);
      }
      await checkEnglishProductImages(page, width);
    }
    assert.ok((await page.locator('#module-preview-caption').innerText()).trim(), 'The selected module view retains its caption');
    await page.locator('[data-component="m4"]').click();
    await checkGraphSelection(page, 'm4');
    await page.locator('#module-preview-tab-library').focus();
    for (const [key, id] of [['ArrowRight', 'modules'], ['End', 'library'], ['Home', 'modules']]) {
      await page.keyboard.press(key);
      assert.equal(await page.locator(`#module-preview-tab-${id}`).getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator(`#module-preview-tab-${id}`).evaluate(node => node === document.activeElement), true);
      assert.equal(await page.locator('.module-graph').isVisible(), id === 'modules');
      assert.equal(await page.locator('.module-library').isVisible(), id === 'library');
      await checkGraphSelection(page, 'm4');
    }
    await page.locator('[data-component="m3"]').click();
  } finally {
    page.off('request', trackRequest);
  }
  assert.deepEqual(requests, [], 'Module graph interactions must not fetch data, invoke models or send mutations');
  console.log(`Module graph ${width}px: synchronized selection, keyboard focus, related edges and zero fetch/XHR/mutation requests.`);
};
const checkEnglishProductImages = async (page, width) => {
  const device = width <= 600 ? 'mobile' : 'desktop';
  const source = page.locator('.source-fragment img');
  const picture = await checkRetinaImage(source, `${width}px English Lean workspace`);
  assert.equal(path.basename(new URL(picture.source).pathname), `workbench-source-${device === 'mobile' ? 'mobile' : 'detail'}-en.png`);
  assert.equal(await page.locator('.source-fragment source').getAttribute('media'), '(max-width: 600px)');
  assert.equal(await page.locator('.source-fragment a').getAttribute('href'), '../assets/workbench-source-detail-en.png');
  const expectedCount = await page.locator('.module-library').isVisible() ? 3 : 2;
  const images = page.locator('.workbench-image-link img:visible, .source-fragment img:visible, .module-library img:visible');
  assert.equal(await images.count(), expectedCount, 'The English homepage shows only the entry, source and visible strategy library pictures');
  const sources = new Set();
  for (const image of await images.all()) {
    const picture = await checkRetinaImage(image, `${width}px English product picture`);
    assert.ok((await image.getAttribute('alt')).trim(), 'English product pictures retain descriptive alternatives');
    assert.ok(picture.source.startsWith(new URL('../assets/', page.url()).href), 'English product pictures use local assets');
    sources.add(picture.source);
  }
  assert.equal(sources.size, expectedCount, 'The visible English product pictures show distinct real views');
};
const checkEnglishArchiveEntry = async page => {
  const footer = page.locator('.archive-footer');
  const link = footer.locator('a[href="archive.html"]');
  assert.equal(await link.count(), 1);
  assert.equal(await link.isVisible(), true, 'The English proof records have a visible native archive link');
  assert.ok((await link.innerText()).trim(), 'The English archive link has an accessible label');
  const provenance = await footer.locator('.proof-provenance').innerText();
  assert.match(provenance, /DeepScientist/);
  assert.match(provenance, /histor|original/i);
  assert.equal(await page.locator('[data-accepted-proof]').count(), catalog.records.filter(record => record.status === 'official_accepted').length);
};
const checkEnglishHomepageFacts = async page => {
  const hero = await page.locator('#hero-title').evaluate(node => node.closest('section').innerText);
  assert.match(hero, /Lean/i);
  assert.match(hero, /proof|verif|check/i);
  const content = await page.locator('main').innerText();
  assert.match(content, /allowlist/i);
  assert.match(content, /(?:beta|platform)[^.\n]*free|free[^.\n]*(?:beta|platform)/i);
  assert.match(content, /provider[^.\n]*(?:bill|charg)|model[^.\n]*(?:bill|cost|fee)/i);
  assert.match(content, /(?:your|own)[^.\n]*(?:API key|model key)|bring[^.\n]*key/i);
  for (const event of ['request-access-hero', 'open-workbench-hero'])
    assert.equal(await page.locator(`[data-umami-event="${event}"]`).isVisible(), true, `English primary action remains available: ${event}`);
  for (const record of catalog.records.filter(record => record.status === 'official_accepted')) {
    const row = page.locator(`[data-accepted-proof="${record.id}"]`);
    await reveal(row);
    assert.ok((await row.innerText()).includes(record.model),
      `English original attribution: ${record.id}`);
  }
};
const mobileInspectorReady = async page => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => {
    const inspector = document.querySelector('#inspector');
    return inspector && document.activeElement === inspector && Math.abs(inspector.getBoundingClientRect().top) <= 2;
  });
};
const selectedRowReady = async page => {
  await page.waitForFunction(() => {
    const row = document.querySelector('.proof-row.is-selected');
    if (!row || document.activeElement !== row) return false;
    const bounds = row.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= innerHeight;
  });
};
const assertGeometryState = async (page, proof) => {
  await page.waitForFunction(proof => {
    const params = new URLSearchParams(location.hash.slice(1));
    return params.get('proof') === proof && params.get('q') === 'geometry' &&
      params.get('status') === 'accepted' && params.get('sort') === 'title' && params.get('tab') === 'evidence';
  }, proof);
  assert.equal(await page.locator('#search').inputValue(), 'geometry');
  assert.equal(await page.locator('input[name="status"][value="accepted"]').isChecked(), true);
  assert.equal(await page.locator('#sort').inputValue(), 'title');
  assert.equal(await page.locator('.detail-tabs #tab-evidence').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.proof-row.is-selected').getAttribute('data-proof-id'), proof);
};

try {
  for (const width of [1440, 768, 390, 320]) {
    const page = await newPage(width);

    await open(page, `${hosted}en/`, 'landingReady');
    assert.equal(await page.getAttribute('html', 'lang'), 'en');
    await checkEnglishHomepageFacts(page);
    assert.equal(await page.locator('.replay-badge').innerText(), 'Recorded example');
    assert.equal(await page.locator('[data-umami-event="request-access-hero"]').getAttribute('href'), '#start');
    assert.equal(await page.locator('[data-umami-event="open-workbench-hero"]').getAttribute('href'), 'https://app.theoremos.top/');
    assert.match(await page.locator('#featured-proof').innerText(), /Official Lean-Eval pass/);
    const original = catalog.records.find(record => record.id === 'dimitrov');
    assert.ok((await page.locator('#featured-proof').innerText()).includes(original.model));
    assert.match(await page.locator('#featured-proof').innerText(), /histor|archiv|original|predecessor/i);
    assert.ok((await page.locator('.featured-question').innerText()).trim());
    if (width < 600) {
      assert.equal(await page.locator('.featured-source').getAttribute('open'), null);
      await page.locator('.featured-source > summary').click();
      assert.equal(await page.locator('.featured-code').isVisible(), true);
      await page.locator('.featured-source > summary').click();
    }
    await checkEnglishWorkbench(page, width);
    await checkEnglishAdvancedWorkbench(page, width);
    await checkEnglishArchiveEntry(page);
    for (const id of ['m1', 'm2', 'm4', 'm5']) await page.locator(`[data-component="${id}"]`).click();
    await page.locator('[data-module-preview="library"]').click();
    await page.locator('#replay-next').scrollIntoViewIfNeeded();
    await page.locator('[data-replay-stage]').first().click();
    await page.locator('.faq-list summary').first().click();
    if (width < 900) await page.locator('.menu-toggle').click();
    assert.deepEqual(await cjkIn(page), [], `English homepage at ${width}px`);
    assert.equal(await page.locator('#module-preview-panel img').getAttribute('src'), '../assets/workbench-library-desktop-en.png');
    assert.equal(await page.locator('[data-umami-event="request-access-hero"]').getAttribute('href'), '#start');
    assert.equal(await page.locator('[data-umami-event="open-workbench-hero"]').getAttribute('href'), 'https://app.theoremos.top/');
    assert.equal(await page.locator('[data-umami-event="open-workbench-hero"]').isVisible(), true);
    assert.equal(await page.locator('.nav-start').getAttribute('href'), '#start');
    assert.equal(await page.locator('#start [data-umami-event="apply-github"]').getAttribute('href'), 'https://github.com/LikC1606/TheoremOS/issues/new?template=early-access.yml');
    assert.equal(await page.locator('#start a[data-umami-event="open-workbench"]').getAttribute('href'), 'https://app.theoremos.top/');
    const apply = page.locator('#start a[data-umami-event="apply-github"]');
    assert.equal(await apply.getAttribute('href'), 'https://github.com/LikC1606/TheoremOS/issues/new?template=early-access.yml');
    const email = new URL(await page.locator('#start a[href^="mailto:"]').first().getAttribute('href'));
    assert.equal(email.protocol, 'mailto:');
    assert.equal(email.pathname, 'liuzhenhao@westlake.edu.cn');
    assert.equal(email.searchParams.get('subject'), 'TheoremOS early access');
    assert.match(email.searchParams.get('body'), /Research use:\n\nPublic problem or Lean link \(optional\):/);
    assert.equal(await page.locator('[data-accepted-proof]').count(), catalog.records.filter(record => record.status === 'official_accepted').length);
    assert.match(await page.locator('#proofs').innerText(), /Discrete geometry/);
    await checkOverflow(page, `English homepage at ${width}px`);
    await page.screenshot({ path: path.join(output, `en-index-${width}.png`), fullPage: true });
    if (width < 900) await page.locator('.menu-toggle').click();

    await page.locator('.archive-footer a[href="archive.html"]').click();
    await page.waitForSelector('#inspector .detail-title');
    assert.equal(new URL(page.url()).pathname, `${base}en/archive.html`);
    assert.equal(await page.locator('.proof-row').count(), catalog.records.length);
    assert.equal(await page.locator('#accepted-count').innerText(), String(catalog.records.filter(record => record.status === 'official_accepted').length));
    assert.equal(await page.locator('#verified-count').innerText(), String(catalog.records.filter(record => record.status === 'locally_verified').length));
    assert.equal(await page.locator('#progress-count').innerText(), String(catalog.records.filter(record => record.status === 'in_progress_not_officially_accepted').length));
    const firstAccepted = catalog.records.find(record => record.status === 'official_accepted');
    assert.equal(await page.locator('#inspector .detail-title').innerText(), firstAccepted.en?.title ?? firstAccepted.title);
    assert.deepEqual(await cjkIn(page), [], `English archive destination at ${width}px`);

    await open(page, `${hosted}en/archive.html#proof=hopf_rinow&tab=evidence`);
    if (width <= 700) await mobileInspectorReady(page);
    assert.equal(await page.getAttribute('html', 'lang'), 'en');
    assert.match(await page.locator('#inspector').innerText(), /Lean-Eval official result/);
    assert.deepEqual(await cjkIn(page), [], `English archive evidence at ${width}px`);
    for (const tab of ['source', 'overview']) {
      await page.locator(`.detail-tabs [data-tab="${tab}"], .detail-tabs #tab-${tab}`).first().click();
      assert.deepEqual(await cjkIn(page), [], `English archive ${tab} at ${width}px`);
    }
    await page.locator('#search').fill('geometry');
    const geometryCount = catalog.records.filter(record => `${record.title} ${record.en?.subtitle ?? record.subtitle} ${record.en?.area ?? record.area} ${record.id} ${record.model}`.toLowerCase().includes('geometry')).length;
    assert.equal(await page.locator('#result-count').innerText(), `${geometryCount} records · “geometry”`);
    await page.locator('#search').fill('');
    await page.locator('input[name="status"][value="progress"]').check({ force: true });
    assert.deepEqual(await cjkIn(page), [], `English archive snapshot at ${width}px`);
    await checkOverflow(page, `English archive at ${width}px`);
    await page.screenshot({ path: path.join(output, `en-archive-${width}.png`), fullPage: true });
    await open(page, `${hosted}en/archive.html#proof=openai_totient_companion_zero&status=verified&tab=evidence`);
    assert.match(await page.locator('.campaign-evidence').innerText(), /kernel_verified/);
    assert.deepEqual(await cjkIn(page), [], `English local acceptance at ${width}px`);
    assert.equal(await page.locator('.campaign-evidence a').getAttribute('href'), '../data/proofs/openai_totient_companion_zero/verification.json');
    await page.getByRole('tab', { name: 'Routes and trajectory' }).click();
    await page.locator('.global-run-lane').first().waitFor();
    await checkOverflow(page, `English research process at ${width}px`);

    if (width <= 700) {
      await open(page, `${hosted}en/archive.html#proof=hopf_rinow&status=accepted&q=geometry&sort=title&tab=evidence`);
      await mobileInspectorReady(page);
      await assertGeometryState(page, 'hopf_rinow');
      await page.locator('[data-action="back-list"]').first().click();
      await selectedRowReady(page);
      await assertGeometryState(page, 'hopf_rinow');

      const row = page.locator('.proof-row').first();
      const selectedId = await row.getAttribute('data-proof-id');
      assert.notEqual(selectedId, 'hopf_rinow', 'The geometry filter must offer a second proof to open');
      await row.click();
      await mobileInspectorReady(page);
      await assertGeometryState(page, selectedId);
      await page.locator('[data-action="back-list"]').last().click();
      await selectedRowReady(page);
      await assertGeometryState(page, selectedId);
      assert.deepEqual(await cjkIn(page), [], `English mobile archive navigation at ${width}px`);
    }

    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    const archiveAccess = page.locator('.archive-access a');
    assert.equal(await archiveAccess.getAttribute('href'), 'index.html#start');
    assert.equal(new URL(await archiveAccess.getAttribute('href'), page.url()).href, `${hosted}en/index.html#start`);
    await archiveAccess.click();
    await page.waitForURL(`${hosted}en/index.html#start`);
    await page.waitForFunction(() => document.documentElement.dataset.landingReady === 'true');
    assert.equal(await page.getAttribute('html', 'lang'), 'en');
    assert.equal(await page.locator('#start [data-umami-event="apply-github"]').getAttribute('href'), 'https://github.com/LikC1606/TheoremOS/issues/new?template=early-access.yml');
    await open(page, `${hosted}en/archive.html#view=quickstart`);
    assert.equal(await page.locator('.quickstart-access a').getAttribute('href'), 'index.html#start');
    assert.equal(new URL(await page.locator('.quickstart-access a').getAttribute('href'), page.url()).href, `${hosted}en/index.html#start`);
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

  for (const width of [1440, 320]) {
    const replayPage = await newPage(width);
    await replayPage.emulateMedia({ reducedMotion: width === 1440 ? 'no-preference' : 'reduce' });
    await checkArchiveReplay(replayPage, `${hosted}en/archive.html#proof=openai_totient_companion_zero&status=verified&tab=overview&sort=title`, {
      english: true, evidence: replayEvidence, label: `English public archive at ${width}px`,
    });
    assert.deepEqual(await cjkIn(replayPage), [], `English interactive replay at ${width}px`);
    await replayPage.screenshot({ path: path.join(output, `en-replay-${width}.png`), fullPage: true });
    await replayPage.close();
  }

  const noScript = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 320, height: 844 }, reducedMotion: 'reduce' });
  noScript.on('pageerror', error => problems.push(error.message));
  noScript.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
  noScript.on('response', response => { if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
  await noScript.goto(`${hosted}en/`);
  await noScript.evaluate(() => document.fonts.ready);
  await checkEnglishHomepageFacts(noScript);
  await checkEnglishProductImages(noScript, 320);
  await checkGraphReadability(noScript, '320px English JavaScript-disabled module map', false);
  await checkGraphVerification(noScript);
  assert.equal(await noScript.locator('.module-preview-tabs').isVisible(), false);
  assert.equal(await noScript.locator('.module-library').isVisible(), false);
  assert.equal(await noScript.locator('[data-accepted-proof]').count(), catalog.records.filter(record => record.status === 'official_accepted').length);
  assert.equal(await noScript.locator('.menu-toggle').isVisible(), false);
  const noScriptApply = noScript.locator('a[href="#start"]:visible').first();
  assert.equal(await noScriptApply.isVisible(), true, 'English readers can request access without scripts');
  await noScriptApply.click();
  assert.equal(new URL(noScript.url()).hash, '#start');
  await noScript.waitForFunction(() => {
    const title = document.querySelector('#start-title').getBoundingClientRect();
    const header = document.querySelector('.site-header').getBoundingClientRect();
    return title.top >= Math.max(0, header.bottom) && title.bottom <= innerHeight;
  });
  await checkEnglishArchiveEntry(noScript);
  await checkOverflow(noScript, '320px English no-script navigation and archive');
  await checkStaticArchiveReceipt(noScript, `${hosted}en/archive.html#view=quickstart`, {
    english: true, evidence: replayEvidence, label: 'English public no-script archive at 320px',
  });
  assert.deepEqual(await cjkIn(noScript), [], 'English no-script replay receipt');
  await noScript.screenshot({ path: path.join(output, 'en-replay-no-script-320.png'), fullPage: true });
  await noScript.close();

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
  console.log('i18n checks passed: English interactive module map and static no-script map, no graph API or mutation calls, homepage, archive (overview, source, evidence, snapshot, interactive replay and no-script receipt), feedback and privacy at 4 widths, mobile deep-link focus and return to the selected filtered row, localized access links, no CJK interface text, English search and Markdown, reciprocal language links and hreflang, hash kept on switch, Pages subpath with directory index, no missing files or console errors.');
  console.log(`Screenshots: ${path.relative(root, output)}`);
} finally {
  await browser.close();
  server.close();
}
