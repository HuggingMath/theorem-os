#!/usr/bin/env bun
// Real HTTP archives and UI resubmission with a disposable local runner; no model or Lean.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput } from '../apps/web/shared';
import { freePort, postRun, ready, startBrowser, waitForRun } from './web-scenario';
import { closeDialog, closeSettings, openSettings, showChat } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/frontend-round8/budget');
await fs.access(path.join(staticRoot, 'app.js'));
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round8-budget-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const credential = 'sk-disposable-round8-budget-fixture';
const checks: object[] = [], errors: string[] = [], external: string[] = [];
const starts: Array<{ id: string; maxTotalTokens?: number }> = [];
const runner: WebRunner = {
  async readiness() { return { ready: true, nativeTeam: true, message: 'Disposable budget regression fixture' }; },
  async run(input, send) {
    starts.push({ id: input.id, ...(input.input.maxTotalTokens !== undefined ? { maxTotalTokens: input.input.maxTotalTokens } : {}) });
    send({ type: 'result', result: { status: 'incomplete', proof: '', report: { localBudgetFixture: true } } });
  },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot,
  THEOREMOS_WEB_PROVIDERS: JSON.stringify([{ id: 'openai', name: 'Fixture provider', baseUrl: 'https://example.invalid/v1' }]),
}), runner, { sample: null });
let browser: Browser | undefined, active: Page | undefined, phase = 'setup', failure: unknown;
const caps: Array<number | undefined> = [10_000, 20_000, 15_000, 10_003, 100_000_000, undefined];
const finished = (run: { status: string }) => ['completed', 'error'].includes(run.status);
const mark = (check: object) => { checks.push(check); console.log(`PASS ${phase}`); };

async function importJson(page: Page, value: unknown, name: string) {
  await showChat(page);
  await page.locator('#task-file').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
  await page.locator('#import-task-dialog[open]').waitFor();
}
async function confirmImport(page: Page) {
  await closeDialog(page, '#import-task-dialog', () => page.locator('#confirm-import').click());
  await page.locator('#run-settings[open]').waitFor();
}

