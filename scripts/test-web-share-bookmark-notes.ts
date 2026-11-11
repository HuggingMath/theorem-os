#!/usr/bin/env bun
// Disposable local fixtures; no model, Lean, mail or production data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { shareSnapshot } from '../apps/web/share';
import { WebResearchCollections } from '../apps/web/researchCollections';
import { localeStorageKey } from '../apps/web/i18n';
import type { ResearchCollection } from '../apps/web/researchCollectionTypes';
import { readingRun } from '../tests/helpers/shareReadingFixture';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/post-lifecycle-20261111/share-notes');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-share-notes-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let prohibited = 0, phase = 'setup', failure: unknown, active: Page | undefined;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), {
  async readiness() { return { ready: true, message: 'Disposable note continuity fixtures' }; },
  async run() { prohibited++; throw new Error('No proof worker allowed'); },
  async check() { prohibited++; throw new Error('No Lean allowed'); },
  async formalize() { prohibited++; throw new Error('No model allowed'); },
}, { sample: null, mailer: async () => { prohibited++; throw new Error('No mail allowed'); } });
const browser = await startBrowser(service.server, port), errors: string[] = [], external: string[] = [], checks: object[] = [];
const collectionFixtures = new WebResearchCollections({ storage: service.storage, projects: service.research.projects, assets: service.research.assets });
const collections = (page: Page): Promise<ResearchCollection[]> => page.evaluate(async () => (await (await fetch('/api/research/collections')).json()).items);
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ key, language }) => localStorage.setItem(key, language), { key: localeStorageKey, language });
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message));
    const run = readingRun(crypto.randomUUID()), snapshot = shareSnapshot(run)!, token = crypto.randomUUID().replaceAll('-', '');
    const author = 'account:disposable-share-notes-author';
    service.storage.saveRun(author, run); service.storage.saveShare(author, run.id, { token, createdAt: snapshot.sharedAt, snapshot });
    const originalLink = `${origin}/share.html?lang=${language}#${token}`;
    const posts: Record<string, unknown>[] = [], mutations: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /\/collections\/[^/]+\/items$/u.test(new URL(request.url()).pathname)) posts.push(request.postDataJSON());
      if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) mutations.push(request.url());
    });
    phase = `first-bookmark-${language}`;
    await page.goto(originalLink); await page.locator('[data-share-bookmark]').click(); await page.locator('[data-share-collection-title]').waitFor();
    assert.deepEqual(mutations, [], 'Opening the form does not create a reference or collection');
    const note = '已核对前提；下次补边界条件。 Checked assumptions; add the boundary condition.';
    await page.locator('[data-share-collection-title]').fill('Proof references'); await page.locator('[data-share-bookmark-note]').fill(note);
    let failFirstSave = true;
    await page.route('**/api/research/collections/*/items', async route => {
      if (failFirstSave) { failFirstSave = false; await route.abort('failed'); } else await route.continue();
    });
    await page.locator('[data-share-save-bookmark]').click(); await page.locator('[data-share-receiver] [role=alert]').waitFor();
    assert.equal(await page.locator('[data-share-bookmark-note]').inputValue(), note, 'A failed first save keeps the typed note');
    await page.locator('[data-share-save-bookmark]').click(); await page.locator('[data-share-saved-collection]').waitFor();
    const first = (await collections(page))[0]!; assert.equal(first.items[0].note, note);
    const target = first.items[0].target; assert.equal(target.kind, 'share'); if (target.kind !== 'share') throw new Error('Missing share target');
    phase = `original-token-rebookmark-${language}`;
    await page.goto(originalLink); const before = mutations.length;
    await page.locator('[data-share-bookmark]').click(); await page.locator('[data-share-existing-bookmark]').waitFor();
    assert.equal(mutations.length, before, 'Resolving a saved original link only reads');
    assert.equal(await page.locator('[data-share-bookmark-note]').inputValue(), note);
    await page.locator('[data-share-receiver]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${language}-${width}-restored.png`) });
    await page.locator('[data-share-save-bookmark]').click(); await page.locator('[data-share-saved-collection]').waitFor();
    assert.equal(Object.hasOwn(posts.at(-1)!, 'note'), false, 'An untouched note is omitted from the request');
    assert.equal((await collections(page))[0].items[0].note, note);
    phase = `reading-link-and-folder-switch-${language}`;
    await page.goto(`${origin}/share.html?reading=${target.shareId}&lang=${language}`);
    await page.locator('[data-share-bookmark]').click(); await page.locator('[data-share-existing-bookmark]').waitFor();
    assert.equal(await page.locator('[data-share-bookmark-note]').inputValue(), note);
    await page.locator('[data-share-collection]').selectOption('new');
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-share-bookmark-note]')?.value === '');
    await page.locator('[data-share-collection-title]').fill('Second folder'); await page.locator('[data-share-bookmark-note]').fill('A different private note.');
    await page.locator('[data-share-save-bookmark]').click(); await page.locator('[data-share-saved-collection]').waitFor();
    const second = (await collections(page)).find(folder => folder.id !== first.id)!; assert.equal(second.items[0].note, 'A different private note.');
    await page.locator('[data-share-collection]').selectOption(first.id);
    await page.waitForFunction(value => document.querySelector<HTMLTextAreaElement>('[data-share-bookmark-note]')?.value === value, note);
    await page.locator('[data-share-collection]').selectOption(second.id);
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-share-bookmark-note]')?.value === 'A different private note.');
    phase = `conflict-refresh-keeps-unsaved-note-${language}`;
    const unsavedNote = '人工复核尚未完成：保留边界条件与后续参数检查。 Human review is incomplete; retain the boundary conditions and follow-up parameter checks.';
    await page.locator('[data-share-bookmark-note]').fill(unsavedNote);
    const viewer = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const latest = collectionFixtures.get(viewer, second.id);
    collectionFixtures.update(viewer, second.id, { requestId: `concurrent-rename-${language}`, expectedRevision: latest.revision,
      title: latest.title + ' (renamed in another tab)', description: latest.description });
    const conflicted = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/research/collections/${second.id}/items`);
    await page.locator('[data-share-save-bookmark]').click(); assert.equal((await conflicted).status(), 409);
    await page.locator('[data-share-receiver] [role=alert]').waitFor();
    const reloaded = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/research/collections');
    await page.getByRole('button', { name: language === 'zh' ? '刷新资料夹' : 'Refresh collections', exact: true }).click();
    await (await reloaded).finished(); await page.locator('[data-share-bookmark-note]:enabled').waitFor();
    assert.equal(await page.locator('[data-share-collection]').inputValue(), second.id);
    assert.equal(await page.locator('[data-share-bookmark-note]').inputValue(), unsavedNote, 'Conflict recovery refreshes revisions without replacing the local note');
    await page.locator('[data-share-receiver]').screenshot({ path: path.join(output, `${language}-${width}-conflict-recovered.png`) });
    await page.locator('[data-share-save-bookmark]').click(); await page.locator('[data-share-saved-collection]').waitFor();
    assert.equal((await collections(page)).find(folder => folder.id === second.id)!.items[0].note, unsavedNote);
    phase = `folder-specific-unsaved-drafts-${language}`;
    await page.locator('[data-share-bookmark-note]').fill('B: unsaved local draft.');
    await page.locator('[data-share-collection]').selectOption(first.id);
    assert.equal(await page.locator('[data-share-bookmark-note]').inputValue(), note);
    await page.locator('[data-share-bookmark-note]').fill('A: a separate unsaved draft.');
    await page.locator('[data-share-collection]').selectOption(second.id);
    assert.equal(await page.locator('[data-share-bookmark-note]').inputValue(), 'B: unsaved local draft.');
    await page.locator('[data-share-collection]').selectOption(first.id);
    assert.equal(await page.locator('[data-share-bookmark-note]').inputValue(), 'A: a separate unsaved draft.');
    await page.locator('[data-share-collection]').selectOption(second.id);
    phase = `explicit-edit-and-clear-${language}`;
    await page.locator('[data-share-bookmark-note]').fill('Revised private note.'); await page.locator('[data-share-save-bookmark]').click();
    await page.locator('[data-share-saved-collection]').waitFor(); assert.equal(posts.at(-1)?.note, 'Revised private note.');
    assert.equal((await collections(page)).find(folder => folder.id === second.id)!.items[0].note, 'Revised private note.');
    await page.locator('[data-share-bookmark-note]').fill(''); await page.locator('[data-share-save-bookmark]').click();
    await page.locator('[data-share-saved-collection]').waitFor(); assert.equal(posts.at(-1)?.note, '');
    const final = await collections(page);
    assert.equal(final.find(folder => folder.id === second.id)!.items[0].note, '');
    assert.equal(final.find(folder => folder.id === first.id)!.items[0].note, note);
    assert.equal(final.every(folder => folder.items.length === 1), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(output, `${language}-${width}-notes.png`), fullPage: true });
    checks.push({ language, width, originalLinkRestoresNote: true, readingLinkRestoresNote: true, noWriteBeforeSave: true,
      firstSaveFailurePreservesNote: true, untouchedNoteOmitted: true, folderSwitchRestoresNote: true, explicitEdit: true, explicitClear: true, otherFolderUnchanged: true });
    Object.assign(checks.at(-1)!, { conflictStatus: 409, conflictRefreshPreservesNote: true, retryPersistsLocalNote: true, folderSpecificUnsavedDrafts: true });
    await context.close(); active = undefined;
  }
  assert.equal(prohibited, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) { failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', phase, checks, errors, external, prohibited,
    ...(failure ? { error: String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Shared bookmark notes: ${checks.length} bilingual desktop/mobile workflows passed`);
