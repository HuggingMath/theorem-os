import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebFormalization, WebFormalizationBackgroundReview } from '../apps/web/formalizationTypes';
import { webFormalizationDefaults, webFormalizationLimits } from '../apps/web/formalizationTypes';
import type { WebFormalizationReport } from '../apps/web/shared';

const root = path.resolve(import.meta.dirname, '..');
const client = path.join(root, 'apps/web/client');
const output = path.resolve(root, '../formalization-latency-20261108-artifacts/background-review-20261109');
const original = 'Let K be a field of characteristic zero. A polynomial is solvable by radicals if and only if its Galois group is solvable.';
const statement = 'theorem criterion (n : Nat) : n + 0 = n := by\n  sorry\n';
const at = '2026-11-09T04:00:00Z';
const evidenceSha256 = 'a'.repeat(64), sourceSha256 = 'b'.repeat(64);
const background = (status: WebFormalizationBackgroundReview['status']): WebFormalizationBackgroundReview => ({
  status, evidenceSha256, sourceSha256, queuedAt: at,
  ...(status === 'changes_requested' ? { finishedAt: at, result: {
    schema: 'theorem-os.formalization-audit.v1', evidenceSha256, sourceSha256, snapshotDigest: 'c'.repeat(64),
    originalSha256: 'd'.repeat(64), environmentDigest: 'e'.repeat(64), model: 'fixture', effort: 'max', startedAt: at, finishedAt: at,
    session: { threadId: 'independent-review-fixture', turnId: 'review-turn', status: 'completed',
      inputDigest: 'f'.repeat(64), outputDigest: '1'.repeat(64), usage: {} },
    review: { verdict: 'changes_requested', summary: 'The statement does not express the Galois criterion.',
      checks: { domains: false, assumptions: false, conclusions: false, definitions: false, quantifierScope: false, instanceCoherence: false },
      issues: [{ aspect: 'conclusions', originalFragment: original, leanFragment: 'n + 0 = n', explanation: 'A natural-number identity does not state the requested field-theoretic equivalence.' }] },
  } } : {}),
});
function formalization(status: WebFormalization['status']): WebFormalization {
  const review = background('running');
  const report: WebFormalizationReport = { schema: 'theorem-os.web-formalization-report.v1', problemId: 'criterion', original, statement,
    environment: 'standard', toolchain: 'leanprover/lean4:v4.19.0', mathlibRevision: null, model: 'fixture', effort: 'max', rounds: 1,
    targets: [{ name: 'criterion', lines: { start: 1, end: 2 } }], correspondences: [], coverage: [], backtranslation: null, reviews: [],
    semanticReview: 'not-performed', evidenceSha256, approvedAt: at, backgroundReview: review };
  return { id: '11111111-1111-4111-8111-111111111111', original, environment: 'standard', model: 'fixture', effort: 'max',
    reviewMode: 'direct', status, createdAt: at, updatedAt: at, report, backgroundReview: review };
}
const capabilities = { available: true, model: 'fixture', providerId: 'fixture', key: 'server', limits: webFormalizationLimits,
  defaults: webFormalizationDefaults, providers: [{ id: 'fixture', name: 'Fixture', baseUrl: 'http://fixture.invalid', defaultModel: 'fixture', key: 'server' }] };

