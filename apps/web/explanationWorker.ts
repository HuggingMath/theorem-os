import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { INFORMALIZATION_ALIGNMENT, INFORMALIZATION_EXPLANATION_POLICY, INFORMALIZATION_OUTLINE_POLICY, informalizationDigest, prepareInformalization, readInformalizationArtifact } from '../../src/math/informalization';
import { readMathBuildManifest } from '../../src/math/mathBuildManifest';
import { readMathJson } from '../../src/math/mathRuntimeIo';
import { createCodexMathSession } from '../../src/runtime/codexSession';
import { prepareSub2apiProfile, SUB2API_PROVIDER } from '../../src/runtime/sub2api';
import { informalizationRetryLimit, isRetryableInformalizationFailure, readInformalizationState,
  runInformalization } from '../../src/solver/informalization';
import { reportedTotalTokens } from '../../src/solver/usageBudget';
import { webExplanationReason, type WebExplanationPhase, type WorkerExplanationCheckpoint, type WorkerExplanationInput,
  type WorkerExplanationMessage } from './shared';
import { captureExplanationCheckpoint, explanationCheckpointSchema, maxExplanationMessageBytes,
  restoreExplanationCheckpoint } from './explanationCheckpoint';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inputSchema = z.object({
  id: z.string().uuid(), proof: z.string().min(1).max(512 * 1024), target: z.string().min(1).max(512),
  language: z.enum(['zh', 'en']), environment: z.enum(['standard', 'mathlib']), model: z.literal(SUB2API_PROVIDER.defaultModel),
  effort: z.enum(['low', 'high', 'max']), apiKey: z.string().regex(/^[\x21-\x7e]{8,4096}$/u),
  provider: z.object({ id: z.literal(SUB2API_PROVIDER.id), name: z.string().max(200), baseUrl: z.string().url().max(512), harness: z.literal('codex').optional(),
    execution: z.object({ executable: z.string().min(1).max(4096).optional() }).strict().optional() }).strict(),
  maxRunSeconds: z.number().int().nonnegative().max(24 * 60 * 60), maxTotalTokens: z.number().int().nonnegative(),
  maxRoundsPerBatch: z.number().int().min(0).max(20), auditors: z.number().int().min(1).max(5),
  checkpoint: explanationCheckpointSchema.optional(),
}).strict();

const relayUrl = new URL(SUB2API_PROVIDER.baseUrl);

/**
 * Explanation roles call the fixed sub2api address 127.0.0.1:8080 (src/runtime/formalizationRelay.ts). Inside the
 * container that address forwards bytes to the configured gateway; the role sandboxes themselves have no network.
 */
export function startGatewayForwarder(baseUrl: string, listen = { host: relayUrl.hostname, port: Number(relayUrl.port) }):
  Promise<net.Server | undefined> {
  const local = relayUrl, target = new URL(baseUrl);
  if (target.protocol !== 'http:' || target.pathname.replace(/\/$/u, '') !== local.pathname || target.username ||
      target.password || target.search || target.hash) throw new Error('explanation_provider_unsupported');
  const port = Number(target.port || 80);
  if (target.hostname === listen.host && port === listen.port) return Promise.resolve(undefined);
  const server = net.createServer({ allowHalfOpen: true }, client => {
    const upstream = net.connect({ host: target.hostname, port, allowHalfOpen: true });
    const destroy = () => { client.destroy(); upstream.destroy(); };
    client.on('error', destroy); upstream.on('error', destroy);
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
    client.pipe(upstream); upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error('explanation_gateway_unavailable')));
    server.listen(listen.port, listen.host, () => resolve(server));
  });
}

