#!/usr/bin/env bun
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { parse } from 'smol-toml';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { webFormalizationLimits, type WebFormalization, type WebFormalizationActivity } from '../apps/web/formalizationTypes';
import type { WebConversation } from '../apps/web/conversationTypes';
import { webLimits, type WebEnvironment, type WebRun, type WebSession } from '../apps/web/shared';

/** Opt-in paid acceptance through the real browser composer. Never part of the offline test suite. */
const problems = {
  'add-zero': '对任意自然数 n（包括 0），证明 n + 0 = n。',
  'even-sum': '对任意自然数 a、b，如果存在自然数 k 使 a = 2 * k，且存在自然数 l 使 b = 2 * l，证明存在自然数 m 使 a + b = 2 * m。',
  'add-comm': '对任意自然数 a 和 b（包括 0），证明 a + b = b + a。',
} as const;
const { values } = parseArgs({ options: { 'base-url': { type: 'string' }, 'credential-profile': { type: 'string' },
  output: { type: 'string', default: 'out/web-first-use-model' }, problem: { type: 'string' }, 'problem-file': { type: 'string' },
  environment: { type: 'string', default: 'standard' },
  'formalization-minutes': { type: 'string' }, 'formalization-tokens': { type: 'string' },
  'proof-minutes': { type: 'string' }, 'proof-tokens': { type: 'string' }, 'proof-turns': { type: 'string' },
  'allow-model': { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('bun scripts/smoke-web-first-use.ts --allow-model --base-url http://127.0.0.1:8797 --output DIR\n'
    + '  [--problem add-zero|even-sum|add-comm | --problem-file FILE] [--environment standard|mathlib] [--credential-profile DIR]\n'
    + '  [--formalization-minutes N] [--formalization-tokens N]\n'
    + '  [--proof-minutes N] [--proof-tokens N] [--proof-turns N]\n'
    + 'Uses SUB2API_WESTLAKE_API_KEY or the existing profile auth command. One problem; no automatic retry.\n'
    + 'All budgets are unlimited by default; omitted, blank or 0 disables a limit.\n'
    + 'Provider-reported token limits stop subsequent requests; in-flight requests may exceed them.\n'
    + 'Saves browser evidence, public host usage, phase timings and the downloaded verification kit.');
  process.exit(0);
}
assert.ok(values['allow-model'], 'Pass --allow-model to authorize the real-model acceptance.');
assert.ok(!(values.problem && values['problem-file']), 'Choose either --problem or --problem-file.');
const problem = values['problem-file'] ? path.basename(values['problem-file']) : values.problem ?? 'add-zero';
assert.ok(values['problem-file'] || Object.hasOwn(problems, problem), 'Choose --problem add-zero, even-sum or add-comm, or supply --problem-file.');
const original = values['problem-file'] ? fs.readFileSync(path.resolve(values['problem-file']), 'utf8') : problems[problem as keyof typeof problems];
assert.ok(original.trim(), 'The problem must contain text.');
assert.ok(['standard', 'mathlib'].includes(values.environment!), 'Choose --environment standard or mathlib.');
const environment = values.environment as WebEnvironment;
const base = new URL(values['base-url'] ?? 'http://127.0.0.1:8797');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)
  && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Use a disposable loopback instance.');
function limit(value: string | undefined, maximum: number, minimum = 1) {
  const number = Number(value ?? 0);
  assert.ok(Number.isSafeInteger(number) && (number === 0 || number >= minimum && number <= maximum),
    `Budget must be 0 (unlimited) or an integer from ${minimum} to ${maximum}.`);
  return number;
}
const budget = {
  maxRunSeconds: limit(values['formalization-minutes'], webFormalizationLimits.maxRunSeconds / 60) * 60,
  maxTotalTokens: limit(values['formalization-tokens'], webFormalizationLimits.maxTotalTokens, 10000),
  research: {
    maxRunSeconds: limit(values['proof-minutes'], webLimits.maxRunSeconds / 60) * 60,
    maxTotalTokens: limit(values['proof-tokens'], webLimits.maxTotalTokens, 10000),
    maxTurns: limit(values['proof-turns'], webLimits.maxTurns),
  },
};
const output = path.resolve(values.output!);
assert.ok(!fs.existsSync(path.join(output, 'report.json')), 'Use a new output directory to preserve the prior attempt.');
fs.mkdirSync(output, { recursive: true });
let key = process.env.SUB2API_WESTLAKE_API_KEY ?? '';
if (!key && values['credential-profile']) {
  const profile = parse(fs.readFileSync(path.join(values['credential-profile'], 'config.toml'), 'utf8')) as any;
  assert.equal(profile.model_provider, 'sub2api');
  const provider = profile.model_providers.sub2api;
  if (provider.env_key) key = process.env[provider.env_key] ?? '';
  else {
    const auth = provider.auth;
    assert.ok(auth && path.isAbsolute(auth.command) && Array.isArray(auth.args));
    try { key = execFileSync(auth.command, auth.args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch { throw new Error('Acceptance credential is unavailable.'); }
  }
}
if (!/^[\x21-\x7e]{8,4096}$/u.test(key)) throw new Error('Supply a valid credential through its existing profile or environment.');
const started = Date.now(), stages: Record<string, unknown>[] = [], writes: { method: string; pathname: string }[] = [];
const pageErrors: string[] = [], resourceErrors: string[] = [], cleanupErrors: string[] = [];
let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined;
let csrf = '', formalizationId = '', runId = '', conversationId = '', submittedAt: number | undefined;
let formalization: WebFormalization | undefined, run: WebRun | undefined, conversation: WebConversation | undefined;
let activity: WebFormalizationActivity[] = [], activityDropped = 0, interrupted = false, failure: string | undefined;
let health: unknown, download: Record<string, unknown> | undefined, passed = false;
let formalizationPosts = 0, conversationPosts = 0;
const stop = () => { interrupted = true; };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const safeText = (text: string) => text.replaceAll(key, '[REDACTED]');
function write(file: string, value: unknown) {
  const text = JSON.stringify(value, null, 2) + '\n';
  assert.ok(!text.includes(key), `Credential detected in ${file}; artifact was not written.`);
  fs.writeFileSync(path.join(output, file), text);
}
async function api<T>(route: string, body?: unknown): Promise<T> {
  const response = await context!.request.fetch(new URL(route, base).href, { method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { data: body, headers: { 'X-CSRF-Token': csrf } }), timeout: 20000, maxRedirects: 0 });
  assert.ok(response.ok(), `Acceptance HTTP ${response.status()} at ${route.split('?')[0]}`);
  return response.json() as Promise<T>;
}
async function readRecords() {
  if (formalizationId) formalization = (await api<{ formalization: WebFormalization }>(`/api/formalizations/${formalizationId}`)).formalization;
  runId = formalization?.runId ?? runId;
  if (runId) run = (await api<{ run: WebRun }>(`/api/runs/${runId}`)).run;
  if (conversationId) conversation = (await api<{ conversation: WebConversation }>(`/api/conversations/${conversationId}`)).conversation;
}
async function readActivity() {
  if (!formalizationId) return;
  let after = 0;
  activity = [];
  while (true) {
    const batch = await api<{ activity: WebFormalizationActivity[]; count: number; dropped: number }>(`/api/formalizations/${formalizationId}/activity?after=${after}`);
    activityDropped = batch.dropped;
    if (!batch.activity.length) break;
    activity.push(...batch.activity);
    const next = batch.activity.at(-1)!.sequence;
    assert.ok(next > after, 'Formalization activity cursor must advance.');
    after = next;
    if (activity.length >= batch.count) break;
  }
}
const seconds = (from?: string, to?: string) => from && to && Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to))
  ? (Date.parse(to) - Date.parse(from)) / 1000 : null;
function phaseTimings() {
  const active = new Map<string, WebFormalizationActivity>(), roles: Record<string, unknown>[] = [];
  for (const entry of activity) {
    if (entry.type !== 'step') continue;
    const step = entry.step;
    if (step.step !== 'role' && step.step !== 'compile') continue;
    const id = `${step.round}:${step.step === 'role' ? step.workerId : 'compile'}`;
    if (step.state === 'started') active.set(id, entry);
    else {
      const start = active.get(id); active.delete(id);
      roles.push({ round: step.round, stage: step.step === 'role' ? step.role : 'compile',
        ...(step.step === 'role' ? { workerId: step.workerId } : {}), state: step.state,
        startedAt: start?.at ?? null, endedAt: entry.at, seconds: seconds(start?.at, entry.at) });
    }
  }
  return { source: 'Server activity timestamps; parallel role durations overlap and must not be added as wall time.',
    formalizationSeconds: seconds(formalization?.createdAt, formalization?.finishedAt), roles,
    unfinishedStages: [...active.keys()], activityDropped,
    proofSeconds: seconds(run?.createdAt, run?.finishedAt),
    proofQueueSeconds: seconds(run?.createdAt, run?.timings?.preparing),
    proofPreparationSeconds: seconds(run?.timings?.preparing, run?.timings?.solving),
    proofSolvingSeconds: seconds(run?.timings?.solving, run?.timings?.evaluating),
    independentEvaluationSeconds: seconds(run?.timings?.evaluating, run?.finishedAt),
    serverSolveWallMs: run?.result?.report.solveWallMs ?? null };
}
function validateAcceptance() {
  assert.equal(formalization?.original, original);
  assert.equal(formalization?.status, 'confirmed');
  assert.equal(formalization?.confirmation, 'automatic', 'Never bypass model review by manually confirming.');
  const report = formalization!.report!;
  assert.equal(report.original, original);
  assert.equal(report.reviews.length, 2);
  assert.equal(new Set(report.reviews.map(review => review.reviewer)).size, 2);
  assert.ok(report.reviews.every(review => review.verdict === 'approved' && review.issues.length === 0), 'Both statement reviewers must approve.');
  assert.equal(run?.status, 'completed'); assert.equal(run?.result?.status, 'evaluated_passed');
  assert.equal(run?.formalizationId, formalization!.id);
  assert.equal(run?.formalization?.evidenceSha256, report.evidenceSha256);
  assert.equal(run?.source, report.statement);
  const evaluator = run!.result!.report.evaluator as any;
  assert.equal(evaluator.status, 'passed'); assert.equal(evaluator.method, 'host-lean-kernel-all-targets');
  assert.equal(evaluator.verification.passed, true);
  const targets = evaluator.verification.verification.results as { theoremName: string; status: string; sorryCount: number; admitCount: number; axioms?: { name: string }[] }[];
  assert.deepEqual(targets.map(target => target.theoremName).sort(), report.targets.map(target => target.name).sort());
  assert.ok(targets.length && targets.every(target => target.status === 'kernel_verified' && target.sorryCount === 0
    && target.admitCount === 0 && !target.axioms?.some(axiom => axiom.name === 'sorryAx')), 'Independent Lean must verify every target without sorry/admit.');
  assert.equal(conversation?.formalizationId, formalization!.id); assert.equal(conversation?.runId, runId);
  assert.equal(conversation?.messages[0]?.text, original);
}
function checkKit(filename: string) {
  // Python's standard ZIP reader checks its directory and CRCs. No executable from the archive is run.
  const files = JSON.parse(execFileSync('/usr/bin/python3', ['-c',
    'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None, "ZIP CRC failure"\n names=z.namelist()\n assert len(names)==len(set(names)), "duplicate ZIP entries"\n print(json.dumps({n:z.read(n).decode("utf-8") for n in names}))', filename],
  { encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 })) as Record<string, string>;
  const prefix = `theoremos-${runId.slice(0, 8)}/`, trustedEnvironment = getLeanTaskEnvironment(environment);
  const expected = [...Object.keys(trustedEnvironment.files), 'Submission.lean', 'Original.lean', 'Check.lean', 'README.txt', 'report.json'];
  assert.deepEqual(Object.keys(files).sort(), expected.map(name => prefix + name).sort());
  assert.equal(files[prefix + 'Submission.lean'], run!.result!.proof);
  assert.equal(files[prefix + 'Original.lean'], run!.source);
  assert.deepEqual(JSON.parse(files[prefix + 'report.json']), run!.result!.report);
  for (const [name, content] of Object.entries(trustedEnvironment.files)) assert.equal(files[prefix + name], content);
  assert.match(files[prefix + 'Check.lean'], /^import Submission\n/mu);
  const identifier = (name: string) => name.split('.').map(part => /^[\p{L}_][\p{L}\p{N}_'!?]*$/u.test(part) ? part : `«${part}»`).join('.');
  assert.deepEqual(files[prefix + 'Check.lean'].split('\n').filter(line => line.startsWith('#print axioms ')),
    formalization!.report!.targets.map(target => `#print axioms ${identifier(target.name)}`));
  const extract = path.join(output, 'verification-kit'); fs.mkdirSync(extract);
  for (const name of expected) {
    assert.ok(!files[prefix + name].includes(key), 'Credential found in verification kit.');
    fs.mkdirSync(path.dirname(path.join(extract, name)), { recursive: true }); fs.writeFileSync(path.join(extract, name), files[prefix + name]);
  }
  return { sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), bytes: fs.statSync(filename).size,
    entries: expected, crcChecked: true, sourceMatchesFrozenStatement: true, proofMatchesAcceptedResult: true,
    reportMatchesIndependentAcceptance: true, pinnedEnvironmentMatches: true };
}
try {
  // Playwright's default SIGINT handler calls process.exit(130), skipping our task cancellation and report.
  browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', acceptDownloads: true, reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('theorem-os.web-locale.v1', 'zh'));
  const session = await api<WebSession>('/api/session'); csrf = session.csrfToken;
  assert.equal(session.auth, 'none', 'Use disposable data with no production account.'); assert.equal(session.runtime.ready, true);
  health = await api('/healthz');
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => pageErrors.push(safeText(error.message)));
  page.on('response', response => { if (response.status() >= 400) resourceErrors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (method !== 'GET') {
      writes.push({ method, pathname: url.pathname });
      let allowed = url.origin === base.origin && method === 'POST';
      if (url.pathname === '/api/formalizations') {
        const body = request.postDataJSON();
        allowed &&= ++formalizationPosts === 1 && body.original === original && body.solve === true && body.environment === environment
          && body.maxRunSeconds === budget.maxRunSeconds && body.maxTotalTokens === budget.maxTotalTokens
          && Object.entries(budget.research).every(([name, value]) => body.research?.[name] === value);
      } else if (url.pathname === '/api/conversations') allowed &&= ++conversationPosts === 1;
      else allowed &&= url.pathname === '/api/providers/sub2api/check';
      if (!allowed) { resourceErrors.push(`Blocked unexpected write ${method} ${url.pathname}`); await route.abort(); return; }
    }
    await route.continue();
  });
  await page.goto(base.href, { waitUntil: 'load' }); await page.locator('#formalize-original').waitFor();
  assert.equal(await page.locator('body').getAttribute('data-entry'), 'natural');
  await page.locator('#formalize-original').fill(original); await page.locator('#formalize-settings > summary').click();
  await page.locator('#formalize-provider').selectOption('sub2api'); await page.locator('#formalize-model').fill('deepseek-flash');
  await page.locator('#formalize-environment').selectOption(environment); await page.locator('#formalize-effort').selectOption('max');
  await page.locator('#formalize-key').fill(key);
  for (const [selector, value] of Object.entries({ '#formalize-minutes': budget.maxRunSeconds / 60, '#formalize-tokens': budget.maxTotalTokens,
    '#research-minutes': budget.research.maxRunSeconds / 60, '#research-tokens': budget.research.maxTotalTokens, '#research-turns': budget.research.maxTurns }))
    await page.locator(selector).fill(value === 0 ? '' : String(value));
  const check = page.waitForResponse(response => new URL(response.url()).pathname === '/api/providers/sub2api/check');
  await page.locator('#check-model-connection').click(); write('connection.json', await (await check).json());
  await page.locator('#chat-connection-result').waitFor(); await page.locator('#formalize-settings > summary').click();
  await page.screenshot({ path: path.join(output, '01-original.png'), fullPage: true, mask: [page.locator('#formalize-key')] });
  if (interrupted) throw new Error('Acceptance interrupted before submission.');
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/formalizations' && response.request().method() === 'POST');
  submittedAt = Date.now(); await page.locator('#formalize-start:enabled').click();
  const response = await created; assert.ok(response.ok(), `Natural-language submission returned HTTP ${response.status()}.`);
  formalization = (await response.json()).formalization; formalizationId = formalization!.id;
  await page.waitForURL(url => url.searchParams.has('chat')); conversationId = new URL(page.url()).searchParams.get('chat')!;
  write('attempt.json', { problem, original, submittedAt: new Date(submittedAt).toISOString(), formalizationId, conversationId, budget });
  const deadline = budget.maxRunSeconds && budget.research.maxRunSeconds
    ? submittedAt + (budget.maxRunSeconds + budget.research.maxRunSeconds + 180) * 1000 : Infinity;
  let last = '';
  while (!interrupted && Date.now() < deadline) {
    await readRecords();
    const state = { formalization: formalization?.status, phase: formalization?.progress?.phase, tokens: formalization?.progress?.tokens,
      ...(run ? { proof: run.status, proofPhase: run.phase } : {}) };
    if (JSON.stringify(state) !== last) {
      last = JSON.stringify(state); const stage = { at: new Date().toISOString(), elapsedSeconds: (Date.now() - submittedAt) / 1000, ...state };
      stages.push(stage); console.log(JSON.stringify(stage)); write('stages.json', stages);
    }
    if (['error', 'cancelled', 'exhausted', 'review'].includes(formalization!.status) || formalization?.researchError
      || run && ['completed', 'error', 'cancelled'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (interrupted) throw new Error('Acceptance interrupted.');
  if (Date.now() >= deadline) throw new Error('Acceptance exceeded both budgets plus 180 seconds for handoff and evaluation.');
  validateAcceptance();
  await page.locator('.research-conversation-status[data-accepted="true"]').waitFor();
  assert.match(await page.locator('[data-statement-verdict]').innerText(), /模型审核通过，未经人工确认/u);
  await page.locator('[data-research-artifact="original"]').click(); await page.locator('#chat-original-panel').waitFor();
  await page.screenshot({ path: path.join(output, '02-reviewed-statement.png'), fullPage: true });
  await page.locator('#close-research-output').click(); await page.locator('[data-research-artifact="source"]:enabled').click();
  await page.locator('[data-detail-tab="result"]').click();
  const link = page.locator(`a[download][href="/api/runs/${runId}/verification-kit"]`); await link.waitFor();
  await page.screenshot({ path: path.join(output, '03-independent-acceptance.png'), fullPage: true });
  const downloadStarted = Date.now(), event = page.waitForEvent('download'); await link.click(); const kit = await event;
  const filename = path.join(output, 'verification-kit.zip'); await kit.saveAs(filename); assert.equal(await kit.failure(), null);
  download = { filename: 'verification-kit.zip', suggestedFilename: kit.suggestedFilename(), seconds: (Date.now() - downloadStarted) / 1000, ...checkKit(filename) };
  assert.equal(formalizationPosts, 1); assert.equal(conversationPosts, 1); assert.deepEqual(pageErrors, []); assert.deepEqual(resourceErrors, []);
  passed = true;
} catch (error) {
  failure = safeText(error instanceof Error ? error.message : String(error));
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, mask: [page.locator('#formalize-key')] }).catch(() => {});
  process.exitCode = 1;
} finally {
  // Cancel only active tasks owned by this attempt. Successful acceptance is not mutated.
  const cleanupError = (error: unknown) => { cleanupErrors.push(safeText(String(error))); };
  if (submittedAt && !formalizationId) {
    // A lost create response may still have started work. Reconcile it without resubmitting.
    await api<{ formalizations: WebFormalization[] }>('/api/formalizations').then(({ formalizations }) => {
      const matching = formalizations.filter(item => item.original === original && Date.parse(item.createdAt) >= submittedAt!
        && item.providerId === 'sub2api' && item.maxRunSeconds === budget.maxRunSeconds && item.maxTotalTokens === budget.maxTotalTokens);
      assert.ok(matching.length <= 1, 'Ambiguous task creation; inspect the disposable service before retrying.');
      if (matching[0]) { formalization = matching[0]; formalizationId = matching[0].id; }
    }).catch(cleanupError);
  }
  if (formalizationId) {
    await readRecords().catch(cleanupError);
    if (formalization && ['queued', 'running'].includes(formalization.status))
      await api(`/api/formalizations/${formalizationId}/cancel`, {}).catch(cleanupError);
    // Approval can hand off to proof while cancellation is being requested.
    await readRecords().catch(cleanupError);
    if (run && ['queued', 'running'].includes(run.status)) await api(`/api/runs/${runId}/cancel`, {}).catch(cleanupError);
    await readRecords().catch(cleanupError); await readActivity().catch(cleanupError);
  }
  if (formalization) write('formalization.json', formalization);
  if (run) write('run.json', run);
  if (conversation) write('conversation.json', conversation);
  write('activity.json', { activity, dropped: activityDropped });
  const usage = { formalization: { reportedTotalTokens: formalization?.progress?.tokens ?? null,
    source: 'Host progress derived from provider-reported session usage; this endpoint exposes an aggregate, not request receipts.',
    coverage: 'Final progress snapshot; per-request completeness is not exposed here.' },
    proof: { usage: run?.result?.report.usage ?? null, tokenBudget: run?.result?.report.tokenBudget ?? null,
      source: 'Run report host accounting; tokenBudget.usageComplete states aggregate coverage when present.' },
    providerReceiptCoverage: 'Per-request receipt capture is separate; absence is not zero usage.',
    cost: { status: 'unknown', amount: null, currency: null,
      reason: 'No provider billed amount or verified applicable price table is exposed here. Model-written token or money claims are not billing evidence.' } };
  write('usage.json', usage);
  write('report.json', { passed: passed && cleanupErrors.length === 0, checkedAt: new Date().toISOString(), health,
    entry: 'Browser natural-language composer → conversation → automatic model review → independent Lean acceptance → browser ZIP download',
    problem, original, provider: 'sub2api', model: 'deepseek-flash', environment, budgets: budget,
    submitted: submittedAt !== undefined, elapsedSeconds: (Date.now() - started) / 1000,
    submittedToEvidenceSeconds: submittedAt === undefined ? null : (Date.now() - submittedAt) / 1000,
    formalizationId, runId, conversationId, stages, timings: phaseTimings(), usage, download,
    browser: { pageErrors, resourceErrors, writes }, cleanupErrors, failure,
    note: 'One first-use problem; unlimited budgets by default. Not a benchmark or an OpenAI compatibility result.' });
  await browser?.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); key = '';
  if (cleanupErrors.length) process.exitCode = 1;
  console.log(JSON.stringify({ passed: passed && cleanupErrors.length === 0, formalizationId, runId, failure, report: path.join(output, 'report.json') }));
}
