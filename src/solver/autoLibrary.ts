import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import { createCodexMathSession, type MathAgentFailureDiagnostic, type MathAgentOptions, type MathAgentSession } from '../runtime/codexSession';
import { AUTO_LIBRARY_RECORD_SCHEMA, autoLibraryFile, autoLibraryPackFor, autoLibraryTheorems, inspectAutoLibrarySource,
  libraryImportClosure, parseAutoLibraryRecord, publishAutoLibraryRecord, readAutoLibraryPool, reserveAutoLibraryName,
  takenAutoLibraryNames, withAutoLibraryHeader, type AutoLibraryRecord } from '../math/autoLibrary';
import { AUTO_LIBRARY_PLANNER_INSTRUCTIONS, autoLibraryLeanFeedback, autoLibraryModuleSummary, autoLibraryPlanJsonSchema,
  autoLibraryPlannerInput, autoLibraryPlanProblems, autoLibraryPlanSchema, autoLibraryProverTask, autoLibraryRejectionFeedback,
} from '../math/autoLibraryPlanner';
import { bootstrapLeanTask, LEAN_TASK_DESCRIPTION_MAX_LENGTH } from '../math/leanTask';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { inspectScopedLeanDeclarations } from '../math/leanSource';
import { extractRunLibraryModules, LIBRARY_PACK_SCHEMA, libraryPackDigest, mergeLibraryPacks, parseLibraryPack,
  type LibraryPack } from '../math/libraryPacks';
