import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { createCodexMathSession, type MathAgentOptions, type MathAgentSession } from '../runtime/codexSession';
import { formalizationEvaluationDecisionFileSchema, formalizationEvaluationInputDigest,
  formalizationEvaluationLeanSource, readFormalizationEvaluationBundle, MAX_FORMALIZATION_EVALUATION_BYTES,
  type FormalizationEvaluationReviewerInput } from '../math/formalizationEvaluation';
import { formalizationTranslationSchema, type FormalizationTranslation } from '../math/formalization';
import { deriveFormalizationRoleOutputJsonSchema } from '../math/formalizationRoleContract';
import { assertReviewBacktranslation, assertReviewStatementObservation, assertStructuredSemanticReview,
  resolveReviewEnvironment, resolveStructuredReviews, structuredReviewAspects,
  structuredReviewDigest as digest, structuredReviewInput, structuredReviewOutputSchema,
  structuredReviewRecheckReasons, structuredReviewReplaySchema, STRUCTURED_REVIEW_PROTOCOL,
  formalizationReviewInstructions,
  type ReviewEnvironmentContext, type ReviewStatementObservation, type ReviewStatementSnapshot,
  type StructuredReviewConfiguration, type StructuredSemanticReview } from '../math/formalizationReviewV2';
import { canonicalMathJson, mathDigest, readMathText, withMathRuntimeLease,
  writeMathFrozen, writeMathJsonDurable } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { readMathBuildManifest } from '../math/mathBuildManifest';
import { resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import type { LeanStatementContextProtocol } from '../math/leanStatementSemantic';
import { elaborateFormalization } from './formalizationElaboration';
import { checkFormalizationFidelity } from './formalizationFidelity';
import type { compareFormalizationReference } from './formalizationReference';
import { assertFormalizationReviewIsolation } from './formalizationReviewIsolation';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const caseId = z.string().regex(/^case_[a-f0-9]{64}$/u);
const roleSchema = z.enum(['primary', 'backtranslate', 'recheck']);
type Role = z.infer<typeof roleSchema>;
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).slice(0, 16000);
const turnSchema = z.object({ messageId: z.string().uuid(), messageSha256: hash,
  turnId: z.string().min(1).optional(), sessionStatus: z.string().optional(),
  // Native usage is cumulative for this thread, including earlier correction turns.
  usage: z.record(z.unknown()), usageIncomplete: z.boolean() }).strict();
const feedbackRefSchema = z.object({
  file: z.string().regex(/^output-feedback\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.json$/u), sha256: hash,
}).strict();
const attemptSchema = z.object({ id: z.string().uuid(), caseId, role: roleSchema,
  workspace: z.string().regex(/^roles\/[a-f0-9-]{36}$/u), inputDigest: hash,
  status: z.enum(['opening', 'running', 'completed', 'failed', 'interrupted']),
  threadId: z.string().min(1).optional(), turnId: z.string().min(1).optional(), sessionStatus: z.string().optional(),
  error: z.string().optional(), usage: z.record(z.unknown()), usageIncomplete: z.boolean(),
  isolationReceipt: z.record(z.unknown()).optional(),
  turns: z.array(turnSchema).optional(), outputFeedback: z.array(feedbackRefSchema).optional() }).strict();
type Attempt = z.infer<typeof attemptSchema>;
const stateSchema = z.object({ schema: z.literal('theorem-os.formalization-review-state.v2'), requestDigest: hash,
  status: z.enum(['running', 'complete', 'partial', 'stopped']), attempts: z.array(attemptSchema),
  receipts: z.record(hash), caseErrors: z.record(z.string()) }).strict();
const roleReceiptSchema = z.object({ schema: z.literal('theorem-os.formalization-review-role-receipt.v2'),
  requestDigest: hash, caseId, role: roleSchema, inputDigest: hash, outputDigest: hash,
  outputFileSha256: hash, attempt: attemptSchema }).strict();
const receiptSchema = z.object({ schema: z.literal('theorem-os.formalization-review-receipt.v2'), requestDigest: hash,
  caseId, inputDigest: hash, observationSha256: hash, roles: z.record(hash),
  verdict: z.enum(['approved', 'changes_requested', 'unknown']), reasons: z.array(z.string()),
  resolution: z.enum(['primary', 'independent-agreement', 'shared-mismatch-aspect', 'review-disagreement', 'observation-unavailable', 'fidelity-not-established']),
  fidelityChecks: z.record(hash).optional(),
  reviewAgreement: z.object({ aspectDisagreements: z.array(z.enum(structuredReviewAspects)),
    sharedMismatches: z.array(z.enum(structuredReviewAspects)) }).strict().nullable() }).strict();
