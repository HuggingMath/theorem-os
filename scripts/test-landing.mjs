import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'out/site');
const url = pathToFileURL(path.join(site, 'index.html')).href;
const output = path.join(root, 'out/site-checks');
fs.mkdirSync(output, { recursive: true });
const catalog = JSON.parse(fs.readFileSync(path.join(site, 'data/catalog.json'), 'utf8'));
const accepted = catalog.records.filter(record => record.status === 'official_accepted');
const replayEvidence = JSON.parse(fs.readFileSync(path.join(site, 'assets/replay.json'), 'utf8'));
const errors = [];
const browser = await chromium.launch();
let server;
const trackErrors = page => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) errors.push(message.text()); });
  page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
};
const checkWidth = async (page, label) => assert.ok(
  await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal overflow: ${label}`,
);
const checkAnchorClearance = async (page, id) => {
  await page.waitForFunction(id => {
    const section = document.querySelector(id);
    const heading = document.getElementById(section.getAttribute('aria-labelledby')) ?? section.querySelector('h1, h2, h3') ?? section;
    const target = heading.getBoundingClientRect();
    const header = document.querySelector('.site-header').getBoundingClientRect();
    return target.top >= Math.max(0, header.bottom) && target.bottom <= innerHeight;
  }, id);
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
  return picture;
};
const checkWorkbench = async (page, label) => {
  const figure = page.locator('#workbench-preview');
  assert.match(await figure.locator('.workbench-image-link img').getAttribute('alt'), /自然语言|原题|工作台/);
  assert.equal(await figure.locator('source[srcset*="assets/workbench-mobile.png"]').getAttribute('media'), '(max-width: 900px)');
  const screenshot = figure.locator('img[src$="workbench-desktop.png"]');
  assert.equal(await screenshot.getAttribute('src'), 'assets/workbench-desktop.png');
  assert.ok(await screenshot.getAttribute('alt'), 'The workbench screenshot must have descriptive alternative text');
  await screenshot.scrollIntoViewIfNeeded();
  const image = await screenshot.evaluate(async image => {
    await image.decode();
    const bounds = image.getBoundingClientRect();
    return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight,
      src: image.currentSrc, viewport: innerWidth,
      visibleWidth: Math.max(0, Math.min(bounds.right, innerWidth) - Math.max(0, bounds.left)),
      visibleHeight: Math.max(0, Math.min(bounds.bottom, innerHeight) - Math.max(0, bounds.top)) };
  });
  assert.ok(image.complete && image.width > 0 && image.height > 0, `The screenshot must load: ${label}`);
  const asset = path.basename(new URL(image.src).pathname);
  assert.ok(['workbench-desktop.png', 'workbench-mobile.png'].includes(asset), `Unexpected screenshot: ${image.src}`);
  assert.equal(asset, `workbench-${image.viewport <= 900 ? 'mobile' : 'desktop'}.png`, `Responsive entry screenshot: ${label}`);
  await checkRetinaImage(screenshot, label);
  assert.ok(image.visibleWidth >= 200 && image.visibleHeight >= 100, `The actual workbench must remain viewable: ${label}`);
};
const checkFeaturedProof = async (page, label) => {
  const record = accepted.find(record => record.id === 'dimitrov');
  const feature = page.locator('#featured-proof');
  const source = fs.readFileSync(path.join(root, record.sources.find(source => source.name === 'Submission.lean').path), 'utf8');
  const body = await feature.locator('pre code').textContent();
  assert.ok(source.includes(body), 'The featured proof body must match the accepted source verbatim');
  assert.match(await feature.innerText(), /Dimitrov/);
  assert.ok((await feature.locator('.featured-question').innerText()).trim(), 'The historical case must retain its problem description');
  const disclosure = feature.locator('details');
  const wasOpen = await disclosure.getAttribute('open') !== null;
  await disclosure.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await disclosure.locator('pre').isVisible(), !wasOpen, 'The source disclosure supports the keyboard');
  await page.keyboard.press('Enter');
  assert.equal(await disclosure.locator('pre').isVisible(), wasOpen, 'The source disclosure restores its original state');
  assert.equal(await feature.locator('.featured-receipt a').getAttribute('href'), record.official.resultUrl);
  assert.equal(await feature.locator('.featured-problem a').getAttribute('href'), 'archive.html#proof=dimitrov&tab=source');
  assert.match(await feature.innerText(), /历史|前身|原始归属/);
  assert.ok((await feature.locator('figcaption').innerText()).includes(record.model));

};
const checkStart = async page => {
  const start = page.locator('#start');
  assert.equal(await start.isVisible(), true, 'The beta application information must remain available');
  assert.match(await start.innerText(), /白名单/);
  assert.match(await start.innerText(), /内测|Beta/i);
  assert.doesNotMatch(await start.innerText(), /即将开放/);
  assert.equal(await start.locator('[data-command], .copy-command, pre').count(), 0, 'The start section must not offer deployment commands');
  assert.ok((await page.locator('.nav-start').innerText()).trim(), 'Access navigation has an accessible label');
  assert.equal(await page.locator('.nav-start').getAttribute('href'), '#start');
  assert.equal(await page.locator('[data-umami-event="request-access-hero"]').getAttribute('href'), '#start');
  assert.equal(await page.locator('[data-umami-event="open-workbench-hero"]').getAttribute('href'), 'https://app.theoremos.top/');
  const open = start.locator('[data-umami-event="open-workbench"]');
  assert.ok((await open.innerText()).trim(), 'The workbench link has an accessible label');
  assert.equal(await open.getAttribute('href'), 'https://app.theoremos.top/');
  const apply = start.locator('[data-umami-event="apply-github"]');
  assert.match(await apply.innerText(), /申请|内测/);
  assert.equal(await apply.getAttribute('href'), 'https://github.com/LikC1606/TheoremOS/issues/new?template=early-access.yml');
  assert.match(await start.innerText(), /公开/);
  const email = new URL(await start.locator('a[href^="mailto:"]').first().getAttribute('href'));
  assert.equal(email.protocol, 'mailto:');
  assert.equal(email.pathname, 'liuzhenhao@westlake.edu.cn');
  assert.equal(email.searchParams.get('subject'), 'TheoremOS 内测申请');
  assert.match(email.searchParams.get('body'), /研究用途：\n\n公开题目或 Lean 链接（选填）：/);
};
const checkProofActions = async page => {
  for (const record of accepted) {
    const row = page.locator(`[data-accepted-proof="${record.id}"]`);
    await reveal(row);
    assert.ok((await row.innerText()).includes(record.model), `Original attribution: ${record.id}`);
    assert.ok((await row.innerText()).includes(record.area), `Research area: ${record.id}`);
    const result = row.locator(`a[href="${record.official.resultUrl}"]`);
    assert.equal(await result.getAttribute('href'), record.official.resultUrl);
    assert.match(await result.innerText(), /官方|Lean-Eval/);
    assert.ok(await result.getAttribute('aria-label'), 'Official evidence needs an accessible name');
    assert.equal(await row.locator('[data-proof-source]').getAttribute('href'), `archive.html#proof=${record.id}&tab=source`);
    for (const link of await row.locator(`a[data-proof-source], a[href="${record.official.resultUrl}"]`).all()) {
      const box = await link.boundingBox();
      assert.ok(box && box.height >= 44, 'Each evidence link must keep a usable touch target');
    }
  }

};
const checkScreenshotPreview = async (page, width) => {
  const link = page.locator('.workbench-image-link');
  const dialog = page.locator('#workbench-dialog');
  const originalUrl = page.url();
  await link.click();
  assert.equal(page.url(), originalUrl, 'Opening the preview must keep the visitor on the homepage');
  assert.equal(await dialog.isVisible(), true);
  const preview = await dialog.locator('img').evaluate(async image => {
    await image.decode();
    return { source: image.currentSrc, width: image.naturalWidth };
  });
  assert.match(preview.source, width <= 600 ? /workbench-full-mobile\.png/ : /workbench-full-desktop\.png/);
  await checkRetinaImage(dialog.locator('img'), `${width}px full workbench preview`);
  assert.equal(await dialog.locator('.preview-original').getAttribute('href'), new URL(preview.source).pathname.split('/').slice(-2).join('/'));
  assert.ok((await dialog.locator('#preview-description').innerText()).trim(), 'The screenshot dialog retains its accessible description');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('preview-open')), true);
  const media = dialog.locator('.preview-dialog-media');
  await dialog.getByRole('button', { name: '放大截图' }).click();
  assert.equal(await dialog.getByRole('button', { name: '适应窗口' }).getAttribute('aria-pressed'), 'true');
  await page.waitForFunction(() => {
    const media = document.querySelector('.preview-dialog-media');
    return media.scrollWidth >= media.clientWidth * 1.9;
  });
  assert.ok(await media.evaluate(node => node.scrollWidth >= node.clientWidth * 1.9), 'Zoom must expose a larger, scrollable image');
  await checkWidth(page, `${width}px screenshot preview`);
  const close = dialog.locator('.preview-close');
  const closeBounds = await close.boundingBox();
  assert.ok(closeBounds && closeBounds.x >= 0 && closeBounds.x + closeBounds.width <= width && closeBounds.y >= 0);
  if (width === 1440) {
    const bounds = await media.boundingBox();
    const before = await media.evaluate(node => node.scrollLeft);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 - 100, bounds.y + 80, { steps: 5 });
    await page.mouse.up();
    assert.ok(await media.evaluate(node => node.scrollLeft) > before + 70, 'A zoomed image must support mouse panning');
  }
  await close.focus();
  await page.keyboard.press('Tab');
  assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'The modal must contain keyboard focus');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.documentElement.classList.contains('preview-open'));
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await link.evaluate(node => node === document.activeElement), true, 'Closing must return focus to the screenshot');
  await link.click();
  assert.equal(await dialog.getByRole('button', { name: '放大截图' }).getAttribute('aria-pressed'), 'false');
  assert.deepEqual(await media.evaluate(node => ({ left: node.scrollLeft, top: node.scrollTop })), { left: 0, top: 0 }, `The ${width}px preview must reopen at its origin`);
  await dialog.locator('.preview-close').click();
  await page.waitForFunction(() => !document.documentElement.classList.contains('preview-open'));
  if (width === 1440) {
    await link.click();
    await page.mouse.click(2, 2);
    await page.waitForFunction(() => !document.querySelector('#workbench-dialog').open);
  }
};
const checkArchiveEntry = async page => {
  const footer = page.locator('.archive-footer');
  const link = footer.locator('a[href="archive.html"]');
  assert.equal(await link.count(), 1);
  assert.equal(await link.isVisible(), true, 'The proof records have a visible native archive link');
  assert.ok((await link.innerText()).trim(), 'The archive link has an accessible label');
  const provenance = await footer.locator('.proof-provenance').innerText();
  assert.match(provenance, /DeepScientist/);
  assert.match(provenance, /原始归属|历史/);
  assert.equal(await page.locator('[data-accepted-proof]').count(), accepted.length);
};
const checkProductImages = async (page, label) => {
  const expectedCount = await page.locator('.module-library').isVisible() ? 3 : 2;
  const images = page.locator('.workbench-image-link img:visible, .source-fragment img:visible, .module-library img:visible');
  assert.equal(await images.count(), expectedCount, `Only the entry, source and visible strategy library are product pictures: ${label}`);
  const sources = new Set();
  for (const image of await images.all()) {
    await checkRetinaImage(image, label);
    const picture = await image.evaluate(async node => {
      await node.decode();
      const bounds = node.getBoundingClientRect(), container = node.closest('a').getBoundingClientRect();
      return {
        source: node.currentSrc, alt: node.alt, complete: node.complete,
        width: node.naturalWidth, height: node.naturalHeight,
        ratio: node.naturalWidth / node.naturalHeight, renderedRatio: bounds.width / bounds.height,
        fits: bounds.left >= container.left - 1 && bounds.right <= container.right + 1 &&
          bounds.top >= container.top - 1 && bounds.bottom <= container.bottom + 1,
      };
    });
    sources.add(picture.source);
    assert.ok(picture.source.startsWith(new URL('assets/', page.url()).href), `Product pictures use local assets: ${picture.source}`);
    assert.ok(picture.complete && picture.width > 0 && picture.height > 0, `Product picture must load: ${picture.source}, ${label}`);
    assert.ok(picture.alt.trim(), `Product picture must have descriptive alternative text: ${picture.source}`);
    assert.ok(picture.fits && Math.abs(picture.ratio - picture.renderedRatio) < .01,
      `Product picture must fit its container without stretching or cropping: ${picture.source}, ${label}`);
  }
  assert.equal(sources.size, expectedCount, `Visible product pictures show distinct real views: ${label}`);
  const source = page.locator('.source-fragment img');
  const device = await page.evaluate(() => innerWidth <= 600 ? 'mobile' : 'detail');
  assert.equal(path.basename(new URL(await source.evaluate(node => node.currentSrc)).pathname), `workbench-source-${device}.png`);
  assert.equal(await page.locator('.source-fragment source').getAttribute('media'), '(max-width: 600px)');
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
  for (const meaning of [/S3/, /完整原题/, /独立/, /Lean/]) assert.match(explanation, meaning);
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
const checkModuleShowcase = async (page, width) => {
  const requests = [];
  const trackRequest = request => {
    if (['fetch', 'xhr'].includes(request.resourceType()) || !['GET', 'HEAD'].includes(request.method())) {
      requests.push({ type: request.resourceType(), method: request.method(), url: request.url() });
    }
  };
  page.on('request', trackRequest);
  try {
    const panel = page.locator('#module-preview-panel');
    assert.equal(await page.locator('.module-media').isVisible(), true);
    assert.equal(await page.locator('#module-preview-tab-modules').getAttribute('aria-selected'), 'true');
    await checkModuleGraph(page, width);
    for (const id of ['modules', 'library']) {
      const tab = page.locator(`#module-preview-tab-${id}`);
      await tab.click();
      assert.equal(await tab.getAttribute('aria-selected'), 'true');
      assert.equal(await tab.getAttribute('tabindex'), '0');
      assert.equal(await panel.getAttribute('aria-labelledby'), `module-preview-tab-${id}`);
      assert.equal(await page.locator('[data-module-preview][aria-selected="true"]').count(), 1);
      assert.equal(await panel.locator('.module-graph').isVisible(), id === 'modules');
      assert.equal(await panel.locator('.module-library').isVisible(), id === 'library');
      await checkGraphSelection(page, 'm3');
      if (id === 'library') {
        const image = panel.locator('.module-library img');
        const picture = await checkRetinaImage(image, `${width}px strategy library`);
        assert.equal(path.basename(new URL(picture.source).pathname), `workbench-library-${width <= 600 ? 'mobile' : 'desktop'}.png`);
        assert.equal(await page.locator('.module-preview-link').getAttribute('href'), `assets/workbench-library-${width <= 600 ? 'mobile' : 'desktop'}.png`);
        assert.match(await image.getAttribute('alt'), /方案|模块|Mathlib/);
      }
      await checkProductImages(page, `${width}px ${id} view`);
      await checkWidth(page, `${width}px module showcase ${id}`);
    }
    await page.locator('[data-component="m4"]').click();
    await checkGraphSelection(page, 'm4');
    await page.locator('#module-preview-tab-modules').click();
    await checkGraphSelection(page, 'm4');
    await page.locator('#module-preview-tab-library').focus();
    for (const [key, id] of [['ArrowRight', 'modules'], ['End', 'library'], ['Home', 'modules']]) {
      await page.keyboard.press(key);
      const tab = page.locator(`#module-preview-tab-${id}`);
      assert.equal(await tab.getAttribute('aria-selected'), 'true');
      assert.equal(await tab.evaluate(node => node === document.activeElement), true);
      assert.equal(await panel.locator('.module-graph').isVisible(), id === 'modules');
      assert.equal(await panel.locator('.module-library').isVisible(), id === 'library');
      await checkGraphSelection(page, 'm4');
    }
    await page.locator('[data-component="m3"]').click();
  } finally {
    page.off('request', trackRequest);
  }
  assert.deepEqual(requests, [], 'Module graph interactions must not fetch data, invoke models or send mutations');
  console.log(`Module graph ${width}px: synchronized selection, keyboard focus, related edges and zero fetch/XHR/mutation requests.`);
};
const checkHoveredGraphEdges = async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' });
  trackErrors(page);
  try {
    await page.goto(url);
    await page.waitForFunction(() => document.documentElement.dataset.landingReady === 'true');
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.module-graph').scrollIntoViewIfNeeded();
    await page.locator('.module-graph-edges[data-ready="true"]').waitFor({ state: 'attached' });
    const summary = page.locator('.graph-verification summary');
    await summary.focus();
    await page.locator('[data-graph-component="m1"]').hover();
    await page.waitForFunction(() => {
      const transform = getComputedStyle(document.querySelector('[data-graph-component="m1"]')).transform;
      return transform !== 'none' && new DOMMatrixReadOnly(transform).m42 < -1.9;
    });
    await page.keyboard.press('Enter');
    assert.notEqual(await page.locator('.graph-verification').getAttribute('open'), null);
    for (const width of [1440, 1420]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForFunction(() => {
        const canvas = document.querySelector('.module-graph-canvas'), svg = canvas.querySelector('.module-graph-edges');
        return Math.abs(canvas.getBoundingClientRect().height - svg.viewBox.baseVal.height) < 1 &&
          Math.abs(canvas.getBoundingClientRect().width - svg.viewBox.baseVal.width) < 1;
      });
      assert.equal(await page.locator('[data-graph-component="m1"]').evaluate(node => node.matches(':hover')), true);
      const lines = await page.locator('path[data-graph-from][data-graph-to]').evaluateAll(paths => paths
        .filter(path => ['m3->m4', 'm1->m2'].includes(`${path.dataset.graphFrom}->${path.dataset.graphTo}`))
        .map(path => {
          const start = path.getPointAtLength(0).matrixTransform(path.getScreenCTM());
          const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM());
          const minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x);
          const intersections = [...document.querySelectorAll('[data-graph-component], [data-graph-terminal]')].filter(node => {
            const box = node.getBoundingClientRect();
            return maxX > box.left + .5 && minX < box.right - .5 && start.y > box.top + .5 && start.y < box.bottom - .5;
          }).map(node => node.dataset.graphComponent ?? node.dataset.graphTerminal);
          return { edge: `${path.dataset.graphFrom}->${path.dataset.graphTo}`, d: path.getAttribute('d'),
            horizontal: /\bH\b/.test(path.getAttribute('d')) && Math.abs(start.y - end.y) < .5, intersections };
        }));
      assert.equal(lines.length, 2);
      for (const line of lines) {
        assert.ok(line.horizontal, `Hover and S3 resize preserve horizontal topology: ${line.edge}, ${line.d}`);
        assert.deepEqual(line.intersections, [], `The ${line.edge} relationship stays between nodes at ${width}px`);
      }
    }
    console.log('Module graph motion: hovered M1, expanded S3 and resize preserve horizontal edges without crossing nodes.');
  } finally {
    await page.close();
  }
};
const componentMeaning = {
  m1: /候选|构造|生成|证明/, m2: /检查|诊断|反馈/, m3: /搜索|任务|下一步|预算/,
  m4: /上下文|检索|证据/, m5: /协作|分工|审阅/,
};
const checkHomepageFacts = async page => {
  await reveal(page.locator('[data-accepted-proof]').first());
  const hero = await page.locator('#hero-title').evaluate(node => node.closest('section').innerText);
  assert.match(hero, /Lean/i, 'The introduction must explain the Lean proof workflow');
  assert.match(hero, /证明|验收|检查/);
  const content = await page.locator('main').innerText();
  assert.match(content, /白名单/);
  assert.match(content, /(?:内测|平台)[^。\n]*免费/);
  assert.match(content, /模型[^。\n]*(?:服务商|计费|费用)|服务商[^。\n]*(?:收费|计费|费用)/);
  assert.match(content, /(?:自己|自备|你的)[^。\n]*(?:Key|密钥)|(?:Key|密钥)[^。\n]*(?:自己|自备|你的)/i);
  assert.match(content, /DeepScientist Math/);
  assert.match(content, /DeepScientist \+ GPT-5\.6/);
  for (const event of ['request-access-hero', 'open-workbench-hero'])
    assert.equal(await page.locator(`[data-umami-event="${event}"]`).isVisible(), true, `Primary action remains available: ${event}`);
  assert.equal(await page.locator('[data-umami-event="request-access-hero"]').getAttribute('href'), '#start');
  assert.equal(await page.locator('[data-umami-event="open-workbench-hero"]').getAttribute('href'), 'https://app.theoremos.top/');
};
const checkMobileComponentTabs = async (page, label) => {
  const tabs = page.locator('[data-component]');
  assert.equal(await tabs.count(), 5);
  for (const tab of await tabs.all()) {
    await tab.focus();
    const fits = await tab.evaluate(node => {
      const bounds = node.getBoundingClientRect(), range = document.createRange();
      range.selectNodeContents(node);
      return bounds.width > 0 && bounds.height > 0 && bounds.left >= -1 && bounds.right <= innerWidth + 1 &&
        [...range.getClientRects()].every(text => text.width === 0 || text.left >= bounds.left - 1 && text.right <= bounds.right + 1);
    });
    assert.ok(fits, `Every component tab and its label must remain accessible: ${label}`);
  }
};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  trackErrors(page);
  await page.goto(url);
  await page.waitForFunction(() => document.documentElement.dataset.landingReady === 'true');
  await page.evaluate(() => document.fonts.ready);
  assert.match(await page.title(), /TheoremOS/);
  assert.equal(await page.locator('h1').count(), 1);
  await checkFeaturedProof(page, '1440px local preview');
  await checkWorkbench(page, '1440px local preview');
  await checkScreenshotPreview(page, 1440);
  await checkArchiveEntry(page);
  await checkProductImages(page, '1440px local preview');
  await checkModuleShowcase(page, 1440);
  assert.equal(await page.locator('#demo').count(), 1, 'The replay remains directly linkable');
  await checkHomepageFacts(page);
  assert.equal(await page.locator('[data-accepted-proof]').count(), accepted.length);
  assert.match(await page.locator('a[href="archive.html#status=accepted"]').innerText(), new RegExp(`\\b${accepted.length}\\b`));
  await checkProofActions(page);
  assert.match(await page.locator('#proofs').innerText(), /DeepScientist/);
  assert.match(await page.locator('#proofs').innerText(), /历史|前身|原始归属/);
  assert.match(await page.locator('.receipt-status').innerText(), new RegExp(replayEvidence.status));
  await reveal(page.locator('.receipt-targets'));
  for (const target of replayEvidence.targets) assert.ok((await page.locator('.receipt-targets').innerText()).includes(target.theorem));
  assert.equal(await page.locator('.replay-badge').innerText(), '示例证明回放');
  assert.equal(replayEvidence.source, 'preset-replay');
  assert.equal(replayEvidence.modelInvoked, false);
  for (const id of ['candidate', 'feedback', 'repair', 'verified']) {
    await page.locator(`#demo-${id}`).click();
    assert.equal(await page.locator(`#demo-${id}`).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator(`#stage-${id}`).isVisible(), true);
    assert.equal(await page.locator('[role="tabpanel"][id^="stage-"]:visible').count(), 1);
    assert.match(await page.locator('.receipt-status').innerText(), /evaluated_passed/);
  }
  assert.match(await page.locator('#stage-candidate').textContent(), /0 \+ n = n := by rfl/);
  assert.match(await page.locator('#stage-repair').textContent(), /by exact Nat.zero_add n/);
  await page.locator('#demo-verified').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#demo-candidate').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await page.locator('#demo-verified').getAttribute('aria-selected'), 'true');
  // Verify local navigation and packaged resources, including file:// previews.
  const localPaths = await page.locator('a[href], img[src], script[src], link[href]').evaluateAll(nodes => nodes.map(node => node.getAttribute('href') ?? node.getAttribute('src')).filter(Boolean));
  for (const relative of localPaths) {
    if (relative.startsWith('#') || /^[a-z]+:/i.test(relative)) continue;
    assert.ok(fs.existsSync(path.join(site, relative.split('#')[0])), `Missing local resource: ${relative}`);
  }
  assert.ok(fs.existsSync(path.join(site, 'assets/social-preview.png')));

  const componentDescriptions = new Set();
  for (const id of ['m1', 'm2', 'm3', 'm4', 'm5']) {
    await page.locator(`#tab-${id}`).click();
    assert.equal(await page.locator(`#tab-${id}`).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#component-panel').getAttribute('aria-labelledby'), `tab-${id}`);
    assert.match(await page.locator('#module-kicker').innerText(), new RegExp(id.toUpperCase()));
    const description = [];
    for (const field of ['title', 'description', 'input', 'output']) {
      const value = (await page.locator(`#module-${field}`).innerText()).trim();
      assert.ok(value, `Component ${id} must show its ${field}`);
      description.push(value);
    }
    assert.match(description.join(' '), componentMeaning[id], `Component ${id} must explain its role`);
    componentDescriptions.add(description[1]);
    const verification = await page.locator('.independent-check').innerText();
    assert.match(verification, /原题|完整/);
    assert.match(verification, /独立|Lean/);
    assert.match(verification, /验收|检查/);
    await checkWidth(page, `component ${id}`);
  }
  assert.equal(componentDescriptions.size, 5, 'Each research component must display its own explanation');
  await page.locator('#tab-m5').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#tab-m1').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await page.locator('#tab-m5').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#tab-m1').getAttribute('aria-selected'), 'true');
  await page.locator('#tab-m3').click();

  await checkStart(page);
  const links = await page.locator('a[href*="github.com/LikC1606"]').evaluateAll(anchors => anchors.map(anchor => anchor.href));
  assert.ok(links.length > 0 && links.every(href => href.startsWith('https://github.com/LikC1606/TheoremOS')), `Only the public site repository may be linked: ${links}`);

  const summary = page.locator('.faq-list summary').first();
  await summary.click();
  assert.equal(await page.locator('.faq-list details').first().getAttribute('open'), '');
  await summary.click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'landing-desktop.png'), fullPage: true });
  await page.screenshot({ path: path.join(output, 'landing-hero.png') });

  for (const viewport of [{ width: 1920, height: 1080 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    await page.goto(url);
    await page.waitForFunction(() => document.documentElement.dataset.landingReady === 'true');
    await page.evaluate(() => document.fonts.ready);
    await checkHomepageFacts(page);
    await checkFeaturedProof(page, `${viewport.width}px homepage`);
    await checkWorkbench(page, `${viewport.width}px homepage`);
    await checkScreenshotPreview(page, viewport.width);
    await checkArchiveEntry(page);
    await checkProductImages(page, `${viewport.width}px homepage`);
    await checkModuleShowcase(page, viewport.width);
    await checkStart(page);
    await checkProofActions(page);
    await checkWidth(page, `${viewport.width}px homepage`);
    for (const id of ['feedback', 'repair', 'verified']) {
      await page.locator(`#demo-${id}`).click();
      await checkWidth(page, `${viewport.width}px replay ${id}`);
    }
    assert.ok(await page.locator('.brand img').first().evaluate(image => image.complete && image.naturalWidth > 0));
    await page.locator('#tab-m2').click();
    await checkWidth(page, `${viewport.width}px M2`);
    if (viewport.width <= 390) {
      await page.locator('#tab-m2').focus();
      await page.keyboard.press('End');
      const selected = await page.locator('#tab-m5').evaluate(node => {
        const bounds = node.getBoundingClientRect(), parent = node.parentElement.getBoundingClientRect();
        return { active: node.getAttribute('aria-selected'), visible: bounds.left >= parent.left - 1 && bounds.right <= parent.right + 1 };
      });
      assert.equal(selected.active, 'true');
      assert.ok(selected.visible, 'Keyboard selection must reveal the active mobile component tab');
      await checkMobileComponentTabs(page, `${viewport.width}px homepage`);
    }
    await page.locator('#start').scrollIntoViewIfNeeded();
    await checkWidth(page, `${viewport.width}px start section`);
    await page.locator('#tab-m3').click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, `landing-${viewport.width}.png`), fullPage: true });
    await page.screenshot({ path: path.join(output, `landing-${viewport.width}-hero.png`) });
  }
  await checkHoveredGraphEdges();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: width === 768 ? 1024 : 844 });
    await page.goto(url);
    await page.waitForFunction(() => document.documentElement.dataset.landingReady === 'true');
    await page.locator('#proofs').scrollIntoViewIfNeeded();
    const header = await page.locator('.site-header').boundingBox();
    assert.ok(header && Math.abs(header.y) < 1, `The header stays available while reading at ${width}px`);
    const menu = page.getByRole('button', { name: '打开导航' });
    await menu.click();
    assert.equal(await page.locator('#mobile-nav').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#mobile-nav').isVisible(), false);
    assert.equal(await menu.evaluate(button => button === document.activeElement), true);
    for (const target of ['#components', '#workbench-preview', '#start']) {
      await menu.click();
      await page.locator(`#mobile-nav a[href="${target}"]`).click();
      assert.equal(await page.locator('#mobile-nav').isVisible(), false);
      assert.equal(new URL(page.url()).hash, target);
      await checkAnchorClearance(page, target);
    }
    assert.equal(await page.locator('.component-tabs').getAttribute('aria-orientation'), 'horizontal');
    if (await page.locator('.nav-start').isVisible()) {
      await page.locator('.nav-start').click();
      await checkAnchorClearance(page, '#start');
    }
    await checkWidth(page, `${width}px sticky navigation`);
  }
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForFunction(() => document.querySelector('#mobile-nav').hidden);
  assert.equal(await page.locator('#mobile-nav').isVisible(), false);

  // The proof row opens the exact archived source, and the archive returns home.
  await reveal(page.locator('[data-accepted-proof="annals_rademacher_enflo_type"]'));
  await page.locator('[data-accepted-proof="annals_rademacher_enflo_type"] a[data-proof-source]').click();
  await page.waitForSelector('.source-code');
  assert.match(await page.locator('.is-declaration').innerText(), /theorem theorem_1_1/);
  await page.getByRole('link', { name: 'TheoremOS 首页' }).click();
  assert.equal(new URL(page.url()).pathname, new URL(url).pathname);
  await page.locator('.archive-footer a[href="archive.html"]').click();
  await page.waitForSelector('#inspector .detail-title');
  assert.equal(new URL(page.url()).pathname, new URL('archive.html', url).pathname);
  assert.equal(await page.locator('.proof-row').count(), catalog.records.length);
  assert.equal(await page.locator('#accepted-count').innerText(), String(accepted.length));
  assert.equal(await page.locator('#verified-count').innerText(), String(catalog.records.filter(record => record.status === 'locally_verified').length));
  assert.equal(await page.locator('#progress-count').innerText(), String(catalog.records.filter(record => record.status === 'in_progress_not_officially_accepted').length));
  assert.equal(await page.locator('#inspector .detail-title').innerText(), accepted[0].title);
  assert.ok((await page.locator('#inspector .record-facts').innerText()).includes(accepted[0].model));

  const noJS = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  trackErrors(noJS);
  await noJS.goto(url);
  assert.equal(await noJS.locator('[data-accepted-proof]').count(), accepted.length);
  await checkFeaturedProof(noJS, 'JavaScript-disabled homepage');
  await checkWorkbench(noJS, 'JavaScript-disabled homepage');
  await checkProductImages(noJS, 'JavaScript-disabled homepage');
  await checkGraphReadability(noJS, '1440px JavaScript-disabled module map', false);
  await checkGraphVerification(noJS);
  assert.equal(await noJS.locator('.module-library').isVisible(), false);
  await checkArchiveEntry(noJS);
  assert.equal(await noJS.locator('.module-preview-tabs').isVisible(), false);
  assert.equal(await noJS.locator('.workbench-image-link').getAttribute('href'), 'assets/workbench-full-desktop.png');
  assert.ok(fs.existsSync(path.join(site, 'assets/workbench-full-desktop.png')));
  await checkHomepageFacts(noJS);
  await checkStart(noJS);
  await checkProofActions(noJS);
  assert.equal(await noJS.locator('[data-accepted-proof] h3 a').first().isVisible(), true);
  await noJS.setViewportSize({ width: 320, height: 844 });
  await noJS.goto(url);
  await checkGraphReadability(noJS, '320px JavaScript-disabled module map', false);
  await checkGraphVerification(noJS);
  assert.equal(await noJS.locator('.menu-toggle').isVisible(), false, 'No-script readers must not get an inert menu');
  const noScriptApply = noJS.locator('a[href="#start"]:visible').first();
  assert.equal(await noScriptApply.isVisible(), true, 'An application link stays available without scripts');
  await noScriptApply.click();
  await checkAnchorClearance(noJS, '#start');
  await checkWidth(noJS, '320px no-script navigation');
  await noJS.close();

  // Test the repository subpath used by GitHub Pages, with real HTTP resource loading.
  server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!pathname.startsWith('/TheoremOS/')) { response.writeHead(404).end(); return; }
    const file = path.resolve(site, pathname.slice('/TheoremOS/'.length) || 'index.html');
    if (!file.startsWith(site + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain' };
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const hosted = `http://127.0.0.1:${server.address().port}/TheoremOS/`;
  await page.goto(hosted);
  await page.waitForFunction(() => document.documentElement.dataset.landingReady === 'true');
  await page.evaluate(() => document.fonts.ready);
  await checkWorkbench(page, 'GitHub Pages repository subpath');
  await checkProductImages(page, 'GitHub Pages repository subpath');
  await checkModuleShowcase(page, 1440);
  await checkScreenshotPreview(page, 1440);
  await page.locator('#tab-m4').click();
  assert.match(await page.locator('#module-kicker').innerText(), /M4/);
  assert.match(await page.locator('#module-description').innerText(), componentMeaning.m4);
  await page.locator('a[href="archive.html"]').filter({ hasText: '浏览' }).first().click();
  await page.waitForSelector('.proof-row');
  assert.equal(await page.locator('.proof-row').count(), catalog.records.length);
  assert.deepEqual(errors, []);
  console.log('Landing checks passed: interactive module graph and static no-script graph, no graph API or mutation calls, Lean workflow, beta application and model billing, exact accepted source and original attribution, responsive product screenshots, modal zoom and keyboard focus, replay and component controls, mobile navigation, JavaScript-disabled content, file preview, Pages subpath, and 5 viewport sizes.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await browser.close();
}