import { readMathBuildManifest } from '../math/mathBuildManifest';
import { acquireMathModelSlot, configuredMathModelSlots, type MathModelSlot } from '../math/mathModelSlot';
import { resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { canonicalMathJson, mathDigest, readMathText, withMathRuntimeLease, writeMathJsonDurable, type MathLease } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { MAX_RESEARCH_WORKERS } from './modules/organization';
import { runSolver } from './run';
import { initializeUsageAccounting, reportedTotalTokens, type UsageAccounting } from './usageBudget';
import { autoLibraryDemandSchema } from './autoLibraryDemand';
import { checkAutoLibraryApplication, autoLibraryApplicationCheckSchema } from './autoLibraryApplication';

/**
 * Build the library a problem needs before solving it. Each round asks the planner for one module statement,
 * checks that it elaborates, lets a solver run prove it, keeps what Lean accepted without sorry, rechecks that
 * module as a frozen library file and publishes it to the pool with its trigger and cost. Every step is resumable
 * from state.json; nothing reaches the pool before the frozen recheck passes.
 */
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const limit = z.number().int().nonnegative();
const requestSchema = z.object({
  schema: z.literal('theorem-os.auto-library-build.v1'), buildId: z.string().uuid(),
  challengeId: z.string().min(1).max(256), challengeSource: z.string().min(1).max(1024 * 1024),
  task: z.string().max(LEAN_TASK_DESCRIPTION_MAX_LENGTH), environment: z.string().min(1).max(64), environmentDigest: hash,
  definitionTargets: z.array(z.string().min(1).max(512)).max(1024).optional(),
  pool: z.string().min(1).max(4096), basePackDigest: hash.nullable(),
  buildManifestRef: z.string().min(1).max(4096), buildDigest: hash,
  planner: z.object({ model: z.string().min(1).max(128), effort: z.string().min(1).max(32), profile: z.string().min(1).max(4096),
    executable: z.string().min(1).max(4096) }).strict(),
  prover: z.object({ model: z.string().min(1).max(128), effort: z.string().min(1).max(32), executable: z.string().min(1).max(4096),
    workers: z.number().int().min(1).max(MAX_RESEARCH_WORKERS), coordination: z.enum(['cooperative', 'independent']),
    maxRunSeconds: limit, maxTurns: limit, maxTurnSeconds: limit, maxTotalTokens: limit, prepareTimeoutSeconds: z.number().int().positive() }).strict(),
  maxModules: z.number().int().min(1).max(8), maxRounds: z.number().int().min(1).max(8),
  maxRunSeconds: limit, maxTotalTokens: limit, plannerTurnSeconds: limit,
  demand: autoLibraryDemandSchema.optional(),
}).strict();
export type AutoLibraryRequest = z.infer<typeof requestSchema>;

/** Freeze one build: the triggering challenge, environment, hand library, pool, models and limits. */
export function prepareAutoLibraryBuild(directoryInput: string, rootInput: string,
  input: Omit<AutoLibraryRequest, 'schema' | 'buildId' | 'environmentDigest' | 'basePackDigest' | 'buildDigest'> & { basePack?: LibraryPack }): AutoLibraryRequest {
  const directory = path.resolve(directoryInput), root = path.resolve(rootInput);
  assertMathCanonicalPath(directory);
  if (isMathPathWithin(root, directory) || isMathPathWithin(directory, root)) throw new Error('auto_library_directory_must_be_external');
  if (fs.existsSync(directory)) throw new Error('auto_library_directory_exists: use a new directory');
  const environment = getLeanTaskEnvironment(input.environment as LeanTaskEnvironment);
  const buildManifestRef = path.resolve(input.buildManifestRef), pool = path.resolve(input.pool);
  readMathBuildManifest(buildManifestRef, root, path.join(root, 'out/main'));
  assertMathCanonicalPath(pool);
  if (isMathPathWithin(directory, pool) || isMathPathWithin(pool, directory)) throw new Error('auto_library_pool_must_be_separate');
  const { basePack: baseInput, ...rest } = input, basePack = baseInput && parseLibraryPack(baseInput);
  const request = requestSchema.parse({ ...rest, schema: 'theorem-os.auto-library-build.v1', buildId: crypto.randomUUID(),
    environment: environment.id, environmentDigest: environment.dependencyDigest, pool, buildManifestRef,
    buildDigest: mathDigest(readMathText(buildManifestRef, 8_000_000)), basePackDigest: basePack ? libraryPackDigest(basePack) : null });
  if (request.definitionTargets) {
    const definitions = new Set(inspectScopedLeanDeclarations(request.challengeSource)
      .filter(item => item.kind !== 'theorem').map(item => item.qualifiedName));
    if (new Set(request.definitionTargets).size !== request.definitionTargets.length ||
        request.definitionTargets.some(name => !definitions.has(name))) throw new Error('auto_library_definition_target_invalid');
  }
  if (request.demand && request.demand.challengeDigest !== mathDigest(request.challengeSource))
    throw new Error('auto_library_demand_challenge_changed');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (basePack) writeMathJsonDurable(path.join(directory, 'base-pack.json'), basePack, 0o400);
  writeMathJsonDurable(path.join(directory, 'request.json'), request, 0o400);
  return request;
}

export function readAutoLibraryRequest(directory: string): { request: AutoLibraryRequest; basePack?: LibraryPack } {
  const request = requestSchema.parse(JSON.parse(readMathText(path.join(directory, 'request.json'), 4 * 1024 * 1024)));
  if (getLeanTaskEnvironment(request.environment as LeanTaskEnvironment).dependencyDigest !== request.environmentDigest)
    throw new Error('auto_library_environment_changed');
  if (request.basePackDigest === null) return { request };
  const basePack = parseLibraryPack(JSON.parse(readMathText(path.join(directory, 'base-pack.json'), 64 * 1024 * 1024)));
  if (libraryPackDigest(basePack) !== request.basePackDigest) throw new Error('auto_library_base_pack_changed');
  return { request, basePack };
}

const accounting = z.object({ startedTurns: limit, reportedTurns: limit, pending: z.boolean(), incomplete: z.boolean() }).strict();
const sessionSchema = z.object({
  module: limit, round: z.number().int().positive(), attempt: z.number().int().positive(), status: z.string().max(64),
  inputDigest: hash, outputDigest: hash.optional(), workspace: z.string().min(1).max(4096), model: z.string(), effort: z.string(),
  threadId: z.string().max(256).optional(), turnId: z.string().max(256).optional(), turns: limit, usage: z.record(z.unknown()),
  usageAccounting: accounting, failureDiagnostic: z.object({ code: z.string(), httpStatusCode: z.number().int().optional(),
    reason: z.string().optional() }).strict().optional(),
}).strict();
const outcome = z.enum(['rejected', 'none', 'statement_failed', 'no_progress', 'verify_failed', 'published']);
const roundSchema = z.object({
  round: z.number().int().positive(), phase: z.enum(['plan', 'check', 'prove', 'extract', 'verify', 'publish', 'done']),
  pool: z.array(z.string()).max(4096), taken: z.array(z.string()).max(4096), name: z.string().optional(),
  // Read earlier saved rounds without weakening the strict contract for a newly submitted plan.
  plan: autoLibraryPlanSchema.extend({ target: autoLibraryPlanSchema.shape.target.default(null),
    application: autoLibraryPlanSchema.shape.application.default(null),
    remaining: autoLibraryPlanSchema.shape.remaining.default(null) }).optional(),
  prove: z.string().max(4096).optional(), verify: z.string().max(4096).optional(),
  applicationCheck: autoLibraryApplicationCheckSchema.optional(),
  proof: z.object({ status: z.string().max(64), tokens: limit.nullable(), turns: limit.nullable() }).strict().optional(),
  outcome: outcome.optional(), feedback: z.string().max(16_000).optional(),
}).strict();
const moduleSchema = z.object({ index: limit, status: z.enum(['open', 'published', 'none', 'exhausted']), openedAtMs: limit,
  rounds: z.array(roundSchema).max(8), published: z.string().optional() }).strict();
const stateSchema = z.object({
  schema: z.literal('theorem-os.auto-library-state.v1'), requestDigest: hash,
  status: z.enum(['running', 'built', 'none', 'exhausted', 'stopped']),
  modules: z.array(moduleSchema).max(8), sessions: z.array(sessionSchema).max(512),
  elapsedMs: limit, activeSince: limit.optional(), error: z.string().max(16_000).optional(),
}).strict();
type Session = Omit<z.infer<typeof sessionSchema>, 'turns' | 'usageAccounting'> & { turns: number; usageAccounting: UsageAccounting };
type State = Omit<z.infer<typeof stateSchema>, 'sessions'> & { sessions: Session[] };
type Round = z.infer<typeof roundSchema>;
type RunOrigin = { kind: 'run'; runId: string; commit: string; file: string; receiptDigest?: string; environmentDigest?: string;
  dropped?: { name: string; reason: 'original' | 'unproved' | 'dependent' }[] };
type Module = z.infer<typeof moduleSchema>;

export type AutoLibrarySolve = (args: string[], purpose: { phase: 'check' | 'prove' | 'verify'; module: number; round: number;
  name: string }) => Promise<number>;
type Options = {
  openSession?: (options: MathAgentOptions) => Promise<MathAgentSession>;
  /** Solver runs; the default is runSolver from this checkout. */
  solve?: AutoLibrarySolve;
  env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  waitForRetry?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: { event: string; module?: number; round?: number; name?: string; outcome?: string; error?: string }) => void;
};
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
class PlannerFailure extends Error {
  constructor(status: string, readonly diagnostic?: MathAgentFailureDiagnostic) {
    super('auto_library_planner_incomplete:' + status + (diagnostic ? ':' + diagnostic.code + (diagnostic.reason ? ':' + diagnostic.reason : '') : ''));
  }
}
class OutputRejected extends Error {
  constructor(readonly problems: string[]) { super('auto_library_plan_rejected'); }
}
/** A time or token limit; the build ends with what it has published. */
class BuildLimit extends Error {}
const retryable = (cause: unknown) => {
  if (!(cause instanceof PlannerFailure) || !cause.diagnostic) return false;
  const { code, httpStatusCode, reason } = cause.diagnostic;
  if (httpStatusCode !== undefined && httpStatusCode < 500 && httpStatusCode !== 408 && httpStatusCode !== 429) return false;
  return code === 'other' && Boolean(reason) || ['rateLimitExceeded', 'flexUnavailable', 'serverOverloaded', 'httpConnectionFailed',
    'responseStreamConnectionFailed', 'internalServerError', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(code);
};
const ROLE_PROMPT = 'Choose one useful reusable dependency. Read INPUT.json and OUTPUT.schema.json, then write a schema-valid ' +
  'OUTPUT.json atomically and stop. Do not inspect Mathlib or search the library: the host checks your statement next. ' +
  'State a tractable prerequisite with a concrete use, or submit decision none. ROLE.md repeats the developer protocol.';
const PLANNER_TURNS_PER_ATTEMPT = 3;
const CONTINUE_PROMPT = 'Continue the same library-planning decision from the files you already read. ' +
  'Write a schema-valid OUTPUT.json atomically now, or submit decision none if no useful dependency is clear.';

type RunResult = { status?: string; reason?: string; runId?: string; solution_commit?: string | null; stateFile?: string; turns?: number;
  tokenBudget?: { reportedTotalTokens?: number | null } };
const readResult = (file: string): RunResult | undefined =>
  fs.existsSync(file) ? JSON.parse(readMathText(file, 64 * 1024 * 1024)) as RunResult : undefined;
const readJson = (file: string): unknown => { try { return JSON.parse(readMathText(file, 64 * 1024 * 1024)); } catch { return undefined; } };

/** Reported tokens of planner sessions; null when a started turn has no complete report. */
const plannerTokens = (sessions: readonly Session[]): number | null => {
  let total = 0;
  for (const session of sessions) {
    if (!session.usageAccounting.startedTurns && !session.turns) continue;
    const tokens = reportedTotalTokens(session.usage);
    if (tokens === null || session.usageAccounting.incomplete) return null;
    total += tokens;
  }
  return total;
};
const proverTokens = (rounds: readonly Round[]): number | null => {
  let total = 0;
  for (const round of rounds) {
    if (!round.proof) continue;
    if (round.proof.tokens === null) return null;
    total += round.proof.tokens;
  }
  return total;
};
const sum = (a: number | null, b: number | null) => a === null || b === null ? null : a + b;

const summarize = (directory: string, state: State) => ({
  status: state.status, directory, published: state.modules.flatMap(module => module.published ? [module.published] : []),
  modules: state.modules.map(module => ({ index: module.index, status: module.status, published: module.published,
    rounds: module.rounds.map(round => ({ round: round.round, phase: round.phase, name: round.name, outcome: round.outcome,
      proof: round.proof, applicationCheck: round.applicationCheck })) })),
  plannerTokens: plannerTokens(state.sessions), proverTokens: proverTokens(state.modules.flatMap(module => module.rounds)),
  modelTurns: state.sessions.reduce((total, session) => total + session.turns, 0) +
    state.modules.flatMap(module => module.rounds).reduce((total, round) => total + (round.proof?.turns ?? 0), 0),
  elapsedMs: state.elapsedMs, ...(state.error ? { error: state.error } : {}),
});
export type AutoLibrarySummary = ReturnType<typeof summarize>;

export function readAutoLibraryState(directory: string): State | undefined {
  const file = path.join(directory, 'state.json');
  return fs.existsSync(file) ? stateSchema.parse(JSON.parse(readMathText(file, 64 * 1024 * 1024))) as State : undefined;
}

/** Run or resume a prepared build until it publishes, gives up, reaches a limit or is stopped. */
export async function runAutoLibraryBuild(directoryInput: string, rootInput: string, options: Options = {}): Promise<AutoLibrarySummary> {
  const directory = path.resolve(directoryInput), root = path.resolve(rootInput);
  assertMathCanonicalPath(directory);
  if (isMathPathWithin(root, directory) || isMathPathWithin(directory, root)) throw new Error('auto_library_directory_must_be_external');
  const { request, basePack } = readAutoLibraryRequest(directory), requestDigest = mathDigest(canonicalMathJson(request));
  readMathBuildManifest(request.buildManifestRef, root, path.join(root, 'out/main'));
  if (mathDigest(readMathText(request.buildManifestRef, 8_000_000)) !== request.buildDigest) throw new Error('auto_library_build_changed');
  const env = resolveMathematicsRuntimeEnvironment(options.env ?? process.env);
  const solve = options.solve ?? (args => runSolver(args, root));
  const controller = new AbortController(), externalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    return await withMathRuntimeLease({ lockPath: path.join(directory, 'run.lock'), flockExecutable: '/usr/bin/flock', signal: controller.signal },
      lease => build({ directory, request, requestDigest, basePack, env, solve, lease, options }));
  } catch (cause) {
    if (controller.signal.aborted && errorText(cause) === 'math_runtime_lease_lost') {
      const stopped = readAutoLibraryState(directory);
      if (stopped?.status === 'stopped') return summarize(directory, stopped);
    }
    throw cause;
  } finally { options.signal?.removeEventListener('abort', externalAbort); }
}

