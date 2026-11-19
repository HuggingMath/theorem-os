import { assertWorkflowSessionSupported, openWorkflowSession, workflowProfileFiles } from './workflowSession';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import { parse as parseToml } from 'smol-toml';
import type { MathAgentFailureDiagnostic, MathAgentOptions, MathAgentSession } from '../runtime/agentSession';
import { readMathBuildManifest } from '../math/mathBuildManifest';
import { canonicalMathJson, mathDigest, readMathText, withMathRuntimeLease, writeMathJsonDurable } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin, repositoryRelativePath } from '../math/paths';
import { projectMathematicsRuntimeEnvironment, resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { scheduleMathTimeout } from '../math/mathTimers';
import { formalizationModelConfigurationDigest } from '../math/formalizationWorkflow';
import { allowanceReached, buildTokenBudget, initializeUsageAccounting, modelDispatchAllowed, reportedTotalTokens, type UsageAccounting } from './usageBudget';
import { acquireMathModelSlot, configuredMathModelSlots, type MathModelSlot } from '../math/mathModelSlot';
import { informalizationOutlineSchema, type InformalizationOutline } from '../math/informalizationExtraction';
import { informalizationAlignedAuditOutputSchema, informalizationAlignedWriterOutputSchema, informalizationAuditApproved,
  informalizationOutlinedAlignedAuditOutputSchema, informalizationOutlinedAlignedWriterOutputSchema,
  informalizationOutlinedAuditOutputSchema, informalizationOutlinedWriterOutputSchema,
  informalizationAuditFeedback, informalizationAuditInput, informalizationAuditOutputSchema, informalizationAuditRejections,
  informalizationBatches, informalizationDigest, informalizationEvidence, informalizationRejectionFeedback,
  informalizationRoleInstructions, informalizationRoleOutputSchema, informalizationWriterInput, informalizationWriterOutputSchema,
  informalizationWriterOutputSchemaFor, informalizationWriterSubmissionRejections,
  readInformalizationArtifact, readInformalizationRequest, writeInformalizationArtifact,
  type InformalizationAuditOutput, type InformalizationEvidence, type InformalizationRequest, type InformalizationRole,
  type InformalizationSection, type InformalizationWriterOutput } from '../math/informalization';
import { extractInformalizationOutline } from './informalizationExtraction';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const relative = z.string().refine(value => repositoryRelativePath(value) !== undefined);
const sessionSchema = z.object({
  role: z.enum(['write', 'audit']), batch: z.number().int().nonnegative(), round: z.number().int().positive(),
  attempt: z.number().int().positive(), auditorId: z.string().optional(), threadId: z.string().optional(), turnId: z.string().optional(),
  status: z.string(), inputDigest: hash, outputDigest: hash.optional(), model: z.string(), effort: z.string(),
  configurationDigest: hash, roleContract: z.object({ roleInstructionsSha256: hash, outputSchemaSha256: hash }).strict(),
  workspace: relative, failureDiagnostic: z.object({ code: z.string(), httpStatusCode: z.number().int().optional(),
    reason: z.string().optional() }).strict().optional(),
  turns: z.number().int().nonnegative(), usage: z.record(z.unknown()),
  usageAccounting: z.object({ startedTurns: z.number().int().nonnegative(), reportedTurns: z.number().int().nonnegative(),
    pending: z.boolean(), incomplete: z.boolean() }).strict(),
}).strict();
const writerOutput = z.union([informalizationOutlinedAlignedWriterOutputSchema, informalizationOutlinedWriterOutputSchema,
  informalizationAlignedWriterOutputSchema, informalizationWriterOutputSchema]);
const auditOutput = z.union([informalizationOutlinedAlignedAuditOutputSchema, informalizationOutlinedAuditOutputSchema,
  informalizationAlignedAuditOutputSchema, informalizationAuditOutputSchema]);
const stateSchema = z.object({
  schema: z.literal('theorem-os.informalization-state.v1'), requestDigest: hash, environmentDigest: hash, profileDigest: hash,
  status: z.enum(['running', 'approved', 'exhausted', 'stopped']),
  outline: z.object({ file: relative, digest: hash }).strict().optional(),
  batches: z.array(z.object({ index: z.number().int().nonnegative(), declarations: z.array(z.string()).min(1),
    status: z.enum(['pending', 'approved']), rounds: z.number().int().nonnegative(), open: z.boolean(),
    feedback: z.string().optional(), previous: writerOutput.optional(),
    accepted: z.object({ writer: writerOutput, writerInputDigest: hash,
      audits: z.array(z.object({ auditorId: z.string(), output: auditOutput }).strict()) }).strict().optional(),
  }).strict()),
  sessions: z.array(sessionSchema), elapsedMs: z.number().int().nonnegative(),
  activeSince: z.number().int().nonnegative().optional(), error: z.string().optional(),
}).strict();
type SessionRecord = Omit<z.infer<typeof sessionSchema>, 'turns' | 'usageAccounting'> & { turns: number; usageAccounting: UsageAccounting };
type State = Omit<z.infer<typeof stateSchema>, 'sessions'> & { sessions: SessionRecord[] };
type Options = {
  openSession?: (options: MathAgentOptions) => Promise<MathAgentSession>;
  extract?: typeof extractInformalizationOutline;
  env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  waitForRetry?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: { event: string } & EventDetail) => void;
};
type EventDetail = { batch?: number; round?: number; role?: InformalizationRole; error?: string;
  failureDiagnostic?: MathAgentFailureDiagnostic };
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const MAX_AUDIT_ATTEMPTS = 3;
const MAX_ROLE_TRANSPORT_ATTEMPTS = 3;
export const informalizationRetryLimit = 'informalization_role_retries_exhausted';
class InformalizationRoleFailure extends Error {
  constructor(status: string, readonly diagnostic?: MathAgentFailureDiagnostic) {
    super('informalization_role_incomplete:' + status + (diagnostic ? ':' + diagnostic.code +
      (diagnostic.reason ? ':' + diagnostic.reason : '') : ''));
  }
}
class OutputRejected extends Error {
  constructor(readonly problems: string[]) { super('informalization_output_rejected'); }
}
const retryableRoleFailure = (cause: unknown) => {
  if (!(cause instanceof InformalizationRoleFailure) || !cause.diagnostic) return false;
  const { code, httpStatusCode, reason } = cause.diagnostic;
  if (httpStatusCode !== undefined && httpStatusCode < 500 && httpStatusCode !== 408 && httpStatusCode !== 429) return false;
  return code === 'other' && Boolean(reason) || ['rateLimitExceeded', 'flexUnavailable', 'serverOverloaded', 'httpConnectionFailed',
    'responseStreamConnectionFailed', 'internalServerError', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(code);
};
const ROLE_PROMPT = 'Follow the complete role protocol in the developer instructions. Read OUTPUT.schema.json and INPUT.json, ' +
  'write OUTPUT.json atomically using that contract, then stop. ROLE.md is the same protocol and need not be reread.';

const summarizeRun = (directory: string, request: InformalizationRequest, state: State) => ({
  status: state.status as 'approved' | 'exhausted' | 'stopped', directory,
  batches: state.batches.length, approvedBatches: state.batches.filter(batch => batch.status === 'approved').length,
  rounds: state.batches.reduce((sum, batch) => sum + batch.rounds, 0),
  modelInvoked: state.sessions.some(item => item.turns > 0),
  tokenBudget: buildTokenBudget(request.maxTotalTokens, state.sessions),
  ...(state.status === 'approved' ? { artifact: path.join(directory, 'artifact'), proof: path.join(directory, 'artifact', 'proof.md') } : {}),
  ...(state.error ? { error: state.error } : {}),
});

export function readInformalizationState(directory: string): State | undefined {
  const file = path.join(directory, 'state.json'); assertMathCanonicalPath(file);
  return fs.existsSync(file) ? stateSchema.parse(JSON.parse(readMathText(file, 64_000_000))) as State : undefined;
}

const profileFiles = (profile: string) => {
  const files = ['config.toml', 'models.json'].map(name => {
    const file = path.join(profile, name);
    return { name, digest: fs.existsSync(file) ? mathDigest(readMathText(file, 2_000_000)) : null };
  });
  const configFile = path.join(profile, 'config.toml');
  const config = fs.existsSync(configFile) ? parseToml(readMathText(configFile, 2_000_000)) : {};
  if (typeof config.model_catalog_json === 'string') {
    if (!path.isAbsolute(config.model_catalog_json)) throw new Error('informalization_model_catalog_must_be_absolute');
    const file = path.resolve(config.model_catalog_json); assertMathCanonicalPath(file);
    files.push({ name: 'model_catalog_json:' + file, digest: fs.existsSync(file) ? mathDigest(readMathText(file, 2_000_000)) : null });
  }
  return files;
};
/** Each role gets a fresh thread and only its own input. Nothing is published before every batch is approved. */
export async function runInformalization(directory: string, root: string, options: Options = {}) {
  directory = path.resolve(directory); root = path.resolve(root);
  assertMathCanonicalPath(directory);
  if (isMathPathWithin(root, directory) || isMathPathWithin(directory, root)) throw new Error('informalization_directory_must_be_external');
  const { request, sources } = readInformalizationRequest(directory), requestDigest = informalizationDigest(request);
  readMathBuildManifest(request.buildManifestRef, root, path.join(root, 'out/main'));
  if (mathDigest(readMathText(request.buildManifestRef, 8_000_000)) !== request.buildDigest) throw new Error('informalization_build_changed');
  const env = resolveMathematicsRuntimeEnvironment(options.env ?? process.env);
  const environmentDigest = informalizationDigest(projectMathematicsRuntimeEnvironment(env));
  const configurations = [request.writer, ...request.auditors];
  for (const config of configurations) assertWorkflowSessionSupported(config, { environment: request.environment });
  const currentProfileDigest = () => informalizationDigest(configurations.map(config => ({
    configurationDigest: formalizationModelConfigurationDigest(config),
    files: workflowProfileFiles(config, () => profileFiles(config.profile), options.env ?? process.env) })));
  const profileDigest = currentProfileDigest();
  const controller = new AbortController(), externalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  process.once('SIGINT', externalAbort); process.once('SIGTERM', externalAbort);
  try {
    return await withMathRuntimeLease({ lockPath: path.join(directory, 'run.lock'), flockExecutable: '/usr/bin/flock', signal: controller.signal }, async lease => {
      const state: State = readInformalizationState(directory) ?? { schema: 'theorem-os.informalization-state.v1' as const,
        requestDigest, environmentDigest, profileDigest, status: 'running' as const, batches: [], sessions: [], elapsedMs: 0 };
      if (state.requestDigest !== requestDigest || state.environmentDigest !== environmentDigest || state.profileDigest !== profileDigest)
        throw new Error('informalization_resume_identity_changed');
      if (state.status === 'approved') {
        readInformalizationArtifact(path.join(directory, 'artifact'));
        return summarizeRun(directory, request, state);
      }
      if (state.activeSince !== undefined) state.elapsedMs += Math.max(0, Date.now() - state.activeSince);
      delete state.activeSince; state.status = 'running';
      for (const session of state.sessions) initializeUsageAccounting(session);
      const startedAt = Date.now(), elapsedBefore = state.elapsedMs;
      const remaining = () => request.maxRunSeconds === 0 ? Infinity : request.maxRunSeconds * 1000 - elapsedBefore - (Date.now() - startedAt);
      const cancelTimer = request.maxRunSeconds === 0 ? undefined : scheduleMathTimeout(() => controller.abort(), Math.max(1, remaining()));
      const stageTimeout = (seconds: number) => Math.min(seconds === 0 ? Infinity : seconds * 1000, Math.max(1, remaining()));
      const save = (active = true) => {
        state.elapsedMs = elapsedBefore + Date.now() - startedAt;
        if (active) state.activeSince = Date.now(); else delete state.activeSince;
        writeMathJsonDurable(path.join(directory, 'state.json'), state);
      };
      const event = (name: string, detail: EventDetail = {}) =>
        options.onEvent?.({ event: name, ...detail });
      type Slot = { role: InformalizationRole; batch: number; round: number; attempt: number; auditorId?: string };
      // Roles in flight; reported usage reaching the allowance stops all of them, not only the next dispatch.
      const running = new Set<() => void>();
      const spent = () => allowanceReached(request.maxTotalTokens, state.sessions);
      const dispatchOnce = async (slot: Slot, input: { inputDigest: string }, check: (value: unknown) => string[],
        signal: AbortSignal): Promise<unknown> => {
        signal.throwIfAborted();
        if (remaining() <= 0) throw new Error('informalization_time_limit');
        if (currentProfileDigest() !== profileDigest) throw new Error('informalization_profile_changed_during_run');
        const config = slot.role === 'write' ? request.writer : request.auditors.find(item => item.id === slot.auditorId)!;
        const inputText = canonicalMathJson(input);
        if (Buffer.byteLength(inputText) > 8_000_000) throw new Error('informalization_role_input_too_large');
        const instructionsText = informalizationRoleInstructions(slot.role, request.alignment, request.explanationPolicy, request.outlinePolicy);
        const schemaText = canonicalMathJson(informalizationRoleOutputSchema(slot.role, request.alignment, request.outlinePolicy));
        const roleContract = { roleInstructionsSha256: mathDigest(instructionsText), outputSchemaSha256: mathDigest(schemaText) };
        const configurationDigest = formalizationModelConfigurationDigest(config);
        // Only closed sessions whose output was read can be reused; bind the actual input and protocol bytes.
        const cached = state.sessions.findLast(item => item.role === slot.role && item.batch === slot.batch && item.round === slot.round &&
          item.attempt === slot.attempt && item.auditorId === slot.auditorId && item.inputDigest === input.inputDigest &&
          item.outputDigest && item.turnId && ['completed', 'submitted'].includes(item.status));
        if (cached) {
          try {
            const workspace = path.resolve(directory, cached.workspace);
            if (!isMathPathWithin(directory, workspace) || cached.configurationDigest !== configurationDigest ||
                canonicalMathJson(cached.roleContract) !== canonicalMathJson(roleContract) ||
                readMathText(path.join(workspace, 'INPUT.json'), 8_000_000) !== inputText ||
                readMathText(path.join(workspace, 'ROLE.md'), 1_000_000) !== instructionsText ||
                readMathText(path.join(workspace, 'OUTPUT.schema.json'), 1_000_000) !== schemaText) throw new Error('identity');
            const output = JSON.parse(readMathText(path.join(workspace, 'OUTPUT.json'), 4_000_000)) as unknown;
            if (informalizationDigest(output) !== cached.outputDigest) throw new Error('output');
            event('informalization_role_restored', slot);
            return output;
          } catch { throw new Error('informalization_checkpoint_changed:' + slot.role); }
        }
        const budget = buildTokenBudget(request.maxTotalTokens, state.sessions);
        if (!modelDispatchAllowed(budget)) throw new Error(budget.reason ?? 'informalization_token_limit');
        const name = slot.role === 'write' ? 'write' : `audit-${slot.auditorId}-${slot.attempt}`;
        const roundDirectory = path.join(directory, 'batches', String(slot.batch), 'round-' + slot.round);
        const baseWorkspace = path.join(roundDirectory, name);
        const baseUsed = fs.existsSync(baseWorkspace) || state.sessions.some(item => item.workspace === path.relative(directory, baseWorkspace));
        const workspace = baseUsed ? path.join(roundDirectory, 'retry-' + crypto.randomUUID(), name) : baseWorkspace;
        assertMathCanonicalPath(workspace);
        fs.mkdirSync(workspace, { mode: 0o700, recursive: true });
        const inputFile = path.join(workspace, 'INPUT.json'), outputFile = path.join(workspace, 'OUTPUT.json');
        const instructionsFile = path.join(workspace, 'ROLE.md'), schemaFile = path.join(workspace, 'OUTPUT.schema.json');
        fs.writeFileSync(inputFile, inputText, { mode: 0o400, flag: 'wx' });
        fs.writeFileSync(instructionsFile, instructionsText, { mode: 0o400, flag: 'wx' });
        fs.writeFileSync(schemaFile, schemaText, { mode: 0o400, flag: 'wx' });
        // The proof the role explains, for reading and scratch compilation.
        for (const source of sources) {
          const file = path.join(workspace, 'proof', source.file);
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          fs.writeFileSync(file, source.text, { mode: 0o400, flag: 'wx' });
        }
        const record: SessionRecord = { role: slot.role, batch: slot.batch, round: slot.round, attempt: slot.attempt,
          ...(slot.auditorId ? { auditorId: slot.auditorId } : {}), status: 'opening', inputDigest: input.inputDigest,
          model: config.model, effort: config.effort, configurationDigest, roleContract, workspace: path.relative(directory, workspace),
          turns: 0, usage: {}, usageAccounting: { startedTurns: 0, reportedTurns: 0, pending: false, incomplete: false } };
        state.sessions.push(record); save(); event('informalization_role_started', slot);
        const turnTimeout = stageTimeout(request.maxTurnSeconds);
        let session: MathAgentSession | undefined, incomplete = false, modelSlot: MathModelSlot | undefined, stopped = false;
        let failureDiagnostic: MathAgentFailureDiagnostic | undefined;
        const interrupt = () => { void session?.interrupt().catch(() => {}); void session?.close().catch(() => {}); };
        const stop = () => { stopped = true; interrupt(); };
        signal.addEventListener('abort', interrupt, { once: true });
        running.add(stop);
        try {
          // Host-side admission control across every process sharing the model gateway.
          const slotConfiguration = options.openSession ? undefined : configuredMathModelSlots();
          if (slotConfiguration) {
            event('informalization_model_slot_waiting', slot);
            modelSlot = await acquireMathModelSlot(slotConfiguration, { signal });
          }
          session = await openWorkflowSession(config, {
            executable: config.executable, profile: config.profile, workspace, model: config.model, effort: config.effort,
            instructions: instructionsText, environment: env, signal,
            turnTimeoutMs: Number.isFinite(turnTimeout) ? turnTimeout : undefined,
            readIsolation: { environment: request.environment },
            completedOutput: { file: outputFile,
              validate: value => { const problems = check(value); if (problems.length) throw new OutputRejected(problems); },
              validationFeedback: error => informalizationRejectionFeedback(error instanceof OutputRejected ? error.problems : [errorText(error)]) },
            onUsage: usage => {
              record.usage = usage; save();
              if (spent()) for (const stopRole of running) stopRole();
            }, onUsageIncomplete: () => { incomplete = true; },
          }, options.openSession);
          signal.throwIfAborted();
          if (stopped || spent()) throw new Error('math_total_token_limit');
          record.threadId = session.threadId;
          if (state.sessions.some(item => item !== record && item.threadId === record.threadId))
            throw new Error('informalization_role_thread_reused');
          record.usageAccounting.startedTurns = 1; record.usageAccounting.pending = true;
          record.status = 'running'; save();
          // A turn stopped at the allowance ends the run; one that still finished keeps its output.
          record.status = await session.run(ROLE_PROMPT, crypto.randomUUID(), workspace, turnId => { record.turnId = turnId; record.turns = 1; save(); })
            .catch((cause: unknown) => { throw stopped ? new Error('math_total_token_limit') : cause; });
          signal.throwIfAborted();
          if (!['completed', 'submitted'].includes(record.status) || !record.turnId) {
            failureDiagnostic = session.lastFailureDiagnostic;
            if (failureDiagnostic) record.failureDiagnostic = { ...failureDiagnostic };
            if (stopped) throw new Error('math_total_token_limit');
            throw new InformalizationRoleFailure(record.status, session.lastFailureDiagnostic);
          }
          await session.close();
          if (currentProfileDigest() !== profileDigest) throw new Error('informalization_profile_changed_during_run');
          if (readMathText(inputFile, 8_000_000) !== inputText || readMathText(instructionsFile, 1_000_000) !== instructionsText ||
              readMathText(schemaFile, 1_000_000) !== schemaText) throw new Error('informalization_role_contract_changed');
          // A missing, linked or malformed output is a failed attempt, not an infrastructure error.
          let output: unknown;
          try { output = JSON.parse(readMathText(outputFile, 4_000_000)); } catch { output = undefined; }
          if (output !== undefined) record.outputDigest = informalizationDigest(output);
          return output;
        } finally {
          await session?.close();
          await modelSlot?.release();
          if (['opening', 'running'].includes(record.status)) record.status = signal.aborted || stopped ? 'interrupted' : 'failed';
          signal.removeEventListener('abort', interrupt);
          running.delete(stop);
          record.usageAccounting.pending = false;
          record.usageAccounting.reportedTurns = reportedTotalTokens(record.usage) !== null && !incomplete ? 1 : 0;
          record.usageAccounting.incomplete = incomplete || (record.usageAccounting.startedTurns > record.usageAccounting.reportedTurns);
          save(); event('informalization_role_finished', { ...slot, ...(failureDiagnostic ? { failureDiagnostic } : {}) });
        }
      };
      const dispatch = async (slot: Slot, input: { inputDigest: string }, check: (value: unknown) => string[],
        signal = lease.signal) => {
        for (let attempt = 1; ; attempt++) {
          try {
            const result = await dispatchOnce(slot, input, check, signal);
            if (state.error?.startsWith('informalization_role_incomplete:')) { delete state.error; save(); }
            return result;
          } catch (cause) {
            if (!retryableRoleFailure(cause)) throw cause;
            signal.throwIfAborted();
            if (remaining() <= 0) throw new Error('informalization_time_limit');
            const budget = buildTokenBudget(request.maxTotalTokens, state.sessions);
            if (!modelDispatchAllowed(budget)) throw new Error(budget.reason ?? 'informalization_token_limit');
            if (attempt >= MAX_ROLE_TRANSPORT_ATTEMPTS) throw new Error(informalizationRetryLimit);
            state.error = errorText(cause); save(); event('informalization_role_retrying', { ...slot, error: state.error });
            const cap = Math.min(1000 * 2 ** (attempt - 1), remaining());
            const delay = Math.max(1, Math.round(cap * (0.5 + Math.random() * 0.5)));
            await (options.waitForRetry ?? ((ms, signal) => wait(ms, undefined, { signal })))(delay, signal);
          }
        }
      };
      try {
        let outline: InformalizationOutline;
        if (state.outline) {
          try {
            const value: unknown = JSON.parse(readMathText(path.join(directory, state.outline.file), 64_000_000));
            if (informalizationDigest(value) !== state.outline.digest) throw new Error('digest');
            outline = informalizationOutlineSchema.parse(value);
          } catch { throw new Error('informalization_checkpoint_changed:outline'); }
        } else {
          event('informalization_extraction_started');
          outline = informalizationOutlineSchema.parse(await (options.extract ?? extractInformalizationOutline)(
            path.join(directory, 'extraction-' + crypto.randomUUID()), request, sources,
            { env, signal: lease.signal, timeoutMs: Number.isFinite(stageTimeout(request.maxCompileSeconds)) ? stageTimeout(request.maxCompileSeconds) : 0 }));
          writeMathJsonDurable(path.join(directory, 'outline.json'), outline, 0o400);
          state.outline = { file: 'outline.json', digest: informalizationDigest(outline) }; save();
          event('informalization_extraction_finished');
        }
        const batches = informalizationBatches(outline, request.batching);
        if (!state.batches.length) {
          state.batches = batches.map(batch => ({ index: batch.index, declarations: batch.declarations, status: 'pending' as const,
            rounds: 0, open: false }));
          save();
        }
        if (canonicalMathJson(state.batches.map(batch => batch.declarations)) !== canonicalMathJson(batches.map(batch => batch.declarations)))
          throw new Error('informalization_checkpoint_changed:batches');
        const accepted = new Map<string, InformalizationSection>();
        for (const batch of batches) {
          const record = state.batches[batch.index]!;
          while (record.status !== 'approved') {
            if (!record.open) {
              if (request.maxRoundsPerBatch !== 0 && record.rounds >= request.maxRoundsPerBatch) {
                state.status = 'exhausted';
                state.error = `informalization_rounds_exhausted: batch ${batch.index + 1}/${batch.count} (${batch.declarations.join(', ')})` +
                  (record.feedback ? '\n' + record.feedback.slice(0, 8000) : '');
                save();
                return summarizeRun(directory, request, state);
              }
              record.rounds++; record.open = true; save();
            }
            const round = record.rounds, context = { outline, batch, accepted, sources, language: request.language,
              alignment: request.alignment, explanationPolicy: request.explanationPolicy, outlinePolicy: request.outlinePolicy };
            const writerInput = informalizationWriterInput({ ...context, round, problemStatement: request.statement,
              feedback: record.feedback ?? null, previousOutput: record.previous ?? null });
            const written = await dispatch({ role: 'write', batch: batch.index, round, attempt: 1 }, writerInput,
              value => informalizationWriterSubmissionRejections(writerInput, value));
            const problems = written === undefined ? ['OUTPUT.json was not written as complete JSON'] :
              informalizationWriterSubmissionRejections(writerInput, written);
            if (problems.length) {
              const parsed = informalizationWriterOutputSchemaFor(request.alignment, request.outlinePolicy).safeParse(written);
              record.feedback = informalizationRejectionFeedback(problems);
              if (parsed.success) record.previous = parsed.data;
              record.open = false; save();
              event('informalization_revision_requested', { batch: batch.index, round, role: 'write', error: record.feedback });
              continue;
            }
            const explanation = written as InformalizationWriterOutput;
            const auditInput = informalizationAuditInput({ ...context, explanation });
            const auditStop = new AbortController();
            const auditSignal = AbortSignal.any([lease.signal, auditStop.signal]);
            let firstFailure: { cause: unknown } | undefined;
            const audits = await Promise.all(request.auditors.map(async auditor => {
              try {
                for (let attempt = 1; attempt <= MAX_AUDIT_ATTEMPTS; attempt++) {
                  const output = await dispatch({ role: 'audit', batch: batch.index, round, attempt, auditorId: auditor.id }, auditInput,
                    value => informalizationAuditRejections(auditInput, value), auditSignal);
                  if (output !== undefined && !informalizationAuditRejections(auditInput, output).length)
                    return { auditorId: auditor.id, output: output as InformalizationAuditOutput };
                }
                throw new Error(`informalization_audit_invalid: ${auditor.id} wrote no valid audit in ${MAX_AUDIT_ATTEMPTS} attempts`);
              } catch (error) {
                firstFailure ??= { cause: error };
                if (errorText(error) === informalizationRetryLimit) auditStop.abort(error);
                return undefined;
              }
            }));
            if (firstFailure) throw firstFailure.cause;
            const completedAudits = audits.filter(item => item !== undefined);
            if (completedAudits.every(item => informalizationAuditApproved(item.output))) {
              record.status = 'approved'; record.open = false; delete record.feedback; delete record.previous;
              record.accepted = { writer: explanation, writerInputDigest: writerInput.inputDigest, audits: completedAudits };
              save(); event('informalization_batch_approved', { batch: batch.index, round });
            } else {
              record.feedback = informalizationAuditFeedback(completedAudits); record.previous = explanation;
              record.open = false; save();
              event('informalization_revision_requested', { batch: batch.index, round, role: 'audit', error: record.feedback });
            }
          }
          for (const section of record.accepted!.writer.sections) accepted.set(section.declaration, section);
        }
        const evidenceBatches: InformalizationEvidence['batches'] = state.batches.map(batch => ({ index: batch.index,
          declarations: batch.declarations, rounds: batch.rounds, writerInputDigest: batch.accepted!.writerInputDigest,
          writer: batch.accepted!.writer, audits: batch.accepted!.audits }));
        const sessions: InformalizationEvidence['sessions'] = state.sessions.map(item => ({ role: item.role, batch: item.batch,
          round: item.round, attempt: item.attempt, ...(item.auditorId ? { auditorId: item.auditorId } : {}),
          ...(item.threadId ? { threadId: item.threadId } : {}), ...(item.turnId ? { turnId: item.turnId } : {}),
          status: item.status, model: item.model, effort: item.effort, inputDigest: item.inputDigest,
          ...(item.outputDigest ? { outputDigest: item.outputDigest } : {}), usage: item.usage }));
        const artifact = path.join(directory, 'artifact');
        if (fs.existsSync(artifact)) {
          if (readInformalizationArtifact(artifact).requestDigest !== requestDigest) throw new Error('informalization_artifact_request_mismatch');
        } else writeInformalizationArtifact(directory, informalizationEvidence({ request, outline, batches: evidenceBatches, sessions }));
        state.status = 'approved'; delete state.error; save();
        event('informalization_approved');
        return summarizeRun(directory, request, state);
      } catch (cause) {
        state.status = 'stopped'; state.error = errorText(cause).slice(0, 16_000); save();
        return summarizeRun(directory, request, state);
      } finally { cancelTimer?.(); save(false); }
    });
  } catch (cause) {
    // A requested cancellation releases the lease after the stopped state was saved.
    if (controller.signal.aborted && errorText(cause) === 'math_runtime_lease_lost') {
      const stopped = readInformalizationState(directory);
      if (stopped?.status === 'stopped') return summarizeRun(directory, request, stopped);
    }
    throw cause;
  } finally {
    options.signal?.removeEventListener('abort', externalAbort);
    process.removeListener('SIGINT', externalAbort); process.removeListener('SIGTERM', externalAbort);
  }
}
