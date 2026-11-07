import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalMathJson, mathDigest, withMathRuntimeLease } from '../src/math/mathRuntimeIo';
import { proofSearchCheckpointSchema, searchLeanBranches, type ProofSearchCheckpoint,
  type SearchCheckpointReference } from '../src/math/leanProofSearch';
import type { ProofSearchSession } from '../src/math/pantographSession';
import { projectProofSearchRecord, retainProofSearchCheckpoint } from '../src/solver/proofSearchRecords';

const boundary = vi.hoisted(() => ({ projection: vi.fn(), retainedProjection: vi.fn(), backend: vi.fn(), open: vi.fn() }));
vi.mock('../src/math/leanSearchProjection', () => ({
  prepareLeanSearchProjection: boundary.projection, prepareRetainedLeanSearchProjection: boundary.retainedProjection,
}));
vi.mock('../src/math/pantographSession', () => ({ readPantographBackend: boundary.backend, openPantographSession: boundary.open }));

// Only projection and protocol boundaries are fake. Checkpoint I/O, host retention and flock are real.
const toolchain = 'leanprover/lean4:v4.33.1';
const target = { file: 'Helpers.lean', theoremName: 'Helpers.refl', type: '∀ n : Nat, n = n' };
const scope = { taskId: 'helper', taskDigest: mathDigest('task'), problemReceiptDigest: mathDigest('problem'),
  environmentDigest: mathDigest('run environment') };
const prefix = 'namespace Helpers\nset_option autoImplicit false\n';
const sources = [{ file: target.file, source: 'namespace Helpers\ntheorem refl : ∀ n : Nat, n = n := by sorry\nend Helpers\n' },
  { file: 'lean-toolchain', source: toolchain + '\n' }];
const sourceFiles = sources.map(({ file, source }) => ({ file, digest: mathDigest(source) }));
const environment = { environmentDigest: mathDigest('diagnostic environment'), toolIdentity: mathDigest('lean and lake') };
const backendDigest = mathDigest('pinned fake backend');

function projection(project: string, change: Record<string, unknown> = {}) {
  return { project: path.join(project, '.lake', 'fake-projection'), prefix,
    sourceDigest: mathDigest(canonicalMathJson(sourceFiles)), projectionDigest: mathDigest('fixture projection'),
    sourceFiles: structuredClone(sourceFiles), environment: { ...environment }, replaySources: structuredClone(sources),
    verify: vi.fn(), dispose: vi.fn(), compile: vi.fn(async () => undefined), ...change };
}
function session(options: { firstStateId?: number; beforeTactic?: (tactic: string) => void } = {}) {
  let nextStateId = options.firstStateId ?? 10;
  const states = new Map<number, boolean>(), tactics: { stateId: number; tactic: string }[] = [];
  const fake: ProofSearchSession & { tactics: typeof tactics; close: ReturnType<typeof vi.fn> } = {
    tactics, close: vi.fn(async () => undefined),
    async request(command, payload) {
      if (command === 'options.set') return {};
      if (command === 'frontend.process') return { units: [{ messages: [] }] };
      if (command === 'goal.start') {
        const stateId = nextStateId++; states.set(stateId, false); return { stateId, root: '?m.root' };
      }
      const stateId = payload.stateId as number;
      if (!states.has(stateId)) throw new Error('fixture_unknown_session_state');
      if (command === 'goal.print') {
        const closed = states.get(stateId)!;
        return { root: closed ? 'fun n => Eq.refl n' : '?m.root', goals: closed ? [] : [{ target: 'n = n' }],
          rootHasSorry: false, rootHasUnsafe: false, rootHasMVar: !closed };
      }
      if (command !== 'goal.tactic' || typeof payload.tactic !== 'string') throw new Error('fixture_unknown_command');
      tactics.push({ stateId, tactic: payload.tactic }); options.beforeTactic?.(payload.tactic);
      const next = nextStateId++; states.set(next, payload.tactic === 'rfl');
      return { nextStateId: next, hasSorry: false, hasUnsafe: false };
    },
  };
  return fake;
}

