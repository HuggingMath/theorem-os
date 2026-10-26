import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkLeanType } from '../src/math/leanTypeDiagnostics';
import { inspectScopedLeanDeclarations } from '../src/math/leanSource';
import { runLeanProcess } from '../src/math/mathProcess';
import type { SolverProblem } from '../src/solver/problem';
import { tacticBatteryProof, tacticBatterySource, vacuityProbeProof } from '../src/solver/tacticBattery';
import type { CooperativeTask } from '../src/solver/tasks';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/math/verifier', () => ({ runMathematicsSandboxedCommand: run,
  formalVerificationToolIdentity: () => 'a'.repeat(64) }));
const toolchains = path.join(os.homedir(), '.elan', 'toolchains');
const lean = fs.existsSync(toolchains) ? fs.readdirSync(toolchains).toSorted().reverse()
  .map(name => path.join(toolchains, name, 'bin', 'lean')).find(file => fs.existsSync(file)) : undefined;

const problem = { declarations: { 'Submission.lean': [{ name: 'Tutorial.add_zero' }] } } as unknown as SolverProblem;
const task = (theoremName = 'Tutorial.helper', type = 'True'): CooperativeTask => ({ id: 'helper', kind: 'lemma',
  objective: 'Prove helper', dependsOn: [], revision: 0, theoremName, proofPath: 'Submission.lean', type });
const proof = tacticBatteryProof(false);
const original = 'namespace Tutorial\n\ntheorem add_zero (n : Nat) : n + 0 = n := by sorry\n\nend Tutorial\n';
const place = (source: string, theoremName?: string, anchor = 'Tutorial.add_zero') =>
  tacticBatterySource(problem, source, task(theoremName), anchor, proof);
const theorems = (source: string) => inspectScopedLeanDeclarations(source).map(item => item.qualifiedName);

describe('tactic battery placement', () => {
  it('uses fixed alternatives and adds Mathlib tactics only when requested', () => {
    expect(proof).toBe('by first | rfl | trivial | omega | (simp; done) | (intros; simp_all; done) | decide');
    expect(tacticBatteryProof(true)).toContain(' | (intros; linarith) | ');
    expect(tacticBatteryProof(true).startsWith(proof)).toBe(true);
  });

  it('probes vacuity only through contradiction tactics after refusing a False conclusion', () => {
    expect(vacuityProbeProof(false)).toBe('by intros; (fail_if_success guard_target =ₛ False); exfalso; ' +
      'first | contradiction | omega | (simp_all; done)');
    expect(vacuityProbeProof(true).startsWith(`${vacuityProbeProof(false)} | linarith | `)).toBe(true);
  });

  it('inserts a new helper before the anchor with a namespace-relative name', () => {
    const edited = place(original)!;
    expect(edited).toBe('namespace Tutorial\n\ntheorem helper : True\n  := ' + proof +
      '\n\ntheorem add_zero (n : Nat) : n + 0 = n := by sorry\n\nend Tutorial\n');
    expect(theorems(edited)).toEqual(['Tutorial.helper', 'Tutorial.add_zero']);
  });

  it('keeps the anchor doc comment attached to the anchor and preserves indentation', () => {
    const source = 'namespace Tutorial\n  /-- Original documentation. -/\n  theorem add_zero (n : Nat) : n + 0 = n := by sorry\nend Tutorial\n';
    const edited = place(source)!;
    expect(edited).toContain(`\n  theorem helper : True\n    := ${proof}\n\n  /-- Original documentation. -/\n  theorem add_zero`);
    const scoped = original.replace('theorem add_zero', 'variable (m : Nat)\n\ntheorem add_zero');
    expect(place(scoped)).toContain(`variable (m : Nat)\n\ntheorem helper : True\n  := ${proof}\n\ntheorem add_zero`);
    expect(place(original.replace('theorem add_zero', '/-- Doc. -/\n@[simp]\ntheorem add_zero'))).toBeUndefined();
  });

  it('fills an existing admitted helper body without changing its statement', () => {
    for (const body of ['by sorry', 'by\n  admit']) {
      const source = original.replace('theorem add_zero', `theorem helper : True := ${body}\n\ntheorem add_zero`);
      const edited = place(source)!;
      expect(edited).toContain(`theorem helper : True := ${proof}\n\ntheorem add_zero (n : Nat) : n + 0 = n := by sorry`);
      expect(theorems(edited)).toEqual(['Tutorial.helper', 'Tutorial.add_zero']);
    }
  });

  it.each([
    ['an attribute', original.replace('theorem add_zero', '@[simp]\ntheorem add_zero')],
    ['an open-in scope', original.replace('theorem add_zero', 'open Nat in\ntheorem add_zero')],
    ['a modifier line', original.replace('theorem add_zero', 'private\ntheorem add_zero')],
    ['several modifiers', original.replace('theorem add_zero', 'protected noncomputable -- note\ntheorem add_zero')],
    ['a same-line attribute', original.replace('theorem add_zero', '@[simp] theorem add_zero')],
    ['a multi-line attribute', original.replace('theorem add_zero', '@[simp,\n  norm_cast]\ntheorem add_zero')],
    ['an option scope', original.replace('theorem add_zero', 'set_option maxHeartbeats 400000 in\ntheorem add_zero')],
  ])('refuses to insert where %s binds to the anchor', (_, source) => {
    expect(place(source)).toBeUndefined();
  });

  it('refuses ambiguous, original, proved, or out-of-namespace placements', () => {
    const helper = (declaration: string) => original.replace('theorem add_zero', `${declaration}\n\ntheorem add_zero`);
    expect(place(helper('theorem Other.helper : True := by sorry'))).toBeUndefined();
    expect(place(helper('theorem helper : True := by sorry\ntheorem Other.helper : True := by sorry'))).toBeUndefined();
    expect(place(helper('theorem helper : True := by trivial'))).toBeUndefined();
    expect(place(helper('def helper : True := by sorry'))).toBeUndefined();
    expect(place(original, 'Tutorial.add_zero')).toBeUndefined();
    expect(place(original, 'Other.helper')).toBeUndefined();
    expect(place(original, 'Tutorial.helper', 'Tutorial.missing')).toBeUndefined();
  });
});

