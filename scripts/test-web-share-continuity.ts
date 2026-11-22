#!/usr/bin/env bun
// Disposable loopback service. Authentication messages stay in memory; no model or Lean is invoked.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { shareSnapshot } from '../apps/web/share';
import { localeStorageKey } from '../apps/web/i18n';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchCollection } from '../apps/web/researchCollectionTypes';
import type { SharedProofPreparation } from '../apps/web/sharedProofTypes';
import { readingRun } from '../tests/helpers/shareReadingFixture';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/research-closure/share-continuity');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.access(path.join(staticRoot, 'share.css')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-share-continuity-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const author = 'account:disposable-share-author', emails = ['share-zh@example.org', 'share-en@example.org'];
const mail: { to: string; text: string }[] = [], errors: string[] = [], external: string[] = [], checks: object[] = [];
let workerCalls = 0, phase = 'start', failure: unknown, active: Page | undefined;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable share continuation fixture' }; },
  async run() { workerCalls++; throw new Error('Preparing a shared original must not start a worker'); },
};
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_AUTH: 'email',
  THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: emails.join(','),
  THEOREMOS_WEB_PROVIDERS: JSON.stringify([{ id: 'fixture', name: 'Local fixture', baseUrl: 'https://provider.invalid/v1' }]) });