let browser: Browser, service: http.Server, origin: string;
beforeAll(async () => {
  const [standalone, chat] = await Promise.all([
    build({ entryPoints: [path.join(client, 'formalize.ts')], bundle: true, write: false, platform: 'browser', target: 'es2023', jsx: 'automatic', jsxImportSource: 'preact' }),
    build({ stdin: { resolveDir: client, loader: 'ts', contents: `
      import { ChatSession } from './chatSession';
      import { agentRoutes, mergeAgentActions } from './agentRoute';
      const noop = () => {};
      const listeners = new Set();
      const activity = { actions: [], version: 0 };
      const session = new ChatSession({
        request: async (url, init) => { const response = await fetch(url, init); if (!response.ok) throw new Error('Unexpected fixture request: ' + url); return response.json(); },
        draftScope: 'background-review-fixture', keyRequired: () => false, session: () => undefined,
        runs: () => [], onOpenRun: noop, connected: () => true,
        onSelection: noop, onConversation: noop, onNavigate: noop,
        onArtifact: kind => { document.body.dataset.chatArtifact = kind; }, onShare: noop,
        onRecover: noop, onKeysChanged: noop, onSample: noop, onHistory: noop, onLean: noop, onGuidance: noop, onCancelRun: noop,
        planApproval: () => undefined, onApprovePlan: noop, onPlan: noop,
        isSample: () => false,
        agentActivity: {
          subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, sync: noop,
          records: run => ({ events: run.events || [], actions: mergeAgentActions(activity.actions) }),
          routes: run => agentRoutes(run.events || [], { actions: activity.actions }),
          state: () => ({ version: activity.version }),
        },
        formalizationActivity: { subscribe: noop, sync: noop, state: () => ({}), activity: () => [] },
      });
      window.fixtureSession = session;
      window.fixtureActions = actions => {
        activity.actions = actions; activity.version++;
        for (const listener of listeners) listener('proof-fixture');
      };
      session.start();
    ` }, bundle: true, write: false, platform: 'browser', target: 'es2023', jsx: 'automatic', jsxImportSource: 'preact' }),
  ]);
  const bundles = new Map([['/formalize.js', standalone.outputFiles[0]!.contents], ['/fixture-chat.js', chat.outputFiles[0]!.contents]]);
  service = http.createServer(async (request, response) => {
    const pathname = new URL(request.url!, 'http://fixture').pathname;
    const bundle = bundles.get(pathname);
    if (bundle) { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(bundle); return; }
    if (pathname === '/chat-fixture.html') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><html><head><link rel="stylesheet" href="app.css"><link rel="stylesheet" href="research-conversation.css"></head><body><main><div id="research-chat-thread"></div><button data-chat-latest hidden>Latest</button><section id="natural-research"></section><nav id="chat-history-list"></nav><section id="chat-original-panel"></section><section id="chat-live-panel"></section></main><script src="fixture-chat.js"></script></body></html>'); return;
    }
    if (pathname === '/theme.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(); return; }
    const file = pathname === '/formalize.html' ? 'formalize.html' : pathname.slice(1);
    if (['formalize.html', 'app.css', 'formalize.css', 'research-conversation.css'].includes(file)) {
      response.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : 'text/css' }); response.end(await fs.readFile(path.join(client, file))); return;
    }
    response.writeHead(204); response.end();
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
  await fs.mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, timeout: 20_000 });
});
afterAll(async () => { await browser?.close(); if (service) await new Promise<void>(resolve => service.close(() => resolve())); });

