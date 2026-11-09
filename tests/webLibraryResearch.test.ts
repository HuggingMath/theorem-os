import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWebLibraryResearch, type WebLibraryRound } from '../apps/web/libraryResearch';
import { prepareWebProblem } from '../apps/web/formalizationSeed';
import { webDefaults } from '../apps/web/config';
import type { WebRunInput, WorkerInput } from '../apps/web/shared';
import { formalizationDigest, readFormalizationArtifact } from '../src/math/formalization';
import { LIBRARY_PACK_SCHEMA, type LibraryPack } from '../src/math/libraryPacks';
import { mathDigest, readMathJson, readMathText, writeMathJsonDurable } from '../src/math/mathRuntimeIo';
import { writeSolverRunState } from '../src/solver/archive';
import { readContinuationInput } from '../src/solver/continuationInput';
import { writeLibraryCatalog } from '../src/solver/libraryCatalog';
import { git, readSolverProblem } from '../src/solver/problem';
import { approvedFormalization } from './helpers/approvedFormalizationFixture';
import { solverState } from './helpers/solver';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const initial = 'Submission/Library/Research/Initial.lean';
const base = 'Submission/Library/Research/Base.lean';
const feature = 'Submission/Library/Research/Feature.lean';
const extra = 'Submission/Library/Research/Extra.lean';
const unused = 'Submission/Library/Research/Unused.lean';
const sources = {
  [initial]: 'namespace Research\ntheorem retained : True := True.intro\nend Research\n',
  [base]: 'namespace Research\ndef usable : Prop := True\nend Research\n',
  [feature]: 'import Submission.Library.Research.Base\nnamespace Research\ntheorem desired : usable := True.intro\nend Research\n',
  [extra]: 'namespace Research\ntheorem final_hint (n : Nat) : n = n := rfl\nend Research\n',
  [unused]: 'namespace Research\ntheorem unrelated (p : Prop) (h : p) : p := h\nend Research\n',
};
const pack: LibraryPack = { schema: LIBRARY_PACK_SCHEMA, modules: Object.entries(sources).map(([file, source]) => ({
  file, source, origin: { kind: 'upstream', repository: 'offline-research-fixture', commit: 'a'.repeat(40), file: file.split('/').at(-1)! },
})) };
const source = 'namespace Original\ntheorem goal : True := by sorry\nend Original\n';

function fixture(input: Partial<WebRunInput> = {}, formalization?: unknown) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-library-research-'))); roots.push(root);
  const libraryCatalog = writeLibraryCatalog(path.join(root, 'release'), { id: 'fixture/research', revision: 'v1',
    environment: 'mathlib', packs: [pack] });
  vi.stubEnv('THEOREMOS_LIBRARY_CATALOG', libraryCatalog.file);
  vi.stubEnv('THEOREMOS_LIBRARY_CATALOG_SHA256', libraryCatalog.digest);
  const directory = path.join(root, 'web'); fs.mkdirSync(directory);
  const request: WorkerInput = { id: 'web-fixture', provider: { id: 'offline', name: 'Offline', baseUrl: 'http://unused.invalid/v1' },
    input: { ...webDefaults, providerId: 'offline', apiKey: 'offline-unused-key', source,
      task: 'Prove the frozen original and preserve all of its declarations.', environment: 'mathlib',
      workers: 1, maxTurns: 10, maxRunSeconds: 120, maxTotalTokens: 1000, ...input },
    ...(formalization ? { formalization } : {}) };
  const seed = prepareWebProblem(directory, request, { libraryPack: { ...pack, modules: [pack.modules[0]!] } });
  return { root, directory, request, seed, output: path.join(directory, 'result.json'),
    libraryCatalog: { file: libraryCatalog.file, digest: libraryCatalog.digest } };
}
type Fixture = ReturnType<typeof fixture>;
type Consumption = { turns?: number; solveWallMs?: number; tokens?: number | null; incompleteUsage?: boolean };

