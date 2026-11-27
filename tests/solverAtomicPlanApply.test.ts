import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCooperationPlan, validateCooperationPlanFile } from '../src/solver/planTool';
import { localExample } from './helpers/solver';

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

describe('validation of archived cooperative plans', () => {
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
      expect(fs.readFileSync(file, 'utf8')).toBe(notes + '\n' + malformed);
    }
  });

  it('validates a plan from stdin without changing the archived notes', () => {
    const { workspace, plan, file } = fixture();
    const original = fs.readFileSync(file, 'utf8');
    const invoke = (input: string) => spawnSync('bun', ['bin/math.ts', 'plan-validate', '--workspace', workspace],
      { input, encoding: 'utf8', timeout: 15_000 });
    const rejected = invoke('{"tasks":[');
    expect(rejected.status, rejected.stderr).toBe(1);
    expect(JSON.parse(rejected.stdout)).toMatchObject({ ok: false, error: 'math_plan_json_invalid' });
    const checked = invoke(JSON.stringify(plan));
    expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout)).toMatchObject({ ok: true, tasksCount: plan.tasks.length,
      planVersion: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});
