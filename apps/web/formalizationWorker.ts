import type { WorkerFormalizationAuditInput } from './formalizationAuditTypes';
import fs from 'node:fs';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assertFormalizationEvidence, directFormalizationEvidenceSchema, prepareFormalization, readFormalizationArtifact } from '../../src/math/formalization';
import { runFormalizationAudit } from '../../src/solver/formalizationAudit';
import { defaultFormalizationWorkflow } from '../../src/math/formalizationWorkflow';
import { LEAN_STATEMENT_CONTEXT_PROTOCOL } from '../../src/math/leanStatementSemantic';
import { readMathBuildManifest } from '../../src/math/mathBuildManifest';
import { readMathJson } from '../../src/math/mathRuntimeIo';
import { createCodexMathSession, type MathAgentOptions } from '../../src/runtime/codexSession';
import { prepareSub2apiProfile, SUB2API_PROVIDER } from '../../src/runtime/sub2api';
import { readFormalizationState, runFormalization } from '../../src/solver/formalization';
import { elaborateFormalization } from '../../src/solver/formalizationElaboration';
import { reportedTotalTokens } from '../../src/solver/usageBudget';
import { startGatewayForwarder } from './explanationWorker';
import { createFormalizationActivity } from './formalizationActivity';
import { webHarnessExecutable } from './harness';
import { prepareWebProviderProfile } from './worker';
import { webAgentLibraryAccess } from './frozenLibrary';
import { webFormalizationLimits, webFormalizationReason, type WorkerFormalizationInput,
  type WorkerFormalizationMessage, type WorkerFormalizationAuditMessage,
  type WebFormalizationProgress } from './formalizationTypes';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const formalizationWorkerInputObject = z.object({
  id: z.string().uuid(), original: z.string().min(1).max(webFormalizationLimits.maxOriginalBytes)
    .refine(value => value.trim().length > 0 && Buffer.byteLength(value) <= webFormalizationLimits.maxOriginalBytes),
  environment: z.enum(['standard', 'mathlib']), model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u),
  effort: z.enum(['low', 'high', 'max']), apiKey: z.string().regex(/^[\x21-\x7e]{8,4096}$/u),
  provider: z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u), name: z.string().max(200), baseUrl: z.string().url().max(512), harness: z.literal('codex').optional(),
    execution: z.object({ executable: z.string().min(1).max(4096).optional() }).strict().optional() }).strict(),
  maxRunSeconds: z.number().int().nonnegative().max(webFormalizationLimits.maxRunSeconds).default(0),
  maxTotalTokens: z.union([z.literal(0), z.number().int().min(10_000).max(webFormalizationLimits.maxTotalTokens)]).default(0),
  maxRounds: z.number().int().nonnegative().max(webFormalizationLimits.maxRounds).default(0),
  maxPlanningRounds: z.number().int().nonnegative().max(webFormalizationLimits.maxPlanningRounds).default(0),
  reviewers: z.literal(webFormalizationLimits.reviewers),
  contextProtocol: z.literal(LEAN_STATEMENT_CONTEXT_PROTOCOL).optional(),
  reviewMode: z.literal('direct').optional(),
}).strict();
const providerConfiguration = (input: { provider: { id: string; baseUrl: string }; model: string }, context: z.RefinementCtx) => {
  let url: URL;
  try { url = new URL(input.provider.baseUrl); }
  catch { context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unsupported provider configuration' }); return; }
  const gateway = input.provider.id === SUB2API_PROVIDER.id;
  if (url.username || url.password || url.search || url.hash || (gateway
    ? url.protocol !== 'http:' || url.pathname.replace(/\/$/u, '') !== '/v1' || input.model !== SUB2API_PROVIDER.defaultModel
    : url.protocol !== 'https:')) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unsupported provider configuration' });
};
export const formalizationWorkerInputSchema = formalizationWorkerInputObject.superRefine(providerConfiguration);
export const formalizationAuditWorkerInputSchema = formalizationWorkerInputObject.pick({
  id: true, original: true, environment: true, model: true, effort: true, apiKey: true, provider: true, maxRunSeconds: true,
}).extend({ operation: z.literal('audit'), evidence: directFormalizationEvidenceSchema,
  maxTotalTokens: z.number().int().safe().nonnegative().max(webFormalizationLimits.maxTotalTokens),
}).strict().superRefine(providerConfiguration);

export function assertWebFormalizationAuditInput(input: WorkerFormalizationAuditInput) {
  assertFormalizationEvidence(input.evidence);
  const request = input.evidence.request;
  if (request.problemId !== input.id || request.statement !== input.original || request.environment !== input.environment ||
      request.model !== input.model || request.effort !== input.effort || request.execution !== 'model')
    throw new Error('formalization_audit_binding_mismatch');
}

/** Add the host-only credential after the solver-visible mathematics environment has been projected. */
export function webFormalizationSessionOptions(options: MathAgentOptions, providerId: string, apiKey: string): MathAgentOptions {
  return { ...options, environment: { ...options.environment,
    [providerId === SUB2API_PROVIDER.id ? SUB2API_PROVIDER.apiKeyEnvironment : 'THEOREMOS_PROVIDER_API_KEY']: apiKey } };
}

/** New direct requests generate and compile; older inputs retain their independent review workflow. */
export function webFormalizationPreparation(input: WorkerFormalizationInput, profile: string, buildManifestRef: string,
  executable = 'codex'): Parameters<typeof prepareFormalization>[1] {
  const author = { model: input.model, effort: input.effort, profile, executable };
  const workflow = input.reviewMode === 'direct' ? undefined : defaultFormalizationWorkflow(author);
  if (workflow) { workflow.maxPlanningRounds = input.maxPlanningRounds; workflow.reviewScheduling = 'parallel'; }
  return { problemId: input.id, statement: input.original, environment: input.environment, execution: 'model',
    ...author, ...(input.reviewMode === 'direct' ? { reviewMode: 'direct' as const } :
      { workflow, fidelityPolicy: 'task-preserving-v2' as const }), buildManifestRef,
    contextProtocol: input.contextProtocol ?? LEAN_STATEMENT_CONTEXT_PROTOCOL,
    maxRounds: input.maxRounds, maxRunSeconds: input.maxRunSeconds, maxTurnSeconds: 0, maxCompileSeconds: 0,
    maxTotalTokens: input.maxTotalTokens };
}

/** Only a code crosses the worker boundary, never compiler/provider/model diagnostic text. */
export function formalizationStopReason(status: string, error: string | undefined, timedOut: boolean):
  { status: 'exhausted' | 'error'; reason: string } {
  const value = error ?? '';
  if (value.startsWith('math_total_token_limit') || value.startsWith('formalization_token_limit'))
    return { status: 'exhausted', reason: 'formalization_token_limit' };
  if (value.startsWith('formalization_time_limit') || timedOut)
    return { status: 'exhausted', reason: 'formalization_time_limit' };
  if (status === 'exhausted') return { status: 'exhausted', reason: 'formalization_rounds_exhausted' };
  const code = /^[a-z0-9_]+/u.exec(value)?.[0] ?? '';
  return { status: 'error', reason: webFormalizationReason.test(code) ? code : 'formalization_failed' };
}

async function readInput(): Promise<WorkerFormalizationInput | WorkerFormalizationAuditInput> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16_000_000) throw new Error('formalization_input_too_large');
    chunks.push(chunk);
  }
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  return value?.operation === 'audit' ? formalizationAuditWorkerInputSchema.parse(value) as WorkerFormalizationAuditInput
    : formalizationWorkerInputSchema.parse(value) as WorkerFormalizationInput;
}

