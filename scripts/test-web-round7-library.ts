#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { ResearchAgentDraft, ResearchAsset, ResearchAssetContent, ResearchAssetKind, ResearchSkillDraft } from '../apps/web/researchAssetTypes';
import type { WebRunner } from '../apps/web/runner';
import { deferred, freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_ROUND7_LIBRARY_OUTPUT ?? path.join(root, 'out/web-round7-library');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-round7-library-'));
let runnerCalls = 0;
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Disposable draft reload regressions' }; },
  async run() { runnerCalls++; throw new Error('Draft reload checks must not start research'); } };
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner, { sample: null });
const browser = await startBrowser(service.server, port);
const errors: string[] = [], external: string[] = [], checks: object[] = [];
let phase = 'setup', active: Page | undefined, failure: unknown;
const panel = (page: Page, name: string) => page.locator('section.research-panel').filter({ has: page.getByRole('heading', { name, exact: true }) });
async function http<T>(page: Page, method: string, pathname: string, input?: object): Promise<T> {
  const response = await page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const result = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: result.status, body: await result.json() };
  }, { method, pathname, input });
  assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response)); return response.body;
}
async function save(page: Page, editor: Locator, pathname: string, label: string) {
  const response = page.waitForResponse(item => item.request().method() === 'PATCH' && new URL(item.url()).pathname === pathname);
  await editor.getByRole('button', { name: label, exact: true }).click();
  assert.equal((await response).status(), 200); await editor.getByRole('status').waitFor();
}
try {
  for (const locale of ['zh', 'en'] as const) {
    const en = locale === 'en', label = en ? 'en-390' : 'zh-1440', t = (zh: string, english: string) => en ? english : zh;
    const context = await browser.newContext({ locale: en ? 'en-US' : 'zh-CN', viewport: { width: en ? 390 : 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(locale => { try { localStorage.setItem('theorem-os.locale.v1', locale); } catch { /* Initial blank document. */ } }, locale);
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    context.on('page', page => { page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(label + ': ' + error.message)); });
    const page = await context.newPage(), control = await context.newPage(); active = page;
    try {
      await control.goto(origin + '/library.html');
      for (const kind of ['skill', 'agent', 'mathematics'] as const) {
        const content: ResearchAssetContent = kind === 'skill'
          ? { instructions: 'ORIGINAL SKILL', steps: ['First step'], inputs: [], outputs: [], slots: ['M1'], roles: [], mode: 'append', dependencies: [], examples: [] }
          : kind === 'agent' ? { environment: 'standard', modulePlan: { scheduler: 'plan', context: 'full', custom: [
            { id: 'reload-rule', name: 'Original rule', slot: 'M1', mode: 'append', enabled: true, instructions: 'Original instructions' },
          ] }, skills: [], libraries: [] }
          : { source: { kind: 'knowledge', catalogDigest: 'a'.repeat(64), entryIds: ['unpublished-draft-entry'] } };
        const created = await http<{ item: ResearchAsset }>(control, 'POST', '/api/research/library', {
          requestId: crypto.randomUUID(), type: kind satisfies ResearchAssetKind, name: `${label} ${kind} saved name`, content,
        });
        const pathname = '/api/research/library/' + created.item.id;
        await page.goto(origin + '/library.html?entry=' + created.item.id);
        await page.getByRole('button', { name: t('编辑草稿', 'Edit draft'), exact: true }).click();
        const editor = panel(page, t('编辑草稿', 'Edit draft'));
        const name = editor.getByRole('textbox', { name: t('名称', 'Name'), exact: true });
        const reload = editor.getByRole('button', { name: t('载入最新草稿', 'Load latest draft'), exact: true });
        const saveLabel = t('保存草稿', 'Save draft');
        // A fresh server revision makes successful reloading observable independently of DOM structure.
        const updated = await http<{ item: ResearchAsset }>(control, 'PATCH', pathname, {
          requestId: crypto.randomUUID(), expectedRevision: created.item.revision, name: `${label} ${kind} newest server name`, content,
        });
        phase = `${label} ${kind}: all editor controls reject edits during a delayed reload and recover on success`;
        await name.fill('UNSAVED INPUT BEFORE EXPLICIT RELOAD');
        const reached = deferred(), release = deferred();
        await page.route('**' + pathname, async route => {
          if (route.request().method() !== 'GET') { await route.continue(); return; }
          const response = await route.fetch(); assert.equal(response.status(), 200);
          reached.resolve(); await release.promise; await route.fulfill({ response });
        });
        let controls = 0;
        try {
          await reload.click(); await reached.promise;
          const values = await editor.locator('form').evaluate(form => [...form.querySelectorAll('input,textarea,select,button')].map(element => ({
            tag: element.tagName, disabled: element.matches(':disabled'),
          })));
          controls = values.length; assert.ok(controls >= 10, `${kind}: exercise actual nested controls`);
          assert.ok(values.every(item => item.disabled), JSON.stringify(values));
          assert.equal(await name.isEnabled(), false); assert.equal(await name.isEditable(), false);
          await page.keyboard.type('THIS MUST NOT BE INSERTED');
          assert.equal(await name.inputValue(), 'UNSAVED INPUT BEFORE EXPLICIT RELOAD');
          release.resolve();
          await page.waitForFunction(value => [...document.querySelectorAll('input')].some(input => input.value === value), updated.item.name);
          assert.equal(await name.isEnabled(), true);
          assert.equal(await editor.getByRole('button', { name: saveLabel, exact: true }).isEnabled(), true);
          if (kind === 'agent') {
            const add = editor.getByRole('button', { name: t('添加规则', 'Add rule'), exact: true });
            assert.equal(await add.isEnabled(), true);
            assert.equal(await editor.getByRole('textbox', { name: t('规则正文', 'Instructions'), exact: true }).isEditable(), true);
          }
          const widths = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
          assert.ok(widths.document <= widths.viewport + 1, JSON.stringify(widths));
          if (kind === 'skill') await page.screenshot({ path: path.join(output, label + '-reloaded-draft.png'), fullPage: true });
          checks.push({ name: phase, disabledControls: controls, loadedRevision: updated.item.revision, newestName: await name.inputValue(), widths });
        } finally { release.resolve(); await page.unroute('**' + pathname); }

        phase = `${label} ${kind}: a failed reload preserves unsaved input and unlocks the complete editor`;
        await name.fill(`${label} ${kind} retained after failed reload`);
        const failedReached = deferred(), failedRelease = deferred();
        await page.route('**' + pathname, async route => {
          if (route.request().method() !== 'GET') { await route.continue(); return; }
          failedReached.resolve(); await failedRelease.promise;
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Draft reload temporarily unavailable' }) });
        });
        try {
          await reload.click(); await failedReached.promise; assert.equal(await name.isEditable(), false);
          failedRelease.resolve(); await editor.getByRole('alert').waitFor();
          assert.equal(await name.inputValue(), `${label} ${kind} retained after failed reload`);
          assert.equal(await name.isEditable(), true); assert.equal(await reload.isEnabled(), true);
          const editableCount = await editor.locator('form').evaluate(form => [...form.querySelectorAll('input,textarea,select,button')].filter(element => !element.matches(':disabled')).length);
          assert.equal(editableCount, controls);
          checks.push({ name: phase, retainedName: await name.inputValue(), enabledControls: editableCount });
        } finally { failedRelease.resolve(); await page.unroute('**' + pathname); }

        if (kind === 'mathematics') continue; // A math draft needs a real accepted run/catalog before save; no synthetic proof sources.
        phase = `${label} ${kind}: ordinary saves still accept later edits and the next save persists them`;
        const patchReached = deferred(), patchRelease = deferred();
        await page.route('**' + pathname, async route => {
          if (route.request().method() !== 'PATCH') { await route.continue(); return; }
          const response = await route.fetch(); assert.equal(response.status(), 200);
          patchReached.resolve(); await patchRelease.promise; await route.fulfill({ response });
        });
        try {
          await editor.getByRole('button', { name: saveLabel, exact: true }).click(); await patchReached.promise;
          assert.equal(await name.isEditable(), true); await name.fill(`${label} ${kind} NEWER INPUT`);
          if (kind === 'skill') await editor.getByRole('textbox', { name: t('适用情境与执行要求', 'When to use and instructions'), exact: true }).fill('NEWER SKILL INSTRUCTIONS');
          else await editor.getByRole('textbox', { name: t('规则正文', 'Instructions'), exact: true }).fill('NEWER AGENT RULE');
          patchRelease.resolve(); await editor.getByRole('status').waitFor();
          assert.match(await editor.getByRole('status').innerText(), en ? /later edits/iu : /修改已保留/u);
          assert.equal(await name.inputValue(), `${label} ${kind} NEWER INPUT`);
        } finally { patchRelease.resolve(); await page.unroute('**' + pathname); }
        await save(page, editor, pathname, saveLabel);
        const saved = (await http<{ item: ResearchAsset }>(control, 'GET', pathname)).item;
        assert.equal(saved.name, `${label} ${kind} NEWER INPUT`);
        if (kind === 'skill') assert.equal((saved.draft as ResearchSkillDraft).instructions, 'NEWER SKILL INSTRUCTIONS');
        else assert.equal((saved.draft as ResearchAgentDraft).modulePlan.custom[0]!.instructions, 'NEWER AGENT RULE');
        checks.push({ name: phase, persistedRevision: saved.revision, savedName: saved.name });
      }
    } finally { await context.close(); active = undefined; }
  }
  assert.equal(checks.length, 16); assert.equal(runnerCalls, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (cause) {
  failure = cause; await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw cause;
} finally {
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(), checks,
    errors, external, runnerCalls, realModels: 0, realLean: 0, productionWrites: false, fixturesRemoved: true,
    ...(failure ? { failedPhase: phase, error: String(failure) } : {}) }, null, 2) + '\n');
}
console.log(`Library round 7 passed ${checks.length} browser cases. Evidence: ${output}`);
