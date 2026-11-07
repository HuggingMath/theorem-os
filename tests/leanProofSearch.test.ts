import { describe, expect, it } from 'vitest';
import { advanceLeanProofSearch, AesopPartialTactic, emptyProofSearchCheckpoint, proofSearchCheckpointSchema,
  proofSearchRequestSchema, type ProofSearchBasis, type ProofSearchCheckpoint } from '../src/math/leanProofSearch';
import type { ProofSearchSession, ProofStateView } from '../src/math/pantographSession';

const basis: ProofSearchBasis = {
  scope: { taskId: 'helper', taskDigest: 'a'.repeat(64), problemReceiptDigest: 'b'.repeat(64), environmentDigest: 'c'.repeat(64) },
  sourceDigest: 'd'.repeat(64), projectionDigest: 'e'.repeat(64), backendDigest: 'f'.repeat(64),
  target: { file: 'Helpers.lean', theoremName: 'Helpers.refl', type: '∀ n : Nat, n = n' },
  environment: { environmentDigest: '1'.repeat(64), toolIdentity: '2'.repeat(64) },
  sourceFiles: [{ file: 'Helpers.lean', digest: '3'.repeat(64) }],
};
const open = (): ProofStateView => ({ root: '?m.root', goals: [{ target: 'n = n', variables: [{ name: 'n', type: 'Nat' }] }],
  rootHasSorry: false, rootHasUnsafe: false, rootHasMVar: true });
const closed = (): ProofStateView => ({ root: 'fun n => Eq.refl n', goals: [],
  rootHasSorry: false, rootHasUnsafe: false, rootHasMVar: false });
type Transition = { stateId: number; tactic: string; path: string[]; view: ProofStateView };
type FakeOptions = {
  firstStateId?: number; initial?: ProofStateView;
  transition?: (input: Transition) => ProofStateView | { reject: string };
  beforeTactic?: (input: Transition) => void;
  onRequest?: (command: string) => void;
};

/** Protocol-only fake: no subprocess, Lean package, model or source project is involved. */
class FakeSession implements ProofSearchSession {
  readonly requests: { command: string; payload: Record<string, unknown> }[] = [];
  readonly transitions: Transition[] = [];
  readonly states = new Map<number, { path: string[]; view: ProofStateView }>();
  private nextStateId: number;
  constructor(private readonly options: FakeOptions = {}) { this.nextStateId = options.firstStateId ?? 10; }
  async request(command: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requests.push({ command, payload: structuredClone(payload) }); this.options.onRequest?.(command);
    if (command === 'options.set') return {};
    if (command === 'frontend.process') {
      // Pinned Pantograph FromJson requires each non-Option Bool, even when Lean gives it a default.
      for (const field of ['readHeader', 'inheritEnv', 'newConstants'])
        if (typeof payload[field] !== 'boolean') throw new Error(`frontend.process ${field}: Bool expected`);
      return { units: [{ messages: [] }] };
    }
    if (command === 'goal.start') {
      const stateId = this.nextStateId++;
      this.states.set(stateId, { path: [], view: structuredClone(this.options.initial ?? open()) });
      return { stateId, root: '?m.root' };
    }
    const parent = this.states.get(payload.stateId as number);
    if (!parent) throw new Error('fake_missing_backend_state');
    if (command === 'goal.print') return structuredClone(parent.view);
    if (command !== 'goal.tactic' || typeof payload.tactic !== 'string') throw new Error('fake_unexpected_request');
    const input = { stateId: payload.stateId as number, tactic: payload.tactic,
      path: [...parent.path, payload.tactic], view: structuredClone(parent.view) };
    this.transitions.push(input); this.options.beforeTactic?.(input);
    const next = this.options.transition?.(input) ?? open();
    if ('reject' in next) return { parseError: next.reject };
    const nextStateId = this.nextStateId++;
    this.states.set(nextStateId, { path: input.path, view: structuredClone(next) });
    return { nextStateId, hasSorry: false, hasUnsafe: false };
  }
  async close() {}
}