async function pageFixture(item: WebFormalization, locale: 'zh' | 'en' = 'zh', proofRunning = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  context.setDefaultTimeout(5_000); context.setDefaultNavigationTimeout(15_000);
  await context.addInitScript(language => localStorage.setItem('theorem-os.web-locale.v1', language), locale);
  const page = await context.newPage(), errors: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const conversation = { id: 'chat-fixture', title: 'Galois criterion', createdAt: at, updatedAt: at, formalizationId: item.id, runId: 'proof-fixture', messages: [
    { id: 'question', role: 'user', kind: 'text', text: original, createdAt: at, status: 'complete' },
    { id: 'task', role: 'assistant', kind: 'task', text: '', createdAt: at, status: 'complete' },
  ] };
  const run = { id: 'proof-fixture', title: 'Galois criterion', status: proofRunning ? 'running' : 'completed', phase: proofRunning ? 'solving' : 'finished', createdAt: at, updatedAt: at,
    providerId: 'fixture', model: 'fixture', effort: 'max', environment: 'standard', source: statement, task: original,
    formalizationId: item.id, formalization: { id: item.id, original, evidenceSha256, reviewMode: 'direct', confirmedAt: at },
    maxTurns: 0, maxRunSeconds: 0, workers: 1, events: [], result: proofRunning ? undefined : { status: 'evaluated_passed', proof: statement.replace('sorry', 'simp'), report: {} } };
  let detailReads = 0;
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push(pathname);
    const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/api/session') return json({ csrfToken: 'fixture-csrf', auth: 'none' });
    if (pathname === '/api/research/overview') return json({ projects: [], notifications: [] });
    if (pathname === '/api/formalizations') return json({ formalizations: [{ ...item, report: undefined }], generation: capabilities });
    if (pathname === `/api/formalizations/${item.id}/confirm`) { item.status = 'confirmed'; return json({ formalization: item }); }
    if (pathname === `/api/formalizations/${item.id}`) { detailReads++; return json({ formalization: item }); }
    if (pathname === '/api/conversations') return json({ conversations: [{ ...conversation, messages: undefined, answering: false }] });
    if (pathname === '/api/conversations/chat-fixture') return json({ conversation });
    if (pathname === '/api/runs/proof-fixture') return json({ run });
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: `Unexpected fixture request: ${pathname}` }) });
  });
  return { context, page, errors, writes, reads: () => detailReads };
}
async function downloadedStatement(page: Page, selector: string) {
  const received = page.waitForEvent('download'); await page.locator(selector).click();
  const download = await received;
  expect(download.suggestedFilename()).toMatch(/\.lean$/u);
  expect(await fs.readFile((await download.path())!, 'utf8')).toBe(statement);
}
async function close(context: BrowserContext, errors: string[]) { await context.close(); expect(errors).toEqual([]); }

