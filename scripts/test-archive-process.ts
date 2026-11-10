#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import { createWebService } from '../apps/web/server';
import { compareSources } from '../apps/web/client/sourceDiff';
import type { ArchiveCatalog, ArchiveProcess, ArchiveRecord } from '../docs/web/types';
import { freePort, settled, startBrowser } from './web-scenario';

// The real workbench HTTP server serves the immutable public archive. The runner never starts.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/archive-process');
const staticRoot = path.join(root, 'out/web');
const catalog = JSON.parse(await fs.readFile(path.join(staticRoot, 'classics/data/catalog.json'), 'utf8')) as ArchiveCatalog;
const manifest = JSON.parse(await fs.readFile(path.join(root, 'research/openai-math/manifest.json'), 'utf8')) as { records: { id: string }[] };
assert.deepEqual(catalog.records.map(record => record.id).sort(), manifest.records.map(record => record.id).sort(), 'Build every solved campaign problem before checking the process reader');
assert.ok((await fs.readFile(path.join(staticRoot, 'classics/site.js'), 'utf8')).includes('data-process-step'),
  'Run bun run build:web before the archive process check');
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-archive-process-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let runnerCalls = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Read-only archive process fixture; no model or Lean' }; },
  async run() { runnerCalls++; throw new Error('A read-only archived process must not start a worker'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: data, THEOREMOS_WEB_AUTH: 'none' }), runner);
type Run = ArchiveProcess['runs'][number];
type Check = NonNullable<Run['checks']>[number];
type Selection = { record: ArchiveRecord; run: Run; check: Check };
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const all = catalog.records.flatMap(record => record.process!.runs.map(run => ({ record, run })));
const failures = all.flatMap(({ record, run }) => (run.checks ?? []).filter(check => check.status === 'failed' && check.diagnostics &&
  check.sourceDigest && record.process!.sources?.[check.sourceDigest]).map(check => ({ record, run, check })));
const failure = failures.sort((a, b) => a.check.diagnostics!.length - b.check.diagnostics!.length)[0];
assert.ok(failure, 'The archive must retain a real failed check with its diagnostic and checked file');
const complex = all.filter(({ run }) => run.tasks.some(task => task.dependencies.some(id => run.tasks.some(other => other.id === id)))
  && (run.deliveries?.length ?? 0) > 0 && (run.checks?.length ?? 0) > 0)
  .sort((a, b) => b.run.tasks.length - a.run.tasks.length)[0];
assert.ok(complex && complex.record.process!.runs.length > 1, 'A real multi-run task graph is needed');
const comparisons: (Selection & { previous: Check })[] = [];
for (const { record, run } of all) for (const check of run.checks ?? []) {
  const source = check.sourceDigest && record.process!.sources?.[check.sourceDigest];
  if (!source) continue;
  const previous = (run.checks ?? []).filter(item => item.at <= check.at && item.id !== check.id && item.scope === check.scope && item.taskId === check.taskId)
    .sort((a, b) => b.at.localeCompare(a.at)).find(item => item.sourceDigest && record.process!.sources?.[item.sourceDigest]?.path === source.path);
  const before = previous?.sourceDigest && record.process!.sources?.[previous.sourceDigest];
  if (before) {
    const compared = compareSources(before.code, source.code);
    if (compared.status === 'ready' && compared.added > 0 && compared.removed > 0) comparisons.push({ record, run, check, previous });
  }
}
const comparison = comparisons.sort((a, b) => a.record.process!.sources![a.check.sourceDigest!].code.length - b.record.process!.sources![b.check.sourceDigest!].code.length)[0];
assert.ok(comparison, 'The real archive must contain two distinct saved versions that can be compared');
const snaky = catalog.records.filter(record => record.campaign?.target.startsWith('Snaky'));
assert.equal(snaky.length, 2);
const checks: string[] = [], errors: string[] = [], writes: { method: string; path: string }[] = [], apiReads: string[] = [], external: string[] = [];
let browser: Browser | undefined, active: Page | undefined, current = 'browser start';
const mark = (message: string) => { checks.push(message); console.log(`PASS ${message}`); };
const urlFor = (record: ArchiveRecord, locale: string, params: Record<string, string> = {}) =>
  `${origin}/classics/${locale === 'en' ? 'en/' : ''}archive.html#${new URLSearchParams({ proof: record.id, tab: 'process', status: 'verified', mode: 'steps', ...params })}`;