type Receipt = z.infer<typeof receiptSchema>;

export type StructuredReviewOptions = {
  /** Any injected role/observation adapter makes the entire run preset evidence. */
  openSession?: (options: MathAgentOptions) => Promise<MathAgentSession>;
  observeStatement?: (directory: string, input: FormalizationEvaluationReviewerInput,
    environment: ReviewEnvironmentContext, env: NodeJS.ProcessEnv, signal: AbortSignal,
    contextProtocol?: LeanStatementContextProtocol) => Promise<ReviewStatementObservation>;
  env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  compareReference?: typeof compareFormalizationReference;
  onEvent?: (event: { event: 'started' | 'completed' | 'failed'; caseId: string }) => void;
};

function frozenText(file: string, limit = 8_000_000) {
  assertMathCanonicalPath(file);
  if ((fs.lstatSync(file).mode & 0o222) !== 0) throw new Error('formalization_review_evidence_not_frozen');
  return readMathText(file, limit);
}

function outputValidationFeedback(cause: unknown, role: Role): string {
  const diagnostic = cause instanceof z.ZodError ? cause.issues.map(issue =>
    `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n').slice(0, 16000) : errorText(cause);
  return [
    'OUTPUT.json was not accepted. Repair the output contract in this same role and thread.',
    'Host validation error (data): ' + JSON.stringify(diagnostic),
    'Read OUTPUT.schema.json and the current INPUT.json again. Write the complete corrected JSON atomically to OUTPUT.json.',
    ...(role === 'backtranslate' ? [] : [
      'originalFragment must be a contiguous verbatim substring of INPUT.json.original. candidateFragment must be a contiguous verbatim substring of the header, candidate or observed type/definition/binder types. Preserve whitespace and newlines after JSON decoding. Do not add ellipses or commentary inside quotations; put explanations in explanation and conversion arguments.',
    ]),
    'Preserve your independent mathematical assessment. A valid unknown is acceptable. This feedback supplies no semantic verdict. Do not modify INPUT.json, ROLE.md or OUTPUT.schema.json.',
    'After submitting a valid OUTPUT.json, stop.',
  ].join('\n');
}

async function observeStatement(directory: string, input: FormalizationEvaluationReviewerInput,
  environment: ReviewEnvironmentContext, env: NodeJS.ProcessEnv, signal: AbortSignal,
  contextProtocol?: LeanStatementContextProtocol): Promise<ReviewStatementObservation> {
  const rawSource = formalizationEvaluationLeanSource(input);
  const base = { schema: 'theorem-os.formalization-review-observation.v2' as const, caseId: input.caseId,
    inputDigest: formalizationEvaluationInputDigest(input), environment };
  try {
    if (environment.compatibility !== 'matched') throw new Error('Source and active environment are ' + environment.compatibility);
    const elaborated = await elaborateFormalization(directory, rawSource, environment.environment,
      { env, signal, timeoutMs: 0, detailedContext: true,
        ...(contextProtocol === 'kernel-v2' ? { structureContext: true } :
          contextProtocol === 'kernel-v1' ? { semanticContext: true } : {}) });
    return { ...base, sourceSha256: elaborated.sourceSha256, status: 'elaborated',
      snapshot: elaborated.snapshot as ReviewStatementSnapshot, snapshotDigest: elaborated.snapshotDigest, diagnostics: '' };
  } catch (cause) {
    signal.throwIfAborted();
    return { ...base, sourceSha256: mathDigest(rawSource), status: 'unavailable', snapshot: null, snapshotDigest: null,
      diagnostics: errorText(cause) };
  }
}

/** Version-aware review; role receipts are checkpoints, and final cases require all routed roles. */
export async function runStructuredFormalizationReview(bundleDirectory: string, runDirectory: string,
  config: StructuredReviewConfiguration, options: StructuredReviewOptions = {}) {
  const prepared = readFormalizationEvaluationBundle(bundleDirectory);
  runDirectory = path.resolve(runDirectory); assertMathCanonicalPath(runDirectory);
  if (isMathPathWithin(root, runDirectory) || isMathPathWithin(runDirectory, root) ||
      isMathPathWithin(prepared.directory, runDirectory) || isMathPathWithin(runDirectory, prepared.directory))
    throw new Error('formalization_review_directory_must_be_external');
  if ((options.observeStatement || options.compareReference) && !options.openSession)
    throw new Error('formalization_review_observer_injection_requires_session_adapter');
  config = config.execution === 'model' ? { ...config, profile: path.resolve(config.profile),
    buildManifestRef: path.resolve(config.buildManifestRef) } : { ...config, replayFile: path.resolve(config.replayFile) };
  const semanticContext = config.contextProtocol !== undefined, structureContext = config.contextProtocol === 'kernel-v2';
  const reviewInstructions = formalizationReviewInstructions('review', semanticContext, structureContext, config.fidelityPolicy);
  const backtranslationInstructions = formalizationReviewInstructions('backtranslate', semanticContext, structureContext);
  const production = config.execution === 'model' && !options.openSession;
  const adapter = options.openSession ? 'injected-preset' : production ? 'codex' : 'saved-preset';
  const inputs = [...prepared.inputs.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
  const inputById = new Map(inputs.map(input => [input.caseId, input]));
  const environment = resolveReviewEnvironment({ sourceToolchain: prepared.bundle.provenance.sourceToolchain,
    sourceMathlibRevision: prepared.bundle.provenance.sourceMathlibRevision }, config.environment);
  const presetRoles = new Map<string, unknown>(), presetObservations = new Map<string, ReviewStatementObservation>();
  let replaySha256: string | undefined;
  if (config.execution === 'replay') {
    const replayText = readMathText(config.replayFile, MAX_FORMALIZATION_EVALUATION_BYTES);
    replaySha256 = mathDigest(replayText);
    const replay = structuredReviewReplaySchema.parse(JSON.parse(replayText));
    if (replay.bundleDigest !== prepared.bundleDigest) throw new Error('formalization_review_replay_bundle_mismatch');
    for (const value of replay.observations) {
      const id = (value as ReviewStatementObservation)?.caseId, input = inputById.get(id);
      if (!input || presetObservations.has(id)) throw new Error('formalization_review_replay_case_invalid');
      presetObservations.set(id, assertReviewStatementObservation(input, environment, value, config.contextProtocol));
    }
    for (const value of replay.roles) {
      const key = value.caseId + ':' + value.role;
      if (!inputById.has(value.caseId) || presetRoles.has(key)) throw new Error('formalization_review_replay_case_invalid');
      presetRoles.set(key, value.output);
    }
  }
  const executionBinding = () => {
    if (config.execution === 'replay') return mathDigest(readMathText(config.replayFile, MAX_FORMALIZATION_EVALUATION_BYTES));
    const build = readMathBuildManifest(config.buildManifestRef, root, path.join(root, 'out/main'));
    assertMathCanonicalPath(config.profile);
    const profileText = readMathText(path.join(config.profile, 'config.toml'), 2_000_000), profile = parseToml(profileText);
    let catalog: string | null = null;
    if (typeof profile.model_catalog_json === 'string') {
      if (!path.isAbsolute(profile.model_catalog_json)) throw new Error('formalization_review_catalog_path_invalid');
      assertMathCanonicalPath(profile.model_catalog_json); catalog = mathDigest(readMathText(profile.model_catalog_json, 2_000_000));
    }
    return digest({ build, profileSha256: mathDigest(profileText), catalog });
  };
  const binding = executionBinding();
  const request = { schema: 'theorem-os.formalization-review-run.v2', protocol: STRUCTURED_REVIEW_PROTOCOL,
    bundleDirectory: prepared.directory, bundleDigest: prepared.bundleDigest, configuration: config, adapter,
    executionBinding: binding, environment, timeoutMs: 0,
    instructions: { primary: mathDigest(reviewInstructions), recheck: mathDigest(reviewInstructions),
      backtranslate: mathDigest(backtranslationInstructions) },
    inputDigests: inputs.map(input => ({ caseId: input.caseId, inputDigest: formalizationEvaluationInputDigest(input) })),
    recheckPolicy: 'all-rejections-and-structural-or-evidence-risk-with-shared-mismatch-aspect' };
  const requestText = canonicalMathJson(request), requestDigest = mathDigest(requestText);
  const existed = fs.existsSync(runDirectory);
  if (!existed) fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  return withMathRuntimeLease({ lockPath: path.join(runDirectory, 'run.lock'), flockExecutable: '/usr/bin/flock' }, async lease => {
    const signal = options.signal ? AbortSignal.any([lease.signal, options.signal]) : lease.signal;
    const env = production ? resolveMathematicsRuntimeEnvironment(options.env) : options.env ?? {};
    const requestFile = path.join(runDirectory, 'request.json'), stateFile = path.join(runDirectory, 'state.json');
    if (fs.existsSync(requestFile)) {
      if (frozenText(requestFile, 32_000_000) !== requestText) throw new Error('formalization_review_request_changed');
    } else {
      if (existed && fs.readdirSync(runDirectory).some(name => name !== 'run.lock')) throw new Error('formalization_review_run_not_empty');
      writeMathFrozen(requestFile, requestText);
    }
    const state = fs.existsSync(stateFile) ? stateSchema.parse(JSON.parse(readMathText(stateFile, 64_000_000))) :
      stateSchema.parse({ schema: 'theorem-os.formalization-review-state.v2', requestDigest, status: 'running', attempts: [], receipts: {}, caseErrors: {} });
    if (state.requestDigest !== requestDigest) throw new Error('formalization_review_request_changed');
    for (const attempt of state.attempts) if (['opening', 'running'].includes(attempt.status)) attempt.status = 'interrupted';
    const threadIds = state.attempts.flatMap(attempt => attempt.threadId ? [attempt.threadId] : []);
    if (new Set(threadIds).size !== threadIds.length) throw new Error('formalization_review_thread_reused');
    for (const name of ['roles', 'role-receipts', 'observations', 'receipts', 'elaboration'])
      fs.mkdirSync(path.join(runDirectory, name), { mode: 0o700, recursive: true });
    const completed = new Map<string, Receipt>(), observations = new Map<string, ReviewStatementObservation>();
    const recovering = new Set<string>();
    for (const name of fs.readdirSync(path.join(runDirectory, 'receipts'))) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!inputById.has(id)) throw new Error('formalization_review_receipt_changed');
      const contents = frozenText(path.join(runDirectory, 'receipts', name));
      const receipt = receiptSchema.parse(JSON.parse(contents));
      if (receipt.caseId !== id || receipt.requestDigest !== requestDigest || state.receipts[id] && state.receipts[id] !== mathDigest(contents))
        throw new Error('formalization_review_receipt_changed');
      recovering.add(id);
    }
    for (const id of Object.keys(state.receipts)) if (!recovering.has(id)) throw new Error('formalization_review_receipt_missing');
    const decisionsFile = path.join(runDirectory, 'decisions.json');
    const save = () => {
      lease.assertHeld(); writeMathJsonDurable(stateFile, state);
      // Preserve published decisions until every previously completed case has been revalidated.
      if (recovering.size) return;
      writeMathJsonDurable(decisionsFile, formalizationEvaluationDecisionFileSchema.parse({
        schema: 'theorem-os.formalization-review-decisions.v1', bundleDigest: prepared.bundleDigest,
        origin: { kind: production ? 'model' : 'preset', reviewer: 'TheoremOS structured blind semantic reviewer v2',
          protocol: production ? 'Source-aware erased-statement observation; structured review; routed independent backtranslation and agreement.' :
            'Offline preset integration, including observations and role outputs; no model accuracy measured.',
          ...(production && config.execution === 'model' ? { model: config.model } : {}) },
        decisions: inputs.map(input => ({ caseId: input.caseId, inputDigest: formalizationEvaluationInputDigest(input),
          verdict: completed.get(input.caseId)?.verdict ?? 'unknown', compileStatus: 'unknown' })) }));
    };
    const assertCurrent = () => {
      lease.assertHeld();
      if (frozenText(requestFile, 32_000_000) !== requestText || executionBinding() !== binding ||
          config.execution === 'replay' && binding !== replaySha256 ||
          readFormalizationEvaluationBundle(prepared.directory).bundleDigest !== prepared.bundleDigest)
        throw new Error('formalization_review_request_changed');
    };
    const checkAttemptEvidence = (attempt: Attempt) => {
      if (attempt.turns && (!attempt.turns.length ||
          attempt.turns.some(turn => !turn.turnId || !['completed', 'submitted'].includes(turn.sessionStatus ?? '')) ||
          new Set(attempt.turns.map(turn => turn.turnId)).size !== attempt.turns.length ||
          attempt.turns.at(-1)!.turnId !== attempt.turnId ||
          attempt.turns.at(-1)!.sessionStatus !== attempt.sessionStatus))
        throw new Error('formalization_review_receipt_changed');
      for (const ref of attempt.outputFeedback ?? []) {
        if (!ref.file.startsWith('output-feedback/' + attempt.id + '/') ||
            mathDigest(frozenText(path.join(runDirectory, ref.file))) !== ref.sha256)
          throw new Error('formalization_review_receipt_changed');
      }
    };
    const stage = async <T>(input: FormalizationEvaluationReviewerInput, role: Role, payload: object,
      schema: object, validate: (value: unknown) => T): Promise<T> => {
      assertCurrent();
      const instructions = role === 'backtranslate' ? backtranslationInstructions : reviewInstructions;
      const inputText = canonicalMathJson(payload) + '\n', schemaText = canonicalMathJson(schema) + '\n';
      const roleInputDigest = digest(payload), key = input.caseId + ':' + role;
      const receiptFile = path.join(runDirectory, 'role-receipts', input.caseId + '-' + role + '.json');
      const checkWorkspace = (workspace: string) => {
        if (frozenText(path.join(workspace, 'INPUT.json')) !== inputText ||
            frozenText(path.join(workspace, 'ROLE.md')) !== instructions ||
            frozenText(path.join(workspace, 'OUTPUT.schema.json')) !== schemaText)
          throw new Error('formalization_review_protocol_changed');
      };
      if (fs.existsSync(receiptFile)) {
        const receipt = roleReceiptSchema.parse(JSON.parse(frozenText(receiptFile)));
        const attempt = receipt.attempt, workspace = path.join(runDirectory, attempt.workspace);
        if (receipt.requestDigest !== requestDigest || receipt.caseId !== input.caseId || receipt.role !== role ||
            receipt.inputDigest !== roleInputDigest || attempt.inputDigest !== roleInputDigest ||
            attempt.caseId !== input.caseId || attempt.role !== role || attempt.status !== 'completed' ||
            !attempt.threadId || !attempt.turnId || !['completed', 'submitted'].includes(attempt.sessionStatus ?? ''))
          throw new Error('formalization_review_receipt_changed');
        checkAttemptEvidence(attempt);
        checkWorkspace(workspace);
        const outputText = frozenText(path.join(workspace, 'OUTPUT.json')), output = validate(JSON.parse(outputText));
        if (receipt.outputDigest !== digest(output) || receipt.outputFileSha256 !== mathDigest(outputText))
          throw new Error('formalization_review_receipt_changed');
        if (production) assertFormalizationReviewIsolation(attempt.isolationReceipt, environment.environment, inputText, instructions, schemaText);
        const previous = state.attempts.find(item => item.id === attempt.id);
        if (state.attempts.some(item => item.id !== attempt.id && item.threadId === attempt.threadId))
          throw new Error('formalization_review_thread_reused');
        if (previous) Object.assign(previous, attempt); else state.attempts.push(attempt);
        return output;
      }
      if (recovering.has(input.caseId)) throw new Error('formalization_review_receipt_missing');
      signal.throwIfAborted();
      const id = crypto.randomUUID(), relative = 'roles/' + id, workspace = path.join(runDirectory, relative);
      fs.mkdirSync(workspace, { mode: 0o700 });
      writeMathFrozen(path.join(workspace, 'INPUT.json'), inputText);
      writeMathFrozen(path.join(workspace, 'ROLE.md'), instructions);
      writeMathFrozen(path.join(workspace, 'OUTPUT.schema.json'), schemaText);
      const outputFile = path.join(workspace, 'OUTPUT.json');
      const attempt: Attempt = { id, caseId: input.caseId, role, workspace: relative, inputDigest: roleInputDigest,
        status: 'opening', usage: {}, usageIncomplete: false, turns: [], outputFeedback: [] };
      state.attempts.push(attempt); save();
      let currentTurn: z.infer<typeof turnSchema> | undefined;
      const recordFeedback = (cause: unknown, outputText: string | null, turnId: string,
        trigger: 'active-turn-validation' | 'completed-turn-validation') => {
        signal.throwIfAborted(); assertCurrent(); checkWorkspace(workspace);
        const message = outputValidationFeedback(cause, role);
        const relative = 'output-feedback/' + id + '/' + crypto.randomUUID() + '.json';
        fs.mkdirSync(path.dirname(path.join(runDirectory, relative)), { recursive: true, mode: 0o700 });
        const contents = canonicalMathJson({ schema: 'theorem-os.formalization-output-feedback.v1',
          attemptId: id, caseId: input.caseId, role, inputDigest: roleInputDigest, turnId, trigger,
          error: errorText(cause), message, outputText, outputSha256: outputText === null ? null : mathDigest(outputText) });
        writeMathFrozen(path.join(runDirectory, relative), contents);
        attempt.outputFeedback!.push({ file: relative, sha256: mathDigest(contents) }); save();
        return message;
      };
      let session: MathAgentSession | undefined, closing: Promise<void> | undefined;
      const close = () => session ? closing ??= session.close() : Promise.resolve();
      const interrupt = () => { void session?.interrupt().catch(() => {}); void close().catch(() => {}); };
      signal.addEventListener('abort', interrupt, { once: true });
      try {
        const sessionOptions: MathAgentOptions = {
          executable: config.execution === 'model' ? config.executable : 'offline-replay',
          profile: config.execution === 'model' ? config.profile : workspace,
          model: config.execution === 'model' ? config.model : 'offline-replay',
          effort: config.execution === 'model' ? config.effort : 'offline-replay', workspace, instructions, signal,
          environment: env, readIsolation: { environment: environment.environment },
          completedOutput: { file: outputFile, validate,
            ...(config.execution === 'model' ? { validationFeedback: (cause: unknown, output: { text: string; turnId: string }) =>
              recordFeedback(cause, output.text, output.turnId, 'active-turn-validation') } : {}) },
          onUsage: usage => { attempt.usage = usage; if (currentTurn) currentTurn.usage = usage; save(); },
          onUsageIncomplete: () => {
            attempt.usageIncomplete = true; if (currentTurn) currentTurn.usageIncomplete = true; save();
          } };
        session = options.openSession ? await options.openSession(sessionOptions) : production ?
          await createCodexMathSession(sessionOptions) : {
            threadId: 'preset-' + id, run: async (_message, _id, _workspace, started) => {
              started('preset-turn-' + id);
              if (presetRoles.has(key)) writeMathFrozen(outputFile, canonicalMathJson(presetRoles.get(key)) + '\n');
              return 'completed';
            }, interrupt: async () => {}, close: async () => {} };
        if (production) assertFormalizationReviewIsolation(session.isolationReceipt, environment.environment, inputText, instructions, schemaText);
        if (!session.threadId || state.attempts.some(other => other !== attempt && other.threadId === session!.threadId))
          throw new Error('formalization_review_thread_reused');
        attempt.threadId = session.threadId;
        if (session.isolationReceipt) attempt.isolationReceipt = session.isolationReceipt;
        signal.throwIfAborted(); attempt.status = 'running'; save();
        let message = config.fidelityPolicy ?
          'Follow the complete role protocol in the developer instructions. Read INPUT.json and OUTPUT.schema.json, submit the exact role output atomically, then stop. ROLE.md is the same protocol and need not be reread.' :
          'Read INPUT.json, ROLE.md and OUTPUT.schema.json. Submit the exact role output atomically.';
        while (true) {
          signal.throwIfAborted(); assertCurrent(); checkWorkspace(workspace);
          currentTurn = { messageId: crypto.randomUUID(), messageSha256: mathDigest(message), usage: {}, usageIncomplete: false };
          attempt.turns!.push(currentTurn); delete attempt.sessionStatus; save();
          attempt.sessionStatus = await session.run(message, currentTurn.messageId, workspace, turnId => {
            attempt.turnId = turnId; currentTurn!.turnId = turnId; save();
          });
          currentTurn.sessionStatus = attempt.sessionStatus;
          const turnId = currentTurn.turnId;
          currentTurn = undefined; save(); signal.throwIfAborted();
          if (!['completed', 'submitted'].includes(attempt.sessionStatus) || !turnId)
            throw new Error('formalization_review_session_incomplete');
          assertCurrent(); checkWorkspace(workspace); assertMathCanonicalPath(outputFile);
          // A normal turn can finish before the watcher observes its final file.
          // Repair only that output contract, using the same independent role thread.
          // Replay data has no model to repair it; failed/interrupted turns remain failures.
          if (config.execution === 'model' && attempt.sessionStatus === 'completed') {
            let outputText: string;
            try { outputText = readMathText(outputFile, 2_000_000); }
            catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
              message = recordFeedback(new Error('OUTPUT.json is missing. Submit the role output file.'), null, turnId,
                'completed-turn-validation');
              continue;
            }
            try { validate(JSON.parse(outputText)); }
            catch (cause) {
              message = recordFeedback(cause, outputText, turnId, 'completed-turn-validation');
              continue;
            }
          }
          break;
        }
        await close(); assertCurrent(); checkWorkspace(workspace); assertMathCanonicalPath(outputFile);
        const outputText = readMathText(outputFile, 2_000_000), output = validate(JSON.parse(outputText));
        checkAttemptEvidence(attempt);
        fs.chmodSync(outputFile, 0o400); attempt.status = 'completed';
        writeMathFrozen(receiptFile, canonicalMathJson(roleReceiptSchema.parse({
          schema: 'theorem-os.formalization-review-role-receipt.v2', requestDigest, caseId: input.caseId, role,
          inputDigest: roleInputDigest, outputDigest: digest(output), outputFileSha256: mathDigest(outputText), attempt })));
        save(); return output;
      } catch (cause) {
        await close(); assertCurrent(); checkWorkspace(workspace);
        attempt.status = signal.aborted ? 'interrupted' : 'failed'; attempt.error = errorText(cause); save(); throw cause;
      } finally { signal.removeEventListener('abort', interrupt); await close(); }
    };
    const loadObservation = async (input: FormalizationEvaluationReviewerInput) => {
      const file = path.join(runDirectory, 'observations', input.caseId + '.json');
      let value: unknown;
      if (fs.existsSync(file)) value = JSON.parse(frozenText(file));
      else {
        if (recovering.has(input.caseId)) throw new Error('formalization_review_receipt_missing');
        if (config.execution === 'replay' && !presetObservations.has(input.caseId))
          throw new Error('formalization_review_replay_observation_missing');
        value = config.execution === 'replay' ? presetObservations.get(input.caseId) :
          await (options.observeStatement ?? observeStatement)(path.join(runDirectory, 'elaboration', crypto.randomUUID()),
            input, environment, env, signal, config.contextProtocol);
        assertReviewStatementObservation(input, environment, value, config.contextProtocol);
        writeMathFrozen(file, canonicalMathJson(value));
      }
      const observation = assertReviewStatementObservation(input, environment, value, config.contextProtocol);
      observations.set(input.caseId, observation); return { observation, sha256: mathDigest(frozenText(file)) };
    };
    // Restore final receipts only after validating every stage that led to the decision.
    state.status = 'running'; save();
    const visits = [...inputs.filter(input => recovering.has(input.caseId)), ...inputs.filter(input => !recovering.has(input.caseId))];
    for (const input of visits) {
      if (signal.aborted) { state.status = 'stopped'; break; }
      options.onEvent?.({ event: 'started', caseId: input.caseId });
      try {
        assertCurrent();
        const { observation, sha256: observationSha256 } = await loadObservation(input);
        const roles: Record<string, string> = {};
        let activeFidelityChecks: Record<string, string> = {};
        let verdict: Receipt['verdict'] = 'unknown', resolution: Receipt['resolution'] = 'observation-unavailable', reasons: string[] = [];
        let reviewAgreement: Receipt['reviewAgreement'] = null;
        const roleHash = (role: Role) => mathDigest(frozenText(path.join(runDirectory, 'role-receipts', input.caseId + '-' + role + '.json')));
        if (observation.status === 'elaborated') {
          const fidelityChecks: Record<string, string> = {};
          const checkFidelity = async (role: 'primary' | 'recheck', roleInput: import('../math/formalizationSemanticReview').StructuredReviewInput,
            review: StructuredSemanticReview) => {
            const directory = path.join(runDirectory, 'fidelity', input.caseId, role);
            const check = await checkFormalizationFidelity(directory, roleInput, review, {
              env, signal, timeoutMs: 0, restoreOnly: recovering.has(input.caseId), compareReference: options.compareReference });
            if (check) fidelityChecks[role] = mathDigest(frozenText(path.join(directory, 'comparison.json'), 16_000_000));
            return !check || check.status === 'established';
          };
          const primaryInput = structuredReviewInput(input, observation, null, config.fidelityPolicy);
          const primary: StructuredSemanticReview = await stage(input, 'primary', primaryInput, structuredReviewOutputSchema(primaryInput),
            value => assertStructuredSemanticReview(primaryInput, value));
          roles.primary = roleHash('primary'); reasons = structuredReviewRecheckReasons(primaryInput, primary);
          let fidelityEstablished = await checkFidelity('primary', primaryInput, primary);
          if (!fidelityEstablished) reasons.push('fidelity-correspondence-not-established');
          verdict = primary.verdict; resolution = 'primary';
          if (reasons.length) {
            // The backtranslator gets only the actual Lean snapshot, no original or primary review.
            const translationInput = { ...observation.snapshot!, snapshotDigest: observation.snapshotDigest };
            const translationSchema = deriveFormalizationRoleOutputJsonSchema(formalizationTranslationSchema);
            translationSchema.properties!.snapshotDigest = { const: observation.snapshotDigest! };
            const translation: FormalizationTranslation = await stage(input, 'backtranslate', translationInput, translationSchema,
              value => assertReviewBacktranslation(observation, value));
            roles.backtranslate = roleHash('backtranslate');
            const recheckInput = structuredReviewInput(input, observation, translation, config.fidelityPolicy);
            const recheck = await stage(input, 'recheck', recheckInput, structuredReviewOutputSchema(recheckInput),
              value => assertStructuredSemanticReview(recheckInput, value));
            roles.recheck = roleHash('recheck');
            const recheckFidelity = await checkFidelity('recheck', recheckInput, recheck);
            fidelityEstablished = fidelityEstablished && recheckFidelity;
            const agreement = resolveStructuredReviews(primary, recheck);
            verdict = agreement.verdict; resolution = agreement.resolution;
            reviewAgreement = { aspectDisagreements: agreement.aspectDisagreements, sharedMismatches: agreement.sharedMismatches };
          }
          if (!fidelityEstablished && verdict === 'approved') { verdict = 'unknown'; resolution = 'fidelity-not-established'; }
          if (config.fidelityPolicy) activeFidelityChecks = fidelityChecks;
        } else reasons = ['statement-observation-unavailable'];
        const receipt = receiptSchema.parse({ schema: 'theorem-os.formalization-review-receipt.v2', requestDigest,
          caseId: input.caseId, inputDigest: formalizationEvaluationInputDigest(input), observationSha256, roles,
          verdict, reasons, resolution, reviewAgreement,
          ...(config.fidelityPolicy ? { fidelityChecks: activeFidelityChecks } : {}) });
        const receiptFile = path.join(runDirectory, 'receipts', input.caseId + '.json'), receiptText = canonicalMathJson(receipt);
        if (fs.existsSync(receiptFile)) {
          if (frozenText(receiptFile) !== receiptText || state.receipts[input.caseId] && state.receipts[input.caseId] !== mathDigest(receiptText))
            throw new Error('formalization_review_receipt_changed');
        } else {
          if (state.receipts[input.caseId]) throw new Error('formalization_review_receipt_missing');
          writeMathFrozen(receiptFile, receiptText);
        }
        state.receipts[input.caseId] = mathDigest(receiptText); completed.set(input.caseId, receipt);
        recovering.delete(input.caseId); delete state.caseErrors[input.caseId]; save();
        options.onEvent?.({ event: 'completed', caseId: input.caseId });
      } catch (cause) {
        options.onEvent?.({ event: 'failed', caseId: input.caseId });
        state.caseErrors[input.caseId] = errorText(cause); save();
        if (recovering.has(input.caseId)) throw cause;
        if (signal.aborted) { state.status = 'stopped'; break; }
        if (/formalization_review_(?:request_changed|protocol_changed|thread_reused|isolation_invalid|evidence_not_frozen|receipt_changed|receipt_missing|observation_invalid|observation_identity_mismatch)/u.test(errorText(cause))) throw cause;
      }
    }
    assertCurrent();
    state.status = completed.size === inputs.length ? 'complete' : state.status === 'stopped' ? 'stopped' : 'partial'; save();
    return { schema: 'theorem-os.formalization-review-run-result.v2', protocol: STRUCTURED_REVIEW_PROTOCOL,
      status: state.status, directory: runDirectory, bundleDigest: prepared.bundleDigest, requestDigest,
      execution: config.execution, adapter, modelInvoked: production && state.attempts.some(attempt => Boolean(attempt.turnId)),
      interpretation: production ? 'structured-semantic-review-against-supplied-labels' : 'preset-session-integration-not-model-accuracy',
      environment, totalCases: inputs.length, completedCases: completed.size, failedOrPendingCases: inputs.length - completed.size,
      unknownCases: inputs.filter(input => !completed.has(input.caseId) || completed.get(input.caseId)!.verdict === 'unknown').length,
      attempts: state.attempts.length, decisionsFile, compilationObserved: false,
      caseErrors: state.caseErrors,
      statementObservations: { elaborated: [...observations.values()].filter(item => item.status === 'elaborated').length,
        unavailable: [...observations.values()].filter(item => item.status === 'unavailable').length,
        authority: production ? 'host-erased-statement-lean' : 'preset' },
      recheckedCases: [...completed.values()].filter(item => item.roles.recheck).length,
      disagreementCases: [...completed.values()].filter(item => item.resolution === 'review-disagreement').length,
      aspectDisagreementCases: [...completed.values()].filter(item => item.reviewAgreement?.aspectDisagreements.length).length,
      timeoutMs: 0 };
  });
}