describe('background review browser workflow', () => {
  it('shows complete proof check details and keeps individual and global folding choices as actions update', async () => {
    const item = formalization('confirmed'); item.runId = 'proof-fixture';
    const { page, context, errors } = await pageFixture(item, 'zh', true);
    const checked = { workerId: 'solver', itemId: 'proof-check', at, sequence: 1,
      kind: 'command', command: 'theorem-os check-lean --file Submission.lean',
      phase: 'completed', status: 'failed', output: 'Full compiler output retained for this check.',
      lean: { passed: false, messages: [
        { severity: 'error', text: 'First proof error', line: 1 },
        { severity: 'error', text: 'Second proof error', line: 2 },
        { severity: 'warning', text: 'Proof warning', line: 3 },
        { severity: 'info', text: 'Proof information', line: 4 },
      ] } };
    const command = (sequence: number) => ({ workerId: 'solver', itemId: `tool-${sequence}`, at, sequence,
      kind: 'command', command: `rg proof-${sequence} Mathlib`, output: `Result ${sequence}`, phase: 'completed', status: 'done' });
    const send = async (actions: object[]) => page.evaluate(actions => {
      (window as unknown as { fixtureActions(actions: object[]): void }).fixtureActions(actions);
    }, actions);
    try {
      await page.goto(`${origin}/chat-fixture.html?chat=chat-fixture`);
      const thinking = page.locator('[data-thinking-process]');
      await thinking.waitFor();
      await send([checked]);
      const detail = thinking.locator('[data-thinking-detail="check:p:solver:proof-check"]');
      await detail.locator('.route-lean').waitFor();
      expect(await detail.getAttribute('open')).not.toBeNull();
      const text = await detail.innerText();
      for (const value of [checked.command, checked.output, ...checked.lean.messages.map(message => message.text)]) expect(text).toContain(value);
      expect(await thinking.locator('[data-thinking-kind="check"]').count()).toBe(1);
      expect(await thinking.locator('[data-thinking-kind="action"]').count()).toBe(0);
      await detail.locator(':scope > summary').click();
      await send([{ ...checked, output: `${checked.output}\nLater output.` }, command(2)]);
      const second = thinking.locator('[data-thinking-detail="prove:solver:tool-2"]');
      await second.locator('.route-output').waitFor();
      expect(await detail.getAttribute('open')).toBeNull();
      expect(await second.getAttribute('open')).not.toBeNull();
      await thinking.locator('[data-thinking-options] > summary').click();
      await thinking.locator('[data-thinking-collapse-all]').click();
      await send([checked, command(2), command(3)]);
      const third = thinking.locator('[data-thinking-detail="prove:solver:tool-3"]');
      await third.waitFor();
      expect(await third.getAttribute('open')).toBeNull();
      expect(await thinking.locator('[data-thinking-detail][open]').count()).toBe(0);
      await thinking.locator('[data-thinking-options] > summary').click();
      await thinking.locator('[data-thinking-expand-all]').click();
      await third.locator('.route-output').waitFor();
      expect(await thinking.locator('[data-thinking-detail][open]').count()).toBe(3);
      expect(await detail.innerText()).toContain('Second proof error');
    } finally { await close(context, errors); }
  });

  it('updates public proof summaries even when the merged action count and run timestamp stay unchanged', async () => {
    const item = formalization('confirmed'); item.runId = 'proof-fixture';
    const { page, context, errors } = await pageFixture(item, 'zh', true);
    const send = async (text: string, completed = false) => page.evaluate(({ text, completed, at }) => {
      (window as unknown as { fixtureActions(actions: object[]): void }).fixtureActions([{
        workerId: 'solver', itemId: 'public-summary', at, sequence: completed ? 2 : 1,
        kind: 'reasoning', textSource: 'summary', text, phase: completed ? 'completed' : 'started', status: completed ? 'done' : 'running',
      }]);
    }, { text, completed, at });
    try {
      await page.goto(`${origin}/chat-fixture.html?chat=chat-fixture`);
      const thinking = page.locator('[data-thinking-process]');
      await thinking.waitFor();
      const diagnostics = page.locator('[data-solve-process]');
      await diagnostics.locator(':scope > summary').click();
      expect(await diagnostics.getAttribute('open')).toBeNull();
      await send('核对证明中使用的域与群的定义。');
      await thinking.locator('[data-thinking-kind="summary"]').filter({ hasText: '核对证明中使用的域与群的定义。' }).waitFor();
      expect(await thinking.locator('[data-thinking-kind="summary"]').count()).toBe(1);
      await thinking.locator(':scope > summary').click();
      expect(await thinking.getAttribute('open')).toBeNull();
      await send('定义已核对，接下来检查引理的假设。', true);
      await thinking.locator('.thinking-preview').filter({ hasText: '定义已核对，接下来检查引理的假设。' }).waitFor();
      expect(await thinking.getAttribute('open')).toBeNull();
      await thinking.locator(':scope > summary').click();
      await thinking.locator('[data-thinking-kind="summary"]').waitFor();
      expect(await thinking.locator('[data-thinking-kind="summary"]').count()).toBe(1);
      expect(await thinking.locator('[data-thinking-kind="summary"]').innerText()).toContain('定义已核对，接下来检查引理的假设。');
      expect(await thinking.locator('[data-thinking-kind="summary"]').innerText()).not.toContain('核对证明中使用的域与群的定义。');
      expect(await page.locator('[data-solve-process]').getAttribute('open')).toBeNull();
    } finally { await close(context, errors); }
  });

  it('keeps a compiled standalone statement usable and refreshes a later review with the same evidence digest', async () => {
    const item = formalization('review');
    const { page, context, errors, writes, reads } = await pageFixture(item);
    try {
      await page.goto(`${origin}/formalize.html?id=${item.id}`);
      await page.locator('[data-background-review="running"]').waitFor();
      const code = await page.locator('#formalize-code').innerText();
      await page.locator('#formalize-code .lean-row').first().evaluate(node => { (node as HTMLElement).dataset.retained = 'compiled'; });
      await downloadedStatement(page, '[data-download-statement]');
      await page.locator('#formalize-checked').check();
      expect(await page.locator('#formalize-confirm').isEnabled()).toBe(true);
      await page.locator('#formalize-confirm').click();
      await page.locator('#formalize-use[aria-disabled="false"]').waitFor();
      expect(item.backgroundReview!.status).toBe('running');
      expect(await page.locator('#formalize-start').isEnabled()).toBe(true);
      expect(writes).toEqual([`/api/formalizations/${item.id}/confirm`]);
      item.backgroundReview = background('changes_requested'); item.report!.backgroundReview = item.backgroundReview;
      await page.locator('[data-background-review="changes_requested"]').waitFor();
      expect(await page.locator('#formalize-prose').innerText()).toContain('does not express the Galois criterion');
      expect(await page.locator('#formalize-code').innerText()).toBe(code);
      expect(await page.locator('#formalize-code .lean-row').first().getAttribute('data-retained')).toBe('compiled');
      expect(await page.locator('#formalize-use').getAttribute('aria-disabled')).toBe('false');
      expect(reads()).toBeGreaterThan(1);
      await page.locator('#formalize-original').fill('A new problem while the advisory review has finished.');
      expect(await page.locator('#formalize-start').isEnabled()).toBe(true);
      await page.screenshot({ path: path.join(output, 'standalone-background-changes.png'), fullPage: true });
    } finally { await close(context, errors); }
  });

  it('keeps polling after proof completion and preserves code when a background reviewer requests changes', async () => {
    const item = formalization('confirmed'); item.runId = 'proof-fixture';
    const { page, context, errors, writes, reads } = await pageFixture(item, 'en');
    try {
      await page.goto(`${origin}/chat-fixture.html?chat=chat-fixture`);
      await page.locator('#research-chat-thread [data-background-review="running"]').waitFor();
      await page.locator('#research-chat-thread [data-research-artifact="original"]').click();
      await page.locator('#chat-original-panel [data-background-review="running"]').waitFor();
      const code = await page.locator('#chat-original-panel .chat-original-columns pre code').innerText();
      await downloadedStatement(page, '#chat-original-panel [data-download-statement]');
      await page.evaluate(() => { const session = (window as unknown as { fixtureSession: { home(reset: boolean): void; fillOriginal(text: string): void } }).fixtureSession; session.home(true); session.fillOriginal('Prove another statement.'); });
      expect(await page.locator('#formalize-start').isEnabled()).toBe(true);
      await page.evaluate(() => (window as unknown as { fixtureSession: { open(id: string): Promise<void> } }).fixtureSession.open('chat-fixture'));
      await page.locator('#research-chat-thread [data-background-review="running"]').waitFor();
      await page.locator('#research-chat-thread [data-research-artifact="original"]').click();
      item.backgroundReview = background('changes_requested'); item.report!.backgroundReview = item.backgroundReview;
      await page.locator('#research-chat-thread [data-background-review="changes_requested"]').waitFor();
      await page.locator('#chat-original-panel [data-background-review="changes_requested"]').waitFor();
      expect(await page.locator('#chat-original-panel .chat-original-columns pre code').innerText()).toBe(code);
      expect(await page.locator('#research-chat-thread').innerText()).toContain('Background review: changes needed');
      expect(await page.locator('#research-chat-thread').innerText()).not.toContain('no independent semantic review');
      expect(writes).toEqual([]); expect(reads()).toBeGreaterThan(2);
      await downloadedStatement(page, '#chat-original-panel [data-download-statement]');
      await page.screenshot({ path: path.join(output, 'chat-background-changes-en.png'), fullPage: true });
    } finally { await close(context, errors); }
  });
});
