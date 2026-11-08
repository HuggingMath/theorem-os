#!/usr/bin/env bun
/** Capture real source, graph and saved-plan panels after build:web; entry screenshots stay untouched. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, startBrowser } from './web-scenario';
import { enterLean, closeSettings, showArtifacts } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..');
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const errors: string[] = [], externalRequests: string[] = [];
const apiRequests: { method: string; pathname: string }[] = [];
let writes = 0, modelInvocations = 0;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), {
  async readiness() { return { ready: true, message: 'Read-only screenshot preview' }; },
  async run() { modelInvocations++; throw new Error('Screenshots must never create a run'); },
  async formalize() { modelInvocations++; throw new Error('Screenshots must never create a formalization'); },
});
const browser = await startBrowser(service.server, port);
async function checkModuleGeometry(target: Page, label: string) {
  await target.evaluate(() => document.fonts.ready);
  const result = await target.locator('#draft-module-panel .module-graph').evaluate(graph => {
    const issues: string[] = [];
    const nodes = [...graph.querySelectorAll<HTMLElement>('.module-node')];
    const overlaps = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .5
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .5;
    for (const node of nodes) {
      const box = node.getBoundingClientRect();
      const parts = ['name', 'subject', 'state'].map(part => {
        const element = node.querySelector(`.module-node-${part}`)!;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const rects: DOMRect[] = [];
        for (let text = walker.nextNode(); text; text = walker.nextNode()) if (text.textContent?.trim()) {
          const range = document.createRange(); range.selectNodeContents(text);
          rects.push(...range.getClientRects());
        }
        for (const rect of rects) if (rect.left < box.left - 1 || rect.right > box.right + 1
          || rect.top < box.top - 1 || rect.bottom > box.bottom + 1)
          issues.push(`${node.dataset.moduleId} ${part} escapes its card`);
        return { part, rects };
      });
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++)
        if (parts[i]!.rects.some(a => parts[j]!.rects.some(b => overlaps(a, b))))
          issues.push(`${node.dataset.moduleId} ${parts[i]!.part}/${parts[j]!.part} overlap`);
    }
    const edges = [...graph.querySelectorAll<HTMLElement>('.module-edge')];
    for (const edge of edges) {
      const box = edge.getBoundingClientRect(), line = getComputedStyle(edge, '::before');
      const arrow = getComputedStyle(edge, '::after');
      const from = graph.querySelector(`[data-module-id="${edge.dataset.from}"]`)!.getBoundingClientRect();
      const to = graph.querySelector(edge.dataset.to === 'research' ? '.module-research'
        : `[data-module-id="${edge.dataset.to}"]`)!.getBoundingClientRect();
      const x = box.left + parseFloat(line.left), y = box.top + parseFloat(line.top);
      const width = parseFloat(line.width), height = parseFloat(line.height);
      const close = (a: number, b: number) => Math.abs(a - b) <= 1.5;
      const direction = edge.dataset.direction;
      const connects = direction === 'right' ? close(x, from.right) && close(x + width, to.left)
        && close(y, from.top + from.height / 2) && close(y, to.top + to.height / 2)
        : direction === 'left' ? close(x, to.right) && close(x + width, from.left)
          && close(y, from.top + from.height / 2) && close(y, to.top + to.height / 2)
        : direction === 'up' ? close(y, to.bottom) && close(y + height, from.top)
          && close(x, from.left + from.width / 2) && close(x, to.left + to.width / 2)
        : close(y, from.bottom) && close(y + height, to.top) && close(x, from.left + from.width / 2)
          && (edge.dataset.to === 'S3' || close(x, to.left + to.width / 2));
      if (!connects || !(width > 0 && height > 0) || !(parseFloat(arrow.width) > 0)
        || !(parseFloat(arrow.height) > 0) || arrow.transform === 'none')
        issues.push(`${edge.dataset.from}→${edge.dataset.to} arrow does not connect: ${JSON.stringify({ x, y, width, height })}`);
    }
    return { nodes: nodes.length, arrows: edges.length, issues };
  });
  assert.equal(result.nodes, 6, `${label}: all research and acceptance nodes exist`);
  assert.equal(result.arrows, 6, `${label}: all graph connections exist`);
  assert.deepEqual(result.issues, [], label);
  return { label, nodes: result.nodes, arrows: result.arrows };
}
const localeLabels = {
  zh: { htmlLang: 'zh-CN', previewStatus: '草稿', draftSaved: '草稿已存于此标签页', saved: '已保存',
    planName: 'Mathlib 代数研究', planSummary: /2 \/ 2.*项策略启用.*与当前配置一致/,
    rules: [['优先代数化简', '先尝试 ring 和 linarith，保持原定理陈述不变。'],
      ['检索匹配引理', '优先选择类型与当前目标匹配的 Mathlib 引理。']] },
  en: { htmlLang: 'en-US', previewStatus: 'Draft', draftSaved: 'Draft saved in this tab', saved: 'Saved',
    planName: 'Mathlib algebra study', planSummary: /2 \/ 2.*strategies enabled.*Matches the current settings/,
    rules: [['Prefer algebraic simplification', 'Try ring and linarith first, preserving the original theorem statement.'],
      ['Retrieve matching lemmas', 'Prefer Mathlib lemmas whose types match the current goal.']] },
} as const;
const draftSource = 'import Mathlib\n\nexample (n : ℕ) : n + 0 = n := by\n  simp';
type Bounds = { x: number; y: number; width: number; height: number };
const captured: object[] = [];
async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}
async function bounds(page: Page, selectors: string[]) {
  return page.evaluate(selectors => {
    const boxes = selectors.map(selector => document.querySelector(selector)!.getBoundingClientRect());
    const x = Math.floor(Math.min(...boxes.map(box => box.left)));
    const y = Math.floor(Math.min(...boxes.map(box => box.top)));
    return { x, y, width: Math.ceil(Math.max(...boxes.map(box => box.right))) - x,
      height: Math.ceil(Math.max(...boxes.map(box => box.bottom))) - y };
  }, selectors);
}
async function capturePanel(page: Page, file: string, clip: Bounds, size: { width: number; height: number },
  density: number, backgroundSelector: string) {
  assert.ok(clip.width <= size.width && clip.height <= size.height,
    `${path.basename(file)}: real panel ${clip.width}×${clip.height} must fit ${size.width}×${size.height} without rescaling or cropping`);
  const image = await page.screenshot({ clip });
  assert.equal(image.readUInt32BE(16), clip.width * density);
  assert.equal(image.readUInt32BE(20), clip.height * density);
  // Pad only with the panel's existing adjacent background; draw the native raster at 1:1 pixel size.
  const result = await page.evaluate(async ({ source, size, density, backgroundSelector }) => {
    let element: Element | null = document.querySelector(backgroundSelector);
    let background = 'transparent';
    while (element && ['transparent', 'rgba(0, 0, 0, 0)'].includes(background)) {
      background = getComputedStyle(element).backgroundColor;
      element = element.parentElement;
    }
    const bytes = Uint8Array.from(atob(source), character => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = size.width * density; canvas.height = size.height * density;
    const context = canvas.getContext('2d')!;
    context.fillStyle = background; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, Math.floor((canvas.width - bitmap.width) / 2), Math.floor((canvas.height - bitmap.height) / 2));
    bitmap.close();
    return { png: canvas.toDataURL('image/png').split(',')[1]!, background };
  }, { source: image.toString('base64'), size, density, backgroundSelector });
  fs.writeFileSync(file, Buffer.from(result.png, 'base64'));
  captured.push({ file: path.basename(file), logical: size, deviceScaleFactor: density,
    pixels: { width: size.width * density, height: size.height * density }, nativePanel: clip,
    viewport: page.viewportSize(), paddingBackground: result.background, rasterRescaled: false });
}
async function captureLocale(locale: keyof typeof localeLabels, density: 2 | 3) {
  const labels = localeLabels[locale], suffix = locale === 'en' ? '-en' : '';
  const output = (name: string) => path.join(root, 'docs/assets', `${name}${suffix}.png`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: density,
    reducedMotion: 'reduce', locale: labels.htmlLang });
  await context.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: localeStorageKey, value: locale });
  await context.route(/^https?:\/\//, async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { externalRequests.push(url.origin); await route.abort(); return; }
    if (url.pathname.startsWith('/api/')) {
      apiRequests.push({ method: request.method(), pathname: url.pathname });
      if (request.method() !== 'GET') { writes++; await route.abort(); return; }
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    const geometryChecks = [];
    await page.goto(origin);
    await page.locator('#formalize-original').waitFor();
    await enterLean(page);
    await page.locator('#submit-run:enabled').waitFor();
    assert.equal(await page.getAttribute('html', 'lang'), labels.htmlLang);
    assert.equal(await page.locator('#api-key').inputValue(), '');
    await page.locator('#edit-draft-source').click();
    await page.locator('#expanded-source').fill(draftSource);
    await page.locator('#apply-editor').click();
    await page.locator('#source-editor').waitFor({ state: 'hidden' });
    await page.locator('#draft-status').filter({ hasText: labels.draftSaved }).waitFor();
    if (await page.locator('#dismiss-draft-recovery').isVisible()) await page.locator('#dismiss-draft-recovery').click();
    await showArtifacts(page);
    assert.equal(await page.locator('#draft-preview .preview-status').innerText(), labels.previewStatus);
    if (density === 2) for (const device of ['desktop', 'mobile'] as const) {
      await page.setViewportSize({ width: device === 'desktop' ? 1094 : 390, height: 900 });
      await showArtifacts(page);
      await page.locator('#draft-preview').evaluate(node => { node.scrollTop = 0; });
      await settle(page);
      const sourceDetail = await page.locator('.draft-source-scroll').evaluate(node => ({
        value: node.querySelector('code')!.textContent,
        fits: node.scrollWidth <= node.clientWidth + 2,
      }));
      assert.equal(sourceDetail.value, draftSource);
      assert.ok(sourceDetail.fits, 'Every line of the real Lean draft must fit without horizontal scrolling');
      const preview = (await page.locator('#draft-preview').boundingBox())!;
      const width = device === 'desktop' ? 850 : 360, height = 450;
      const clip = { x: Math.round(preview.x + (preview.width - width) / 2), y: Math.floor(preview.y), width, height };
      const visible = await page.evaluate(clip => {
        const elements = ['.preview-heading h2', '.preview-status', '#draft-preview-code code'];
        return elements.every(selector => {
          const element = document.querySelector(selector)!;
          const range = document.createRange(); range.selectNodeContents(element);
          return [...range.getClientRects()].every(box => box.left >= clip.x && box.right <= clip.x + clip.width
            && box.top >= clip.y && box.bottom <= clip.y + clip.height);
        });
      }, clip);
      assert.ok(visible, `${locale} ${device}: show the real draft badge and every code line`);
      await page.screenshot({ path: output(device === 'desktop' ? 'workbench-source-detail' : 'workbench-source-mobile'), clip });
      captured.push({ file: path.basename(output(device === 'desktop' ? 'workbench-source-detail' : 'workbench-source-mobile')),
        logical: { width, height }, pixels: { width: width * density, height: height * density },
        deviceScaleFactor: density, viewport: page.viewportSize(), nativePanel: clip, draftSource });
    }

    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.locator('#open-settings').click();
    await page.locator('#run-settings[open]').waitFor();
    await page.locator('[data-settings-section="module-plan"]').click();
    await page.locator('#module-plan-scheduler').selectOption('critical-path');
    await page.locator('#module-plan-context').selectOption('essential');
    for (const [name, slot, instructions] of [
      [labels.rules[0][0], 'M1', labels.rules[0][1]],
      [labels.rules[1][0], 'M4', labels.rules[1][1]],
    ]) {
      await page.locator('#module-plan-add').click();
      const rule = page.locator('[data-module-plan-id]').last();
      await rule.locator('[data-module-plan-field="name"]').fill(name);
      await rule.locator('[data-module-plan-field="slot"]').selectOption(slot);
      await rule.locator('[data-module-plan-field="instructions"]').fill(instructions);
      await rule.locator('[data-module-plan-field="enabled"]').check();
      await rule.locator('[data-module-plan-disclosure]').click();
    }
    await page.locator('#module-plan-library>summary').click();
    await page.locator('#module-library-name').fill(labels.planName);
    await page.locator('[data-module-library-save]').click();
    await page.locator('[data-module-library-notice]').filter({ hasText: labels.saved }).waitFor();
    assert.equal(await page.locator('[data-module-library-count]').innerText(), '1 / 12');
    assert.match(await page.locator('[data-module-library-summary]').innerText(), labels.planSummary);
    const device = density === 3 ? 'desktop' : 'mobile';
    await page.setViewportSize({ width: device === 'desktop' ? 1440 : 390, height: 1200 });
    await page.locator('#module-plan-library').evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await settle(page);
    const library = await bounds(page, device === 'desktop' ? ['#module-plan-library']
      : ['#module-plan-library', '.module-plan-builtins', '.module-plan-fixed']);
    await capturePanel(page, output(`workbench-library-${device}`), library,
      device === 'desktop' ? { width: 632, height: 395 } : { width: 360, height: 650 }, density, '#module-plan-library');
    if (density === 3) return { locale, deviceScaleFactor: density, previews: 1, apiKeyEmpty: true,
      savedPlan: 'disposable browser localStorage' };
    await closeSettings(page);
    if (await page.locator('#open-draft-preview').isVisible()) await page.locator('#open-draft-preview').click();
    await page.locator('#draft-tab-modules').click();
    for (const [width, height, device] of [[1920, 1100, 'desktop'], [390, 1200, 'mobile']] as const) {
      await page.setViewportSize({ width, height });
      await page.locator('#draft-preview').evaluate(node => { node.scrollTop = 0; });
      if (device === 'mobile') {
        await page.locator('.module-view-heading').evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
        const coordinator = await page.locator('[data-module-id="M5"]').boundingBox();
        const receipt = await page.locator('[data-module-id="S3"]').boundingBox();
        assert.ok(coordinator && receipt && coordinator.y >= 100 && receipt.y + receipt.height <= height + 1,
          'The mobile module screenshot must show the full research graph and independent acceptance');
      }
      assert.equal(await page.locator('#draft-preview .preview-status').innerText(), labels.previewStatus);
      geometryChecks.push(await checkModuleGeometry(page, `${locale} saved-plan preview at ${width}px`));
      await settle(page);
      const graph = await bounds(page, ['.module-graph > [data-module-id="M5"]', '.module-research',
        '.module-acceptance-edge', '.module-graph > [data-module-id="S3"]', '.module-legend']);
      await capturePanel(page, output(`workbench-modules-${device}`), graph,
        device === 'desktop' ? { width: 848, height: 530 } : { width: 360, height: 650 }, density, '.module-graph');
    }
    assert.equal(await page.locator('#api-key').inputValue(), '');
    return { locale, deviceScaleFactor: density, previews: 5, geometryChecks,
      apiKeyEmpty: true, draftStatus: labels.previewStatus, savedPlan: 'disposable browser localStorage' };
  } finally { await context.close(); }
}
try {
  const captures = [];
  for (const locale of ['zh', 'en'] as const) {
    captures.push(await captureLocale(locale, 2));
    captures.push(await captureLocale(locale, 3));
  }
  assert.equal(writes, 0, 'Capturing previews must not send any API writes');
  assert.equal(modelInvocations, 0, 'Capturing previews must not invoke a model');
  assert.deepEqual(externalRequests, [], 'Capturing previews must stay on the local origin');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ previews: 12, captures, images: captured, writes, modelInvocations,
    externalRequests, apiRequests, modelInvoked: false, draftUnsubmitted: true, apiKeyEmpty: true }, null, 2));
} finally {
  await browser.close();
  await service.close();
}