describe.skipIf(!lean)('local Lean tactic battery elaboration', () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tactic-battery-')));
    fs.writeFileSync(path.join(root, 'Submission.lean'), original);
    run.mockReset().mockImplementation(input => runLeanProcess('/bin/sh', ['-ceu', input.args.at(-1)], {
      cwd: input.checkoutRoot, timeoutMs: input.timeoutMs, signal: input.signal, outputLimit: input.outputLimit,
      outputCapture: input.outputCapture, env: { ...process.env, PATH: `${path.dirname(lean!)}:${process.env.PATH}`,
        LEAN_PATH: path.join(input.checkoutRoot, '.lake', 'build', 'lib', 'lean') } }));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const check = (type: string, expression = proof) => checkLeanType({ projectRoot: root, file: 'Submission.lean',
    context: 'Tutorial.add_zero', type, expression, timeoutMs: 60_000 });

  it.each(['True', '2 + 2 = 4', '∀ n : Nat, n + 0 = n', '∀ a b : Nat, a + b = b + a'])
  ('closes the easy closed type %s with the core battery', async type => {
    const result = await check(type);
    expect(result.status, result.stdout + result.stderr).toBe('elaborated');
    expect(result.constants).not.toContain('sorryAx');
  });

  it.each(['∀ n : Nat, n = n + 1', 'False'])('fails without admitting a proof for %s', async type => {
    const result = await check(type);
    expect(result.status).toBe('failed');
    expect(result.proofAcceptance).toBe('not-assessed');
  });

  it.each(['∀ n : Nat, n < 0 → n = 5', '∀ p : Prop, p → ¬p → 1 = 2', '∀ a b : Nat, a < b → b < a → a + b = 7'])
  ('reports the contradictory hypotheses of %s as vacuous', async type => {
    const result = await check(type, vacuityProbeProof(false));
    expect(result.status, result.stdout + result.stderr).toBe('elaborated');
    expect(result.constants).not.toContain('sorryAx');
  });

  it.each(['∀ n : Nat, n + 0 = n', '∀ n : Nat, n = 0 → n + 1 = 1', '∀ n : Nat, n < 0 → False', 'False', '∀ n : Nat, ¬ (n < 0)'])
  ('does not report the satisfiable or refutation-shaped type %s as vacuous', async type => {
    expect((await check(type, vacuityProbeProof(false))).status).toBe('failed');
  });
});
