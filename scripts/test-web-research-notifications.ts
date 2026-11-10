#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import { readingRun, readingEnvironment } from '../tests/helpers/shareReadingFixture';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/product-continuity/research-followthrough/notifications');
await fs.mkdir(output, { recursive: true });
const build = JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8'));
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-notification-flow-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const controls = new Map<string, { finish(): void; wait(): void }>();
let prohibited = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable notification fixture' }; },
  async run(input, send, signal) {
    const recorded = readingRun(input.id), observation = recorded.observation!;
    observation.sequence = 1; observation.snapshot.stateDigest = mathDigest(`notice-start:${input.id}`);
    observation.inspection.configuration.environmentDigest = readingEnvironment;
    observation.inspection.planVersion = 'notification-plan'; observation.plan!.baseVersion = 'notification-plan';
    observation.guidance = []; observation.inspection.edits = [];
    observation.inspection.planApproval = { required: true, status: 'awaiting-plan', planVersion: 'notification-plan', rejections: [], leadRevising: false };
    send({ type: 'observation', observation: structuredClone(observation) });
    await new Promise<void>(resolve => {
      controls.set(input.id, {
        finish: () => { send({ type: 'result', result: { status: 'limit_reached', proof: recorded.result!.proof, report: {} } }); resolve(); },
        wait: () => { observation.sequence++; observation.snapshot.stateDigest = mathDigest(`notice-pending:${input.id}`);
          observation.inspection.planApproval!.status = 'pending'; send({ type: 'observation', observation: structuredClone(observation) }); },
      });
      if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
  async formalize() { prohibited++; throw new Error('No model in this fixture'); },
  async explain() { prohibited++; throw new Error('No model in this fixture'); },
  async check() { prohibited++; throw new Error('No Lean in this fixture'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '6' }), runner,
  { sample: null, mailer: async () => { prohibited++; throw new Error('No external email in this fixture'); } });
const browser = await startBrowser(service.server, port), context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
type NoticeWindow = Window & { notices: { title: string; body: string; onclick?: () => void }[]; fixtureHidden: boolean };
await context.addInitScript(() => {
  localStorage.setItem('theorem-os.web-locale.v1', 'zh');
  if (!localStorage.getItem('theorem-os.web-notify.v1')) localStorage.setItem('theorem-os.web-notify.v1', 'on');
  const scope = window as unknown as NoticeWindow; scope.notices = []; scope.fixtureHidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => scope.fixtureHidden });
  class FixtureNotification {
    static permission = 'granted';
    static async requestPermission() { throw new Error('Should retain the existing notification permission'); }
    onclick?: () => void;
    body: string;
    constructor(readonly title: string, options: NotificationOptions) { this.body = options.body ?? ''; scope.notices.push(this); }
    close() {}
  }
  Object.defineProperty(window, 'Notification', { configurable: true, value: FixtureNotification });
});
const errors: string[] = [], external: string[] = [], passed: string[] = [];
await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
const page = await context.newPage(); page.setDefaultTimeout(30_000); page.on('pageerror', error => errors.push(error.message));
const hidden = (target: Page, value: boolean) => target.evaluate(value => { (window as unknown as NoticeWindow).fixtureHidden = value; document.dispatchEvent(new Event('visibilitychange')); }, value);
const notices = (target: Page) => target.evaluate(() => (window as unknown as NoticeWindow).notices.map(item => ({ title: item.title, body: item.body })));
const mark = (text: string) => { passed.push(text); console.log(`PASS ${text}`); };
let failure: unknown;
try {
  await page.goto(`${origin}/workspace.html`); await page.locator('.workspace-tabs').waitFor();
  const owner = (await context.cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
  const session = await page.evaluate(async () => (await fetch('/api/session')).json()), provider = session.providers[0];
  const create = (title: string) => service.jobs.create(owner, { providerId: provider.id, apiKey: 'sk-fixture-not-sent', model: 'fixture-notifications', effort: 'high',
    source: readingRun().source, task: title, environment: 'standard', maxTurns: 2, maxRunSeconds: 600, workers: 1, coordination: 'cooperative' }, provider);
  const openProblem = async (id: string) => {
    const list = page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs');
    await page.goto(`${origin}/problem.html?run=${id}`); await page.locator('[data-problem-run-state="running"]').waitFor(); await list;
    await page.waitForFunction(() => document.title.includes('项进行中'));
  };

  const first = create('Reading a problem while it finishes'); await openProblem(first.id);
  await hidden(page, true); controls.get(first.id)!.finish();
  await page.waitForFunction(() => document.title.includes('研究已结束'));
  assert.equal((await notices(page)).length, 1); assert.match((await notices(page))[0].body, /Reading a problem/u);
  await page.screenshot({ path: path.join(output, 'problem-finished.png'), fullPage: true });
  const navigated = page.waitForURL(url => url.searchParams.get('run') === first.id && url.searchParams.get('tab') === 'overview');
  await page.evaluate(() => (window as unknown as NoticeWindow).notices[0].onclick!()); await navigated;
  await page.locator('[data-problem-run-state="completed"]').waitFor();
  mark('A background problem page sends completion and title reminders; clicking returns to the exact run overview');

  const shared = create('Same completion in two open pages'); await openProblem(shared.id);
  const workbench = await context.newPage(); workbench.on('pageerror', error => errors.push(error.message));
  await workbench.goto(`${origin}/?run=${shared.id}`); await workbench.locator(`#run-detail[data-render-run-id="${shared.id}"]`).waitFor({ state: 'attached' });
  await hidden(page, true); await hidden(workbench, true); controls.get(shared.id)!.finish();
  await page.waitForFunction(() => document.title.includes('研究已结束')); await workbench.waitForFunction(() => document.title.includes('研究已结束'));
  assert.equal((await notices(page)).length + (await notices(workbench)).length, 1);
  await hidden(page, false); await page.waitForFunction(() => !document.title.includes('研究已结束'));
  await workbench.close(); mark('Workbench and research pages deduplicate the same event and clear the unseen title when read');

  const pending = create('A plan needs human approval'); await openProblem(pending.id);
  await hidden(page, true); controls.get(pending.id)!.wait();
  await page.waitForFunction(() => document.title.includes('等你批准计划'));
  assert.equal((await notices(page)).length, 1); assert.match((await notices(page))[0].title, /等你批准/u);
  await page.screenshot({ path: path.join(output, 'plan-waiting.png'), fullPage: true });
  service.jobs.cancel(owner, pending.id); mark('A newly waiting plan retains the browser preference and asks for human approval');

  await page.evaluate(() => localStorage.setItem('theorem-os.web-notify.v1', 'off'));
  const muted = create('Muted browser reminders'); await openProblem(muted.id);
  await hidden(page, true); controls.get(muted.id)!.finish();
  await page.waitForFunction(() => document.title.includes('研究已结束'));
  assert.equal((await notices(page)).length, 0); mark('Opt-out suppresses desktop notifications while keeping the title indicator');
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.equal(prohibited, 0);
} catch (error) { failure = error; await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', build, passed, errors, external, prohibited,
    limitation: 'Recorded local runs and Notification substitute; no model, Lean, external email or OS delivery tested.',
    ...(failure ? { error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2));
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
if (failure) throw failure;
