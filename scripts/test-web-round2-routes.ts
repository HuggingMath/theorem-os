#!/usr/bin/env bun
// Recorded route regressions only: this suite never starts a solver or writes business data.
import assert from 'node:assert/strict';
import { showArtifacts } from './web-ui-controls';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Locator, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { loadWebSample } from '../apps/web/sample';
import { createWebService } from '../apps/web/server';
import type { ArchiveCatalog, ArchiveProcess } from '../docs/web/types';
import { freePort, settled, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), webRoot = path.join(root, 'out/web');
const output = path.join(root, 'out/web-round2-routes');
const catalog = JSON.parse(await fs.readFile(path.join(webRoot, 'classics/data/catalog.json'), 'utf8')) as ArchiveCatalog;
const classic = catalog.records.find(record => record.id === 'openai_totient_companion_zero');
assert.ok(classic, 'Build the classic archive before running these regressions.');
const sample = loadWebSample(); assert.ok(sample, 'A saved sample is required; the runner must never execute.');
await fs.mkdir(output, { recursive: true });
const readProcess = async (id: string): Promise<ArchiveProcess> => {
  const script = await fs.readFile(path.join(webRoot, 'classics/data/process', `${id}.js`), 'utf8');
  return JSON.parse(script.slice(script.indexOf(']=') + 2).trim().replace(/;$/u, ''));
};
const process = await readProcess(classic.id);
type SourceTarget = { id: string; query: string; name: string; digest: string; line: number; endLine: number; code: string; runId?: string };
function sourceTarget(value: ArchiveProcess, declarationName: string, step = false): SourceTarget {
  for (const file of value.sourceRoute?.files ?? []) {
    const declaration = file.declarations.find(item => item.name === declarationName);
    if (!declaration) continue;
    const selected = step ? declaration.steps.at(-1)! : declaration;
    assert.ok(selected, 'The source-step regression requires a real proof block.');
    const source = value.sources?.[file.sha256];
    return { id: selected.id, query: declaration.name, name: source?.path ?? file.name, digest: file.sha256,
      line: selected.line, endLine: selected.endLine, code: source?.code ?? file.code! };
  }
  throw new Error(`Missing archived declaration: ${declarationName}`);
}

