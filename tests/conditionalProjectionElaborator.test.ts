import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { conditionalExpectedType, conditionalProjection, type ConditionalDependency } from '../src/solver/conditionalProjection';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';

const roots: string[] = [], lean = newestLeanBinary();
const mathlibProject = process.env.THEOREMOS_TEST_MATHLIB_PROJECT?.trim();
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function compile(declaration: string, dependencies: readonly ConditionalDependency[], options: {
  name?: string; before?: string; after?: string; expectedType?: string; mathlib?: boolean;
} = {}) {
  if (!lean) throw new Error('Native Lean is required for conditional projection checks.');
  const root = temporaryDirectory('conditional-projection-'); roots.push(root);
  const name = options.name ?? 'target';
  const projection = conditionalProjection({ theoremName: name, writtenName: name.split('.').at(-1)!, declaration, dependencies });
  const mirror = options.expectedType === undefined ? '' : '\nexample : ' +
    conditionalExpectedType(name, options.expectedType, dependencies) + ' := @' + name + '\n';
  const file = path.join(root, 'Projection.lean');
  fs.writeFileSync(file, (options.mathlib ? 'import Mathlib\n' : '') + 'import Lean\nsyntax \"variables\" : command\nset_option autoImplicit false\n' + projection.prelude + '\n' +
    (options.before ?? '') + projection.source + (options.after ?? '') + mirror + '\n#print axioms ' + name + '\nrun_cmd do\n' +
    dependencies.map(dependency => '  if (← Lean.getEnv).contains ' + JSON.stringify(dependency.theoremName) +
      '.toName then throwError "Conditional dependency leaked"').join('\n') + '\n');
  const packages = mathlibProject && path.join(mathlibProject, '.lake', 'packages');
  const libraries = options.mathlib && packages ? fs.readdirSync(packages).map(name =>
    path.join(packages, name, '.lake', 'build', 'lib', 'lean')).filter(directory => fs.existsSync(directory)) : undefined;
  const result = spawnSync(lean, [file], { encoding: 'utf8', timeout: 30_000,
    env: libraries ? { ...process.env, LEAN_PATH: libraries.join(path.delimiter) } : process.env });
  expect(result.error).toBeUndefined();
  return { status: result.status, output: `${result.stdout}${result.stderr}`, source: fs.readFileSync(file, 'utf8') };
}
function accepted(result: ReturnType<typeof compile>) {
  expect(result.status, result.output).toBe(0);
  expect(result.output).not.toMatch(/sorryAx|declaration uses [`']sorry/u);
  for (const report of result.output.matchAll(/depends on axioms: \[([^\]]*)\]/gu))
    expect(report[1]!.split(',').map(name => name.trim()).filter(Boolean).every(name =>
      ['Classical.choice', 'propext', 'Quot.sound'].includes(name)), result.output).toBe(true);
}

describe.skipIf(!lean)('host conditional projection elaborators', { timeout: 60_000 }, () => {
  it.each([false, true])('preserves implicit and instance binders with a conditional input used=%s', used => {
    accepted(compile('theorem target {n : Nat} [Nonempty (Fin n)] (x : Fin n) : x = x := by ' +
      (used ? 'exact D.refl x' : 'rfl'),
    [{ theoremName: 'D.refl', type: '∀ {n : Nat} (x : Fin n), x = x' }],
    { expectedType: '∀ {n : Nat} [Nonempty (Fin n)] (x : Fin n), x = x' }));
  });

  it.skipIf(!mathlibProject).each(['theorem', 'lemma'])('normalizes Mathlib %s without leaking its conditional proof assumptions', kind => {
    accepted(compile(kind + ' target (n : Nat) : n = n := by exact D.refl n',
      [{ theoremName: 'D.refl', type: '∀ n : Nat, n = n' }],
      { mathlib: true, expectedType: '∀ n : Nat, n = n' }));
  });

  it.skipIf(!mathlibProject)('normalizes a qualified Mathlib lemma while retaining section variables and different universe uses', () => {
    accepted(compile('lemma target (x : α) (y : β) : x = x ∧ y = y := by exact ⟨D.refl x, D.refl y⟩',
      [{ theoremName: 'Demo.D.refl', type: '∀ {γ : Type _} (a : γ), a = a' }],
      { mathlib: true, name: 'Demo.target',
        before: 'namespace Demo\nuniverse u v\nvariable {α : Type u} {β : Type v}\n', after: '\nend Demo\n',
        expectedType: '∀ {α β : Type _} (x : α) (y : β), x = x ∧ y = y' }));
  });

  it.skipIf(!mathlibProject)('still rejects a wrong host contract after normalizing a Mathlib lemma', () => {
    const result = compile('lemma target (n : Nat) : n = n := by exact D.refl n',
      [{ theoremName: 'D.refl', type: '∀ n : Nat, n = n' }], { mathlib: true, expectedType: 'False' });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('Helper declaration has a different type or additional assumptions');
  });

  it('rejects an anonymous declaration before constructing a conditional proof payload', () => {
    expect(() => compile('example : True := by trivial', [], { mathlib: true }))
      .toThrow('math_task_conditional_header_unsupported');
  });

  it('orders dependency contracts and their used instances when a proof occurs in a later type', () => {
    const dependencies = [
      { theoremName: 'D.consumer', type: '∀ {α : Type _} (a : α), D.base a = D.base a' },
      { theoremName: 'D.base', type: '∀ {α : Type _} (a : α), a = a' },
    ];
    accepted(compile('theorem target {α : Type _} (a : α) : D.base a = D.base a := by exact D.consumer a',
      dependencies, { expectedType: '∀ {α : Type _} (a : α), D.base a = D.base a' }));
  });

  it.each(['def', 'abbrev'])('preserves a conditional data construction declared with %s', kind => {
    accepted(compile(kind + ' target : Nat := Classical.choose D.choice',
      [{ theoremName: 'D.choice', type: '∃ n : Nat, n = n' }],
      { before: 'noncomputable section\n', after: '\nend\n' }));
  });

  it('keeps scoped parameters and lookup scopes while producing a closed declaration', () => {
    accepted(compile('theorem target (a : α) : a = a := by exact D.refl a',
      [{ theoremName: 'Demo.D.refl', type: '∀ {β : Type _} (b : β), b = b' }],
      { name: 'Demo.target', before: 'namespace Demo\nuniverse u\nvariable {α : Type u}\n', after: '\nend Demo\n',
        expectedType: '∀ {α : Type _} (a : α), a = a' }));
  });

  it('keeps different fully qualified dependencies with the same final name separate', () => {
    accepted(compile('theorem target (a b : Nat) : a = a ∧ b = b := by exact ⟨A.input a, B.input b⟩',
      [{ theoremName: 'A.input', type: '∀ a : Nat, a = a' }, { theoremName: 'B.input', type: '∀ b : Nat, b = b' }],
      { expectedType: '∀ a b : Nat, a = a ∧ b = b' }));
  });

  it('independently rejects a changed host task type after compiling the proof', () => {
    const result = compile('theorem target (a : Nat) : a = a := by exact D.refl a',
      [{ theoremName: 'D.refl', type: '∀ a : Nat, a = a' }], { expectedType: 'False' });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('Helper declaration has a different type or additional assumptions');
  });

  it('rejects a changed dependency contract in the independent expected-type query', () => {
    const dependencies = [{ theoremName: 'D.refl', type: '∀ a : Nat, a = a' }];
    const wrong = [{ theoremName: 'D.refl', type: 'False' }];
    const result = compile('theorem target (a : Nat) : a = a := by exact D.refl a', dependencies, {
      after: '\nexample : ' + conditionalExpectedType('target', '∀ a : Nat, a = a', wrong) + ' := @target\n',
    });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('Host conditional premise has a different dependency type');
  });
});