try {
  browser = await startBrowser(service.server, port);
  for (const [locale, width, operation] of [['zh', 1440, 'download'], ['en', 390, 'snapshot']] as const) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: 'reduce', locale: locale === 'zh' ? 'zh-CN' : 'en-US' });
    await context.addInitScript(locale => { try { localStorage.setItem('theorem-os.locale.v1', locale); } catch { /* about:blank has no storage. */ } }, locale);
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    const page = active = await context.newPage(); page.setDefaultTimeout(12_000);
    page.on('pageerror', error => errors.push(`${phase}: ${error.message}`));
    try {
      await page.goto(origin); await ready(page);
      for (const cap of caps) {
        phase = `${locale}/${width}/${operation}/${cap ?? 'unlimited'}`;
        const input: WebRunInput = { providerId: 'openai', apiKey: credential, model: 'fixture-budget-model', effort: 'low',
          environment: 'standard', source: 'theorem budget_fixture : True := by\n  sorry\n', task: `Budget roundtrip ${cap ?? 'unlimited'}`,
          maxTurns: 2, maxRunSeconds: 60, workers: 1, coordination: 'cooperative',
          ...(cap === undefined ? {} : { maxTotalTokens: cap }) };
        const seed = await postRun({ page }, input, 'Budget source');
        await waitForRun({ page }, seed.id, finished);
        const response = await context.request.get(`${origin}/api/runs/${seed.id}/${operation}`);
        assert.equal(response.status(), 200);
        const archive = await response.json();
        // The server persists omitted budgets as zero, the explicit unlimited value.
        assert.equal(archive.run.maxTotalTokens, cap ?? 0);
        assert.equal(archive.schema, operation === 'download' ? 'theorem-os.web-archive.v2' : 'theorem-os.web-export.v1');
        await fs.writeFile(path.join(output, `${locale}-source-${cap ?? 'unlimited'}.json`), JSON.stringify(archive, null, 2) + '\n');

        await importJson(page, archive, `${locale}-real-${operation}-${cap ?? 'unlimited'}.json`);
        const facts = await page.locator('#import-facts').innerText();
        if (cap === 10_003) await page.screenshot({ path: path.join(output, `${locale}-fractional-import-${width}.png`) });
        await confirmImport(page);
        const units = cap === undefined ? '' : String(cap / 10_000);
        assert.equal(await page.locator('#max-tokens').inputValue(), units);
        assert.equal(await page.locator('#max-tokens').evaluate(input => (input as HTMLInputElement).validity.stepMismatch), false);
        assert.equal(await page.locator('#source').inputValue(), archive.run.source);

        // A normal draft stores UI units. Export/import it as well to catch double conversion.
        await closeSettings(page); await showChat(page);
        const downloading = page.waitForEvent('download');
        await page.locator('#export-draft').click();
        const ordinary = JSON.parse(await fs.readFile((await (await downloading).path())!, 'utf8'));
        assert.equal(ordinary.schema, 'theorem-os.web-draft.v1');
        assert.equal(ordinary.draft.maxTotalTokens, cap === undefined ? undefined : units);
        await importJson(page, ordinary, 'ordinary-draft-roundtrip.json'); await confirmImport(page);
        assert.equal(await page.locator('#max-tokens').inputValue(), units);
        await page.locator('#api-key').fill(credential);
        const submitted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs');
        await page.locator('#settings-submit').click();
        const created = await submitted; assert.equal(created.status(), 201);
        const posted = created.request().postDataJSON() as WebRunInput;
        assert.equal(posted.maxTotalTokens, cap);
        const { run } = await created.json();
        await waitForRun({ page }, run.id, finished);
        assert.equal(starts.find(item => item.id === run.id)?.maxTotalTokens, cap ?? 0);
        await page.locator('body[data-view="run"]').waitFor({ state: 'attached' });
        const storage = await page.evaluate(() => JSON.stringify(sessionStorage) + JSON.stringify(localStorage));
        assert.equal(storage.includes(credential), false);
        mark({ locale, width, source: { method: 'GET', path: `/api/runs/${seed.id}/${operation}`, schema: archive.schema, maxTotalTokens: archive.run.maxTotalTokens },
          importedUnits: units, ordinaryDraftUnits: ordinary.draft.maxTotalTokens ?? null, postedTokens: posted.maxTotalTokens ?? null,
          runnerTokens: starts.find(item => item.id === run.id)?.maxTotalTokens ?? null, facts });
      }

      phase = `${locale}/${width}/reject-partial-token`;
      await showChat(page);
      await page.locator('#source').fill('theorem budget_precision_fixture : True := by\n  sorry');
      await page.locator('#task').fill('Reject a fractional token without starting research.');
      await openSettings(page);
      await page.locator('#max-tokens').fill('1.00001'); await page.locator('#api-key').fill(credential);
      const before = starts.length;
      await page.locator('#settings-submit').click(); await page.locator('#max-tokens[aria-invalid="true"]').waitFor();
      const message = await page.locator('#max-tokens-validation').innerText();
      assert.match(message, locale === 'zh' ? /最多 4 位小数/u : /up to 4 decimal places/u);
      assert.equal(starts.length, before);
      await page.screenshot({ path: path.join(output, `${locale}-reject-partial-token-${width}.png`) });
      mark({ locale, width, partialTokenRejected: true, message });
    } catch (error) {
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert.equal(starts.length, caps.length * 4, 'Each scenario starts only its source and explicit resubmission fixtures');
} catch (error) {
  failure = error; console.error(error);
  await active?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  const report = { status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(), staticRoot,
    mode: 'Real loopback HTTP and Chromium with disposable data and an immediate fixture runner; no model, Lean, Docker or external calls.',
    checks, fixtureRuns: starts.length, errors, external, temporaryDataRemoved: true,
    ...(failure ? { failedScenario: phase, error: failure instanceof Error ? failure.stack : String(failure) } : {}) };
  assert.equal(JSON.stringify(report).includes(credential), false);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