const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let runnerCalls = 0;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: webRoot, THEOREMOS_WEB_AUTH: 'none' }), {
  async readiness() { return { ready: true, message: 'Recorded route fixture; no model or Lean' }; },
  async run() { runnerCalls++; throw new Error('Route browsing must never start a worker.'); },
}, { sample });
const checks: object[] = [], writes: string[] = [], errors: string[] = [];
let browser: Browser | undefined, current = '', failureScreenshot: string | undefined;
async function scenario(name: string, locale: 'zh' | 'en', viewport: { width: number; height: number }, run: (page: Page) => Promise<object>) {
  current = name;
  const context = await browser!.newContext({ locale: locale === 'en' ? 'en-US' : 'zh-CN', viewport, reducedMotion: 'reduce' });
  await context.addInitScript(value => localStorage.setItem('theorem-os.web-locale.v1', value), locale);
  await context.route(/^https?:\/\//u, route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!['GET', 'HEAD'].includes(request.method())) { writes.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  try {
    checks.push({ ...await run(page), name, locale, viewport }); console.log(`PASS ${name}`);
  } catch (error) {
    failureScreenshot = `failure-${checks.length + 1}.png`;
    await page.screenshot({ path: path.join(output, failureScreenshot) }).catch(() => {}); throw error;
  } finally { await context.close(); }
}
async function openClassic(page: Page, locale: 'zh' | 'en', id = classic!.id, runId = '') {
  const params = new URLSearchParams({ proof: id, tab: 'process', ...(runId ? { run: runId, mode: 'global' } : {}) });
  await page.goto(`${origin}/classics/${locale === 'en' ? 'en/' : ''}archive.html#${params}`);
  await page.locator(`[data-solution-route-record="${id}"][data-solution-route-state="ready"]`).waitFor();
  await settled(page);
}
async function mode(page: Page, basis: string) {
  await page.locator(`[data-solution-mode="${basis}"]`).click();
  await page.locator(`.solution-route[data-solution-route-basis="${basis}"]`).waitFor();
}
async function openSource(page: Page, target: SourceTarget, child = false) {
  const map = page.locator('.solution-route');
  await map.locator('[data-solution-search]').fill(target.query);
  const node = map.locator(`[data-solution-node=${JSON.stringify(target.id)}]`);
  if (child) await map.locator(`.solution-route-records [data-solution-select=${JSON.stringify(target.id)}]`).click();
  else await node.click();
  await map.locator('[data-solution-expand]').click();
  await map.locator('[data-solution-open]').click();
  const panel = page.locator(`pre[data-source-digest="${target.digest}"]`);
  await panel.waitFor(); await settled(page);
  assert.equal(await panel.getAttribute('data-source-name'), target.name);
  const highlight = panel.locator('[data-source-highlight]');
  assert.equal(await highlight.count(), target.endLine - target.line + 1, 'Highlight the exact selected range.');
  assert.equal(await highlight.first().getAttribute('data-source-line'), String(target.line));
  assert.equal(await highlight.last().getAttribute('data-source-line'), String(target.endLine));
  const actualLines = await panel.locator('[data-source-line] > span:last-child').allTextContents();
  const expectedLines = target.code.replace(/\r\n/gu, '\n').split('\n');
  if (expectedLines.at(-1) === '') expectedLines.pop();
  assert.deepEqual(actualLines, expectedLines.map(line => line || ' '), 'Show every line from the selected immutable version.');
  const visible = await highlight.first().evaluate(element => {
    const panel = element.closest('pre')!, viewport = panel.getBoundingClientRect(), row = element.getBoundingClientRect();
    let top = Math.max(0, viewport.top), bottom = Math.min(innerHeight, viewport.bottom);
    for (let parent = panel.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll|hidden|clip)/u.test(getComputedStyle(parent).overflowY)) {
        const rect = parent.getBoundingClientRect(); top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom);
      }
    }
    return { visible: row.top >= top - 1 && row.bottom <= bottom + 1, scrollTop: panel.scrollTop,
      top: row.top, bottom: row.bottom, visibleTop: top, visibleBottom: bottom, background: getComputedStyle(element).backgroundColor };
  });
  assert.ok(visible.visible, `The first selected line must be visible after opening: ${JSON.stringify(visible)}`);
  assert.notEqual(visible.background, 'rgba(0, 0, 0, 0)', 'Selected lines must have a visible highlight.');
  if (target.line > 3) assert.ok(visible.scrollTop > 0, 'The source reader must scroll to a later declaration or proof block.');
  assert.equal(await page.locator('body').evaluate(body => body.style.overflow === 'hidden'), false, 'Opening source closes the expanded route.');
  return { name: target.name, digest: target.digest, line: target.line, endLine: target.endLine, visible };
}
async function collapseChild(map: Locator, taskId: string) {
  await map.locator(`[data-solution-node=${JSON.stringify(taskId)}]`).click();
  const toggle = map.locator(`[data-solution-children=${JSON.stringify(taskId)}]`);
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const child = map.locator('.solution-route-records [data-solution-select]').first();
  const childId = await child.getAttribute('data-solution-select'); assert.ok(childId);
  await child.click();
  assert.equal(await map.locator('[data-solution-heading]').getAttribute('data-solution-heading'), childId);
  await map.locator('[data-solution-all]').click();
  assert.equal(await map.locator('[data-solution-heading]').getAttribute('data-solution-heading'), taskId);
  assert.equal(await map.locator('[data-solution-node][aria-pressed="true"]').count(), 1, 'Keep exactly one visible selection after collapsing.');
  return childId;
}

