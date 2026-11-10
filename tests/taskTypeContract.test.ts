import { describe, expect, it } from 'vitest';
import { assertPlanTaskTypeContracts, taskTypeContractError } from '../src/solver/taskTypeContract';
import type { CooperativeTask } from '../src/solver/tasks';

const legacy: CooperativeTask = { id: 'legacy', kind: 'lemma', objective: 'Prove the helper.', dependsOn: [], revision: 0,
  proofPath: 'Submission.lean', theoremName: 'Fixture.helper', type: 'theorem Fixture.helper (n : Nat) : n = n' };

describe('helper type term contract', () => {
  it.each(['theorem Fixture.helper (n : Nat) : n = n', '/- saved declaration -/\nprivate theorem helper : True',
    '@[simp]\nlemma helper (n : Nat) : n = n', 'noncomputable def helper : Nat := 0'])
  ('rejects declaration commands with an actionable contract correction: %s', type => {
    const reason = taskTypeContractError({ ...legacy, type });
    expect(reason).toContain('Task legacy'); expect(reason).toContain('closed type term');
    expect(reason).toContain('explicitly quantify every parameter and instance');
  });

  it.each(['∀ (n : Nat), n = n', 'forall (n : Nat), n = n', '/- theorem helper -/ ∀ (n : Nat), n = n',
    '«theorem»', 'theoremδ', 'theoremType', '(∀ (n : Nat), n = n)'])('leaves type terms and quoted names to Lean: %s', type => {
    expect(taskTypeContractError({ ...legacy, type })).toBeUndefined();
  });

  it('allows an unchanged historical contract during an unrelated plan edit and preserves its original bytes', () => {
    const revised = { ...legacy, objective: 'Retain until its type is corrected.', revision: 1 };
    expect(() => assertPlanTaskTypeContracts([revised], [legacy])).not.toThrow();
    expect(revised.type).toBe(legacy.type);
  });

  it('rejects new or newly malformed types, and permits an explicit closed-type revision', () => {
    expect(() => assertPlanTaskTypeContracts([legacy])).toThrow('math_plan_invalid_helper_type: Task legacy');
    expect(() => assertPlanTaskTypeContracts([{ ...legacy, type: 'lemma Fixture.helper : True' }], [legacy]))
      .toThrow('closed type term');
    expect(() => assertPlanTaskTypeContracts([{ ...legacy, type: '∀ (n : Nat), n = n' }], [legacy])).not.toThrow();
  });
});