/** Only a reason code leaves the container: the run's error text can quote the model, the provider or Lean output. */
export function explanationStopReason(status: string, error: string | undefined, timedOut: boolean):
  { status: 'exhausted' | 'error'; reason: string } {
  const text = error ?? '';
  if (status === 'exhausted' || text.startsWith('informalization_rounds_exhausted'))
    return { status: 'exhausted', reason: 'informalization_rounds_exhausted' };
  if (text.startsWith('math_total_token_limit') || text.startsWith('informalization_token_limit'))
    return { status: 'exhausted', reason: 'explanation_token_limit' };
  if (text.startsWith('informalization_time_limit') || timedOut) return { status: 'exhausted', reason: 'informalization_time_limit' };
  if (text.startsWith('math_model_usage_unavailable')) return { status: 'error', reason: 'explanation_usage_unavailable' };
  const code = /^[a-z0-9_]+/u.exec(text)?.[0] ?? '';
  if (webExplanationReason.test(code)) return { status: 'error', reason: code };
  const prefixed = /^(?:formalization|math)_([a-z0-9_]{1,60})$/u.exec(code);
  return { status: 'error', reason: prefixed ? `explanation_${prefixed[1]}` : 'explanation_failed' };
}

async function readInput(): Promise<WorkerExplanationInput> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxExplanationMessageBytes + 4 * 1024 * 1024) throw new Error('explanation_input_too_large');
    chunks.push(chunk);
  }
  return inputSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))) as WorkerExplanationInput;
}

