import fs from 'node:fs';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { prepareFormalization, readFormalizationArtifact } from '../../src/math/formalization';
import { defaultFormalizationWorkflow } from '../../src/math/formalizationWorkflow';
import { readMathBuildManifest } from '../../src/math/mathBuildManifest';
import { readMathJson } from '../../src/math/mathRuntimeIo';
import { createCodexMathSession } from '../../src/runtime/codexSession';
import { prepareSub2apiProfile, SUB2API_PROVIDER } from '../../src/runtime/sub2api';
import { readFormalizationState, runFormalization } from '../../src/solver/formalization';
import { reportedTotalTokens } from '../../src/solver/usageBudget';
import { startGatewayForwarder } from './explanationWorker';
import { webFormalizationLimits, webFormalizationReason, type WorkerFormalizationInput,
  type WorkerFormalizationMessage, type WebFormalizationProgress } from './formalizationTypes';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const formalizationWorkerInputSchema = z.object({
  id: z.string().uuid(), original: z.string().min(1).max(webFormalizationLimits.maxOriginalBytes)
    .refine(value => value.trim().length > 0 && Buffer.byteLength(value) <= webFormalizationLimits.maxOriginalBytes),
  environment: z.enum(['standard', 'mathlib']), model: z.literal(SUB2API_PROVIDER.defaultModel),
  effort: z.enum(['low', 'high', 'max']), apiKey: z.string().regex(/^[\x21-\x7e]{8,4096}$/u),
  provider: z.object({ id: z.literal(SUB2API_PROVIDER.id), name: z.string().max(200), baseUrl: z.string().url().max(512) }).strict(),
  maxRunSeconds: z.number().int().positive().max(webFormalizationLimits.maxRunSeconds),
  maxTotalTokens: z.literal(webFormalizationLimits.maxTotalTokens),
  maxRounds: z.number().int().positive().max(webFormalizationLimits.maxRounds),
  maxPlanningRounds: z.number().int().positive().max(webFormalizationLimits.maxPlanningRounds),
  reviewers: z.literal(webFormalizationLimits.reviewers),
}).strict();

/** Keep the CLI's planned v3 fidelity protocol and unanimous independent review policy. */
export function webFormalizationPreparation(input: WorkerFormalizationInput, profile: string, buildManifestRef: string,
  executable = 'codex'): Parameters<typeof prepareFormalization>[1] {
  const author = { model: input.model, effort: input.effort, profile, executable };
  const workflow = defaultFormalizationWorkflow(author);
  workflow.maxPlanningRounds = input.maxPlanningRounds;
  workflow.reviewScheduling = 'parallel';
  return { problemId: input.id, statement: input.original, environment: input.environment, execution: 'model',
    ...author, workflow, fidelityPolicy: 'task-preserving-v2', buildManifestRef,
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

async function readInput(): Promise<WorkerFormalizationInput> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) throw new Error('formalization_input_too_large');
    chunks.push(chunk);
  }
  return formalizationWorkerInputSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))) as WorkerFormalizationInput;
}

async function main() {
  const input = await readInput(), key = input.apiKey;
  const send = (message: WorkerFormalizationMessage) => new Promise<void>(resolve => process.stdout.write(
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
    report();
    gateway = await startGatewayForwarder(input.provider.baseUrl);
    prepareSub2apiProfile(profile, input.model, input.effort);
    // This disposable container owns its profile and never loads a machine credential or environment file.
    process.env.DEEPSCIENTIST_MATH_ENV_FILE = path.join(scratch, 'math.env');
    fs.writeFileSync(process.env.DEEPSCIENTIST_MATH_ENV_FILE, '', { mode: 0o400, flag: 'wx' });
    const buildIndex = readMathJson(process.env.THEOREMOS_WORKER_BUILD || '/opt/theoremos-build.json') as { buildManifestRef: string };
    readMathBuildManifest(buildIndex.buildManifestRef, root, path.join(root, 'out/main'));
    prepareFormalization(directory, webFormalizationPreparation(input, profile, buildIndex.buildManifestRef,
      process.env.DEEPSCIENTIST_MATH_CODEX_EXECUTABLE || 'codex'));
    poll = setInterval(() => { refresh(); report(); }, 10_000);
    const result = await runFormalization(directory, root, {
      openSession: options => createCodexMathSession({ ...options,
        environment: { ...options.environment, [SUB2API_PROVIDER.apiKeyEnvironment]: key } }),
      onEvent: event => {
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
    else await send({ type: 'result', ...formalizationStopReason(result.status, result.error,
      Date.now() - startedAt >= input.maxRunSeconds * 1_000) });
  } catch (error) {
    await send({ type: 'result', ...formalizationStopReason('stopped', error instanceof Error ? error.message : undefined, false) });
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