function run(session: ProofSearchSession, options: {
  checkpoint?: ProofSearchCheckpoint; branches?: { from?: string; tactics: string[]; proposal?: { id: string; premiseIds: string[] } }[];
  maxTransitions?: number; signal?: AbortSignal; deadlineAt?: number;
  save?: (checkpoint: ProofSearchCheckpoint) => void;
} = {}) {
  const checkpoint = options.checkpoint ?? emptyProofSearchCheckpoint(structuredClone(basis));
  const saved: ProofSearchCheckpoint[] = [];
  const result = advanceLeanProofSearch({ session, checkpoint, prefix: 'import Mathlib\nnamespace Helpers\n',
    request: proofSearchRequestSchema.parse({ branches: options.branches ?? [{ tactics: [] }],
      limits: { timeoutMs: 1000, maxTransitions: options.maxTransitions ?? 32 } }),
    signal: options.signal ?? new AbortController().signal, deadlineAt: options.deadlineAt ?? Date.now() + 60_000,
    save(value) { saved.push(structuredClone(value)); options.save?.(value); },
  });
  return { checkpoint, saved, result };
}

describe('bounded complete-state proof search with a protocol fake', () => {
  it('retains unexecuted proposals and the reported premise provenance when a call exhausts its budget', async () => {
    const proposal = { id: 'worker-proposal-2', premiseIds: ['catalog:helper'] };
    const search = run(new FakeSession(), { branches: [{ tactics: ['intro n', 'rfl'], proposal }], maxTransitions: 1 });
    expect(await search.result).toMatchObject({ status: 'budget-exhausted', transitions: 1 });
    expect(search.checkpoint.lastRequest?.branches).toEqual([{ tactics: ['intro n', 'rfl'], proposal }]);
    expect(search.checkpoint.actions[0]).toMatchObject({ branchIndex: 0, proposal,
      requestDigest: search.checkpoint.lastRequest!.digest });
    expect(proofSearchCheckpointSchema.parse(search.checkpoint).lastRequest).toEqual(search.checkpoint.lastRequest);
  });
  it('keeps two paths with identical printed goals as separate complete states', async () => {
    const session = new FakeSession(), search = run(session, { branches: [{ tactics: ['left'] }, { tactics: ['right'] }] });
    expect(await search.result).toMatchObject({ status: 'exhausted', candidates: [], transitions: 2 });
    const children = search.checkpoint.nodes.filter(node => node.tactics.length);
    expect(children).toHaveLength(2);
    expect(children[0]!.view).toEqual(children[1]!.view);
    expect(children[0]!.id).not.toBe(children[1]!.id);
    expect(session.transitions.map(item => item.stateId)).toEqual([10, 10]);
    expect(session.states.get(10)!.path).toEqual([]);
    expect(proofSearchCheckpointSchema.parse(search.saved.at(-1))).toEqual(search.checkpoint);
  });

  it('shares an executed prefix and continues a sibling after a rejected candidate', async () => {
    const session = new FakeSession({ transition: ({ tactic }) => tactic === 'bad' ? { reject: 'invalid tactic' } : tactic === 'rfl' ? closed() : open() });
    const search = run(session, { branches: [{ tactics: ['intro n', 'bad'] }, { tactics: ['intro n', 'change n = n', 'rfl'] }] });
    const result = await search.result;
    expect(result).toMatchObject({ status: 'candidate', transitions: 4 });
    expect(session.transitions.filter(item => item.tactic === 'intro n')).toHaveLength(1);
    const failed = session.transitions.find(item => item.tactic === 'bad')!;
    const sibling = session.transitions.find(item => item.tactic === 'change n = n')!;
    expect(failed.stateId).toBe(sibling.stateId);
    expect(session.transitions.indexOf(failed)).toBeLessThan(session.transitions.findIndex(item => item.tactic === 'rfl'));
    expect(search.checkpoint.nodes.find(node => node.tactics.at(-1) === 'bad')?.status).toBe('rejected');
    expect(search.checkpoint.nodes.find(node => node.tactics.at(-1) === 'intro n')?.status).toBe('open');
    expect(result.candidates).toEqual([{ node: search.checkpoint.nodes.find(node => node.status === 'candidate')!.id,
      proofSource: 'by\n  intro n\n  change n = n\n  rfl\n' }]);
  });

  it.each([
    { reason: 'missing root', view: { ...closed(), root: undefined }, status: 'open' },
    { reason: 'unassigned metavariable', view: { ...closed(), rootHasMVar: true }, status: 'open' },
    { reason: 'sorry', view: { ...closed(), rootHasSorry: true }, status: 'rejected' },
    { reason: 'unsafe root', view: { ...closed(), rootHasUnsafe: true }, status: 'rejected' },
  ])('does not export an empty-goal state containing $reason', async ({ view, status }) => {
    const session = new FakeSession({ transition: () => view }), search = run(session, { branches: [{ tactics: ['candidate'] }] });
    expect(await search.result).toMatchObject({ status: 'exhausted', candidates: [] });
    expect(search.checkpoint.nodes.at(-1)?.status).toBe(status);
  });

  it('preserves all coupled goals after a partial Aesop action and can continue that state', async () => {
    const partial: ProofStateView = { ...open(), goals: [
      { target: '?shared = 0', variables: [{ name: 'h', type: '?shared = 0' }] },
      { target: '?shared = ?shared', variables: [{ name: 'h', type: '?shared = 0' }] },
    ] };
    const first = run(new FakeSession({ transition: () => partial }), { branches: [{ tactics: [AesopPartialTactic] }] });
    expect(await first.result).toMatchObject({ status: 'exhausted', candidates: [] });
    const frontier = first.checkpoint.nodes.at(-1)!;
    expect(frontier).toMatchObject({ status: 'open', view: partial });
    const resumed = new FakeSession({ firstStateId: 100, transition: ({ tactic, view }) => {
      if (tactic === AesopPartialTactic) return partial;
      expect(view.goals).toEqual(partial.goals); return closed();
    } });
    const second = run(resumed, { checkpoint: structuredClone(first.checkpoint), branches: [{ from: frontier.id, tactics: ['all_goals assumption'] }] });
    expect(await second.result).toMatchObject({ status: 'candidate', transitions: 2 });
    expect(resumed.transitions.map(item => item.tactic)).toEqual([AesopPartialTactic, 'all_goals assumption']);
    expect(second.checkpoint.counters).toMatchObject({ issued: 3, completed: 3, replay: 1 });
  });

  it('replays a saved path into fresh backend state IDs before extending it', async () => {
    const first = run(new FakeSession(), { branches: [{ tactics: ['intro n', 'change n = n'] }] }); await first.result;
    const prefix = first.checkpoint.nodes.at(-1)!;
    const restored = proofSearchCheckpointSchema.parse(JSON.parse(JSON.stringify(first.checkpoint)));
    const session = new FakeSession({ firstStateId: 1000, transition: ({ tactic }) => tactic === 'rfl' ? closed() : open() });
    const second = run(session, { checkpoint: restored, branches: [{ from: prefix.id, tactics: ['rfl'] }] });
    const result = await second.result;
    expect(result.status).toBe('candidate');
    expect(session.transitions.map(item => [item.stateId, item.tactic])).toEqual([
      [1000, 'intro n'], [1001, 'change n = n'], [1002, 'rfl'],
    ]);
    expect(second.checkpoint.counters).toMatchObject({ issued: 5, completed: 5, replay: 2 });
    expect(result.candidates[0]?.proofSource).toBe('by\n  intro n\n  change n = n\n  rfl\n');
  });

  it('rechecks a saved candidate instead of treating the checkpoint as proof acceptance', async () => {
    const first = run(new FakeSession({ transition: () => closed() }), { branches: [{ tactics: ['rfl'] }] }); await first.result;
    const candidate = first.checkpoint.nodes.at(-1)!;
    expect(candidate.status).toBe('candidate');
    const session = new FakeSession({ firstStateId: 1000 }), second = run(session, {
      checkpoint: structuredClone(first.checkpoint), branches: [{ from: candidate.id, tactics: [] }],
    });
    expect(await second.result).toMatchObject({ status: 'exhausted', candidates: [], transitions: 1 });
    expect(session.transitions.map(item => item.tactic)).toEqual(['rfl']);
    expect(second.checkpoint.nodes.at(-1)?.status).toBe('open');
  });

  it('charges path replay against the same per-call transition budget', async () => {
    const first = run(new FakeSession(), { branches: [{ tactics: ['intro n', 'change n = n'] }] }); await first.result;
    const session = new FakeSession(), second = run(session, { checkpoint: structuredClone(first.checkpoint), maxTransitions: 1,
      branches: [{ from: first.checkpoint.nodes.at(-1)!.id, tactics: ['rfl'] }] });
    expect(await second.result).toMatchObject({ status: 'budget-exhausted', candidates: [], transitions: 1 });
    expect(session.transitions.map(item => item.tactic)).toEqual(['intro n']);
    expect(second.checkpoint.counters).toMatchObject({ issued: 3, completed: 3, replay: 1 });
  });

  it('reports exhaustion when duplicate branches are already covered at the exact transition limit', async () => {
    const session = new FakeSession(), search = run(session, { maxTransitions: 1,
      branches: [{ tactics: ['intro n'] }, { tactics: ['intro n'] }] });
    expect(await search.result).toMatchObject({ status: 'exhausted', transitions: 1, candidates: [] });
    expect(session.transitions.map(item => item.tactic)).toEqual(['intro n']);
  });

  it('saves an issued transition before calling the backend and retains that cost after interruption', async () => {
    const controller = new AbortController(); let lastSaved: ProofSearchCheckpoint | undefined;
    const session = new FakeSession({ beforeTactic() {
      expect(lastSaved?.actions.at(-1)?.status).toBe('issued');
      expect(lastSaved?.counters).toMatchObject({ issued: 1, completed: 0 });
      controller.abort(new Error('fake interruption')); controller.signal.throwIfAborted();
    } });
    const first = run(session, { signal: controller.signal, branches: [{ tactics: ['intro n'] }],
      save(value) { lastSaved = structuredClone(value); } });
    await expect(first.result).rejects.toThrow('fake interruption');
    expect(first.checkpoint.actions[0]?.status).toBe('issued');
    expect(first.checkpoint.counters).toMatchObject({ issued: 1, completed: 0 });
    const second = run(new FakeSession({ firstStateId: 500 }), { checkpoint: structuredClone(first.checkpoint),
      branches: [{ tactics: ['intro n'] }] });
    expect(await second.result).toMatchObject({ status: 'exhausted', transitions: 1 });
    expect(second.checkpoint.actions.map(action => action.status)).toEqual(['interrupted', 'completed']);
    expect(second.checkpoint.counters).toMatchObject({ issued: 2, completed: 1, replay: 1 });
  });

  it('honors cancellation after prefix initialization before issuing a root or tactic request', async () => {
    const controller = new AbortController(), session = new FakeSession({ onRequest(command) {
      if (command === 'frontend.process') controller.abort(new Error('cancelled during prefix'));
    } });
    const search = run(session, { signal: controller.signal, branches: [{ tactics: ['rfl'] }] });
    await expect(search.result).rejects.toThrow('cancelled during prefix');
    expect(session.requests.map(item => item.command)).toEqual(['options.set', 'frontend.process']);
    expect(search.checkpoint.counters.issued).toBe(0);
  });

  it('does not open a backend goal after the call deadline has already elapsed', async () => {
    const session = new FakeSession(), search = run(session, { deadlineAt: Date.now() - 1, branches: [{ tactics: ['rfl'] }] });
    await expect(search.result).rejects.toThrow('proof_search_deadline');
    expect(session.requests).toEqual([]);
    expect(search.checkpoint.counters.issued).toBe(0);
  });

  it('rejects unknown logical nodes and inconsistent saved accounting before protocol work', async () => {
    const unknown = new FakeSession(), missing = run(unknown, { branches: [{ from: '9'.repeat(64), tactics: ['rfl'] }] });
    await expect(missing.result).rejects.toThrow('proof_search_unknown_node');
    expect(unknown.requests).toEqual([]);
    const checkpoint = emptyProofSearchCheckpoint(structuredClone(basis)); checkpoint.counters.issued = 1;
    const invalid = new FakeSession(), broken = run(invalid, { checkpoint });
    await expect(broken.result).rejects.toThrow('proof_search_checkpoint_invalid');
    expect(invalid.requests).toEqual([]);
  });
});
