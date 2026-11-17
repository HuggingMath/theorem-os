import { assertWorkflowSessionSupported, openWorkflowSession, workflowProfileFiles } from './workflowSession';
import { completedWorkflowOutput, nativeWorkflowOutputInstructions, usesNativeWorkflowOutput } from './workflowOutput';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parse as parseToml } from 'smol-toml';
import type { MathAgentOptions, MathAgentSession } from '../runtime/agentSession';
import { readFormalizationEvaluationBundle, formalizationEvaluationInputDigest,
  formalizationEvaluationDecisionFileSchema, MAX_FORMALIZATION_EVALUATION_BYTES,
  type FormalizationEvaluationReviewerInput } from '../math/formalizationEvaluation';
import { assertFormalizationSemanticReview, formalizationReviewConfigurationSchema, formalizationReviewReplaySchema,
  formalizationSemanticReviewOutputSchema, FORMALIZATION_SEMANTIC_REVIEW_INSTRUCTIONS,
  type FormalizationReviewConfiguration, type LegacyFormalizationReviewConfiguration, type FormalizationSemanticReview } from '../math/formalizationReview';
import { canonicalMathJson, mathDigest, readMathText, withMathRuntimeLease,
  writeMathFrozen, writeMathJsonDurable } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { getLeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { readMathBuildManifest } from '../math/mathBuildManifest';
import { resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { assertFormalizationReviewIsolation as assertIsolation } from './formalizationReviewIsolation';
import { runStructuredFormalizationReview, type StructuredReviewOptions } from './formalizationReviewV2';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const caseId = z.string().regex(/^case_[a-f0-9]{64}$/u);
const digest = (value: unknown) => mathDigest(canonicalMathJson(value));
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).slice(0, 16000);
const attemptSchema = z.object({
  id: z.string().uuid(), caseId, workspace: z.string().regex(/^roles\/[a-f0-9-]{36}$/u),
  status: z.enum(['opening', 'running', 'completed', 'failed', 'interrupted']),
  threadId: z.string().min(1).optional(), turnId: z.string().min(1).optional(),
  sessionStatus: z.string().optional(), error: z.string().optional(),
  usage: z.record(z.unknown()), usageIncomplete: z.boolean(), isolationReceipt: z.record(z.unknown()).optional(),
}).strict();
type Attempt = z.infer<typeof attemptSchema>;
const stateSchema = z.object({
  schema: z.literal('theorem-os.formalization-review-state.v1'), requestDigest: hash,
  status: z.enum(['running', 'complete', 'partial', 'stopped']), attempts: z.array(attemptSchema),
  receipts: z.record(hash),
}).strict();
const receiptSchema = z.object({
  schema: z.literal('theorem-os.formalization-review-receipt.v1'), requestDigest: hash,
  caseId, inputDigest: hash, attempt: attemptSchema,
  outputDigest: hash, outputFileSha256: hash,
}).strict();
type Options = StructuredReviewOptions;

function outside(value: string) {
  const directory = path.resolve(value); assertMathCanonicalPath(directory);
  if (isMathPathWithin(root, directory) || isMathPathWithin(directory, root))
    throw new Error('formalization_review_directory_must_be_external');
  return directory;
}
function frozenText(file: string, maximum: number) {
  assertMathCanonicalPath(file);
  if ((fs.lstatSync(file).mode & 0o222) !== 0) throw new Error('formalization_review_evidence_not_frozen');
  return readMathText(file, maximum);
}

/**
 * Run one direct blind review per candidate, with fresh sessions and resumable host receipts.
 * Replay is an explicit preset adapter; only the production model adapter can record model turns.
 */
export async function runFormalizationReview(bundleDirectory: string, runDirectory: string,
  configurationValue: FormalizationReviewConfiguration, options: Options = {}) {
  const parsed = formalizationReviewConfigurationSchema.parse(configurationValue);
  if ('protocol' in parsed) return runStructuredFormalizationReview(bundleDirectory, runDirectory, parsed, options);
  const configuration = parsed as LegacyFormalizationReviewConfiguration;
  const prepared = readFormalizationEvaluationBundle(bundleDirectory);
  runDirectory = outside(runDirectory);
  if (isMathPathWithin(prepared.directory, runDirectory) || isMathPathWithin(runDirectory, prepared.directory))
    throw new Error('formalization_review_run_overlaps_bundle');
  const adapter = options.openSession ? 'injected-preset' : configuration.execution === 'replay' ? 'saved-preset' : configuration.agentHarness?.id ?? 'codex';
  const production = configuration.execution === 'model' && !options.openSession;
  const config = configuration.execution === 'model' ? { ...configuration, profile: path.resolve(configuration.profile),
    buildManifestRef: path.resolve(configuration.buildManifestRef) } :
    { ...configuration, replayFile: path.resolve(configuration.replayFile) };
  const inputs = [...prepared.inputs.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
  const inputById = new Map(inputs.map(input => [input.caseId, input]));
  if (config.execution === 'model' && config.agentHarness && options.openSession) throw new Error('math_workflow_harness_injection_conflict');
  if (config.execution === 'model') assertWorkflowSessionSupported(config, { environment: config.environment });
  const preset = new Map<string, FormalizationSemanticReview>();
  let replaySha256: string | undefined;
  if (config.execution === 'replay') {
    assertMathCanonicalPath(config.replayFile);
    const replayText = readMathText(config.replayFile, MAX_FORMALIZATION_EVALUATION_BYTES);
    replaySha256 = mathDigest(replayText);
    const replay = formalizationReviewReplaySchema.parse(JSON.parse(replayText));
    if (replay.bundleDigest !== prepared.bundleDigest) throw new Error('formalization_review_replay_bundle_mismatch');
    for (const value of replay.outputs) {
      const input = inputById.get(value.caseId);
      if (!input || preset.has(value.caseId)) throw new Error('formalization_review_replay_case_invalid');
      preset.set(value.caseId, assertFormalizationSemanticReview(input, value));
    }
  }
  const currentExecutionBinding = () => {
    if (config.execution === 'replay') return mathDigest(readMathText(config.replayFile, MAX_FORMALIZATION_EVALUATION_BYTES));
    const build = readMathBuildManifest(config.buildManifestRef, root, path.join(root, 'out/main'));
    assertMathCanonicalPath(config.profile);
    const profileText = readMathText(path.join(config.profile, 'config.toml'), 2_000_000);
    const profile = parseToml(profileText);
    let catalog: string | null = null;
    if (typeof profile.model_catalog_json === 'string') {
      if (!path.isAbsolute(profile.model_catalog_json)) throw new Error('formalization_review_catalog_path_invalid');
      assertMathCanonicalPath(profile.model_catalog_json);
      catalog = mathDigest(readMathText(profile.model_catalog_json, 2_000_000));
    }
    return digest({ build, profileSha256: mathDigest(profileText), catalog,
      ...(config.agentHarness ? { harness: workflowProfileFiles(config, () => null, options.env ?? process.env) } : {}) });
  };
  const binding = currentExecutionBinding();
  const savedRequest = fs.existsSync(path.join(runDirectory, 'request.json'))
    ? JSON.parse(frozenText(path.join(runDirectory, 'request.json'), 32_000_000)) : undefined;
  const outputDelivery = savedRequest ? savedRequest.outputDelivery as 'native-schema' | 'file' | undefined : 'native-schema';
  const nativeOutput = usesNativeWorkflowOutput(config, config.execution, outputDelivery);
  const instructions = nativeOutput ? nativeWorkflowOutputInstructions(FORMALIZATION_SEMANTIC_REVIEW_INSTRUCTIONS)
    : FORMALIZATION_SEMANTIC_REVIEW_INSTRUCTIONS;
  const request = { schema: 'theorem-os.formalization-review-run.v1', bundleDirectory: prepared.directory,
    ...(outputDelivery ? { outputDelivery } : {}),
    bundleDigest: prepared.bundleDigest, configuration: config, adapter, executionBinding: binding,
    environmentDigest: getLeanTaskEnvironment(config.environment).dependencyDigest,
    instructionsSha256: mathDigest(instructions), inputDigests: inputs.map(input => ({ caseId: input.caseId,
      inputDigest: formalizationEvaluationInputDigest(input), outputSchemaDigest: digest(formalizationSemanticReviewOutputSchema(input)) })),
    timeoutMs: 0, protocol: 'direct-semantic-blind-review-v1' };
  const requestText = canonicalMathJson(request), requestDigest = mathDigest(requestText);
  const existed = fs.existsSync(runDirectory);
  if (!existed) fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const requestFile = path.join(runDirectory, 'request.json'), stateFile = path.join(runDirectory, 'state.json');
  // Cancellation stops the role, while the writer lease remains held to checkpoint it.
  return withMathRuntimeLease({ lockPath: path.join(runDirectory, 'run.lock'), flockExecutable: '/usr/bin/flock' }, async lease => {
    const signal = options.signal ? AbortSignal.any([lease.signal, options.signal]) : lease.signal;
    if (fs.existsSync(requestFile)) {
      if (frozenText(requestFile, 32_000_000) !== requestText) throw new Error('formalization_review_request_changed');
    } else {
      if (existed && fs.readdirSync(runDirectory).some(name => name !== 'run.lock'))
        throw new Error('formalization_review_run_not_empty');
      writeMathFrozen(requestFile, requestText);
    }
    const state = fs.existsSync(stateFile) ? stateSchema.parse(JSON.parse(readMathText(stateFile, 64_000_000))) :
      stateSchema.parse({ schema: 'theorem-os.formalization-review-state.v1', requestDigest, status: 'running', attempts: [], receipts: {} });
    if (state.requestDigest !== requestDigest) throw new Error('formalization_review_state_changed');
    for (const attempt of state.attempts) {
      if (!inputById.has(attempt.caseId)) throw new Error('formalization_review_state_changed');
      if (attempt.status === 'opening' || attempt.status === 'running') attempt.status = 'interrupted';
    }
    const completed = new Map<string, FormalizationSemanticReview>();
    const receiptDirectory = path.join(runDirectory, 'receipts');
    fs.mkdirSync(receiptDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(runDirectory, 'roles'), { recursive: true, mode: 0o700 });
    const expectedInputText = (input: FormalizationEvaluationReviewerInput) => canonicalMathJson(input) + '\n';
    const expectedSchemaText = (input: FormalizationEvaluationReviewerInput) => canonicalMathJson(formalizationSemanticReviewOutputSchema(input)) + '\n';
    const checkWorkspace = (workspace: string, input: FormalizationEvaluationReviewerInput) => {
      if (frozenText(path.join(workspace, 'INPUT.json'), 1_000_000) !== expectedInputText(input) ||
          frozenText(path.join(workspace, 'ROLE.md'), 256_000) !== instructions ||
          frozenText(path.join(workspace, 'OUTPUT.schema.json'), 1_000_000) !== expectedSchemaText(input))
        throw new Error('formalization_review_protocol_changed');
    };
    // Completed receipts are authoritative checkpoints, including an explicit unknown.
    // Recover a receipt saved immediately before a process stopped updating state.json.
    for (const name of fs.readdirSync(receiptDirectory)) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      const input = inputById.get(id);
      if (!input) throw new Error('formalization_review_receipt_case_invalid');
      const file = path.join(receiptDirectory, name), contents = frozenText(file, 1_000_000);
      if (state.receipts[id] && state.receipts[id] !== mathDigest(contents)) throw new Error('formalization_review_receipt_changed');
      const receipt = receiptSchema.parse(JSON.parse(contents));
      if (receipt.requestDigest !== requestDigest || receipt.caseId !== id ||
          receipt.inputDigest !== formalizationEvaluationInputDigest(input) || receipt.attempt.caseId !== id ||
          receipt.attempt.status !== 'completed' || !receipt.attempt.threadId || !receipt.attempt.turnId ||
          !['completed', 'submitted'].includes(receipt.attempt.sessionStatus ?? ''))
        throw new Error('formalization_review_receipt_changed');
      const workspace = path.join(runDirectory, receipt.attempt.workspace); checkWorkspace(workspace, input);
      const text = frozenText(path.join(workspace, 'OUTPUT.json'), 1_000_000);
      const output = assertFormalizationSemanticReview(input, JSON.parse(text));
      if (receipt.outputFileSha256 !== mathDigest(text) || receipt.outputDigest !== digest(output))
        throw new Error('formalization_review_receipt_changed');
      if (production) assertIsolation(receipt.attempt.isolationReceipt, config.environment,
        expectedInputText(input), instructions, expectedSchemaText(input));
      const previous = state.attempts.find(attempt => attempt.id === receipt.attempt.id);
      if (previous) Object.assign(previous, receipt.attempt); else state.attempts.push(receipt.attempt);
      state.receipts[id] = mathDigest(contents); completed.set(id, output);
    }
    for (const id of Object.keys(state.receipts)) if (!completed.has(id)) throw new Error('formalization_review_receipt_missing');
    const threads = state.attempts.flatMap(attempt => attempt.threadId ? [attempt.threadId] : []);
    if (new Set(threads).size !== threads.length) throw new Error('formalization_review_thread_reused');
    const decisionsFile = path.join(runDirectory, 'decisions.json');
    const save = () => {
      lease.assertHeld();
      writeMathJsonDurable(stateFile, state);
      const decisions = formalizationEvaluationDecisionFileSchema.parse({
        schema: 'theorem-os.formalization-review-decisions.v1', bundleDigest: prepared.bundleDigest,
        origin: { kind: production ? 'model' : 'preset', reviewer: 'TheoremOS direct blind semantic reviewer v1',
          protocol: production ? 'Fresh isolated session per candidate; input-bound host receipts. Compilation remains unobserved.' :
            'Offline preset session replay; integration evidence only, no model accuracy measured.',
          ...(production && config.execution === 'model' ? { model: config.model } : {}) },
        decisions: inputs.map(input => ({ caseId: input.caseId, inputDigest: formalizationEvaluationInputDigest(input),
          verdict: completed.get(input.caseId)?.verdict ?? 'unknown', compileStatus: 'unknown' })) });
      writeMathJsonDurable(decisionsFile, decisions);
    };
    const assertCurrent = () => {
      if (frozenText(requestFile, 32_000_000) !== requestText || currentExecutionBinding() !== binding ||
          config.execution === 'replay' && binding !== replaySha256 ||
          readFormalizationEvaluationBundle(prepared.directory).bundleDigest !== prepared.bundleDigest)
        throw new Error('formalization_review_request_changed');
    };
    state.status = 'running'; save();
    for (const input of inputs) {
      if (completed.has(input.caseId)) continue;
      if (signal.aborted) { state.status = 'stopped'; break; }
      assertCurrent();
      const id = crypto.randomUUID(), relative = 'roles/' + id, workspace = path.join(runDirectory, relative);
      fs.mkdirSync(workspace, { mode: 0o700 });
      writeMathFrozen(path.join(workspace, 'INPUT.json'), expectedInputText(input));
      writeMathFrozen(path.join(workspace, 'ROLE.md'), instructions);
      writeMathFrozen(path.join(workspace, 'OUTPUT.schema.json'), expectedSchemaText(input));
      const outputFile = path.join(workspace, 'OUTPUT.json');
      const attempt: Attempt = { id, caseId: input.caseId, workspace: relative, status: 'opening', usage: {}, usageIncomplete: false };
      state.attempts.push(attempt); save(); options.onEvent?.({ event: 'started', caseId: input.caseId });
      let session: MathAgentSession | undefined, closing: Promise<void> | undefined;
      const close = () => session ? closing ??= session.close() : Promise.resolve();
      const interrupt = () => { void session?.interrupt().catch(() => {}); void close().catch(() => {}); };
      signal.addEventListener('abort', interrupt, { once: true });
      try {
        const sessionOptions: MathAgentOptions = {
          executable: config.execution === 'model' ? config.executable : 'offline-replay',
          profile: config.execution === 'model' ? config.profile : workspace,
          model: config.execution === 'model' ? config.model : 'offline-replay',
          effort: config.execution === 'model' ? config.effort : 'offline-replay', workspace, instructions,
          environment: production ? resolveMathematicsRuntimeEnvironment(options.env) : options.env,
          signal, readIsolation: { environment: config.environment },
          ...(nativeOutput ? { outputSchema: formalizationSemanticReviewOutputSchema(input) } : {
            completedOutput: { file: outputFile, validate: (value: unknown) => { assertFormalizationSemanticReview(input, value); } } }),
          onUsage: usage => { attempt.usage = usage; save(); },
          onUsageIncomplete: () => { attempt.usageIncomplete = true; save(); },
        };
        session = options.openSession ? await options.openSession(sessionOptions) : config.execution === 'model' ?
          await openWorkflowSession(config, sessionOptions) : {
            threadId: 'preset-' + id,
            run: async (_message, _messageId, _workspace, onStarted) => {
              onStarted('preset-turn-' + id);
              const value = preset.get(input.caseId);
              if (value) writeMathFrozen(outputFile, canonicalMathJson(value) + '\n');
              return 'completed';
            }, interrupt: async () => {}, close: async () => {},
          };
        if (production) assertIsolation(session.isolationReceipt, config.environment,
          expectedInputText(input), instructions, expectedSchemaText(input));
        if (!session.threadId || state.attempts.some(other => other !== attempt && other.threadId === session!.threadId))
          throw new Error('formalization_review_thread_reused');
        attempt.threadId = session.threadId;
        if (session.isolationReceipt) attempt.isolationReceipt = session.isolationReceipt;
        signal.throwIfAborted(); attempt.status = 'running'; save();
        const message = 'Read INPUT.json, ROLE.md and OUTPUT.schema.json. Review this statement and submit OUTPUT.json using the exact contract.';
        attempt.sessionStatus = await session.run(nativeOutput ? nativeWorkflowOutputInstructions(message) : message,
          crypto.randomUUID(), workspace, turnId => { attempt.turnId = turnId; save(); });
        signal.throwIfAborted();
        if (!['completed', 'submitted'].includes(attempt.sessionStatus) || !attempt.turnId)
          throw new Error('formalization_review_session_incomplete');
        await close();
        assertCurrent(); checkWorkspace(workspace, input);
        assertMathCanonicalPath(outputFile);
        const text = nativeOutput ? completedWorkflowOutput(session, attempt.turnId, 1_000_000) : readMathText(outputFile, 1_000_000);
        const output = assertFormalizationSemanticReview(input, JSON.parse(text));
        if (nativeOutput) writeMathFrozen(outputFile, text);
        fs.chmodSync(outputFile, 0o400);
        attempt.status = 'completed';
        const receipt = receiptSchema.parse({ schema: 'theorem-os.formalization-review-receipt.v1', requestDigest,
          caseId: input.caseId, inputDigest: formalizationEvaluationInputDigest(input), attempt,
          outputDigest: digest(output), outputFileSha256: mathDigest(text) });
        const contents = canonicalMathJson(receipt), receiptFile = path.join(receiptDirectory, input.caseId + '.json');
        writeMathFrozen(receiptFile, contents); state.receipts[input.caseId] = mathDigest(contents);
        completed.set(input.caseId, output); save(); options.onEvent?.({ event: 'completed', caseId: input.caseId });
      } catch (cause) {
        await close();
        assertCurrent(); checkWorkspace(workspace, input);
        attempt.status = signal.aborted ? 'interrupted' : 'failed';
        attempt.error = errorText(cause); save(); options.onEvent?.({ event: 'failed', caseId: input.caseId });
        if (/formalization_review_(?:request_changed|protocol_changed|thread_reused|isolation_invalid|evidence_not_frozen)/u.test(attempt.error)) throw cause;
        if (signal.aborted) { state.status = 'stopped'; break; }
      } finally {
        signal.removeEventListener('abort', interrupt);
        await close();
      }
    }
    assertCurrent();
    state.status = completed.size === inputs.length ? 'complete' : state.status === 'stopped' ? 'stopped' : 'partial';
    save();
    return { schema: 'theorem-os.formalization-review-run-result.v1', status: state.status, directory: runDirectory,
      bundleDigest: prepared.bundleDigest, requestDigest, execution: config.execution, adapter,
      modelInvoked: production && state.attempts.some(attempt => Boolean(attempt.turnId)),
      interpretation: production ? 'direct-semantic-review-against-supplied-labels' : 'preset-session-integration-not-model-accuracy',
      totalCases: inputs.length, completedCases: completed.size, failedOrPendingCases: inputs.length - completed.size,
      unknownCases: inputs.filter(input => !completed.has(input.caseId) || completed.get(input.caseId)!.verdict === 'unknown').length,
      attempts: state.attempts.length, decisionsFile, compilationObserved: false, timeoutMs: 0 };
  });
}
