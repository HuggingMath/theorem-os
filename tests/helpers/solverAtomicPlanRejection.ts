import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { commitSolverSources, committedSource } from '../../src/solver/problem';
import { parseCooperationPlan } from '../../src/solver/tasks';
import { cooperativeResearch } from './cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './solver';

describe('CooperativeResearch malformed plans', () => {
  const fence = (value: unknown) => '```math-plan\n' + JSON.stringify(value) + '\n```';
  const malformedFence = fence({ tasks: [] }) + '\n' + fence({ tasks: [] });

  function fixture() {
    const example = localExample('solver-atomic-plan-rejection-', 'lead');
    const { directory, workspace, problem } = example;
    const lead = leadWorker(problem, workspace);
    const peer = peerWorker(example, 'engineer', { role: 'engineer' });
    const plan = parseCooperationPlan(problem, { tasks: problem.targets.map((target, index) => ({
      ...target, id: `goal_${index}`, kind: 'goal', objective: `Prove ${target.theoremName}.`, status: 'paused',
    })) });
    const archive = { tasks: plan.tasks.map(task => ({ task, status: 'blocked' as const, attempts: 0 })),
      groups: plan.groups.map(group => ({ group, turns: 0 })), error: 'fixture_request_new_plan' };
    const state = solverState(problem, workspace, { runId: 'atomic-plan-rejection', phase: 'running', cooperation: archive });
    const controller = new AbortController();
    const emit = vi.fn();
    const research = cooperativeResearch({ state, workers: [lead, peer], retrievalRoot: directory, signal: controller.signal, emit });
    const budget = { maxTurns: Infinity, remainingMs: Infinity };
    const inbox = (worktree: string) => JSON.parse(fs.readFileSync(path.join(worktree, 'COOPERATION.json'), 'utf8'));
    async function checkpoint(notes: string, editLean?: () => void) {
      const action = await research.next(lead, budget);
      if (action?.kind !== 'lead') throw new Error('fixture_expected_lead');
      expect(research.started(lead, action)).toBe(true);
      research.activate(lead, action, async () => {}, async () => {});
      expect(research.leadCheckpointInstruction(action)).toContain('plan-apply');
      const file = path.join(lead.worktree, 'RESEARCH.md');
      fs.writeFileSync(file, notes);
      editLean?.();
      research.deactivate(lead);
      const commit = commitSolverSources(problem, lead.worktree);
      await research.deliver(lead, action, commit, true, 'scheduling-checkpoint');
      return commit;
    }
    return { state, research, lead, peer, problem, emit, inbox, budget, checkpoint, async close() {
      controller.abort();
      await research.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    } };
  }

  it('keeps a repair turn private and stops retrying different malformed drafts on unchanged inputs', async () => {
    const f = fixture();
    try {
      const archive = f.state.cooperation!;
      const first = await f.checkpoint(malformedFence);
      expect(f.inbox(f.lead.worktree)).toMatchObject({ error: 'math_math-plan_requires_one_block' });
      expect(f.inbox(f.peer.worktree)).not.toHaveProperty('planRejection');
      expect(archive.planRejection).toMatchObject({ stalled: false });
      expect(committedSource(f.lead.worktree, first, 'RESEARCH.md')).toBe(malformedFence);

      // A distinct schema error receives accurate feedback, but neither a different bad
      // response nor changing its explanatory prose is new mathematical evidence.
      const second = '# Still drafting\n\n' + fence({ tasks: 'bad task array' });
      await f.checkpoint(second);
      expect(archive.planRejection).toMatchObject({ stalled: true,
        error: expect.stringContaining('math_plan_invalid: {"field":"tasks"}') });
      expect(f.inbox(f.peer.worktree)).not.toHaveProperty('error');
      expect(archive.deliveries ?? []).toEqual([]);
      expect(archive.leadWakes?.recent?.filter(wake => wake.reason === 'plan-rejected') ?? []).toEqual([]);
      expect(await f.research.next(f.lead, f.budget)).toBeUndefined();
      expect(f.emit).toHaveBeenCalledWith('plan_stalled', expect.objectContaining({ stalled: true }));
    } finally { await f.close(); }
  });

  it('retains a checkpoint containing genuine Lean changes as an advisory source draft', async () => {
    const f = fixture();
    try {
      const file = path.join(f.lead.worktree, f.problem.projectRelative, 'Submission.lean');
      const commit = await f.checkpoint(malformedFence, () => {
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('theorem add_zero', 'lemma atomic_plan_draft : True := by trivial\ntheorem add_zero'));
      });
      const archive = f.state.cooperation!;
      expect(archive.deliveries).toContainEqual(expect.objectContaining({
        commit, kind: 'progress', status: 'advisory',
        summary: expect.stringContaining('owned Lean source changes'),
      }));
      expect(archive.deliveries?.find(delivery => delivery.commit === commit)?.summary).not.toContain('math_math-plan_requires_one_block');
      expect(committedSource(f.lead.worktree, commit, `${f.problem.projectRelative}/Submission.lean`)).toContain('lemma atomic_plan_draft');
      expect(archive.tasks.every(node => !node.integratedCheck)).toBe(true);
    } finally { await f.close(); }
  });
});
