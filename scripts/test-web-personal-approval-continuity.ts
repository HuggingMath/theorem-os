#!/usr/bin/env bun
// Every solver observation and delivery result is fixture data in disposable localhost storage.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebObservation } from '../apps/web/collaboration';
import { readingRun, readingEnvironment } from '../tests/helpers/shareReadingFixture';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { freePort, preferFullCollaboration, startBrowser } from './web-scenario';

const root = process.cwd(), output = path.resolve(process.argv[2] ?? 'output/web-personal-approval-continuity');
await fs.mkdir(output, { recursive: true });
const build = JSON.parse(await fs.readFile(path.join(root, 'out/web/build-info.json'), 'utf8'));
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-approval-continuity-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const controls = new Map<string, { observation: WebObservation; emit(): void }>();
const modes = new Map<string, 'unknown' | 'approved'>();
const commands: { runId: string; id: string; planVersion: string }[] = [];
const posts: { runId: string; id: string; planVersion: string }[] = [], checks: object[] = [], errors: string[] = [], external: string[] = [];
let prohibited = 0, phase = 'setup', active: Page | undefined, failure: unknown;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable approval continuity fixture' }; },
  async run(input, send, signal) {
    const observation = readingRun(input.id).observation!;
    observation.sequence = 1; observation.snapshot.stateDigest = mathDigest(`approval-start:${input.id}`);
    observation.inspection.configuration.environmentDigest = readingEnvironment;
    observation.inspection.planVersion = 'decision-plan-1'; observation.plan!.baseVersion = 'decision-plan-1';
    observation.guidance = []; observation.inspection.edits = [];
    observation.inspection.planApproval = { required: true, status: 'pending', planVersion: 'decision-plan-1', rejections: [], leadRevising: false };
    send({ type: 'observation', observation: structuredClone(observation) });
    await new Promise<void>(resolve => {
      controls.set(input.id, { observation, emit() {
        this.observation.sequence++; this.observation.snapshot.stateDigest = mathDigest(`approval:${input.id}:${this.observation.sequence}`);
        send({ type: 'observation', observation: structuredClone(this.observation) });
      } });
      if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
  async command(runId, command) {
    if (command.type === 'capture') return { id: 'capture', status: 'captured' };
    if (command.type !== 'plan-approval') throw new Error(`Unexpected command ${command.type}`);
    commands.push({ runId, ...command.approval });
    const status = modes.get(runId) ?? 'unknown';
    if (status === 'approved') {
      const control = controls.get(runId)!, approval = control.observation.inspection.planApproval!;
      assert.equal(command.approval.planVersion, approval.planVersion);
      Object.assign(approval, { status: 'approved', approvedId: command.approval.id, approvedVersion: command.approval.planVersion });
      control.emit();
      return { id: command.approval.id, status, planVersion: command.approval.planVersion, observation: structuredClone(control.observation) };
    }
    return { id: command.approval.id, status, reason: 'Fixture delivery cannot yet be confirmed' };
  },
  async check() { prohibited++; throw new Error('No Lean in this scenario'); },
  async formalize() { prohibited++; throw new Error('No model in this scenario'); },
  async explain() { prohibited++; throw new Error('No model in this scenario'); },
};
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '8',
  THEOREMOS_WEB_CLIENT_IP_HEADER: 'x-fixture-client' }), runner,
  { sample: null, mailer: async () => { prohibited++; throw new Error('No mail in this scenario'); } });