async function build(context: { directory: string; request: AutoLibraryRequest; requestDigest: string; basePack?: LibraryPack;
  env: NodeJS.ProcessEnv; solve: AutoLibrarySolve; lease: MathLease; options: Options }): Promise<AutoLibrarySummary> {
  const { directory, request, basePack, lease, options } = context;
  const state: State = readAutoLibraryState(directory) ?? { schema: 'theorem-os.auto-library-state.v1', requestDigest: context.requestDigest,
    status: 'running', modules: [], sessions: [], elapsedMs: 0 };
  if (state.requestDigest !== context.requestDigest) throw new Error('auto_library_resume_identity_changed');
  if (state.status !== 'running' && state.status !== 'stopped') return summarize(directory, state);
  if (state.activeSince !== undefined) state.elapsedMs += Math.max(0, Date.now() - state.activeSince);
  delete state.activeSince; delete state.error; state.status = 'running';
  for (const session of state.sessions) initializeUsageAccounting(session);
  const startedAt = Date.now(), elapsedBefore = state.elapsedMs;
  const elapsed = () => elapsedBefore + Date.now() - startedAt;
  const remainingMs = () => request.maxRunSeconds === 0 ? Infinity : request.maxRunSeconds * 1000 - elapsed();
  const save = (active = true) => {
    state.elapsedMs = elapsed();
    if (active) state.activeSince = Date.now(); else delete state.activeSince;
    writeMathJsonDurable(path.join(directory, 'state.json'), state);
  };
  const event = (name: string, detail: { module?: number; round?: number; name?: string; outcome?: string; error?: string } = {}) =>
    options.onEvent?.({ event: name, ...detail });
  const spent = () => sum(plannerTokens(state.sessions), proverTokens(state.modules.flatMap(module => module.rounds)));
  const remainingTokens = () => {
    if (!request.maxTotalTokens) return Infinity;
    const used = spent();
    return used === null ? 0 : request.maxTotalTokens - used;
  };
  // Limits stop new planning and proving; a proved module is still extracted, rechecked and published.
  const checkLimits = () => {
    lease.signal.throwIfAborted();
    if (remainingMs() <= 0) throw new BuildLimit('auto_library_time_limit');
    if (remainingTokens() <= 0) throw new BuildLimit(spent() === null ? 'auto_library_usage_unavailable' : 'auto_library_token_limit');
  };
  const environment = getLeanTaskEnvironment(request.environment as LeanTaskEnvironment);
  const records = (names: readonly string[]) => {
    const wanted = new Set(names), found = readAutoLibraryPool(request.pool).filter(record => wanted.has(record.name));
    if (found.length !== wanted.size) throw new Error('auto_library_pool_changed');
    return found;
  };
  // The pack a round works against: the hand library plus the pool snapshot taken when the round opened.
  const roundPack = (round: Round) => autoLibraryPackFor({ base: basePack, records: records(round.pool),
    environmentDigest: environment.dependencyDigest, challengeSource: request.challengeSource }).pack;
  // The pack modules a source imports, transitively: what its proof project installs.
  const closurePack = (pack: LibraryPack | undefined, source: string): LibraryPack | undefined => {
    const files = new Set(libraryImportClosure(pack, source));
    return pack && files.size ? parseLibraryPack({ schema: LIBRARY_PACK_SCHEMA, modules: pack.modules.filter(module => files.has(module.file)) }) : undefined;
  };
  const runArgs = (directoryOf: string, phase: 'check' | 'prove' | 'verify', extra: string[]) => [
    '--workspace', path.join(directoryOf, 'workspace'), '--task-file', path.join(directoryOf, 'task.md'),
    '--output', path.join(directoryOf, 'result.json'), '--build-manifest', request.buildManifestRef,
    '--workers', String(phase === 'verify' ? 1 : request.prover.workers), '--coordination', request.prover.coordination,
    '--model', request.prover.model, '--effort', request.prover.effort, '--codex', request.prover.executable,
    '--max-turns', String(request.prover.maxTurns), '--max-turn-seconds', String(request.prover.maxTurnSeconds),
    '--prepare-timeout-seconds', String(request.prover.prepareTimeoutSeconds), ...extra];
  const resumeFlag = (directoryOf: string) => fs.existsSync(path.join(directoryOf, 'result.json.runtime', 'state.json')) ? ['--resume'] : [];
  const plannerOnce = async (module: Module, round: Round, attempt: number, input: ReturnType<typeof autoLibraryPlannerInput>,
    pack: LibraryPack | undefined): Promise<unknown> => {
    checkLimits();
    const inputText = canonicalMathJson(input), schemaText = canonicalMathJson(autoLibraryPlanJsonSchema());
    const cached = state.sessions.findLast(item => item.module === module.index && item.round === round.round && item.attempt === attempt &&
      item.inputDigest === input.inputDigest && item.outputDigest && item.turnId && ['completed', 'submitted'].includes(item.status));
    if (cached) {
      const output: unknown = JSON.parse(readMathText(path.join(directory, cached.workspace, 'OUTPUT.json'), 1024 * 1024));
      if (mathDigest(canonicalMathJson(output)) !== cached.outputDigest) throw new Error('auto_library_checkpoint_changed');
      return output;
    }
    const workspace = path.join(directory, 'modules', String(module.index), `round-${round.round}`, `plan-${attempt}-${crypto.randomUUID().slice(0, 8)}`);
    fs.mkdirSync(path.join(workspace, 'library'), { recursive: true, mode: 0o700 });
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, text, { mode: 0o400, flag: 'wx' });
    };
    write(path.join(workspace, 'INPUT.json'), inputText);
    write(path.join(workspace, 'ROLE.md'), AUTO_LIBRARY_PLANNER_INSTRUCTIONS);
    write(path.join(workspace, 'OUTPUT.schema.json'), schemaText);
    for (const item of pack?.modules ?? []) write(path.join(workspace, 'library', item.file), item.source);
    const record: Session = { module: module.index, round: round.round, attempt, status: 'opening', inputDigest: input.inputDigest,
      workspace: path.relative(directory, workspace), model: request.planner.model, effort: request.planner.effort, turns: 0, usage: {},
      usageAccounting: { startedTurns: 0, reportedTurns: 0, pending: false, incomplete: false } };
    state.sessions.push(record); save(); event('auto_library_planner_started', { module: module.index, round: round.round });
    let session: MathAgentSession | undefined, slot: MathModelSlot | undefined, incomplete = false;
    const interrupt = () => { void session?.interrupt().catch(() => {}); void session?.close().catch(() => {}); };
    lease.signal.addEventListener('abort', interrupt, { once: true });
    try {
      const slots = options.openSession ? undefined : configuredMathModelSlots();
      if (slots) slot = await acquireMathModelSlot(slots, { signal: lease.signal });
      const turnMs = Math.min(request.plannerTurnSeconds ? request.plannerTurnSeconds * 1000 : Infinity, Math.max(1, remainingMs()));
      session = await (options.openSession ?? createCodexMathSession)({
        executable: request.planner.executable, profile: request.planner.profile, workspace, model: request.planner.model,
        effort: request.planner.effort, instructions: AUTO_LIBRARY_PLANNER_INSTRUCTIONS, environment: context.env, signal: lease.signal,
        turnTimeoutMs: Number.isFinite(turnMs) ? turnMs : undefined,
        readIsolation: { environment: request.environment as LeanTaskEnvironment },
        completedOutput: { file: path.join(workspace, 'OUTPUT.json'),
          validate: value => { const problems = autoLibraryPlanSchema.safeParse(value).success ? [] : ['OUTPUT.json does not match OUTPUT.schema.json'];
            if (problems.length) throw new OutputRejected(problems); },
          validationFeedback: error => autoLibraryRejectionFeedback(error instanceof OutputRejected ? error.problems : [errorText(error)]) },
        onUsage: usage => { record.usage = usage; save(); }, onUsageIncomplete: () => { incomplete = true; },
      });
      if (lease.signal.aborted) { await session.close(); lease.signal.throwIfAborted(); }
      record.threadId = session.threadId;
      for (let turn = 0; turn < PLANNER_TURNS_PER_ATTEMPT; turn++) {
        checkLimits();
        record.usageAccounting.startedTurns++;
        record.usageAccounting.pending = true; record.status = 'running'; save();
        record.status = await session.run(turn === 0 ? ROLE_PROMPT : CONTINUE_PROMPT,
          crypto.randomUUID(), workspace, turnId => { record.turnId = turnId; record.turns++; save(); });
        lease.signal.throwIfAborted();
        if (record.status !== 'checkpoint') break;
      }
      lease.signal.throwIfAborted();
      if (!['completed', 'submitted'].includes(record.status) || !record.turnId) {
        if (session.lastFailureDiagnostic) record.failureDiagnostic = { ...session.lastFailureDiagnostic };
        throw new PlannerFailure(record.status, session.lastFailureDiagnostic);
      }
      await session.close();
      if (readMathText(path.join(workspace, 'INPUT.json'), 8_000_000) !== inputText) throw new Error('auto_library_planner_input_changed');
      let output: unknown;
      try { output = JSON.parse(readMathText(path.join(workspace, 'OUTPUT.json'), 1024 * 1024)); } catch { output = undefined; }
      if (output !== undefined) record.outputDigest = mathDigest(canonicalMathJson(output));
      return output;
    } finally {
      await session?.close().catch(() => {});
      await slot?.release();
      if (['opening', 'running'].includes(record.status)) record.status = lease.signal.aborted ? 'interrupted' : 'failed';
      lease.signal.removeEventListener('abort', interrupt);
      record.usageAccounting.pending = false;
      record.usageAccounting.reportedTurns = reportedTotalTokens(record.usage) !== null && !incomplete ? record.turns : 0;
      record.usageAccounting.incomplete = incomplete || record.usageAccounting.startedTurns > record.usageAccounting.reportedTurns;
      save(); event('auto_library_planner_finished', { module: module.index, round: round.round });
    }
  };
  // Transient provider failures retry the same role in a fresh thread; anything else stops the build.
  const planner = async (module: Module, round: Round, input: ReturnType<typeof autoLibraryPlannerInput>, pack: LibraryPack | undefined) => {
    for (let retry = 0; ; retry++) {
      const done = state.sessions.findLast(item => item.module === module.index && item.round === round.round &&
        item.inputDigest === input.inputDigest && item.outputDigest && item.turnId && ['completed', 'submitted'].includes(item.status));
      const attempt = done?.attempt ?? state.sessions.filter(item => item.module === module.index && item.round === round.round).length + 1;
      try { return await plannerOnce(module, round, attempt, input, pack); }
      catch (cause) {
        if (!retryable(cause) || retry >= 3) throw cause;
        state.error = errorText(cause); save(); event('auto_library_planner_retrying', { module: module.index, round: round.round, error: state.error });
        const delay = Math.max(1, Math.round(Math.min(30_000, 1000 * 2 ** retry, Math.max(1, remainingMs())) * (0.5 + Math.random() * 0.5)));
        await (options.waitForRetry ?? ((ms, signal) => wait(ms, undefined, { signal })))(delay, lease.signal);
        delete state.error;
      }
    }
  };
  const finish = (module: Module, round: Round, result: z.infer<typeof outcome>, feedback?: string) => {
    round.outcome = result; round.phase = 'done';
    if (feedback) round.feedback = feedback;
    save(); event('auto_library_round_finished', { module: module.index, round: round.round, name: round.name, outcome: result });
  };
  const plan = async (module: Module, round: Round) => {
    checkLimits();
    const pack = roundPack(round), previous = module.rounds.at(-2);
    const library = (pack?.modules ?? []).map(item => ({ module: item.file.slice(0, -5).replaceAll('/', '.'), file: item.file,
      auto: item.file.startsWith('Submission/Library/Auto/'), declarations: autoLibraryTheorems(item.source).length,
      theorems: item.file.startsWith('Submission/Library/Auto/') ? autoLibraryTheorems(item.source) : [],
      summary: autoLibraryModuleSummary(item.source) }));
    const input = autoLibraryPlannerInput({ challengeId: request.challengeId, challenge: request.challengeSource, task: request.task,
      ...(request.definitionTargets ? { definitionTargets: request.definitionTargets } : {}),
      ...(request.demand ? { demand: request.demand } : {}),
      environment: request.environment, library, taken: round.taken, module: module.index, round: round.round, maxRounds: request.maxRounds,
      ...(previous?.feedback ? { feedback: previous.feedback } : {}),
      ...(previous?.plan ? { previous: { name: previous.plan.name, summary: previous.plan.summary, lean: previous.plan.lean,
        target: previous.plan.target, application: previous.plan.application, remaining: previous.plan.remaining } } : {}) });
    const output = await planner(module, round, input, pack);
    const parsed = autoLibraryPlanSchema.safeParse(output);
    if (parsed.success) { round.plan = parsed.data; save(); }
    const modules = new Set((pack?.modules ?? []).map(item => item.file.slice(0, -5).replaceAll('/', '.')));
    const problems = output === undefined ? ['the planner wrote no readable OUTPUT.json'] :
      autoLibraryPlanProblems(output, { inputDigest: input.inputDigest, taken: round.taken,
        challenge: request.challengeSource, definitionTargets: request.definitionTargets, libraryModules: modules });
    if (problems.length) return finish(module, round, 'rejected', autoLibraryRejectionFeedback(problems));
    if (round.plan!.decision === 'none') return finish(module, round, 'none');
    if (!await reserveAutoLibraryName(request.pool, round.plan!.name!, request.buildId))
      return finish(module, round, 'rejected', autoLibraryRejectionFeedback([`name ${round.plan!.name} was taken by another build; choose another`]));
    round.name = round.plan!.name!; round.phase = 'check'; save();
  };
  const check = async (module: Module, round: Round) => {
    checkLimits();
    const name = round.name!, spec = round.plan!.lean!, pack = closurePack(roundPack(round), spec);
    const roundDirectory = path.join(directory, 'modules', String(module.index), `round-${round.round}`);
    if (!round.prove || !fs.existsSync(path.join(roundDirectory, round.prove, 'workspace', 'active-problem.json'))) {
      round.prove = `prove-${crypto.randomUUID().slice(0, 8)}`; save();
      const proveDirectory = path.join(roundDirectory, round.prove);
      fs.mkdirSync(proveDirectory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(proveDirectory, 'task.md'), autoLibraryProverTask(name) + '\n', { mode: 0o400, flag: 'wx' });
      try {
        bootstrapLeanTask(path.join(proveDirectory, 'workspace'), { source: spec, task: autoLibraryProverTask(name),
          environment: request.environment as LeanTaskEnvironment, ...(pack ? { libraryPack: pack } : {}) });
      } catch (cause) {
        return finish(module, round, 'rejected', autoLibraryRejectionFeedback([`the statement could not be set up as a proof task: ${errorText(cause)}`]));
      }
    }
    const proveDirectory = path.join(roundDirectory, round.prove), output = path.join(proveDirectory, 'result.json');
    let result = readResult(output);
    if (result?.status !== 'prepared' && result?.reason !== 'math_statement_check_failed') {
      await context.solve(runArgs(proveDirectory, 'check', ['--startup-only', '--check-statement', '--max-run-seconds', '0',
        ...resumeFlag(proveDirectory)]), { phase: 'check', module: module.index, round: round.round, name });
      lease.signal.throwIfAborted();
      result = readResult(output);
    }
    if (result?.reason === 'math_statement_check_failed')
      return finish(module, round, 'statement_failed', autoLibraryLeanFeedback('Lean rejected the module statement (theorem bodies may stay sorry):',
        readJson(path.join(`${output}.runtime`, 'statement-diagnostics.json'))));
    if (result?.status !== 'prepared') throw new Error(`auto_library_check_failed: ${result?.reason ?? result?.status ?? 'no result'}`);
    round.phase = 'prove'; save();
  };
  const prove = async (module: Module, round: Round) => {
    const name = round.name!, proveDirectory = path.join(directory, 'modules', String(module.index), `round-${round.round}`, round.prove!);
    const output = path.join(proveDirectory, 'result.json');
    let result = readResult(output);
    const seconds = Math.min(request.prover.maxRunSeconds || Infinity, Math.floor(remainingMs() / 1000));
    const tokens = Math.min(request.prover.maxTotalTokens || Infinity, remainingTokens());
    // Phase prove is left only after a solve returned while this build still ran, so a saved result in this phase
    // belongs to a run this build stopped (or never wrote one): resume it. Finished proofs return at once.
    if (!['evaluated_passed', 'evaluated_failed'].includes(result?.status ?? '') && seconds >= 1 && tokens > 0) {
      await context.solve(runArgs(proveDirectory, 'prove', ['--resume', '--max-run-seconds', String(Number.isFinite(seconds) ? seconds : 0),
        '--max-total-tokens', String(Number.isFinite(tokens) ? tokens : 0)]), { phase: 'prove', module: module.index, round: round.round, name });
      lease.signal.throwIfAborted();
      result = readResult(output);
    }
    round.proof = { status: result?.status ?? 'unavailable', tokens: result?.tokenBudget?.reportedTotalTokens ?? null,
      turns: typeof result?.turns === 'number' ? result.turns : null };
    round.phase = 'extract'; save();
  };
  const extract = (module: Module, round: Round) => {
    const name = round.name!, spec = round.plan!.lean!, proveDirectory = path.join(directory, 'modules', String(module.index), `round-${round.round}`, round.prove!);
    const extractedFile = path.join(proveDirectory, 'extracted.json');
    if (!fs.existsSync(extractedFile)) {
      const result = readResult(path.join(proveDirectory, 'result.json')), stateFile = path.join(proveDirectory, 'result.json.runtime', 'state.json');
      const saved = readJson(stateFile) as { cooperation?: { canonicalCommit?: unknown } } | undefined;
      const commits = [...new Set([result?.solution_commit, saved?.cooperation?.canonicalCommit]
        .filter((commit): commit is string => typeof commit === 'string'))];
      const pack = closurePack(roundPack(round), spec);
      const wanted = new Set(autoLibraryTheorems(spec)), failures: string[] = [];
      for (const commit of commits) {
        let extracted;
        try {
          extracted = extractRunLibraryModules({ stateFile, files: ['Submission.lean'], commit, keepOriginals: true, dropUnproved: true,
            modulePaths: { 'Submission.lean': autoLibraryFile(name) }, ...(pack ? { base: pack } : {}) });
        } catch (cause) { failures.push(errorText(cause)); continue; }
        const found = extracted.modules.find(item => item.file === autoLibraryFile(name))!;
        const kept = autoLibraryTheorems(found.source).filter(theorem => wanted.has(theorem));
        if (!kept.length) { failures.push('no stated theorem was proved'); continue; }
        const source = withAutoLibraryHeader(found.source, { name, summary: round.plan!.summary!, sources: round.plan!.sources!,
          ...(round.plan!.target && round.plan!.application && round.plan!.remaining ? {
            application: { target: round.plan!.target, use: round.plan!.application, remaining: round.plan!.remaining } } : {}) });
        const problems = inspectAutoLibrarySource({ name, source, libraryModules: new Set((pack?.modules ?? [])
          .map(item => item.file.slice(0, -5).replaceAll('/', '.'))), allowSorry: false });
        if (problems.length) { failures.push(...problems); continue; }
        if (found.origin.kind !== 'run') throw new Error('auto_library_extract_origin_invalid');
        writeMathJsonDurable(extractedFile, { source, kept, origin: found.origin }, 0o400);
        break;
      }
      if (!fs.existsSync(extractedFile))
        return finish(module, round, 'no_progress', autoLibraryRejectionFeedback([
          'It proved none of the stated theorems in a form the library can keep.', ...failures.slice(0, 6),
          'State smaller lemmas, or a different module.'], 'The solver run did not prove the module:'));
    }
    round.phase = 'verify'; save();
  };
  const extracted = (module: Module, round: Round) => JSON.parse(readMathText(path.join(directory, 'modules', String(module.index),
    `round-${round.round}`, round.prove!, 'extracted.json'), 4 * 1024 * 1024)) as { source: string; kept: string[];
    origin: RunOrigin };
  // The module as a frozen library file of a fresh project: the startup recheck compiles it and rejects sorry.
  const verify = async (module: Module, round: Round) => {
    const name = round.name!, item = extracted(module, round), pack = closurePack(roundPack(round), item.source);
    const roundDirectory = path.join(directory, 'modules', String(module.index), `round-${round.round}`);
    if (!round.verify || !fs.existsSync(path.join(roundDirectory, round.verify, 'workspace', 'active-problem.json'))) {
      round.verify = `verify-${crypto.randomUUID().slice(0, 8)}`; save();
      const verifyDirectory = path.join(roundDirectory, round.verify), task = `Check that the library module ${name} installs.`;
      fs.mkdirSync(verifyDirectory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(verifyDirectory, 'task.md'), task + '\n', { mode: 0o400, flag: 'wx' });
      const own: LibraryPack = { schema: LIBRARY_PACK_SCHEMA, modules: [{ file: autoLibraryFile(name), source: item.source, origin: item.origin }] };
      try {
        bootstrapLeanTask(path.join(verifyDirectory, 'workspace'), { source: 'theorem auto_library_installed : True := trivial\n', task,
          environment: request.environment as LeanTaskEnvironment, libraryPack: pack ? mergeLibraryPacks([pack, own]) : parseLibraryPack(own) });
      } catch (cause) {
        return finish(module, round, 'verify_failed', autoLibraryRejectionFeedback([`the proved module could not be installed: ${errorText(cause)}`]));
      }
    }
    const verifyDirectory = path.join(roundDirectory, round.verify), output = path.join(verifyDirectory, 'result.json');
    let result = readResult(output);
    if (result?.status !== 'prepared' && result?.reason !== 'math_library_pack_failed') {
      await context.solve(runArgs(verifyDirectory, 'verify', ['--startup-only', '--max-run-seconds', '0', ...resumeFlag(verifyDirectory)]),
        { phase: 'verify', module: module.index, round: round.round, name });
      lease.signal.throwIfAborted();
      result = readResult(output);
    }
    if (result?.reason === 'math_library_pack_failed')
      return finish(module, round, 'verify_failed', autoLibraryLeanFeedback('Lean rejected the proved module as a frozen library file:',
        readJson(path.join(`${output}.runtime`, 'library-pack-diagnostics.json'))));
    if (result?.status !== 'prepared') throw new Error(`auto_library_verify_failed: ${result?.reason ?? result?.status ?? 'no result'}`);
    if (round.plan?.consumerApplication && !round.applicationCheck) {
      const item = extracted(module, round), pack = roundPack(round);
      const own: LibraryPack = { schema: LIBRARY_PACK_SCHEMA, modules: [{ file: autoLibraryFile(name), source: item.source, origin: item.origin }] };
      const consumerDirectory = path.join(roundDirectory, 'consumer-application');
      round.applicationCheck = await checkAutoLibraryApplication({
        workspace: consumerDirectory, source: request.challengeSource,
        definitionTargets: request.definitionTargets,
        environment: request.environment as LeanTaskEnvironment, pack: pack ? mergeLibraryPacks([pack, own]) : parseLibraryPack(own),
        moduleName: name, selected: { declaration: round.plan.consumerApplication.declaration!,
          application: round.plan.consumerApplication.application! }, env: context.env, signal: lease.signal,
        prepare: async () => {
          fs.writeFileSync(path.join(consumerDirectory, 'task.md'), 'Check the selected library application at its original consumer.\n', { mode: 0o400 });
          await context.solve(runArgs(consumerDirectory, 'verify', ['--startup-only', '--max-run-seconds', '0', ...resumeFlag(consumerDirectory)]),
            { phase: 'verify', module: module.index, round: round.round, name });
          if (readResult(path.join(consumerDirectory, 'result.json'))?.status !== 'prepared')
            throw new Error('auto_library_application_environment_unavailable');
        } });
      save(); lease.signal.throwIfAborted();
    }
    round.phase = 'publish'; save();
  };
  const publish = async (module: Module, round: Round) => {
    const name = round.name!, roundDirectory = path.join(directory, 'modules', String(module.index), `round-${round.round}`);
    const recordFile = path.join(roundDirectory, 'record.json');
    let record: AutoLibraryRecord;
    if (fs.existsSync(recordFile)) record = parseAutoLibraryRecord(JSON.parse(readMathText(recordFile, 4 * 1024 * 1024)));
    else {
      const item = extracted(module, round), pack = roundPack(round), plan = round.plan!;
      const requires = libraryImportClosure(pack, item.source).map(file =>
        ({ file, digest: mathDigest(pack!.modules.find(entry => entry.file === file)!.source) }));
      // Every round of this and earlier modules handed its pack to the planner and its closure to the prover.
      const visible = [...new Set(state.modules.filter(entry => entry.index <= module.index).flatMap(entry => entry.rounds)
        .flatMap(entry => (roundPack(entry)?.modules ?? []).map(file => file.file)))].sort();
      const proverState = readJson(path.join(roundDirectory, round.prove!, 'result.json.runtime', 'state.json')) as { runId?: unknown } | undefined;
      record = parseAutoLibraryRecord({ schema: AUTO_LIBRARY_RECORD_SCHEMA, name, file: autoLibraryFile(name), source: item.source,
        sourceDigest: mathDigest(item.source), summary: plan.summary, sources: plan.sources, theorems: autoLibraryTheorems(item.source), requires,
        visible, environment: { id: request.environment, digest: request.environmentDigest },
        trigger: { challengeId: request.challengeId, challengeDigest: mathDigest(request.challengeSource), taskDigest: mathDigest(request.task) },
        cost: { plannerTokens: plannerTokens(state.sessions.filter(session => session.module === module.index)),
          proverTokens: proverTokens(module.rounds), wallMs: Math.max(0, Math.round(elapsed() - module.openedAtMs)), rounds: module.rounds.length },
        planner: { model: request.planner.model, effort: request.planner.effort },
        prover: { runId: typeof proverState?.runId === 'string' ? proverState.runId : item.origin.runId, commit: item.origin.commit,
          model: request.prover.model, ...(item.origin.receiptDigest ? { receiptDigest: item.origin.receiptDigest } : {}),
          ...(item.origin.environmentDigest ? { environmentDigest: item.origin.environmentDigest } : {}),
          dropped: (item.origin.dropped ?? []).filter(entry => entry.reason !== 'original') },
        buildId: request.buildId, buildDigest: request.buildDigest, publishedAt: new Date().toISOString() });
      writeMathJsonDurable(recordFile, record, 0o400);
    }
    await publishAutoLibraryRecord(request.pool, record);
    module.published = name;
    finish(module, round, 'published');
  };
  try {
    for (;;) {
      let module = state.modules.at(-1);
      if (!module || module.status === 'published') {
        if (state.modules.length >= request.maxModules) break;
        checkLimits();
        module = { index: state.modules.length, status: 'open', openedAtMs: Math.round(elapsed()), rounds: [] };
        state.modules.push(module); save();
      }
      if (module.status !== 'open') break;
      const last = module.rounds.at(-1);
      if (last?.phase === 'done') {
        if (last.outcome === 'published') { module.status = 'published'; save(); continue; }
        if (last.outcome === 'none') { module.status = 'none'; save(); break; }
        if (module.rounds.length >= request.maxRounds) { module.status = 'exhausted'; save(); break; }
      }
      let round = last?.phase === 'done' || !last ? undefined : last;
      if (!round) {
        checkLimits();
        const pool = autoLibraryPackFor({ base: basePack, records: readAutoLibraryPool(request.pool),
          environmentDigest: environment.dependencyDigest, challengeSource: request.challengeSource }).included;
        round = { round: module.rounds.length + 1, phase: 'plan', pool, taken: takenAutoLibraryNames(request.pool, request.buildId) };
        module.rounds.push(round); save(); event('auto_library_round_started', { module: module.index, round: round.round });
      }
      const step = { plan, check, prove, extract, verify, publish }[round.phase as Exclude<Round['phase'], 'done'>];
      await step(module, round);
    }
    const published = state.modules.some(module => module.published);
    state.status = published ? 'built' : state.modules.at(-1)?.status === 'none' ? 'none' : 'exhausted';
    save(false); event('auto_library_finished', { outcome: state.status });
  } catch (cause) {
    if (cause instanceof BuildLimit) state.status = state.modules.some(module => module.published) ? 'built' : 'exhausted';
    else state.status = 'stopped';
    state.error = errorText(cause).slice(0, 16_000);
    save(false); event('auto_library_finished', { outcome: state.status, error: state.error });
  }
  return summarize(directory, state);
}

/** Offline: the saved state of a build, or that it is only prepared. */
export function inspectAutoLibraryBuild(directoryInput: string) {
  const directory = path.resolve(directoryInput), state = readAutoLibraryState(directory);
  readAutoLibraryRequest(directory);
  return state ? summarize(directory, state) : { status: 'prepared' as const, directory };
}