async function main() {
  const input = await readInput(), key = input.apiKey;
  const send = (message: WorkerFormalizationMessage | WorkerFormalizationAuditMessage) => new Promise<void>(resolve => process.stdout.write(
    JSON.stringify(message).replaceAll(JSON.stringify(key).slice(1, -1), '[REDACTED]') + '\n', () => resolve()));
  const originalLog = console.log, originalError = console.error;
  console.log = () => {}; console.error = () => {};
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalize-')));
  const directory = path.join(scratch, 'run'), profile = path.join(scratch, 'profile');
  const startedAt = Date.now();
  let gateway: net.Server | undefined, poll: ReturnType<typeof setInterval> | undefined;
  const progress: WebFormalizationProgress = { phase: 'preparing' };
  const report = (phase?: WebFormalizationProgress['phase']) => {
    if (phase) progress.phase = phase;
    void send({ type: 'progress', progress: { ...progress } });
  };
  const refresh = () => {
    try {
      const state = readFormalizationState(directory);
      if (!state) return;
      progress.round = state.rounds;
      progress.tokens = state.sessions.reduce((sum, session) => sum + (reportedTotalTokens(session.usage) ?? 0), 0);
    } catch { /* The next poll reads the atomic checkpoint. */ }
  };
  try {
    if (!('operation' in input)) report();
    const sub2api = input.provider.id === SUB2API_PROVIDER.id;
    const openSession = (options: MathAgentOptions) => createCodexMathSession(webFormalizationSessionOptions(options, input.provider.id, key));
    if (sub2api) {
      gateway = await startGatewayForwarder(input.provider.baseUrl);
      prepareSub2apiProfile(profile, input.model, input.effort);
    } else prepareWebProviderProfile(profile, { provider: input.provider, input: { model: input.model, effort: input.effort } });
    // This disposable container owns its profile and never loads a machine credential or environment file.
    process.env.DEEPSCIENTIST_MATH_ENV_FILE = path.join(scratch, 'math.env');
    fs.writeFileSync(process.env.DEEPSCIENTIST_MATH_ENV_FILE, '', { mode: 0o400, flag: 'wx' });
    const buildIndex = readMathJson(process.env.THEOREMOS_WORKER_BUILD || '/opt/theoremos-build.json') as { buildManifestRef: string };
    readMathBuildManifest(buildIndex.buildManifestRef, root, path.join(root, 'out/main'));
    if ('operation' in input) {
      assertWebFormalizationAuditInput(input);
      const result = await runFormalizationAudit(path.join(scratch, 'audit'), root, input.evidence,
        { profile, executable: input.provider.execution?.executable ?? process.env.DEEPSCIENTIST_MATH_CODEX_EXECUTABLE ?? webHarnessExecutable(input.provider), model: input.model,
          effort: input.effort, buildManifestRef: buildIndex.buildManifestRef },
        { openSession,
          maxRunSeconds: input.maxRunSeconds, maxTotalTokens: input.maxTotalTokens,
          onUsage: tokens => { void send({ type: 'audit-progress', tokens }); } });
      await send({ type: 'audit-result', result });
      return;
    }
    const libraryCatalog = webAgentLibraryAccess(input.environment);
    prepareFormalization(directory, { ...webFormalizationPreparation(input, profile, buildIndex.buildManifestRef,
      input.provider.execution?.executable ?? process.env.DEEPSCIENTIST_MATH_CODEX_EXECUTABLE ?? webHarnessExecutable(input.provider)), ...(libraryCatalog ? { libraryCatalog } : {}) });
    poll = setInterval(() => { refresh(); report(); }, 10_000);
    const activity = createFormalizationActivity({ scratch, directory, root, apiKey: key, redact: [input.provider.baseUrl],
      send: entry => { void send({ type: 'activity', activity: entry }); } });
    const result = await runFormalization(directory, root, {
      openSession: activity.openSession(openSession),
      elaborate: activity.elaborate(elaborateFormalization),
      onCompiledCandidate: candidate => send({ type: 'compiled', candidate }),
      onEvent: event => {
        activity.onEvent(event);
        if (event.round) progress.round = event.round;
        if (event.event === 'formalization_role_started') {
          const phases = { plan: 'planning', generate: 'generating', backtranslate: 'translating', compare: 'reviewing', refute: 'reviewing' } as const;
          if (event.role) report(phases[event.role]);
        } else if (event.event === 'formalization_compilation_started') report('compiling');
        else if (event.event === 'formalization_approved') { refresh(); report('finishing'); }
        else if (event.event === 'formalization_role_finished') { refresh(); report(); }
      } });
    clearInterval(poll);
    if (result.status === 'approved')
      await send({ type: 'result', status: 'approved', evidence: readFormalizationArtifact(path.join(directory, 'artifact')) });
    else {
      const stop = formalizationStopReason(result.status, result.error, input.maxRunSeconds > 0 && Date.now() - startedAt >= input.maxRunSeconds * 1_000);
      activity.stopped(stop.reason, result.error);
      await send({ type: 'result', ...stop });
    }
  } catch (error) {
    const stop = formalizationStopReason('stopped', error instanceof Error ? error.message : undefined, false);
    await send('operation' in input ? { type: 'audit-error', reason: stop.reason } : { type: 'result', ...stop });
    process.exitCode = 1;
  } finally {
    clearInterval(poll);
    input.apiKey = '';
    gateway?.close();
    console.log = originalLog; console.error = originalError;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({ type: 'result', status: 'error', reason: 'formalization_input_invalid' }) + '\n');
    process.exitCode = 1;
  }).finally(() => process.exit());
}