const attr = (name: string, value: string) => `[${name}=${JSON.stringify(value)}]`;
const processRoot = (page: Page) => page.locator('.archive-process');
const step = (page: Page, id: string) => page.locator(`.process-step-list ${attr('data-process-step', id)}`);
const hash = (page: Page) => new URLSearchParams(new URL(page.url()).hash.slice(1));
async function observe(context: BrowserContext, label: string) {
  await context.route(/^https?:\/\//u, route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.href); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) { writes.push({ method: request.method(), path: url.pathname }); return route.abort(); }
    if (url.pathname.startsWith('/api/')) apiReads.push(url.pathname);
    return route.continue();
  });
  context.on('page', page => {
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${label}: ${response.status()} ${new URL(response.url()).pathname}`); });
  });
}
async function fits(page: Page, label: string) {
  await settled(page);
  const bounds = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
    detail: document.querySelector('#process-step-detail')?.getBoundingClientRect().toJSON() }));
  assert.ok(bounds.scroll <= bounds.width + 1, `${label}: horizontal overflow ${JSON.stringify(bounds)}`);
  if (bounds.detail) assert.ok(bounds.detail.left >= -1 && bounds.detail.right <= bounds.width + 1, `${label}: step detail leaves the viewport`);
}
async function open(page: Page, record: ArchiveRecord, locale: string, params: Record<string, string> = {}) {
  await page.goto(urlFor(record, locale, params));
  await processRoot(page).waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('#tab-process').getAttribute('aria-selected'), 'true');
  assert.equal(hash(page).get('proof'), record.id);
}
async function selectRun(page: Page, run: Run) {
  await page.locator(`.process-run-nav ${attr('data-process-run', run.runId)}`).click();
  assert.equal(await processRoot(page).getAttribute('data-process-run-id'), run.runId);
  assert.equal(hash(page).get('run'), run.runId);
}
async function selectCheck(page: Page, item: Selection, locale: string) {
  await open(page, item.record, locale, { run: item.run.runId });
  await page.locator('[data-process-filter="checks"]').click();
  await step(page, `check:${item.check.id}`).click();
  assert.equal(hash(page).get('step'), `check:${item.check.id}`);
  assert.equal(hash(page).get('filter'), 'checks');
  assert.equal(await step(page, `check:${item.check.id}`).getAttribute('aria-pressed'), 'true');
}

try {
  // Verify every recovered file, not a hand-picked or synthetic proof body.
  let sourceCount = 0, savedChecks = 0, deliveries = 0;
  for (const record of catalog.records) {
    assert.equal(record.status, 'locally_verified');
    assert.ok(record.campaign && record.process);
    for (const [key, source] of Object.entries(record.process.sources ?? {})) {
      assert.equal(digest(source.code), source.sha256, `${record.id}: immutable source bytes`);
      assert.equal(key, source.sha256, `${record.id}: source table key`);
      sourceCount++;
    }
    for (const run of record.process.runs) {
      savedChecks += run.checks?.length ?? 0; deliveries += run.deliveries?.length ?? 0;
      for (const check of run.checks ?? []) if (check.sourceDigest) assert.ok(record.process.sources?.[check.sourceDigest], `${record.id}: dangling check source`);
    }
  }
  mark(`all ${catalog.records.length} accepted problems retain ${savedChecks} checks, ${deliveries} deliveries and ${sourceCount} exact SHA-256-bound source files`);
  browser = await startBrowser(service.server, port);
  for (const locale of ['zh', 'en']) for (const width of [1440, 390, 320]) {
    const label = `${locale} ${width}px`;
    current = `${label}: process reader`;
    const context = await browser.newContext({ viewport: { width, height: width < 700 ? 844 : 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (text: string) => { (window as Window & { archiveTestClipboard?: string }).archiveTestClipboard = text; },
      } });
    });
    await observe(context, label);
    context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
    const page = await context.newPage(); active = page;
    try {
      await open(page, complex.record, locale);
      assert.equal(await processRoot(page).getAttribute('data-process-run-id'), complex.record.campaign!.runId);
      assert.equal(await page.locator('.process-run-nav [data-process-run]').count(), complex.record.process!.runs.length);
      assert.equal(await page.locator('[data-process-acceptance]').count(), 1);
      for (const target of complex.record.campaign!.targets) assert.ok((await page.locator('[data-process-acceptance]').innerText()).includes(target));
      assert.equal(await page.locator('.catalog').isVisible(), false, 'The timeline must have the full reading column');
      const frame = await processRoot(page).boundingBox();
      assert.ok(frame && frame.width >= (width === 1440 ? 900 : width - 65), `${label}: the trajectory is still in a narrow inspector`);
      await fits(page, `${label}: acceptance`);
      await page.screenshot({ path: path.join(output, `acceptance-${locale}-${width}.png`), fullPage: true });
      const finalStepIds = await page.locator('.process-step-list [data-process-step]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-process-step')));
      assert.equal(finalStepIds.at(-1), 'acceptance');
      assert.equal(await page.locator('.process-step-navigation button').last().isDisabled(), true);
      await page.locator('.process-step-navigation button').first().click();
      assert.equal(hash(page).get('step'), finalStepIds.at(-2));
      await page.locator('.process-step-navigation button').last().click();
      assert.equal(hash(page).get('step'), 'acceptance');
      mark(`${label}: a full-width trajectory opens the final accepted run and original targets`);

      // Switch history through controls, then follow a real dependency and filter actual archived steps.
      const otherRun = complex.record.process!.runs.find(run => run.runId !== complex.run.runId)!;
      await selectRun(page, otherRun); await selectRun(page, complex.run);
      await page.locator('.process-task-browser > summary').click();
      const task = complex.run.tasks.find(task => task.dependencies.some(id => complex.run.tasks.some(other => other.id === id)))!;
      const dependency = task.dependencies.find(id => complex.run.tasks.some(other => other.id === id))!;
      await page.locator(`.process-task-grid ${attr('data-process-task', task.id)}`).click();
      await page.locator(`.process-dependencies ${attr('data-process-task', dependency)}`).click();
      assert.equal(hash(page).get('task'), dependency);
      assert.equal(await page.locator(`.process-task-grid ${attr('data-process-task', dependency)}`).getAttribute('aria-pressed'), 'true');
      await page.locator('[data-process-filter="checks"]').click();
      const expectedTaskChecks = (complex.run.checks ?? []).filter(check => check.taskId === dependency);
      assert.deepEqual(await page.locator('.process-step-list [data-process-step^="check:"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-process-step')).sort()),
        expectedTaskChecks.map(check => `check:${check.id}`).sort());
      await page.locator('.process-task-heading [data-process-task=""]').click();
      await page.locator('[data-process-filter="decisions"]').click();
      const delivery = complex.run.deliveries!.find(item => item.summary.trim().length > 40)!;
      assert.ok(delivery);
      assert.deepEqual(await page.locator('.process-step-list [data-process-step^="delivery:"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-process-step')).sort()),
        complex.run.deliveries!.map(item => `delivery:${item.id}`).sort());
      await step(page, `delivery:${delivery.id}`).click();
      const deliveryText = (await page.locator('#process-step-detail .process-message').innerText()).trim();
      assert.ok(delivery.summary.replace(/\r\n?/gu, '\n').includes(deliveryText.replace(/…$/u, '')), 'The displayed finding must come from the selected saved delivery');
      const deepLink = page.url();
      await page.reload(); await processRoot(page).waitFor();
      assert.equal(page.url(), deepLink, 'Reload must keep the complete selected process location');
      assert.equal(await step(page, `delivery:${delivery.id}`).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('[data-process-filter="decisions"]').getAttribute('aria-pressed'), 'true');
      await fits(page, `${label}: task and delivery`);
      mark(`${label}: history, real task dependencies, checks and deliveries filter correctly and survive reload`);

      // The failed-check diagnostic and exact file are read from the same archived check.
      await selectCheck(page, failure, locale);
      assert.equal(await page.locator('[data-process-acceptance]').count(), 0, 'A failed local check must not become original-problem acceptance');
      assert.equal(await page.locator('.process-diagnostics pre').textContent(), failure.check.diagnostics);
      assert.equal(await page.locator('.process-check-scope').innerText(), failure.check.scope === 'task'
        ? locale === 'en' ? 'Task proof check' : '局部任务检查' : locale === 'en' ? 'Original problem check' : '完整原题检查');
      const source = failure.record.process!.sources![failure.check.sourceDigest!];
      await page.locator('[data-process-code="source"]').click();
      assert.equal(await page.locator('.process-code:not(.process-diff) code').textContent(), source.code);
      assert.ok((await page.locator('.process-code-digest').innerText()).includes(source.sha256));
      await page.locator('[data-process-copy-source]').click();
      assert.equal(await page.evaluate(() => (window as Window & { archiveTestClipboard?: string }).archiveTestClipboard), source.code);
      const downloading = page.waitForEvent('download'); await page.locator('[data-process-download-source]').click();
      const downloaded = await downloading, filename = await downloaded.path(); assert.ok(filename);
      const downloadedBytes = await fs.readFile(filename);
      assert.equal(downloadedBytes.toString('utf8'), source.code); assert.equal(digest(downloadedBytes), source.sha256);
      assert.ok(downloaded.suggestedFilename().includes(source.sha256.slice(0, 12)));
      await fits(page, `${label}: failed check source`);
      await page.screenshot({ path: path.join(output, `failed-check-${locale}-${width}.png`), fullPage: true });
      mark(`${label}: a real failed diagnostic and the exact checked source support correct copy and download`);

      await selectCheck(page, comparison, locale);
      await page.locator('[data-process-code="source"]').click();
      await page.locator('[data-process-code="diff"]').click();
      const before = comparison.record.process!.sources![comparison.previous.sourceDigest!].code;
      const after = comparison.record.process!.sources![comparison.check.sourceDigest!].code;
      const shown = await page.locator('.process-diff [data-diff]').evaluateAll(nodes => nodes.map(node => ({ kind: node.getAttribute('data-diff'), text: node.textContent!.slice(2) })));
      assert.ok(shown.some(row => row.kind === 'added') && shown.some(row => row.kind === 'removed'), 'Two different real versions must show additions and removals');
      for (const row of shown) assert.ok((row.kind === 'removed' ? before : after).replace(/\r\n?/gu, '\n').split('\n').includes(row.text), 'Diff rows must belong to the selected archived file versions');
      await fits(page, `${label}: saved source comparison`);
      await page.screenshot({ path: path.join(output, `comparison-${locale}-${width}.png`), fullPage: true });
      mark(`${label}: comparing two saved checks shows real changed lines from both source versions`);

      // The final proof and receipt buttons must reach the actual archived artifacts, then keep the process selection.
      await open(page, complex.record, locale);
      await page.locator('[data-process-open-tab="source"]').click();
      await page.locator('#source-file').waitFor();
      assert.equal(await page.locator('#tab-source').getAttribute('aria-selected'), 'true');
      await page.selectOption('#source-file', 'Submission.lean');
      assert.ok((await page.locator('.source-facts').innerText()).includes(complex.record.campaign!.proofSha256));
      await page.locator('#tab-process').click(); await processRoot(page).waitFor();
      await page.locator('[data-process-open-tab="evidence"]').click();
      await page.locator('[data-acceptance-receipts] > summary').click();
      assert.ok((await page.locator('.campaign-evidence').innerText()).includes(complex.record.campaign!.proofSha256));
      const receipt = await page.request.get(`${origin}/classics/data/proofs/${complex.record.id}/verification.json`, { timeout: 0 });
      assert.equal(receipt.status(), 200); assert.equal((await receipt.json()).runId, complex.record.campaign!.runId);
      await page.locator('#tab-process').click(); await processRoot(page).waitFor();
      await page.locator('[data-action="back-list"]').first().click();
      assert.equal(await page.locator('.catalog').isVisible(), true);
      assert.equal(await page.locator('.proof-row.is-selected').getAttribute('data-proof-id'), complex.record.id);
      assert.equal(hash(page).get('status'), 'verified');
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.proofId), complex.record.id);
      mark(`${label}: the final proof and acceptance evidence open real artifacts; back returns to the same problem`);

      for (const record of snaky) {
        await open(page, record, locale);
        assert.equal(await page.locator('.process-check-source .process-code').count(), 0, 'Large encoded sources stay closed by default');
        assert.ok((await processRoot(page).innerText()).length < 20_000, 'A certificate payload must not flood the reading column');
        const candidates = record.process!.runs.flatMap(run => (run.deliveries ?? []).map(delivery => ({ run, delivery })))
          .sort((a, b) => b.delivery.summary.length - a.delivery.summary.length);
        if (candidates.length) {
          await selectRun(page, candidates[0].run); await step(page, `delivery:${candidates[0].delivery.id}`).click();
          const visible = await page.locator('#process-step-detail').innerText();
          assert.ok(visible.length < 8_000 && !/\S{240}/u.test(visible), 'Loader commands and encoded payloads must not appear as the research explanation');
        }
        await fits(page, `${label}: ${record.id}`);
      }
      mark(`${label}: both Snaky records keep certificate payloads out of the default and delivery reading views`);
      assert.deepEqual(errors, []);
    } catch (error) {
      await page.screenshot({ path: path.join(output, `failure-${locale}-${width}.png`), fullPage: true });
      const overflow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('body *')].map(element => {
        const box = element.getBoundingClientRect();
        return { tag: element.tagName, id: element.id, className: String(element.className), left: box.left, right: box.right,
          width: box.width, text: element.innerText?.slice(0, 120), visible: element.checkVisibility() };
      }).filter(element => element.visible && (element.left < -1 || element.right > innerWidth + 1)).slice(0, 40));
      await fs.writeFile(path.join(output, `failure-${locale}-${width}.json`), JSON.stringify({ label, url: page.url(), overflow }, null, 2) + '\n');
      throw error;
    } finally { await context.close(); active = undefined; }
  }

  // Check every problem through HTTP, including its data and accepted final run, rather than only representative UI fixtures.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
  await observe(context, 'all records');
  const page = await context.newPage(); active = page;
  for (const record of catalog.records) {
    current = `all records: ${record.id}`;
    await open(page, record, 'zh');
    assert.equal(await page.locator('.process-run-nav [data-process-run]').count(), record.process!.runs.length);
    assert.equal(await processRoot(page).getAttribute('data-process-run-id'), record.campaign!.runId);
    const final = record.process!.runs.find(run => run.runId === record.campaign!.runId)!;
    assert.equal(await page.locator('.process-step-list [data-process-step^="check:"]').count(), final.checks!.length);
    assert.equal(await page.locator('.process-step-list [data-process-step^="delivery:"]').count(), final.deliveries!.length);
    assert.ok(final.checks?.some(check => check.scope === 'original' && check.status === 'kernel_verified'), 'The accepted final run must retain an original-problem check');
    const response = await page.request.get(`${origin}/classics/data/proofs/${record.id}/process.json`, { timeout: 0 });
    const { walkthrough: _walkthrough, ...nativeProcess } = record.process!;
    assert.equal(response.status(), 200); assert.deepEqual(await response.json(), nativeProcess);
  }
  await context.close(); active = undefined;
  mark(`all ${catalog.records.length} accepted problems open their own final run and complete original process JSON`);
  assert.equal(runnerCalls, 0); assert.deepEqual(writes, []); assert.deepEqual(apiReads, []); assert.deepEqual(external, []); assert.deepEqual(errors, []);
  const screenshots = ['zh', 'en'].flatMap(locale => [1440, 390, 320].flatMap(width =>
    ['acceptance', 'failed-check', 'comparison'].map(kind => `${kind}-${locale}-${width}.png`)));
  const report = { status: 'passed', checkedAt: new Date().toISOString(), checks, records: catalog.records.length,
    sourceCount, savedChecks, deliveries, screenshots, paidModelCalls: false, runnerCalls, leanProcesses: 0, writes, apiReads, external, errors,
    failureExample: { record: failure.record.id, run: failure.run.runId, check: failure.check.id },
    comparisonExample: { record: comparison.record.id, run: comparison.run.runId, before: comparison.previous.id, after: comparison.check.id } };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Archive process passed ${checks.length} checks; ${sourceCount} exact files; no model, Lean, email or research calls.`);
} catch (error) {
  await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', checkedAt: new Date().toISOString(),
    current, error: error instanceof Error ? error.message : String(error), checks, paidModelCalls: false, runnerCalls, writes, apiReads, errors }, null, 2) + '\n');
  throw error;
} finally {
  await browser?.close(); await service.close(); await fs.rm(data, { recursive: true, force: true });
}
