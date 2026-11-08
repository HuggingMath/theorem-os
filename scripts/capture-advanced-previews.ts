#!/usr/bin/env bun
/** Capture only the twelve Chinese/English advanced previews after build:web; entry screenshots stay untouched. */
import assert from 'node:assert/strict';
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
const draftSource = 'import Mathlib\ntheorem square_add (x y : ℝ) :\n  (x+y)^2 = x^2+2*x*y+y^2 := by sorry';
async function captureLocale(locale: keyof typeof localeLabels) {
  const labels = localeLabels[locale], suffix = locale === 'en' ? '-en' : '';
  const output = (name: string) => path.join(root, 'docs/assets', `${name}${suffix}.png`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
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
  const capture = async (name: string) => {
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.screenshot({ path: output(name) });
  };
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
    await page.setViewportSize({ width: 1245, height: 667 });
    const source = page.locator('#draft-preview');
    await source.evaluate(node => { node.scrollTop = 0; });
    const sourceDetail = await page.locator('.draft-source-scroll').evaluate(node => ({
      value: node.querySelector('code')!.textContent,
      fits: node.scrollHeight <= node.clientHeight + 2 && node.scrollWidth <= node.clientWidth + 2,
    }));
    assert.equal(sourceDetail.value, draftSource);
    assert.ok(sourceDetail.fits, 'The source screenshot must show the complete Lean draft');
    await page.evaluate(() => document.fonts.ready);
    await source.screenshot({ path: output('workbench-source-detail') });
    const sourceBounds = await source.boundingBox();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#open-settings').click();
    await page.locator('#run-settings[open]').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-settings-section="settings-connection"]').click();
    assert.equal(await page.locator('#api-key').inputValue(), '');
    assert.equal(await page.locator('#api-key').getAttribute('type'), 'password');
    const settingsVisible = await page.locator('.settings-content').evaluate(node => {
      const bounds = node.getBoundingClientRect();
      return ['#provider', '#model', '#effort', '#api-key'].every(selector => {
        const field = node.querySelector(selector)!, rect = field.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top >= bounds.top && rect.bottom <= bounds.bottom
          && rect.left >= bounds.left && rect.right <= bounds.right;
      });
    });
    assert.ok(settingsVisible, 'The connection screenshot must show the provider, model and empty API key');
    await page.locator('#run-settings').screenshot({ path: output('workbench-settings-detail') });
    const settingsBounds = await page.locator('#run-settings').boundingBox();

    await page.setViewportSize({ width: 1440, height: 900 });
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
    for (const [width, height, device] of [[1440, 900, 'desktop'], [390, 844, 'mobile']] as const) {
      await page.setViewportSize({ width, height });
      await page.locator('[data-settings-section="module-plan"]').click();
      await capture(`workbench-library-${device}`);
    }
    await closeSettings(page);
    if (await page.locator('#open-draft-preview').isVisible()) await page.locator('#open-draft-preview').click();
    await page.locator('#draft-tab-modules').click();
    for (const [width, height, device] of [[1440, 900, 'desktop'], [390, 844, 'mobile']] as const) {
      await page.setViewportSize({ width, height });
      await page.locator('#draft-module-panel').evaluate(node => { node.scrollTop = 0; });
      if (device === 'mobile') {
        await page.locator('.module-view-heading').evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
        const coordinator = await page.locator('[data-module-id="M5"]').boundingBox();
        const receipt = await page.locator('[data-module-id="S3"]').boundingBox();
        assert.ok(coordinator && receipt && coordinator.y >= 100 && receipt.y + receipt.height <= height + 1,
          'The mobile module screenshot must show the full research graph and independent acceptance');
      }
      assert.equal(await page.locator('#draft-preview .preview-status').innerText(), labels.previewStatus);
      geometryChecks.push(await checkModuleGeometry(page, `${locale} saved-plan preview at ${width}px`));
      await capture(`workbench-modules-${device}`);
    }
    assert.equal(await page.locator('#api-key').inputValue(), '');
    return { locale, previews: 6, sourceBounds, settingsBounds, geometryChecks,
      apiKeyEmpty: true, draftStatus: labels.previewStatus, savedPlan: 'disposable browser localStorage' };
  } finally { await context.close(); }
}
try {
  const captures = [];
  for (const locale of ['zh', 'en'] as const) captures.push(await captureLocale(locale));
  assert.equal(writes, 0, 'Capturing previews must not send any API writes');
  assert.equal(modelInvocations, 0, 'Capturing previews must not invoke a model');
  assert.deepEqual(externalRequests, [], 'Capturing previews must stay on the local origin');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ previews: 12, deviceScaleFactor: 2, captures, writes, modelInvocations,
    externalRequests, apiRequests, modelInvoked: false, draftUnsubmitted: true, apiKeyEmpty: true }, null, 2));
} finally {
  await browser.close();
  await service.close();
}
