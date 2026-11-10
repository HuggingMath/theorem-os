#!/usr/bin/env bun
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Cookie, type Page } from 'playwright';
import { parse } from 'smol-toml';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import type { WebFormalization, WebFormalizationActivity } from '../apps/web/formalizationTypes';
import type { WebConversation, WebConversationSummary } from '../apps/web/conversationTypes';
import type { WebRun, WebSession } from '../apps/web/shared';
import { demoOriginal } from './fixtures/cantorBernsteinDemo';
import { openAdvancedChatSettings } from './web-ui-controls';

/** Opt-in real-model browser run. The fixture contributes only its original problem, never a solution. */
const { values } = parseArgs({ options: {
  'base-url': { type: 'string' }, output: { type: 'string' }, 'credential-profile': { type: 'string' },
  'allow-model': { type: 'boolean' }, resume: { type: 'boolean' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('bun scripts/run-web-cantor-bernstein-real.ts --allow-model --base-url http://127.0.0.1:8797 --output DIR --credential-profile DIR [--resume]\n'
    + 'One real natural-language submission; all five budget fields remain blank (unlimited).\n'
    + 'No observation deadline, retry submission, cancellation, service restart or generated explanation.\n'
    + '--resume reuses the original task and private anonymous session.json; keep that file private.');
  process.exit(0);
}
assert.ok(values['allow-model'], 'Pass --allow-model for this real-model browser run.');
assert.ok(values.output && values['base-url'] && values['credential-profile'], 'Supply --base-url, --output and --credential-profile.');
const base = new URL(values['base-url']);
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)
  && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Use an isolated loopback instance.');
const output = path.resolve(values.output);
const attemptFile = path.join(output, 'attempt.json'), sessionFile = path.join(output, 'session.json');
const budgets = { maxRunSeconds: 0, maxTotalTokens: 0, research: { maxRunSeconds: 0, maxTotalTokens: 0, maxTurns: 0 } };
type Attempt = {
  schema: 'theorem-os.cantor-bernstein-real.v1'; baseUrl: string; original: string;
  provider: 'sub2api'; model: 'deepseek-flash'; effort: 'max'; environment: 'mathlib'; budgets: typeof budgets;
  startedAt: string; submittedAt?: string; formalizationId?: string; runId?: string; conversationId?: string;
  formalizationPosts: number; submittedBudgetVerified: boolean;
};
let attempt: Attempt;
if (values.resume) {
  assert.ok(fs.existsSync(attemptFile) && fs.existsSync(sessionFile), 'Resume requires the original attempt.json and private session.json.');
  attempt = JSON.parse(fs.readFileSync(attemptFile, 'utf8')) as Attempt;
  assert.equal(attempt.schema, 'theorem-os.cantor-bernstein-real.v1'); assert.equal(attempt.baseUrl, base.href);
  assert.equal(attempt.original, demoOriginal); assert.equal(attempt.provider, 'sub2api');
  assert.equal(attempt.model, 'deepseek-flash'); assert.equal(attempt.effort, 'max'); assert.equal(attempt.environment, 'mathlib');
  assert.deepEqual(attempt.budgets, budgets);
  assert.ok(attempt.submittedAt, 'No submission was attempted; resume never submits a new task.');
} else {
  assert.ok(!fs.existsSync(attemptFile) && !fs.existsSync(path.join(output, 'report.json')) && !fs.existsSync(sessionFile),
    'Use a fresh output directory, or --resume for the existing attempt.');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  attempt = { schema: 'theorem-os.cantor-bernstein-real.v1', baseUrl: base.href, original: demoOriginal,
    provider: 'sub2api', model: 'deepseek-flash', effort: 'max', environment: 'mathlib', budgets,
    startedAt: new Date().toISOString(), formalizationPosts: 0, submittedBudgetVerified: false };
}
let key = '';
try {
  const profile = parse(fs.readFileSync(path.join(values['credential-profile'], 'config.toml'), 'utf8')) as any;
  assert.equal(profile.model_provider, 'sub2api');
  const auth = profile.model_providers?.sub2api?.auth;
  assert.ok(auth && typeof auth.command === 'string' && path.isAbsolute(auth.command)
    && Array.isArray(auth.args) && auth.args.every((arg: unknown) => typeof arg === 'string'));
  key = execFileSync(auth.command, auth.args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.ok(/^[\x21-\x7e]{8,4096}$/u.test(key));
} catch { throw new Error('Credential is unavailable through the existing profile auth command.'); }

const secrets = [key];
const safeText = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
function secretFree(text: string, label: string) {
  assert.ok(secrets.every(secret => !text.includes(secret)), `Sensitive value detected in ${label}; artifact was not written.`);
  return text;
}
function writeText(file: string, text: string) {
  fs.writeFileSync(path.join(output, file), secretFree(text, file));
}
function write(file: string, value: unknown) { writeText(file, JSON.stringify(value, null, 2) + '\n'); }
function previous<T>(file: string, fallback: T): T {
  return values.resume && fs.existsSync(path.join(output, file)) ? JSON.parse(fs.readFileSync(path.join(output, file), 'utf8')) as T : fallback;
}
const stages = previous<Record<string, unknown>[]>('stages.json', []);
const requests = previous<{ method: string; pathname: string }[]>('requests.json', []);
const savedActivity = previous<{ activity: WebFormalizationActivity[]; dropped: number }>('activity.json', { activity: [], dropped: 0 });
const activity = savedActivity.activity;
let activityDropped = savedActivity.dropped;
let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined;
let resumedSessionValue: string | undefined;
let formalization: WebFormalization | undefined, run: WebRun | undefined, conversation: WebConversation | undefined;
let interrupted = false, failure: string | undefined, validationError: string | undefined;
let passed = false, accepted = false, health: unknown, download: Record<string, unknown> | undefined;
const pageErrors: string[] = [], resourceErrors: { status: number; pathname: string }[] = [], observationErrors: string[] = [];
let wake: (() => void) | undefined;
const stop = () => { interrupted = true; wake?.(); void browser?.close().catch(() => {}); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
async function pause() { await new Promise<void>(resolve => { const timer = setTimeout(resolve, 5000); wake = () => { clearTimeout(timer); resolve(); }; }); wake = undefined; }
async function api<T>(route: string): Promise<T> {
  const response = await context!.request.get(new URL(route, base).href, { timeout: 0, maxRedirects: 0 });
  assert.ok(response.ok(), `Observer HTTP ${response.status()} at ${route.split('?')[0]}`);
  try { return await response.json() as T; } finally { await response.dispose(); }
}
async function saveSession() {
  const cookies = (await context!.cookies(base.origin)).filter(cookie => cookie.name === 'theoremos_session'
    && cookie.httpOnly && cookie.domain.replace(/^\./u, '') === base.hostname && cookie.path === '/');
  assert.equal(cookies.length, 1, 'Expected one anonymous HttpOnly session cookie.');
  assert.ok(!resumedSessionValue || cookies[0].value === resumedSessionValue,
    'The original anonymous session is no longer active; its private session file was preserved.');
  for (const cookie of cookies) if (!secrets.includes(cookie.value)) secrets.push(cookie.value);
  const text = JSON.stringify(cookies, null, 2) + '\n';
  assert.ok(!text.includes(key), 'Credential must not be persisted with the anonymous cookie.');
  fs.writeFileSync(sessionFile, text, { mode: 0o600 }); fs.chmodSync(sessionFile, 0o600);
}
async function screenshot(name: string) {
  if (!page || page.isClosed()) return;
  await page.screenshot({ path: path.join(output, name), fullPage: true, timeout: 0,
    mask: [page.locator('#formalize-key'), page.locator('#api-key')] });
}
async function readRecords() {
  if (!attempt.formalizationId && attempt.submittedAt) {
    const { formalizations } = await api<{ formalizations: WebFormalization[] }>('/api/formalizations');
    const matching = formalizations.filter(item => item.original === demoOriginal && item.providerId === 'sub2api'
      && item.model === 'deepseek-flash' && item.environment === 'mathlib' && Date.parse(item.createdAt) >= Date.parse(attempt.submittedAt!));
    assert.ok(matching.length <= 1, 'Ambiguous task creation; no second submission will be made.');
    if (matching[0]) attempt.formalizationId = matching[0].id;
  }
  if (attempt.formalizationId) {
    formalization = (await api<{ formalization: WebFormalization }>(`/api/formalizations/${attempt.formalizationId}`)).formalization;
    attempt.runId = formalization.runId ?? attempt.runId;
    if (!attempt.conversationId) {
      const { conversations } = await api<{ conversations: WebConversationSummary[] }>('/api/conversations');
      const matching = conversations.filter(item => item.formalizationId === attempt.formalizationId);
      assert.ok(matching.length <= 1, 'Expected one conversation for the original submission.');
      if (matching[0]) attempt.conversationId = matching[0].id;
    }
  }
  if (attempt.conversationId) {
    conversation = (await api<{ conversation: WebConversation }>(`/api/conversations/${attempt.conversationId}`)).conversation;
    attempt.runId = conversation.runId ?? attempt.runId;
  }
  if (attempt.runId) run = (await api<{ run: WebRun }>(`/api/runs/${attempt.runId}`)).run;
  write('attempt.json', attempt);
}
async function readActivity() {
  if (!attempt.formalizationId) return;
  let after = activity.at(-1)?.sequence ?? 0;
  while (!interrupted) {
    const batch = await api<{ activity: WebFormalizationActivity[]; count: number; dropped: number }>(
      `/api/formalizations/${attempt.formalizationId}/activity?after=${after}`);
    activityDropped = batch.dropped;
    if (!batch.activity.length) break;
    assert.ok(batch.activity.every((item, index) => item.sequence > (index ? batch.activity[index - 1].sequence : after)), 'Activity cursor must advance.');
    activity.push(...batch.activity); after = activity.at(-1)!.sequence;
    if (after >= batch.count) break;
  }
}
const seconds = (from?: string, to?: string) => from && to && Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to))
  ? (Date.parse(to) - Date.parse(from)) / 1000 : null;
function usage() {
  return { formalization: { reportedTotalTokens: formalization?.progress?.tokens ?? null },
    proof: { usage: run?.result?.report.usage ?? null, tokenBudget: run?.result?.report.tokenBudget ?? null },
    source: 'Host progress and run accounting from provider-reported usage; missing data is not zero usage.',
    coverage: 'Per-request billing receipts are not exposed; tokenBudget.usageComplete describes aggregate coverage when present.',
    billedCost: null };
}
function persist(status = 'observing') {
  if (formalization) write('formalization.json', formalization);
  if (run) write('run.json', run);
  if (conversation) write('conversation.json', conversation);
  const statement = formalization?.report?.statement ?? run?.source;
  if (statement) writeText('Statement.lean', statement);
  const proof = run?.result?.proof || run?.artifact?.source;
  if (proof) writeText('Proof.lean', proof);
  write('attempt.json', attempt); write('activity.json', { activity, dropped: activityDropped });
  write('stages.json', stages); write('requests.json', requests); write('usage.json', usage());
  write('report.json', { status, passed, independentAcceptanceVerified: accepted, checkedAt: new Date().toISOString(), health,
    original: demoOriginal, provider: attempt.provider, model: attempt.model, effort: attempt.effort, environment: attempt.environment, budgets,
    formalizationId: attempt.formalizationId ?? null, runId: attempt.runId ?? null, conversationId: attempt.conversationId ?? null,
    submittedAt: attempt.submittedAt ?? null, formalizationPosts: attempt.formalizationPosts,
    submittedBudgetVerified: attempt.submittedBudgetVerified,
    formalizationStatus: formalization?.status ?? null, proofStatus: run?.status ?? null,
    proofArtifactStatus: !proof ? 'unavailable' : accepted ? 'independently-accepted' : 'candidate-or-unverified-result',
    timing: { elapsedSeconds: seconds(attempt.startedAt, new Date().toISOString()),
      submittedToEvidenceSeconds: seconds(attempt.submittedAt, new Date().toISOString()),
      formalizationSeconds: seconds(formalization?.createdAt, formalization?.finishedAt), proofSeconds: seconds(run?.createdAt, run?.finishedAt),
      queueSeconds: seconds(run?.createdAt, run?.timings?.preparing), preparationSeconds: seconds(run?.timings?.preparing, run?.timings?.solving),
      solvingSeconds: seconds(run?.timings?.solving, run?.timings?.evaluating), evaluationSeconds: seconds(run?.timings?.evaluating, run?.finishedAt) },
    usage: usage(), download: download ?? null, pageErrors, resourceErrors, observationErrors, failure: failure ?? null,
    boundary: 'Real browser composer and server records; no mocked runner, supplied proof, request interception or replayed result. '
      + 'Independent acceptance checks the frozen Lean statement, not by itself the original-language semantics or the prohibition on existing CSB theorems. '
      + 'Those require inspection of the generated statement, proof and declaration dependencies. No detailed-explanation generation is requested. '
      + 'The observer has no time, token or iteration limit and never cancels background jobs. Transport/runtime errors remain possible. '
      + 'The private session.json contains only an anonymous HttpOnly cookie and must not be shared with public evidence.' });
}
function validateAcceptance() {
  assert.ok(formalization?.report && run?.result && conversation, 'Complete formalization, proof and conversation evidence is required.');
  assert.equal(formalization.original, demoOriginal); assert.equal(formalization.report.original, demoOriginal);
  assert.equal(formalization.report.environment, 'mathlib'); assert.equal(formalization.workflow, 'solve');
  assert.ok(!formalization.humanReview, 'Automatic participation must not become a manual review workflow.');
  assert.equal(formalization.model, 'deepseek-flash'); assert.equal(formalization.effort, 'max');
  assert.equal(formalization.maxRunSeconds, 0); assert.equal(formalization.maxTotalTokens, 0); assert.deepEqual(formalization.research, budgets.research);
  assert.equal(formalization.maxRounds, 0); assert.equal(formalization.maxPlanningRounds, 0);
  assert.equal(run.status, 'completed'); assert.equal(run.result.status, 'evaluated_passed');
  assert.equal(run.providerId, 'sub2api'); assert.equal(run.model, 'deepseek-flash'); assert.equal(run.effort, 'max'); assert.equal(run.environment, 'mathlib');
  assert.equal(run.maxRunSeconds, 0); assert.equal(run.maxTotalTokens, 0); assert.equal(run.maxTurns, 0);
  assert.equal(run.formalizationId, formalization.id); assert.equal(run.formalization?.evidenceSha256, formalization.report.evidenceSha256);
  assert.equal(run.formalization?.original, demoOriginal); assert.equal(run.source, formalization.report.statement);
  const evaluator = run.result.report.evaluator as any;
  assert.equal(evaluator?.status, 'passed'); assert.equal(evaluator?.method, 'host-lean-kernel-all-targets');
  assert.equal(evaluator?.verification?.passed, true);
  const targets = evaluator?.verification?.verification?.results as { theoremName: string; status: string; sorryCount: number; admitCount: number; axioms?: { name: string }[] }[];
  assert.ok(Array.isArray(targets) && targets.length > 0);
  assert.deepEqual(targets.map(target => target.theoremName).sort(), formalization.report.targets.map(target => target.name).sort());
  assert.ok(targets.every(target => target.status === 'kernel_verified' && target.sorryCount === 0 && target.admitCount === 0
    && Array.isArray(target.axioms) && !target.axioms.some(axiom => axiom.name === 'sorryAx')), 'Every original target must be kernel_verified without sorry/admit/sorryAx.');
  assert.equal(conversation.formalizationId, formalization.id); assert.equal(conversation.runId, run.id); assert.equal(conversation.messages[0]?.text, demoOriginal);
  assert.equal(attempt.formalizationPosts, 1); assert.equal(attempt.submittedBudgetVerified, true);
  const environment = getLeanTaskEnvironment('mathlib');
  assert.equal(formalization.report.toolchain, environment.toolchain); assert.equal(formalization.report.mathlibRevision, environment.mathlibRevision);
}
function checkKit(filename: string) {
  // Inspect ZIP content and CRCs with Python's standard library; never execute downloaded code.
  const raw = execFileSync('/usr/bin/python3', ['-c',
    'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None, "ZIP CRC failure"\n names=z.namelist()\n assert len(names)==len(set(names)), "duplicate ZIP entries"\n print(json.dumps({n:z.read(n).decode("utf-8") for n in names}))', filename],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const files = JSON.parse(secretFree(raw, 'verification-kit')) as Record<string, string>;
  const prefix = `theoremos-${attempt.runId!.slice(0, 8)}/`, environment = getLeanTaskEnvironment('mathlib');
  const expected = [...Object.keys(environment.files), 'Submission.lean', 'Original.lean', 'Check.lean', 'README.txt', 'report.json'];
  assert.deepEqual(Object.keys(files).sort(), expected.map(name => prefix + name).sort());
  assert.equal(files[prefix + 'Submission.lean'], run!.result!.proof); assert.equal(files[prefix + 'Original.lean'], run!.source);
  assert.deepEqual(JSON.parse(files[prefix + 'report.json']), run!.result!.report);
  for (const [name, content] of Object.entries(environment.files)) assert.equal(files[prefix + name], content);
  assert.match(files[prefix + 'Check.lean'], /^import Submission\n/mu);
  const identifier = (name: string) => name.split('.').map(part => /^[\p{L}_][\p{L}\p{N}_'!?]*$/u.test(part) ? part : `«${part}»`).join('.');
  assert.deepEqual(files[prefix + 'Check.lean'].split('\n').filter(line => line.startsWith('#print axioms ')),
    formalization!.report!.targets.map(target => `#print axioms ${identifier(target.name)}`));
  for (const name of expected) {
    const target = path.join(output, 'verification-kit', name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, secretFree(files[prefix + name], 'verification-kit'));
  }
  return { sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), bytes: fs.statSync(filename).size,
    entries: expected, crcChecked: true, sourceMatchesFrozenStatement: true, proofMatchesAcceptedResult: true,
    reportMatchesIndependentAcceptance: true, pinnedEnvironmentMatches: true, toolchain: environment.toolchain, mathlibRevision: environment.mathlibRevision };
}

try {
  browser = await chromium.launch({ headless: true, timeout: 0, handleSIGINT: false, handleSIGTERM: false });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', acceptDownloads: true, reducedMotion: 'reduce' });
  context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
  if (values.resume) {
    assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600, 'Private session.json must have mode 0600.');
    const cookies = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as Cookie[];
    assert.ok(Array.isArray(cookies) && cookies.length === 1 && cookies.every(cookie => cookie.name === 'theoremos_session'
      && cookie.httpOnly && cookie.domain.replace(/^\./u, '') === base.hostname && cookie.path === '/'), 'Resume accepts only the original anonymous HttpOnly cookie.');
    for (const cookie of cookies) secrets.push(cookie.value);
    resumedSessionValue = cookies[0].value;
    await context.addCookies(cookies);
  }
  const session = await api<WebSession>('/api/session');
  assert.equal(session.auth, 'none', 'Use an isolated anonymous instance.'); assert.equal(session.runtime.ready, true);
  health = await api('/healthz'); await saveSession(); write('attempt.json', attempt);
  await context.addInitScript(() => localStorage.setItem('theorem-os.web-locale.v1', 'zh'));
  page = await context.newPage(); page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0);
  page.on('pageerror', error => pageErrors.push(safeText(error.message)));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== base.origin || response.status() < 400) return;
    resourceErrors.push({ status: response.status(), pathname: url.pathname });
    if (response.request().method() === 'POST' && url.pathname === '/api/formalizations') validationError = `Submission returned HTTP ${response.status()}; no resubmission was made.`;
  });
  page.on('requestfailed', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/formalizations')
      validationError = 'Submission connection failed; reconcile this attempt with --resume, without resubmitting.';
  });
  page.on('request', request => {
    const url = new URL(request.url()); if (url.origin !== base.origin) return;
    requests.push({ method: request.method(), pathname: url.pathname });
    if (request.method() !== 'POST' || url.pathname !== '/api/formalizations') return;
    try {
      attempt.formalizationPosts++;
      assert.equal(attempt.formalizationPosts, 1, 'Only one real formalization submission is permitted.');
      assert.ok(!values.resume, 'Resume must never create a new formalization.');
      // Inspect only in memory. Neither the request body nor the credential is serialized.
      const body = request.postDataJSON();
      assert.equal(body.original, demoOriginal); assert.equal(body.providerId, 'sub2api'); assert.equal(body.model, 'deepseek-flash');
      assert.equal(body.environment, 'mathlib'); assert.equal(body.effort, 'max'); assert.equal(body.solve, true); assert.ok(!body.humanReview);
      assert.equal(body.maxRunSeconds, 0); assert.equal(body.maxTotalTokens, 0);
      assert.equal(body.research?.maxRunSeconds, 0); assert.equal(body.research?.maxTotalTokens, 0); assert.equal(body.research?.maxTurns, 0);
      attempt.submittedBudgetVerified = true; write('attempt.json', attempt);
    } catch (error) { validationError = safeText(error instanceof Error ? error.message : String(error)); }
  });
  await page.goto(attempt.conversationId ? new URL(`?chat=${attempt.conversationId}`, base).href : base.href, { timeout: 0 });
  if (!values.resume) {
    await page.locator('#formalize-original').waitFor({ timeout: 0 }); await page.locator('#formalize-original').fill(demoOriginal);
    const participation = page.locator('[data-chat-participation-control]');
    if (!await participation.evaluate(node => (node as HTMLDetailsElement).open)) await participation.locator(':scope > summary').click();
    await page.locator('input[name="chat-participation"][value="automatic"]').check();
    await openAdvancedChatSettings(page);
    await page.locator('#formalize-provider').selectOption('sub2api'); await page.locator('#formalize-model').fill('deepseek-flash');
    await page.locator('#formalize-environment').selectOption('mathlib'); await page.locator('#formalize-effort').selectOption('max');
    await page.locator('#formalize-key').fill(key);
    for (const selector of ['#formalize-minutes', '#formalize-tokens', '#research-minutes', '#research-tokens', '#research-turns']) {
      await page.locator(selector).fill(''); assert.equal(await page.locator(selector).inputValue(), '');
    }
    await screenshot('00-original.png');
    await page.locator('#formalize-settings > summary').click();
    attempt.submittedAt = new Date().toISOString(); write('attempt.json', attempt); await saveSession();
    await page.locator('#formalize-start:enabled').click({ timeout: 0 });
  }
  let lastState = '';
  while (!interrupted) {
    await readRecords(); await readActivity();
    if (validationError) throw new Error(validationError);
    if (attempt.conversationId && new URL(page.url()).searchParams.get('chat') !== attempt.conversationId)
      await page.goto(new URL(`?chat=${attempt.conversationId}`, base).href, { timeout: 0 });
    const state = { formalization: formalization?.status ?? 'awaiting-submission', phase: formalization?.progress?.phase ?? null,
      round: formalization?.progress?.round ?? null, proof: run?.status ?? null, proofPhase: run?.phase ?? null, result: run?.result?.status ?? null };
    if (JSON.stringify(state) !== lastState) {
      lastState = JSON.stringify(state);
      const stage = { at: new Date().toISOString(), elapsedSeconds: seconds(attempt.submittedAt, new Date().toISOString()),
        ...state, formalizationTokens: formalization?.progress?.tokens ?? null, formalizationId: attempt.formalizationId ?? null, runId: attempt.runId ?? null };
      stages.push(stage); persist(); console.log(JSON.stringify(stage));
      await screenshot(`stage-${String(stages.length).padStart(3, '0')}.png`);
    }
    persist(); await saveSession();
    if (formalization && ['error', 'exhausted', 'cancelled'].includes(formalization.status)) throw new Error(`Formalization ended: ${formalization.status} (${formalization.reason ?? 'no reason'}).`);
    if (formalization?.researchError && !attempt.runId) throw new Error(`Proof handoff failed: ${formalization.researchError}.`);
    if (run && ['completed', 'cancelled', 'error'].includes(run.status)) break;
    await pause();
  }
  if (interrupted) throw new Error('Observation interrupted; background work was not cancelled. Resume with the same output directory.');
  validateAcceptance(); accepted = true; persist('downloading-verification-kit');
  await page.locator('.research-conversation-status[data-accepted="true"]').waitFor({ timeout: 0 });
  const more = page.locator('[data-chat-result-more]');
  if (!await more.evaluate(node => (node as HTMLDetailsElement).open)) await more.locator(':scope > summary').click();
  const link = page.locator(`a[data-chat-download-kit][download][href="/api/runs/${attempt.runId}/verification-kit"]`);
  await link.waitFor({ timeout: 0 }); await screenshot('independent-acceptance.png');
  const downloadStarted = Date.now(), event = page.waitForEvent('download', { timeout: 0 });
  await link.click({ timeout: 0 }); const kit = await event; assert.equal(await kit.failure(), null);
  const temporary = await kit.path(); assert.ok(temporary, 'Browser download must produce a local ZIP.');
  const checked = checkKit(temporary);
  await kit.saveAs(path.join(output, 'verification-kit.zip'));
  download = { filename: 'verification-kit.zip', seconds: (Date.now() - downloadStarted) / 1000, ...checked };
  passed = true;
} catch (error) {
  failure = safeText(error instanceof Error ? error.message : String(error)); process.exitCode = interrupted ? 130 : 1;
  await screenshot('observation-stopped.png').catch(error => observationErrors.push(safeText(String(error))));
} finally {
  // Only read/reconcile. Closing this browser never cancels or mutates the background jobs.
  if (context && !interrupted) {
    await readRecords().catch(error => observationErrors.push(safeText(String(error))));
    await readActivity().catch(error => observationErrors.push(safeText(String(error))));
    await saveSession().catch(error => observationErrors.push(safeText(String(error))));
  }
  persist(passed ? 'passed' : interrupted ? 'interrupted' : 'failed');
  await browser?.close().catch(error => observationErrors.push(safeText(String(error))));
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); key = '';
  console.log(JSON.stringify({ passed, formalizationId: attempt.formalizationId ?? null, runId: attempt.runId ?? null,
    failure: failure ?? null, report: path.join(output, 'report.json') }));
}
