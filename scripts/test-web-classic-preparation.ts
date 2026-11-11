#!/usr/bin/env bun
// Disposable localhost data only. Browsing and preparing must never invoke a model, Lean or mail.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { localeStorageKey } from '../apps/web/i18n';
import { loadClassicPreparation } from '../apps/web/client/classicPreparation';
import { taskDraftStorageKey, type TaskDraft } from '../apps/web/client/draft';
import { draftOwnerStorageKey, researchEntryStorageKey } from '../apps/web/client/ownedDrafts';
import type { ArchiveIndex } from '../docs/web/types';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-gaps-fix/classics');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-classic-preparation-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let prohibited = 0, recordedPrechecks = 0;
const forbidden = () => { prohibited++; throw new Error('No model, Lean or mail calls are allowed'); };
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: data }), {
  async readiness() { return { ready: true, message: 'Recorded preparation fixture' }; },
  async run() { forbidden(); },
  async check() {
    recordedPrechecks++;
    return { output: JSON.stringify({ severity: 'warning', kind: 'hasSorry', data: "declaration uses 'sorry'", pos: { line: 1, column: 0 } }), exitCode: 0, timedOut: false };
  },
  async formalize() { forbidden(); },
}, { sample: null, mailer: async () => { forbidden(); } });
const browser = await startBrowser(service.server, port);
const errors: string[] = [], external: string[] = [], checks: object[] = [];
let active: Page | undefined, phase = 'all-originals', failure: unknown;
try {
  const index = JSON.parse(await fs.readFile(path.join(staticRoot, 'classics/data/index.json'), 'utf8')) as ArchiveIndex;
  for (const record of index.records) {
    const prepared = await loadClassicPreparation(record.id, 'zh', (input, init) => fetch(new URL(String(input), `${origin}/`), init));
    const original = await fs.readFile(path.join(staticRoot, 'classics/data/proofs', record.id, 'Challenge.lean'), 'utf8');
    assert.equal(prepared.source, original);
    assert.equal(prepared.origin.sourceSha256, record.sources.find(source => source.name === 'Challenge.lean')!.sha256);
    assert.ok(record.campaign?.targets.every(target => prepared.task.includes(target)));
    checks.push({ id: 'every-classic-has-exact-original-preparation', record: record.id });
  }
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const record = language === 'zh' ? index.records[0]! : [...index.records].sort((a, b) =>
      (b.sources.find(source => source.name === 'Challenge.lean')?.lines ?? 0) - (a.sources.find(source => source.name === 'Challenge.lean')?.lines ?? 0))[0]!;
    const source = await fs.readFile(path.join(staticRoot, 'classics/data/proofs', record.id, 'Challenge.lean'), 'utf8');
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ key, language }) => localStorage.setItem(key, language), { key: localeStorageKey, language });
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    phase = `${language}-existing-drafts`;
    await page.goto(`${origin}/?lang=${language}`); await page.locator('#formalize-original').waitFor();
    const natural = `My independent natural-language problem (${language})`;
    await page.locator('#formalize-original').fill(natural);
    const old: TaskDraft = { providerId: 'deepseek', model: 'preserve-my-model', source: 'theorem preserved (n : Nat) : n = n := by\n  sorry\n',
      task: 'Preserve my unrelated Lean problem.', maxTurns: '10', maxRunSeconds: '600', maxTotalTokens: '3', workers: '1',
      effort: 'high', environment: 'standard', coordination: 'independent', templateId: '' };
    await page.evaluate(async ({ old, ownerKey, draftKey, entryKey }) => {
      const session = await (await fetch('/api/session')).json();
      old.providerId = session.providers[0].id;
      sessionStorage.setItem(ownerKey, session.draftOwner ?? session.csrfToken);
      sessionStorage.setItem(draftKey, JSON.stringify({ schema: draftKey, draft: old }));
      sessionStorage.setItem(entryKey, 'lean');
    }, { old, ownerKey: draftOwnerStorageKey, draftKey: taskDraftStorageKey, entryKey: researchEntryStorageKey });
    phase = `${language}-preview`;
    await page.goto(`${origin}/?fromClassic=${record.id}&lang=${language}`);
    await page.locator('[data-classic-preview]').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('fromClassic'), record.id);
    assert.equal(await page.locator('#source').inputValue(), old.source);
    assert.equal(await page.locator('#formalize-original').inputValue(), natural);
    assert.equal(await page.locator('[data-classic-preview]').evaluate(element => (element as HTMLDetailsElement).open), false);
    await page.reload(); await page.locator('[data-classic-preview]').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('fromClassic'), record.id);
    assert.equal(await page.locator('#source').inputValue(), old.source);
    const back = await page.locator('[data-classic-origin] > a').getAttribute('href');
    assert.ok(back?.includes(record.id));
    await page.locator('[data-classic-preview] > summary').click();
    assert.equal(await page.locator('.classic-preparation-source').textContent(), source);
    await page.screenshot({ path: path.join(output, `preview-${language}.png`), fullPage: true });
    phase = `${language}-explicit-prepare`;
    await page.locator('[data-classic-confirm]').click();
    await page.locator('[data-classic-ready=true]').waitFor();
    await page.waitForFunction(() => document.body.dataset.entry === 'lean');
    assert.equal(await page.locator('#source').inputValue(), source);
    assert.equal(await page.locator('#model').inputValue(), old.model);
    assert.ok((await page.locator('#task').inputValue()).includes(record.campaign!.targets[0]!));
    const edited = `${source}\n-- My independent question edit ${language}\n`;
    await page.locator('#source').fill(edited);
    await page.waitForFunction(key => sessionStorage.getItem(key)?.includes('My independent question edit'), taskDraftStorageKey);
    phase = `${language}-reload`;
    await page.reload(); await page.locator('[data-classic-ready=true]').waitFor();
    await page.waitForFunction(() => document.body.dataset.entry === 'lean');
    assert.equal(await page.locator('#source').inputValue(), edited);
    assert.equal(new URL(page.url()).searchParams.get('fromClassic'), record.id);
    assert.equal(await page.locator('[data-classic-origin] > a').getAttribute('href'), back);
    assert.equal(await page.locator('#formalize-original').inputValue(), natural);
    const widthCheck = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, expected: innerWidth }));
    assert.ok(widthCheck.actual <= widthCheck.expected, JSON.stringify(widthCheck));
    await page.screenshot({ path: path.join(output, `prepared-reloaded-${language}.png`), fullPage: true });
    phase = `${language}-undo`;
    await page.locator('#restore-draft').click();
    assert.equal(await page.locator('#source').inputValue(), old.source);
    assert.equal(await page.locator('#task').inputValue(), old.task);
    assert.equal(new URL(page.url()).searchParams.get('fromClassic'), null);
    assert.equal(await page.locator('[data-classic-origin]').count(), 0);
    assert.equal((await (await page.request.get(`${origin}/api/runs`)).json()).runs.length, 0);
    checks.push({ id: 'interactive-preview-confirm-reload-and-undo', language, width, record: record.id, sourceBytes: new TextEncoder().encode(source).length, originalCopied: true,
      existingLeanRecovered: true, naturalDraftPreserved: true, sourceAndReturnLinkRetained: true, modelsNotStarted: true });
    await context.close();
  }
  assert.equal(prohibited, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) {
  failure = error;
  if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, errors, external, prohibited, recordedPrechecks,
    realLeanCalls: 0, realModelCalls: 0,
    ...(failure ? { error: String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(data, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Classic preparation: ${checks.length} checks passed`);
