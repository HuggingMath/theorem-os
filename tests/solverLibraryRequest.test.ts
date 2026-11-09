import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { agentLibrary, LibraryInstallationRequested, LIBRARY_REQUEST_FILE } from '../src/solver/libraryAccess';
import { writeLibraryCatalog } from '../src/solver/libraryCatalog';
import { directSolverModules, type SolverModules } from '../src/solver/modules';
import { committedSource, git, readSolverProblem } from '../src/solver/problem';
import { runResearchWorkers } from '../src/solver/research';
import { deferred } from './helpers/async';
import { workerAccess } from './helpers/cooperation';
import { temporaryDirectory } from './helpers/files';
import { leadWorker, solverState } from './helpers/solver';
import { failedBatch, verifiedBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../src/math/mathBuildManifest', () => ({ readMathBuildManifest: vi.fn() }));
vi.mock('../src/math/verifier', async original => ({ ...await original<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, formalVerificationToolIdentity: () => undefined,
  resolveMathematicsLakePackagesCache: () => undefined,
}));

const challenge = 'namespace Current\ntheorem target (n : Nat) : n = n := by sorry\nend Current\n';
const moduleFile = 'Submission/Library/Catalog/Identity.lean';
const roots: string[] = [], controllers: AbortController[] = [], running: Promise<unknown>[] = [];
const releases: (() => void)[] = [];

function gate<T = void>() {
  const value = deferred<T>();
  releases.push(() => value.resolve(undefined as T));
  return value;
}

beforeEach(() => {
  host.verify.mockReset().mockImplementation(async (request: MathematicsVerifierBatchRequest) =>
    failedBatch(verifiedBatch(request, { sessionId: 'library-request-fixture' }), {
      stdoutPreview: () => 'Submission.lean:2:1: error: unsolved goals\n⊢ n = n', goalsRemaining: 1,
    }));
});

afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.abort());
  releases.splice(0).forEach(release => release());
  await Promise.allSettled(running.splice(0));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

function fixture({ parallel = false, previous = false } = {}) {
  const directory = temporaryDirectory('solver-library-request-'); roots.push(directory);
  const workspace = path.join(directory, 'solver');
  const receipt = bootstrapLeanTask(workspace, { source: challenge, task: 'Prove the original identity.' });
  const problem = readSolverProblem(workspace, receipt.activeProblemPath);
  const workers = [leadWorker(problem, workspace)];
  if (parallel) {
    const peer = path.join(directory, 'peer');
    git(workspace, ['worktree', 'add', '--quiet', '--detach', peer, problem.baseCommit]);
    workers.push({ ...leadWorker(problem, peer, 'peer'), role: 'researcher' });
  }
  const historical = previous ? { turns: 1, usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
    usageAccounting: { startedTurns: 1, reportedTurns: 1, pending: false, incomplete: false },
    requestUsageAccounting: { startedRequests: 1, reportedRequests: 1, pendingRequests: 0, incomplete: false } } : { turns: 0 };
  const state = solverState(problem, workspace, { runId: 'library-request-fixture', phase: 'prepared',
    environmentDigest: getLeanTaskEnvironment('standard').dependencyDigest,
    ...(parallel ? { turns: historical.turns * workers.length, coordination: 'independent' as const,
      workers: workers.map(worker => ({ ...worker, phase: 'prepared' as const, ...structuredClone(historical) })) } : historical),
  });
  const catalog = writeLibraryCatalog(path.join(directory, 'release'), {
    id: 'fixture/request', revision: 'v1', environment: 'standard', packs: [{ schema: LIBRARY_PACK_SCHEMA,
      modules: [{ file: moduleFile, source: 'namespace Catalog\ntheorem identity (n : Nat) : n = n := rfl\nend Catalog\n',
        origin: { kind: 'upstream', repository: 'offline-fixture', commit: 'a'.repeat(40), file: 'Identity.lean' } }] }],
  });
  const access = workerAccess(workers, directory);
  for (const worker of workers) access.get(worker.id)!.libraryCatalog = { file: catalog.file, digest: catalog.digest };
  const events: { event: string; details?: Record<string, unknown> }[] = [];
  const controller = new AbortController(); controllers.push(controller);
  const check = vi.fn(directSolverModules.M2.check);
  const run = (open: (options: MathAgentOptions) => Promise<MathAgentSession>,
    onEvent?: (event: string, details?: Record<string, unknown>) => void) => {
    const modules: SolverModules = { ...directSolverModules,
      M1: { ...directSolverModules.M1, open }, M2: { ...directSolverModules.M2, check },
      M4: { ...directSolverModules.M4, build: () => ({ instructions: 'Offline library request fixture.',
        message: 'Inspect the pinned catalog and save an installation request when required.',
        scope: 'original-problem-and-allowed-library', sources: { problemReceiptDigest: problem.receiptDigest } }) },
    };
    const completion = runResearchWorkers({ state, workers, modules, access, root: directory,
      buildFile: path.join(directory, 'build.json'), taskText: 'Prove the original identity.',
      executable: 'offline-fixture', profile: 'offline-fixture', signal: controller.signal,
      deadline: Infinity, maxTurns: state.turns + workers.length, maxTurnMs: Infinity, maxTotalTokens: 1000,
      save: () => {}, emit: (event, details) => { events.push({ event, details }); onEvent?.(event, details); },
    });
    running.push(completion); void completion.catch(() => {});
    return completion;
  };
  const request = (worktree: string) => agentLibrary(worktree).request(['Catalog.identity'], 'Use the catalog identity theorem.');
  return { directory, problem, workers, state, catalog, events, check, run, request };
}