type SearchInput = Parameters<typeof searchLeanBranches>[0];
let directory: string, project: string, env: NodeJS.ProcessEnv;
function makeProject(name: string) {
  const root = path.join(directory, name); fs.mkdirSync(root);
  for (const source of sources) fs.writeFileSync(path.join(root, source.file), source.source);
  return root;
}
function readCheckpoint(root: string, reference: SearchCheckpointReference): ProofSearchCheckpoint {
  const file = path.resolve(root, reference.path), bytes = fs.readFileSync(file);
  expect(mathDigest(bytes)).toBe(reference.digest);
  return proofSearchCheckpointSchema.parse(JSON.parse(bytes.toString('utf8')));
}
function search(options: Partial<SearchInput> = {}) {
  return searchLeanBranches({ projectRoot: project, ...target, scope, env,
    request: { branches: [{ tactics: ['intro n'] }], limits: { timeoutMs: 30_000, maxTransitions: 32 } }, ...options });
}
function continuation(reference: SearchCheckpointReference, checkpoint: ProofSearchCheckpoint) {
  const frontier = checkpoint.nodes.find(node => node.tactics.length === 1)!;
  return { resume: reference, branches: [{ from: frontier.id, tactics: ['rfl'] }],
    limits: { timeoutMs: 30_000, maxTransitions: 32 } };
}
async function savedSearch() {
  const output = projection(project), fake = session();
  boundary.projection.mockReturnValue(output); boundary.open.mockResolvedValue(fake);
  const result = await search();
  expect(result.status).toBe('exhausted'); expect(result.checkpoint).toBeDefined();
  const reference = result.checkpoint!, checkpoint = readCheckpoint(project, reference);
  return { result, reference, checkpoint, output, fake };
}
function clearBoundaryCalls() {
  boundary.projection.mockClear(); boundary.retainedProjection.mockClear(); boundary.open.mockClear();
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-search-runtime-'));
  project = makeProject('owner');
  const envFile = path.join(directory, 'math.env'); fs.writeFileSync(envFile, '');
  env = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: envFile };
  for (const mock of Object.values(boundary)) mock.mockReset();
  boundary.backend.mockReturnValue({ digest: backendDigest, toolchain, verify: vi.fn() });
  boundary.retainedProjection.mockImplementation(() => { throw new Error('unexpected_retained_projection'); });
});
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

