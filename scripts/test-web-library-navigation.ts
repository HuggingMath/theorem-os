#!/usr/bin/env bun
// Saved Library configuration must not replace an existing run, chat or sample with a draft.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { loadWebSample } from '../apps/web/sample';
import type { WebConversation } from '../apps/web/conversationTypes';
import type { ResearchAsset, ResearchPublication } from '../apps/web/researchAssetTypes';
import { freePort, postRun, settled, startBrowser, waitForRun } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.env.THEOREMOS_NAVIGATION_OUTPUT ?? path.join(root, 'out/web-library-navigation'));
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-library-navigation-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
let fixtureRuns = 0;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_AUTH: 'none' }), {
  async readiness() { return { ready: true, message: 'Disposable Library navigation fixture; no models' }; },
  async run(input, send) {
    fixtureRuns++;
    send({ type: 'result', result: { status: 'incomplete', proof: input.input.source, report: { status: 'incomplete', fixture: true } } });
  },
  async formalize() { throw new Error('Navigation must not call a model'); },
}, { sample: loadWebSample(), mailer: async () => { throw new Error('Navigation must not send mail'); } });
const checks: object[] = [], errors: string[] = [], external: string[] = [];
let browser: Browser | undefined, page: Page | undefined, failure: unknown;
async function http<T>(method: string, pathname: string, input?: unknown): Promise<T> {
  return page!.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const value = await response.json();
    if (!response.ok) throw new Error(`Fixture HTTP ${response.status}: ${value.error}`);
    return value;
  }, { method, pathname, input }) as Promise<T>;
}
async function snapshot() {
  return page!.evaluate(() => ({ search: location.search, view: document.body.dataset.view, entry: document.body.dataset.entry,
    runIds: Array.from(document.querySelectorAll<HTMLElement>('.detail-heading[data-run]')).map(node => node.dataset.run),
    selection: document.querySelector('.composer-research-selection')?.textContent ?? '' }));
}
async function configurationLoaded(action: () => Promise<unknown>) {
  const response = page!.waitForResponse(response => new URL(response.url()).pathname === '/api/research/configuration'
    && response.request().method() === 'POST');
  await action(); assert.equal((await response).status(), 200, 'Saved Library configuration remains valid');
  await page!.waitForFunction(() => document.querySelector('.composer-research-selection')?.textContent?.includes('Navigation Skill'));
  await settled(page!);
}
async function check(name: string, action: () => Promise<void>) {
  const started = performance.now();
  try {
    await action();
    assert.equal(fixtureRuns, 1, 'Navigation must not create a research run');
    checks.push({ name, status: 'passed', elapsedMs: Math.round(performance.now() - started), ...await snapshot() });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, status: 'failed', elapsedMs: Math.round(performance.now() - started), error: String(error), ...await snapshot() });
    failure ??= error;
    console.log(`FAIL ${name}: ${error}`);
  }
  await page!.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
}
try {
  browser = await startBrowser(service.server, port);
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route(/^https?:\/\//u, async route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/library.html`);
  await page.getByRole('heading', { name: '数学库', exact: true }).waitFor();
  const { item: skill } = await http<{ item: ResearchAsset }>('POST', '/api/research/library', { requestId: crypto.randomUUID(),
    type: 'skill', name: 'Navigation Skill', visibility: 'private', content: { instructions: 'Local navigation fixture only.', slots: ['M1'] } });
  const { item: publication } = await http<{ item: ResearchPublication }>('POST', `/api/research/library/${skill.id}/publish`, {
    requestId: crypto.randomUUID(), expectedRevision: skill.revision, version: 'v1', license: 'MIT', visibility: 'private' });
  const until = Date.now() + 10_000;
  for (;;) {
    const { item } = await http<{ item: ResearchPublication }>('GET', `/api/research/publications/${publication.id}`);
    if (item.status === 'completed') break;
    assert.notEqual(item.status, 'failed', item.reason); assert.ok(Date.now() < until, 'Skill fixture publication finishes');
    await page.waitForTimeout(25);
  }
  const run = await postRun({ page }, { providerId: 'openai', apiKey: 'navigation-local-fixture', model: 'fixture', effort: 'low',
    environment: 'standard', source: 'theorem navigation_fixture : True := by sorry\n', task: 'Existing navigation research',
    maxTurns: 1, maxRunSeconds: 30, workers: 1, coordination: 'independent' });
  await waitForRun({ page }, run.id, run => run.status === 'completed');
  const { conversation } = await http<{ conversation: WebConversation }>('POST', '/api/conversations', { runId: run.id });
  await page.goto(`${origin}/library.html?entry=${skill.id}&version=v1`);
  await page.getByRole('button', { name: '加入配置选择', exact: true }).click();

  for (const [name, search] of [['existing-run', `?run=${run.id}`], ['existing-chat', `?chat=${conversation.id}`], ['sample', '?sample']] as const) {
    for (const reload of [false, true]) await check(`${name}${reload ? '-reload' : ''}`, async () => {
      await configurationLoaded(() => reload ? page!.reload() : page!.goto(`${origin}/${search}`));
      await page!.waitForFunction(() => document.body.dataset.view === 'run', undefined, { timeout: 2000 });
      const state = await snapshot();
      if (name === 'sample') {
        assert.ok(new URLSearchParams(state.search).has('sample'));
        await page!.locator('[data-chat-sample-note]').waitFor();
      } else {
        assert.ok(state.search === `?run=${run.id}` || state.search === `?chat=${conversation.id}`, 'The existing research keeps its address');
        assert.ok(state.runIds.includes(run.id), 'The requested research stays selected');
      }
    });
  }
  await check('saved-selection-new-draft', async () => {
    await configurationLoaded(() => page!.goto(origin));
    const state = await snapshot(); assert.equal(state.view, 'draft'); assert.equal(state.entry, 'lean');
    assert.equal(await page!.locator('.composer-research-selection').isVisible(), true);
    assert.ok(state.selection.includes('Navigation Skill'));
  });
  await check('library-use-in-new-research', async () => {
    await page!.goto(`${origin}/library.html?entry=${skill.id}&version=v1`);
    await configurationLoaded(() => page!.getByRole('button', { name: '用于新研究', exact: true }).click());
    const state = await snapshot(); assert.equal(state.view, 'draft'); assert.equal(state.entry, 'lean');
    assert.equal(await page!.locator('.composer-research-selection').isVisible(), true);
    assert.ok(state.selection.includes('Navigation Skill'));
  });
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  assert.deepEqual(external, [], 'The fixture stays on its own loopback origin');
} catch (error) { failure ??= error; }
finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
    mode: 'new disposable local service, real Chromium, actual saved Library selection and fixture run', paidModelCalls: false,
    fixtureRuns, checks, errors, external, ...(failure ? { error: String(failure) } : {}) }, null, 2) + '\n');
  await browser?.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