try {
  browser = await startBrowser(service.server, port);
  for (const locale of ['zh', 'en'] as const) {
    await scenario(`R2-01 ${locale}: declaration and source-step location`, locale,
      locale === 'zh' ? { width: 1440, height: 900 } : { width: 390, height: 480 }, async page => {
        const declaration = sourceTarget(process, locale === 'zh' ? 'TheoremOS.Analysis.asympAveragedModulus_eq_unit'
          : 'TheoremOS.Analysis.HasDaugavetProperty.unitSlice');
        await openClassic(page, locale); await mode(page, 'source');
        const selected = await openSource(page, declaration);
        await page.screenshot({ path: path.join(output, `source-declaration-${locale}.png`) });
        await openClassic(page, locale); await mode(page, 'source');
        await page.locator('[data-solution-search]').fill(declaration.query);
        await page.locator(`[data-solution-node=${JSON.stringify(declaration.id)}]`).click();
        const step = sourceTarget(process, declaration.query, true);
        const proofStep = await openSource(page, step, true);
        await page.screenshot({ path: path.join(output, `source-step-${locale}.png`) });
        return { selected, proofStep };
      });
  }

  await scenario('R2-01: checked proof explanation preserves its line range', 'en', { width: 1440, height: 900 }, async page => {
    const walkthrough = process.walkthrough; assert.ok(walkthrough);
    const step = walkthrough.steps.at(-1)!, saved = process.sources![walkthrough.proofSha256];
    const target: SourceTarget = { id: step.id, query: step.title.en, name: saved.path, digest: saved.sha256,
      line: step.evidence.source.line, endLine: step.evidence.source.endLine, code: saved.code };
    await openClassic(page, 'en'); await mode(page, 'explanation');
    const result = await openSource(page, target);
    await page.screenshot({ path: path.join(output, 'checked-explanation.png') }); return result;
  });

  await scenario('R2-01: historical source keeps its checked version', 'zh', { width: 1440, height: 900 }, async page => {
    for (const record of catalog.records.filter(item => (item.processSummary?.runs ?? 0) > 1)) {
      const value = await readProcess(record.id);
      for (const run of value.runs.filter(item => item.runId !== record.campaign?.runId)) {
        const latest = new Map<string, string>();
        for (const check of [...run.checks ?? []].sort((a, b) => a.at.localeCompare(b.at))) {
          const source = check.sourceDigest && value.sources?.[check.sourceDigest];
          if (source && check.sourceDigest) latest.set(source.path, check.sourceDigest);
        }
        for (const digest of latest.values()) {
          if (digest === record.campaign?.proofSha256) continue;
          const file = value.sourceRoute?.files.find(item => item.sha256 === digest), saved = value.sources?.[digest];
          const declaration = file?.declarations.find(item => item.line > 5 && item.steps.length);
          if (!file || !saved || !declaration) continue;
          const step = declaration.steps.at(-1)!;
          const target: SourceTarget = { id: step.id, query: declaration.name, name: saved.path, digest,
            line: step.line, endLine: step.endLine, code: saved.code, runId: run.runId };
          await openClassic(page, 'zh', record.id, run.runId); await mode(page, 'source');
          await page.locator('[data-solution-search]').fill(declaration.name);
          await page.locator(`[data-solution-node=${JSON.stringify(declaration.id)}]`).click();
          const result = await openSource(page, target, true);
          assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('run'), run.runId);
          await page.screenshot({ path: path.join(output, 'historical-source.png') });
          return { recordId: record.id, runId: run.runId, ...result };
        }
      }
    }
    throw new Error('The archive must contain a historical checked source distinct from the final proof.');
  });

  for (const surface of ['classics', 'workbench'] as const) for (const locale of ['zh', 'en'] as const) {
    await scenario(`R2-02 ${surface} ${locale}: collapse retains previous/next context`, locale,
      locale === 'zh' ? { width: 1440, height: 900 } : { width: 390, height: 480 }, async page => {
        if (surface === 'classics') { await openClassic(page, locale); await mode(page, 'recorded'); }
        else { await page.goto(`${origin}/?sample`); await page.locator('[data-sample-badge]').waitFor({ state: 'attached' }); await showArtifacts(page); await page.locator('#detail-tab-trajectory').click(); await page.locator('[data-trajectory-view="roadmap"]').click(); }
        const map = page.locator('.solution-route');
        const task = map.locator(surface === 'workbench' ? '[data-solution-node="task:goal_2"]' : '[data-solution-node^="task:"]').first();
        const taskId = await task.getAttribute('data-solution-node'); assert.ok(taskId);
        const childId = await collapseChild(map, taskId);
        const visible = await map.locator('[data-solution-node]').evaluateAll(elements => elements.map(element => element.getAttribute('data-solution-node')!));
        const at = visible.indexOf(taskId); assert.ok(at >= 0 && at < visible.length - 1);
        await map.locator('[data-solution-step="next"]').click();
        const next = await map.locator('[data-solution-heading]').getAttribute('data-solution-heading');
        assert.equal(next, visible[at + 1], 'Next continues after the selected task, without jumping to the start.');
        await collapseChild(map, taskId);
        await map.locator('[data-solution-step="previous"]').click();
        const previous = await map.locator('[data-solution-heading]').getAttribute('data-solution-heading');
        assert.equal(previous, visible[Math.max(0, at - 1)], 'Previous continues from the same task.');
        await map.locator('[data-solution-expand]').click();
        await page.screenshot({ path: path.join(output, `collapse-${surface}-${locale}.png`) });
        await page.keyboard.press('Escape');
        return { taskId, childId, next, previous };
      });
  }
  assert.equal(runnerCalls, 0); assert.deepEqual(writes, []); assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, writes, errors, runnerCalls, paidModelCalls: false }, null, 2) + '\n');
} catch (error) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', current, failureScreenshot, checks, writes, errors, runnerCalls,
    error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n'); throw error;
} finally { await browser?.close(); await service.close(); }
