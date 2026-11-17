import { assertWorkflowSessionSupported, openWorkflowSession, workflowProfileFiles } from './workflowSession';
import { usesNativeWorkflowOutput } from './workflowOutput';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assertFormalizationEvidence, directFormalizationEvidenceSchema, formalizationDigest, type DirectFormalizationEvidence } from '../math/formalization';
import { assertFormalizationAuditResult, assertFormalizationAuditReview, formalizationAuditBindings, formalizationAuditInput,
  formalizationAuditInstructions, formalizationAuditOutputSchema, formalizationAuditResultSchema, type FormalizationAuditResult } from '../math/formalizationAudit';
import { formalizationModelConfigurationDigest, formalizationModelConfigurationSchema } from '../math/formalizationWorkflow';
import { readMathBuildManifest } from '../math/mathBuildManifest';
import { canonicalMathJson, mathDigest, readMathText, writeMathFrozen, writeMathJsonDurable } from '../math/mathRuntimeIo';
import { resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { scheduleMathTimeout } from '../math/mathTimers';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { acquireMathModelSlot, configuredMathModelSlots, type MathModelSlot } from '../math/mathModelSlot';
import type { MathAgentOptions, MathAgentSession } from '../runtime/agentSession';
import { assertFormalizationReviewIsolation } from './formalizationReviewIsolation';
import { shareFormalizationContext } from './formalizationContext';
import { allowanceReached, beginRequestUsage, buildTokenBudget, initializeRequestUsageAccounting,
  modelDispatchAllowed, recordThreadUsage, reportedTotalTokens, type RequestUsageAccounting, type UsageAccounting } from './usageBudget';

export type FormalizationAuditConfiguration = { profile: string; executable: string; model: string; effort: string; buildManifestRef: string;
  agentHarness?: import('../math/formalizationWorkflow').FormalizationModelConfiguration['agentHarness'] };
export type FormalizationAuditOptions = { env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  openSession?: (options: MathAgentOptions) => Promise<MathAgentSession>;
  maxRunSeconds?: number; maxTotalTokens?: number; onUsage?: (tokens: number) => void };
type SessionRecord = { threadId?: string; turnId?: string; status: string; completionReason?: 'validated-output';
  inputDigest: string; outputDigest?: string; turns: number; usage: Record<string, unknown>;
  usageAccounting: UsageAccounting; requestUsageAccounting?: RequestUsageAccounting };

export const FORMALIZATION_AUDIT_READING_PROTOCOL = [
  'The turn may provide theorem-os.formalization-audit-reading-view.v2. Its input preserves the complete original and source, every target type, bindings, references and omitted list. Read all source definitions and targets. elaboratedType gives the explicit Lean type; localDeclarations lists every reached local declaration and its actual type, including generated declarations not written explicitly in the source.',
  'Expanded local values, kernel trees and imported-library records remain in the complete read-only INPUT.json at their exact inputPath or kernelInputPath. Short local values are inline; larger values give their byte count and path. These observations are deferred, not empty or already checked. Read the exact resolved record when an implicit instance, coercion, local alias or unfamiliar library meaning could affect a check; use the pinned library if an essential record was not exported. Use unknown if a necessary meaning remains unresolved. Do not dump or reread the whole file, expand ordinary implementation plumbing or repeat settled source facts.',
  'The view may be wrapped in theorem-os.formalization-shared-context.v1: an object with only "$ref":i means dictionary[i], recursively; dictionary entries reference only earlier entries. All other JSON is literal. The host checked lossless expansion. Interpret shared observations directly instead of printing their expanded duplicates.',
  'The outer canonicalInputSha256 identifies the reading view; the view.frozenInputSha256 identifies the complete INPUT.json. Neither is a new semantic verdict. The original frozen input and output validators remain authoritative.',
].join('\n');

/** Read the actual source/types first; exact expanded meanings remain addressable in the frozen input. */
export function formalizationAuditReadingView(inputText: string): string | undefined {
  if (Buffer.byteLength(inputText) <= 128 * 1024) return;
  const input = JSON.parse(inputText) as ReturnType<typeof formalizationAuditInput>;
  const snapshot = { ...input.snapshot, targets: input.snapshot.targets.map((target, index) => {
    const { constants, structures, semantic, ...complete } = target.context;
    const base = `$.snapshot.targets[${index}].context`;
    return { ...target, context: { ...complete, ...(semantic ? {
      elaboratedType: semantic.rawType, kernelInputPath: base + '.semantic.kernelType',
      localDeclarations: semantic.localMeaningClosure.map((entry, localIndex) => {
        const inputPath = `${base}.semantic.localMeaningClosure[${localIndex}]`;
        return { name: entry.name, kind: entry.kind, type: entry.rawType, kernelInputPath: inputPath,
          ...(entry.rawValue === undefined ? {} : { value: Buffer.byteLength(entry.rawValue) <= 4096 ? entry.rawValue
            : { inputPath: inputPath + '.rawValue', bytes: Buffer.byteLength(entry.rawValue) } }) };
      }),
    } : {}), importedLibrary: {
      constants: { inputPath: base + '.constants', count: constants.length },
      ...(structures ? { structures: { schema: structures.schema,
        inputPath: base + '.structures.entries', count: structures.entries.length } } : {}),
    } } };
  }) };
  const view = canonicalMathJson({ schema: 'theorem-os.formalization-audit-reading-view.v2',
    frozenInputSha256: mathDigest(inputText), input: { ...input, snapshot } });
  return shareFormalizationContext(view) ?? view;
}

/** One independent audit; it never writes a candidate or blocks/changes compiler evidence. */
export async function runFormalizationAudit(directory: string, root: string, evidence: DirectFormalizationEvidence,
  configuration: FormalizationAuditConfiguration, options: FormalizationAuditOptions = {}): Promise<FormalizationAuditResult> {
  evidence = directFormalizationEvidenceSchema.parse(evidence);
  assertFormalizationEvidence(evidence);
  const config = formalizationModelConfigurationSchema.extend({ buildManifestRef: z.string().min(1) }).strict().parse(configuration) as FormalizationAuditConfiguration;
  const limit = z.number().int().safe().nonnegative();
  const maxRunSeconds = limit.parse(options.maxRunSeconds ?? 0), maxTotalTokens = limit.parse(options.maxTotalTokens ?? 0);
  directory = path.resolve(directory); root = path.resolve(root); assertMathCanonicalPath(directory);
  if (isMathPathWithin(root, directory) || isMathPathWithin(directory, root)) throw new Error('formalization_audit_directory_must_be_external');
  // The audit's own worker build is current; the generation manifest may belong to a different container.
  readMathBuildManifest(config.buildManifestRef, root, path.join(root, 'out/main'));
  const buildDigest = mathDigest(readMathText(config.buildManifestRef, 8_000_000));
  assertWorkflowSessionSupported(config, { environment: evidence.request.environment });
  workflowProfileFiles(config, () => null, options.env ?? process.env);
  const configurationDigest = formalizationModelConfigurationDigest(config), bindings = formalizationAuditBindings(evidence);
  const resultFile = path.join(directory, 'result.json'), stateFile = path.join(directory, 'state.json');
  if (fs.existsSync(resultFile)) {
    const result = formalizationAuditResultSchema.parse(JSON.parse(readMathText(resultFile, 4_000_000)));
    assertFormalizationAuditResult(evidence, result);
    const previous = JSON.parse(readMathText(stateFile, 8_000_000));
    if (previous.status !== 'completed' || previous.configurationDigest !== configurationDigest || previous.buildDigest !== buildDigest ||
        previous.resultSha256 !== formalizationDigest(result) || result.model !== config.model || result.effort !== config.effort)
      throw new Error('formalization_audit_checkpoint_changed');
    return result;
  }
  if (fs.existsSync(directory) && fs.readdirSync(directory).length) throw new Error('formalization_audit_directory_in_use');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const workspace = path.join(directory, 'session'); fs.mkdirSync(workspace, { mode: 0o700 });
  const input = formalizationAuditInput(evidence, config), inputText = canonicalMathJson(input);
  const schemaText = canonicalMathJson(formalizationAuditOutputSchema);
  const view = formalizationAuditReadingView(inputText);
  const inlineView = view && Buffer.byteLength(view) + Buffer.byteLength(schemaText) +
    Buffer.byteLength(FORMALIZATION_AUDIT_READING_PROTOCOL) <= 128 * 1024 ? view : undefined;
  const cliHandoff = config.agentHarness?.id === 'cli' || (config.agentHarness?.id ?? 'codex') === 'codex' &&
    !usesNativeWorkflowOutput(config, 'model', 'native-schema');
  const handoffFile = path.join(workspace, 'AUDIT-REVIEW.json');
  const handoffRolePath = '/workspace/AUDIT-REVIEW.json';
  const submissionInstructions = cliHandoff ? formalizationAuditInstructions.split('\n').map(line =>
    line.startsWith('Return only the review JSON in your final response matching the native output schema:')
      ? line.replace('Return only the review JSON in your final response matching the native output schema:',
        'Write only the review JSON to ' + handoffRolePath + ' matching OUTPUT.schema.json:')
      : line.startsWith('Return the final JSON directly and stop;')
        ? 'Write the completed review to ' + handoffRolePath + ' and stop. Do not write OUTPUT.json; the host owns it. The host closes this session, checks the frozen inputs and then validates this handoff before binding the review. This review does not change the frozen statement or establish a proof.'
        : line).join('\n') : formalizationAuditInstructions;
  const instructions = submissionInstructions + (inlineView ? '\n' + FORMALIZATION_AUDIT_READING_PROTOCOL : '');
  const frozen = { 'INPUT.json': inputText, 'ROLE.md': instructions, 'OUTPUT.schema.json': schemaText };
  for (const [file, text] of Object.entries(frozen)) writeMathFrozen(path.join(workspace, file), text);
  const outputFile = path.join(workspace, 'OUTPUT.json');
  const record: SessionRecord = { status: 'opening', inputDigest: formalizationDigest(input), turns: 0, usage: {},
    usageAccounting: { startedTurns: 0, reportedTurns: 0, pending: false, incomplete: false } };
  const state = { schema: 'theorem-os.formalization-audit-state.v1', status: 'running', ...bindings,
    configurationDigest, buildDigest, model: config.model, effort: config.effort, startedAt: new Date().toISOString(),
    finishedAt: undefined as string | undefined, resultSha256: undefined as string | undefined, error: undefined as string | undefined,
    session: record, isolationReceipt: undefined as Record<string, unknown> | undefined,
    tokenBudget: buildTokenBudget(maxTotalTokens, [record]) };
  const save = () => { state.tokenBudget = buildTokenBudget(maxTotalTokens, [record]); writeMathJsonDurable(stateFile, state); };
  save();
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('formalization_audit_cancelled'));
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const cancelTimer = maxRunSeconds ? scheduleMathTimeout(() => controller.abort(new Error('formalization_audit_time_limit')), maxRunSeconds * 1000) : undefined;
  let session: MathAgentSession | undefined, modelSlot: MathModelSlot | undefined, closing: Promise<void> | undefined;
  let incomplete = false, receivedUsage = false;
  const closeWriter = () => session ? closing ??= session.close() : Promise.resolve();
  const interrupt = () => { void session?.interrupt().catch(() => {}); void closeWriter().catch(() => {}); };
  controller.signal.addEventListener('abort', interrupt, { once: true });
  const observeUsage = () => {
    save();
    const tokens = reportedTotalTokens(record.usage);
    if (tokens !== null) options.onUsage?.(tokens);
    if (allowanceReached(maxTotalTokens, [record])) controller.abort(new Error('formalization_audit_token_limit'));
  };
  try {
    controller.signal.throwIfAborted();
    const slots = options.openSession ? undefined : configuredMathModelSlots();
    if (slots) modelSlot = await acquireMathModelSlot(slots, { signal: controller.signal });
    session = await openWorkflowSession(config, { ...config, workspace,
      instructions, environment: resolveMathematicsRuntimeEnvironment(options.env ?? process.env),
      signal: controller.signal, turnTimeoutMs: maxRunSeconds ? Math.max(1, maxRunSeconds * 1000 - (Date.now() - Date.parse(state.startedAt))) : undefined,
      readIsolation: { environment: evidence.request.environment, packages: 'sources',
        ...(evidence.request.library ? { library: { file: evidence.request.library.file, digest: evidence.request.library.digest } } : {}) },
      ...(cliHandoff ? { completedOutput: { file: handoffFile,
        validate: (value: unknown) => { assertFormalizationAuditReview(evidence, value); } } }
        : { outputSchema: formalizationAuditOutputSchema }),
      onUsage: usage => {
        if (record.requestUsageAccounting) return;
        receivedUsage = recordThreadUsage(record, usage); observeUsage();
      }, onUsageIncomplete: () => {
        incomplete = true;
        if (record.requestUsageAccounting) record.requestUsageAccounting.incomplete = true;
        record.usageAccounting.incomplete = true; save();
      }, requestGate: identity => {
        if (controller.signal.aborted) return { allowed: false, reason: 'math_model_request_stopped' };
        const budget = buildTokenBudget(maxTotalTokens, [record]);
        if (!modelDispatchAllowed(budget)) return { allowed: false, reason: budget.reason! };
        initializeRequestUsageAccounting(record);
        const settle = beginRequestUsage(record, identity); save();
        return { allowed: true, settle: receipt => { settle(receipt); observeUsage(); } };
      },
    }, options.openSession);
    controller.signal.throwIfAborted();
    record.threadId = session.threadId;
    if (evidence.sessions.some(author => author.threadId === record.threadId)) throw new Error('formalization_audit_generation_thread_reused');
    state.isolationReceipt = session.isolationReceipt;
    if (!options.openSession || evidence.execution === 'model' || session.isolationReceipt)
      assertFormalizationReviewIsolation(session.isolationReceipt, evidence.request.environment, inputText, instructions, schemaText, 'sources',
        evidence.request.library ? { digest: evidence.request.library.digest } : undefined);
    if (session.usageSource === 'upstream-requests') initializeRequestUsageAccounting(record);
    record.usageAccounting.startedTurns = 1; record.usageAccounting.pending = true; record.status = 'running'; save();
    const submission = cliHandoff ? 'Write only the final review JSON to ' + handoffRolePath + ' matching OUTPUT.schema.json.'
      : 'Return only the final review JSON matching the native output schema.';
    const message = inlineView
      ? 'Perform the independent audit using the complete original, source and actual types in the reading view below and the developer protocol. Resolve shared references as observations; query only specific unresolved expanded meanings in INPUT.json. Once all six checks are settled, '
        + submission[0].toLowerCase() + submission.slice(1) + '\nBEGIN AUDIT READING VIEW\n'
        + inlineView + '\nEND AUDIT READING VIEW\nBEGIN OUTPUT.schema.json\n' + schemaText + '\nEND OUTPUT.schema.json'
      : Buffer.byteLength(inputText) + Buffer.byteLength(schemaText) <= 128 * 1024
      ? 'Perform the independent audit using the complete frozen input and schema below. Follow the developer protocol; do not reread these files. ' + submission + '\nBEGIN INPUT.json\n'
        + inputText + '\nEND INPUT.json\nBEGIN OUTPUT.schema.json\n' + schemaText + '\nEND OUTPUT.schema.json'
      : 'Perform the independent audit using INPUT.json and OUTPUT.schema.json. The complete protocol is in the developer instructions; ROLE.md is its frozen copy. ' + submission;
    const submissionMessage = cliHandoff
      ? message + '\nSubmit through ' + handoffRolePath + '. Do not write OUTPUT.json. The final stdout response is not the audit handoff.'
      : message;
    record.status = await session.run(submissionMessage, crypto.randomUUID(), workspace, turnId => { record.turnId = turnId; record.turns = 1; save(); });
    // The writer must be closed even for normal completion before any output is read and accepted.
    await closeWriter(); controller.signal.throwIfAborted();
    record.usageAccounting.pending = false;
    const complete = record.requestUsageAccounting ? !record.requestUsageAccounting.incomplete && !record.requestUsageAccounting.pendingRequests
      : receivedUsage && !incomplete;
    record.usageAccounting.reportedTurns = complete ? 1 : 0;
    record.usageAccounting.incomplete = !complete;
    if (!['completed', 'submitted'].includes(record.status) || !record.turnId)
      throw new Error('formalization_audit_session_incomplete:' + record.status + (session.lastFailureDiagnostic ? ':' + session.lastFailureDiagnostic.code : ''));
    if (record.status === 'submitted') record.completionReason = 'validated-output';
    for (const [file, text] of Object.entries(frozen)) {
      const filename = path.join(workspace, file); assertMathCanonicalPath(filename);
      if (readMathText(filename) !== text) throw new Error('formalization_audit_contract_changed');
    }
    if (cliHandoff) assertMathCanonicalPath(handoffFile);
    const finalResponse = cliHandoff ? readMathText(handoffFile, 4_000_000)
      : session.lastCompletedResponse?.turnId === record.turnId ? session.lastCompletedResponse.text : undefined;
    if (finalResponse === undefined) throw new Error('formalization_audit_final_response_missing');
    const review = assertFormalizationAuditReview(evidence, JSON.parse(finalResponse));
    writeMathFrozen(outputFile, canonicalMathJson(review) + '\n');
    record.outputDigest = formalizationDigest(review);
    const budget = buildTokenBudget(maxTotalTokens, [record]);
    if (!modelDispatchAllowed(budget)) throw new Error(budget.reason!);
    state.finishedAt = new Date().toISOString();
    const result = formalizationAuditResultSchema.parse({ schema: 'theorem-os.formalization-audit.v1', ...bindings,
      model: config.model, effort: config.effort, review, startedAt: state.startedAt, finishedAt: state.finishedAt,
      session: { threadId: record.threadId, turnId: record.turnId, status: record.status,
        ...(record.completionReason ? { completionReason: record.completionReason } : {}),
        inputDigest: record.inputDigest, outputDigest: record.outputDigest, usage: record.usage } });
    assertFormalizationAuditResult(evidence, result);
    writeMathFrozen(resultFile, canonicalMathJson(result) + '\n');
    state.status = 'completed'; state.resultSha256 = formalizationDigest(result); save();
    return result;
  } catch (cause) {
    const error = controller.signal.aborted ? controller.signal.reason : cause;
    state.status = 'error'; state.error = (error instanceof Error ? error.message : String(error)).slice(0, 16_000);
    state.finishedAt = new Date().toISOString(); record.status = 'failed'; save();
    throw error;
  } finally {
    cancelTimer?.(); options.signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', interrupt);
    try { await closeWriter(); } finally { await modelSlot?.release(); record.usageAccounting.pending = false; save(); }
  }
}

export type { FormalizationAuditResult } from '../math/formalizationAudit';