const service = createWebService(config, runner, { sample: null, mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
const browser = await startBrowser(service.server, port);
const noOverflow = async (page: Page) => {
  const measured = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll<HTMLElement>('body *')].map(item => ({ item, rect: item.getBoundingClientRect() }))
      .filter(({ item, rect }) => rect.width > 0 && rect.right > innerWidth + 1 && getComputedStyle(item).position !== 'fixed')
      .slice(0, 6).map(({ item, rect }) => ({ tag: item.tagName, id: item.id, class: item.className, width: rect.width, right: rect.right })) }));
  assert.ok(measured.scrollWidth <= measured.viewport + 1, `Page fits its viewport: ${JSON.stringify(measured)}`);
};
const collections = (page: Page) => page.evaluate(async () => (await (await fetch('/api/research/collections')).json()).items as ResearchCollection[]);
async function login(page: Page, email: string) {
  await page.locator('#send-code:enabled').waitFor(); await page.locator('#login-email').fill(email); await page.locator('#login-captcha').fill('24680');
  if (await page.locator('#terms-option').isVisible()) await page.locator('#accept-terms').check();
  await page.locator('#send-code').click(); await page.locator('#code-step:visible').waitFor();
  const code = mail.findLast(message => message.to === email)?.text.match(/\b\d{6}\b/u)?.[0]; assert.ok(code);
  await page.locator('#login-code').fill(code); await page.locator('#verify-code').click();
  await page.waitForURL(url => url.pathname === '/share.html'); await page.locator('[data-share-collection-title]').waitFor();
}
try {
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN' });
    await context.addInitScript(({ key, language }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, language); }, { key: localeStorageKey, language });
    const writes: string[] = [], forbiddenWrites: string[] = []; let sessions = 0;
    await context.route(/^https?:\/\//u, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(url.origin); await route.abort(); return; }
      if (url.pathname === '/api/session') sessions++;
      if (request.method() !== 'GET' && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/')) {
        writes.push(url.pathname);
        if (/^\/api\/(?:runs|formalizations|conversations)(?:\/|$)/u.test(url.pathname)) {
          forbiddenWrites.push(url.pathname); await route.fulfill({ status: 422, json: { error: 'The fixture cannot start a worker.' } }); return;
        }
      }
      await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    const run = readingRun(crypto.randomUUID()); run.source = `\n${run.source}\n\n`;
    run.model = 'author-model-must-not-be-copied'; run.workers = 7;
    const snapshot = shareSnapshot(run)!;
    const token = crypto.randomUUID().replaceAll('-', '');
    service.storage.saveRun(author, run); service.storage.saveShare(author, run.id, { token, createdAt: snapshot.sharedAt, snapshot });
    phase = `${language}-anonymous-share`;
    await page.goto(`${origin}/share.html?lang=${language}#${token}`); await page.locator('[data-share-receiver]').waitFor();
    assert.equal(sessions, 0); assert.deepEqual(await context.cookies(origin), []); assert.deepEqual(writes, []);
    await page.locator('[data-share-receiver]').scrollIntoViewIfNeeded(); await noOverflow(page);
    await page.screenshot({ path: path.join(output, `${language}-share-actions.png`), fullPage: true });
    await page.locator('[data-share-bookmark]').click(); await page.locator('[data-share-signin]').waitFor();
    const loginLink = (await page.locator('[data-share-signin]').getAttribute('href'))!;
    assert.ok(loginLink.includes('shareReturn=')); assert.ok(!loginLink.includes(token)); assert.deepEqual(writes, []);
    await page.locator('[data-share-signin]').click(); await page.waitForURL(url => url.pathname === '/login.html');
    const returnNonce = new URL(page.url()).searchParams.get('shareReturn'); assert.ok(returnNonce);
    for (const lang of [language === 'zh' ? 'en' : 'zh', language]) {
      await page.locator('#locale-switch').click(); await page.waitForURL(url => url.searchParams.get('lang') === lang);
      await page.locator('#send-code:enabled').waitFor(); assert.equal(new URL(page.url()).searchParams.get('shareReturn'), returnNonce);
    }
    await page.reload(); await login(page, `share-${language}@example.org`);
    assert.equal(new URL(page.url()).hash, `#${token}`); assert.equal(new URL(page.url()).searchParams.get('shareReturn'), null);
    assert.deepEqual(writes, []); assert.deepEqual(await collections(page), []);
    assert.equal(await page.evaluate(nonce => sessionStorage.getItem(`theorem-os.share-return.${nonce}`), returnNonce), null);
    phase = `${language}-bookmark`;
    await page.locator('[data-share-collection-title]').fill('Study this derivation'); await page.locator('[data-share-bookmark-note]').fill('Check the transition to the final equality.');
    await page.locator('[data-share-save-bookmark]').click(); await page.locator('[data-share-saved-collection]').waitFor();
    const folder = (await collections(page))[0]!, bookmark = folder.items[0]!;
    assert.equal(bookmark.target.kind, 'share'); assert.ok(bookmark.available); assert.ok(!JSON.stringify(folder).includes(token)); assert.ok(!JSON.stringify(folder).includes(run.id));
    await page.locator('[data-share-saved-collection]').click(); await page.locator(`[data-collection-id="${folder.id}"] [data-bookmark-id]`).waitFor();
    await noOverflow(page); await page.screenshot({ path: path.join(output, `${language}-collection.png`), fullPage: true });
    await page.locator(`[data-bookmark-id="${bookmark.id}"] a`).click(); await page.locator('[data-share-receiver]').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('reading'), bookmark.target.kind === 'share' ? bookmark.target.shareId : '');
    assert.equal(new URL(page.url()).hash, '');
    phase = `${language}-prepare-retry`;
    await page.locator('[data-share-prepare]').click(); await page.locator('[data-share-preparation-preview]').waitFor();
    assert.equal(await page.locator('[data-share-confirm-prepare]').isDisabled(), true);
    await page.locator('[data-share-preparation-preview] details summary').click();
    assert.equal(await page.locator('[data-share-preparation-preview] pre').textContent(), snapshot.source);
    await page.locator('[data-share-confirm-copy]').check(); await noOverflow(page);
    await page.screenshot({ path: path.join(output, `${language}-prepare.png`), fullPage: true });
    let prepared: SharedProofPreparation | undefined, preparePosts = 0;
    await page.route('**/api/research/shared-proofs/*/prepare', async route => {
      preparePosts++; const response = await route.fetch();
      assert.equal(response.status(), 201); const body = await response.json() as { item: SharedProofPreparation }; prepared = body.item;
      if (preparePosts === 1) { service.storage.deleteShare(author, run.id); await route.abort('failed'); }
      else await route.fulfill({ response });
    });
    await page.locator('[data-share-confirm-prepare]').click(); await page.locator('[data-share-receiver] [role=alert]').waitFor();
    assert.match(await page.locator('[data-share-receiver] [role=alert]').innerText(), language === 'zh' ? /请重试/u : /Please retry/u);
    assert.ok(prepared); assert.equal(await page.locator('[data-share-confirm-prepare]').isEnabled(), true);
    await page.locator('[data-share-confirm-prepare]').click(); await page.waitForURL(url => url.pathname === '/');
    await page.locator('[data-shared-proof-ready=true]').waitFor(); assert.equal(preparePosts, 2);
    assert.equal(new URL(page.url()).searchParams.get('sharedDraft'), null);
    assert.equal(await page.locator('#source').inputValue(), snapshot.source); assert.equal(await page.locator('#task').inputValue(), snapshot.task);
    assert.notEqual(await page.locator('#model').inputValue(), snapshot.model); assert.notEqual(await page.locator('#workers').inputValue(), String(snapshot.workers));
    assert.equal(await page.evaluate(async () => (await (await fetch('/api/runs')).json()).runs.length), 0);
    await noOverflow(page); await page.screenshot({ path: path.join(output, `${language}-own-draft.png`), fullPage: true });
    phase = `${language}-edit-refresh`;
    await page.locator('#edit-draft-source').click(); await page.locator('#expanded-source').fill(`${snapshot.source}-- recipient edit\n`);
    await page.locator('#apply-editor').click();
    await page.waitForFunction(() => sessionStorage.getItem('theorem-os.web-draft.v1')?.includes('-- recipient edit'));
    await page.reload(); await page.locator('#open-account').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#source').inputValue(), `${snapshot.source}-- recipient edit\n`);
    const savedDraft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('theorem-os.web-draft.v1')!));
    assert.ok(!JSON.stringify(savedDraft).includes(run.id)); assert.ok(!JSON.stringify(savedDraft).includes(snapshot.model));
    phase = `${language}-revoked-share`;
    await page.goto(`${origin}/workspace.html?tab=collections&collection=${folder.id}`); await page.locator(`[data-bookmark-id="${bookmark.id}"]`).waitFor();
    const unavailable = (await collections(page))[0]!.items[0]!; assert.equal(unavailable.available, false); assert.equal(unavailable.note, bookmark.note); assert.equal(unavailable.href, undefined);
    assert.equal(await page.locator(`[data-bookmark-id="${bookmark.id}"] a`).count(), 0);
    await page.goto(`${origin}/${bookmark.href}`); await page.locator('#share-missing:not([hidden])').waitFor();
    assert.equal(await page.locator('[data-share-receiver]').count(), 0);
    const copied = await page.evaluate(async id => (await (await fetch(`/api/research/shared-proofs/preparations/${id}`)).json()).item, prepared!.id);
    assert.equal(copied.source, snapshot.source);
    phase = `${language}-classic-entry`;
    await page.goto(`${origin}/classics/${language === 'en' ? 'en/' : ''}archive.html#status=verified`);
    await page.locator('[data-proof-id]').first().click(); await page.locator('[data-tab=overview]').click();
    const cta = page.locator('[data-archive-study]'), href = (await cta.getAttribute('href'))!;
    const destination = new URL(href, page.url()); assert.equal(destination.pathname, '/'); assert.equal(destination.searchParams.get('lang'), language);
    assert.ok(destination.searchParams.get('fromClassic')); await cta.click(); await page.locator('[data-classic-origin]').waitFor();
    assert.equal(new URL(page.url()).pathname, '/');
    const back = (await page.locator('[data-classic-origin] a').getAttribute('href'))!;
    assert.equal(new URL(back, origin).hash.includes(destination.searchParams.get('fromClassic')!), true);
    assert.deepEqual(forbiddenWrites, []); await noOverflow(page);
    await page.locator('[data-chat-research-overview] > summary').click();
    await page.locator('[data-inbox-summary] > div > a').first().waitFor();
    assert.ok(await page.locator('[data-inbox-summary] > div > a').evaluateAll(links => links.length === 3 && links.every(link => {
      const count = link.querySelector('strong')!.getBoundingClientRect(), label = link.querySelector('span')!.getBoundingClientRect();
      return label.left - count.right >= 4;
    })), 'Research counters have readable spacing between each count and label');
    await page.screenshot({ path: path.join(output, `${language}-classic-destination.png`), fullPage: true });
    checks.push({ language, width, anonymousReadingWithoutSession: true, loginReturnAndLocale: true, explicitBookmark: true,
      ownerScopedReading: true, originalSourceCopy: true, completedCopyRetryAfterRevocation: true, refreshPreservesEdit: true,
      revokedBookmarkKeepsNote: true, classicEntryReachesWorkbench: true });
    await context.close();
  }
  assert.equal(workerCalls, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (error) { failure = error; if (active && !active.isClosed()) await active.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(), phase,
    checks, errors, external, workerCalls, ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`Share continuity: ${checks.length} desktop/mobile workflows passed`);
