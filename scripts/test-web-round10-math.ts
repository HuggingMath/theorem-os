#!/usr/bin/env bun
// Presentation fixtures only: no model, Lean process or newly established mathematical acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Locator } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { shareSnapshot } from '../apps/web/share';
import { localeStorageKey, translator } from '../apps/web/i18n';
import type { WebFormalizationReport } from '../apps/web/shared';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { freePort, postRun, readRun, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_ROUND10_MATH_OUTPUT || path.join(root, 'out/web-round10-math');
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round10-math-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const source = 'theorem addition (n : Nat) : n + 0 = n := by\n  sorry\n', proof = source.replace('sorry', 'rfl');
const original = '对任意自然数 $n$，证明 $n + 0 = n$。\n\n$$\\forall n\\in\\mathbb{N},\\quad n+0=n.$$';
const unsupported = String.raw`$\unsupportedRoundTenCommand{x}$`;
const unsafe = '<img src=x onerror="window.roundTenInjected=true">';
const results: object[] = [], errors: string[] = [], external: string[] = [];
let controlledRuns = 0, failure: unknown;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: data }), {
  async readiness() { return { ready: true, message: 'Round10 mathematics reading fixture' }; },
  async run(_input, send) {
    controlledRuns++;
    send({ type: 'result', result: { status: 'evaluated_passed', proof,
      report: { fixture: true, candidateCheck: { passed: true, results: [{ theoremName: 'addition', status: 'kernel_verified' }] },
        evaluator: { status: 'passed', method: 'host-lean-kernel-all-targets', verification: { sourceDigest: 'a'.repeat(64),
          verification: { results: [{ theoremName: 'addition', status: 'kernel_verified' }] } } } } } });
  },
}, { sample: null });
const browser = await startBrowser(service.server, port);
async function readyMath(scope: Locator, minimum: number) {
  await scope.locator('.math').first().waitFor();
  await scope.locator('.math').evaluateAll(async formulas => {
    const until = performance.now() + 10_000;
    while (formulas.some(formula => !['ready', 'source'].includes((formula as HTMLElement).dataset.mathState ?? ''))) {
      if (performance.now() > until) throw new Error('Formula rendering did not settle');
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  });
  const rendered = await scope.locator('.math[data-math-state="ready"] math').count();
  assert.ok(rendered >= minimum, `Expected ${minimum} rendered formulas, got ${rendered}`);
  return rendered;
}
try {
  for (const [locale, width] of [['zh', 1440], ['zh', 390], ['en', 390]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(([key, locale]) => localStorage.setItem(key, locale), [localeStorageKey, locale]);
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000); page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(origin); await page.locator('#formalize-original').waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'), locale === 'zh' ? 'zh-CN' : 'en-US');
      const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
      const started = await postRun({ page }, { providerId: 'openai', model: 'fixture', apiKey: 'sk-local-round10-math', effort: 'low', environment: 'standard',
        source, task: 'Mathematics reading fixture', maxTurns: 2, maxRunSeconds: 120, workers: 1, coordination: 'cooperative' });
      let run = await readRun({ page }, started.id);
      for (let attempt = 0; run.status !== 'completed' && attempt < 100; attempt++) { await page.waitForTimeout(20); run = await readRun({ page }, started.id); }
      assert.equal(run.result?.status, 'evaluated_passed');
      const at = new Date().toISOString(), formalId = crypto.randomUUID();
      const binding = { id: formalId, original, evidenceSha256: 'b'.repeat(64), confirmedAt: at, confirmation: 'manual' as const };
      const owned = service.jobs.get(owner, run.id)!; owned.formalization = binding; service.storage.saveRun(owner, owned);
      // A complete view fixture lets this test cover every prose consumer without a real formalization job.
      const report: WebFormalizationReport = { schema: 'theorem-os.web-formalization-report.v1', problemId: formalId, original, statement: source,
        environment: 'standard', toolchain: 'fixture', mathlibRevision: null, targets: [{ name: 'addition', lines: { start: 1, end: 2 } }],
        backtranslation: { mathematics: 'For every natural number $n$, $n + 0 = n$.', assumptions: ['$n \\in \\mathbb{N}$'],
          definitions: ['Let $f(n) = n + 0$.'], targets: [{ name: 'addition', mathematics: '$n+0=n$' }] },
        correspondences: [{ aspect: 'conclusions', relation: 'direct', original: '$n + 0 = n$', originalStart: original.indexOf('$n + 0'),
          originalEnd: original.indexOf('$n + 0') + '$n + 0 = n$'.length, leanText: 'n + 0 = n', lean: [{ line: 1, start: 31, end: 40 }],
          reviewers: 2, explanations: ['The equality is $n + 0 = n$.', `${unsupported}\n${unsafe}`] }],
        coverage: [], reviews: [], model: 'fixture', effort: 'low', rounds: 1, evidenceSha256: binding.evidenceSha256, approvedAt: at };
      await page.route(`${origin}/api/formalizations/${formalId}`, route => route.fulfill({ json: { formalization: { id: formalId, original,
        environment: 'standard', model: 'fixture', effort: 'low', status: 'confirmed', createdAt: at, updatedAt: at,
        confirmedAt: at, confirmation: 'manual', runId: run.id, report } } }));
      const snapshot = shareSnapshot({ ...run, formalization: binding })!;
      snapshot.formalization!.review = { backtranslation: report.backtranslation, correspondences: report.correspondences };
      const shareToken = crypto.randomUUID().replaceAll('-', '');
      service.storage.saveShare(owner, run.id, { token: shareToken, createdAt: at, snapshot });
      const chatId = crypto.randomUUID();
      service.storage.saveRecord(['owners', mathDigest(owner), 'conversations', `${chatId}.json`], { id: chatId, formalizationId: formalId, runId: run.id,
        title: 'Mathematics reading fixture', createdAt: at, updatedAt: at, messages: [
          { id: crypto.randomUUID(), role: 'user', kind: 'text', text: original, createdAt: at, status: 'complete' },
          { id: crypto.randomUUID(), role: 'assistant', kind: 'task', text: '', createdAt: at, status: 'complete' }] });
      await page.goto(`${origin}/?chat=${chatId}`); await page.locator(`[data-conversation="${chatId}"]`).waitFor();
      const messageMath = await readyMath(page.locator(`[data-conversation="${chatId}"] .chat-message-content`).first(), 3);
      await page.locator('[data-research-artifact="original"]').first().click();
      const panel = page.locator('#chat-original-panel');
      const originalMath = await readyMath(panel.locator('.chat-original-columns .chat-message-text').first(), 3);
      const translationMath = await readyMath(panel.locator('.chat-backtranslation'), 4);
      const correspondenceMath = await readyMath(panel.locator('.chat-correspondences'), 2);
      assert.equal(await panel.locator('.chat-correspondences .math[data-math-state="source"]').innerText(), unsupported.slice(1, -1));
      assert.equal(await panel.locator('img').count(), 0); assert.ok((await panel.innerText()).includes(unsafe));
      assert.equal(await panel.locator('pre code').first().textContent(), source);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(output, `original-math-${locale}-${width}.png`), fullPage: true });
      await page.goto(`${origin}/share.html#${shareToken}`); await page.locator('#share-content:not([hidden])').waitFor();
      assert.equal(await page.locator('#share-task-heading').innerText(), translator(locale)('自然语言原题'));
      await page.locator('#share-review > summary').click();
      const shareOriginalMath = await readyMath(page.locator('#share-task'), 3);
      const shareTranslationMath = await readyMath(page.locator('#share-backtranslation'), 4);
      const shareCorrespondenceMath = await readyMath(page.locator('#share-correspondences'), 2);
      assert.equal(await page.locator('#share-correspondences .math[data-math-state="source"]').innerText(), unsupported.slice(1, -1));
      assert.equal(await page.locator('#share-content img').count(), 0);
      assert.equal(await page.evaluate(() => Boolean((window as unknown as { roundTenInjected?: boolean }).roundTenInjected)), false);
      assert.equal(await page.locator('#share-code').textContent(), proof);
      for (const view of ['proof', 'source'] as const) {
        await page.locator(`[data-share-view="${view}"]`).click();
        const [file] = await Promise.all([page.waitForEvent('download'), page.locator('#share-download').click()]);
        assert.equal(await fs.readFile((await file.path())!, 'utf8'), view === 'proof' ? run.result!.proof : run.source);
      }
      await page.locator('[data-share-view="proof"]').click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(output, `share-math-${locale}-${width}.png`), fullPage: true });
      const stored = (await page.request.get(`${origin}/api/share/${shareToken}`));
      assert.equal((await stored.json()).share.formalization.original, original, 'Original data keeps exact TeX');
      results.push({ locale, width, messageMath, originalMath, translationMath, correspondenceMath, shareOriginalMath, shareTranslationMath,
        shareCorrespondenceMath, unsupportedFormulaReadable: true, noHtmlExecution: true, rawOriginalPreserved: true, leanDownloadsExact: true, overflow: false });
      console.log(`PASS mathematics reading and sharing ${locale} ${width}px`);
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) { failure = String(error); throw error; }
finally {
  await browser.close(); await service.close(); await fs.rm(data, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', results, errors, external,
    controlledRuns, realModels: 0, realLean: 0, externalMail: 0, productionWrites: 0, fixturesRemoved: true, mathematicalAcceptance: 'not-assessed', failure }, null, 2) + '\n');
}
