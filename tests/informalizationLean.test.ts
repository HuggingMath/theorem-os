import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readInformalizationRequest } from '../src/math/informalization';
import { extractInformalizationOutline } from '../src/solver/informalizationExtraction';
import { LIB_SOURCE, PROOF_SOURCE, informalizationFixture } from './helpers/informalizationFixture';

// Real Lean in the pinned standard environment; opt in with THEOREMOS_TEST_REFERENCE_LEAN=1.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function extract(files?: Record<string, string>) {
  const f = informalizationFixture(roots, {}, files); f.prepare();
  const { request, sources } = readInformalizationRequest(f.directory);
  return extractInformalizationOutline(path.join(f.directory, 'extraction'), request, sources, { timeoutMs: 600_000 });
}

describe.skipIf(process.env.THEOREMOS_TEST_REFERENCE_LEAN !== '1')('informalization extraction with Lean', () => {
  it('outlines a two-module proof in dependency order', async () => {
    const outline = await extract();
    expect(outline.units.map(unit => [unit.name, unit.kind, unit.module])).toEqual([['lib_fact', 'theorem', 'Lib'],
      ['double', 'definition', 'Proof'], ['double_eq', 'theorem', 'Proof'], ['double_add_zero', 'theorem', 'Proof']]);
    const byName = new Map(outline.units.map(unit => [unit.name, unit]));
    expect(byName.get('double_add_zero')!.proofDependencies).toEqual(expect.arrayContaining(['double_eq', 'lib_fact']));
    expect(byName.get('double_eq')!.statementDependencies).toEqual(['double']);
    expect(byName.get('lib_fact')!.source).toBe('theorem lib_fact (n : Nat) : n + 0 = n := rfl');
    expect(byName.get('double')!.source).toBe('/-- Twice a number. -/\ndef double (n : Nat) : Nat := n + n');
    expect(byName.get('double_add_zero')!.signature).toBe('double_add_zero (n : Nat) : double (n + 0) = 2 * n');
    expect(outline.axioms).not.toContain('sorryAx');
    // Goals Lean printed around each tactic as written.
    expect(outline.goalStates).toEqual({ protocol: 'lean-tactic-goals-v1', status: 'complete' });
    expect(byName.get('lib_fact')!.goals).toEqual({ truncated: false, tactics: [] });
    const tactics = (name: string) => byName.get(name)!.goals!.tactics.map(item => [item.tactic, item.before, item.after]);
    expect(tactics('double_eq')).toEqual([['unfold double', ['n : Nat\n⊢ double n = 2 * n'], ['n : Nat\n⊢ n + n = 2 * n']],
      ['omega', ['n : Nat\n⊢ n + n = 2 * n'], []]]);
    expect(tactics('double_add_zero')).toEqual([['rw [lib_fact]', ['n : Nat\n⊢ double (n + 0) = 2 * n'], ['n : Nat\n⊢ double n = 2 * n']],
      ['exact double_eq n', ['n : Nat\n⊢ double n = 2 * n'], []]]);
  }, 600_000);

  it('refuses a proof with sorry and a proof that does not compile', async () => {
    await expect(extract({ 'Lib.lean': LIB_SOURCE, 'Proof.lean': PROOF_SOURCE.replace('  omega', '  sorry') }))
      .rejects.toThrow('informalization_proof_incomplete');
    await expect(extract({ 'Lib.lean': LIB_SOURCE, 'Proof.lean': PROOF_SOURCE.replace('  omega', '  exact rfl') }))
      .rejects.toThrow(/^informalization_proof_does_not_compile: Proof\.lean: /u);
  }, 600_000);
});
