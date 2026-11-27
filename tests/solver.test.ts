import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalMathProblemStatementPayloads, type MathProblemContract } from '../src/math/contracts';
import { LEAN_EVAL_BENCHMARK_COMMIT } from '../src/math/leanEvalCatalogAdapter';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readSolverRunState } from '../src/solver/archive';
import { hashMathFormalSourceDeclaration, type MathematicsVerifierBatchRequest, type MathematicsVerifierBatchResult } from '../src/math/verifier';
import * as verifier from '../src/math/verifier';
import { readSolverProblem, assertSolverSources, assertSolverProjectSources, committedSource, commitSolverSources, git, withSolverWorktree, SolverSourceError, type SolverProblem } from '../src/solver/problem';
import { ownedSourceDeclarations } from '../src/solver/declarationIndex';
import { checkProjectedDeclarations, checkSolverProof } from '../src/solver/modules/evidence';
import { assessTaskResponsibility } from '../src/solver/modules/organization';
import { directSolverModules } from '../src/solver/modules';
import { configurableSolverModules } from '../src/solver/modules/custom';
import { runSolver } from '../src/solver/run';
import { rememberSolverFailure, solverProofFeedback } from '../src/solver/feedback';
import { createMathRetrievalCorpus } from '../src/math/mathRetrievalCorpus';
import * as retrievalCorpus from '../src/math/mathRetrievalCorpus';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { prepareDeepSeekProfile } from '../src/runtime/deepseek';
import { prepareWestlakeProfile } from '../src/runtime/westlake';
import { prepareSub2apiProfile } from '../src/runtime/sub2api';
import { readCooperationPlan } from '../src/solver/cooperationShared';
import { parseCooperationPlan, taskVersion, assignmentDeliveryFile, type CooperativeAction, type CooperativeTask, type RouteGroup } from '../src/solver/tasks';
import { leadWakePending } from '../src/solver/leadWakes';
import { canonicalMathJson } from '../src/math/mathRuntimeIo';
import { deliveryDetails, readDeliveryLines, readMathResponse } from '../src/solver/deliveries';
import { assertStatementSnapshot, captureStatementContexts, isStatementAction, readBacktranslation, statementSnapshot, writeStatementSnapshot } from '../src/solver/statementReview';
import { parseLeanStatementContexts } from '../src/math/leanStatementContext';
import { captureProofReferences, proofReferencesUnchanged } from '../src/solver/proofReferences';
import { applyTaskChanges, checkTaskProof, checkTaskProofs, createTaskSourceProjector, taskChanges } from '../src/solver/cooperativeProof';
import { conditionalExpectedType } from '../src/solver/conditionalProjection';
import { readContinuationPage, readContinuationSnapshot } from '../src/solver/continuationInput';
import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations, leanDeclarationContextCommands } from '../src/math/leanSource';
import { recordRouteBlockers, refreshRouteBlockers } from '../src/solver/routeControl';
import { freshlyAccepted, type TaskRecord } from '../src/solver/tasks';
import { buildTheoremKnowledge, writeTheoremKnowledge } from '../src/solver/theoremKnowledge';
import { readKnowledgeCatalog, writePackedKnowledge } from '../src/solver/theoremKnowledgeStore';
import { buildRunInspection } from '../src/solver/inspection';
import { createTaskConnectionCheck } from '../src/solver/taskConnections';
import { deferred } from './helpers/async';
import { bootstrapLeanTask, leanTaskId } from '../src/math/leanTask';
import { writeLibraryHostFixture } from './helpers/libraryHostFixture';
import { prepareLibraryKnowledge } from '../src/solver/theoremKnowledgeLibrary';
import { planApprovalLog } from '../src/solver/planApproval';
import { workflowHarnessFixture } from './helpers/workflowHarnessFixture';

const host = vi.hoisted(() => ({ verify: vi.fn(), createSession: vi.fn(), officialGate: vi.fn(), build: vi.fn(), delay: vi.fn(),
  prepare: vi.fn(), freeze: vi.fn(), readiness: vi.fn(), connectivity: vi.fn(), explain: vi.fn(), packages: undefined as string | undefined }));