function reportUsage(options: MathAgentOptions) {
  const receipt = options.requestGate!({ requestId: 'request-' + options.environment!.DEEPSCIENTIST_MATH_WORKER_ID });
  expect(receipt.allowed).toBe(true);
  if (!receipt.allowed) throw new Error('fixture_request_not_admitted');
  receipt.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 60, outputTokens: 40, totalTokens: 100 } });
}

describe('solver library installation handoff', () => {
  it('waits for every writer to close, retains cumulative usage and never accepts the request as a proof', async () => {
    const f = fixture({ parallel: true, previous: true });
    const bothStarted = gate(), requestClosing = gate(), peerClosing = gate();
    const releaseRequest = gate(), releasePeer = gate(), peerTurn = gate<string>();
    const closes = [vi.fn(), vi.fn()];
    const draft = challenge.replace('by sorry', 'by\n  -- The saved draft still needs its library dependency.\n  sorry');
    let started = 0;
    const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => {
      const index = options.environment!.DEEPSCIENTIST_MATH_WORKER_ID === 'solver' ? 0 : 1;
      return { threadId: `library-request-${index}`, usageSource: 'upstream-requests',
        run: async (_message, _messageId, _workspace, onStarted) => {
          onStarted(`turn-${index}`); reportUsage(options);
          if (++started === 2) bothStarted.resolve();
          await bothStarted.promise;
          if (index) return peerTurn.promise;
          fs.writeFileSync(path.join(options.workspace, f.problem.projectRelative, 'Submission.lean'), draft);
          fs.writeFileSync(path.join(options.workspace, 'RESEARCH.md'), 'Saved work needs Catalog.identity.\n');
          expect(f.request(options.workspace)).toMatchObject({ status: 'queued' });
          return 'completed';
        }, interrupt: async () => {}, close: async () => {
          closes[index]();
          if (index) { peerClosing.resolve(); peerTurn.resolve('interrupted'); await releasePeer.promise; }
          else { requestClosing.resolve(); await releaseRequest.promise; }
        } };
    });
    let settled = false;
    const result = f.run(open).then(value => ({ value }), error => ({ error }));
    void result.then(() => { settled = true; });
    await requestClosing.promise;
    expect(settled).toBe(false); expect(closes[1]).not.toHaveBeenCalled();
    expect(f.check).not.toHaveBeenCalled();
    releaseRequest.resolve(); await peerClosing.promise;
    expect(settled).toBe(false);
    releasePeer.resolve();
    const outcome = await result;
    expect(outcome).toHaveProperty('error');
    const error = 'error' in outcome ? outcome.error : undefined;
    expect(error).toBeInstanceOf(LibraryInstallationRequested);
    expect(error).toMatchObject({ worktree: f.workers[0].worktree, request: {
      names: ['Catalog.identity'], catalogDigest: f.catalog.digest, problemReceiptDigest: f.problem.receiptDigest,
    } });
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(2); expect(f.state.turns).toBe(4);
    expect(f.state.usage).toEqual({ inputTokens: 132, outputTokens: 88, totalTokens: 220 });
    expect(f.state.tokenBudget).toMatchObject({ reportedTotalTokens: 220, usageComplete: true, status: 'available' });
    for (const worker of f.state.workers!) expect(worker).toMatchObject({ turns: 2, phase: 'finished',
      usageAccounting: { startedTurns: 2, reportedTurns: 2, pending: false, incomplete: false },
      requestUsageAccounting: { startedRequests: 2, reportedRequests: 2, pendingRequests: 0, incomplete: false } });
    expect(f.state.check).toBeUndefined(); expect(f.state.candidate).toBeUndefined();
    expect(f.state.winningWorker).toBeUndefined(); expect(f.state.error).toBeUndefined();
    expect(f.check).not.toHaveBeenCalled(); expect(host.verify).not.toHaveBeenCalled();
    expect(committedSource(f.workers[0].worktree, git(f.workers[0].worktree, ['rev-parse', 'HEAD']),
      path.join(f.problem.projectRelative, 'Submission.lean'))).toBe(draft);
    expect(fs.existsSync(path.join(f.workers[0].worktree, f.problem.projectRelative, moduleFile))).toBe(false);
    expect(f.events.filter(item => item.event === 'library_installation_requested')).toHaveLength(1);
  });

  it.each(['catalog', 'problem', 'seed', 'name', 'json'] as const)(
    'rejects an invalid %s request and continues ordinary proof checking without installation', async kind => {
      const f = fixture(), close = vi.fn(async () => {});
      const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => ({
        threadId: 'invalid-library-request', usageSource: 'upstream-requests', close, interrupt: async () => {},
        run: async (_message, _messageId, _workspace, onStarted) => {
          onStarted('invalid-request-turn'); reportUsage(options); f.request(options.workspace);
          const file = path.join(options.workspace, LIBRARY_REQUEST_FILE);
          const request = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (kind === 'catalog') request.catalogDigest = 'f'.repeat(64);
          if (kind === 'problem') request.problemReceiptDigest = 'f'.repeat(64);
          if (kind === 'seed') request.seedCommit = '0'.repeat(40);
          if (kind === 'name') request.names = ['Catalog.absent'];
          fs.writeFileSync(file, kind === 'json' ? '{incomplete' : JSON.stringify(request));
          return 'completed';
        },
      }));
      await expect(f.run(open)).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce();
      expect(f.state.turns).toBe(1); expect(f.state.usage).toEqual({ inputTokens: 60, outputTokens: 40, totalTokens: 100 });
      expect(f.state.tokenBudget).toMatchObject({ reportedTotalTokens: 100, usageComplete: true });
      expect(f.check).toHaveBeenCalledOnce(); expect(host.verify).toHaveBeenCalledOnce();
      expect(f.state.check?.passed).toBe(false); expect(f.state.winningWorker).toBeUndefined();
      expect(f.events.filter(item => item.event === 'library_request_rejected')).toHaveLength(1);
      expect(f.events.some(item => item.event === 'library_installation_requested')).toBe(false);
      expect(fs.existsSync(path.join(f.workers[0].worktree, LIBRARY_REQUEST_FILE))).toBe(false);
      expect(fs.existsSync(path.join(f.workers[0].worktree, f.problem.projectRelative, moduleFile))).toBe(false);
    });

  it('returns an accepted winner when a peer finishes its pending request during winner cleanup', async () => {
    const f = fixture({ parallel: true });
    host.verify.mockImplementation(async request => verifiedBatch(request, { sessionId: 'library-request-winner' }));
    const bothStarted = gate(), requestClosing = gate(), releaseRequest = gate();
    const closes = [vi.fn(), vi.fn()];
    let started = 0;
    const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => {
      const index = options.environment!.DEEPSCIENTIST_MATH_WORKER_ID === 'solver' ? 0 : 1;
      return { threadId: `winner-request-${index}`, usageSource: 'upstream-requests',
        run: async (_message, _messageId, _workspace, onStarted) => {
          onStarted(`winner-turn-${index}`); reportUsage(options);
          if (++started === 2) bothStarted.resolve();
          await bothStarted.promise;
          if (index) { f.request(options.workspace); return 'completed'; }
          await requestClosing.promise;
          fs.writeFileSync(path.join(options.workspace, f.problem.projectRelative, 'Submission.lean'),
            challenge.replace('by sorry', 'by rfl'));
          return 'completed';
        }, interrupt: async () => {}, close: async () => {
          closes[index]();
          if (index) { requestClosing.resolve(); await releaseRequest.promise; }
        } };
    });
    const winner = await f.run(open, event => { if (event === 'candidate_selected') releaseRequest.resolve(); });
    expect(winner).toMatchObject({ worktree: f.workers[0].worktree, check: { passed: true } });
    expect(f.state.winningWorker).toBe('solver'); expect(f.state.check).toBe(winner!.check);
    expect(f.check).toHaveBeenCalledOnce(); expect(host.verify).toHaveBeenCalledOnce();
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
    expect(f.state.turns).toBe(2); expect(f.state.usage).toEqual({ inputTokens: 120, outputTokens: 80, totalTokens: 200 });
    expect(f.state.tokenBudget).toMatchObject({ reportedTotalTokens: 200, usageComplete: true });
    expect(f.state.error).toBeUndefined();
  });
});
