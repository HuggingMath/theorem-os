import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import { readMathAgentSkill } from '../src/runtime/codexSkills';
import { directSolverModules } from '../src/solver/modules';
import { commitSolverSources } from '../src/solver/problem';
import { runResearchLead } from '../src/solver/research';
import { MAX_COMPACTIONS_PER_SLICE, SOFT_SLICE_MS, softSliceSettings } from '../src/solver/softSlice';
import { deferred } from './helpers/async';
import { localExample, solverState } from './helpers/solver';

vi.mock(import('../src/math/mathBuildManifest'), async importOriginal =>
  ({ ...await importOriginal(), readMathBuildManifest: vi.fn() }));

describe('soft research milestones', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['time', 'compaction', 'fallback', 'natural-return', 'independent', 'team'] as const)('yields an unlimited research turn after %s', async trigger => {
    vi.useFakeTimers();
    const { directory, workspace, problem } = localExample('soft-slice-');
    const controller = new AbortController();
    const started = deferred<MathAgentOptions>(), done = deferred<string>();
    const notify = vi.fn(async () => {});
    const interrupt = vi.fn(async () => { done.resolve('interrupted'); });
    const stop = vi.fn(async () => ({ status: 'stopped' as const }));
    const events: { event: string; details?: Record<string, unknown> }[] = [];
    const skill = trigger === 'independent' ? undefined : (() => {
      const skillRoot = path.join(workspace, '.agents/skills/theoremos-research');
      fs.mkdirSync(path.dirname(skillRoot), { recursive: true });
      fs.cpSync(path.resolve('skills/theoremos-research'), skillRoot, { recursive: true });
      return readMathAgentSkill(path.join(skillRoot, 'SKILL.md'));
    })();
    const state = solverState(problem, workspace, { runId: 'soft-slice-fixture', phase: 'prepared',
      ...(trigger === 'team' ? { researchDelegation: { mode: 'team', maxAgents: 3 }, agentTeam: { schema: 'theorem-os.agent-team.v1',
        transport: 'native-agent-control', workers: [], events: [], deliveries: [], adoptions: [], operations: [] } } : {}),
      ...(skill ? { researchMode: 'skill', researchSkill: { name: skill.name, digest: skill.digest, loading: skill.loading } } : {}) });
    const modules: typeof directSolverModules = { ...directSolverModules,
      M2: { ...directSolverModules.M2, check: async () => {
        const commit = commitSolverSources(problem, workspace);
        return { commit, sourceDigest: 'unproved-fixture', passed: false,
          verification: { schema: 'deepscientist.mathematics.verification-batch/v1', status: 'failed', targetCommit: commit,
            sessionId: 'offline-check', results: [], events: [], startedAt: 0, checkedAt: 0, durationMs: 0 } };
      } },
      M1: { ...directSolverModules.M1, open: async (options: MathAgentOptions): Promise<MathAgentSession> => ({
        threadId: 'offline-soft-slice', usageSource: 'upstream-requests', advisoryNotifications: 'native-history',
        notify, interrupt, close: vi.fn(async () => {}), stopForFreeze: stop,
        run: async (_message, _id, _workspace, begin) => {
          begin('held-turn');
          started.resolve(options);
          return done.promise;
        },
      }) },
    };
    const completion = runResearchLead({ state, modules,
      access: { environment: {}, retrievalRoot: directory, researchSkill: skill },
      root: directory, buildFile: path.join(directory, 'unused-build.json'), taskText: 'Prove both original addition targets.',
      executable: 'offline-fixture', profile: 'offline-fixture', signal: controller.signal,
      deadline: Infinity, maxTurnMs: Infinity, maxTurns: 1, maxTotalTokens: 0,
      softSlice: { softSliceMs: trigger === 'compaction' ? 0 : 1_000, softSliceGraceMs: 100 },
      save: () => {}, emit: (event, details) => { events.push({ event, details }); },
    });
    try {
      const options = await Promise.race([started.promise, completion.then(() => { throw new Error('fixture did not dispatch'); })]);
      const event = trigger === 'compaction' ? 'compaction_circuit_breaker_triggered' : 'soft_slice_milestone_requested';
      if (trigger === 'compaction') {
        options.onActivity?.({ event: 'item_started', itemType: 'contextCompaction' });
        options.onActivity?.({ event: 'item_completed', itemType: 'contextCompaction' });
        expect(notify).not.toHaveBeenCalled();
        options.onActivity?.({ event: 'item_started', itemType: 'contextCompaction' });
        options.onActivity?.({ event: 'item_completed', itemType: 'contextCompaction' });
      } else {
        await vi.advanceTimersByTimeAsync(999);
        expect(notify).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(events).toContainEqual({ event, details: expect.objectContaining({ turnId: 'held-turn',
        completedCompactions: trigger === 'compaction' ? 2 : 0 }) });
      const notice = trigger === 'team' ? /route_summary.*delegate focused independent obligations.*fewer than 20 lines.*RESEARCH\.md/u
        : /standalone helper.*fewer than 20 lines.*RESEARCH\.md/u;
      expect(notify.mock.calls).toEqual([[expect.stringMatching(notice), { mode: 'advisory' }]]);
      if (trigger === 'team') {
        expect(options.instructions).toContain('spawn and coordinate useful child agents');
        expect(notify.mock.calls.flat()).not.toContainEqual(expect.stringContaining('declaration-submission.json'));
        // This file is handled after the turn, outside the whole-proof diagnostics watcher.
        expect(options.completedOutput?.file).toMatch(/lean-diagnostics-latest\.json$/u);
        fs.writeFileSync(path.join(workspace, '.scratch/declaration-submission.json'), '{"declarations":[]}');
      } else if (skill) {
        expect(notify.mock.calls.flat()).toContainEqual(expect.stringContaining('Never write an empty declarations array'));
      }
      expect(options.requestGate?.checkpoint?.()).toBe(false);
      expect(interrupt).not.toHaveBeenCalled();
      fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), 'Established the first reduction. The induction step remains open.\n');
      await vi.advanceTimersByTimeAsync(100);
      if (trigger === 'natural-return') {
        done.resolve('completed');
      } else if (trigger === 'fallback') {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(interrupt).toHaveBeenCalledOnce();
      } else {
        expect(options.requestGate?.checkpoint?.()).toBe(true);
        expect(options.requestGate?.checkpoint?.()).toBe(false);
        expect(interrupt).not.toHaveBeenCalled();
        done.resolve('checkpoint');
      }
      await completion;
      expect(events).toContainEqual({ event: 'turn_checkpoint', details: expect.objectContaining({ reason: 'math_soft_slice_checkpoint' }) });
      expect(events.some(entry => entry.event === (skill ? 'research_saved' : 'proof_checked'))).toBe(true);
      expect(fs.readFileSync(path.join(workspace, 'RESEARCH.md'), 'utf8')).toContain('The induction step remains open.');
      if (trigger === 'team') {
        expect(fs.existsSync(path.join(workspace, '.scratch/declaration-submission.json'))).toBe(false);
        expect(fs.existsSync(path.join(workspace, '.scratch/declaration-feedback.json'))).toBe(false);
        expect(events.some(entry => entry.event === 'declarations_checked')).toBe(false);
        expect(state.declarationArtifacts ?? []).toEqual([]);
      }
    } finally {
      controller.abort();
      done.resolve('interrupted');
      await completion.catch(() => {});
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires an explicit zero to disable either trigger', () => {
    expect(softSliceSettings({}, {})).toMatchObject({ timeMs: SOFT_SLICE_MS, compactions: MAX_COMPACTIONS_PER_SLICE });
    expect(softSliceSettings({ maxCompactionsPerSlice: 0 }, { THEOREMOS_SOFT_SLICE_MS: '0' }))
      .toMatchObject({ timeMs: 0, compactions: 0 });
  });
});