vi.mock('../src/solver/automaticExplanations', () => ({ generateSolverExplanations: host.explain }));
vi.mock('../src/math/leanDiagnostics', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/leanDiagnostics')>(), runLeanDiagnostics: host.prepare,
}));
vi.mock('../src/math/leanTypeDiagnostics', () => ({ checkLeanType: async () => {
  throw new Error('Offline solver fixture: type preflight is tested separately.');
} }));
vi.mock('node:timers/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:timers/promises')>(), setTimeout: host.delay,
}));
vi.mock('../src/math/mathBuildManifest', () => ({ readMathBuildManifest: host.build }));
vi.mock('../src/math/leanToolchainReadiness', () => ({ checkResolvedLeanToolchainReadiness: host.readiness }));
vi.mock('../src/runtime/codexConnectivity', () => ({ checkCodexProviderConnectivity: host.connectivity }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, resolveMathematicsLakePackagesCache: () => host.packages,
  formalVerificationToolIdentity: () => 'fixture-lean-tools',
}));
vi.mock('../src/math/mathProofEnvironment', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathProofEnvironment')>(),
  prepareMathProofEnvironment: host.freeze,
}));
vi.mock('../src/math/leanEvalBootstrap', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/leanEvalBootstrap')>(), runPersistedLeanEvalOfficialGate: host.officialGate,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));

function verified(request: MathematicsVerifierBatchRequest): MathematicsVerifierBatchResult {
  return { schema: 'deepscientist.mathematics.verification-batch/v1', status: 'kernel_verified',
    targetCommit: request.targetCommit!, sessionId: 'host', events: [], startedAt: 1, checkedAt: 2, durationMs: 1,
    results: request.items.map((item, index) => ({ ...item, sourceDeclarationHash: item.expectedSourceDeclarationHash,
      checkId: item.id?.trim() || `check-${index + 1}`, sessionId: 'host', checkedAt: 2,
      receiptId: `fixture-${request.targetCommit}-${item.theoremName}`,
      targetCommit: request.targetCommit, status: 'kernel_verified', claim: 'statement' })) as MathematicsVerifierBatchResult['results'] };
}

/** Marks the batch and every result as failed; `fields` adds result fields such as an error preview. */
function failed(batch: MathematicsVerifierBatchResult, fields: Partial<MathematicsVerifierBatchResult['results'][number]> = {}): MathematicsVerifierBatchResult {
  return { ...batch, status: 'failed', results: batch.results.map(result => ({ ...result, status: 'failed', ...fields })) };
}

const unsolved = 'Submission.lean:4:1: error: unsolved goals\n⊢ True';
const requestReceipt = (runId: string, totalTokens?: number) => ({ requestId: expect.any(String), runId,
  sessionId: expect.any(String), startedAt: expect.any(Number), settledAt: expect.any(Number), outcome: 'unknown',
  ...(totalTokens === undefined ? { status: 'missing', missingReason: 'provider-usage-missing' } : {
    status: 'reported', usage: { totalTokens, inputTokens: totalTokens - 10, outputTokens: 10 } }) });

/** A model session stub whose turns run `turn`; `fields` adds session fields such as lastError. */
function session(thread: string | ((options: MathAgentOptions) => string),
  turn: (options: MathAgentOptions, message: string) => Promise<string>, fields: Partial<MathAgentSession> = {}) {
  return async (options: MathAgentOptions): Promise<MathAgentSession> => ({ threadId: typeof thread === 'string' ? thread : thread(options),
    ...fields, run: message => turn(options, message), close: vi.fn(), interrupt: vi.fn() });
}

/** Exact lemma proposals in current research deliveries that the plan has not adopted. */
function unadoptedProposals(archive: { tasks: readonly TaskRecord[]; deliveries?: readonly any[] }): CooperativeTask[] {
  return (archive.deliveries ?? []).filter(delivery => delivery.kind === 'research' && delivery.status !== 'superseded')
    .flatMap(delivery => delivery.lemmaRequests ?? [])
    .filter((task: CooperativeTask) => !archive.tasks.some(node => node.task.id === task.id));
}

function commitFixture(worktree: string, message: string, ...flags: string[]) {
  git(worktree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', ...flags, '--no-gpg-sign', '--quiet', '-m', message]);
}

describe('isolated solver and host acceptance', () => {
  let directory: string;
  let workspace: string;
  let project: string;
  let problem: SolverProblem;
  let output: string;
  let args: string[];
  const original = 'namespace Submission\ndef fixed : Nat := 2\ntheorem first : True := by sorry\ntheorem second : True := by sorry\nend Submission\n';
  beforeEach(() => {
    vi.clearAllMocks();
    host.explain.mockReset().mockResolvedValue({ status: 'approved', targets: [] });
    host.packages = undefined;
    host.prepare.mockReset().mockImplementation(async input => {
      for (const file of input.files) if (/^StatementContext[0-9a-f]+\.lean$/u.test(file)) {
        const source = fs.readFileSync(path.join(input.projectRoot, file), 'utf8');
        const reports = [...source.matchAll(/\("id", Lean.toJson "([^"]+)"\)/gu)].map(match =>
          ({ id: match[1], context: { type: 'True', constants: [], omitted: [] } }));
        fs.mkdirSync(path.join(input.projectRoot, '.lake'), { recursive: true });
        fs.writeFileSync(path.join(input.projectRoot, '.lake', file.replace('StatementContext', 'statement-context-').replace('.lean', '.json')), JSON.stringify(reports));
      }
      return { exitCode: 0, timedOut: false, phases: [] };
    });
    host.readiness.mockReset().mockReturnValue({ status: 'ready' });
    host.connectivity.mockReset().mockResolvedValue({ status: 'reachable', httpStatus: 401 });
    host.freeze.mockReset().mockResolvedValue({ environmentValue: 'fixture', dispose: vi.fn() });
    host.delay.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'math-solver-test-')));
    // Offline verifier fixtures must not inherit the developer's math.env or toolchain.
    vi.stubEnv('DEEPSCIENTIST_MATH_ENV_FILE', path.join(directory, 'math.env'));
    vi.stubEnv('DEEPSCIENTIST_MATH_PANTOGRAPH_MANIFEST', undefined);
    vi.stubEnv('DEEPSCIENTIST_MATH_PANTOGRAPH_SHA256', undefined);
    workspace = path.join(directory, 'public'); project = path.join(workspace, 'generated', 'p');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(`${workspace}.source`);
    fs.writeFileSync(path.join(project, 'Submission.lean'), original);
    fs.writeFileSync(path.join(project, 'Challenge.lean'), original);
    fs.writeFileSync(path.join(project, 'lean-toolchain'), 'leanprover/lean4:v4.31.0');
    fs.writeFileSync(path.join(project, 'lakefile.toml'), 'name = "proof"\n');
    const payload = canonicalMathProblemStatementPayloads({ informalStatement: 'Prove both claims', formalStatement: original, assumptions: [] });
    const contract: MathProblemContract = { problemId: 'p', informalStatement: 'Prove both claims', formalStatement: original,
      assumptions: [], knownTraps: [], acceptanceCriteria: ['Both original targets'], officialVerificationCommand: 'lake test',
      statementHash: mathDigest(payload.informal), leanStatementHash: mathDigest(payload.lean) };
    const receipt = { schema: 'deepscientist.mathematics.lean-eval-bootstrap-receipt.v1', receiptId: 'fixture', problemId: 'p',
      benchmarkCommit: LEAN_EVAL_BENCHMARK_COMMIT, catalogHash: 'a'.repeat(64), leaderboardSource: 'disabled',
      contract, workspaceRoot: workspace, projectRoot: project, sourceProjectRoot: `${workspace}.source`,
      activeProblemPath: path.join(workspace, 'active-problem.json'), createdAt: 1,
      trustedFiles: ['Challenge.lean', 'lean-toolchain', 'lakefile.toml'], solverOwnedFiles: ['Submission.lean'],
      publicObligations: ['Submission.first', 'Submission.second'].map(name => ({ name,
        declarationHash: hashMathFormalSourceDeclaration(original, name) })) };
    fs.writeFileSync(receipt.activeProblemPath, JSON.stringify(receipt));
    git(workspace, ['init', '--quiet']);
    git(workspace, ['add', 'generated']);
    commitFixture(workspace, 'Public baseline');
    fs.appendFileSync(path.join(workspace, '.git', 'info', 'exclude'), '\n/active-problem.json\n**/.lake/\n');
    problem = readSolverProblem(workspace, receipt.activeProblemPath);
    output = path.join(directory, 'run.json');
    const task = path.join(directory, 'task.md'); const build = path.join(directory, 'build.json');
    fs.writeFileSync(task, 'Prove the original targets'); fs.writeFileSync(build, '{}');
    args = ['--workspace', workspace, '--task-file', task, '--build-manifest', build, '--output', output, '--max-turns', '1', '--workers', '1'];
    host.verify.mockImplementation(async request => verified(request));
    host.officialGate.mockResolvedValue({ comparison: { status: 'official_verified' } });
    host.createSession.mockImplementation(session(options => options.threadId || 'fixture-thread', async options => {
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
      return 'completed';
    }));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });

  function configureDefinitionGoal() {
    const source = original.replace('theorem first', 'noncomputable def C : Nat := by sorry\ntheorem first');
    const receipt = JSON.parse(fs.readFileSync(problem.activeProblemPath, 'utf8'));
    const payload = canonicalMathProblemStatementPayloads({ ...receipt.contract, formalStatement: source });
    receipt.contract = { ...receipt.contract, formalStatement: source,
      statementHash: mathDigest(payload.informal), leanStatementHash: mathDigest(payload.lean) };
    receipt.publicObligations.unshift({ name: 'Submission.C', declarationHash: hashMathFormalSourceDeclaration(source, 'Submission.C') });
    fs.writeFileSync(problem.activeProblemPath, JSON.stringify(receipt));
    for (const file of ['Submission.lean', 'Challenge.lean']) fs.writeFileSync(path.join(project, file), source);
    git(workspace, ['add', '--', 'generated']);
    commitFixture(workspace, 'Original definition goal');
    problem = readSolverProblem(workspace, problem.activeProblemPath);
    const task: CooperativeTask = { id: 'constant', kind: 'goal', objective: 'Fill the original definition', dependsOn: [], revision: 0,
      proofPath: 'Submission.lean', theoremName: 'Submission.C' };
    return { source, task };
  }

  it.each([undefined, 'max'] as const)('defaults new proof effort to high and preserves explicit %s', async effort => {
    expect(await runSolver([...args, ...(effort ? ['--effort', effort] : [])], directory)).toBe(0);
    expect(readSolverRunState(`${output}.runtime/state.json`).effort).toBe(effort ?? 'high');
    expect(host.createSession).toHaveBeenCalled();
    for (const [options] of host.createSession.mock.calls) expect(options.effort).toBe(effort ?? 'high');
  });

  it('automatically starts explanations after independent acceptance and persists live progress', async () => {
    host.explain.mockImplementationOnce(async input => {
      expect(JSON.parse(fs.readFileSync(output, 'utf8')).status).toBe('evaluated_passed');
      const summary = { status: 'approved', language: input.language, directory: input.directory,
        targets: input.problem.targets.map(target => ({ target: target.theoremName, status: 'approved',
          proof: path.join(input.directory, 'explanations', target.theoremName, 'artifact/proof.md') })) };
      input.onUpdate(summary);
      return summary;
    });
    expect(await runSolver([...args, '--explanation-language', 'en'], directory)).toBe(0);
    expect(host.explain).toHaveBeenCalledOnce();
    expect(host.explain.mock.calls[0][0]).toMatchObject({ language: 'en', writer: { effort: 'high' },
      problem: { targets: [{ theoremName: 'Submission.first' }, { theoremName: 'Submission.second' }] } });
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'evaluated_passed',
      explanations: { status: 'approved', language: 'en', targets: [{ status: 'approved' }, { status: 'approved' }] } });
  });

  it.each(['codex', 'claude-code', 'opencode', 'cli'] as const)(
    'keeps the selected %s binding for automatic explanations and accepted-run resume', async id => {
      let flags: string[];
      if (id === 'codex') {
        const profile = path.join(directory, 'codex-profile'); fs.mkdirSync(profile);
        fs.writeFileSync(path.join(profile, 'config.toml'), 'model="fixture"\n');
        const executable = path.join(directory, 'codex');
        fs.symlinkSync('/usr/bin/true', executable);
        flags = ['--harness', id, '--harness-profile', profile, '--harness-executable', executable, '--model', 'fixture'];
      } else flags = workflowHarnessFixture(directory, id).flags;
      const modules = { ...directSolverModules, M1: { ...directSolverModules.M1,
        open: async (options: MathAgentOptions) => host.createSession(options) } };
      const selected = [...args, ...flags, '--research-mode', 'legacy'];
      expect(await runSolver(selected, directory, modules)).toBe(0);
      const binding = readSolverRunState(`${output}.runtime/state.json`).agentHarness!;
      expect(binding.id).toBe(id);
      expect(host.explain).toHaveBeenCalledOnce();
      expect(host.explain.mock.calls[0][0].writer).toMatchObject({
        model: id === 'opencode' ? 'fixture/model' : 'fixture', effort: 'high',
        profile: binding.profile, executable: binding.executable, agentHarness: binding,
      });
      host.createSession.mockClear(); host.explain.mockClear();
      expect(await runSolver([...selected, '--resume'], directory, modules)).toBe(0);
      expect(host.createSession).not.toHaveBeenCalled();
      expect(host.explain.mock.calls[0][0].writer).toMatchObject({
        profile: binding.profile, executable: binding.executable, agentHarness: binding,
      });
    });

  it('keeps proof acceptance when explanation generation fails and resumes only explanation work', async () => {
    host.explain.mockRejectedValueOnce(new Error('provider fixture failure'));
    expect(await runSolver(args, directory)).toBe(0);
    const accepted = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(accepted).toMatchObject({ status: 'evaluated_passed', evaluator: { status: 'passed' }, explanations: { status: 'error' } });
    host.createSession.mockClear(); host.explain.mockClear();
    expect(await runSolver([...args, '--resume'], directory)).toBe(0);
    expect(host.createSession).not.toHaveBeenCalled();
    expect(host.explain).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).solution_commit).toBe(accepted.solution_commit);
  });

  it('allows accepted CLI runs to opt out of explanation model calls', async () => {
    expect(await runSolver([...args, '--no-explanations'], directory)).toBe(0);
    expect(host.explain).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'evaluated_passed', explanations: { status: 'disabled' } });
  });

  it('does not generate explanations for failed acceptance', async () => {
    host.officialGate.mockResolvedValue({ comparison: { status: 'failed' } });
    expect(await runSolver(args, directory)).toBe(2);
    expect(host.explain).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).not.toHaveProperty('explanations');
  });

  it.each([{ flags: [] }, { flags: ['--effort', 'max'] }, { flags: ['--effort=max'] }])('resumes frozen max effort with matching or omitted flags $flags', async ({ flags }) => {
    expect(await runSolver([...args, '--effort', 'max', '--startup-only'], directory)).toBe(0);
    const prepared = readSolverRunState(`${output}.runtime/state.json`);
    expect(prepared.effort).toBe('max'); expect(host.createSession).not.toHaveBeenCalled();
    expect(await runSolver([...args, '--resume', ...flags], directory)).toBe(0);
    expect(readSolverRunState(`${output}.runtime/state.json`)).toMatchObject({ runId: prepared.runId, effort: 'max' });
    expect(host.createSession).toHaveBeenCalled();
    for (const [options] of host.createSession.mock.calls) expect(options.effort).toBe('max');
    const stateBytes = fs.readFileSync(`${output}.runtime/state.json`), resultBytes = fs.readFileSync(output);
    host.createSession.mockClear();
    expect(await runSolver([...args, '--resume', '--effort=high'], directory)).toBe(1);
    expect(fs.readFileSync(`${output}.runtime/state.json`)).toEqual(stateBytes);
    expect(fs.readFileSync(output)).toEqual(resultBytes);
    expect(host.createSession).not.toHaveBeenCalled();
  });

  it('runs a custom M1 without the Codex route while retaining proof checks and independent acceptance', async () => {
    host.connectivity.mockResolvedValue({ status: 'unavailable' });
    const modules = { ...directSolverModules, id: 'custom-execution', M1: { ...directSolverModules.M1,
      version: 'custom-execution-v1', open: (options: MathAgentOptions) => host.createSession(options) } };
    expect(await runSolver(args, directory, modules)).toBe(0);
    expect(host.connectivity).not.toHaveBeenCalled();
    expect(host.verify.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(host.officialGate).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).status).toBe('evaluated_passed');
  });

  it('loads a CLI module plan, retains independent acceptance and rejects changed policies on resume', async () => {
    const plan = { scheduler: 'plan' as const, context: 'essential' as const, custom: [] };
    const file = path.join(directory, 'module-plan.json'); fs.writeFileSync(file, JSON.stringify(plan));
    expect(await runSolver([...args, '--module-plan', file], directory)).toBe(0);
    const state = JSON.parse(fs.readFileSync(output + '.runtime/state.json', 'utf8'));
    const modules = configurableSolverModules(plan, 'cooperative', 1);
    expect(state.moduleConfiguration.versions.M4).toBe(modules.M4.version);
    expect(state.moduleConfiguration.versions.M2).toBe(directSolverModules.M2.version);
    expect(host.verify.mock.calls.length).toBeGreaterThanOrEqual(2);
    const completed = fs.readFileSync(output, 'utf8');
    fs.writeFileSync(file, JSON.stringify({ ...plan, context: 'full' }));
    expect(await runSolver([...args, '--module-plan', file, '--resume'], directory)).toBe(1);
    expect(fs.readFileSync(output, 'utf8')).toBe(completed);
  });

  it.each([
    ['DeepSeek', prepareDeepSeekProfile, 'deepseek-v4-pro', 'https://api.deepseek.com'],
    ['Westlake', prepareWestlakeProfile, 'deepseek-flash', 'https://hpc-api.westlake.edu.cn/v1'],
    ['Sub2API', prepareSub2apiProfile, 'deepseek-flash', 'http://127.0.0.1:8080/v1'],
  ] as const)('binds %s provider configuration to saved runs and rejects profile changes on resume', async (name, prepare, model, endpoint) => {
    const profile = path.join(directory, name.toLowerCase());
    const digest = prepare(profile, model, 'high');
    vi.stubEnv('CODEX_HOME', profile);
    const providerArgs = [...args, '--model', model, '--effort', 'high'];
    expect(await runSolver(providerArgs, directory)).toBe(0);
    const state = JSON.parse(fs.readFileSync(output + '.runtime/state.json', 'utf8'));
    expect(state).toMatchObject({ providerProfile: profile, providerProfileDigest: digest });
    if (name === 'Sub2API') expect(state.tokenBudget.enforcement).toBe('provider-observed-dispatch-limit');
    expect(host.createSession.mock.calls[0][0]).toMatchObject({ profile, model, effort: 'high' });
    expect(await runSolver([...providerArgs, '--resume'], directory)).toBe(0);
    const completed = fs.readFileSync(output, 'utf8');
    const calls = host.createSession.mock.calls.length;
    const replacement = path.join(directory, 'other-profile');
    prepare(replacement, model, 'high');
    vi.stubEnv('CODEX_HOME', replacement);
    expect(await runSolver([...providerArgs, '--resume'], directory)).toBe(1);
    expect(fs.readFileSync(output, 'utf8')).toBe(completed);
    expect(host.createSession).toHaveBeenCalledTimes(calls);
    vi.stubEnv('CODEX_HOME', profile);
    const config = path.join(profile, 'config.toml');
    fs.chmodSync(config, 0o600);
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(endpoint, 'https://changed-provider.invalid'));
    expect(await runSolver([...providerArgs, '--resume'], directory)).toBe(1);
    expect(fs.readFileSync(output, 'utf8')).toBe(completed);
    expect(host.createSession).toHaveBeenCalledTimes(calls);
  });

  function continuationFixture(text = 'Historical route; its proof has not been replayed.') {
    const source = path.join(directory, 'previous-notes.txt');
    const file = path.join(directory, 'continuation-input.json');
    fs.writeFileSync(source, text);
    const sha256 = mathDigest(text);
    fs.writeFileSync(file, JSON.stringify({ schema: 'theorem-os.continuation-input.v1',
      taskDigest: mathDigest(fs.readFileSync(args[args.indexOf('--task-file') + 1])), problemReceiptDigest: problem.receiptDigest,
      attachments: ['previous', 'same-content'].map(id => ({ id, kind: 'research-notes', path: source,
        bytes: Buffer.byteLength(text), sha256 })) }));
    return { file, source, text, sha256 };
  }

  it('resumes from frozen attachments after the original input files are removed', async () => {
    const fixture = continuationFixture();
    expect(await runSolver([...args, '--startup-only', '--continuation-manifest', fixture.file], directory)).toBe(0);
    const before = readSolverRunState(`${output}.runtime/state.json`).continuationDigest;
    fs.rmSync(fixture.source); fs.rmSync(fixture.file);
    expect(await runSolver([...args, '--startup-only', '--resume'], directory)).toBe(0);
    expect(readSolverRunState(`${output}.runtime/state.json`).continuationDigest).toBe(before);
    expect(host.createSession).not.toHaveBeenCalled();
  });

  it('delivers the mandatory frozen attachment index to a resumed model turn after original inputs are removed', async () => {
    const fixture = continuationFixture();
    expect(await runSolver([...args, '--startup-only', '--continuation-manifest', fixture.file], directory)).toBe(0);
    const before = readSolverRunState(`${output}.runtime/state.json`);
    fs.rmSync(fixture.source); fs.rmSync(fixture.file);
    let received = false;
    host.createSession.mockImplementation(session('continuation-resume', async (options, message) => {
      const current = readSolverRunState(`${output}.runtime/state.json`);
      const section = current.lastContextManifest!.included.find(item => item.id === `continuation-input:${before.continuationDigest}`);
      expect(section).toMatchObject({ kind: 'continuation', required: true });
      expect(message).toContain('continuation read --snapshot');
      expect(message).toContain(before.continuationDigest);
      expect(message).not.toContain(fixture.text);
      const snapshot = path.join(options.workspace, problem.projectRelative, '.lake/continuation.json');
      expect(message).toContain(snapshot);
      expect(readContinuationPage(snapshot, before.continuationDigest!, 'previous').text).toBe(fixture.text);
      fs.writeFileSync(path.join(options.workspace, problem.projectRelative, 'Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
      received = true;
      return 'completed';
    }));
    expect(await runSolver([...args, '--resume'], directory)).toBe(0);
    expect(received).toBe(true);
    expect(host.createSession).toHaveBeenCalledOnce();
    expect(readSolverRunState(`${output}.runtime/state.json`).continuationDigest).toBe(before.continuationDigest);
  });

  it.each([
    { target: 'manifest', change: 'missing' }, { target: 'body', change: 'missing' },
    { target: 'manifest', change: 'corrupted' }, { target: 'body', change: 'corrupted' },
  ] as const)('rebuilds a missing worker attachment but rejects a corrupted copy ($target, $change)', async ({ target, change }) => {
    const fixture = continuationFixture();
    expect(await runSolver([...args, '--startup-only', '--continuation-manifest', fixture.file], directory)).toBe(0);
    const before = readSolverRunState(`${output}.runtime/state.json`);
    const snapshot = path.join(before.worktree, problem.projectRelative, '.lake/continuation.json');
    const changed = target === 'manifest' ? snapshot : path.join(path.dirname(snapshot), 'continuation', `${fixture.sha256}.txt`);
    fs.rmSync(fixture.source); fs.rmSync(fixture.file);
    if (change === 'missing') fs.rmSync(changed);
    else {
      const bytes = fs.readFileSync(changed); bytes[bytes.length - 1] ^= 1;
      fs.chmodSync(changed, 0o600); fs.writeFileSync(changed, bytes); fs.chmodSync(changed, 0o400);
    }
    expect(await runSolver([...args, '--resume'], directory)).toBe(change === 'missing' ? 0 : 1);
    if (change === 'missing') {
      expect(host.createSession).toHaveBeenCalledOnce();
      expect(readContinuationPage(snapshot, before.continuationDigest!, 'previous').text).toBe(fixture.text);
      expect(fs.statSync(changed).mode & 0o777).toBe(0o400);
    } else {
      expect(host.createSession).not.toHaveBeenCalled();
      expect(readSolverRunState(`${output}.runtime/state.json`)).toMatchObject({
        continuationDigest: before.continuationDigest, turns: 0, error: 'math_continuation_frozen_file_changed',
      });
    }
    expect(readContinuationPage(path.join(`${output}.runtime`, 'continuation.json'), before.continuationDigest!, 'previous').text)
      .toBe(fixture.text);
  });

  it.each(['manifest', 'snapshot', 'body', 'missing'] as const)
  ('checks attached %s identity before a completed run can return early', async changed => {
    const fixture = continuationFixture();
    expect(await runSolver([...args, '--continuation-manifest', fixture.file], directory)).toBe(0);
    const completed = fs.readFileSync(output, 'utf8'), calls = host.createSession.mock.calls.length;
    const stateBefore = fs.readFileSync(`${output}.runtime/state.json`, 'utf8');
    const snapshot = path.join(`${output}.runtime`, 'continuation.json');
    const body = path.join(`${output}.runtime`, 'continuation', `${fixture.sha256}.txt`);
    let resume = [...args, '--resume'];
    if (changed === 'manifest') resume.push('--continuation-manifest', continuationFixture('Replaced historical route.').file);
    else if (changed === 'missing') fs.rmSync(body);
    else {
      const target = changed === 'snapshot' ? snapshot : body;
      fs.chmodSync(target, 0o600); fs.writeFileSync(target, 'Replaced frozen content.');
    }
    expect(await runSolver(resume, directory)).toBe(1);
    expect(fs.readFileSync(output, 'utf8')).toBe(completed);
    expect(fs.readFileSync(`${output}.runtime/state.json`, 'utf8')).toBe(stateBefore);
    expect(host.createSession).toHaveBeenCalledTimes(calls);
  });

  it('rejects adding attachments to an existing unattached run before its completed-result shortcut', async () => {
    expect(await runSolver(args, directory)).toBe(0);
    const completed = fs.readFileSync(output, 'utf8'), calls = host.createSession.mock.calls.length;
    const fixture = continuationFixture();
    expect(await runSolver([...args, '--resume', '--continuation-manifest', fixture.file], directory)).toBe(1);
    expect(fs.readFileSync(output, 'utf8')).toBe(completed);
    expect(host.createSession).toHaveBeenCalledTimes(calls);
    expect(fs.existsSync(path.join(`${output}.runtime`, 'continuation.json'))).toBe(false);
  });

  function knowledgeFixture(filename = 'knowledge.json', type = 'True', format: 'v1' | 'v2' = 'v1') {
    const write = format === 'v1' ? writeTheoremKnowledge : writePackedKnowledge;
    return write(path.join(directory, filename), buildTheoremKnowledge([{
      name: 'Saved.helper', file: 'Submission.lean', type, typeKind: 'closed-task-type', kind: 'lemma',
      description: 'Historical helper', premises: [],
      dependencies: { statement: [], proof: [], tasks: [], coverage: 'unavailable' },
      files: { 'Submission.lean': `namespace Saved\nlemma helper : ${type} := by trivial\nend Saved\n` },
      provenance: { kind: 'solver-check', problemId: 'previous-problem', source: '/archive/state.json',
        sourceDigest: 'a'.repeat(64), receiptIds: ['historical-receipt'] },
    }]));
  }

  function hostedKnowledgeFixture() {
    const source = 'import Mathlib\ntheorem hosted_goal : True := by sorry\n';
    const hostFixture = writeLibraryHostFixture(path.join(directory, 'host'), [
      { taskId: leanTaskId(source), selection: { mode: 'mapped', exclusionKeys: ['FixtureTask'] } }]);
    vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', hostFixture.configPath);
    const hostedWorkspace = path.join(directory, 'hosted-task');
    const receipt = bootstrapLeanTask(hostedWorkspace, { source, task: 'prove', environment: 'openai-math' });
    host.packages = path.join(directory, 'hosted-packages'); fs.mkdirSync(host.packages);
    const catalog = prepareLibraryKnowledge(hostedWorkspace, path.join(directory, 'authorized.json'));
    if (!catalog.enabled) throw new Error('expected catalog');
    return { ...hostFixture, receipt, catalog, hostedArgs: args.map(value => value === workspace ? hostedWorkspace : value) };
  }

  it('rejects a full release catalog before reading it or admitting a hosted provider', async () => {
    const f = hostedKnowledgeFixture();
    expect(await runSolver([...f.hostedArgs, '--library-catalog', '/missing',
      '--library-catalog-sha256', 'a'.repeat(64)], directory)).toBe(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('library_knowledge_catalog_unauthorized'));
    expect(host.connectivity).not.toHaveBeenCalled();
    expect(host.createSession).not.toHaveBeenCalled();
  });
  it('rechecks host policy after preparation without a historical knowledge catalog', async () => {
    const f = hostedKnowledgeFixture();
    const applyLibrary = vi.spyOn(directSolverModules.M2, 'applyLibrary');
    host.connectivity.mockImplementation(async () => {
      fs.appendFileSync(f.configPath, ' '); return { status: 'reachable', httpStatus: 401 };
    });
    expect(await runSolver(f.hostedArgs, directory)).toBe(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'runtime_error', reason: 'library_host_binding_changed' });
    expect(applyLibrary).not.toHaveBeenCalled();
    expect(host.createSession).not.toHaveBeenCalled();
  });
  it('rechecks installed-only host policy between model turns', async () => {
    const f = hostedKnowledgeFixture();
    vi.spyOn(directSolverModules.M2, 'applyLibrary').mockResolvedValue({ status: 'skipped', reason: 'fixture-policy-check', candidates: [] });
    host.verify.mockImplementation(async request => failed(verified(request)));
    const turn = vi.fn(async () => {
      fs.appendFileSync(f.configPath, ' ');
      return 'completed';
    });
    host.createSession.mockImplementation(session('hosted-policy-drift', turn));
    expect(await runSolver([...f.hostedArgs, '--max-turns', '2'], directory)).toBe(1);
    expect(turn).toHaveBeenCalledOnce();
    expect(host.createSession).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('library_host_binding_changed'));
    expect(readSolverRunState(output + '.runtime/state.json').knowledgeDigest).toBeUndefined();
    expect(host.officialGate).not.toHaveBeenCalled();
  });
  it('rejects host policy changes during preparation before copying knowledge to a worker', async () => {
    const f = hostedKnowledgeFixture();
    host.connectivity.mockImplementation(async () => {
      fs.appendFileSync(f.configPath, ' '); return { status: 'reachable', httpStatus: 401 };
    });
    expect(await runSolver([...f.hostedArgs, '--startup-only', '--knowledge-base', f.catalog.file], directory)).toBe(1);
    expect(host.createSession).not.toHaveBeenCalled();
    const state = readSolverRunState(output + '.runtime/state.json');
    expect(fs.existsSync(path.join(state.worktree, state.problem.projectRelative, '.lake/theorem-knowledge.json'))).toBe(false);
  });
  it('rejects a saved hosted continuation on resume even when no attachment flag is supplied', async () => {
    const f = hostedKnowledgeFixture(), hostedArgs = [...f.hostedArgs, '--startup-only', '--knowledge-base', f.catalog.file];
    expect(await runSolver(hostedArgs, directory)).toBe(0);
    const stateFile = output + '.runtime/state.json', state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.continuationDigest = 'a'.repeat(64); fs.writeFileSync(stateFile, JSON.stringify(state));
    expect(await runSolver([...hostedArgs, '--resume'], directory)).toBe(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('library_knowledge_history_unauthorized'));
    expect(host.createSession).not.toHaveBeenCalled();
  });

  it('offers pinned knowledge commands to the solver while retaining independent proof acceptance', async () => {
    const catalog = knowledgeFixture();
    const entry = readKnowledgeCatalog(catalog.file).base.entries[0]!;
    const declaration = { name: 'Submission.saved_bridge', file: 'Submission.lean' };
    const claim = { id: entry.id, catalogDigest: catalog.sha256, declaration };
    const messages: string[] = [];
    host.verify.mockImplementation(async (request: MathematicsVerifierBatchRequest) => {
      const result = verified(request);
      return { ...result, results: result.results.map(item => ({ ...item, declarationReferences: { statement: [],
        proof: item.theoremName === 'Submission.first' ? [declaration] : [] } })) };
    });
    host.createSession.mockImplementation(session('knowledge-fixture', async (options, message) => {
      messages.push(message);
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original
        .replace('theorem first', 'lemma saved_bridge : True := by trivial\ntheorem first')
        .replace('first : True := by sorry', 'first : True := by exact saved_bridge')
        .replace('second : True := by sorry', 'second : True := by trivial'));
      fs.writeFileSync(path.join(options.workspace, 'RESEARCH.md'), JSON.stringify({
        summary: 'Adapt the saved bridge for the first original target; prove the second directly.',
        knowledgeUses: [claim, { ...claim, catalogDigest: mathDigest('forged-catalog') }],
      }));
      return 'completed';
    }));
    expect(await runSolver([...args, '--knowledge-base', catalog.file], directory)).toBe(0);
    const options = host.createSession.mock.calls[0]![0] as MathAgentOptions;
    expect(options.instructions).toContain('knowledge search --catalog');
    expect(options.instructions).toContain(catalog.sha256);
    expect(options.instructions).toContain('historical receipts');
    expect(options.instructions).toContain('knowledge dependencies --catalog');
    expect(options.instructions).toContain('knowledge consumers --catalog');
    expect(options.instructions).toContain('not instantiated applications');
    expect(options.instructions).toContain('knowledge source --catalog');
    expect(options.instructions).toContain('--offset NEXT_OFFSET');
    expect(options.instructions).toContain('--environment');
    expect(options.instructions).toContain('--problem-receipt');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('theorem-os.knowledge-context.v1');
    expect(messages[0]).toContain('Saved.helper');
    expect(messages[0]).toContain('Submission.first');
    expect(messages[0]).toContain('Submission.second');
    expect(messages[0]).not.toContain('by trivial');
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).status).toBe('evaluated_passed');
    const recorded = readSolverRunState(`${output}.runtime/state.json`);
    expect(recorded.knowledgeRetrievals?.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ catalogDigest: catalog.sha256, included: true, candidateIds: expect.any(Array),
        contextDigest: expect.any(String) }),
    ]));
    expect(recorded.knowledgeUses).toEqual([
      { ...claim, source: 'catalog', consumer: { taskId: 'original_goal_1', taskDigest: expect.any(String) },
        status: 'checked-reference', attribution: 'model-reported-origin', catalogDeclarationMatch: false, workerId: 'solver',
        commit: recorded.check!.commit, checkedCommit: recorded.check!.commit, checkedSourceDigest: recorded.check!.sourceDigest },
      { ...claim, source: 'catalog', consumer: { taskId: 'original_goal_2', taskDigest: expect.any(String) },
        status: 'reported-attempt', attribution: 'model-reported-origin', catalogDeclarationMatch: false, workerId: 'solver', commit: recorded.check!.commit },
    ]);
    expect(vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(line)).filter(item => item.event === 'knowledge_use_rejected'))
      .toEqual([expect.objectContaining({ commit: recorded.check!.commit, rejected: 1 }),
        expect.objectContaining({ commit: recorded.check!.commit, rejected: 1 })]);
    expect(buildRunInspection(recorded).knowledge).toMatchObject({ status: 'enabled', retrievalCoverage: 'recorded' });
    expect(host.verify.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(host.officialGate).toHaveBeenCalledOnce();
  });

  it('rejects damaged packed worker source objects on resume before model dispatch', async () => {
    const catalog = knowledgeFixture('knowledge.json', 'True', 'v2');
    expect(await runSolver([...args, '--startup-only', '--knowledge-base', catalog.file], directory)).toBe(0);
    const state = JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8'));
    const snapshot = path.join(state.worktree, 'generated/p/.lake/theorem-knowledge.json');
    const manifest = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
    const blob = path.join(path.dirname(snapshot), manifest.objectsDirectory, Object.keys(manifest.sources)[0]!);
    fs.chmodSync(blob, 0o600);
    fs.writeFileSync(blob, fs.readFileSync(blob, 'utf8').replace('True', 'Fals'));
    fs.chmodSync(blob, 0o400);
    expect(await runSolver([...args, '--startup-only', '--resume', '--knowledge-base', catalog.file], directory)).toBe(1);
    expect(host.createSession).not.toHaveBeenCalled();
  });

  it.each(['omitted', 'replaced'])('rejects a %s knowledge snapshot on resume before model dispatch', async change => {
    const first = knowledgeFixture(), replacement = knowledgeFixture('replacement.json', 'True /\\ True');
    expect(await runSolver([...args, '--startup-only', '--knowledge-base', first.file], directory)).toBe(0);
    expect(await runSolver([...args, '--startup-only', '--resume',
      ...(change === 'replaced' ? ['--knowledge-base', replacement.file] : [])], directory)).toBe(1);
    expect(host.createSession).not.toHaveBeenCalled();
  });

  it('stops new model turns at the reported token allowance without cancelling final proof verification', async () => {
    host.createSession.mockImplementation(session('token-proof', async options => {
      options.onUsage({ totalTokens: 120, inputTokens: 100, outputTokens: 20 });
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
      return 'completed';
    }));
    expect(await runSolver([...args, '--max-total-tokens', '100', '--max-turns', '0', '--max-run-seconds', '0',
      '--max-turn-seconds', '0'], directory)).toBe(0);
    const result = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(result).toMatchObject({ status: 'evaluated_passed', turns: 1,
      tokenBudget: { status: 'exhausted', reportedTotalTokens: 120, overrunTokens: 20, usageComplete: true } });
    expect(result.reason).toBeUndefined();
    expect(host.officialGate).toHaveBeenCalledOnce();
    expect(host.createSession.mock.results.length).toBe(1);
    expect((await host.createSession.mock.results[0].value).interrupt).not.toHaveBeenCalled();
  });

  it.each([false, true])('gates internal requests without losing complete usage or final proof checks (solved: %s)', async solved => {
    const profile = path.join(directory, 'westlake-request-budget');
    prepareWestlakeProfile(profile, 'deepseek-flash', 'high');
    vi.stubEnv('CODEX_HOME', profile);
    host.verify.mockImplementation(async request => solved ? verified(request) : failed(verified(request)));
    const requests = vi.fn();
    host.createSession.mockImplementation(async (options: MathAgentOptions) => ({ threadId: 'request-budget',
      usageSource: 'upstream-requests', lastError: 'HTTP 403 Forbidden',
      lastFailureDiagnostic: { code: 'unauthorized' as const }, run: async () => {
        for (const totalTokens of [60, 50]) {
          const admission = options.requestGate!();
          expect(admission.allowed).toBe(true);
          if (admission.allowed) {
            requests();
            const receipt = { usage: { inputTokens: totalTokens - 10, outputTokens: 10, totalTokens }, complete: true };
            admission.settle(receipt); admission.settle(receipt);
          }
        }
        // A native cumulative notification may be delayed, duplicated, or include historical thread state.
        options.onUsage({ totalTokens: 10_000 });
        for (let retry = 0; retry < 3; retry++) expect(options.requestGate!()).toEqual({ allowed: false, reason: 'math_total_token_limit' });
        if (solved) fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
        return 'failed';
      }, close: vi.fn(), interrupt: vi.fn() }));
    expect(await runSolver([...args, '--max-turns', '20', '--max-total-tokens', '100', '--model', 'deepseek-flash', '--effort', 'high'], directory)).toBe(solved ? 0 : 4);
    const result = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(result).toMatchObject({ status: solved ? 'evaluated_passed' : 'limit_reached', turns: 1,
      usage: { totalTokens: 110, inputTokens: 90, outputTokens: 20 }, tokenBudget: {
        enforcement: 'provider-observed-upstream-request-limit', status: 'exhausted', reportedTotalTokens: 110, usageComplete: true } });
    const state = JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8'));
    expect(state.requestUsageAccounting).toEqual({ startedRequests: 2, reportedRequests: 2, pendingRequests: 0, incomplete: false,
      receipts: [requestReceipt(state.runId, 60), requestReceipt(state.runId, 50)] });
    expect(new Set(state.requestUsageAccounting.receipts.map((receipt: any) => receipt.requestId)).size).toBe(2);
    expect(new Set(state.requestUsageAccounting.receipts.map((receipt: any) => receipt.sessionId)).size).toBe(1);
    expect(state.lastFailure?.reason).toBe(solved ? undefined : 'math_total_token_limit');
    expect(state.usageAccounting).toMatchObject({ startedTurns: 1, reportedTurns: 1, pending: false, incomplete: false });
    expect(requests).toHaveBeenCalledTimes(2); expect(host.delay).not.toHaveBeenCalled();
    expect(host.officialGate).toHaveBeenCalledTimes(Number(solved));
  });

  it('blocks internal requests immediately after a missing receipt and retains known earlier usage', async () => {
    host.verify.mockImplementation(async request => failed(verified(request)));
    host.createSession.mockImplementation(session('request-missing-usage', async options => {
      const first = options.requestGate!();
      if (first.allowed) first.settle({ usage: { totalTokens: 40, inputTokens: 30, outputTokens: 10 }, complete: true });
      const second = options.requestGate!();
      if (second.allowed) second.settle({ complete: false });
      expect(options.requestGate!()).toEqual({ allowed: false, reason: 'math_model_usage_unavailable' });
      options.onUsage({ totalTokens: 40 });
      return 'failed';
    }, { usageSource: 'upstream-requests' }));
    expect(await runSolver([...args, '--max-turns', '20', '--max-total-tokens', '100'], directory)).toBe(4);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'limit_reached', reason: 'math_model_usage_unavailable',
      usage: { totalTokens: 40 }, tokenBudget: { status: 'usage-unavailable', reportedTotalTokens: 40, usageComplete: false } });
    const state = JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8'));
    expect(state.requestUsageAccounting).toEqual({ startedRequests: 2, reportedRequests: 1, pendingRequests: 0, incomplete: true,
      receipts: [requestReceipt(state.runId, 40), requestReceipt(state.runId)] });
    expect(host.delay).not.toHaveBeenCalled();
  });

  it.each([false, true])('adds receipts after resuming a thread and preserves its historical label (legacy: %s)', async legacy => {
    const profile = path.join(directory, 'request-resume-profile');
    prepareWestlakeProfile(profile, 'deepseek-flash', 'high');
    vi.stubEnv('CODEX_HOME', profile);
    const requestArgs = [...args, '--model', 'deepseek-flash', '--effort', 'high'];
    let turns = 0;
    host.verify.mockImplementation(async request => turns < 2 ? failed(verified(request)) : verified(request));
    host.createSession.mockImplementation(session(options => options.threadId ?? 'request-resume', async options => {
      const admission = options.requestGate!();
      expect(admission.allowed).toBe(true);
      if (admission.allowed) admission.settle({ usage: { totalTokens: 40, inputTokens: 30, outputTokens: 10 }, complete: true });
      options.onUsage({ totalTokens: 40 });
      if (++turns === 2) fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
      return 'completed';
    }, { usageSource: 'upstream-requests' }));
    expect(await runSolver([...requestArgs, '--max-total-tokens', '100'], directory)).toBe(4);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).usage.totalTokens).toBe(40);
    const beforeResume = JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8'));
    if (legacy) {
      const stateFile = `${output}.runtime/state.json`, state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      delete state.requestUsageAccounting;
      state.tokenBudget.enforcement = 'provider-observed-dispatch-limit';
      fs.writeFileSync(stateFile, JSON.stringify(state));
    }
    expect(await runSolver([...requestArgs, '--resume', '--max-turns', '2'], directory)).toBe(0);
    expect(host.createSession.mock.calls[1][0].threadId).toBe('request-resume');
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ usage: { totalTokens: 80 },
      tokenBudget: { maxTotalTokens: 100, usageComplete: true, reportedTotalTokens: 80,
        enforcement: legacy ? 'provider-observed-dispatch-limit' : 'provider-observed-upstream-request-limit' } });
    const resumed = JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8'));
    expect(resumed.requestUsageAccounting)
      .toEqual({ startedRequests: legacy ? 1 : 2, reportedRequests: legacy ? 1 : 2, pendingRequests: 0, incomplete: false,
        receipts: [...legacy ? [] : beforeResume.requestUsageAccounting.receipts, requestReceipt(resumed.runId, 40)] });
    expect(new Set(resumed.requestUsageAccounting.receipts.map((receipt: any) => receipt.requestId)).size).toBe(legacy ? 1 : 2);
  });

  it('keeps request consumption additive when context rotation creates a new thread', async () => {
    let turns = 0;
    host.verify.mockImplementation(async request => turns < 2 ? failed(verified(request)) : verified(request));
    host.createSession.mockImplementation(async (options: MathAgentOptions) => {
      const first = host.createSession.mock.calls.length === 1;
      if (!first) expect(options.threadId).toBeUndefined();
      return { threadId: first ? 'request-large-context' : 'request-new-context',
        usageSource: 'upstream-requests', lastInputTokens: first ? 100_000 : 1000, run: async () => {
          const admission = options.requestGate!(); expect(admission.allowed).toBe(true);
          if (admission.allowed) admission.settle({ usage: { totalTokens: 40, inputTokens: 30, outputTokens: 10 }, complete: true });
          options.onUsage({ totalTokens: first ? 110_000 : 2000 });
          if (++turns === 2) fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
          return 'completed';
        }, close: vi.fn(), interrupt: vi.fn() };
    });
    expect(await runSolver([...args, '--max-turns', '2', '--max-total-tokens', '100'], directory)).toBe(0);
    expect(host.createSession).toHaveBeenCalledTimes(2);
    const state = JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8'));
    expect(state.previousThreadIds).toEqual(['request-large-context']);
    expect(state.usage.totalTokens).toBe(80);
    expect(state.usageBeforeThread.totalTokens).toBe(40);
    expect(state.requestUsageAccounting).toEqual({ startedRequests: 2, reportedRequests: 2, pendingRequests: 0, incomplete: false,
      receipts: [requestReceipt(state.runId, 40), requestReceipt(state.runId, 40)] });
    expect(new Set(state.requestUsageAccounting.receipts.map((receipt: any) => receipt.requestId)).size).toBe(2);
    expect(new Set(state.requestUsageAccounting.receipts.map((receipt: any) => receipt.sessionId)).size).toBe(2);
    expect(state.tokenBudget).toMatchObject({ reportedTotalTokens: 80, usageComplete: true, status: 'available' });
  });

  it.each(['transport', 'exception', 'failed', 'checkpoint', 'interrupted'] as const)
  ('keeps intermediate usage incomplete after a %s model turn with a finite allowance', async failure => {
    host.verify.mockImplementation(async request => failed(verified(request)));
    const runs = vi.fn();
    host.createSession.mockImplementation(session('partial-token-usage', async options => {
      runs(); options.onUsage({ totalTokens: 40 });
      if (failure === 'transport') throw new Error('math_codex_transport_closed:fixture');
      if (failure === 'exception') throw new Error('fixture_request_exception');
      return failure;
    }, { lastError: 'math_codex_transport_closed:fixture' }));
    expect(await runSolver([...args, '--max-turns', '20', '--max-total-tokens', '100'], directory)).toBe(4);
    expect(runs).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({
      status: 'limit_reached', reason: 'math_model_usage_unavailable',
      usage: { totalTokens: 40 }, tokenBudget: { status: 'usage-unavailable', reportedTotalTokens: 40, usageComplete: false } });
    expect(JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8')).usageAccounting).toMatchObject({
      startedTurns: 1, reportedTurns: 0, incomplete: true, pending: false });
    expect(host.delay).not.toHaveBeenCalled();
    expect(host.officialGate).not.toHaveBeenCalled();
  });

  it.each(['reported-first', 'missing-first'] as const)
  ('preserves missing request usage inside a completed tool roundtrip (%s)', async order => {
    host.verify.mockImplementation(async request => failed(verified(request)));
    const runs = vi.fn();
    host.createSession.mockImplementation(session('mixed-request-usage', async options => {
      runs();
      expect(options.onUsageIncomplete).toBeTypeOf('function');
      if (order === 'missing-first') options.onUsageIncomplete!();
      options.onUsage({ totalTokens: 40 });
      if (order === 'reported-first') options.onUsageIncomplete!();
      return 'completed';
    }));
    expect(await runSolver([...args, '--max-turns', '20', '--max-total-tokens', '100'], directory)).toBe(4);
    expect(runs).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({
      status: 'limit_reached', reason: 'math_model_usage_unavailable', usage: { totalTokens: 40 },
      tokenBudget: { status: 'usage-unavailable', usageComplete: false, reportedTotalTokens: 40 } });
    expect(JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8')).usageAccounting).toMatchObject({
      startedTurns: 1, reportedTurns: 0, incomplete: true, pending: false });
    expect(host.officialGate).not.toHaveBeenCalled();
  });

  it('retains partial request usage across later completed turns with an unlimited allowance', async () => {
    let turns = 0;
    host.verify.mockImplementation(async request => turns < 2 ? failed(verified(request)) : verified(request));
    host.createSession.mockImplementation(session('mixed-request-unlimited', async options => {
      options.onUsage({ totalTokens: ++turns * 40 });
      if (turns === 1) options.onUsageIncomplete!();
      else fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'),
        original.replaceAll('by sorry', 'by trivial'));
      return 'completed';
    }));
    expect(await runSolver([...args, '--max-turns', '2', '--max-total-tokens', '0'], directory)).toBe(0);
    expect(turns).toBe(2);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'evaluated_passed', usage: { totalTokens: 80 },
      tokenBudget: { status: 'unlimited', reportedTotalTokens: 80, usageComplete: false } });
    expect(JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8')).usageAccounting).toMatchObject({
      startedTurns: 2, reportedTurns: 1, incomplete: true, pending: false });
  });

  it('keeps partial usage visible while preserving unlimited retries after a transport failure', async () => {
    let turns = 0;
    host.verify.mockImplementation(async request => turns < 2 ? failed(verified(request)) : verified(request));
    host.createSession.mockImplementation(session(() => `partial-token-${host.createSession.mock.calls.length}`, async options => {
      options.onUsage({ totalTokens: 40 });
      if (++turns === 1) throw new Error('math_codex_transport_closed:fixture');
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
      return 'completed';
    }, { lastError: 'math_codex_transport_closed:fixture' }));
    expect(await runSolver([...args, '--max-turns', '2', '--max-total-tokens', '0'], directory)).toBe(0);
    expect(turns).toBe(2);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'evaluated_passed', usage: { totalTokens: 80 },
      tokenBudget: { status: 'unlimited', reportedTotalTokens: 80, usageComplete: false } });
  });

  it.each([80, 0])('retains the cumulative token allowance on resume and allows explicitly changing it to %s', async allowance => {
    let turns = 0;
    host.verify.mockImplementation(async request => turns < 2 ? failed(verified(request)) : verified(request));
    host.createSession.mockImplementation(session('token-resume', async options => {
      options.onUsage({ totalTokens: ++turns * 30 });
      if (turns === 2) fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'),
        original.replaceAll('by sorry', 'by trivial'));
      return 'completed';
    }));
    expect(await runSolver([...args, '--max-turns', '20', '--max-total-tokens', '30'], directory)).toBe(4);
    expect(turns).toBe(1);
    // Omitting the option must not silently turn a saved finite allowance into unlimited work.
    expect(await runSolver([...args, '--resume', '--max-turns', '20'], directory)).toBe(4);
    expect(turns).toBe(1);
    expect(await runSolver([...args, '--resume', '--max-turns', '20', '--max-total-tokens', '25'], directory)).toBe(4);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).tokenBudget).toMatchObject({ reportedTotalTokens: 30, overrunTokens: 5 });
    expect(turns).toBe(1);
    expect(await runSolver([...args, '--resume', '--max-turns', '20', '--max-total-tokens', String(allowance)], directory)).toBe(0);
    expect(turns).toBe(2);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'evaluated_passed', usage: { totalTokens: 60 },
      tokenBudget: { maxTotalTokens: allowance, reportedTotalTokens: 60, usageComplete: true } });
    expect(host.createSession).toHaveBeenCalledTimes(2);
  });

  it.each(['coordination', 'scheduler'])('freezes the CLI %s policy across resume', async policy => {
    expect(await runSolver([...args, '--startup-only'], directory)).toBe(0);
    const prepared = fs.readFileSync(output, 'utf8');
    expect(await runSolver([...args, '--resume', `--${policy}`, policy === 'scheduler' ? 'continuation' : 'cooperative'], directory)).toBe(1);
    expect(fs.readFileSync(output, 'utf8')).toBe(prepared);
    expect(host.createSession).not.toHaveBeenCalled();
  });

  it.each([false, true])('isolates and releases a disposable proof checkout when failure=%s', async failure => {
    const worktrees = git(workspace, ['worktree', 'list', '--porcelain']);
    let checkout = '';
    const result = withSolverWorktree(workspace, problem.baseCommit, async isolated => {
      checkout = isolated;
      expect(git(isolated, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
      fs.writeFileSync(path.join(isolated, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
      await Promise.resolve();
      if (failure) throw new Error('fixture_check_failed');
      return 'checked';
    });
    if (failure) await expect(result).rejects.toThrow('fixture_check_failed');
    else await expect(result).resolves.toBe('checked');
    expect(fs.existsSync(path.dirname(checkout))).toBe(false);
    expect(git(workspace, ['worktree', 'list', '--porcelain'])).toBe(worktrees);
    expect(fs.readFileSync(path.join(project, 'Submission.lean'), 'utf8')).toBe(original);
  });

  it('rejects modified targets, fixed definitions and trusted inputs', () => {
    const proof = path.join(project, 'Submission.lean');
    fs.writeFileSync(proof, original.replace('first : True', 'first : False'));
    expect(() => assertSolverSources(problem, workspace)).toThrow('math_original_declaration_changed');
    fs.writeFileSync(proof, original.replace('fixed : Nat := 2', 'fixed : Nat := 3'));
    expect(() => assertSolverSources(problem, workspace)).toThrow('math_original_declaration_changed');
    fs.writeFileSync(proof, original);
    fs.writeFileSync(proof, original.replace('theorem first', 'variable (h : False)\ntheorem first'));
    expect(() => assertSolverSources(problem, workspace)).toThrow('math_original_context_changed');
    fs.writeFileSync(proof, original);
    fs.writeFileSync(path.join(workspace, 'outside.txt'), 'unexpected file');
    expect(() => assertSolverSources(problem, workspace)).toThrow('math_source_outside_ownership');
    fs.unlinkSync(path.join(workspace, 'outside.txt'));
    fs.writeFileSync(path.join(project, 'Challenge.lean'), 'different problem');
    expect(() => assertSolverSources(problem, workspace)).toThrow('math_trusted_source_changed');
  });

  it('preserves untracked worker scratch as advisory outside proof checkpoints', () => {
    fs.mkdirSync(path.join(workspace, '.scratch'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.scratch', 'Probe.lean'), 'scratch');
    fs.mkdirSync(path.join(workspace, 'scratch'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'scratch', 'search.c'), 'scratch');
    fs.writeFileSync(path.join(workspace, 'scratch_test'), 'scratch');
    fs.writeFileSync(path.join(workspace, 'Probe.lean'), 'scratch');
    fs.writeFileSync(path.join(project, 'Probe2.lean'), 'scratch');
    expect(() => assertSolverSources(problem, workspace)).not.toThrow();
    expect(fs.existsSync(path.join(workspace, '.scratch', 'Probe.lean'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'scratch', 'search.c'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'scratch_test'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'Probe.lean'))).toBe(true);
    expect(fs.existsSync(path.join(project, 'Probe2.lean'))).toBe(true);
  });

  it('allows new helper declarations while preserving the original context', () => {
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replace('theorem first',
      'lemma helper : True := by trivial\ntheorem first'));
    expect(() => assertSolverSources(problem, workspace)).not.toThrow();
  });

  it('provides source recovery guidance and permits a repaired saved file without relaxing checks', () => {
    const file = path.join(project, 'Submission.lean');
    const helper = 'lemma helper : True := by trivial\n';
    fs.writeFileSync(file, original.replace('theorem first', `open scoped BigOperators\n${helper}theorem first`));
    let error: unknown;
    try { assertSolverProjectSources(problem, project); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SolverSourceError);
    expect(error).toMatchObject({ message: 'math_original_context_changed', proofPath: 'Submission.lean' });
    expect((error as SolverSourceError).recovery).toContain('inside their proofs');
    fs.writeFileSync(file, original.replace('theorem first', helper + 'theorem first'));
    expect(() => assertSolverProjectSources(problem, project)).not.toThrow();
    fs.writeFileSync(file, original.replace('fixed : Nat := 2', 'fixed : Nat := 3'));
    try { assertSolverProjectSources(problem, project); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ message: 'math_original_declaration_changed', declarationName: 'fixed' });
    expect((error as SolverSourceError).recovery).toContain('fixed');
  });

  it.each(['first', 'second'])('projects documented declarations without orphan comments when keeping %s', target => {
    const source = original
      .replace('theorem first', '/-! Module documentation. -/\n/-- First /- nested -/ documentation. -/\ntheorem first')
      .replace('theorem second', '/-- Second documentation. -/\ntheorem second')
      .replace(`${target} : True := by sorry`, `${target} : True := by trivial`)
      .replace('end Submission', 'def marker : String := "/-- literal -/"\n/-- Hidden helper documentation. -/\nlemma hidden : True := by trivial\nend Submission');
    fs.writeFileSync(path.join(project, 'Submission.lean'), source);
    git(workspace, ['add', 'generated/p/Submission.lean']);
    commitFixture(workspace, 'Documented baseline');
    problem = readSolverProblem(workspace, problem.activeProblemPath);
    const commit = commitSolverSources(problem, workspace);
    const task: CooperativeTask = { id: target, kind: 'goal', objective: 'Prove the target', dependsOn: [], revision: 0,
      proofPath: 'Submission.lean', theoremName: `Submission.${target}` };
    const projected = createTaskSourceProjector(problem, workspace, commit)(task, []).get('Submission.lean')!;
    expect(projected).toContain(`theorem ${target} : True := by trivial`);
    expect(projected).not.toContain(`theorem ${target === 'first' ? 'second' : 'first'}`);
    expect(projected).toContain('lemma hidden');
    expect(projected).not.toMatch(/documentation/iu);
    expect(projected).toContain('def marker : String := "/-- literal -/"');
    expect(projected).toContain('namespace Submission');
    expect(projected).toContain('end Submission');
    expect(fs.readFileSync(path.join(project, 'Submission.lean'), 'utf8')).toBe(source);
  });

  it.each([
    ['an omitted instance', 'variable {p : Prop} [Decidable p]\n', 'omit [Decidable p] in\n'],
    ['an attribute line', '', '@[simp]\n'],
    ['stacked in-commands', '', 'open Nat in\nset_option maxHeartbeats 400000 in\n'],
    ['a documented local attribute', '', 'attribute [local simp] Nat.add_comm in\n/-- Second documentation. -/\n'],
  ])('removes an unfinished goal with %s instead of binding it to the closing end', (_, context, prefix) => {
    const source = original.replace('def fixed', `${context}def fixed`).replace('theorem second', `${prefix}theorem second`)
      .replace('first : True := by sorry', 'first : True := by trivial');
    fs.writeFileSync(path.join(project, 'Submission.lean'), source);
    git(workspace, ['add', 'generated/p/Submission.lean']);
    commitFixture(workspace, 'Prefixed baseline');
    problem = readSolverProblem(workspace, problem.activeProblemPath);
    const commit = commitSolverSources(problem, workspace);
    const task: CooperativeTask = { id: 'first', kind: 'goal', objective: 'Prove the target', dependsOn: [], revision: 0,
      proofPath: 'Submission.lean', theoremName: 'Submission.first' };
    const projected = createTaskSourceProjector(problem, workspace, commit)(task, []).get('Submission.lean')!;
    expect(projected).toBe(source.replace(`${prefix}theorem second : True := by sorry\n`, ''));
  });

  it.each([
    ['', 'math_task_missing_declaration'],
    ['lemma BranchA.helper : True := by trivial\nlemma BranchB.helper : True := by trivial\n', 'math_task_ambiguous_declaration'],
    ['def helper : True := by trivial\n', 'math_task_requires_theorem'],
  ])('distinguishes an invalid assigned declaration: %s', (helper, code) => {
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replace('theorem first', helper + 'theorem first'));
    const commit = commitSolverSources(problem, workspace);
    const task: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Prove the helper', dependsOn: [], revision: 0,
      proofPath: 'Submission.lean', theoremName: 'Submission.helper', type: 'True' };
    expect(() => createTaskSourceProjector(problem, workspace, commit)(task, [])).toThrow(code);
    expect(() => createTaskSourceProjector(problem, workspace, commit)(task, [])).toThrow('Target: Submission.helper');
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('checks and merges only the body of a configured original definition goal', async () => {
    const { source, task } = configureDefinitionGoal();
    const candidate = source.replace('C : Nat := by sorry', 'C : Nat := 7');
    fs.writeFileSync(path.join(project, 'Submission.lean'), candidate);
    const commit = commitSolverSources(problem, workspace);
    host.verify.mockImplementation(async request => {
      const projected = fs.readFileSync(path.join(request.projectRoot, 'Submission.lean'), 'utf8');
      expect(projected).toContain('noncomputable def C : Nat := 7');
      expect(projected).toContain('def fixed : Nat := 2');
      expect(projected).not.toContain('theorem first');
      expect(projected).not.toContain('theorem second');
      expect(projected).not.toContain('sorry');
      expect(request.items.map(item => item.theoremName)).toEqual(['Submission.C']);
      return verified(request);
    });
    const proof = await checkTaskProof(problem, workspace, commit, task,
      { taskId: task.id, taskDigest: taskVersion(task), workerId: 'engineer', seedCommit: problem.baseCommit },
      [], {}, new AbortController().signal);
    expect(proof.passed).toBe(true);
    expect(host.verify).toHaveBeenCalledOnce();
    expect(proof.changes).toEqual([{ file: 'Submission.lean', name: 'C',
      before: 'noncomputable def C : Nat := by sorry\n', after: 'noncomputable def C : Nat := 7\n' }]);
    await withSolverWorktree(workspace, problem.baseCommit, async checkout => {
      const file = path.join(checkout, problem.projectRelative, 'Submission.lean');
      const peer = 'lemma peer : True := by trivial\n';
      fs.writeFileSync(file, source.replace('theorem first', peer + 'theorem first'));
      applyTaskChanges(problem, checkout, proof.changes);
      expect(fs.readFileSync(file, 'utf8')).toBe(candidate.replace('theorem first', peer + 'theorem first'));
      expect(() => assertSolverSources(problem, checkout)).not.toThrow();
    });
  });

  it('checks an exact original definition using a host-bound unfinished typed input', async () => {
    const { source, task: originalTask } = configureDefinitionGoal();
    const helper: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Supply the construction input',
      type: 'True', theoremName: 'Submission.helper', proofPath: 'Submission.lean', dependsOn: [], revision: 0 };
    const task = { ...originalTask, dependsOn: [helper.id] };
    const tasks: TaskRecord[] = [helper, task].map(task => ({ task, status: 'pending', attempts: 0 }));
    const assignment = { taskId: task.id, taskDigest: taskVersion(task), workerId: 'engineer', seedCommit: problem.baseCommit,
      dependencies: [{ taskId: helper.id, taskDigest: taskVersion(helper) }] };
    const dispatched = { ...assignment, connectionCheck: createTaskConnectionCheck(task, assignment, tasks,
      { environmentDigest: 'fixture', problemReceiptDigest: problem.receiptDigest }) };
    fs.writeFileSync(path.join(project, 'Submission.lean'), source.replace('C : Nat := by sorry',
      'C : Nat := by\n  have h : True := Submission.helper\n  exact 7'));
    const commit = commitSolverSources(problem, workspace);
    host.verify.mockImplementation(async request => {
      const projected = fs.readFileSync(path.join(request.projectRoot, 'Submission.lean'), 'utf8');
      expect(projected).toContain('noncomputable def C : theorem_os_conditional_type%');
      expect(projected).toContain('have h : True := _root_.Submission.helper');
      expect(projected).not.toContain('sorry'); return verified(request);
    });
    const proof = await checkTaskProof(problem, workspace, commit, task, dispatched,
      [], {}, new AbortController().signal, Infinity, [helper], 'fixture');
    expect(proof.passed).toBe(true);
    expect(proof.conditions).toEqual(assignment.dependencies);
    expect(proof.changes[0].after).not.toContain('(helper : True)');
    expect(host.verify).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'a changed type', edit: (source: string) => source.replace('C : Nat', 'C : Int'), error: 'math_original_declaration_changed' },
    { name: 'an added parameter', edit: (source: string) => source.replace('C : Nat', 'C (n : Nat) : Nat'), error: 'math_original_declaration_changed' },
    { name: 'a renamed target', edit: (source: string) => source.replace('def C : Nat', 'def otherC : Nat'), error: 'math_original_declaration_changed' },
    { name: 'a different namespace', edit: (source: string) => source.replace('def C : Nat', 'def Other.C : Nat'), error: 'math_original_declaration_changed' },
    { name: 'a changed frozen context', edit: (source: string) => source.replace('noncomputable def C', 'variable (extra : False)\nnoncomputable def C'), error: 'math_original_context_changed' },
    { name: 'a changed non-target definition', edit: (source: string) => source.replace('fixed : Nat := 2', 'fixed : Nat := 3'), error: 'math_original_declaration_changed' },
    { name: 'another original goal proof', edit: (source: string) => source.replace('first : True := by sorry', 'first : True := by trivial'), error: 'math_task_existing_declaration_changed' },
    { name: 'an abbrev in place of the original def', edit: (source: string) => source.replace('def C : Nat', 'abbrev C : Nat'), error: 'math_task_requires_theorem' },
    { name: 'a theorem in place of the original def', edit: (source: string) => source.replace('def C : Nat', 'theorem C : Nat'), error: 'math_task_requires_theorem' },
  ])('rejects $name before checking an original definition goal', async ({ edit, error }) => {
    const { source, task } = configureDefinitionGoal();
    fs.writeFileSync(path.join(project, 'Submission.lean'), edit(source.replace('C : Nat := by sorry', 'C : Nat := 7')));
    git(workspace, ['add', '--', 'generated/p/Submission.lean']);
    commitFixture(workspace, 'Invalid definition candidate');
    const commit = git(workspace, ['rev-parse', 'HEAD']);
    await expect(checkTaskProof(problem, workspace, commit, task,
      { taskId: task.id, taskDigest: taskVersion(task), workerId: 'engineer', seedCommit: problem.baseCommit },
      [], {}, new AbortController().signal)).rejects.toThrow(error);
    expect(host.verify).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'lemma' as const, theoremName: 'Submission.helper', type: 'Nat' },
    { kind: 'lemma' as const, theoremName: 'Submission.C', type: 'Nat' },
    { kind: 'goal' as const, theoremName: 'Submission.helper' },
    { kind: 'goal' as const, theoremName: 'Other.C' },
  ])('rejects definition impersonation through $kind target $theoremName', impostor => {
    const { source, task } = configureDefinitionGoal();
    fs.writeFileSync(path.join(project, 'Submission.lean'), source.replace('theorem first', 'def helper : Nat := 7\ntheorem first'));
    const commit = commitSolverSources(problem, workspace);
    expect(() => createTaskSourceProjector(problem, workspace, commit)({ ...task, ...impostor }, []))
      .toThrow('math_task_requires_theorem');
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('checks a planned definition task as a complete def of its exact type and keeps its body for consumers', async () => {
    const task: CooperativeTask = { id: 'double', kind: 'lemma', declaration: 'definition', objective: 'Twice a natural number',
      type: 'Nat → Nat', theoremName: 'Submission.double', proofPath: 'Submission.lean', dependsOn: [], revision: 0 };
    const candidate = original.replace('theorem first', 'def double (n : Nat) : Nat := n + n\ntheorem first');
    fs.writeFileSync(path.join(project, 'Submission.lean'), candidate);
    const commit = commitSolverSources(problem, workspace);
    host.verify.mockImplementation(async (request, options) => {
      const projected = fs.readFileSync(path.join(request.projectRoot, 'Submission.lean'), 'utf8');
      expect(projected).toContain('def double (n : Nat) : Nat := n + n');
      expect(request.items.map(item => item.theoremName)).toEqual(['Submission.double']);
      expect(options.expectedDeclarationType).toBe('Nat → Nat');
      return verified(request);
    });
    const proof = await checkTaskProof(problem, workspace, commit, task,
      { taskId: task.id, taskDigest: taskVersion(task), workerId: 'engineer', seedCommit: problem.baseCommit },
      [], {}, new AbortController().signal);
    expect(proof.passed).toBe(true);
    expect(proof.changes).toEqual([expect.objectContaining({ name: 'double', after: 'def double (n : Nat) : Nat := n + n\n' })]);
    const consumer: CooperativeTask = { id: 'double_eq', kind: 'lemma', objective: 'Unfold double', type: 'double 2 = 4',
      theoremName: 'Submission.double_eq', proofPath: 'Submission.lean', dependsOn: [task.id], revision: 0 };
    fs.writeFileSync(path.join(project, 'Submission.lean'),
      candidate.replace('theorem first', 'theorem double_eq : double 2 = 4 := by decide\ntheorem first'));
    const projected = createTaskSourceProjector(problem, workspace, commitSolverSources(problem, workspace))(consumer, [])
      .get('Submission.lean')!;
    expect(projected).toContain('def double (n : Nat) : Nat := n + n');
  });

  it.each([
    ['theorem double : True := by trivial\n', 'math_task_requires_definition'],
    ['', 'math_task_missing_declaration'],
  ])('rejects a definition task delivered as %j before Lean', (helper, code) => {
    const task: CooperativeTask = { id: 'double', kind: 'lemma', declaration: 'definition', objective: 'Twice a natural number',
      type: 'Nat → Nat', theoremName: 'Submission.double', proofPath: 'Submission.lean', dependsOn: [], revision: 0 };
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replace('theorem first', helper + 'theorem first'));
    const commit = commitSolverSources(problem, workspace);
    expect(() => createTaskSourceProjector(problem, workspace, commit)(task, [])).toThrow(code);
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('allows root and explicit Mathlib imports while preserving original imports, declarations and trusted inputs', () => {
    const file = path.join(project, 'Submission.lean');
    const imports = ['Mathlib.MeasureTheory.Integral.Bochner.Basic', 'Mathlib.MeasureTheory.Measure.Lebesgue.Basic',
      'Mathlib.Analysis.SpecialFunctions.Log.Basic'];
    const baseline = imports.map(module => `import ${module}\n`).join('') + original;
    fs.writeFileSync(file, baseline);
    commitSolverSources(problem, workspace);
    problem = readSolverProblem(workspace, problem.activeProblemPath);
    expect(problem.sourceImports?.['Submission.lean']).toEqual(imports);
    const candidate = 'import Mathlib\nimport Mathlib.Analysis.Calculus.Deriv.Basic\n' + baseline;
    fs.writeFileSync(file, candidate);
    expect(() => assertSolverProjectSources(problem, project)).not.toThrow();
    expect(() => assertSolverSources(problem, workspace)).not.toThrow();
    const { sourceImports: _imports, ...legacy } = problem;
    expect(() => assertSolverProjectSources(legacy, project)).toThrow('math_original_context_changed');
    for (const source of [original, candidate.replace(`import ${imports[0]}\n`, ''),
      ...['import Other', 'import Solution', 'import MathlibExtra', 'import Mathlib.Data.Real.Basic variable (h : False)']
        .map(command => command + '\n' + baseline)]) {
      fs.writeFileSync(file, source);
      expect(() => assertSolverProjectSources(problem, project)).toThrow('math_original_context_changed');
    }
    for (const source of [candidate.replace('first : True', 'first : False'), candidate.replace('fixed : Nat := 2', 'fixed : Nat := 3')]) {
      fs.writeFileSync(file, source);
      expect(() => assertSolverProjectSources(problem, project)).toThrow('math_original_declaration_changed');
    }
    fs.writeFileSync(file, candidate);
    fs.writeFileSync(path.join(project, 'Challenge.lean'), 'import Mathlib.Data.Nat.Basic\n' + original);
    expect(() => assertSolverSources(problem, workspace)).toThrow('math_trusted_source_changed');
  });

  it.each([false, true])('allows helpers to import frozen public modules and rejects cycles (cycle: %s)', cycle => {
    const helper = 'Submission/Helpers.lean';
    fs.mkdirSync(path.join(project, 'Submission'));
    fs.writeFileSync(path.join(project, helper), '');
    fs.writeFileSync(path.join(project, 'ChallengeDeps.lean'), (cycle ? 'import Submission.Helpers\n' : '') + 'def publicSeed : Nat := 1\n');
    fs.writeFileSync(path.join(project, 'Submission.lean'), 'import ChallengeDeps\nimport Submission.Helpers\n' + original);
    const receipt = JSON.parse(fs.readFileSync(problem.activeProblemPath, 'utf8'));
    receipt.solverOwnedFiles.push(helper); receipt.trustedFiles.push('ChallengeDeps.lean');
    fs.writeFileSync(problem.activeProblemPath, JSON.stringify(receipt));
    git(workspace, ['add', 'generated']);
    commitFixture(workspace, 'Freeze public imports');
    problem = readSolverProblem(workspace, problem.activeProblemPath);
    fs.writeFileSync(path.join(project, helper), 'import ChallengeDeps\n');
    if (cycle) expect(() => assertSolverSources(problem, workspace)).toThrow('math_local_module_import_cycle');
    else {
      expect(() => assertSolverSources(problem, workspace)).not.toThrow();
      fs.writeFileSync(path.join(project, helper), '');
      applyTaskChanges(problem, workspace, [], [{ file: helper, module: 'ChallengeDeps' }]);
      expect(fs.readFileSync(path.join(project, helper), 'utf8')).toBe('import ChallengeDeps\n');
      expect(() => applyTaskChanges(problem, workspace, [], [{ file: helper, module: 'Solution' }])).toThrow('math_task_source_outside_scope');
    }
  });

  it('passes the frozen import policy to model-side diagnostic constraints', async () => {
    expect(await runSolver([...args, '--startup-only'], directory)).toBe(0);
    const state = JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8'));
    const prepared = path.join(state.worktree, problem.projectRelative);
    const constraints = JSON.parse(fs.readFileSync(path.join(prepared, '.lake/source-constraints.json'), 'utf8'));
    expect(constraints.sourceImports).toEqual(problem.sourceImports);
    fs.writeFileSync(path.join(prepared, 'Submission.lean'), 'import Mathlib.Data.Nat.Basic\n' + original);
    expect(() => assertSolverProjectSources(constraints, prepared)).not.toThrow();
    expect(host.createSession).not.toHaveBeenCalled();
  });

  it('allows single-name type queries while rejecting context changes beside them', () => {
    const file = path.join(project, 'Submission.lean');
    const probe = original.replace('theorem first', '#check Finset.sum_eq_single\n#check Nat.add_comm\ntheorem first');
    fs.writeFileSync(file, probe);
    expect(() => assertSolverProjectSources(problem, project)).not.toThrow();
    expect(() => assertSolverSources(problem, workspace)).not.toThrow();
    for (const command of ['#check True variable (h : False)', '#check True\nvariable (h : False)',
      '#check True\nset_option autoImplicit true', '#check True\nimport Other']) {
      fs.writeFileSync(file, original.replace('theorem first', `${command}\ntheorem first`));
      expect(() => assertSolverProjectSources(problem, project)).toThrow('math_original_context_changed');
    }
    fs.writeFileSync(file, probe.replace('first : True', 'first : False'));
    expect(() => assertSolverProjectSources(problem, project)).toThrow('math_original_declaration_changed');
  });

  it('allows read-only instance queries with bare and parenthesized types while rejecting trailing commands', () => {
    const file = path.join(project, 'Submission.lean');
    const probe = original.replace('theorem first',
      '#synth Finite ({-1, 1} : Set ℤ)\n#synth Fintype ({-1, 1} : Set ℤ)\n' +
      '#synth Fintype (Fin (2 + 1))\n#synth NormedSpace (ℝ) (X)\n#synth Nontrivial\n' +
      '#synth MeasureSpace ℝ\n#synth Fintype Nat\n#synth NormedSpace ℝ X\ntheorem first');
    fs.writeFileSync(file, probe);
    expect(() => assertSolverProjectSources(problem, project)).not.toThrow();
    expect(() => assertSolverSources(problem, workspace)).not.toThrow();
    for (const command of ['#synth True variable (h : False)', '#synth Fintype ({-1, 1} : Set ℤ)\nvariable (h : False)',
      '#synth Fintype (Nat) variable (h : False)', '#synth Fintype (Nat) import Other',
      '#synth Fintype (Nat) set_option autoImplicit true', '#synth Fintype (Nat)\nimport Other',
      '#synth Fintype (Nat)\nset_option autoImplicit true', '#synth Fintype (Nat); import Other',
      '#synth Fintype Nat variable (h : False)', '#synth MeasureSpace ℝ import Other',
      '#synth NormedSpace ℝ X set_option autoImplicit true', '#synth Fintype ((Nat)', '#synth Fintype (Nat))']) {
      fs.writeFileSync(file, original.replace('theorem first', `${command}\ntheorem first`));
      expect(() => assertSolverProjectSources(problem, project)).toThrow('math_original_context_changed');
    }
    fs.writeFileSync(file, probe.replace('first : True', 'first : False'));
    expect(() => assertSolverProjectSources(problem, project)).toThrow('math_original_declaration_changed');
  });

  it('allows noncomputable new helpers without changing original declarations or context', () => {
    const file = path.join(project, 'Submission.lean');
    fs.writeFileSync(file, original.replace('theorem first', 'noncomputable def helper : Nat := 0\ntheorem first'));
    expect(() => assertSolverSources(problem, workspace)).not.toThrow();
    fs.writeFileSync(file, original.replace('def fixed', 'noncomputable def fixed'));
    expect(() => assertSolverSources(problem, workspace)).toThrow('math_original_context_changed');
  });

  it('shares the original source checks with diagnostics before compiling a candidate', () => {
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replace('theorem first', 'noncomputable section\ntheorem first'));
    expect(() => assertSolverProjectSources(problem, project)).toThrow('math_original_context_changed');
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replace('fixed : Nat := 2', 'fixed : Nat := 3'));
    expect(() => assertSolverProjectSources(problem, project)).toThrow('math_original_declaration_changed');
  });

  it.each([false, true])('starts a fresh context with notes, proof sources, failures and cumulative usage (resume: %s)', async resume => {
    let turn = 0;
    const messages: string[] = [];
    const closes = [vi.fn(), vi.fn()];
    const checkpoint = 'Checked helper: keep this proof.\n' + 'x'.repeat(20000) + '\nNext step: apply the retained helper to the final goal.';
    host.verify.mockImplementation(async request => turn === 1 ? failed(verified(request), { stdoutPreview: unsolved }) : verified(request));
    host.createSession.mockImplementation(async (options: MathAgentOptions) => {
      const first = host.createSession.mock.calls.length === 1;
      const threadId = options.threadId ?? (first ? 'large-thread' : 'continued-thread');
      return { threadId, lastInputTokens: first ? 100_000 : 1000,
        close: first ? closes[0] : closes[1], interrupt: vi.fn(), run: async (message: string) => {
          messages.push(message); turn++;
          if (first) {
            fs.writeFileSync(path.join(options.workspace, 'RESEARCH.md'), checkpoint);
            fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replace('by sorry', 'by trivial'));
          } else {
            expect(options.threadId).toBeUndefined();
            expect(message).toContain(checkpoint);
            expect(message).toContain('Original problem:');
            expect(message).toContain('unsolved goals');
            const manifest = JSON.parse(message.split('Context compilation manifest:\n')[1]);
            expect(manifest.usedBytes).toBeLessThanOrEqual(manifest.maxBytes);
            expect(manifest.included).toContainEqual(expect.objectContaining({ id: 'checkpoint', required: false }));
            expect(fs.readFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), 'utf8')).toContain('first : True := by trivial');
            fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
          }
          options.onUsage({ inputTokens: first ? 100000 : 1000, totalTokens: first ? 110000 : 2000 });
          return 'completed';
        } };
    });
    if (resume) {
      expect(await runSolver(args, directory)).toBe(4);
      expect(JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8')).lastInputTokens).toBe(100000);
    }
    expect(await runSolver([...args, '--max-turns', '2', ...(resume ? ['--resume'] : [])], directory)).toBe(0);
    const state = JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8'));
    expect(state.previousThreadIds).toEqual(['large-thread']);
    expect(state.threadId).toBe('continued-thread');
    expect(state.usage).toMatchObject({ inputTokens: 101000, totalTokens: 112000 });
    expect(state.failures).toHaveLength(1);
    expect(closes[0]).toHaveBeenCalledOnce();
  });

  it.each([
    ['target', 'first : True', 'first : False', 'math_original_declaration_changed'],
    ['definition', 'fixed : Nat := 2', 'fixed : Nat := 3', 'math_original_declaration_changed'],
    ['context', 'theorem first', 'variable (h : False)\ntheorem first', 'math_original_context_changed'],
  ])('lets the same session repair a changed %s before checking or integrating it', async (_kind, from, to, reason) => {
    const messages: string[] = [];
    const solved = original.replaceAll('by sorry', 'by trivial');
    const withHelper = solved.replace('theorem first', 'lemma helper : True := by trivial\ntheorem first');
    host.createSession.mockImplementation(session('fixture-thread', async (options, message) => {
      messages.push(message);
      if (messages.length === 2) {
        expect(host.verify).not.toHaveBeenCalled();
        expect(git(options.workspace, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
        expect(fs.readFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), 'utf8')).toContain('lemma helper');
      }
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'),
        messages.length === 1 ? withHelper.replace(from, to) : withHelper);
      return 'completed';
    }));
    expect(await runSolver([...args, '--max-turns', '2'], directory)).toBe(0);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain(reason);
    expect(messages[1]).toContain('generated/p/Submission.lean');
    expect(messages[1]).toContain(problem.baseCommit);
    expect(host.createSession).toHaveBeenCalledTimes(1);
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(project, 'Submission.lean'), 'utf8')).toBe(withHelper);
  });

  it('keeps repeated invalid edits incomplete and resumable within the turn budget', async () => {
    host.createSession.mockImplementation(session('fixture-thread', async options => {
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replace('first : True', 'first : False'));
      return 'completed';
    }));
    expect(await runSolver([...args, '--max-turns', '2'], directory)).toBe(4);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'incomplete', turns: 2,
      solution_commit: null, solver_ready_receipt_valid: false, evaluator: { status: 'skipped' } });
    expect(host.verify).not.toHaveBeenCalled();
    expect(host.officialGate).not.toHaveBeenCalled();
    expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
    const messages: string[] = [];
    host.createSession.mockImplementation(session(options => options.threadId!, async (options, message) => {
      messages.push(message);
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
      return 'completed';
    }));
    expect(await runSolver([...args, '--resume', '--max-turns', '3'], directory)).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('math_original_declaration_changed');
    expect(host.createSession.mock.calls[1][0].threadId).toBe('fixture-thread');
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).turns).toBe(3);
  });

  it.each([
    ['trusted input', 'generated/p/Challenge.lean', 'math_trusted_source_changed'],
  ])('stops on a changed %s without sending it through Lean', async (_kind, file, reason) => {
    const run = vi.fn(async (options: MathAgentOptions) => {
      fs.writeFileSync(path.join(options.workspace, file), 'unexpected content');
      return 'completed';
    });
    host.createSession.mockImplementation(async (options: MathAgentOptions) => ({ threadId: 'fixture-thread',
      run: () => run(options), close: vi.fn(), interrupt: vi.fn() }));
    expect(await runSolver([...args, '--max-turns', '2'], directory)).toBe(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'runtime_error', reason });
    expect(run).toHaveBeenCalledTimes(1);
    expect(host.verify).not.toHaveBeenCalled();
    expect(host.officialGate).not.toHaveBeenCalled();
    expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
  });

  it('requires receipts for every target at the exact frozen commit', async () => {
    const check = await checkSolverProof(problem, workspace, {});
    expect(check.passed).toBe(true);
    expect(host.verify.mock.calls[0][0]).toMatchObject({ timeoutMs: 180_000 });
    expect(host.verify.mock.calls[0][1]).toMatchObject({ prepareLocalDependencies: true });
    for (const corrupt of [
      (batch: MathematicsVerifierBatchResult) => batch.results.pop(),
      (batch: MathematicsVerifierBatchResult) => batch.results.push(batch.results[0]),
      (batch: MathematicsVerifierBatchResult) => batch.results.reverse(),
      (batch: MathematicsVerifierBatchResult) => { batch.targetCommit = 'b'.repeat(40); },
      (batch: MathematicsVerifierBatchResult) => { batch.status = 'failed'; },
    ]) {
      host.verify.mockImplementation(async request => { const batch = verified(request); corrupt(batch); return batch; });
      expect((await checkSolverProof(problem, workspace, {})).passed).toBe(false);
    }
    for (const [field, value] of Object.entries({ status: 'failed', targetCommit: 'b'.repeat(40), proofPath: 'wrong.lean',
      theoremName: 'wrong', statementHash: 'wrong', leanStatementHash: 'wrong', sourceDeclarationHash: 'wrong', claim: 'negation' })) {
      host.verify.mockImplementation(async request => { const batch = verified(request); Object.assign(batch.results[0], { [field]: value }); return batch; });
      expect((await checkSolverProof(problem, workspace, {})).passed, field).toBe(false);
    }
  });

  it('ignores a worker diagnostic log but not a tracked or nested one', () => {
    fs.writeFileSync(path.join(workspace, 'check-lean-submission.log'), 'diagnostic output\n');
    expect(() => assertSolverSources(problem, workspace)).not.toThrow();
    fs.writeFileSync(path.join(project, 'probe.log'), 'diagnostic output\n');
    expect(() => assertSolverSources(problem, workspace)).toThrow('math_source_outside_ownership');
    fs.unlinkSync(path.join(project, 'probe.log'));
    fs.writeFileSync(path.join(workspace, 'tracked.log'), 'committed on purpose\n');
    git(workspace, ['add', '--', 'tracked.log']);
    git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--no-gpg-sign', '--quiet',
      '-m', 'Track a log']);
    fs.writeFileSync(path.join(workspace, 'tracked.log'), 'changed after the commit\n');
    expect(() => assertSolverSources(problem, workspace)).toThrow('math_source_outside_ownership');
    fs.unlinkSync(path.join(workspace, 'tracked.log'));
    fs.unlinkSync(path.join(workspace, 'check-lean-submission.log'));
  });

  it('keeps changing host journals outside the strict clean-checkout boundary', async () => {
    const journals = ['COOPERATION.json', 'CONTEXT-MANIFEST.json', 'DECLARATIONS.jsonl', 'DELIVERIES.jsonl', `DELIVERIES-${'a'.repeat(64)}.jsonl`];
    for (const file of journals) fs.writeFileSync(path.join(workspace, file), '{}\n');
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
    fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), 'Checked both original targets.');
    host.verify.mockImplementation(async request => {
      expect(git(request.projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
      expect(git(request.projectRoot, ['rev-parse', 'HEAD'])).toBe(request.targetCommit);
      return verified(request);
    });
    const first = await checkSolverProof(problem, workspace, {});
    expect(first.passed).toBe(true);
    expect(git(workspace, ['ls-files', '--', ...journals])).toBe('');
    const exclude = path.resolve(workspace, git(workspace, ['rev-parse', '--git-path', 'info/exclude']));
    const rules = fs.readFileSync(exclude, 'utf8');
    for (const file of journals) fs.appendFileSync(path.join(workspace, file), '{"update":true}\n');
    const next = await checkSolverProof(problem, workspace, {}, undefined, first);
    expect(next.passed).toBe(true);
    expect(next.commit).toBe(first.commit);
    expect(fs.readFileSync(exclude, 'utf8')).toBe(rules);
    fs.writeFileSync(path.join(workspace, 'DELIVERIES-invalid.jsonl'), '{}\n');
    await expect(checkSolverProof(problem, workspace, {})).rejects.toThrow('math_source_outside_ownership');
    expect(host.verify).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('checks a clean committed proof while retaining advisory scratch (verifier throws: %s)', async throws => {
    const source = original.replaceAll('by sorry', 'by trivial');
    fs.writeFileSync(path.join(project, 'Submission.lean'), source);
    const advisory = new Map([
      '.scratch/tmp/RootProbe.lean', path.join(problem.projectRelative, '.scratch/tmp/LibProbe.lean'),
      'ProbeRoot.lean', path.join(problem.projectRelative, 'ProbeProject.lean'), 'check-lean-submission.log',
    ].map((file, index) => [file, Buffer.from(`-- Retained advisory file ${index}.\n#check Nat.add_zero\n`)]));
    for (const [relative, content] of advisory) {
      const file = path.join(workspace, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
    }
    const packages = path.join(project, '.lake', 'packages');
    fs.mkdirSync(packages, { recursive: true }); fs.writeFileSync(path.join(packages, 'Pinned.lean'), '-- pinned package\n');
    const env = { DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS: packages }, controller = new AbortController();
    const worktrees = () => git(workspace, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree '));
    const registered = worktrees(), failure = new Error('fixture_strict_verifier_failed');
    const items = problem.targets.map(target => ({ proofPath: target.proofPath, theoremName: target.theoremName,
      expectedSourceDeclarationHash: target.declarationHash, statementHash: problem.contract.statementHash,
      leanStatementHash: problem.contract.leanStatementHash, claim: 'statement' }));
    let checkout = '', commit = '', verification: MathematicsVerifierBatchResult | undefined;
    host.verify.mockImplementation(async (request: MathematicsVerifierBatchRequest, options) => {
      checkout = git(request.projectRoot, ['rev-parse', '--show-toplevel']);
      commit = git(workspace, ['rev-parse', 'HEAD']);
      expect(checkout).not.toBe(workspace); expect(commit).not.toBe(problem.baseCommit);
      expect(request).toMatchObject({ projectRoot: path.join(checkout, problem.projectRelative), targetCommit: commit,
        timeoutMs: 180_000, items });
      expect(options).toMatchObject({ env, signal: controller.signal, prepareLocalDependencies: true, collectDeclarationReferences: true,
        trustedLakePackagesRoots: [packages] });
      expect(git(checkout, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
      expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(commit);
      expect(fs.readFileSync(path.join(request.projectRoot, 'Submission.lean'), 'utf8')).toBe(source);
      expect(git(checkout, ['show', `${commit}:${problem.projectRelative}/Submission.lean`])).toBe(source.trim());
      expect(fs.realpathSync(path.join(request.projectRoot, '.lake', 'packages'))).toBe(packages);
      expect(fs.readFileSync(path.join(request.projectRoot, '.lake', 'packages', 'Pinned.lean'), 'utf8')).toBe('-- pinned package\n');
      for (const relative of advisory.keys()) expect(fs.existsSync(path.join(checkout, relative)), relative).toBe(false);
      if (throws) throw failure;
      return verification = verified(request);
    });
    const pending = checkSolverProof(problem, workspace, env, controller.signal);
    if (throws) await expect(pending).rejects.toBe(failure);
    else {
      const checked = await pending;
      expect(checked).toMatchObject({ passed: true, commit }); expect(checked.verification).toBe(verification);
      expect(checked.verification).toMatchObject({ targetCommit: commit, results: items.map(item => ({ ...item,
        targetCommit: commit, sourceDeclarationHash: item.expectedSourceDeclarationHash,
        receiptId: `fixture-${commit}-${item.theoremName}` })) });
    }
    expect(host.verify).toHaveBeenCalledOnce(); expect(checkout).not.toBe('');
    expect(fs.existsSync(path.dirname(checkout))).toBe(false); expect(worktrees()).toEqual(registered);
    expect(fs.readFileSync(path.join(project, 'Submission.lean'), 'utf8')).toBe(source);
    expect(fs.readFileSync(path.join(packages, 'Pinned.lean'), 'utf8')).toBe('-- pinned package\n');
    for (const [relative, content] of advisory) {
      expect(fs.lstatSync(path.join(workspace, relative)).isFile()).toBe(true);
      expect(fs.readFileSync(path.join(workspace, relative))).toEqual(content);
    }
    expect(git(workspace, ['ls-files', '--others', '--exclude-standard']).split('\n').sort()).toEqual([...advisory.keys()].sort());
    expect(git(workspace, ['ls-tree', '-r', '--name-only', commit, '--', ...advisory.keys()])).toBe('');
  });

  it.each(['', 'Combinatorics'])('checks the frozen Submission declarations for LeanEval namespace %s', async namespace => {
    const receipt = JSON.parse(fs.readFileSync(problem.activeProblemPath, 'utf8'));
    const challenge = original.replaceAll('namespace Submission', `namespace LeanEval${namespace ? `\nnamespace ${namespace}` : ''}`)
      .replaceAll('end Submission', `${namespace ? `end ${namespace}\n` : ''}end LeanEval`);
    fs.writeFileSync(path.join(project, 'Challenge.lean'), challenge);
    receipt.contract.formalStatement = challenge;
    const payload = canonicalMathProblemStatementPayloads(receipt.contract);
    receipt.contract.statementHash = mathDigest(payload.informal);
    receipt.contract.leanStatementHash = mathDigest(payload.lean);
    receipt.publicObligations = ['first', 'second'].map(local => `LeanEval.${namespace ? `${namespace}.` : ''}${local}`).map(name => ({ name,
      declarationHash: hashMathFormalSourceDeclaration(challenge, name) }));
    fs.writeFileSync(problem.activeProblemPath, JSON.stringify(receipt));
    git(workspace, ['add', 'generated/p/Challenge.lean']);
    commitFixture(workspace, 'Canonical challenge namespace');
    const mapped = readSolverProblem(workspace, problem.activeProblemPath);
    expect(mapped.targets.map(item => item.theoremName)).toEqual(['Submission.first', 'Submission.second']);
    expect(fs.readFileSync(path.join(project, 'Submission.lean'), 'utf8')).toBe(original);
    expect((await checkSolverProof(mapped, workspace, {})).passed).toBe(true);
    expect(host.verify.mock.calls[0][0].items.map(item => item.theoremName)).toEqual(['Submission.first', 'Submission.second']);
  });

  it('keeps an exact qualified target when another namespace has the same declaration header', () => {
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replace('end Submission',
      'namespace Nested\ntheorem first : True := by trivial\nend Nested\nend Submission'));
    expect(readSolverProblem(workspace, problem.activeProblemPath).targets.map(item => item.theoremName))
      .toEqual(['Submission.first', 'Submission.second']);
  });

  it('reuses identical Lean rejections across notes while rechecking changed proofs and source constraints', async () => {
    host.verify.mockImplementation(async request => failed(verified(request), { stdoutPreview: unsolved }));
    const env = { DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'math.env') };
    const first = await checkSolverProof(problem, workspace, env);
    expect(await checkSolverProof(problem, workspace, env, undefined, first)).toBe(first);
    expect(host.verify).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
    const changed = await checkSolverProof(problem, workspace, env, undefined, first);
    expect(changed.commit).not.toBe(first.commit);
    expect(host.verify).toHaveBeenCalledTimes(2);
    fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), 'A different proof route');
    const notes = await checkSolverProof(problem, workspace, env, undefined, changed);
    expect(notes.sourceDigest).toBe(changed.sourceDigest);
    expect(notes.commit).not.toBe(changed.commit);
    expect(notes.verification).toBe(changed.verification);
    expect(notes.verification.targetCommit).toBe(changed.commit);
    expect(host.verify).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    controller.abort();
    await expect(checkSolverProof(problem, workspace, env, controller.signal, notes)).rejects.toThrow();
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replace('first : True', 'first : False'));
    await expect(checkSolverProof(problem, workspace, env, undefined, notes)).rejects.toThrow('math_original_declaration_changed');
    expect(host.verify).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['kernel_verified', undefined, undefined],
    ['failed', 'Process exited without Lean diagnostics', undefined],
    ['failed', 'Submission.lean:4:1: error: unsolved goals', 'checkout cleanup failed'],
    ['blocked', 'Submission.lean:4:1: error: unsolved goals', undefined],
    ['unavailable', 'Submission.lean:4:1: error: unsolved goals', undefined],
  ] as const)('rechecks non-reusable results (status %s, output %s, cleanup %s)', async (status, stdoutPreview, cleanupError) => {
    host.verify.mockImplementation(async request => ({ ...verified(request), status,
      results: verified(request).results.map(item => ({ ...item, status, stdoutPreview, cleanupError })) }));
    const first = await checkSolverProof(problem, workspace, {});
    expect(await checkSolverProof(problem, workspace, {}, undefined, first)).not.toBe(first);
    expect(host.verify).toHaveBeenCalledTimes(2);
  });

  it('checks in the isolated worktree, closes the model, rechecks integration and scores independently', async () => {
    host.verify.mockImplementation(async request => {
      if (host.verify.mock.calls.length === 1) {
        const checkout = path.resolve(request.projectRoot, '../..');
        expect(path.basename(checkout)).toBe('worktree');
        expect(path.basename(path.dirname(checkout))).toMatch(/^math-check-/u);
        expect(git(checkout, ['status', '--porcelain'])).toBe('');
        expect(fs.readFileSync(path.join(request.projectRoot, 'Submission.lean'), 'utf8'))
          .toBe(original.replaceAll('by sorry', 'by trivial'));
      }
      return verified(request);
    });
    expect(await runSolver(args, directory)).toBe(0);
    const result = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(result).toMatchObject({ status: 'evaluated_passed', solver_ready_receipt_valid: true,
      completion_signal_valid: true, evaluator: { official: true, method: 'official-comparator' } });
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(host.verify.mock.calls[0][0].projectRoot).not.toBe(path.join(`${output}.runtime/worktree`, 'generated/p'));
    expect(host.verify.mock.calls[1][0].projectRoot).toBe(project);
    expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(result.solution_commit);
    const session = await host.createSession.mock.results[0].value;
    expect(session.close).toHaveBeenCalledBefore(host.officialGate);
    expect(await runSolver([...args, '--resume'], directory)).toBe(0);
    expect(host.createSession).toHaveBeenCalledTimes(1);
  });

  it.each(['winner', 'main'])('rejects completed-result reuse after the %s proof changes', async location => {
    expect(await runSolver(args, directory)).toBe(0);
    const worktree = location === 'main' ? workspace : path.join(`${output}.runtime`, 'worktree');
    const file = path.join(worktree, 'generated/p/Submission.lean');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('by trivial', 'by exact True.intro'));
    expect(await runSolver([...args, '--resume'], directory)).toBe(1);
    expect(host.createSession).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('math_resume_completed_proof_changed'));
  });

  it('rejects malformed restored control state before starting a model', async () => {
    expect(await runSolver([...args, '--startup-only'], directory)).toBe(0);
    const stateFile = `${output}.runtime/state.json`, state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.turns = -1; fs.writeFileSync(stateFile, JSON.stringify(state));
    expect(await runSolver([...args, '--resume'], directory)).toBe(1);
    expect(host.createSession).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('math_resume_state_invalid:turns'));
  });

  it.each(['uncommitted', 'committed'])('rejects a %s change to the main workspace before adopting a checked proof', async change => {
    let changedHead: string;
    const check = async (...inputs: Parameters<typeof checkSolverProof>) => {
      const receipt = await checkSolverProof(...inputs);
      fs.writeFileSync(path.join(project, 'Submission.lean'), original.replaceAll('by sorry', 'by exact True.intro'));
      if (change === 'committed') commitSolverSources(problem, workspace);
      changedHead = git(workspace, ['rev-parse', 'HEAD']);
      return receipt;
    };
    expect(await runSolver(args, directory, { ...directSolverModules, M2: { ...directSolverModules.M2, check } })).toBe(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'runtime_error', reason: 'math_main_workspace_changed' });
    expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(changedHead);
    expect(fs.readFileSync(path.join(project, 'Submission.lean'), 'utf8')).toContain('by exact True.intro');
    expect(host.verify).toHaveBeenCalledOnce();
    expect(host.officialGate).not.toHaveBeenCalled();
  });

  it('allows replacing context construction without replacing the executor or final acceptance', async () => {
    const execute = vi.fn(directSolverModules.M1.execute);
    const check = vi.fn(directSolverModules.M2.check);
    const build = vi.fn((...inputs: Parameters<typeof directSolverModules.M4.build>) => {
      const context = directSolverModules.M4.build(...inputs);
      return { ...context, message: `${context.message}\nTest context policy`, instructions: `${context.instructions}\nTest context policy` };
    });
    const modules = { ...directSolverModules, M1: { ...directSolverModules.M1, execute },
      M2: { ...directSolverModules.M2, check }, M4: { version: 'test-context-v1', build } };
    expect(await runSolver(args, directory, modules)).toBe(0);
    expect(execute.mock.calls[0][1]).toMatchObject({ scope: 'original-problem-and-allowed-library',
      sources: { problemReceiptDigest: problem.receiptDigest } });
    expect(execute.mock.calls[0][1].message).toContain('Test context policy');
    expect(host.createSession.mock.calls[0][0].instructions).toContain('Test context policy');
    expect(check).toHaveBeenCalledTimes(1);
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(host.officialGate).toHaveBeenCalledTimes(1);
    const state = JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8'));
    expect(state.candidate).toMatchObject({ problemReceiptDigest: problem.receiptDigest, operation: 'direct',
      provenance: { workerId: 'solver', threadId: 'fixture-thread' } });
    expect(state.methodDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  const planTasks = (): CooperativeTask[] => [
    ...['a', 'b'].map(id => ({ id, kind: 'lemma' as const, objective: `Prove helper ${id}`, dependsOn: [],
      proofPath: 'Submission.lean', theoremName: `Submission.${id}`, type: 'True', revision: 0 })),
    { id: 'first', kind: 'goal', objective: 'Combine both helpers', dependsOn: ['a', 'b'],
      proofPath: 'Submission.lean', theoremName: 'Submission.first', revision: 0 },
    { id: 'second', kind: 'goal', objective: 'Use the checked first goal', dependsOn: ['first'],
      proofPath: 'Submission.lean', theoremName: 'Submission.second', revision: 0 },
  ];
  const reviewedPlanTasks = (): CooperativeTask[] => [...planTasks(), {
    id: 'candidate_audit', kind: 'research', objective: 'Independently inspect the completed candidate.',
    dependsOn: [], revision: 0, reviewScope: 'final-candidate',
  }];
  // Receipt replay and concurrency fixtures prepare helpers under ordinary dependency waiting.
  const waitingPlanTasks = () => planTasks().map(task => task.kind === 'goal' ? { ...task, conditional: false } : task);
  const writePlan = (worktree: string, tasks: readonly CooperativeTask[], groups?: readonly RouteGroup[],
    researchDecisions?: unknown[]) =>
    fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), '```math-plan\n' + JSON.stringify({ tasks, groups, researchDecisions }) + '\n```\n');

  it('rejects forward original-goal dependencies and accepts a shared helper before both goals', () => {
    const tasks = planTasks();
    tasks[2] = { ...tasks[2], dependsOn: ['second'] };
    tasks[3] = { ...tasks[3], dependsOn: [] };
    expect(() => parseCooperationPlan(problem, { tasks })).toThrow('math_plan_forward_goal_dependency: first precedes second');
    tasks[2] = { ...tasks[2], dependsOn: ['a'] };
    tasks[3] = { ...tasks[3], dependsOn: ['a'] };
    expect(() => parseCooperationPlan(problem, { tasks })).not.toThrow();
  });

  it.each(['lemma', 'research', 'sketch'])('rejects a copied prompt placeholder before assigning %s proof work', kind => {
    const tasks = planTasks();
    expect(() => parseCooperationPlan(problem, { tasks: [
      { ...tasks[0], kind, type: ' FULL_CLOSED_LEAN_TYPE ' }, ...tasks.slice(1),
    ] })).toThrow('math_plan_placeholder_helper_type');
    expect(host.createSession).not.toHaveBeenCalled();
  });

  it.each(['research', 'sketch'])('treats typed %s tasks as lemma work while keeping advisory tasks read-only', kind => {
    const tasks = planTasks();
    const parsed = parseCooperationPlan(problem, { tasks: [
      { ...tasks[0], kind }, ...tasks.slice(1),
      { id: 'advice', kind, objective: 'Explore possible methods' },
    ] });
    expect(parsed.tasks[0]).toMatchObject({ kind: 'lemma', theoremName: 'Submission.a', type: 'True', proofPath: 'Submission.lean' });
    expect(parsed.tasks.at(-1)).toEqual({ id: 'advice', kind, objective: 'Explore possible methods', dependsOn: [], revision: 0 });
    expect(() => parseCooperationPlan(problem, { tasks: [{ ...tasks[0], kind, type: 123 }, ...tasks.slice(1)] })).not.toThrow(TypeError);
  });
  const assignmentFrom = (message: string) => JSON.parse(message.match(/Cooperative assignment:\n([^\n]+)/u)![1]) as CooperativeAction;
  function configureCooperation(run?: (action: CooperativeAction, options: MathAgentOptions, message: string) => Promise<string>,
    plan: () => CooperativeTask[] = planTasks) {
    const threadCalls = new Map<string, number>();
    host.verify.mockImplementation(async (request, options) => {
      const source = fs.readFileSync(path.join(request.projectRoot, 'Submission.lean'), 'utf8');
      const wrongType = request.items.some(item =>
        (options.expectedDeclarationType || options.expectedDeclarationTypes?.[item.theoremName]) &&
        source.includes(`${item.theoremName.split('.').at(-1)} : False`));
      const checked = verified(request);
      return !source.includes('sorry') && !wrongType ? checked
        : failed(checked, { stdoutPreview: 'Submission.lean:3:1: error: task type mismatch or unfinished proof\n⊢ True' });
    });
    host.createSession.mockImplementation(async (options: MathAgentOptions) => {
      const threadId = options.threadId || `thread-${options.environment!.DEEPSCIENTIST_MATH_WORKER_ID}`;
      if (!options.threadId) threadCalls.set(threadId, 0);
      return {
        threadId,
        close: vi.fn(), interrupt: vi.fn(), run: async (message: string) => {
          const calls = (threadCalls.get(threadId) ?? 0) + 1;
          threadCalls.set(threadId, calls);
          options.onUsage({ inputTokens: calls * 1000, totalTokens: calls * 1200 });
          const action = assignmentFrom(message);
          if (run) return run(action, options, message);
          if (action.kind === 'lead') writePlan(options.workspace, plan());
          else finishAssignment(action, options);
          return 'completed';
        },
      };
    });
  }


  function finishAssignment(action: CooperativeAction, options: MathAgentOptions) {
    if (action.kind === 'lead') { writePlan(options.workspace, planTasks()); return; }
    if (isStatementAction(action)) {
      fs.writeFileSync(path.join(options.workspace, 'RESEARCH.md'), '```' + (action.kind === 'backtranslate' ? 'math-backtranslation' : 'math-statement-review') + '\n' + JSON.stringify({
        reviewId: action.reviewId, snapshotDigest: action.snapshotDigest,
        ...(action.kind === 'backtranslate' ? { mathematics: 'The proposition True holds.', assumptions: [], definitions: [], evidenceRefs: ['STATEMENT.json'] } :
          { verdict: 'accepted', summary: 'The fixed translation agrees with the intended proposition.', evidenceRefs: ['STATEMENT.json'] }),
      }) + '\n```'); return;
    }
    if (action.kind === 'review') {
      fs.writeFileSync(path.join(options.workspace, 'RESEARCH.md'), '```math-review\n' + JSON.stringify({
        commit: action.seedCommit, verdict: 'accepted', summary: 'Both original targets are proved with matching premises.', evidenceRefs: ['Submission.first', 'Submission.second'],
      }) + '\n```'); return;
    }
    if (action.kind !== 'task') throw new Error('assembly_must_not_call_model');
    const file = path.join(options.workspace, 'generated/p/Submission.lean');
    const source = fs.readFileSync(file, 'utf8');
    const id = action.task.id;
    if (action.task.kind === 'lemma') fs.writeFileSync(file, source.includes(`lemma ${id} : True`)
      ? source.replace(`lemma ${id} : True := by sorry`, `lemma ${id} : True := by trivial`)
      : source.replace('theorem first', `lemma ${id} : True := by trivial\ntheorem first`));
    else if (id === 'first') {
      if (!action.assignment.connectionCheck) {
        expect(source).toContain('lemma a : True := by trivial');
        expect(source).toContain('lemma b : True := by trivial');
      }
      fs.writeFileSync(file, source.replace('first : True := by sorry', 'first : True := by exact And.left (And.intro a b)'));
    } else fs.writeFileSync(file, source.replace('second : True := by sorry', 'second : True := by exact first'));
  }

  it('accepts larger cooperative plans and preserves their full mathematical content', () => {
    const type = '(True ∧ '.repeat(1000) + 'True' + ')'.repeat(1000);
    const premises = ['P'.repeat(2001), ...Array(32).fill('A')];
    const tasks: CooperativeTask[] = [...planTasks(), ...Array.from({ length: 29 }, (_, index) => ({
      id: `question-${index}`, kind: 'research' as const, objective: 'Explore an independent question', dependsOn: [], revision: 0,
    }))];
    tasks[0] = { ...tasks[0], objective: 'O'.repeat(2001), type, premises, statementReview: true, informalStatement: 'M'.repeat(8001) };
    const groups: RouteGroup[] = [{ id: 'main', objective: 'G'.repeat(2001), status: 'active', revision: 0, maxConcurrent: 4 },
      ...Array.from({ length: 16 }, (_, index) => ({ id: `route-${index}`, objective: 'Explore another route', status: 'active' as const, revision: 0 }))];
    writePlan(workspace, tasks, groups);
    const plan = readCooperationPlan(problem, workspace);
    expect(plan.tasks).toHaveLength(33); expect(plan.groups).toEqual(groups);
    expect(plan.tasks[0]).toMatchObject(tasks[0]);
    expect(() => parseCooperationPlan(problem, { ...plan, tasks: plan.tasks.filter(task => task.id !== 'second') }))
      .toThrow('math_plan_incomplete_original_coverage');
    expect(() => parseCooperationPlan(problem, { ...plan, tasks: plan.tasks.map(task => task.id === 'a' ? { ...task, dependsOn: ['first'] } : task) }))
      .toThrow('math_plan_dependency_cycle');
    expect(() => parseCooperationPlan(problem, { ...plan, tasks: plan.tasks.map(task => task.id === 'a' ? { ...task, premises: [123] } : task) }))
      .toThrow('math_plan_invalid_task');
  });

  it('reads an explicitly empty route list as the implicit main route', () => {
    const tasks = planTasks().map(task => ({ ...task, groupId: undefined }));
    const planned = parseCooperationPlan(problem, { tasks, groups: [] });
    expect(planned.groups).toEqual([{ id: 'main', objective: 'Prove the original problem', status: 'active', revision: 0 }]);
    expect(planned.tasks.every(task => task.groupId === undefined)).toBe(true);
    expect(parseCooperationPlan(problem, { tasks })).toEqual(planned);
  });

  it('applies revised M4 instructions while resuming the same model thread', async () => {
    const seen: string[] = [], emitted: string[] = [];
    let calls = 0;
    host.verify.mockImplementationOnce(async request => failed(verified(request)));
    host.createSession.mockImplementation(async (options: MathAgentOptions) => ({ threadId: 'audit-thread', close: vi.fn(), interrupt: vi.fn(),
      run: async () => {
        seen.push(options.instructions ?? ''); calls++;
        fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', `by\n  -- ${calls}\n  trivial`));
        return 'completed';
      } }));
    const build = (...inputs: Parameters<typeof directSolverModules.M4.build>) => {
      const bundle = directSolverModules.M4.build(...inputs);
      return { ...bundle, instructions: bundle.instructions + `\nAUDIT_PHASE_${inputs[1].turns}` };
    };
    const execute = async (...inputs: Parameters<typeof directSolverModules.M1.execute>) => {
      emitted.push(inputs[1].instructions); return directSolverModules.M1.execute(...inputs);
    };
    expect(await runSolver([...args, '--max-turns', '2'], directory,
      { ...directSolverModules, M4: { ...directSolverModules.M4, build }, M1: { ...directSolverModules.M1, execute } })).toBe(0);
    expect(emitted[1]).toContain('AUDIT_PHASE_1');
    expect(seen[1]).toContain('AUDIT_PHASE_1'); expect(seen[1]).not.toContain('AUDIT_PHASE_0');
    expect(host.createSession).toHaveBeenCalledTimes(2);
    expect(host.createSession.mock.calls[1][0].threadId).toBe('audit-thread');
  });



  const budgetFixturePlan = () => waitingPlanTasks().map(task => task.id === 'a' ? { ...task, ownerId: 'researcher-1' }
    : task.id === 'b' ? { ...task, ownerId: 'researcher-2' } : task);


  it('prefers an explicit research response and rejects ambiguous legacy blocks', () => {
    const file = path.join(workspace, 'RESEARCH.md');
    fs.writeFileSync(file, '```math\n{"summary":"first"}\n```\n```math-result\n{"summary":"second"}\n```');
    expect(readMathResponse(workspace, 'math-result').summary).toBe('second');
    expect(readMathResponse(workspace, 'math-result', {}, 'summary').summary).toBe('second');
    fs.writeFileSync(file, '```math\n{"summary":"first"}\n```\n```json\n{"summary":"second"}\n```');
    expect(() => readMathResponse(workspace, 'math-result')).toThrow('requires_one_block');
    expect(() => readMathResponse(workspace, 'math-result', {}, 'summary')).toThrow('requires_one_block');
    fs.writeFileSync(file, '```math\n{"commit":"wrong-version","summary":"first"}\n```');
    expect(readMathResponse(workspace, 'math-review', { commit: 'assigned-version' }).commit).toBe('wrong-version');
  });

  it('does not parse an inherited plan fence as Markdown research findings', () => {
    writePlan(workspace, planTasks());
    expect(() => readMathResponse(workspace, 'math-result', {}, 'summary')).toThrow('requires_one_block');
    fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), '# Findings\nUse True.intro.\n\n```lean\nexact True.intro\n```');
    expect(readMathResponse(workspace, 'math-result', {}, 'summary').summary).toContain('Use True.intro.');
  });

  it('bounds a 3007-character advisory summary without discarding its verdict, evidence or raw response', () => {
    const value = { verdict: 'changes_requested', summary: 'x'.repeat(3007), evidenceRefs: ['STATEMENT.json'], remainingObligations: ['Resolve the coefficient'] };
    const raw = '```math\n' + JSON.stringify(value) + '\n```';
    fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), raw);
    const response = readMathResponse(workspace, 'math-statement-review');
    const details = deliveryDetails(response);
    expect(response.verdict).toBe('changes_requested'); expect(details.summary).toHaveLength(3000);
    expect(details.evidenceRefs).toEqual(value.evidenceRefs); expect(details.remainingObligations).toEqual(value.remainingObligations);
    expect(fs.readFileSync(path.join(workspace, 'RESEARCH.md'), 'utf8')).toBe(raw);
    expect(deliveryDetails({ ...value, evidenceRefs: [123, 'STATEMENT.json'] }).evidenceRefs).toEqual(['STATEMENT.json']);
    expect(() => deliveryDetails({ ...value, remainingObligations: [123] })).toThrow('math_delivery_invalid');
    fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), 'x'.repeat(64001));
    expect(readMathResponse(workspace, 'math-result', {}, 'summary').summary).toHaveLength(64001);
    fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), JSON.stringify({ ...value, summary: 'x'.repeat(100000) }));
    expect(deliveryDetails(readMathResponse(workspace, 'math-statement-review')).summary).toHaveLength(3000);
  });

  it('preserves long mathematical explanations, premises and obligations without field quotas', () => {
    const mathematics = 'x'.repeat(8001), assumptions = ['y'.repeat(2001), ...Array(32).fill('A')];
    const value = { mathematics, assumptions, definitions: assumptions, statement: mathematics, premises: assumptions,
      remainingObligations: assumptions, evidenceRefs: 'STATEMENT.json' };
    fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), JSON.stringify(value));
    const response = readMathResponse(workspace, 'math-backtranslation');
    expect(readBacktranslation(response)).toEqual({ mathematics, assumptions, definitions: assumptions, evidenceRefs: ['STATEMENT.json'] });
    expect(deliveryDetails(response)).toEqual({ summary: '', statement: mathematics, premises: assumptions,
      remainingObligations: assumptions, evidenceRefs: ['STATEMENT.json'] });
  });

  it('identifies changed inherited helper parameters and permits newly named helpers', () => {
    const file = path.join(project, 'Submission.lean');
    const seedSource = original.replace('end Submission', 'lemma kept : True := by trivial\nend Submission');
    fs.writeFileSync(file, seedSource);
    const seedCommit = commitSolverSources(problem, workspace);
    const task: CooperativeTask = { id: 'candidate', kind: 'lemma', objective: 'Prove a new helper', dependsOn: [], revision: 0,
      proofPath: 'Submission.lean', theoremName: 'Submission.candidate', type: 'True' };
    const edited = seedSource.replace('lemma kept : True := by trivial', 'lemma kept (h : True) : True := by exact h');
    fs.writeFileSync(file, edited);
    const rejectedCommit = commitSolverSources(problem, workspace);
    expect(() => taskChanges(problem, workspace, rejectedCommit, task, { seedCommit }))
      .toThrow(new RegExp('math_task_existing_declaration_changed[\\s\\S]*Submission\\.lean[\\s\\S]*kept[\\s\\S]*' + seedCommit));
    fs.writeFileSync(file, seedSource.replace('end Submission', 'lemma candidate : True := by trivial\nend Submission'));
    const acceptedCommit = commitSolverSources(problem, workspace);
    expect(taskChanges(problem, workspace, acceptedCommit, task, { seedCommit })).toMatchObject([
      { file: 'Submission.lean', name: 'candidate', after: 'lemma candidate : True := by trivial\n' },
    ]);
  });

  it('merges prerequisite moves before an original goal without discarding peer additions', async () => {
    const file = path.join(project, 'Submission.lean');
    const helper = 'lemma prerequisite : True := by trivial\n';
    const seed = original.replace('end Submission', helper + 'end Submission');
    fs.writeFileSync(file, seed);
    const seedCommit = commitSolverSources(problem, workspace);
    const task: CooperativeTask = { id: 'first', kind: 'goal', objective: 'Prove the first target', dependsOn: [], revision: 0,
      proofPath: 'Submission.lean', theoremName: 'Submission.first' };
    const candidate = original.replace('theorem first', helper + 'theorem first').replace('first : True := by sorry', 'first : True := by exact prerequisite');
    fs.writeFileSync(file, candidate);
    const changes = taskChanges(problem, workspace, commitSolverSources(problem, workspace), task, { seedCommit });
    await withSolverWorktree(workspace, seedCommit, async checkout => {
      const mergedFile = path.join(checkout, problem.projectRelative, 'Submission.lean');
      fs.writeFileSync(mergedFile, seed.replace('end Submission', 'lemma peer : True := by trivial\nend Submission'));
      applyTaskChanges(problem, checkout, changes);
      const merged = fs.readFileSync(mergedFile, 'utf8');
      expect(merged.indexOf('lemma prerequisite')).toBeLessThan(merged.indexOf('theorem first'));
      expect(merged).toContain('first : True := by exact prerequisite');
      expect(merged).toContain('lemma peer : True := by trivial');
      applyTaskChanges(problem, checkout, changes);
      expect(fs.readFileSync(mergedFile, 'utf8')).toBe(merged);
    });
  });

  it('moves an original goal with its document comment after existing helpers and preserves peer additions', async () => {
    const file = path.join(project, 'Submission.lean');
    const documentation = '/-- The original goal remains unchanged.\nA nested /- explanatory comment -/ belongs to this declaration.\nThe proof may use checked helpers. -/\n';
    const frozen = original.replace('theorem first', documentation + 'theorem first');
    fs.writeFileSync(file, frozen);
    git(workspace, ['add', '--', 'generated/p/Submission.lean']);
    commitFixture(workspace, 'Freeze the documented original goal');
    problem = readSolverProblem(workspace, problem.activeProblemPath);
    const helpers = 'lemma prerequisite : True := by trivial\nlemma closing : True := prerequisite\n';
    const seed = frozen.replace('theorem second', helpers + 'theorem second');
    fs.writeFileSync(file, seed);
    const seedCommit = commitSolverSources(problem, workspace);
    const task: CooperativeTask = { id: 'first', kind: 'goal', objective: 'Prove the first target', dependsOn: [], revision: 0,
      proofPath: 'Submission.lean', theoremName: 'Submission.first' };
    const proved = 'theorem first : True := by exact closing\n';
    const candidate = frozen.replace(documentation + 'theorem first : True := by sorry\n', helpers + documentation + proved);
    fs.writeFileSync(file, candidate);
    const changes = taskChanges(problem, workspace, commitSolverSources(problem, workspace), task, { seedCommit });
    expect(changes).toContainEqual(expect.objectContaining({ name: 'first', afterName: 'closing' }));
    await withSolverWorktree(workspace, seedCommit, async checkout => {
      const mergedFile = path.join(checkout, problem.projectRelative, 'Submission.lean');
      fs.writeFileSync(mergedFile, seed.replace('end Submission', 'lemma peer : True := by trivial\nend Submission'));
      applyTaskChanges(problem, checkout, changes);
      const merged = fs.readFileSync(mergedFile, 'utf8');
      expect(merged).toContain(documentation + proved);
      expect(merged.indexOf('lemma closing')).toBeLessThan(merged.indexOf(documentation));
      expect(merged).toContain('lemma peer : True := by trivial');
      expect(merged.split(documentation)).toHaveLength(2);
      expect(() => assertSolverSources(problem, checkout)).not.toThrow();
      applyTaskChanges(problem, checkout, changes);
      expect(fs.readFileSync(mergedFile, 'utf8')).toBe(merged);
    });
    expect(host.createSession).not.toHaveBeenCalled();
  });

  it('keeps an original goal document comment attached when discharging a later conditional input', async () => {
    const file = path.join(project, 'Submission.lean');
    const documentation = '/-- The original goal remains unchanged.\nIts checked input may arrive later.\nThis documentation belongs to the goal. -/\n';
    const frozen = original.replace('theorem first', documentation + 'theorem first');
    fs.writeFileSync(file, frozen);
    git(workspace, ['add', '--', 'generated/p/Submission.lean']);
    commitFixture(workspace, 'Freeze a documented conditional consumer');
    problem = readSolverProblem(workspace, problem.activeProblemPath);
    const seedCommit = problem.baseCommit;
    const task: CooperativeTask = { id: 'first', kind: 'goal', objective: 'Prove the first target', dependsOn: ['prerequisite'], revision: 0,
      proofPath: 'Submission.lean', theoremName: 'Submission.first', conditional: true };
    const input: CooperativeTask = { id: 'prerequisite', kind: 'lemma', objective: 'Prove the input', dependsOn: [], revision: 0,
      proofPath: 'Submission.lean', theoremName: 'Submission.prerequisite', type: 'True' };
    const proved = 'theorem first : True := by exact prerequisite\n';
    fs.writeFileSync(file, frozen.replace('theorem first : True := by sorry\n', proved));
    const changes = taskChanges(problem, workspace, commitSolverSources(problem, workspace), task, { seedCommit });
    expect(changes.every(change => !change.afterName)).toBe(true);
    await withSolverWorktree(workspace, seedCommit, async checkout => {
      const mergedFile = path.join(checkout, problem.projectRelative, 'Submission.lean');
      fs.writeFileSync(mergedFile, frozen.replace('theorem second',
        'lemma prerequisite : True := by trivial\nlemma peer : True := by trivial\ntheorem second'));
      applyTaskChanges(problem, checkout, changes, [], [input]);
      const merged = fs.readFileSync(mergedFile, 'utf8');
      expect(merged).toContain(documentation + proved);
      expect(merged.indexOf('lemma prerequisite')).toBeLessThan(merged.indexOf(documentation));
      expect(merged).toContain('lemma peer : True := by trivial');
      expect(() => assertSolverSources(problem, checkout)).not.toThrow();
      applyTaskChanges(problem, checkout, changes, [], [input]);
      expect(fs.readFileSync(mergedFile, 'utf8')).toBe(merged);
    });
    expect(host.createSession).not.toHaveBeenCalled();
  });

  it('inserts a new helper before an original goal document comment without stealing its documentation', async () => {
    const file = path.join(project, 'Submission.lean');
    const documentation = '/-- The original goal remains unchanged.\nThis is the original statement documentation.\nIt must stay attached to the goal. -/\n';
    const frozen = original.replace('theorem first', documentation + 'theorem first');
    fs.writeFileSync(file, frozen);
    git(workspace, ['add', '--', 'generated/p/Submission.lean']);
    commitFixture(workspace, 'Freeze a documented helper insertion anchor');
    problem = readSolverProblem(workspace, problem.activeProblemPath);
    const seedCommit = problem.baseCommit;
    const helper = 'lemma prerequisite : True := by trivial\n';
    fs.writeFileSync(file, frozen.replace(documentation, helper + documentation));
    const task: CooperativeTask = { id: 'first', kind: 'goal', objective: 'Prove the first target', dependsOn: [], revision: 0,
      proofPath: 'Submission.lean', theoremName: 'Submission.first' };
    const changes = taskChanges(problem, workspace, commitSolverSources(problem, workspace), task, { seedCommit });
    expect(changes).toMatchObject([{ name: 'prerequisite', beforeName: 'first' }]);
    await withSolverWorktree(workspace, seedCommit, async checkout => {
      const mergedFile = path.join(checkout, problem.projectRelative, 'Submission.lean');
      fs.writeFileSync(mergedFile, frozen.replace('end Submission', 'lemma peer : True := by trivial\nend Submission'));
      applyTaskChanges(problem, checkout, changes);
      const merged = fs.readFileSync(mergedFile, 'utf8');
      expect(merged).toContain(helper + documentation + 'theorem first');
      expect(merged).toContain('lemma peer : True := by trivial');
      expect(() => assertSolverSources(problem, checkout)).not.toThrow();
      applyTaskChanges(problem, checkout, changes);
      expect(fs.readFileSync(mergedFile, 'utf8')).toBe(merged);
    });
    expect(host.createSession).not.toHaveBeenCalled();
  });

  it('keeps a helper added at the end of a namespace block in that block when a later block opens another namespace', async () => {
    const helper = 'Submission/Helpers.lean';
    const seed = 'namespace Submission.Helpers\ndef base : Nat := 2\nend Submission.Helpers\n\n' +
      'namespace Submission.Helpers.Spec\ndef Statement : Prop := Submission.Helpers.base = 2\nend Submission.Helpers.Spec\n';
    fs.mkdirSync(path.join(project, 'Submission'));
    fs.writeFileSync(path.join(project, helper), seed);
    const receipt = JSON.parse(fs.readFileSync(problem.activeProblemPath, 'utf8'));
    receipt.solverOwnedFiles.push(helper);
    fs.writeFileSync(problem.activeProblemPath, JSON.stringify(receipt));
    git(workspace, ['add', '--', `generated/p/${helper}`]);
    commitFixture(workspace, 'Owned helper module with a later specification namespace');
    problem = readSolverProblem(workspace, problem.activeProblemPath);
    const task: CooperativeTask = { id: 'first', kind: 'goal', objective: 'Prove the first target', dependsOn: [], revision: 0,
      proofPath: 'Submission.lean', theoremName: 'Submission.first' };
    const lemmas = 'lemma base_eq : base = 2 := rfl\nlemma base_pos : 0 < base := by rw [base_eq]; decide\n';
    fs.writeFileSync(path.join(project, helper), seed.replace('end Submission.Helpers\n\n', lemmas + 'end Submission.Helpers\n\n'));
    const changes = taskChanges(problem, workspace, commitSolverSources(problem, workspace), task, { seedCommit: problem.baseCommit });
    expect(changes).toMatchObject([{ name: 'base_eq', afterName: 'base' }, { name: 'base_pos', afterName: 'base_eq' }]);
    await withSolverWorktree(workspace, problem.baseCommit, async checkout => {
      const file = path.join(checkout, problem.projectRelative, helper);
      fs.writeFileSync(file, seed.replace('def base : Nat := 2\n', 'def base : Nat := 2\nlemma peer : True := by trivial\n'));
      applyTaskChanges(problem, checkout, changes);
      const source = fs.readFileSync(file, 'utf8');
      expect(inspectScopedLeanDeclarations(source).map(item => item.qualifiedName)).toEqual(['Submission.Helpers.base',
        'Submission.Helpers.base_eq', 'Submission.Helpers.base_pos', 'Submission.Helpers.peer', 'Submission.Helpers.Spec.Statement']);
      applyTaskChanges(problem, checkout, changes);
      expect(fs.readFileSync(file, 'utf8')).toBe(source);
      // A replayed insertion is not a move: a later peer helper anchored on the same sibling keeps its place.
      applyTaskChanges(problem, checkout, [{ file: helper, name: 'later', after: 'lemma later : True := by trivial\n', afterName: 'base' }]);
      const withLater = fs.readFileSync(file, 'utf8');
      applyTaskChanges(problem, checkout, changes);
      expect(fs.readFileSync(file, 'utf8')).toBe(withLater);
    });
  });

  it('rejects a typed task check whose exact declaration name is absent instead of crashing the type query', async () => {
    fs.writeFileSync(path.join(project, 'Submission.lean'),
      original.replace('end Submission', 'lemma helper : True := by trivial\nend Submission'));
    const commit = commitSolverSources(problem, workspace);
    await withSolverWorktree(workspace, commit, async checkout => {
      const targets = [{ proofPath: 'Submission.lean', theoremName: 'Submission.Spec.helper', digest: 'a'.repeat(64),
        missingError: 'math_task_missing_declaration' }];
      await expect(checkProjectedDeclarations(problem, checkout, workspace, commit, targets,
        { timeoutMs: 1_000, expectedDeclarationType: 'True' })).rejects.toThrow(/^math_task_missing_declaration$/u);
    });
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('merges independent helpers inside an initially empty namespace', async () => {
    const helper = 'Submission/Helpers.lean';
    const empty = 'import Mathlib.Data.Nat.Basic\n\nnamespace Submission.Helpers\n\nend Submission.Helpers\n';
    fs.mkdirSync(path.join(project, 'Submission'));
    fs.writeFileSync(path.join(project, helper), empty);
    const receipt = JSON.parse(fs.readFileSync(problem.activeProblemPath, 'utf8'));
    receipt.solverOwnedFiles.push(helper);
    fs.writeFileSync(problem.activeProblemPath, JSON.stringify(receipt));
    git(workspace, ['add', '--', `generated/p/${helper}`]);
    commitFixture(workspace, 'Owned helper module');
    problem = readSolverProblem(workspace, problem.activeProblemPath);
    const task: CooperativeTask = { id: 'first', kind: 'goal', objective: 'Prove the first target', dependsOn: [], revision: 0,
      proofPath: 'Submission.lean', theoremName: 'Submission.first' };
    const changes = ['lemma a : True := by trivial\nlemma b : True := by trivial\n', 'lemma peer : True := by trivial\n'].map(proof => {
      fs.writeFileSync(path.join(project, helper), empty.replace('end Submission.Helpers', proof + 'end Submission.Helpers'));
      return taskChanges(problem, workspace, commitSolverSources(problem, workspace), task, { seedCommit: problem.baseCommit });
    });
    await withSolverWorktree(workspace, problem.baseCommit, async checkout => {
      for (const change of changes) applyTaskChanges(problem, checkout, change);
      const file = path.join(checkout, problem.projectRelative, helper);
      const source = fs.readFileSync(file, 'utf8');
      expect(inspectScopedLeanDeclarations(source).map(item => item.qualifiedName))
        .toEqual(['Submission.Helpers.a', 'Submission.Helpers.b', 'Submission.Helpers.peer']);
      expect(leanDeclarationContextCommands(source, 'Submission.Helpers.a').before).toEqual(['namespace Submission.Helpers']);
      expect(source).toContain('import Mathlib.Data.Nat.Basic');
      for (const change of changes) applyTaskChanges(problem, checkout, change);
      expect(fs.readFileSync(file, 'utf8')).toBe(source);
    });
  });

  it('checks and merges proof-only repairs and new helpers across owned files while protecting statements', async () => {
    const helper = 'Submission/Helpers.lean', module = 'Mathlib.Data.Nat.Basic';
    const seed = 'namespace Submission.Helpers\ndef generatedValue : Nat := 2\nlemma kept : True := by trivial\nend Submission.Helpers\n';
    fs.mkdirSync(path.join(project, 'Submission'));
    fs.writeFileSync(path.join(project, helper), 'namespace Submission.Helpers\nend Submission.Helpers\n');
    const receipt = JSON.parse(fs.readFileSync(problem.activeProblemPath, 'utf8'));
    receipt.solverOwnedFiles.push(helper);
    fs.writeFileSync(problem.activeProblemPath, JSON.stringify(receipt));
    git(workspace, ['add', '--', `generated/p/${helper}`]);
    commitFixture(workspace, 'Owned helper module');
    problem = readSolverProblem(workspace, problem.activeProblemPath);
    configureCooperation();
    fs.writeFileSync(path.join(project, helper), seed);
    const seedCommit = commitSolverSources(problem, workspace);
    const task = planTasks()[0], assignment = { taskId: task.id, taskDigest: taskVersion(task), workerId: 'researcher', seedCommit };
    const source = `import ${module}\n` + seed.replace('kept : True := by trivial', 'kept : True := by exact True.intro')
      .replace('end Submission.Helpers', 'lemma support : True := by trivial\nend Submission.Helpers');
    fs.writeFileSync(path.join(project, helper), source);
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replace('theorem first', 'lemma a : True := by trivial\ntheorem first'));
    const commit = commitSolverSources(problem, workspace);
    const proof = await checkTaskProof(problem, workspace, commit, task, assignment, [], {}, new AbortController().signal);
    expect(proof.passed).toBe(true);
    expect(proof.changes.map(change => [change.file, change.name])).toEqual([
      ['Submission.lean', 'a'], [helper, 'kept'], [helper, 'support'],
    ]);
    await withSolverWorktree(workspace, seedCommit, async checkout => {
      applyTaskChanges(problem, checkout, proof.changes, proof.imports);
      expect(fs.readFileSync(path.join(checkout, problem.projectRelative, helper), 'utf8')).toBe(source);
    });
    for (const modified of [source.replace('lemma kept : True', 'lemma kept (h : True) : True'),
      source.replace('generatedValue : Nat := 2', 'generatedValue : Nat := 3'),
      source.replace('lemma kept : True := by exact True.intro\n', '')]) {
      fs.writeFileSync(path.join(project, helper), modified);
      expect(() => taskChanges(problem, workspace, commitSolverSources(problem, workspace), task, assignment))
        .toThrow(/math_task_existing_declaration_(?:changed|removed)/u);
    }
    fs.writeFileSync(path.join(project, helper), source);
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replace('second : True := by sorry', 'second : True := by trivial'));
    expect(() => taskChanges(problem, workspace, commitSolverSources(problem, workspace), task, assignment))
      .toThrow('math_task_existing_declaration_changed');
  });

  it('removes orphan wrapper chains when a conditional task abstracts a saved dependency', () => {
    const file = path.join(project, 'Submission.lean');
    const source = original.replace('theorem first',
      'lemma dependency₂ : True := by trivial\nlemma dependency_wrapper : True := dependency₂\n' +
      'lemma wrapper_chain : True := dependency_wrapper\nlemma parent : True := Submission.dependency₂\n' +
      'lemma parent_wrapper : True := parent\ntheorem first');
    fs.writeFileSync(file, source);
    const commit = commitSolverSources(problem, workspace);
    const dependency: CooperativeTask = { id: 'dependency', kind: 'lemma', objective: 'Prove the premise', dependsOn: [],
      revision: 0, proofPath: 'Submission.lean', theoremName: 'Submission.dependency₂', type: 'True' };
    const task: CooperativeTask = { id: 'parent', kind: 'lemma', objective: 'Prove the connection', dependsOn: ['dependency'],
      revision: 0, proofPath: 'Submission.lean', theoremName: 'Submission.parent', type: 'True', conditional: true };
    const unconditional = createTaskSourceProjector(problem, workspace, commit)(task, []).get('Submission.lean')!;
    expect(unconditional).toContain('lemma dependency₂ : True');
    expect(unconditional).toContain('lemma dependency_wrapper : True');
    const projected = createTaskSourceProjector(problem, workspace, commit)(task, [], [dependency]).get('Submission.lean')!;
    expect(projected).toContain('lemma parent : theorem_os_conditional_type%');
    expect(projected).toContain('_root_.Submission.dependency₂');
    for (const name of ['dependency₂', 'dependency_wrapper', 'wrapper_chain', 'parent_wrapper'])
      expect(projected).not.toMatch(new RegExp(`lemma ${name} :`));
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
  });

  it.each(['sorry', 'admit'])('isolates unfinished peer proofs without assuming a required %s dependency', placeholder => {
    const file = path.join(project, 'Submission.lean');
    const source = original.replace('theorem first',
      `lemma unfinished : True := by ${placeholder}\nlemma wrapper : True := unfinished\n` +
      'lemma valid : True := by trivial\nlemma consumer : True := unfinished\ntheorem first');
    fs.writeFileSync(file, source);
    const commit = commitSolverSources(problem, workspace);
    const task: CooperativeTask = { id: 'consumer', kind: 'lemma', objective: 'Check the consumer', dependsOn: [],
      revision: 0, proofPath: 'Submission.lean', theoremName: 'Submission.consumer', type: 'True' };
    const projected = createTaskSourceProjector(problem, workspace, commit)(task, []).get('Submission.lean')!;
    expect(projected).not.toContain('lemma unfinished');
    expect(projected).not.toContain('lemma wrapper');
    expect(projected).toContain('lemma valid : True := by trivial');
    expect(projected).toContain('lemma consumer : True := unfinished');
    const targeted = createTaskSourceProjector(problem, workspace, commit)(
      { ...task, theoremName: 'Submission.unfinished' }, []).get('Submission.lean')!;
    expect(targeted).toContain(`lemma unfinished : True := by ${placeholder}`);
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
  });

  it('removes the complete noncomputable declaration prefix from an invalidated peer wrapper', () => {
      const file = path.join(project, 'Submission.lean');
      const source = original.replace('theorem first',
        'lemma premise : True := by trivial\n' +
        'noncomputable def wrapper : True := premise\n' +
        'theorem helper : True := by trivial\n' +
        'theorem consumer : True := helper\ntheorem first');
      fs.writeFileSync(file, source);
      const commit = commitSolverSources(problem, workspace);
      const dependency: CooperativeTask = { id: 'premise', kind: 'lemma', objective: 'Prove the premise', dependsOn: [],
        revision: 0, proofPath: 'Submission.lean', theoremName: 'Submission.premise', type: 'True' };
      const task: CooperativeTask = { id: 'consumer', kind: 'lemma', objective: 'Check the conditional consumer',
        dependsOn: ['premise'], revision: 0, proofPath: 'Submission.lean', theoremName: 'Submission.consumer',
        type: 'True', conditional: true };
      const projected = createTaskSourceProjector(problem, workspace, commit)(task, [], [dependency]).get('Submission.lean')!;
      expect(projected).not.toContain('def wrapper');
      expect(projected).not.toContain('noncomputable');
      expect(projected).toContain('\ntheorem helper : True := by trivial\n');
      expect(projected).toContain('theorem consumer : theorem_os_conditional_type%');
      expect(projected).not.toContain('lemma premise');
      expect(fs.readFileSync(file, 'utf8')).toBe(source);
    });

  it('retains added Mathlib imports when checking and merging a helper proof', async () => {
    configureCooperation();
    const task = planTasks()[0], module = 'Mathlib.Analysis.SpecialFunctions.Trigonometric.InverseDeriv';
    const assignment = { taskId: task.id, taskDigest: taskVersion(task), workerId: 'researcher', seedCommit: problem.baseCommit };
    fs.writeFileSync(path.join(project, 'Submission.lean'), `import ${module}\n` +
      original.replace('theorem first', 'lemma a : True := by trivial\ntheorem first'));
    const commit = commitSolverSources(problem, workspace);
    const proof = await checkTaskProof(problem, workspace, commit, task, assignment, [], {}, new AbortController().signal);
    expect(proof.passed).toBe(true);
    expect(proof.imports).toEqual([{ file: 'Submission.lean', module }]);
    await withSolverWorktree(workspace, problem.baseCommit, async checkout => {
      const file = path.join(checkout, problem.projectRelative, 'Submission.lean');
      fs.writeFileSync(file, original.replace('theorem first', 'lemma peer : True := by trivial\ntheorem first'));
      applyTaskChanges(problem, checkout, proof.changes, proof.imports);
      const source = fs.readFileSync(file, 'utf8');
      expect(source).toContain(`import ${module}`);
      expect(source).toContain('lemma a : True := by trivial');
      expect(source).toContain('lemma peer : True := by trivial');
      expect(source).toContain('theorem first : True := by sorry');
      applyTaskChanges(problem, checkout, proof.changes, proof.imports);
      expect(fs.readFileSync(file, 'utf8')).toBe(source);
    });
  });

  it('keeps per-target receipts and closed types when batching identical proof projections', async () => {
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replace('theorem first',
      'lemma a : True := by trivial\nlemma b : True → True := by intro h; exact h\ntheorem first'));
    const commit = commitSolverSources(problem, workspace);
    const tasks = planTasks().slice(0, 2).map(task => task.id === 'b' ? { ...task, type: 'True → True' } : task);
    const proofs = await checkTaskProofs(problem, workspace, commit, tasks.map(task => ({ task, retainedGoals: [],
      assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: 'solver', seedCommit: commit } })),
      {}, new AbortController().signal);
    expect(host.verify).toHaveBeenCalledOnce();
    expect(host.verify.mock.calls[0][1].expectedDeclarationTypes).toEqual({ 'Submission.a': 'True', 'Submission.b': 'True → True' });
    expect(proofs.map(proof => ({ passed: proof.passed, taskDigest: proof.taskDigest,
      targets: proof.verification.results.map(result => result.theoremName) }))).toEqual(tasks.map(task => ({
        passed: true, taskDigest: taskVersion(task), targets: [task.theoremName] })));
  });

  it('rejects batching different source projections before invoking Lean', async () => {
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replaceAll('by sorry', 'by trivial')
      .replace('theorem first', 'lemma a : True := by trivial\ntheorem first'));
    const commit = commitSolverSources(problem, workspace);
    const tasks = [planTasks()[0], planTasks()[2]];
    await expect(checkTaskProofs(problem, workspace, commit, tasks.map(task => ({ task, retainedGoals: [],
      assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: 'solver', seedCommit: commit } })),
      {}, new AbortController().signal)).rejects.toThrow('math_task_batch_projection_mismatch');
    expect(host.verify).not.toHaveBeenCalled();
  });

  const routeGroups = (): RouteGroup[] => [
    { id: 'main', objective: 'Prove the original obligations', status: 'active', revision: 0, engineerId: 'engineer' },
    { id: 'alternative', objective: 'Test an alternative bridge', status: 'active', revision: 0, maxTurns: 2, maxConcurrent: 1 },
  ];
  const groupedTasks = () => planTasks().map(task => ({ ...task, groupId: task.id === 'b' ? 'alternative' : 'main',
    sharing: task.id === 'b' ? 'problem' as const : 'group' as const }));

  it.each(['unknown', 'private-dependency', 'concurrency', 'duplicate', 'budget'] as const)('rejects an invalid route plan (%s)', flaw => {
    const tasks = groupedTasks();
    const groups = routeGroups();
    if (flaw === 'unknown') tasks[0] = { ...tasks[0], groupId: 'unknown' };
    if (flaw === 'private-dependency') tasks[1] = { ...tasks[1], sharing: undefined };
    if (flaw === 'concurrency') groups[1] = { ...groups[1], maxConcurrent: 0 };
    if (flaw === 'duplicate') groups.push(groups[0]);
    if (flaw === 'budget') groups[1] = { ...groups[1], maxTurns: -1 };
    writePlan(workspace, tasks, groups);
    expect(() => readCooperationPlan(problem, workspace)).toThrow(/math_plan/u);
  });

  it.each(['cycle', 'missing', 'duplicate', 'coverage', 'target'])('rejects a %s plan before dispatch', flaw => {
    const tasks = planTasks();
    if (flaw === 'cycle') tasks[0] = { ...tasks[0], dependsOn: ['first'] };
    if (flaw === 'missing') tasks[0] = { ...tasks[0], dependsOn: ['unknown'] };
    if (flaw === 'duplicate') tasks.push({ ...tasks[2], id: 'duplicate' });
    if (flaw === 'coverage') tasks.pop();
    if (flaw === 'target') tasks[2] = { ...tasks[2], theoremName: 'Submission.changed' };
    writePlan(workspace, tasks);
    expect(() => readCooperationPlan(problem, workspace)).toThrow(/math_plan/u);
  });

  const cooperationState = () => JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8')).cooperation;
  const appendDelivery = (options: MathAgentOptions, action: Extract<CooperativeAction, { kind: 'task' }>, value: Record<string, unknown>) =>
    fs.appendFileSync(path.join(options.workspace, 'DELIVERIES.jsonl'), JSON.stringify({ taskId: action.task.id,
      taskDigest: action.assignment.taskDigest, evidenceRefs: [], ...value }) + '\n');

  const statementTasks = () => {
    const tasks = planTasks();
    tasks[0] = { ...tasks[0], statementReview: true, informalStatement: 'INTENT_SECRET: the proposition True holds.' };
    return tasks;
  };

  const configureStatementReferenceReports = () => {
    const prepare = host.prepare.getMockImplementation()!;
    host.prepare.mockImplementation(async input => {
      const result = await prepare(input);
      for (const file of input.files) if (/^StatementContext[0-9a-f]+\.lean$/u.test(file)) {
        const report = path.join(input.projectRoot, '.lake', file.replace('StatementContext', 'statement-context-').replace('.lean', '.json'));
        const contexts = JSON.parse(fs.readFileSync(report, 'utf8'));
        for (const context of contexts) Object.assign(context.context, { references: { statement: [], proof: [] } });
        fs.writeFileSync(report, JSON.stringify(contexts));
      }
      return result;
    });
  };

  it.each(['nonempty-metadata', 'linked-metadata', 'unexpected-directory'])('rejects unsafe or unexpected statement snapshot entries (%s)', entry => {
    const task = statementTasks()[0], reviewWorkspace = path.join(directory, 'blind');
    const snapshot = statementSnapshot(problem, task, workspace, problem.baseCommit, 'fixed-env', []);
    const review = { workspace: reviewWorkspace, files: writeStatementSnapshot(reviewWorkspace, snapshot) } as any;
    if (entry === 'linked-metadata') fs.symlinkSync(path.join(reviewWorkspace, 'definitions'), path.join(reviewWorkspace, '.codex'));
    else {
      const extra = path.join(reviewWorkspace, entry === 'nonempty-metadata' ? '.codex' : 'extra');
      fs.mkdirSync(extra);
      if (entry === 'nonempty-metadata') fs.writeFileSync(path.join(extra, 'unexpected.txt'), 'Unexpected content');
    }
    expect(() => assertStatementSnapshot(review)).toThrow('math_statement_snapshot_changed');
  });

  it('builds formal-only snapshots that bind definitions and helper dependencies but ignore goal scheduling', () => {
    const tasks = statementTasks(), snapshot = () => statementSnapshot(problem, tasks[2], workspace, git(workspace, ['rev-parse', 'HEAD']), 'fixed-env',
      [{ task: tasks[0], taskDigest: taskVersion(tasks[0]) }]);
    const before = snapshot();
    expect(before.definitions.find(definition => definition.file === 'Submission.lean')!.source)
      .toContain('namespace Submission\ndef fixed : Nat := 2\ntheorem first : True\nend Submission');
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replaceAll('by sorry', 'by trivial /- PROOF_SECRET -/'));
    commitSolverSources(problem, workspace);
    expect(snapshot().snapshotDigest).toBe(before.snapshotDigest);
    expect(JSON.stringify(snapshot())).not.toContain('PROOF_SECRET'); expect(JSON.stringify(snapshot())).not.toContain('INTENT_SECRET');
    const helperSnapshot = () => statementSnapshot(problem, tasks[1], workspace, git(workspace, ['rev-parse', 'HEAD']), 'fixed-env',
      [{ task: tasks[0], taskDigest: taskVersion(tasks[0]) }]);
    const helperBefore = helperSnapshot();
    tasks[0] = { ...tasks[0], revision: 1 };
    expect(snapshot().snapshotDigest).toBe(before.snapshotDigest);
    expect(helperSnapshot().snapshotDigest).toBe(helperBefore.snapshotDigest);
    expect(helperSnapshot().input.dependencies[0]!.taskDigest).toBe(taskVersion(tasks[0]));
    tasks[0] = { ...tasks[0], revision: 0 };
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replace('theorem first', 'def additional : Nat := 3\ntheorem first'));
    commitSolverSources(problem, workspace); expect(snapshot().snapshotDigest).not.toBe(before.snapshotDigest);
  });

  it('binds Lean-resolved imported names and definitions to the blind snapshot and detects tampering', () => {
    const task = statementTasks()[2];
    const context = { type: 'NNReal.pi / NNReal.sqrt 2', constants: [
      { name: 'NNReal.pi', module: 'Mathlib.Analysis.SpecialFunctions.Trigonometric.Basic', type: 'NNReal', definition: '⟨Real.pi, ⋯⟩' },
      { name: 'NNReal.sqrt', module: 'Mathlib.Analysis.Real.Sqrt', type: 'NNReal ≃o NNReal', definition: 'OrderIso.symm (OrderIso.pow 2 ⋯)' }], omitted: [] };
    const snapshot = statementSnapshot(problem, task, workspace, problem.baseCommit, 'fixed-env', [], context);
    expect(snapshot.input.elaboration).toEqual(context);
    expect(statementSnapshot(problem, task, workspace, problem.baseCommit, 'fixed-env', [], { ...context, type: 'Real.pi / Real.sqrt 2' }).snapshotDigest)
      .not.toBe(snapshot.snapshotDigest);
    const reviewWorkspace = path.join(directory, 'blind');
    const review = { workspace: reviewWorkspace, files: writeStatementSnapshot(reviewWorkspace, snapshot) } as any;
    expect(() => assertStatementSnapshot(review)).not.toThrow();
    fs.appendFileSync(path.join(reviewWorkspace, 'STATEMENT.json'), ' ');
    expect(() => assertStatementSnapshot(review)).toThrow('math_statement_snapshot_changed');
    expect(() => parseLeanStatementContexts(JSON.stringify([{ id: task.id, context }]), ['different-task'])).toThrow('math_statement_elaboration_invalid');
  });

  it('captures pending statement references before a helper declaration or proof exists', () => {
    const task = statementTasks()[0], context = { type: 'True', constants: [], omitted: [], references: { statement: [], proof: [] } };
    const snapshot = statementSnapshot(problem, task, workspace, problem.baseCommit, 'fixed-env', [], context);
    expect(snapshot.references).toMatchObject({ scope: 'statement', statementType: 'True', inputs: [] });
    expect(snapshot.definitions.find(definition => definition.file === task.proofPath)!.source).not.toContain('lemma a');
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replace('theorem first', 'def unrelated : Nat := 3\ntheorem first'));
    const commit = commitSolverSources(problem, workspace);
    expect(proofReferencesUnchanged(problem, workspace, commit, snapshot.references!, 'fixed-env')).toBe(true);
    expect(statementSnapshot(problem, task, workspace, commit, 'fixed-env', [], context).snapshotDigest).not.toBe(snapshot.snapshotDigest);
    expect(statementSnapshot(problem, { ...task, type: 'False' }, workspace, commit, 'fixed-env', [], { ...context, type: 'False' }).references?.statementType).toBe('False');
    expect(proofReferencesUnchanged(problem, workspace, commit, snapshot.references!, 'changed-env')).toBe(false);
  });

  it('binds the fresh local definition closure of a pending type and falls back for unknown declarations', () => {
    const file = path.join(project, 'Submission.lean');
    const source = original.replace('theorem first', 'def inner : Nat := 2\ndef selected : Nat := inner\ndef unrelated : Nat := 0\ntheorem first');
    fs.writeFileSync(file, source);
    const commit = commitSolverSources(problem, workspace), task = { ...statementTasks()[0], type: 'Submission.selected = 2' };
    const context = { type: 'Eq Nat Submission.selected 2', constants: [], omitted: ['imported definition traversal bound reached'],
      references: { statement: [{ name: 'Submission.selected', file: 'Submission.lean' }, { name: 'Submission.inner', file: 'Submission.lean' }], proof: [] } };
    const snapshot = statementSnapshot(problem, task, workspace, commit, 'fixed-env', [], context);
    expect(snapshot.references?.inputs.map(input => input.name)).toEqual(['inner', 'selected']);
    fs.writeFileSync(file, source.replace('unrelated : Nat := 0', 'unrelated : Nat := 1'));
    expect(proofReferencesUnchanged(problem, workspace, commitSolverSources(problem, workspace), snapshot.references!, 'fixed-env')).toBe(true);
    fs.writeFileSync(file, source.replace('inner : Nat := 2', 'inner : Nat := 3'));
    expect(proofReferencesUnchanged(problem, workspace, commitSolverSources(problem, workspace), snapshot.references!, 'fixed-env')).toBe(false);
    fs.writeFileSync(file, source);
    const unknown = statementSnapshot(problem, task, workspace, commit, 'fixed-env', [], { ...context,
      references: { statement: [{ name: '_private.Submission.0.generated', file: 'Submission.lean' }], proof: [] } }).references!;
    expect(unknown.inputs.some(input => input.file === 'Submission.lean' && !input.name)).toBe(true);
    fs.writeFileSync(file, source.replace('unrelated : Nat := 0', 'unrelated : Nat := 2'));
    expect(proofReferencesUnchanged(problem, workspace, commitSolverSources(problem, workspace), unknown, 'fixed-env')).toBe(false);
  });

  it.each(['import', 'notation', 'instance', 'structure'])('preserves pending statement context invalidation for %s changes', change => {
    const task = statementTasks()[0], context = { type: 'True', constants: [], omitted: [], references: { statement: [], proof: [] } };
    const references = statementSnapshot(problem, task, workspace, problem.baseCommit, 'fixed-env', [], context).references!;
    const additions: Record<string, string> = { import: 'import Mathlib.Data.Nat.Basic\n', notation: 'notation "truth" => True\n',
      instance: 'instance custom : Inhabited Nat := ⟨3⟩\n', structure: 'structure Extra where\n  value : Nat\n' };
    fs.writeFileSync(path.join(project, 'Submission.lean'), additions[change] + original);
    git(workspace, ['add', 'generated/p/Submission.lean']);
    commitFixture(workspace, 'Fingerprint context changes');
    expect(proofReferencesUnchanged(problem, workspace, git(workspace, ['rev-parse', 'HEAD']), references, 'fixed-env')).toBe(false);
  });

  it('does not infer an empty local closure from legacy or invalid statement exports', () => {
    const task = statementTasks()[0], context = { type: 'True', constants: [], omitted: [] };
    expect(statementSnapshot(problem, task, workspace, problem.baseCommit, 'fixed-env', [], context).references).toBeUndefined();
    const parse = (references: unknown) => parseLeanStatementContexts(JSON.stringify([{ id: task.id, context: { ...context, references } }]), [task.id]);
    expect(parse({ statement: [], proof: [] }).get(task.id)?.references).toEqual({ statement: [], proof: [] });
    expect(() => parse({ statement: [], proof: [{ name: 'proof', file: 'Submission.lean' }] })).toThrow('math_statement_elaboration_invalid');
    expect(() => parse({ statement: [{ name: '', file: 'Submission.lean' }], proof: [] })).toThrow('math_statement_elaboration_invalid');
    expect(() => parse({ statement: Array.from({ length: 257 }, () => ({ name: 'a', file: 'Submission.lean' })), proof: [] }))
      .toThrow('math_statement_elaboration_invalid');
    expect(statementSnapshot(problem, task, workspace, problem.baseCommit, 'fixed-env', [], { ...context,
      references: { statement: [{ name: 'outside', file: '../outside.lean' }], proof: [] } }).references).toBeUndefined();
    expect(captureProofReferences(problem, workspace, problem.baseCommit, { name: task.theoremName!, file: task.proofPath! },
      { statement: [], proof: [] }, 'fixed-env', undefined, 'True')).toBeUndefined();
  });

  it('elaborates pending types together without theorem proof bodies and releases the projection on failure', async () => {
    const tasks = statementTasks().filter(task => task.statementReview), prepare = host.prepare.getMockImplementation()!;
    fs.writeFileSync(path.join(project, 'lake-manifest.json'), JSON.stringify({ packages: [] }));
    git(workspace, ['add', 'generated/p/lake-manifest.json']);
    commitFixture(workspace, 'Pin package manifest');
    const receiptFile = path.join(workspace, 'active-problem.json'), receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    receipt.trustedFiles.push('lake-manifest.json');
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    problem = readSolverProblem(workspace, receiptFile);
    let projection = '';
    host.prepare.mockImplementationOnce(async input => {
      projection = input.projectRoot;
      expect(projection).not.toBe(project);
      expect(JSON.parse(fs.readFileSync(path.join(projection, '.lake/package-overrides.json'), 'utf8'))).toEqual({ schemaVersion: '1.2.0', packages: [] });
      expect(fs.readFileSync(path.join(projection, 'Submission.lean'), 'utf8')).not.toContain('PROOF_SECRET');
      expect(fs.readFileSync(path.join(projection, 'Submission.lean'), 'utf8')).toContain('by sorry');
      const query = fs.readFileSync(path.join(projection, input.files[0]), 'utf8');
      expect(query).toContain('Lean.getConstInfo'); expect(query).toContain('Lean.Meta.ppExpr root.type');
      expect(query).not.toContain('root.value'); expect(query).not.toContain('INTENT_SECRET');
      return prepare(input);
    });
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replaceAll('by sorry', 'by trivial /- PROOF_SECRET -/'));
    const commit = commitSolverSources(problem, workspace);
    const contexts = await captureStatementContexts(problem, tasks, workspace, commit, {}, undefined, 1000);
    expect([...contexts.keys()]).toEqual(tasks.map(task => task.id)); expect(fs.existsSync(projection)).toBe(false);
    expect(fs.readFileSync(path.join(project, 'Submission.lean'), 'utf8')).toContain('PROOF_SECRET');
    host.prepare.mockImplementationOnce(async input => { projection = input.projectRoot; return { exitCode: 1, stderr: 'type mismatch' }; });
    await expect(captureStatementContexts(problem, tasks, workspace, commit, {}, undefined, 1000)).rejects.toThrow('math_statement_elaboration_failed');
    expect(fs.existsSync(projection)).toBe(false); expect(host.verify).not.toHaveBeenCalled();
  });

  it('preserves failed projection inputs and full diagnostics while showing the first error', async () => {
    const warnings = 'Submission.lean:1:1: warning: declaration uses `sorry`\n'.repeat(60);
    host.prepare.mockImplementationOnce(async () => ({ exitCode: 1, stdout: warnings +
      'Submission.lean:80:4: error: unexpected token\nexpected a term\n', stderr: 'additional diagnostics' }));
    await expect(captureStatementContexts(problem, statementTasks().filter(task => task.statementReview),
      workspace, problem.baseCommit, {}, undefined, 1000)).rejects.toThrow(
      'math_statement_elaboration_failed\nSubmission.lean:80:4: error: unexpected token\nexpected a term');
    const diagnosticsRoot = path.join(path.dirname(workspace), 'statement-diagnostics');
    const reportDirectory = path.join(diagnosticsRoot, fs.readdirSync(diagnosticsRoot)[0]);
    const manifest = JSON.parse(fs.readFileSync(path.join(reportDirectory, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ status: 'advisory-unverified', problemReceiptDigest: problem.receiptDigest,
      commit: problem.baseCommit, exitCode: 1 });
    expect(fs.readFileSync(path.join(reportDirectory, 'stdout.log'), 'utf8')).toContain(warnings);
    expect(fs.readFileSync(path.join(reportDirectory, 'stderr.log'), 'utf8')).toBe('additional diagnostics');
    expect(fs.readFileSync(path.join(reportDirectory, 'project/Submission.lean'), 'utf8')).toContain('by sorry');
    expect(manifest.files.some((file: any) => file.path.endsWith(manifest.query))).toBe(true);
    for (const file of manifest.files)
      expect(mathDigest(fs.readFileSync(path.join(reportDirectory, file.path)))).toBe(file.digest);
    expect(host.verify).not.toHaveBeenCalled();
  });

  const configureReferenceReports = (extra: Record<string, string[]> = {}) => {
    const verify = host.verify.getMockImplementation()!;
    host.verify.mockImplementation(async (request, options) => {
      const result = await verify(request, options);
      if (!options.collectDeclarationReferences) return result;
      return { ...result, results: result.results.map(item => ({ ...item, declarationReferences: { statement: [],
        proof: (extra[item.theoremName.split('.').at(-1)] ?? ({ first: ['a', 'b'], second: ['first', 'a', 'b'] }[item.theoremName.split('.').at(-1)] ?? []))
          .map(name => ({ name: `Submission.${name}`, file: 'Submission.lean' })) } })) };
    });
  };

  it('binds statement references to types and definitions while preserving them across proof-body changes', () => {
    const file = path.join(project, 'Submission.lean');
    const source = original.replace('theorem first', 'def selected : Nat := 2\nlemma supporting : True := by trivial\ntheorem first');
    fs.writeFileSync(file, source); const commit = commitSolverSources(problem, workspace);
    const references = captureProofReferences(problem, workspace, commit, { name: 'Submission.first', file: 'Submission.lean' },
      { statement: [{ name: 'Submission.selected', file: 'Submission.lean' }, { name: 'Submission.supporting', file: 'Submission.lean' }], proof: [] }, 'fixed-env', 'statement')!;
    fs.writeFileSync(file, source.replace('first : True := by sorry', 'first : True := by trivial').replace('supporting : True := by trivial', 'supporting : True := True.intro'));
    expect(proofReferencesUnchanged(problem, workspace, commitSolverSources(problem, workspace), references, 'fixed-env')).toBe(true);
    fs.writeFileSync(file, source.replace('selected : Nat := 2', 'selected : Nat := 3'));
    expect(proofReferencesUnchanged(problem, workspace, commitSolverSources(problem, workspace), references, 'fixed-env')).toBe(false);
  });

  it('tracks definition fingerprints from the Lean report, preserving proofs after unrelated changes', () => {
    const file = path.join(project, 'Submission.lean');
    let source = original.replace('theorem first', 'def used : Nat := 2\ndef unrelated : Nat := 0\ntheorem first');
    fs.writeFileSync(file, source); const commit = commitSolverSources(problem, workspace);
    const references = captureProofReferences(problem, workspace, commit, { name: 'Submission.first', file: 'Submission.lean' },
      { statement: [{ name: 'Submission.used', file: 'Submission.lean' }], proof: [] }, 'fixed-env')!;
    const unchanged = () => {
      git(workspace, ['add', 'generated/p/Submission.lean']);
      commitFixture(workspace, 'Fingerprint inputs', '--allow-empty');
      return proofReferencesUnchanged(problem, workspace, git(workspace, ['rev-parse', 'HEAD']), references, 'fixed-env');
    };
    fs.writeFileSync(file, source.replace('unrelated : Nat := 0', 'unrelated : Nat := 1')); expect(unchanged()).toBe(true);
    fs.writeFileSync(file, source.replace('used : Nat := 2', 'used : Nat := 3')); expect(unchanged()).toBe(false);
    fs.writeFileSync(file, source.replace('first : True := by sorry', 'first : True := by trivial')); expect(unchanged()).toBe(false);
    fs.writeFileSync(file, source.replace('namespace Submission', 'namespace Submission\nset_option maxRecDepth 800')); expect(unchanged()).toBe(false);
    fs.writeFileSync(file, source.replace('theorem first', 'instance custom : Inhabited Nat := ⟨2⟩\ntheorem first')); expect(unchanged()).toBe(false);
    fs.writeFileSync(file, source);
    expect(proofReferencesUnchanged(problem, workspace, commitSolverSources(problem, workspace), references, 'new-env')).toBe(false);
  });

  it('falls back to a whole module for generated constants and rejects references outside frozen sources', () => {
    const commit = git(workspace, ['rev-parse', 'HEAD']), root = { name: 'Submission.first', file: 'Submission.lean' };
    const references = captureProofReferences(problem, workspace, commit, root,
      { statement: [], proof: [{ name: '_private.Submission.0.internal', file: 'Submission.lean' }] }, 'fixed-env')!;
    expect(references.inputs.some(input => input.file === 'Submission.lean' && !input.name)).toBe(true);
    fs.writeFileSync(path.join(project, 'Submission.lean'), original.replace('theorem first', 'def unrelated : Nat := 2\ntheorem first'));
    expect(proofReferencesUnchanged(problem, workspace, commitSolverSources(problem, workspace), references, 'fixed-env')).toBe(false);
    expect(captureProofReferences(problem, workspace, commit, root, { statement: [], proof: [{ name: 'outside', file: '../outside.lean' }] }, 'fixed-env')).toBeUndefined();
  });

  it('reads appended delivery lines without consuming a partial write or replaying a saved cursor', () => {
    const file = path.join(directory, 'deliveries.jsonl');
    fs.writeFileSync(file, '{"id":"one"}\n{"id":');
    const first = readDeliveryLines(file, 0);
    expect(first.entries.map(entry => entry.line)).toEqual(['{"id":"one"}']);
    fs.appendFileSync(file, '"two"}\n');
    const second = readDeliveryLines(file, first.offset);
    expect(second.entries.map(entry => entry.line)).toEqual(['{"id":"two"}']);
    expect(readDeliveryLines(file, second.offset).entries).toEqual([]);
    fs.truncateSync(file, 0);
    expect(readDeliveryLines(file, second.offset).entries).toMatchObject([{ error: 'math_delivery_log_rewritten', offset: 0 }]);
  });

  it('keeps search stopping decisions separate from proof acceptance', async () => {
    const select = vi.fn((...inputs: Parameters<typeof directSolverModules.M3.select>) => {
      expect(inputs[2]).toMatchObject({ maxTurns: 1, aborted: false });
      return { operation: 'stop' as const, reason: 'no-operation' as const };
    });
    const modules = { ...directSolverModules, M3: { ...directSolverModules.M3, version: 'test-stop-v1', select } };
    expect(await runSolver(args, directory, modules)).toBe(4);
    expect(select).toHaveBeenCalledTimes(1);
    expect(host.createSession).not.toHaveBeenCalled();
    expect(host.verify).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'incomplete', turns: 0,
      solution_commit: null, completion_signal_valid: false });
  });

  it('keeps the host turn limit when a replacement search policy requests more work', async () => {
    host.verify.mockImplementation(async request => failed(verified(request)));
    const modules = { ...directSolverModules, M3: { ...directSolverModules.M3, version: 'test-continue-v1',
      select: () => ({ operation: 'direct' as const, reason: 'continue' as const }) } };
    expect(await runSolver(args, directory, modules)).toBe(4);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'incomplete', turns: 1 });
    expect(host.verify).toHaveBeenCalledTimes(1);
  });

  it('disables total, turn and per-turn limits with zero while still requiring final acceptance', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    host.verify.mockImplementationOnce(async request => failed(verified(request)));
    let turns = 0;
    host.createSession.mockImplementation(session('fixture-thread', async options => {
      turns++;
      clock.mockReturnValue(now + turns * 24 * 60 * 60 * 1000);
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'),
        original.replaceAll('by sorry', `by\n  -- attempt ${turns}\n  trivial`));
      return 'completed';
    }));
    expect(await runSolver([...args, '--max-run-seconds', '0', '--max-turns', '0', '--max-turn-seconds', '0',
      '--proof-timeout-seconds', '0', '--evaluator-timeout-seconds', '0'], directory)).toBe(0);
    expect(turns).toBe(2);
    expect(host.createSession.mock.calls[0][0].turnTimeoutMs).toBeUndefined();
    for (const [request] of host.verify.mock.calls) expect(request).toMatchObject({ timeoutMs: Infinity, batchTimeoutMs: Infinity });
    expect(timers.mock.calls.some(([, ms]) => ms === Infinity)).toBe(false);
    expect(host.officialGate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'evaluated_passed', turns: 2 });
  });

  it('still stops an unlimited solve on SIGTERM and records the solving phase', async () => {
    host.createSession.mockResolvedValueOnce({ threadId: 'fixture-thread',
      run: async () => { process.emit('SIGTERM'); throw new Error('stopped'); },
      close: vi.fn(), interrupt: vi.fn() });
    expect(await runSolver([...args, '--max-run-seconds', '0', '--max-turns', '0', '--max-turn-seconds', '0'], directory)).toBe(4);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'limit_reached', reason: 'math_run_stopped' });
    expect(JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8')).phase).toBe('finished');
    expect(host.officialGate).not.toHaveBeenCalled();
  });

  it('gives final acceptance its own budget after solving finishes near the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    host.verify.mockImplementation(async request => {
      if (request.projectRoot !== project) await vi.advanceTimersByTimeAsync(900);
      return verified(request);
    });
    host.officialGate.mockImplementation(async ({ signal }) => {
      await vi.advanceTimersByTimeAsync(1500);
      signal.throwIfAborted();
      return { comparison: { status: 'official_verified' } };
    });
    expect(await runSolver([...args, '--max-run-seconds', '1', '--evaluator-timeout-seconds', '10'], directory)).toBe(0);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'evaluated_passed', solveWallMs: 900 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, 300, 3_000_000])('applies a finite %s-second evaluator budget to the integrated Lean recheck', async seconds => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    host.officialGate.mockImplementation(async ({ signal }) => {
      await vi.advanceTimersByTimeAsync(10);
      signal.throwIfAborted();
      return { comparison: { status: 'official_verified' } };
    });
    expect(await runSolver([...args, '--evaluator-timeout-seconds', String(seconds)], directory)).toBe(0);
    const recheck = host.verify.mock.calls.find(([request]) => request.projectRoot === project);
    expect(recheck?.[0].timeoutMs).toBe(seconds * 1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['recheck', 'official'])('enforces the total evaluator budget when time runs out during %s', async phase => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    host.verify.mockImplementation(async request => {
      if (request.projectRoot === project) await vi.advanceTimersByTimeAsync(phase === 'recheck' ? 1001 : 600);
      return verified(request);
    });
    host.officialGate.mockImplementation(async ({ signal }) => {
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(401);
      expect(signal.aborted).toBe(true);
      return { comparison: { status: 'official_verified' } };
    });
    expect(await runSolver([...args, '--evaluator-timeout-seconds', '1'], directory)).toBe(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'runtime_error',
      completion_signal_valid: false, evaluator: { status: 'error', reason: 'math_evaluation_timeout', timedOut: true } });
    expect(host.officialGate).toHaveBeenCalledTimes(phase === 'recheck' ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('shares the evaluator budget with an external command (timeout: %s)', async timeout => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    host.verify.mockImplementation(async request => {
      if (request.projectRoot === project) await vi.advanceTimersByTimeAsync(600);
      return verified(request);
    });
    const command = vi.spyOn(verifier, 'runMathematicsSandboxedCommand').mockImplementation(async input => {
      expect(input.timeoutMs).toBe(1000);
      expect(input.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(timeout ? 401 : 300);
      expect(input.signal?.aborted).toBe(timeout);
      return { started: true, exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 300 };
    });
    expect(await runSolver([...args, '--evaluator-command', 'fixture-evaluator', '--evaluator-timeout-seconds', '1'], directory)).toBe(timeout ? 1 : 0);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject(timeout
      ? { status: 'runtime_error', evaluator: { status: 'error', reason: 'math_evaluation_timeout', timedOut: true } }
      : { status: 'evaluated_passed', evaluator: { status: 'passed', method: 'external-command', official: false } });
    expect(command).toHaveBeenCalledOnce();
    expect(host.officialGate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('still cancels unlimited final acceptance on %s', async interrupt => {
    host.officialGate.mockImplementation(async ({ signal }) => {
      process.emit(interrupt);
      signal.throwIfAborted();
    });
    expect(await runSolver([...args, '--evaluator-timeout-seconds', '0'], directory)).toBe(4);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'limit_reached', reason: 'math_run_stopped' });
    expect(host.officialGate).toHaveBeenCalledOnce();
  });

  it('rejects a changed component version on resume before invoking a model', async () => {
    expect(await runSolver([...args, '--startup-only'], directory)).toBe(0);
    const prepared = fs.readFileSync(output, 'utf8');
    const modules = { ...directSolverModules, M4: { ...directSolverModules.M4, version: 'different-context-v1' } };
    expect(await runSolver([...args, '--resume'], directory, modules)).toBe(1);
    expect(fs.readFileSync(output, 'utf8')).toBe(prepared);
    expect(host.createSession).not.toHaveBeenCalled();
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('requires fixed host acceptance even if a replacement evidence module reports success', async () => {
    host.verify.mockImplementation(async request => failed(verified(request)));
    const check = async (...inputs: Parameters<typeof checkSolverProof>) => ({ ...await checkSolverProof(...inputs), passed: true });
    const modules = { ...directSolverModules, M2: { version: 'test-false-positive-v1', check } };
    expect(await runSolver(args, directory, modules)).toBe(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'runtime_error',
      reason: 'math_integrated_proof_mismatch', evaluator: { status: 'skipped' } });
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(host.officialGate).not.toHaveBeenCalled();
  });

  it.each(['failed', 'transport_closed', 'stream_disconnected'])('checks a saved proof after a %s turn before independent evaluation', async status => {
    const run = vi.fn();
    const close = vi.fn();
    host.createSession.mockImplementation(async (options: MathAgentOptions) => {
      run.mockImplementation(async () => {
        fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
        if (status === 'transport_closed') throw new Error('math_codex_transport_closed');
        return 'failed';
      });
      return { threadId: 'fixture-thread', lastError: status === 'stream_disconnected'
        ? 'stream disconnected before completion: error sending request' : undefined, run, close, interrupt: vi.fn() };
    });
    expect(await runSolver([...args, '--max-turns', '3'], directory)).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledBefore(host.verify);
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(host.officialGate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'evaluated_passed', turns: 1,
      solver_ready_receipt_valid: true, evaluator: { official: true } });
  });

  it.each(['failed', 'transport_closed'])('saves Lean diagnostics after a %s turn and resumes from that failure', async status => {
    host.verify.mockImplementationOnce(async request => failed(verified(request), { stdoutPreview: unsolved }));
    const run = vi.fn(async () => {
      if (status === 'transport_closed') throw new Error('math_codex_transport_closed');
      return status;
    });
    host.createSession.mockResolvedValueOnce({ threadId: 'fixture-thread', run, close: vi.fn(), interrupt: vi.fn() });
    expect(await runSolver([...args, '--max-turns', '1'], directory)).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(host.verify).toHaveBeenCalledTimes(1);
    expect(host.officialGate).not.toHaveBeenCalled();
    expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'runtime_error', turns: 1, reason: 'math_model_turn_failed' });
    const resumed = vi.fn();
    host.createSession.mockImplementation(async (options: MathAgentOptions) => {
      resumed.mockImplementation(async () => {
        fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
        return 'completed';
      });
      return { threadId: options.threadId!, run: resumed, close: vi.fn(), interrupt: vi.fn() };
    });
    expect(await runSolver([...args, '--resume', '--max-turns', '2'], directory)).toBe(0);
    expect(resumed.mock.calls[0][0]).toContain(unsolved);
    expect(host.createSession.mock.calls[1][0].threadId).toBe('fixture-thread');
    expect(host.verify).toHaveBeenCalledTimes(3);
  });

  it('returns frozen-source feedback after a failed turn so the next session can repair it', async () => {
    const run = vi.fn();
    host.createSession.mockImplementation(async (options: MathAgentOptions) => {
      run.mockImplementation(async (message: string) => {
        if (run.mock.calls.length === 1) {
          fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replace('first : True', 'first : False'));
          return 'failed';
        }
        expect(message).toContain('math_original_declaration_changed');
        expect(message).toContain('generated/p/Submission.lean');
        expect(host.verify).not.toHaveBeenCalled();
        fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
        return 'completed';
      });
      return { threadId: 'fixture-thread', run, close: vi.fn(), interrupt: vi.fn() };
    });
    expect(await runSolver([...args, '--max-turns', '3'], directory)).toBe(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(host.createSession.mock.calls[1][0].threadId).toBe('fixture-thread');
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(host.officialGate).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'evaluated_passed', turns: 2 });
  });

  it.each(['stream disconnected before completion: Concurrency limit exceeded for account, please retry later',
    'stream disconnected before completion: error sending request', 'math_codex_transport_closed', 'Service unavailable (503)'])
  ('automatically resumes a failed request with saved proof and Lean feedback (%s)', async error => {
    const partial = original.replace('theorem first : True := by sorry', 'theorem first : True := by trivial');
    host.verify.mockImplementationOnce(async request => failed(verified(request), { stdoutPreview: unsolved }));
    host.createSession.mockImplementationOnce(async (options: MathAgentOptions) => ({ threadId: 'fixture-thread',
      lastError: error,
      run: async () => {
        fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), partial);
        return 'failed';
      }, close: vi.fn(), interrupt: vi.fn() }));
    const resumed = vi.fn();
    host.createSession.mockImplementationOnce(session(options => options.threadId || 'resumed-thread', async (options, message) => {
      resumed(message);
      expect(fs.readFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), 'utf8')).toBe(partial);
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
      return 'completed';
    }));
    expect(await runSolver([...args, '--max-turns', '3'], directory)).toBe(0);
    expect(host.createSession.mock.calls[1][0].threadId).toBe(error.startsWith('math_codex_transport_closed') ? undefined : 'fixture-thread');
    expect(resumed.mock.calls[0][0]).toContain(unsolved);
    expect(host.delay).toHaveBeenCalledWith(10_000, undefined, { signal: expect.any(AbortSignal) });
    expect(host.verify).toHaveBeenCalledTimes(3);
    expect(host.officialGate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'evaluated_passed', turns: 2 });
  });

  it('retries a transient failure on its saved thread before rotating after another failure', async () => {
    const partial = original.replace('theorem first : True := by sorry', 'theorem first : True := by trivial');
    let turns = 0;
    host.verify.mockImplementation(async request => turns < 3 ? failed(verified(request), { stdoutPreview: unsolved }) : verified(request));
    host.createSession.mockImplementation(async (options: MathAgentOptions) => ({
      threadId: options.threadId || (turns ? 'fresh-thread' : 'fixture-thread'),
      lastError: 'stream disconnected before completion: error sending request',
      run: async (message: string) => {
        turns++;
        options.onUsage({ totalTokens: turns === 3 ? 15 : turns * 10 });
        if (turns === 1) fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), partial);
        if (turns < 3) return 'failed';
        expect(options.threadId).toBeUndefined();
        expect(fs.readFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), 'utf8')).toBe(partial);
        expect(message).toContain(unsolved);
        fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
        return 'completed';
      }, close: vi.fn(), interrupt: vi.fn(),
    }));
    expect(await runSolver([...args, '--max-turns', '4'], directory)).toBe(0);
    expect(host.createSession.mock.calls.map(call => call[0].threadId)).toEqual([undefined, 'fixture-thread', undefined]);
    expect(host.delay.mock.calls.map(call => call[0])).toEqual([10_000, 20_000]);
    const state = JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8'));
    expect(state).toMatchObject({ turns: 3, threadId: 'fresh-thread', previousThreadIds: ['fixture-thread'],
      usage: { totalTokens: 35 }, usageBeforeThread: { totalTokens: 20 }, lastFailure: { reason: 'math_model_request_failed' } });
    expect(host.officialGate).toHaveBeenCalledOnce();
  });

  it('preserves a saved thread through the first structured upstream 502', async () => {
    const close = vi.fn();
    host.verify.mockImplementationOnce(async request => failed(verified(request), { stdoutPreview: unsolved }));
    host.createSession.mockResolvedValueOnce({ threadId: 'saved-upstream-thread',
      lastError: 'Service unavailable (502)',
      lastFailureDiagnostic: { code: 'httpConnectionFailed', httpStatusCode: 502 },
      run: vi.fn().mockResolvedValue('failed'), close, interrupt: vi.fn() });
    host.createSession.mockImplementationOnce(session(options => options.threadId!, async options => {
      expect(options.threadId).toBe('saved-upstream-thread');
      expect(close).toHaveBeenCalledOnce();
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
      return 'completed';
    }));
    expect(await runSolver([...args, '--max-turns', '3'], directory)).toBe(0);
    const state = JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8'));
    expect(state.threadId).toBe('saved-upstream-thread');
    expect(state.previousThreadIds ?? []).toEqual([]);
    expect(host.delay).toHaveBeenCalledOnce();
  });

  it('rotates a malformed tool-call thread even when upstream reports it as a 502', async () => {
    host.verify.mockImplementationOnce(async request => failed(verified(request), { stdoutPreview: unsolved }));
    host.createSession.mockResolvedValueOnce({ threadId: 'malformed-tool-thread',
      lastError: 'Service unavailable (502)',
      lastFailureDiagnostic: { code: 'responseStreamDisconnected', httpStatusCode: 502, reason: 'invalid_tool_call_arguments' },
      run: vi.fn().mockResolvedValue('failed'), close: vi.fn(), interrupt: vi.fn() });
    host.createSession.mockImplementationOnce(session(options => options.threadId ?? 'fresh-tool-thread', async options => {
      expect(options.threadId).toBeUndefined();
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
      return 'completed';
    }));
    expect(await runSolver([...args, '--max-turns', '3'], directory)).toBe(0);
    const state = JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8'));
    expect(state.previousThreadIds).toEqual(['malformed-tool-thread']);
    expect(state.lastFailure.reason).toBe('math_model_tool_failed');
  });

  it('reopens a disconnected startup without spending another turn or discarding saved proof', async () => {
    const partial = original.replace('first : True := by sorry', 'first : True := by trivial');
    host.createSession.mockImplementationOnce(async (options: MathAgentOptions) => {
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), partial);
      throw new Error('math_codex_transport_closed:process_exit:code=9:signal=none');
    });
    host.createSession.mockImplementationOnce(session('reopened', async options => {
      expect(fs.readFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), 'utf8')).toBe(partial);
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
      return 'completed';
    }));
    expect(await runSolver(args, directory)).toBe(0);
    expect(host.createSession).toHaveBeenCalledTimes(2);
    expect(host.delay).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8')).turns).toBe(1);
    expect(host.officialGate).toHaveBeenCalledOnce();
  });

  it('bounds disconnected session startup retries and releases its unstarted turn', async () => {
    host.createSession.mockRejectedValue(new Error('math_codex_transport_closed:process_exit:code=9:signal=none'));
    expect(await runSolver(args, directory)).toBe(1);
    expect(host.createSession).toHaveBeenCalledTimes(4);
    expect(host.delay.mock.calls.map(call => call[0])).toEqual([10_000, 20_000, 40_000]);
    expect(JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8')).turns).toBe(0);
  });

  it('avoids preparing or opening a spare session when selection stops after retry backoff', async () => {
    host.verify.mockImplementation(async request => failed(verified(request)));
    host.createSession.mockResolvedValue({ threadId: 'fixture-thread', lastError: 'Concurrency limit exceeded for account',
      run: vi.fn().mockResolvedValue('failed'), close: vi.fn(), interrupt: vi.fn() });
    const build = vi.fn(directSolverModules.M4.build);
    const select = vi.fn(directSolverModules.M3.select)
      .mockImplementationOnce(directSolverModules.M3.select)
      .mockReturnValue({ operation: 'stop', reason: 'no-operation' });
    expect(await runSolver([...args, '--max-turns', '3'], directory, {
      ...directSolverModules, M3: { ...directSolverModules.M3, select }, M4: { ...directSolverModules.M4, build },
    })).toBe(4);
    expect(host.delay).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenCalledOnce();
    expect(host.createSession).toHaveBeenCalledOnce();
    expect(host.officialGate).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'incomplete', turns: 1 });
  });

  it.each([2, 10])('bounds request retries by both retry and turn limits (%s turns)', async maxTurns => {
    host.verify.mockImplementation(async request => failed(verified(request), { stdoutPreview: unsolved }));
    host.createSession.mockImplementation(async (options: MathAgentOptions) => ({ threadId: options.threadId || 'fixture-thread',
      lastError: 'Concurrency limit exceeded for account', run: vi.fn().mockResolvedValue('failed'), close: vi.fn(), interrupt: vi.fn() }));
    expect(await runSolver([...args, '--max-turns', String(maxTurns)], directory)).toBe(1);
    const turns = Math.min(maxTurns, 4);
    expect(host.createSession).toHaveBeenCalledTimes(turns);
    expect(host.delay.mock.calls.map(call => call[0])).toEqual([10_000, 20_000, 40_000].slice(0, turns - 1));
    expect(host.officialGate).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'runtime_error', turns, reason: 'math_model_concurrency_limit' });
    expect(JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8')).error).toBe('math_model_concurrency_limit');
  });

  it('stops an aborted rate-limit backoff without creating another session', async () => {
    host.verify.mockImplementation(async request => failed(verified(request)));
    host.createSession.mockResolvedValueOnce({ threadId: 'fixture-thread', lastError: 'Concurrency limit exceeded for account',
      run: vi.fn().mockResolvedValue('failed'), close: vi.fn(), interrupt: vi.fn() });
    host.delay.mockImplementationOnce(async () => { process.emit('SIGTERM'); });
    expect(await runSolver([...args, '--max-turns', '3'], directory)).toBe(4);
    expect(host.createSession).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).status).toBe('limit_reached');
    expect(JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8')).check.passed).toBe(false);
  });

  it('resets the request retry count after successful turns', async () => {
    let turns = 0;
    host.verify.mockImplementation(async request => turns === 8 ? verified(request) : failed(verified(request)));
    host.createSession.mockImplementation(session(options => options.threadId || 'fixture-thread', async options => {
      if (++turns === 8) fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
      return turns % 2 ? 'failed' : 'completed';
    }, { lastError: 'stream disconnected before completion: error sending request' }));
    expect(await runSolver([...args, '--max-turns', '10'], directory)).toBe(0);
    expect(host.delay.mock.calls.map(call => call[0])).toEqual([10_000, 10_000, 10_000, 10_000]);
    expect(host.officialGate).toHaveBeenCalledOnce();
  });

  it('reports authentication failures without retrying them', async () => {
    host.verify.mockImplementation(async request => failed(verified(request)));
    host.createSession.mockResolvedValueOnce({ threadId: 'fixture-thread', lastError: 'Invalid authentication',
      run: vi.fn().mockResolvedValue('failed'), close: vi.fn(), interrupt: vi.fn() });
    expect(await runSolver([...args, '--max-turns', '3'], directory)).toBe(1);
    expect(host.createSession).toHaveBeenCalledTimes(1);
    expect(host.delay).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'runtime_error', reason: 'math_model_authentication_failed' });
  });

  it('reports a missing provider key before model work and does not retry', async () => {
    host.createSession.mockRejectedValueOnce(new Error('math_model_api_key_missing:DEEPSEEK_API_KEY'));
    expect(await runSolver([...args, '--max-turns', '3'], directory)).toBe(1);
    expect(host.createSession).toHaveBeenCalledOnce();
    expect(host.delay).not.toHaveBeenCalled();
    expect(host.verify).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'runtime_error', reason: 'math_model_api_key_missing:DEEPSEEK_API_KEY' });
  });

  it('stops interrupted turns without starting verification', async () => {
    const run = vi.fn(async () => 'interrupted');
    host.createSession.mockResolvedValueOnce({ threadId: 'fixture-thread', run, close: vi.fn(), interrupt: vi.fn() });
    expect(await runSolver([...args, '--max-turns', '3'], directory)).toBe(4);
    expect(run).toHaveBeenCalledTimes(1);
    expect(host.verify).not.toHaveBeenCalled();
    expect(host.officialGate).not.toHaveBeenCalled();
  });

  it('starts the solve budget after preparation and blocks unusable imports before the model', async () => {
    const clock = Date.now();
    let elapsed = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock + elapsed);
    host.prepare.mockImplementationOnce(async () => {
      elapsed += 5000;
      return { exitCode: 0, timedOut: false, phases: [] };
    });
    expect(await runSolver([...args, '--max-run-seconds', '1'], directory)).toBe(0);
    expect(host.createSession.mock.calls[0][0].turnTimeoutMs).toBeUndefined();
    const rejected = path.join(directory, 'rejected.json');
    host.prepare.mockResolvedValueOnce({ exitCode: 1, timedOut: false, phases: [], stderr: 'error: unknown module prefix Mathlib' });
    expect(await runSolver([...args, '--output', rejected], directory)).toBe(1);
    expect(host.createSession).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(`${rejected}.runtime/state.json`, 'utf8')).phase).toBe('finished');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('error: unknown module prefix Mathlib'));
  });

  it('records installed library proof references without a historical catalog or a model usage report', async () => {
    vi.spyOn(directSolverModules.M2, 'applyLibrary').mockResolvedValue({ status: 'skipped', reason: 'fixture-model-reference', candidates: [] });
    const lib = 'Submission/Library/Fixture/Lemmas.lean';
    const source = 'namespace Frozen\ntheorem library_true : True := trivial\nend Frozen\n';
    fs.mkdirSync(path.join(project, path.dirname(lib)), { recursive: true });
    fs.writeFileSync(path.join(project, lib), source);
    const receipt = JSON.parse(fs.readFileSync(problem.activeProblemPath, 'utf8'));
    fs.writeFileSync(problem.activeProblemPath, JSON.stringify({ ...receipt, solverOwnedFiles: ['Submission.lean', lib],
      libraryPack: { digest: 'c'.repeat(64), files: { [lib]: mathDigest(source) } } }));
    git(workspace, ['add', 'generated']);
    commitFixture(workspace, 'Install library for reference observation');
    host.createSession.mockImplementation(session('installed-library-use', async options => {
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'),
        'import Submission.Library.Fixture.Lemmas\n' + original
          .replace('first : True := by sorry', 'first : True := by exact Frozen.library_true')
          .replace('second : True := by sorry', 'second : True := by trivial'));
      return 'completed';
    }));
    host.verify.mockImplementation(async (request: MathematicsVerifierBatchRequest) => {
      const result = verified(request);
      return { ...result, results: result.results.map(item => ({ ...item, declarationReferences: { statement: [],
        proof: item.theoremName === 'Submission.first' ? [{ name: 'Frozen.library_true', file: lib }] : [] } })) };
    });

    expect(await runSolver(args, directory)).toBe(0);

    const recorded = readSolverRunState(`${output}.runtime/state.json`);
    expect(recorded.knowledgeDigest).toBeUndefined();
    expect(recorded.knowledgeUses).toEqual([expect.objectContaining({ source: 'installed-library',
      declaration: { name: 'Frozen.library_true', file: lib }, consumer: { taskId: 'original_goal_1', taskDigest: expect.any(String) },
      status: 'checked-reference', attribution: 'host-observed-reference', checkedCommit: recorded.check!.commit,
    })]);
    expect(recorded.knowledgeUses![0].application).toBeUndefined();
    expect(host.officialGate).toHaveBeenCalledOnce();
  });

  it('rechecks frozen library-pack modules at startup and stops before the model when one uses sorry', async () => {
    const lib = 'Submission/Library/Fixture/Lemmas.lean', source = 'namespace Submission\ntheorem library_true : True := trivial\nend Submission\n';
    fs.mkdirSync(path.join(project, path.dirname(lib)), { recursive: true });
    fs.writeFileSync(path.join(project, lib), source);
    const receipt = JSON.parse(fs.readFileSync(problem.activeProblemPath, 'utf8'));
    fs.writeFileSync(problem.activeProblemPath, JSON.stringify({ ...receipt, solverOwnedFiles: ['Submission.lean', lib],
      libraryPack: { digest: 'c'.repeat(64), files: { [lib]: mathDigest(source) } } }));
    git(workspace, ['add', 'generated']);
    commitFixture(workspace, 'Install library pack');
    host.createSession.mockImplementation(() => { throw new Error('fixture-library-should-close-before-model'); });
    expect(await runSolver(args, directory)).toBe(0);
    expect(host.createSession).not.toHaveBeenCalled();
    const solved = readSolverRunState(`${output}.runtime/state.json`);
    const savedSource = committedSource(solved.worktree, solved.check!.commit, `${solved.problem.projectRelative}/Submission.lean`);
    expect(savedSource).toContain('import Submission.Library.Fixture.Lemmas');
    expect(savedSource).toContain('exact _root_.Submission.library_true');
    expect(savedSource).not.toContain('by sorry');
    expect(solved.turns).toBe(0);
    const libraryCheck = host.prepare.mock.calls.find(([input]) => input.files.includes(lib));
    expect(libraryCheck?.[0]).toMatchObject({ files: [lib] });
    expect(libraryCheck?.[0]).not.toHaveProperty('dependenciesOnly');
    expect(JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8')).problem.frozenFiles).toEqual({ [lib]: mathDigest(source) });
    expect(fs.existsSync(`${output}.runtime/library-pack-diagnostics.json`)).toBe(true);

    host.createSession.mockClear();
    const rejected = path.join(directory, 'rejected.json');
    host.prepare.mockResolvedValueOnce({ exitCode: 0, timedOut: false, phases: [] }).mockResolvedValueOnce({ exitCode: 0, timedOut: false,
      phases: [], messages: [{ format: 'lean-json', severity: 'warning', file: lib, message: "declaration uses 'sorry'" }] });
    expect(await runSolver([...args, '--output', rejected], directory)).toBe(1);
    expect(host.createSession).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(`${rejected}.runtime/library-pack-diagnostics.json`, 'utf8')).messages).toHaveLength(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`${lib} declaration uses 'sorry'`));
  });

  it('reports the pinned compiler mismatch before starting dependencies or a model', async () => {
    const diagnostics = 'Pinned Lean version mismatch: expected 4.31.0, found 4.30.0. Check PATH and ELAN_HOME.';
    host.readiness.mockReturnValue({ status: 'invalid', diagnostics });
    expect(await runSolver(args, directory)).toBe(1);
    expect(host.prepare).not.toHaveBeenCalled();
    expect(host.createSession).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(`${output}.runtime/toolchain-readiness.json`, 'utf8'))).toMatchObject({ status: 'invalid', diagnostics });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(diagnostics));
  });

  it.each([false, true])('blocks an unreachable provider before dependencies or a model, startup=%s', async startup => {
    host.connectivity.mockResolvedValue({ status: 'unavailable', diagnostics: 'Provider connection failed. Check the proxy on this host.' });
    expect(await runSolver([...args, ...(startup ? ['--startup-only'] : [])], directory)).toBe(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({
      status: 'runtime_error', reason: 'math_codex_provider_unreachable', turns: 0,
    });
    expect(host.freeze).not.toHaveBeenCalled();
    expect(host.prepare).not.toHaveBeenCalled();
    expect(host.createSession).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(`${output}.runtime/provider-connectivity.json`, 'utf8')).status).toBe('unavailable');
  });

  it.each([false, true])('blocks a missing pinned package cache before preparation or a model, startup=%s', async startup => {
    fs.writeFileSync(path.join(project, 'lake-manifest.json'), JSON.stringify({ packages: [
      { name: 'mathlib', rev: 'a'.repeat(40), type: 'git' },
    ] }));
    git(workspace, ['add', '--', 'generated/p/lake-manifest.json']);
    commitFixture(workspace, 'Pinned dependency');
    expect(await runSolver([...args, ...(startup ? ['--startup-only'] : [])], directory)).toBe(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({
      status: 'runtime_error', reason: 'math_lake_packages_unavailable', turns: 0,
    });
    expect(host.freeze).not.toHaveBeenCalled();
    expect(host.prepare).not.toHaveBeenCalled();
    expect(host.createSession).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No manifest-compatible Lake package cache'));
  });

  it('checks a timed checkpoint and resumes with host diagnostics', async () => {
    host.verify.mockImplementationOnce(async request => failed(verified(request), { stdoutPreview: 'Submission.lean:4:1: error: unsolved goals' }));
    const messages: string[] = [];
    host.createSession.mockImplementation(session('fixture-thread', async (options, message) => {
      messages.push(message);
      if (messages.length === 1) return 'checkpoint';
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
      return 'completed';
    }));
    expect(await runSolver([...args, '--max-turns', '2'], directory)).toBe(0);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('unsolved goals');
    expect(host.createSession).toHaveBeenCalledTimes(1);
    expect(host.verify).toHaveBeenCalledTimes(3);
  });

  it.each(['throw', 'reject'])('reports a %s session close failure after proof selection', async mode => {
    const close = vi.fn(() => {
      const error = new Error('fixture_close_failed');
      if (mode === 'throw') throw error;
      return Promise.reject(error);
    });
    host.createSession.mockImplementation(async (options: MathAgentOptions) => ({ threadId: 'fixture-thread',
      run: async () => {
        fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
        return 'completed';
      }, close, interrupt: vi.fn() }));
    expect(await runSolver(args, directory)).toBe(1);
    expect(close).toHaveBeenCalledOnce();
    expect(host.verify).toHaveBeenCalledOnce();
    expect(host.officialGate).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'runtime_error', reason: 'fixture_close_failed' });
  });

  it('preserves unrelated session errors as runtime failures', async () => {
    host.createSession.mockResolvedValueOnce({ threadId: 'fixture-thread', run: vi.fn().mockRejectedValue(new Error('unexpected failure')),
      close: vi.fn(), interrupt: vi.fn() });
    expect(await runSolver(args, directory)).toBe(1);
    expect(host.verify).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'runtime_error', reason: 'unexpected failure' });
  });

  it('logs the source commit, file and exit status when a worker cannot read Git source', async () => {
    host.createSession.mockImplementationOnce(async () => {
      committedSource(workspace, problem.baseCommit, 'generated/p/missing.lean');
      throw new Error('fixture_expected_missing_source');
    });
    expect(await runSolver(args, directory)).toBe(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'runtime_error', reason: 'math_task_source_unavailable' });
    const events = vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(line));
    const diagnostic = { command: 'show', commit: problem.baseCommit, file: 'generated/p/missing.lean',
      exitCode: 128, signal: null, stderr: expect.stringContaining('missing.lean') };
    expect(events.find(event => event.event === 'worker_failed')).toMatchObject({ reason: 'math_task_source_unavailable', git: diagnostic });
    expect(events.find(event => event.event === 'finished')).toMatchObject({ status: 'runtime_error', git: diagnostic });
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('keeps repeated unchanged rejections incomplete without recompiling the same commit', async () => {
    host.verify.mockImplementation(async request => failed(verified(request), { error: 'Lean exited with status 1.', stdoutPreview: unsolved }));
    expect(await runSolver([...args, '--max-turns', '3'], directory)).toBe(4);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'incomplete', turns: 3, evaluator: { status: 'skipped' } });
    expect(host.verify).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"reused":true'));
    expect(host.officialGate).not.toHaveBeenCalled();
    expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
  });

  it.each([false, true])('feeds deduplicated Lean goals back and detects stalled proof work (source changed: %s)', async changed => {
    const messages: string[] = [];
    const leanError = 'Submission.lean:12:4: error: linarith failed to find a contradiction\nx : Nat\nh : 0 < x\n|- False\n';
    host.verify.mockImplementation(async request => messages.length <= 2
      ? failed(verified(request), { error: 'Lean exited with status 1.', stdoutPreview: 'Submission.lean:1:1: warning: unused variable\n' + leanError })
      : verified(request));
    host.createSession.mockImplementation(session('fixture-thread', async (options, message) => {
      messages.push(message);
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry',
        changed || messages.length === 3 ? `by\n  -- attempt ${messages.length}\n  trivial` : 'by trivial'));
      return 'completed';
    }));
    expect(await runSolver([...args, '--max-turns', '3'], directory)).toBe(0);
    expect(messages).toHaveLength(3);
    expect(messages[1].split(leanError.trim())).toHaveLength(2);
    expect(messages[1]).toContain('Submission.first: failed');
    expect(messages[1]).toContain('Submission.second: failed');
    expect(messages[1]).not.toContain('unused variable');
    expect(messages[1]).toContain('subtype .property');
    expect(messages[2]).toContain(changed ? 'same Lean errors and goal contexts' : 'proof source is unchanged');
    expect(host.verify).toHaveBeenCalledTimes(changed ? 4 : 3);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).status).toBe('evaluated_passed');
  });

  it('bounds repair feedback in bytes while retaining the earliest error and its context', async () => {
    const check = await checkSolverProof(problem, workspace, {});
    check.verification.results = check.verification.results.map(item => ({ ...item, status: 'failed',
      stdoutPreview: 'Submission.lean:2:3: error: unsolved goals\nh : True\n|- True\n' + '\u03b1'.repeat(20_000) }));
    const feedback = solverProofFeedback({ ...check, passed: false });
    expect(Buffer.byteLength(feedback)).toBeLessThanOrEqual(16_000);
    expect(feedback).toContain('h : True\n|- True');
    expect(feedback).toContain('[truncated;');
  });

  it('remembers a failure that recurs after another goal without bypassing acceptance', async () => {
    const messages: string[] = [];
    host.verify.mockImplementation(async request => messages.length <= 3
      ? failed(verified(request), { stdoutPreview: `Submission.lean:${messages.length + 3}:1: error: unsolved goals\n⊢ ${messages.length === 2 ? 'False' : 'True'}` })
      : verified(request));
    host.createSession.mockImplementation(session('fixture-thread', async (options, message) => {
      messages.push(message);
      fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'),
        original.replaceAll('by sorry', `by\n  -- attempt ${messages.length}\n  trivial`));
      return 'completed';
    }));
    expect(await runSolver([...args, '--max-turns', '4'], directory)).toBe(0);
    expect(messages[2]).not.toContain('already occurred');
    expect(messages[3]).toContain('already occurred 1 time(s)');
    const failures = JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8')).failures;
    expect(failures.map((item: { attempts: number }) => item.attempts)).toEqual([1, 2]);
    expect(host.verify).toHaveBeenCalledTimes(5);
    expect(host.officialGate).toHaveBeenCalledTimes(1);
  });

  it('bounds failure memory and excludes success and missing Lean diagnostics', async () => {
    const accepted = await checkSolverProof(problem, workspace, {});
    let history: ReturnType<typeof rememberSolverFailure> = [];
    for (let index = 0; index < 40; index++) {
      const failed = { ...accepted, passed: false, verification: { ...accepted.verification, status: 'failed' as const,
        results: accepted.verification.results.map(item => ({ ...item, status: 'failed' as const,
          stdoutPreview: `Submission.lean:4:1: error: unsolved goals\n⊢ P${index}` })) } };
      history = rememberSolverFailure(failed, history);
    }
    expect(history).toHaveLength(32);
    expect(JSON.stringify(history)).not.toContain('unsolved goals');
    expect(rememberSolverFailure(accepted, history)).toEqual(history);
    const opaque = { ...accepted, passed: false, verification: { ...accepted.verification, status: 'failed' as const,
      results: accepted.verification.results.map(item => ({ ...item, status: 'failed' as const, stdoutPreview: 'Process exited' })) } };
    expect(rememberSolverFailure(opaque, history)).toEqual(history);
    expect(solverProofFeedback(opaque, undefined, history)).not.toContain('already occurred');
  });

  it('resumes an incomplete proof with its saved Lean feedback', async () => {
    const diagnostic = 'Submission.lean:4:1: error: unsolved goals\nh : True\n|- True';
    host.verify.mockImplementationOnce(async request => failed(verified(request), { error: 'open goals', stdoutPreview: diagnostic }));
    expect(await runSolver(args, directory)).toBe(4);
    const messages: string[] = [];
    host.createSession.mockImplementation(session(options => options.threadId!, async (_options, message) => {
      messages.push(message);
      return 'completed';
    }));
    expect(await runSolver([...args, '--resume', '--max-turns', '2'], directory)).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(diagnostic);
    expect(messages[0]).toContain('Submission.first: failed');
    expect(messages[0]).toContain('already occurred 1 time(s)');
    expect(host.createSession.mock.calls[1][0].threadId).toBe('fixture-thread');
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).turns).toBe(2);
    expect(host.verify).toHaveBeenCalledTimes(3);
  });

  it('offers verified library lookup to the solver and rejects changed retrieval identities on resume', async () => {
    host.packages = path.join(project, '.lake/packages');
    const library = path.join(project, '.lake/packages/mathlib/Mathlib/Order/Basic.lean');
    fs.mkdirSync(path.dirname(library), { recursive: true });
    fs.writeFileSync(library, 'lemma library_helper : True := by trivial');
    fs.writeFileSync(path.join(project, 'lake-manifest.json'), JSON.stringify({ packages: [
      { name: 'mathlib', rev: 'a'.repeat(40), url: 'https://github.com/leanprover-community/mathlib4' },
    ] }));
    git(workspace, ['add', '--force', '--', 'generated/p/.lake/packages', 'generated/p/lake-manifest.json']);
    commitFixture(workspace, 'Pinned library fixture');
    const file = path.join(directory, 'corpus.json');
    fs.writeFileSync(file, JSON.stringify(await createMathRetrievalCorpus(project, ['mathlib'])));
    vi.stubEnv('DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS', file);
    vi.stubEnv('DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256', mathDigest(fs.readFileSync(file)));
    expect(await runSolver(args, directory)).toBe(0);
    const options = host.createSession.mock.calls[0][0] as MathAgentOptions;
    expect(options.instructions).toContain('search-lean --workspace');
    expect(options.instructions).toContain('--sha256');
    expect(options.instructions).toContain(path.join(`${output}.runtime/worktree`, 'generated/p'));
    fs.appendFileSync(file, '\n');
    expect(await runSolver([...args, '--resume'], directory)).toBe(1);
    expect(host.createSession).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).status).toBe('evaluated_passed');
  });

  it.each(['unchanged', 'corpus', 'source'])('automatically enables frozen Mathlib lookup and validates it on resume (%s)', async change => {
    const assertCorpus = vi.spyOn(retrievalCorpus, 'assertMathRetrievalCorpus');
    host.freeze.mockImplementation(async (root: string) => {
      expect(fs.existsSync(path.join(root, '.lake/package-overrides.json'))).toBe(false);
      return { environmentValue: 'fixture', dispose: vi.fn() };
    });
    host.packages = path.join(directory, 'packages');
    const library = path.join(host.packages, 'mathlib/Mathlib/Algebra/Basic.lean');
    fs.mkdirSync(path.dirname(library), { recursive: true });
    fs.writeFileSync(library, 'namespace Finset\nlemma sum_bound : True := by trivial\nend Finset\n');
    fs.writeFileSync(path.join(host.packages, 'mathlib/lakefile.toml'), 'name = "mathlib"\n');
    fs.writeFileSync(path.join(project, 'lake-manifest.json'), JSON.stringify({ packages: [
      { name: 'mathlib', rev: 'a'.repeat(40), url: 'https://github.com/leanprover-community/mathlib4' },
    ] }));
    git(workspace, ['add', '--', 'generated/p/lake-manifest.json']);
    commitFixture(workspace, 'Pinned library');
    host.verify.mockImplementationOnce(async request => failed(verified(request)));
    expect(await runSolver(args, directory)).toBe(4);
    const options = host.createSession.mock.calls[0][0] as MathAgentOptions;
    const corpusFile = options.environment!.DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS!;
    expect(options.instructions).toContain('search-lean --workspace');
    expect(options.instructions).toContain(corpusFile);
    expect(options.environment!.DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256).toBe(mathDigest(fs.readFileSync(corpusFile)));
    expect(JSON.parse(fs.readFileSync(corpusFile, 'utf8')).sources).toHaveLength(1);
    expect(assertCorpus).not.toHaveBeenCalled();
    if (change === 'corpus') fs.appendFileSync(corpusFile, '\n');
    if (change === 'source') fs.appendFileSync(library, '\n-- changed');
    expect(await runSolver([...args, '--resume', '--max-turns', '2'], directory)).toBe(change === 'unchanged' ? 0 : 1);
    if (change !== 'unchanged') {
      expect(JSON.parse(fs.readFileSync(output, 'utf8')).reason).toBe(
        change === 'corpus' ? 'math_corpus_identity_changed' : 'math_corpus_source_changed'
      );
      expect(host.createSession).toHaveBeenCalledTimes(1);
    } else {
      expect(host.createSession).toHaveBeenCalledTimes(2);
      expect(host.createSession.mock.calls[1][0].environment.DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256)
        .toBe(options.environment!.DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256);
    }
    expect(assertCorpus).toHaveBeenCalledTimes(change === 'corpus' ? 0 : 1);
  });

  it('resumes a saved passing check before evaluation without another model session or turn', async () => {
    const close = vi.fn().mockRejectedValueOnce(new Error('session close failed'));
    const run = vi.fn();
    host.createSession.mockImplementation(async (options: MathAgentOptions) => {
      run.mockImplementation(async () => {
        fs.writeFileSync(path.join(options.workspace, 'generated/p/Submission.lean'), original.replaceAll('by sorry', 'by trivial'));
        return 'completed';
      });
      return { threadId: 'fixture-thread', run, close, interrupt: vi.fn() };
    });
    expect(await runSolver(args, directory)).toBe(1);
    expect(JSON.parse(fs.readFileSync(`${output}.runtime/state.json`, 'utf8'))).toMatchObject({ phase: 'finished', check: { passed: true } });
    expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
    expect(host.officialGate).not.toHaveBeenCalled();
    expect(await runSolver([...args, '--resume'], directory)).toBe(0);
    expect(host.createSession).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(host.officialGate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'evaluated_passed', turns: 1 });
  });

  it.each([false, true])('invalidates a changed passing checkpoint without starting a session when turns are exhausted (committed: %s)', async committed => {
    host.officialGate.mockRejectedValueOnce(new Error('offline evaluator'));
    expect(await runSolver(args, directory)).toBe(1);
    const worktree = path.join(`${output}.runtime`, 'worktree');
    fs.writeFileSync(path.join(worktree, 'generated/p/Submission.lean'), original);
    if (committed) {
      git(worktree, ['add', '--', 'generated/p/Submission.lean']);
      commitFixture(worktree, 'Changed proof');
    }
    expect(await runSolver([...args, '--resume'], directory)).toBe(4);
    expect(host.createSession).toHaveBeenCalledTimes(1);
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(host.officialGate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'incomplete', turns: 1,
      solution_commit: null, solver_ready_receipt_valid: false, evaluator: { status: 'skipped' } });
  });

  it('resumes an interrupted evaluation without another model turn', async () => {
    host.officialGate.mockRejectedValueOnce(new Error('offline evaluator'));
    expect(await runSolver(args, directory)).toBe(1);
    expect(await runSolver([...args, '--resume'], directory)).toBe(0);
    expect(host.createSession).toHaveBeenCalledTimes(1);
    expect(host.officialGate).toHaveBeenCalledTimes(2);
  });

  it('reports evaluator timeouts as infrastructure errors', async () => {
    host.officialGate.mockResolvedValue({ comparison: { status: 'failed', timedOut: true } });
    expect(await runSolver(args, directory)).toBe(1);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ status: 'runtime_error', evaluator: { status: 'error' } });
  });

  it('prepares without a model and rejects changed resume identities without overwriting the result', async () => {
    expect(await runSolver([...args, '--startup-only'], directory)).toBe(0);
    expect(host.createSession).not.toHaveBeenCalled();
    const receipt = fs.readFileSync(output, 'utf8');
    const changed = args.map((value, index) => args[index - 1] === '--task-file' ? path.join(directory, 'changed.md') : value);
    fs.writeFileSync(path.join(directory, 'changed.md'), 'Change the task');
    expect(await runSolver([...changed, '--resume'], directory)).toBe(1);
    expect(fs.readFileSync(output, 'utf8')).toBe(receipt);
  });

});