/** Only host state/result fixtures are written. No Lean process, provider or solver session runs. */
function finishRound(f: Fixture, round: WebLibraryRound, names?: string[], used: Consumption = {}) {
  const problem = readSolverProblem(round.seed.workspaceRoot, round.seed.activeProblemPath);
  const turns = used.turns ?? 1, solveWallMs = used.solveWallMs ?? 1000;
  const usage = used.tokens === null ? undefined : { totalTokens: used.tokens ?? 100 };
  const state = solverState(problem, round.seed.workspaceRoot, { runId: `solver-round-${round.round}`, phase: 'finished',
    workerCount: 1, coordination: 'cooperative', turns, solveStartedAt: 1000, solveFinishedAt: 1000 + solveWallMs,
    usage, usageAccounting: { startedTurns: turns, reportedTurns: usage ? turns : 0, pending: false,
      incomplete: Boolean(used.incompleteUsage || !usage) } });
  const stateFile = `${round.output}.runtime/state.json`;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true }); writeSolverRunState(stateFile, state);
  const raw = { runId: state.runId, status: names ? 'library_requested' : 'incomplete', turns, solveWallMs,
    ...(names ? { libraryRequest: { worktree: state.worktree, request: { schema: 'theorem-os.library-request.v1',
      catalogDigest: f.libraryCatalog.digest, problemReceiptDigest: problem.receiptDigest,
      seedCommit: git(state.worktree, ['rev-parse', 'HEAD']), names, reason: 'Need this public interface for the current proof.' } } } : {}) };
  writeMathJsonDurable(round.output, raw);
  return { state, stateFile, raw, problem };
}

