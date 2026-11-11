#!/usr/bin/env bun
// Disposable localhost regression fixtures. Checks are recorded responses; no models, Lean or mail.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebResearchCollections } from '../apps/web/researchCollections';
import { researchMathExampleValidator } from '../apps/web/researchMathExamples';
import type { ResearchMathUsage } from '../apps/web/researchAssetTypes';
import type { ResearchReleaseComparison } from '../apps/web/researchReleaseComparison';
import type { WebRunner } from '../apps/web/runner';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { localeStorageKey } from '../apps/web/i18n';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/library-product-gaps');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.access(path.join(staticRoot, 'library.html')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-library-product-gaps-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let prohibited = 0, recordedChecks = 0, phase = 'setup', failure: unknown, active: Page | undefined;
const forbid = async () => { prohibited++; throw new Error('Runtime, model and mail calls are forbidden'); };
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Disposable library fixtures' }; }, run: forbid, check: forbid, command: forbid, formalize: forbid };
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner, { sample: null, mailer: forbid });
const baseSource = 'namespace Shared\ntheorem zero (n : Nat) : n + 0 = n := by simp\nend Shared\n';
let moduleSource = baseSource, commit = 'a'.repeat(40);
const assets = new WebResearchAssets(service.storage, { identity: owner => service.research.projects.identity(owner),
  async resolveMathematics() { return { environment: 'standard', environmentDigest: getLeanTaskEnvironment('standard').dependencyDigest,
    declarations: [{ name: 'Shared.zero', type: '(n : Nat) : n + 0 = n', file: 'Submission/Library/Shared.lean' }],
    pack: { schema: 'theorem-os.library-pack.v1', modules: [{ file: 'Submission/Library/Shared.lean', source: moduleSource,
      origin: { kind: 'run', runId: 'recorded-publication-fixture', commit, file: 'Main.lean' } }] } }; },
  async validateMathematics() { recordedChecks++; return { passed: true, receiptRefs: ['recorded-publication-check'] }; },
  validateMathematicsExample: researchMathExampleValidator(service.storage, { ...runner, async check(input) {
    recordedChecks++; return { output: '', exitCode: 0, timedOut: false, checkedTarget: input.candidateTarget?.name };
  } }),
});
const collections = new WebResearchCollections({ storage: service.storage, projects: service.research.projects, assets: service.research.assets });
const browser = await startBrowser(service.server, port), checks: object[] = [], errors: string[] = [], external: string[] = [];
const reply = (page: Page, method: string, pathname: string) => page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === pathname);
async function publish(author: string, id: string, version: string) {
  const asset = assets.get(author, id), preview = await assets.preview(author, id);
  const queued = await assets.publish(author, id, { requestId: `publish-${id}-${version}`, expectedRevision: asset.revision,
    previewDigest: preview.previewDigest, version, license: 'MIT', visibility: 'public' });
  const result = await assets.waitForPublication(author, queued.id); assert.equal(result.status, 'completed', result.reason);
  return assets.release(author, id, version);
}
const usage = (updated: boolean): ResearchMathUsage => ({ conditions: updated ? 'Locate the $n + 0$ subexpression before rewriting.' : 'For $n \\in \\mathbb{N}$.',
  result: updated ? 'Directly establishes $n + 0 = n$.' : 'Eliminates the right additive identity $0$.',
  examples: [{ id: 'addition', title: updated ? 'Match the current goal' : 'Call the addition lemma', declaration: 'Shared.zero',
    type: updated ? '∀ (n : Nat), n + 0 = n' : '∀ n : Nat, n + 0 = n',
    proof: updated ? 'by\n  intro n\n  simpa using (Shared.zero n)' : 'by\n  intro n\n  exact Shared.zero n',
    argumentNotes: updated ? 'Choose `n`, then pass `Shared.zero n` to `simpa using`.' : 'Pass the natural number `n`.' }] });
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const tx = (zh: string, en: string) => language === 'zh' ? zh : en, suffix = `${language}-${width}`;
    phase = `setup-${suffix}`; moduleSource = baseSource; commit = 'a'.repeat(40);
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ key, language }) => localStorage.setItem(key, language), { key: localeStorageKey, language });
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/library.html?collection=shared'); await page.getByRole('heading', { name: tx('数学库', 'Library'), exact: true }).waitFor();
    const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value, author = `fixture-library-author-${language}`;
    const source = { kind: 'run' as const, runId: 'recorded-publication-fixture', commit };
    const asset = assets.create(author, { requestId: `create-${suffix}`, type: 'mathematics', name: 'Addition usage', content: { source, usage: usage(false) } });
    const v1 = await publish(author, asset.id, 'v1'), target = { kind: 'release' as const, assetId: asset.id, version: 'v1', digest: v1.digest };
    const a = collections.create(owner, { requestId: `collection-a-${suffix}`, title: 'Collection A' });
    const b = collections.create(owner, { requestId: `collection-b-${suffix}`, title: 'Collection B' });
    collections.saveItem(owner, a.id, { requestId: `seed-a-${suffix}`, expectedRevision: a.revision, target, note: 'A: original private note.' });
    collections.saveItem(owner, b.id, { requestId: `seed-b-${suffix}`, expectedRevision: b.revision, target, note: 'B: important human review record.' });
    await page.goto(`${origin}/library.html?entry=${asset.id}&version=v1`);
    const bookmark = page.locator('[data-bookmark-control]'); await bookmark.locator(':scope > summary').click();
    const chooser = bookmark.getByRole('combobox', { name: tx('资料夹', 'Collection'), exact: true });
    const note = bookmark.getByRole('textbox', { name: tx('私人备注（可选）', 'Private note (optional)'), exact: true });
    const save = async (id: string, status = 200) => {
      const pending = reply(page, 'POST', `/api/research/collections/${id}/items`);
      await bookmark.getByRole('button', { name: tx('保存收藏', 'Save bookmark'), exact: true }).click();
      const response = await pending; assert.equal(response.status(), status);
      if (status === 200) await bookmark.getByText(tx('已保存到你的资料夹。', 'Saved to your collection.'), { exact: true }).waitFor();
      else await bookmark.getByRole('alert').waitFor();
      await bookmark.locator('fieldset:not(:disabled)').waitFor();
      return response.request().postDataJSON();
    };
    phase = `bookmark-target-isolation-${suffix}`;
    await chooser.selectOption(a.id); assert.equal(await note.inputValue(), 'A: original private note.');
    await note.fill('A: separate unsaved revision.');
    await chooser.selectOption(b.id); assert.equal(await note.inputValue(), 'B: important human review record.');
    assert.equal(Object.hasOwn(await save(b.id), 'note'), false, 'Untouched B note must be omitted');
    await chooser.selectOption(a.id); assert.equal(await note.inputValue(), 'A: separate unsaved revision.');
    await save(a.id);
    await chooser.selectOption(b.id); assert.equal(await note.inputValue(), 'B: important human review record.');
    assert.equal(Object.hasOwn(await save(b.id), 'note'), false, 'Saving A must not mark B as edited');
    assert.equal(collections.get(owner, b.id).items[0].note, 'B: important human review record.');
    await bookmark.screenshot({ path: path.join(output, `bookmark-target-isolation-${suffix}.png`) });

    phase = `bookmark-conflict-recovery-${suffix}`;
    await chooser.selectOption(a.id); await note.fill('A: unsaved details retained after a concurrent folder rename.');
    const latest = collections.get(owner, a.id);
    collections.update(owner, a.id, { requestId: `rename-${suffix}`, expectedRevision: latest.revision, title: 'Collection A (renamed)', description: latest.description });
    await save(a.id, 409);
    const refreshed = reply(page, 'GET', '/api/research/collections');
    await bookmark.getByRole('button', { name: tx('重新读取资料夹后重试', 'Reload collections and try again'), exact: true }).click(); await (await refreshed).finished();
    assert.equal(await note.inputValue(), 'A: unsaved details retained after a concurrent folder rename.');
    await save(a.id); assert.equal(collections.get(owner, a.id).items[0].note, 'A: unsaved details retained after a concurrent folder rename.');
    await chooser.selectOption(b.id); await note.fill(''); assert.equal((await save(b.id)).note, '');
    assert.equal(collections.get(owner, b.id).items[0].note, '');
    await chooser.selectOption('new'); await bookmark.getByRole('textbox', { name: tx('资料夹名称', 'Collection name'), exact: true }).fill('Collection C');
    await note.fill('C: note created with the collection.');
    const created = reply(page, 'POST', '/api/research/collections');
    await bookmark.getByRole('button', { name: tx('保存收藏', 'Save bookmark'), exact: true }).click();
    const createdId = (await (await created).json()).item.id;
    await bookmark.getByText(tx('已保存到你的资料夹。', 'Saved to your collection.'), { exact: true }).waitFor();
    assert.equal(collections.get(owner, createdId).items[0].note, 'C: note created with the collection.');
    checks.push({ id: 'bookmark-target-isolation-and-recovery', language, width, existingNotesLoaded: true, otherCollectionPreserved: true,
      untouchedNoteOmitted: true, unsavedDraftsIsolated: true, conflictStatus: 409, conflictRefreshPreservesDraft: true, explicitClear: true, newCollectionNote: true });

    phase = `mathematical-usage-comparison-${suffix}`;
    await page.goto(`${origin}/library.html?entry=${asset.id}&version=v1`);
    await page.getByRole('button', { name: tx('关注新版本', 'Follow new releases'), exact: true }).click();
    await page.getByRole('button', { name: tx('已关注新版本', 'Following new releases'), exact: true }).waitFor();
    assets.update(author, asset.id, { requestId: `usage-${suffix}`, expectedRevision: assets.get(author, asset.id).revision, content: { source, usage: usage(true) } });
    const v2 = await publish(author, asset.id, 'v2');
    assert.deepEqual(v1.mathematics!.pack, v2.mathematics!.pack);
    await page.goto(origin + '/workspace.html?tab=inbox#asset-updates');
    await page.locator('#asset-updates').getByRole('link', { name: tx('查看版本差异', 'Compare releases'), exact: true }).click();
    const comparison = page.locator('[data-release-comparison]'), usageChanges = comparison.locator('[data-release-usage-changes]');
    await comparison.getByRole('heading', { name: 'v1 → v2', exact: true }).waitFor();
    const difference: ResearchReleaseComparison = await page.evaluate(async id => (await (await fetch(`/api/research/library/${id}/compare?from=v1&to=v2`)).json()).item, asset.id);
    assert.equal(difference.content.length, 0); assert.equal(difference.declarations.length, 0); assert.equal(difference.environment.changed, false);
    assert.deepEqual(difference.usage.map(item => item.field).sort(), ['argumentNotes', 'conditions', 'proof', 'result', 'title', 'type']);
    for (const field of ['conditions', 'result', 'proof', 'argumentNotes', 'type']) await usageChanges.locator(`[data-usage-field="${field}"] > summary`).click();
    assert.ok(await usageChanges.locator('.katex').count() >= 2, 'Formula descriptions render in before/after usage panels');
    await usageChanges.getByText('simpa using (Shared.zero n)', { exact: false }).waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, `mathematical-usage-comparison-${suffix}.png`), fullPage: true });
    await usageChanges.locator('[data-usage-field="proof"]').screenshot({ path: path.join(output, `invocation-proof-comparison-${suffix}.png`) });
    moduleSource += '-- Source comparison control\n'; commit = 'b'.repeat(40);
    assets.update(author, asset.id, { requestId: `source-control-${suffix}`, expectedRevision: assets.get(author, asset.id).revision,
      content: { source: { ...source, commit }, usage: usage(true) } });
    await publish(author, asset.id, 'v3');
    await page.goto(`${origin}/library.html?entry=${asset.id}&version=v3&compareFrom=v2&compareTo=v3#release-comparison`);
    await comparison.getByRole('heading', { name: 'v2 → v3', exact: true }).waitFor();
    const control: ResearchReleaseComparison = await page.evaluate(async id => (await (await fetch(`/api/research/library/${id}/compare?from=v2&to=v3`)).json()).item, asset.id);
    assert.equal(control.content.length, 1); assert.deepEqual(control.usage, []);
    assert.deepEqual(assets.release(author, asset.id, 'v1'), v1); assert.deepEqual(assets.release(author, asset.id, 'v2'), v2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    checks.push({ id: 'mathematical-usage-comparison', language, width, usageFields: difference.usage.map(item => item.field), moduleSourceUnchanged: true,
      sourceChangeControl: control.content.length, receiptOnlyChangesIgnored: true, fixedVersionsUnchanged: true });
    await context.close(); active = undefined;
  }
  assert.equal(prohibited, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) { failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await browser.close(); await assets.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, prohibited, recordedChecks, errors, external,
    ...(failure ? { error: String(failure) } : {}) }, null, 2));
}
if (failure) throw failure;
console.log(JSON.stringify({ status: 'passed', checks: checks.length, prohibited, recordedChecks, output }));