describe('proof-search runtime persistence with fake Lean boundaries', () => {
  it('rejects a 4.33.0 backend for a 4.33.1 project before preparing sources or opening a session', async () => {
    boundary.backend.mockReturnValue({ digest: backendDigest, toolchain: 'leanprover/lean4:v4.33.0', verify: vi.fn() });
    const result = await search();
    expect(result).toMatchObject({ status: 'unavailable', reason: 'proof_search_backend_toolchain_mismatch',
      authority: 'advisory-proof-search', proofAcceptance: 'not-accepted' });
    expect(boundary.projection).not.toHaveBeenCalled(); expect(boundary.retainedProjection).not.toHaveBeenCalled();
    expect(boundary.open).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(project, '.lake'))).toBe(false);
  });

  it('persists intent before sending a tactic and releases the session and writer lock after interruption', async () => {
    const output = projection(project); boundary.projection.mockReturnValue(output);
    let lastSaved: SearchCheckpointReference | undefined, intent: SearchCheckpointReference | undefined;
    const fake = session({ beforeTactic(tactic) {
      expect(tactic).toBe('intro n'); expect(lastSaved).toBeDefined();
      intent = { ...lastSaved! };
      const saved = readCheckpoint(project, intent);
      expect(saved.actions.at(-1)).toMatchObject({ status: 'issued', replay: false });
      expect(saved.counters).toMatchObject({ issued: 1, completed: 0, replay: 0 });
      expect(saved.replaySources).toEqual(sources);
      throw new Error('fixture_transport_interrupted');
    } });
    boundary.open.mockResolvedValue(fake);
    const result = await search({ onCheckpoint(reference) { lastSaved = { ...reference }; } });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'fixture_transport_interrupted',
      authority: 'advisory-proof-search', proofAcceptance: 'not-accepted', counters: { issued: 1, completed: 0 } });
    expect(intent).toBeDefined();
    expect(readCheckpoint(project, intent!).actions[0]?.status).toBe('issued');
    expect(readCheckpoint(project, result.checkpoint!).counters).toMatchObject({ issued: 1, completed: 0 });
    expect(fs.statSync(path.resolve(project, result.checkpoint!.path)).mode & 0o777).toBe(0o400);
    expect(fake.close).toHaveBeenCalledTimes(1); expect(output.dispose).toHaveBeenCalledTimes(1);
    const lockPath = path.join(path.dirname(path.resolve(project, result.checkpoint!.path)), 'writer.lock');
    await expect(withMathRuntimeLease({ lockPath, flockExecutable: '/usr/bin/flock' }, async () => 'released'))
      .resolves.toBe('released');
    const retryProjection = projection(project), retrySession = session({ firstStateId: 200 });
    boundary.projection.mockReturnValue(retryProjection); boundary.open.mockResolvedValue(retrySession);
    const retry = await search({ request: { resume: result.checkpoint, branches: [{ tactics: ['intro n'] }],
      limits: { timeoutMs: 30_000, maxTransitions: 1 } } });
    expect(retry).toMatchObject({ status: 'exhausted', counters: { issued: 2, completed: 1, replay: 1 } });
    expect(readCheckpoint(project, retry.checkpoint!).actions.map(action => action.status)).toEqual(['interrupted', 'completed']);
    expect(readCheckpoint(project, intent!).actions[0]?.status).toBe('issued');
    expect(retrySession.close).toHaveBeenCalledTimes(1); expect(retryProjection.dispose).toHaveBeenCalledTimes(1);
  });

  it('retains checkpoint bytes on the host and explicitly resumes in another worker with replay charged', async () => {
    const first = await savedSearch(), originalBytes = fs.readFileSync(path.resolve(project, first.reference.path));
    const record = retainProofSearchCheckpoint({ projectRoot: project, runDirectory: directory, reference: first.reference,
      scope, workerId: 'owner', assignmentKey: 'DELIVERIES-helper.jsonl' });
    fs.rmSync(project, { recursive: true });
    const replacement = makeProject('replacement');
    const restored = projectProofSearchRecord({ record, scope, projectRoot: replacement, runDirectory: directory })!;
    expect(restored).toBeDefined();
    expect(fs.readFileSync(restored.checkpoint.path)).toEqual(originalBytes);
    expect(record).toMatchObject({ evidence: 'advisory-proof-search', proofAcceptance: 'not-accepted' });
    const output = projection(replacement), fake = session({ firstStateId: 1000 });
    boundary.projection.mockReturnValue(output); boundary.open.mockResolvedValue(fake);
    const result = await search({ projectRoot: replacement, request: continuation(restored.checkpoint, first.checkpoint) });
    expect(result).toMatchObject({ status: 'candidate', proofAcceptance: 'not-accepted',
      counters: { issued: 3, completed: 3, replay: 1 } });
    expect(fake.tactics).toEqual([{ stateId: 1000, tactic: 'intro n' }, { stateId: 1001, tactic: 'rfl' }]);
    const saved = readCheckpoint(replacement, result.checkpoint!);
    expect(saved.generation).toBeGreaterThan(first.checkpoint.generation);
    expect(saved.replaySources).toEqual(first.checkpoint.replaySources);
    expect(saved.actions.map(action => action.replay)).toEqual([false, true, false]);
    expect(fs.readFileSync(record.checkpoint.path)).toEqual(originalBytes);
    const candidate = result.candidates[0]!.artifact;
    const proof = fs.readFileSync(path.resolve(replacement, candidate.path));
    expect(mathDigest(proof)).toBe(candidate.digest);
    expect(proof.toString()).toBe('by\n  intro n\n  rfl\n');
    expect(first.fake.close).toHaveBeenCalledTimes(1); expect(fake.close).toHaveBeenCalledTimes(1);
    expect(output.dispose).toHaveBeenCalledTimes(1); expect(boundary.retainedProjection).not.toHaveBeenCalled();
  });

  it('keeps ordinary owner resumes stale when current source changes instead of restoring retained source', async () => {
    const first = await savedSearch(), changedSource = sources[0]!.source + '-- new owner edit\n';
    fs.writeFileSync(path.join(project, target.file), changedSource);
    const changedFiles = [{ file: target.file, digest: mathDigest(changedSource) }, sourceFiles[1]!];
    const output = projection(project, { sourceFiles: changedFiles,
      sourceDigest: mathDigest(canonicalMathJson(changedFiles)), projectionDigest: mathDigest('changed projection'),
      replaySources: [{ file: target.file, source: changedSource }, sources[1]!] });
    clearBoundaryCalls(); boundary.projection.mockReturnValue(output);
    const result = await search({ request: continuation(first.reference, first.checkpoint) });
    expect(result).toMatchObject({ status: 'stale', reason: 'proof_search_stale_basis', proofAcceptance: 'not-accepted' });
    expect(boundary.projection).toHaveBeenCalledTimes(1); expect(boundary.retainedProjection).not.toHaveBeenCalled();
    expect(boundary.open).not.toHaveBeenCalled(); expect(output.compile).not.toHaveBeenCalled();
    expect(output.dispose).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(project, target.file), 'utf8')).toBe(changedSource);
    expect(readCheckpoint(project, first.reference)).toEqual(first.checkpoint);
  });

  it.each([
    ['basisDigest', 'proof_search_stale_retained_basis'],
    ['checkpointDigest', 'proof_search_stale_retained_checkpoint'],
  ] as const)('rejects a retained-input %s mismatch before preparing sources or opening a backend', async (field, reason) => {
    const first = await savedSearch(); clearBoundaryCalls();
    const retainedInput = { basisDigest: first.result.basis!, checkpointDigest: first.reference.digest,
      [field]: mathDigest('another authorization') };
    const result = await search({ request: continuation(first.reference, first.checkpoint), retainedInput });
    expect(result).toMatchObject({ status: 'stale', reason, proofAcceptance: 'not-accepted' });
    expect(boundary.projection).not.toHaveBeenCalled(); expect(boundary.retainedProjection).not.toHaveBeenCalled();
    expect(boundary.open).not.toHaveBeenCalled();
    expect(readCheckpoint(project, first.reference)).toEqual(first.checkpoint);
  });

  it('uses retained projection only with the matching input and preserves the independent worker source', async () => {
    const first = await savedSearch(); clearBoundaryCalls();
    const canonicalSource = '-- Independent worker has no unintegrated helper.\n';
    fs.writeFileSync(path.join(project, target.file), canonicalSource);
    boundary.projection.mockImplementation(() => { throw new Error('live_source_must_not_be_projected'); });
    const output = projection(project), fake = session({ firstStateId: 500 });
    boundary.retainedProjection.mockReturnValue(output); boundary.open.mockResolvedValue(fake);
    const result = await search({ request: continuation(first.reference, first.checkpoint),
      retainedInput: { basisDigest: first.result.basis!, checkpointDigest: first.reference.digest } });
    expect(result).toMatchObject({ status: 'candidate', basis: first.result.basis, proofAcceptance: 'not-accepted',
      counters: { issued: 3, completed: 3, replay: 1 } });
    expect(boundary.retainedProjection).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: project, ...target,
      scope, sources: first.checkpoint.replaySources }));
    expect(boundary.projection).not.toHaveBeenCalled(); expect(output.compile).toHaveBeenCalledTimes(1);
    expect(output.verify).toHaveBeenCalledTimes(1); expect(fake.close).toHaveBeenCalledTimes(1);
    expect(output.dispose).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(project, target.file), 'utf8')).toBe(canonicalSource);
    expect(readCheckpoint(project, result.checkpoint!).basis).toEqual(first.checkpoint.basis);
  });

  it.each(['sourceDigest', 'projectionDigest', 'sourceFiles', 'environment', 'backendDigest'] as const)(
    'rejects recomputed %s changes even with the correct retained-input authorization', async field => {
      const first = await savedSearch(); clearBoundaryCalls();
      const changed = mathDigest('changed basis field');
      const override = field === 'sourceFiles' ? { sourceFiles: [{ ...sourceFiles[0]!, digest: changed }, sourceFiles[1]!] }
        : field === 'environment' ? { environment: { ...environment, toolIdentity: changed } }
        : field === 'backendDigest' ? {} : { [field]: changed };
      const output = projection(project, override); boundary.retainedProjection.mockReturnValue(output);
      if (field === 'backendDigest') boundary.backend.mockReturnValue({ digest: changed, toolchain, verify: vi.fn() });
      const result = await search({ request: continuation(first.reference, first.checkpoint),
        retainedInput: { basisDigest: first.result.basis!, checkpointDigest: first.reference.digest } });
      expect(result).toMatchObject({ status: 'stale', reason: 'proof_search_stale_basis', proofAcceptance: 'not-accepted' });
      expect(boundary.retainedProjection).toHaveBeenCalledTimes(1); expect(boundary.projection).not.toHaveBeenCalled();
      expect(boundary.open).not.toHaveBeenCalled(); expect(output.compile).not.toHaveBeenCalled();
      expect(output.dispose).toHaveBeenCalledTimes(1);
      expect(readCheckpoint(project, first.reference)).toEqual(first.checkpoint);
    });

  it('disposes a failed projection without opening a session and releases the real writer lock', async () => {
    const output = projection(project); output.compile.mockRejectedValue(new Error('fixture_compile_failed'));
    boundary.projection.mockReturnValue(output);
    const result = await search();
    expect(result).toMatchObject({ status: 'unavailable', reason: 'fixture_compile_failed' });
    expect(boundary.open).not.toHaveBeenCalled(); expect(output.dispose).toHaveBeenCalledTimes(1);
    const saved = readCheckpoint(project, result.checkpoint!);
    expect(saved.counters).toMatchObject({ issued: 0, completed: 0 });
    const lockPath = path.join(path.dirname(path.resolve(project, result.checkpoint!.path)), 'writer.lock');
    await expect(withMathRuntimeLease({ lockPath, flockExecutable: '/usr/bin/flock' }, async () => 'released'))
      .resolves.toBe('released');
  });
});
