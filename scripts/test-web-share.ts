#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebRun, WebRunInput } from '../apps/web/shared';
import { selectHistoryRun } from './web-ui-controls';
import { audit } from './web-a11y';
import { freePort, postRun, readRun, settled, startBrowser, ready } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-ui-smoke');
await fs.access(path.join(root, 'out/web/share.js')).catch(() => { throw new Error('Run bun run build:web before the share check.'); });
await fs.mkdir(output, { recursive: true });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const credential = 'sk-theoremos-share-fixture';
const proof = 'theorem fixture : True := by\n  trivial\n';
const runner: WebRunner = {
  async readiness() { return { ready: true, message: '本地分享验证环境' }; },
  async run(input, send) {
    if (input.input.task === 'rejected') { send({ type: 'result', result: { status: 'evaluated_failed', proof, report: {} } }); return; }
    send({ type: 'result', result: { status: 'evaluated_passed', proof, report: { turns: 2, solveWallMs: 31_000, usage: { totalTokens: 48_000 },
      reason: 'PRIVATE-REASON', runId: 'PRIVATE-SOLVER-RUN',
      environment: { toolchain: 'leanprover/lean4:v4.33.0', mathlibRevision: 'f'.repeat(40) },
      candidateCheck: { passed: true, results: [{ theoremName: 'fixture', status: 'kernel_verified', stderrPreview: 'PRIVATE-DIAGNOSTIC' }] },
      evaluator: { status: 'passed', method: 'host-lean-kernel-all-targets',
        verification: { sourceDigest: 'e'.repeat(64), verification: { results: [{ theoremName: 'fixture', status: 'kernel_verified' }] } } } } } });
  },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), runner);
const input = (task: string): WebRunInput => ({ providerId: 'openai', apiKey: credential, model: 'deepseek-flash',
  effort: 'max', environment: 'standard', source: 'theorem fixture : True := by\n  sorry\n', task,
  maxTurns: 4, maxRunSeconds: 120, workers: 2, coordination: 'cooperative' });
const mark = (check: string) => console.log(`PASS ${check}`);
async function finished(page: Page, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = await readRun({ page }, id);
    if (run.status === 'completed') return run;
    await page.waitForTimeout(50);
  }
  throw new Error(`Run ${id} did not finish`);
}
async function open(page: Page, id: string) {
  await page.reload();
  await ready(page);
  await selectHistoryRun(page, id);
}
let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
try {
  browser = await startBrowser(service.server, port);
  const owner = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await owner.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await owner.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(origin);
  await ready(page);

  const rejected: WebRun = await postRun({ page }, input('rejected'));
  await finished(page, rejected.id);
  await open(page, rejected.id);
  assert.equal(await page.locator('[data-action="share-run"]').count(), 0, 'Only accepted runs offer a share link');
  const accepted: WebRun = await postRun({ page }, input('accepted'));
  await finished(page, accepted.id);
  await open(page, accepted.id);
  await page.locator('[data-action="share-run"]').click();
  await page.locator('#share-dialog[open]').waitFor();
  await page.locator('#create-share:enabled').waitFor();
  assert.match(await page.locator('#share-dialog').innerText(), /不会公开[\s\S]*API Key/u);
  await settled(page);
  assert.deepEqual(await audit(page, { scope: '#share-dialog' }), [], 'Share dialog accessibility');
  await page.screenshot({ path: path.join(output, 'share-dialog-1440.png') });
  await page.locator('#create-share').click();
  await page.locator('#share-link-row:not([hidden])').waitFor();
  const url = await page.locator('#share-url').inputValue();
  assert.match(url, new RegExp(`^${origin}/share\\.html#[A-Za-z0-9_-]{32}$`, 'u'));
  await page.locator('#copy-share').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), url);
  mark('an accepted run creates a share link after listing what becomes public, and the link copies');

  // A visitor with no cookies sees the snapshot and never receives a session.
  const visitor = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const reader = await visitor.newPage();
  reader.on('pageerror', error => errors.push(error.message));
  await reader.goto(url);
  await reader.locator('#share-content:not([hidden])').waitFor();
  const text = await reader.locator('body').innerText();
  assert.match(text, /完整原题通过独立 Lean 验收/u);
  assert.match(text, /Lean 内核 · 全部目标/u);
  assert.equal(await reader.locator('#share-code').textContent(), proof);
  for (const secret of [credential, 'PRIVATE', accepted.id]) assert.ok(!text.includes(secret), `Share page shows ${secret}`);
  assert.deepEqual(await visitor.cookies(), []);
  assert.equal(await reader.locator('meta[name="robots"]').getAttribute('content'), 'noindex, nofollow');
  await reader.locator('[data-share-view="source"]').click();
  assert.match(await reader.locator('#share-code').innerText(), /sorry/u);
  // Both downloads are named after the theorem, like the workbench's; the original problem says so.
  for (const [view, name] of [['source', 'fixture-problem.lean'], ['proof', 'fixture.lean']] as const) {
    await reader.locator(`[data-share-view="${view}"]`).click();
    const [file] = await Promise.all([reader.waitForEvent('download'), reader.locator('#share-download').click()]);
    assert.equal(file.suggestedFilename(), name);
  }
  await reader.locator('[data-share-view="source"]').click();
  assert.deepEqual(await audit(reader), [], 'Share page accessibility');
  await reader.screenshot({ path: path.join(output, 'share-page-1440.png'), fullPage: true });
  for (const width of [375, 320]) {
    await reader.setViewportSize({ width, height: 760 });
    await settled(reader);
    assert.ok(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Share page overflows at ${width}px`);
  }
  await reader.screenshot({ path: path.join(output, 'share-page-320.png'), fullPage: true });
  mark('a signed-out visitor reads the proof, source and checks without private fields, cookies or overflow');

  await page.locator('#stop-share').click();
  await page.locator('#create-share:not([hidden])').waitFor();
  await reader.reload();
  await reader.locator('#share-missing:not([hidden])').waitFor();
  await reader.goto(`${origin}/share.html#short`);
  await reader.locator('#share-missing-text', { hasText: '链接不完整' }).waitFor();
  mark('stopping the share ends the link at once, and a damaged link explains itself');
  assert.deepEqual(errors.filter(message => !/status of 404/u.test(message)), []);
  console.log('Share checks passed: eligibility, dialog, copy, signed-out view, private fields, narrow layout and revocation.');
} finally {
  await browser?.close();
  await service.close();
}
