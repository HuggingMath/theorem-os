import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { readCooperationPlan } from '../src/solver/cooperationShared';
import { applyCooperationPlanFile, validateCooperationPlan, validateCooperationPlanFile } from '../src/solver/planTool';
import { parseCooperationPlan } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';
import './helpers/solverAtomicPlanRejection';

const roots: string[] = [];
const notes = '## Current argument\nKeep this explanation.\n\n```json\n{"example":42}\n```\n';
const malformed = '```math-plan\n{ malformed }\n```\n';

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const example = localExample('atomic-plan-apply-');
  roots.push(example.directory);
  const { workspace, problem } = example;
  const plan = { tasks: problem.targets.map(({ proofPath, theoremName }, index) => ({
    id: `goal_${index}`, kind: 'goal', objective: `Prove ${theoremName}.`, proofPath, theoremName,
  })) };
  const file = path.join(workspace, 'RESEARCH.md');
  fs.writeFileSync(file, notes + '\n' + malformed);
  return { example, workspace, problem, plan, file };
}

describe('atomic cooperative plan commands', () => {
  it('leaves the notes byte-for-byte unchanged on invalid JSON, a graph violation, and invalid retirement fields', () => {
    const { workspace, plan, file, problem } = fixture();
    const invalidTask = { tasks: [{ ...plan.tasks[0], status: 'verified' }] };
    const invalidRetirement = { ...plan, retireRoutes: [{ routeId: 'dead', reason: '', evidenceRefs: [0] }] };
    expect(validateCooperationPlan(invalidTask, { problem })).toMatchObject({ ok: false, error: 'math_plan_invalid_task',
      issues: [{ path: 'tasks[goal_0].status', message: expect.stringContaining('Host scheduling and proof-acceptance') }] });

    const cases = [
      { text: '{"tasks": [}', error: 'math_plan_json_invalid', fields: ['$'] },
      { text: JSON.stringify(invalidTask), error: 'math_plan_invalid_task', fields: ['tasks[goal_0].status'] },
      { text: JSON.stringify(invalidRetirement), error: 'math_plan_invalid_retire_routes',
        fields: ['retireRoutes[0].reason', 'retireRoutes[0].evidenceRefs[0]'] },
    ];
    const candidate = path.join(workspace, 'candidate.json');
    for (const item of cases) {
      fs.writeFileSync(candidate, item.text);
      const input = { workspace, file: candidate };
      const result = validateCooperationPlanFile(input);
      expect(result).toMatchObject({ ok: false, error: item.error,
        issues: item.fields.map(field => ({ path: field, message: expect.any(String) })) });
      expect(applyCooperationPlanFile(input)).toEqual(result);
      expect(fs.readFileSync(file, 'utf8')).toBe(notes + '\n' + malformed);
    }
  });

  it('accepts full JSON through the CLI from stdin and replaces only old plan fences', () => {
    const { workspace, plan, file, problem } = fixture();
    const extraPlan = '```math\n' + JSON.stringify(plan) + '\n```\n';
    fs.appendFileSync(file, extraPlan + '\nEnd of notes.\n');
    const invoke = (command: 'plan-validate' | 'plan-apply', input: string) => spawnSync('bun',
      ['bin/math.ts', command, '--workspace', workspace], { input, encoding: 'utf8', timeout: 15_000 });
    const rejected = invoke('plan-apply', '{"tasks":[');
    expect(rejected.status, rejected.stderr || String(rejected.error ?? '')).toBe(1);
    expect(JSON.parse(rejected.stdout)).toMatchObject({ ok: false, error: 'math_plan_json_invalid' });
    expect(fs.readFileSync(file, 'utf8')).toContain(malformed + extraPlan);
    const checked = invoke('plan-validate', JSON.stringify(plan));
    expect(checked.status, checked.stderr || String(checked.error ?? '')).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toContain(malformed);
    const applied = invoke('plan-apply', JSON.stringify(plan));
    expect(applied.status, applied.stderr || String(applied.error ?? '')).toBe(0);
    const parsed = JSON.parse(checked.stdout);
    expect(parsed).toMatchObject({ ok: true, tasksCount: plan.tasks.length, planVersion: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(JSON.parse(applied.stdout)).toEqual({ ...parsed, file });
    const result = fs.readFileSync(file, 'utf8');
    expect(result).toContain(notes);
    expect(result).toContain('End of notes.');
    expect(result.match(/```math-plan\n/g)).toHaveLength(1);
    expect(result).not.toContain(extraPlan);
    expect(readCooperationPlan(problem, workspace)).toEqual(parseCooperationPlan(problem, plan));
  });

  it('uses the host-projected revision base, rejects a stale base, and retains checked retirement directives', async () => {
    const { example, workspace, plan, file, problem } = fixture();
    const lead = leadWorker(problem, workspace), peer = peerWorker(example, 'engineer', { role: 'engineer' });
    const basePlan = parseCooperationPlan(problem, plan);
    const state = solverState(problem, workspace, { runId: 'atomic-plan', phase: 'running', cooperation: {
      tasks: basePlan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
      groups: basePlan.groups.map(group => ({ group, turns: 0 })), planVersion: 'current', error: 'fixture_needs_revision',
    } });
    const host = cooperativeResearch({ state, workers: [lead, peer], retrievalRoot: example.directory });
    host.start();
    try {
      const action = await host.next(lead, { maxTurns: Infinity, remainingMs: Infinity });
      expect(action?.kind).toBe('lead');
      if (action?.kind !== 'lead') throw new Error('fixture_expected_lead_dispatch');
      expect(host.started(lead, action)).toBe(true);
      const version = state.cooperation!.planVersion!;
      const invalidPatches = [
        { patch: { baseVersion: 'stale', upsert: [] }, error: 'math_plan_patch_version_conflict', path: 'baseVersion',
          message: expect.stringContaining(version) },
        { patch: { baseVersion: version, tasks: { baseVersion: 'stale', upsert: [] } }, error: 'math_plan_patch_invalid',
          path: 'tasks.baseVersion' },
        { patch: { baseVersion: version, remove: ['unknown'] }, error: 'math_plan_patch_unknown_task', path: 'remove[0]' },
      ];
      for (const { patch, error, path, message } of invalidPatches) {
        const input = { workspace, text: JSON.stringify(patch) };
        const result = validateCooperationPlanFile(input);
        expect(result).toMatchObject({ ok: false, error, issues: [{ path, message: message ?? expect.any(String) }] });
        expect(applyCooperationPlanFile(input)).toEqual(result);
      }
      expect(fs.readFileSync(file, 'utf8')).toBe(notes + '\n' + malformed);
      const revise = { tasks: { baseVersion: version, upsert: [{ id: plan.tasks[0].id, objective: 'A sharper reduction.' }] },
        retireRoutes: [{ routeId: 'dead', reason: 'Counterexample at the boundary.' }] };
      expect(applyCooperationPlanFile({ workspace, text: JSON.stringify(revise) })).toMatchObject({ ok: true, baseVersion: version,
        retireRoutesCount: 1, tasksCount: basePlan.tasks.length });
      const applied = readCooperationPlan(problem, workspace, { version, ...basePlan });
      expect(applied.tasks[0].objective).toBe('A sharper reduction.');
      expect(applied).toMatchObject({ fromPatch: true, retireRoutes: revise.retireRoutes });
      const peerContext = JSON.parse(fs.readFileSync(path.join(peer.worktree, 'COOPERATION.json'), 'utf8'));
      expect(peerContext.planTool).toBeUndefined();
    } finally { await host.stop(); }
  });
});