describe('Web library research supervision without provider calls', () => {
  it('carries execution time across library rounds without charging idle human approval time', async () => {
    const f = fixture({ maxRunSeconds: 12 }), limits: number[] = [];
    const result = await runWebLibraryResearch({ ...f, run: async round => {
      limits.push(round.limits.maxRunSeconds);
      const completed = finishRound(f, round, round.round === 0 ? ['Research.desired'] : undefined,
        { solveWallMs: round.round === 0 ? 600_000 : 1_000 });
      writeMathJsonDurable(round.output, { ...completed.raw, solveExecutionMs: 1_000 });
    } });
    expect(limits).toEqual([12, 11]);
    expect(result.raw).toMatchObject({ solveWallMs: 601_000, solveExecutionMs: 2_000, solveWaitingMs: 599_000 });
  });
  it('installs the requested dependency closure in a new receipt and retains drafts, notes and original continuation as advisory material', async () => {
    const f = fixture(), original = readSolverProblem(f.seed.workspaceRoot, f.seed.activeProblemPath);
    const receiptBefore = fs.readFileSync(f.seed.activeProblemPath), taskBefore = readMathText(f.seed.taskFile);
    const reference = 'An original user reference that must survive the library installation.';
    fs.writeFileSync(path.join(f.directory, 'original-reference.txt'), reference);
    const continuationFile = path.join(f.directory, 'original-continuation.json');
    writeMathJsonDurable(continuationFile, { schema: 'theorem-os.continuation-input.v1', taskDigest: mathDigest(taskBefore),
      problemReceiptDigest: original.receiptDigest, attachments: [{ id: 'original-reference', kind: 'reference',
        path: 'original-reference.txt', sha256: mathDigest(reference), bytes: Buffer.byteLength(reference),
        provenance: { source: 'Original user reference', evidence: 'unverified' } }] });
    const calls: WebLibraryRound[] = [], draft = source + '\n-- saved unfinished draft\n';
    const notes = 'The requested helper may close the original goal; this is still unverified research.';
    const result = await runWebLibraryResearch({ ...f, continuationFile, run: async round => {
      calls.push(round);
      if (round.round === 0) {
        expect(round.continuationFile).toBe(continuationFile);
        expect(Object.keys(original.frozenFiles)).toEqual([initial]);
        fs.writeFileSync(path.join(original.workspace, original.projectRelative, 'Submission.lean'), draft);
        fs.writeFileSync(path.join(original.workspace, 'RESEARCH.md'), notes);
        finishRound(f, round, ['Research.desired']);
        return;
      }
      const current = readSolverProblem(round.seed.workspaceRoot, round.seed.activeProblemPath);
      expect(round).toMatchObject({ round: 1, previousSolverRunId: 'solver-round-0', requestedNames: ['Research.desired'] });
      expect(current.receiptDigest).not.toBe(original.receiptDigest);
      expect(current.contract.formalStatement).toBe(source);
      expect(current.contract.informalStatement).toBe(original.contract.informalStatement);
      expect(current.targets).toEqual(original.targets);
      expect(readMathText(round.seed.taskFile)).toBe(taskBefore);
      expect(readMathText(path.join(current.workspace, current.projectRelative, 'Submission.lean'))).toBe(source);
      expect(Object.keys(current.frozenFiles).sort()).toEqual([initial, base, feature].sort());
      for (const file of [initial, base, feature]) {
        expect(current.frozenFiles[file]).toBe(mathDigest(sources[file]));
        expect(readMathText(path.join(current.workspace, current.projectRelative, file))).toBe(sources[file]);
      }
      const continued = readContinuationInput(round.continuationFile!, {
        taskDigest: mathDigest(taskBefore), problemReceiptDigest: current.receiptDigest });
      const attachments = continued.manifest.attachments.map(item => ({ ...item, text: continued.contents.get(item.sha256) }));
      expect(attachments).toHaveLength(3);
      expect(attachments).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'reference', text: reference, provenance: { source: 'Original user reference', evidence: 'unverified' } }),
        expect.objectContaining({ kind: 'proof-source', text: expect.stringContaining(draft),
          provenance: expect.objectContaining({ evidence: 'recorded-not-replayed', runId: 'solver-round-0' }) }),
        expect.objectContaining({ kind: 'research-notes', text: notes,
          provenance: expect.objectContaining({ evidence: 'recorded-not-replayed', runId: 'solver-round-0' }) }),
      ]));
      expect(attachments.filter(item => item.kind === 'proof-source')[0]!.text).not.toContain(sources[initial]);
      expect(fs.readFileSync(f.seed.activeProblemPath)).toEqual(receiptBefore);
      expect(readSolverProblem(f.seed.workspaceRoot, f.seed.activeProblemPath).frozenFiles).toEqual(original.frozenFiles);
      finishRound(f, round);
    } });
    expect(calls).toHaveLength(2);
    expect((result.raw.libraryResearch as { rounds: unknown[] }).rounds[0]).toMatchObject({
      libraryRequest: { names: ['Research.desired'], catalogDigest: f.libraryCatalog.digest },
      librarySelection: { catalogDigest: f.libraryCatalog.digest,
        modules: expect.arrayContaining([expect.objectContaining({ file: feature }), expect.objectContaining({ file: base })]) },
    });
    expect(f.request.input.workers).toBe(1);
    expect(result.output).toBe(calls[1]!.output);
    expect(result.raw).toMatchObject({ status: 'incomplete', turns: 2, solveWallMs: 2000,
      libraryResearch: { schema: 'theorem-os.library-research.v1', rounds: [
        { round: 0, runId: 'solver-round-0', installedModules: [initial] },
        { round: 1, runId: 'solver-round-1', previousSolverRunId: 'solver-round-0', installedModules: [base, feature, initial].sort() },
      ] } });
    expect(readMathJson(path.join(f.directory, 'library-research.json'))).toEqual(result.raw);
  });

  it('passes the remaining total turn, wall-time and worker token allowance to each later round', async () => {
    const f = fixture({ maxRunSeconds: 12 }), calls: WebLibraryRound[] = [];
    const result = await runWebLibraryResearch({ ...f, run: async round => {
      calls.push(round);
      const saved = finishRound(f, round, round.round === 0 ? ['Research.desired'] : round.round === 1 ? ['Research.final_hint'] : undefined,
        [{ turns: 2, solveWallMs: 1500, tokens: 120 }, { turns: 3, solveWallMs: 2500, tokens: 230 },
          { turns: 1, solveWallMs: 1000, tokens: 50 }][round.round]);
      // A cooperative state reports totals at both levels; count the worker records exactly once.
      saved.state.workers = [{ id: 'solver', role: 'lead', worktree: saved.state.worktree, phase: 'finished',
        turns: saved.state.turns, usage: saved.state.usage, usageAccounting: saved.state.usageAccounting }];
      writeSolverRunState(saved.stateFile, saved.state);
      if (round.round === 2) expect(Object.keys(saved.problem.frozenFiles).sort()).toEqual([initial, base, feature, extra].sort());
    } });
    expect(calls.map(round => round.limits)).toEqual([
      { maxTurns: 10, maxRunSeconds: 12, maxTotalTokens: 1000 },
      { maxTurns: 8, maxRunSeconds: 10, maxTotalTokens: 880 },
      { maxTurns: 5, maxRunSeconds: 8, maxTotalTokens: 650 },
    ]);
    expect(result.raw).toMatchObject({ status: 'incomplete', turns: 6, solveWallMs: 5000, usage: { totalTokens: 400 },
      tokenBudget: { status: 'available', reportedTotalTokens: 400, usageComplete: true } });
  });

  it('retains all 32 original reference bodies plus new drafts and notes within the continuation attachment limit', async () => {
    const f = fixture(), original = readSolverProblem(f.seed.workspaceRoot, f.seed.activeProblemPath);
    const taskDigest = mathDigest(readMathText(f.seed.taskFile));
    const references = Array.from({ length: 32 }, (_, index) => `Original reference ${index}: preserve this distinct body [reference-${index}].`);
    const continuationFile = path.join(f.directory, 'full-continuation.json');
    writeMathJsonDurable(continuationFile, { schema: 'theorem-os.continuation-input.v1', taskDigest,
      problemReceiptDigest: original.receiptDigest, attachments: references.map((text, index) => {
        const file = `original-reference-${index}.txt`; fs.writeFileSync(path.join(f.directory, file), text);
        return { id: `reference-${index}`, kind: 'reference', path: file, sha256: mathDigest(text), bytes: Buffer.byteLength(text),
          provenance: { source: `Original reference ${index}`, evidence: 'unverified' } };
      }) });
    expect(readContinuationInput(continuationFile, { taskDigest, problemReceiptDigest: original.receiptDigest }).manifest.attachments)
      .toHaveLength(32);
    const draft = source + '\n-- new draft retained alongside the full original attachment set\n';
    const notes = 'New research notes that must survive a library restart with 32 existing references.';
    const run = vi.fn(async (round: WebLibraryRound) => {
      if (round.round === 0) {
        fs.writeFileSync(path.join(original.workspace, original.projectRelative, 'Submission.lean'), draft);
        fs.writeFileSync(path.join(original.workspace, 'RESEARCH.md'), notes);
        finishRound(f, round, ['Research.desired']);
        return;
      }
      const current = readSolverProblem(round.seed.workspaceRoot, round.seed.activeProblemPath);
      expect(current.receiptDigest).not.toBe(original.receiptDigest);
      const continued = readContinuationInput(round.continuationFile!, { taskDigest, problemReceiptDigest: current.receiptDigest });
      expect(continued.manifest.attachments.length).toBeLessThanOrEqual(32);
      expect(continued.manifest.problemReceiptDigest).toBe(current.receiptDigest);
      const retained = [...continued.contents.values()].join('\n\n');
      for (const text of [...references, draft, notes]) expect(retained).toContain(text);
      expect(new Set(continued.manifest.attachments.map(item => item.kind)))
        .toEqual(new Set(['reference', 'proof-source', 'research-notes']));
      finishRound(f, round);
    });
    const result = await runWebLibraryResearch({ ...f, continuationFile, run });
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.raw).toMatchObject({ status: 'incomplete' });
  });

  it.each([
    ['turns', { maxTurns: 2 }, { turns: 2 }, 'math_turn_limit_reached'],
    ['time', { maxRunSeconds: 2 }, { solveWallMs: 2000 }, 'math_run_stopped'],
    ['tokens', { maxTotalTokens: 100 }, { tokens: 100 }, 'math_total_token_limit'],
    ['missing usage', { maxTotalTokens: 1000 }, { tokens: null }, 'math_model_usage_unavailable'],
    ['incomplete usage', { maxTotalTokens: 1000 }, { tokens: 10, incompleteUsage: true }, 'math_model_usage_unavailable'],
  ] as const)('ends without starting another round when finite %s allowance cannot continue', async (_label, limits, used, reason) => {
    const f = fixture(limits), run = vi.fn(async (round: WebLibraryRound) => { finishRound(f, round, ['Research.desired'], used); });
    const result = await runWebLibraryResearch({ ...f, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.raw).toMatchObject({ status: 'limit_reached', run_outcome: 'limit_reached', reason });
    expect(fs.existsSync(path.join(f.directory, 'rounds'))).toBe(false);
  });

  it('preserves unlimited allowances through a restart even when tokens are not reported', async () => {
    const f = fixture({ maxTurns: 0, maxRunSeconds: 0, maxTotalTokens: 0 }), limits: WebLibraryRound['limits'][] = [];
    const result = await runWebLibraryResearch({ ...f, run: async round => {
      limits.push(round.limits); finishRound(f, round, round.round === 0 ? ['Research.desired'] : undefined, { tokens: null });
    } });
    expect(limits).toEqual(Array.from({ length: 2 }, () => ({ maxTurns: 0, maxRunSeconds: 0, maxTotalTokens: 0 })));
    expect(result.raw).toMatchObject({ status: 'incomplete', tokenBudget: { status: 'unlimited', usageComplete: false } });
  });

  it.each(['unknown worker', 'outside worker', 'catalog identity', 'problem identity', 'run identity', 'state receipt'] as const)
    ('rejects an installation request with changed %s', async mode => {
      const f = fixture();
      const run = vi.fn(async (round: WebLibraryRound) => {
        const saved = finishRound(f, round, ['Research.desired']);
        if (mode === 'unknown worker') saved.raw.libraryRequest!.worktree = path.join(f.directory, 'unregistered-worker');
        if (mode === 'outside worker') {
          saved.raw.libraryRequest!.worktree = f.root;
          saved.state.workers = [{ id: 'outside', role: 'researcher', worktree: f.root, phase: 'finished', turns: 0 }];
        }
        if (mode === 'catalog identity') saved.raw.libraryRequest!.request.catalogDigest = 'b'.repeat(64);
        if (mode === 'problem identity') saved.raw.libraryRequest!.request.problemReceiptDigest = 'b'.repeat(64);
        if (mode === 'run identity') saved.raw.runId = 'another-solver';
        if (mode === 'state receipt') saved.state.problem = { ...saved.problem, receiptDigest: 'b'.repeat(64) };
        writeSolverRunState(saved.stateFile, saved.state); writeMathJsonDurable(round.output, saved.raw);
      });
      await expect(runWebLibraryResearch({ ...f, run })).rejects.toThrow(
        mode.includes('worker') ? 'math_library_request_worker_changed' : mode === 'run identity' || mode === 'state receipt'
          ? 'math_library_request_run_identity_changed' : 'math_library_request_identity_changed');
      expect(run).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(f.directory, 'rounds'))).toBe(false);
    });

  it('keeps the approved informal original and formalization evidence through a library restart', async () => {
    const approved = await approvedFormalization(roots, 'web-library-research-original', 'mathlib');
    const evidence = readFormalizationArtifact(path.join(approved, 'artifact'));
    const f = fixture({ source: evidence.candidate.source, formalizationId: evidence.request.problemId }, evidence);
    const before = readSolverProblem(f.seed.workspaceRoot, f.seed.activeProblemPath), rounds: WebLibraryRound[] = [];
    await runWebLibraryResearch({ ...f, run: async round => {
      rounds.push(round);
      const current = readSolverProblem(round.seed.workspaceRoot, round.seed.activeProblemPath);
      expect(current.contract.informalStatement).toContain(evidence.request.statementSha256);
      expect(current.contract.formalStatement).toBe(evidence.candidate.source);
      expect(current.contract).toEqual(before.contract);
      if (round.round === 1) {
        const continuedEvidence = readFormalizationArtifact(path.join(f.directory, 'rounds', '1', 'formalized', 'artifact'));
        expect(continuedEvidence.request.statement).toBe(evidence.request.statement);
        expect(formalizationDigest(continuedEvidence)).toBe(formalizationDigest(evidence));
      }
      finishRound(f, round, round.round === 0 ? ['Research.desired'] : undefined);
    } });
    expect(rounds).toHaveLength(2);
    expect(readMathText(rounds[1]!.seed.taskFile)).toBe(readMathText(f.seed.taskFile));
  });
});