const browser = await startBrowser(service.server, port);
const sent = (id: string) => posts.filter(item => item.runId === id);
const delivered = (id: string) => commands.filter(item => item.runId === id);
async function http(page: Page, method: string, pathname: string, input?: unknown) {
  const result = await page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { method, pathname, input });
  assert.ok(result.status < 300, JSON.stringify(result)); return result.body;
}
async function workbench(page: Page, runId: string) {
  await page.goto(`${origin}/?run=${runId}`); await page.locator('[data-chat-approve-plan]').waitFor();
}
async function enabled(page: Page) {
  await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[data-chat-approve-plan]')?.disabled === false);
}
async function original(page: Page, id: string, status = 'unknown') {
  const record = page.locator(`[data-chat-original-plan-approval="${id}"]`); await record.waitFor();
  await page.waitForFunction(({ id, status }) => document.querySelector(`[data-chat-original-plan-approval="${id}"]`)?.textContent?.includes(status), { id, status });
  await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[data-chat-check-plan-approval]')?.disabled === false);
  assert.equal(await page.locator('[data-chat-approve-plan]').isDisabled(), true);
}
try {
  for (const [language, width] of [['zh', 1440], ['zh', 390], ['en', 1440], ['en', 390]] as const) {
    phase = `setup-${language}-${width}`;
    const context = await browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US', viewport: { width, height: 1000 }, reducedMotion: 'reduce',
      extraHTTPHeaders: { 'x-fixture-client': `approval-${language}-${width}` } });
    await context.addInitScript(language => localStorage.setItem('theorem-os.web-locale.v1', language), language); await preferFullCollaboration(context);
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
    });
    const page = await context.newPage(); active = page; page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const match = /^\/api\/runs\/([^/]+)\/plan-approval$/u.exec(new URL(request.url()).pathname);
      if (match && request.method() === 'POST') posts.push({ runId: match[1], ...request.postDataJSON() });
    });
    await page.goto(origin + '/workspace.html'); await page.locator('.workspace-tabs').waitFor();
    const cookie = (await context.cookies(origin)).find(item => item.name === 'theoremos_session')!.value;
    const research = await http(page, 'GET', '/api/research/session');
    assert.equal(research.authenticated, true); assert.equal(research.researcherId, service.research.projects.identity(cookie));
    const create = async () => {
      const run = (await http(page, 'POST', '/api/runs', { requestId: crypto.randomUUID(), providerId: 'openai', apiKey: 'sk-local-approval-fixture', model: 'fixture-approval',
        effort: 'high', source: readingRun().source.trim(), task: 'Approval continuity fixture', environment: 'standard', maxTurns: 2, maxRunSeconds: 600,
        workers: 2, coordination: 'cooperative', planApproval: true })).run;
      await page.waitForFunction(async id => Boolean((await (await fetch(`/api/runs/${id}`)).json()).run.observation), run.id); return run;
    };
    phase = `unknown-and-reload-${language}-${width}`;
    const run = await create();
    let ownerUnavailable = true;
    const ownerPath = '**/api/research/session';
    const ownerRead = async (route: import('playwright').Route) => {
      if (ownerUnavailable) { ownerUnavailable = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Controlled owner lookup interruption' }) }); }
      else await route.continue();
    };
    await page.route(ownerPath, ownerRead); await workbench(page, run.id);
    await page.locator('[data-chat-plan-decision] .chat-error').waitFor();
    assert.equal(await page.locator('[data-chat-approve-plan]').isDisabled(), true);
    assert.equal(sent(run.id).length, 0, 'Unavailable owner never sends or discards a decision');
    await page.locator('[data-chat-check-plan-approval]').click(); await enabled(page); await page.unroute(ownerPath, ownerRead);
    await page.locator('[data-chat-approve-plan]').click();
    await page.waitForFunction(() => document.querySelector('[data-chat-original-plan-approval]')?.textContent?.includes('unknown'));
    const first = delivered(run.id)[0]; assert.ok(first); await original(page, first.id);
    assert.equal(sent(run.id).length, 1);
    await page.locator('[data-chat-plan-decision]').screenshot({ path: path.join(output, `unknown-${language}-${width}.png`) });
    await page.reload(); await original(page, first.id); assert.equal(sent(run.id).length, 1);

    phase = `same-id-retry-${language}-${width}`;
    const receiptPath = `**/api/runs/${run.id}/commands/${first.id}`;
    let missing = true;
    const missingReceipt = async (route: import('playwright').Route) => {
      if (missing) { missing = false; await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Controlled missing receipt' }) }); }
      else await route.continue();
    };
    await page.route(receiptPath, missingReceipt); await page.locator('[data-chat-check-plan-approval]').click();
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[data-chat-check-plan-approval]')?.disabled === false);
    assert.equal(sent(run.id).length, 2); assert.deepEqual(sent(run.id)[1], first); assert.equal(delivered(run.id).length, 1);
    await page.unroute(receiptPath, missingReceipt);

    phase = `entry-transfer-${language}-${width}`;
    await page.goto(`${origin}/problem.html?run=${run.id}&tab=route`); await page.locator('[data-inline-open]').click();
    await page.locator('[data-inline-command-status="unknown"]').waitFor();
    assert.equal(await page.locator('[data-inline-personal-approval]').getAttribute('data-approval-request-id'), first.id);
    assert.equal(await page.locator('[data-inline-approve-plan]').isDisabled(), true);
    await page.locator('[data-inline-retry-command]').click();
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[data-inline-retry-command]')?.disabled === false);
    assert.equal(delivered(run.id).length, 1); assert.equal(sent(run.id).length, 2);
    await workbench(page, run.id); await original(page, first.id);

    phase = `changed-version-and-rejection-${language}-${width}`;
    const control = controls.get(run.id)!;
    control.observation.plan!.baseVersion = 'decision-plan-2'; control.observation.inspection.planVersion = 'decision-plan-2';
    control.observation.inspection.planApproval!.planVersion = 'decision-plan-2'; control.emit();
    await page.reload(); await original(page, first.id);
    assert.match(await page.locator('[data-chat-original-plan-approval]').innerText(), /decision-plan-1/u);
    missing = true; await page.route(receiptPath, missingReceipt); await page.locator('[data-chat-check-plan-approval]').click();
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[data-chat-check-plan-approval]')?.disabled === false);
    assert.equal(sent(run.id).length, 2, 'A new current version never replaces or resends the original approval');
    await page.unroute(receiptPath, missingReceipt);
    await page.locator('[data-chat-plan-decision]').screenshot({ path: path.join(output, `changed-plan-${language}-${width}.png`) });
    control.observation.inspection.planApproval!.rejections.push({ id: first.id, planVersion: first.planVersion, reason: 'math_plan_approval_version_conflict', at: Date.now() }); control.emit();
    await page.reload(); await page.locator('[data-chat-review-current-plan]').waitFor();
    assert.equal(await page.locator('[data-chat-approve-plan]').isDisabled(), true);
    await page.reload(); await page.locator('[data-chat-review-current-plan]').waitFor();
    assert.equal(await page.locator('[data-chat-approve-plan]').isDisabled(), true, 'Reload after a settled rejection still requires current-plan review');
    assert.equal((await page.locator('[data-chat-approve-plan]').innerText()).trim(), language === 'zh' ? '先重新核对计划' : 'Review the current plan first');
    await page.locator('[data-chat-plan-decision]').screenshot({ path: path.join(output, `rejected-after-reload-${language}-${width}.png`) });
    await page.locator('[data-chat-review-current-plan]').click(); await enabled(page);
    modes.set(run.id, 'approved'); await page.locator('[data-chat-approve-plan]').click();
    await page.locator('[data-chat-approve-plan]').waitFor({ state: 'detached' });
    assert.equal(delivered(run.id).length, 2); assert.notEqual(delivered(run.id)[1].id, first.id);
    assert.equal(delivered(run.id)[1].planVersion, 'decision-plan-2');

    phase = `network-result-and-reverse-transfer-${language}-${width}`;
    const network = await create(); await workbench(page, network.id); await enabled(page);
    const deliveryPath = `**/api/runs/${network.id}/plan-approval`;
    await page.route(deliveryPath, async route => { await route.fetch(); await route.abort('failed'); });
    await page.locator('[data-chat-approve-plan]').click();
    await page.locator('[data-chat-plan-decision] .chat-error').waitFor();
    const lost = delivered(network.id)[0]; assert.ok(lost);
    assert.equal(await page.locator('[data-chat-approve-plan]').isDisabled(), true);
    await page.unroute(deliveryPath); await page.reload(); await original(page, lost.id);
    assert.equal(sent(network.id).length, 1); assert.equal(delivered(network.id).length, 1);
    await page.goto(`${origin}/problem.html?run=${network.id}&tab=route`); await page.locator('[data-inline-open]').click();
    await page.locator('[data-inline-command-status="unknown"]').waitFor();
    assert.equal(await page.locator('[data-inline-personal-approval]').getAttribute('data-approval-request-id'), lost.id);

    const inline = await create(); await page.goto(`${origin}/problem.html?run=${inline.id}&tab=route`); await page.locator('[data-inline-open]').click();
    await page.locator('[data-inline-confirm-plan]').check(); await page.locator('[data-inline-approve-plan]').click();
    await page.locator('[data-inline-command-status="unknown"]').waitFor(); const fromInline = delivered(inline.id)[0];
    await workbench(page, inline.id); await original(page, fromInline.id); assert.equal(sent(inline.id).length, 1);
    await page.locator('[data-chat-check-plan-approval]').click();
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[data-chat-check-plan-approval]')?.disabled === false);
    assert.equal(delivered(inline.id).length, 1); assert.equal(sent(inline.id).length, 1);
    await page.locator('[data-chat-plan-decision]').screenshot({ path: path.join(output, `inline-to-workbench-${language}-${width}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'The page fits the viewport');
    for (const item of [run, network, inline]) service.jobs.cancel(cookie, item.id);
    checks.push({ language, width, anonymousOwnerMatchesRoutePage: true, unavailableOwnerShowsRecoveryAndSendsNothing: true, unknownAndReloadKeepOriginal: true, missingReceiptRetriesSameId: true,
      changedPlanCannotResendOriginal: true, rejectedReloadRequiresReview: true, reviewedCurrentPlanApprovesNormally: true,
      lostResponseKeepsOriginal: true, bothEntryDirectionsKeepOriginal: true, distinctRunsIsolated: true });
    await context.close(); console.log(`PASS personal approval continuity ${language} ${width}`);
  }
  assert.equal(prohibited, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
} catch (cause) { failure = cause; await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined); }
finally {
  await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
  if (!failure) await fs.rm(path.join(output, 'failure.png'), { force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'failed' : 'completed', phase, build, checks, commands, posts, errors, external, prohibited,
    ...(failure ? { error: String(failure) } : {}), cleanup: { browserClosed: true, serviceClosed: true, disposableDataRemoved: true, realModelCalls: 0, realLeanCalls: 0, realMailCalls: 0 } }, null, 2));
}
if (failure) throw failure;