async function main() {
  const input = await readInput();
  const key = input.apiKey;
  const send = (message: WorkerExplanationMessage) => new Promise<void>(resolve => process.stdout.write(
    JSON.stringify(message).replaceAll(JSON.stringify(key).slice(1, -1), '[REDACTED]') + '\n', () => resolve()));
  // Runtime and Codex diagnostics stay inside this disposable container; stdout carries protocol lines only.
  const originalLog = console.log, originalError = console.error;
  console.log = () => {}; console.error = () => {};
  // The worker entrypoint gives each container a fresh disk volume at the same path. The frozen
  // request and environment include absolute profile and env-file paths, which must match on retry.
  const scratch = path.join(fs.realpathSync(process.env.THEOREMOS_EXPLAIN_ROOT || os.tmpdir()), 'explanation');
  fs.mkdirSync(scratch, { mode: 0o700 });
  const directory = path.join(scratch, 'run'), project = path.join(scratch, 'project'), profile = path.join(scratch, 'profile');
  const startedAt = Date.now();
  let gateway: net.Server | undefined, poll: ReturnType<typeof setInterval> | undefined;
  const progress: Extract<WorkerExplanationMessage, { type: 'progress' }>['progress'] = { phase: 'preparing' };
  const report = (phase?: WebExplanationPhase) => {
    if (phase) progress.phase = phase;
    void send({ type: 'progress', progress: { ...progress } });
  };
  const refresh = () => {
    try {
      const state = readInformalizationState(directory);
      if (!state) return;
      if (state.batches.length) progress.batches = state.batches.length;
      progress.approvedBatches = state.batches.filter(batch => batch.status === 'approved').length;
      progress.tokens = state.sessions.reduce((sum, session) => sum + (reportedTotalTokens(session.usage) ?? 0), 0);
      progress.modelRequestFailures = state.sessions.filter(session => isRetryableInformalizationFailure(session.failureDiagnostic)).length;
    } catch { /* The next poll reads the state after its atomic replacement. */ }
  };
  try {
    report();
    gateway = await startGatewayForwarder(input.provider.baseUrl);
    prepareSub2apiProfile(profile, input.model, input.effort);
    // This container owns the profile. No machine profile, environment file or authentication file is read.
    process.env.CODEX_HOME = profile;
    process.env.DEEPSCIENTIST_MATH_ENV_FILE = path.join(scratch, 'math.env');
    fs.writeFileSync(process.env.DEEPSCIENTIST_MATH_ENV_FILE, '', { mode: 0o400, flag: 'wx' });
    fs.mkdirSync(project, { mode: 0o700 });
    const proofFile = path.join(project, 'Submission.lean');
    fs.writeFileSync(proofFile, input.proof, { mode: 0o400, flag: 'wx' });
    const buildIndex = readMathJson(process.env.THEOREMOS_WORKER_BUILD || '/opt/theoremos-build.json') as { buildManifestRef: string };
    readMathBuildManifest(buildIndex.buildManifestRef, root, path.join(root, 'out/main'));
    const writer = { model: input.model, effort: input.effort, profile,
      executable: input.provider.execution?.executable ?? process.env.DEEPSCIENTIST_MATH_CODEX_EXECUTABLE ?? 'codex' };
    const request = prepareInformalization(directory, {
      proofId: input.target.replace(/[^A-Za-z0-9_-]+/gu, '_').slice(0, 128), proofFile, projectRoot: project,
      target: input.target, environment: input.environment, statement: null, alignment: INFORMALIZATION_ALIGNMENT,
      explanationPolicy: INFORMALIZATION_EXPLANATION_POLICY, outlinePolicy: INFORMALIZATION_OUTLINE_POLICY, language: input.language, writer,
      auditors: Array.from({ length: input.auditors }, (_, index) => ({ ...writer, id: `auditor-${index + 1}` })),
      batching: { maxUnits: 12, maxSourceBytes: 60_000 }, maxRoundsPerBatch: input.maxRoundsPerBatch,
      maxRunSeconds: input.maxRunSeconds, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: input.maxTotalTokens,
      buildManifestRef: buildIndex.buildManifestRef });
    const restored = input.checkpoint && restoreExplanationCheckpoint(directory, informalizationDigest(request), input.checkpoint);
    delete input.checkpoint;
    let refreshOnResume = restored;
    poll = setInterval(() => { refresh(); report(); }, 10_000);
    const run = () => runInformalization(directory, root, {
      openSession: options => createCodexMathSession({ ...options,
        environment: { ...options.environment, [SUB2API_PROVIDER.apiKeyEnvironment]: key } }),
      onEvent: event => {
        if (refreshOnResume) { refresh(); refreshOnResume = false; }
        if (event.round) progress.round = event.round;
        if (event.event === 'informalization_extraction_started') report('extracting');
        else if (event.event === 'informalization_role_started')
          report(event.role === 'audit' ? 'auditing' : (event.round ?? 1) > 1 ? 'revising' : 'writing');
        else if (event.event === 'informalization_role_retrying') report('retrying');
        else if (event.event === 'informalization_role_finished' && isRetryableInformalizationFailure(event.failureDiagnostic)) {
          progress.modelRequestFailures = (progress.modelRequestFailures ?? 0) + 1;
          report();
        } else if (event.event === 'informalization_extraction_finished' || event.event === 'informalization_batch_approved') {
          refresh(); report();
        } else if (event.event === 'informalization_approved') { refresh(); report('finishing'); }
      } });
    let result;
    try { result = await run(); }
    catch (error) {
      // Profile or runtime changes can invalidate a matching request before a role opens.
      if (!restored || !(error instanceof Error) || error.message !== 'informalization_resume_identity_changed') throw error;
      for (const name of ['state.json', 'outline.json', 'batches'])
        fs.rmSync(path.join(directory, name), { recursive: true, force: true });
      refreshOnResume = false;
      result = await run();
    }
    clearInterval(poll);
    if (result.status === 'approved')
      await send({ type: 'result', status: 'approved', evidence: readInformalizationArtifact(path.join(directory, 'artifact')) });
    else {
      const outcome = explanationStopReason(result.status, result.error,
        input.maxRunSeconds > 0 && Date.now() - startedAt >= input.maxRunSeconds * 1_000);
      let checkpoint: WorkerExplanationCheckpoint | undefined;
      if (outcome.reason === informalizationRetryLimit) {
        try { checkpoint = captureExplanationCheckpoint(directory, key); }
        catch { /* The stop reason is still useful if the scratch checkpoint could not be read. */ }
      }
      await send({ type: 'result', ...outcome, ...(checkpoint ? { checkpoint } : {}) });
    }
  } catch (error) {
    await send({ type: 'result', ...explanationStopReason('stopped', error instanceof Error ? error.message : undefined, false) });
    process.exitCode = 1;
  } finally {
    clearInterval(poll);
    input.apiKey = '';
    // Kept-alive relay connections would hold close() open; the process exits right after this.
    gateway?.close();
    console.log = originalLog; console.error = originalError;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({ type: 'result', status: 'error', reason: 'explanation_input_invalid' }) + '\n');
    process.exitCode = 1;
  }).finally(() => process.exit());
}
