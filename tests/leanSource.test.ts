import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { newestLeanBinary } from './helpers/lean';
import {
  declarationHashes,
  hashMathFormalSourceDeclaration,
  inspectLeanDeclarationRegions,
  inspectLeanDeclarations,
  inspectLeanProjectionDeclarations,
  inspectScopedLeanDeclarations,
  leanDeclarationContextCommands,
  leanDeclarationKeys,
  repeatedLeanLocalNames,
} from '../src/math/leanSource';

describe('Lean declaration names with punctuation', () => {
  it('keeps question-mark, plain and exclamation-mark declarations distinct for exact lookup', () => {
    const names = ['delivery_probe?', 'delivery_probe', 'delivery_probe!'];
    const declarations = names.map(name => `lemma ${name} : True := by trivial\n`);
    const source = declarations.join('');
    expect(inspectLeanDeclarations(source).map(item => item.name)).toEqual(names);
    expect(inspectLeanDeclarationRegions(source).map(item => item.name)).toEqual(names);
    expect(declarationHashes(source).size).toBe(3);
    expect(new Set(declarationHashes(source).values()).size).toBe(3);
    for (const [index, name] of names.entries()) {
      const expected = hashMathFormalSourceDeclaration(declarations[index], name);
      expect(expected).toMatch(/^[a-f0-9]{64}$/u);
      expect(declarationHashes(source).get(name)).toBe(expected);
      expect(hashMathFormalSourceDeclaration(source, `Submission.${name}`)).toBe(expected);
    }
    expect(hashMathFormalSourceDeclaration(source, 'delivery_probe?!')).toBeUndefined();
  });

  it.each(['?', '!'])('preserves %s in qualified names beside universe parameters', suffix => {
    const source = `namespace Outer
theorem Algebra.α'${suffix}.{u} {K : Type u} (x : K) : x = x := by rfl
theorem _root_.Submission.apply'${suffix}.{u} {K : Type u} (x : K) : x = x := by rfl
end Outer
`;
    expect(inspectScopedLeanDeclarations(source).map(({ name, qualifiedName }) => ({ name, qualifiedName }))).toEqual([
      { name: `Algebra.α'${suffix}`, qualifiedName: `Outer.Algebra.α'${suffix}` },
      { name: `_root_.Submission.apply'${suffix}`, qualifiedName: `Submission.apply'${suffix}` },
    ]);
    expect(inspectLeanDeclarations(source)[0].declarationType).toContain(`Algebra.α'${suffix}.{u}`);
    expect(leanDeclarationContextCommands(source, `Outer.Algebra.α'${suffix}`)).toEqual({
      before: ['namespace Outer'], after: ['end Outer'],
    });
  });

  it('does not treat keyword-shaped identifiers as declaration keywords', () => {
    const source = `def theorem? : True := True.intro
def lemma! : True := theorem?
theorem goal : True := lemma!
`;
    expect(inspectLeanDeclarations(source).map(item => [item.name, item.kind])).toEqual([
      ['theorem?', 'definition'], ['lemma!', 'definition'], ['goal', 'theorem'],
    ]);
  });
});

describe('Lean declaration universe parameters', () => {
  it('keeps distinct helper names usable for lookup and duplicate detection', () => {
    const source = `namespace Submission.Helpers
theorem contDiffOn_superposition_compact_nat.{uK, uE, uF}
    {K : Type uK} (x : K) : x = x := by
  rfl
theorem contDiffOn_superposition_compact.{uK, uE, uF}
    {K : Type uK} (x : K) : x = x := by
  rfl
end Submission.Helpers
`;
    const names = ['contDiffOn_superposition_compact_nat', 'contDiffOn_superposition_compact'];
    expect(inspectLeanDeclarationRegions(source).map(region => region.name)).toEqual(names);
    expect(new Set(inspectLeanDeclarationRegions(source).map(region => region.name.split('.').at(-1))).size).toBe(2);
    for (const name of names) {
      expect(declarationHashes(source).get(name)).toMatch(/^[a-f0-9]{64}$/u);
      expect(hashMathFormalSourceDeclaration(source, `Submission.Helpers.${name}`)).toBe(declarationHashes(source).get(name));
    }
    expect(leanDeclarationContextCommands(source, 'Submission.Helpers.contDiffOn_superposition_compact')).toEqual({
      before: ['namespace Submission.Helpers'], after: ['end Submission.Helpers'],
    });
  });

  it('preserves qualified names, root qualification, Unicode and apostrophes', () => {
    const source = `namespace Outer
theorem Algebra.α'.{u} {K : Type u} (x : K) : x = x := by rfl
theorem _root_.Submission.Flow.apply'.{u} {K : Type u} (x : K) : x = x := by rfl
end Outer
`;
    expect(inspectScopedLeanDeclarations(source).map(({ name, qualifiedName }) => ({ name, qualifiedName }))).toEqual([
      { name: "Algebra.α'", qualifiedName: "Outer.Algebra.α'" },
      { name: "_root_.Submission.Flow.apply'", qualifiedName: "Submission.Flow.apply'" },
    ]);
    expect(declarationHashes(source).get("apply'")).toBe(declarationHashes(source).get("_root_.Submission.Flow.apply'"));
  });

  it('retains universe binders in the protected header while excluding proof changes', () => {
    const source = 'theorem target.{u, v} {K : Type u} (x : K) : x = x := by rfl\n';
    const hash = hashMathFormalSourceDeclaration(source, 'target');
    expect(inspectLeanDeclarations(source)[0].declarationType).toBe('target.{u, v} {K : Type u} (x : K) : x = x');
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(hashMathFormalSourceDeclaration(source.replace('.{u, v}', '.{u}'), 'target')).not.toBe(hash);
    expect(hashMathFormalSourceDeclaration(source.replace('by rfl', 'by exact rfl'), 'target')).toBe(hash);
  });

  it('leaves projections, decimals and explicit universe applications in types and bodies intact', () => {
    const source = `def Algebra.project (x : Nat × Nat) : Nat := x.1
def Algebra.decimal : Float := 1.25
theorem Algebra.target.{u} (α : Type u) : id.{u + 1} α = α := by
  rfl
`;
    const regions = inspectLeanDeclarationRegions(source);
    expect(regions.map(region => region.name)).toEqual(['Algebra.project', 'Algebra.decimal', 'Algebra.target']);
    expect(regions.map(region => source.slice(region.bodyOffset, region.endOffset).trim())).toEqual(['x.1', '1.25', 'by\n  rfl']);
    expect(regions[2].declarationType).toContain('id.{u + 1} α = α');
  });
});

describe('Lean declaration equation boundaries', () => {
  it.each([
    '|d / (q : ℝ) - d0| ≤ eta * d0 / 2',
    '|(H.edgeDensity A B : ℝ) - (G.edgeDensity A B : ℝ) / (q : ℝ)| <\n      1 / ((A.card : ℝ) * (B.card : ℝ))',
    '|D.sum (fun w => T.sum (fun t => f t *\n      (if supported w t then (1 : ℝ) else 0)))| ≤ bound',
    '|fun x => f x| = bound',
    '|λ x => f x| = bound',
  ])('keeps a line-leading absolute-value conclusion in the protected header: %s', conclusion => {
    const source = `theorem target (d : ℝ) :\n    ${conclusion} := by\n  exact proof\n`;
    const inline = source.replace(':\n    |', ': |');
    const [region] = inspectLeanDeclarationRegions(source);
    expect(region.declarationType).toBe(`target (d : ℝ) : ${conclusion.replace(/\s+/gu, ' ')}`);
    expect(source.slice(region.bodyOffset, region.endOffset).trim()).toBe('by\n  exact proof');
    const originalHash = hashMathFormalSourceDeclaration(source, 'target');
    expect(originalHash).toBe(hashMathFormalSourceDeclaration(inline, 'target'));
    expect(originalHash).not.toBe(hashMathFormalSourceDeclaration(source.replace(conclusion, 'True'), 'target'));
    expect(originalHash).toBe(hashMathFormalSourceDeclaration(source.replace('exact proof', 'exact anotherProof'), 'target'));
  });

  it('keeps an absolute-value return type before real equation clauses', () => {
    const source = `def target (x : ℝ) :
    |x| ≤ 1 → Nat → Nat
  | _, 0 => 0
  | _, n + 1 => n
theorem next : True := by trivial
`;
    const regions = inspectLeanDeclarationRegions(source);
    expect(regions.map(region => region.name)).toEqual(['target', 'next']);
    expect(regions[0].declarationType).toBe('target (x : ℝ) : |x| ≤ 1 → Nat → Nat');
    expect(source.slice(regions[0].bodyOffset, regions[0].endOffset)).toBe('| _, 0 => 0\n  | _, n + 1 => n\n');
  });

  it.each([
    '0 => 0\n  | n + 1 => n',
    '0 | 1 => 0\n  | n => n',
    '0\n  | 1 => 0\n  | n => n',
    '0 | 1\n  | 2 => 0\n  | n => n',
    'some\n      (n) => n\n  | none => 0',
    '"(=>|" => 0\n  | _ => 1',
    "'(' => 0\n  | _ => 1",
    "')' => 0\n  | _ => 1",
    "'=' => 0\n  | _ => 1",
    "'|' => 0\n  | _ => 1",
    String.raw`'\'' => 0
  | _ => 1`,
    'n /- outer /- => ( -/ nested -/ -- => [\n    => n',
  ])('preserves equation bodies with nested or quoted pattern tokens: %s', clauses => {
    const source = `def target : Nat → Nat\n  | ${clauses}\n`;
    const [region] = inspectLeanDeclarationRegions(source);
    expect(region.declarationType).toBe('target : Nat → Nat');
    expect(source.slice(region.bodyOffset, region.endOffset)).toBe(`| ${clauses}\n`);
    expect(hashMathFormalSourceDeclaration(source, 'target')).toBe(
      hashMathFormalSourceDeclaration(source.replace(/=> [01n]/gu, '=> 2'), 'target'));
  });

  it('keeps binder defaults and top-level match return types protected', () => {
    const source = `def defaulted (n : Nat := match true with
    | true => 0
    | false => 1) : Nat → Nat
  | 0 => n
  | k + 1 => k
def matched : match true with
    | true => Nat
    | false => Nat := 0
`;
    const regions = inspectLeanDeclarationRegions(source);
    expect(regions.map(region => region.name)).toEqual(['defaulted', 'matched']);
    expect(regions[0].declarationType).toBe('defaulted (n : Nat := match true with | true => 0 | false => 1) : Nat → Nat');
    expect(source.slice(regions[0].bodyOffset, regions[0].endOffset)).toBe('| 0 => n\n  | k + 1 => k\n');
    expect(regions[1].declarationType).toBe('matched : match true with | true => Nat | false => Nat');
    expect(source.slice(regions[1].bodyOffset, regions[1].endOffset).trim()).toBe('0');
  });
});

describe('instance attributes and derive handlers', () => {
  it('finds a target after a named where instance using only default fields', () => {
    const source = [
      'namespace Fixture',
      'class Witness where',
      '  marker : Nat := 7',
      'instance before : Witness where',
      '  marker := 1',
      'instance defaulted : Witness where',
      'theorem goal : True := by sorry',
      'instance after : Witness where',
      '  marker := 2',
      'end Fixture', '',
    ].join('\n');
    const regions = inspectLeanDeclarationRegions(source);
    expect(regions.map(region => region.name)).toEqual(['before', 'defaulted', 'goal', 'after']);
    const defaulted = regions.find(region => region.name === 'defaulted')!;
    expect(source.slice(defaulted.startOffset, defaulted.endOffset).trim())
      .toBe('instance defaulted : Witness where');
    expect(inspectScopedLeanDeclarations(source).map(item => item.qualifiedName))
      .toEqual(['Fixture.before', 'Fixture.defaulted', 'Fixture.goal', 'Fixture.after']);
    expect(hashMathFormalSourceDeclaration(source, 'Fixture.goal'))
      .toBe(hashMathFormalSourceDeclaration('theorem goal : True := by sorry\n', 'goal'));
  });

  it('preserves legacy hashes and frozen body boundaries for nonempty named where instances', () => {
    const source = [
      'instance before : Witness where',
      '  marker := 1',
      'theorem goal : True := by sorry',
      'instance after : Witness where',
      '  marker := 2', '',
    ].join('\n');
    // Existing task receipts include the first where-field name in the protected header.
    for (const [name, body] of [['before', '1'], ['after', '2']]) {
      const region = inspectLeanDeclarationRegions(source).find(item => item.name === name)!;
      const legacyHeader = `${name} : Witness where marker`;
      expect(region.declarationType).toBe(legacyHeader);
      expect(declarationHashes(source).get(name)).toBe(mathDigest(legacyHeader));
      expect(hashMathFormalSourceDeclaration(source, name)).toBe(mathDigest(legacyHeader));
      expect(source.slice(region.bodyOffset, region.endOffset).trim()).toBe(body);
    }
  });

  it.each([
    ['same-column field', 'marker := 9'],
    ['field after a block comment', '/- field -/ marker := 9'],
    ['field after a closing block comment', '/- field\n-/ marker := 9'],
  ])('retains the legacy header and complete projection for a %s', (_kind, field) => {
    const instance = `instance populated : Witness where\n${field}`;
    const source = [
      'class Witness where', '  marker : Nat := 7', instance,
      'theorem goal : populated.marker = 9 := rfl', '',
    ].join('\n');
    const region = inspectLeanDeclarationRegions(source).find(item => item.name === 'populated')!;
    const legacyHeader = 'populated : Witness where marker';
    expect(region.declarationType).toBe(legacyHeader);
    expect(source.slice(region.bodyOffset, region.endOffset).trim()).toBe('9');
    expect(declarationHashes(source).get('populated')).toBe(mathDigest(legacyHeader));
    expect(hashMathFormalSourceDeclaration(source, 'populated')).toBe(mathDigest(legacyHeader));
    const projected = inspectLeanProjectionDeclarations(source).find(item => item.name === 'populated')!;
    expect(source.slice(projected.startOffset, projected.endOffset).trim()).toBe(instance);
    expect(source.slice(projected.bodyOffset, projected.endOffset)).toContain('marker := 9');
  });

  it('ends an empty where instance before a commented following target', () => {
    const source = [
      'class Witness where', '  marker : Nat := 7',
      'instance defaulted : Witness where',
      '/- Keep the default marker.\n   This comment belongs before the next command. -/',
      'theorem goal : defaulted.marker = 7 := rfl', '',
    ].join('\n');
    expect(inspectLeanDeclarationRegions(source).map(item => item.name)).toEqual(['defaulted', 'goal']);
    expect(inspectLeanProjectionDeclarations(source).map(item => item.name)).toEqual(['defaulted', 'goal']);
    expect(hashMathFormalSourceDeclaration(source, 'goal'))
      .toBe(mathDigest('goal : defaulted.marker = 7'));
    for (const regions of [inspectLeanDeclarationRegions(source), inspectLeanProjectionDeclarations(source)]) {
      const instance = regions.find(item => item.name === 'defaulted')!;
      expect(source.slice(instance.startOffset, instance.endOffset)).not.toContain('theorem goal');
    }
  });

  it('recognizes an empty where instance at EOF without a trailing newline', () => {
    const source = 'class Witness where\n  marker : Nat := 7\ninstance defaulted : Witness where';
    for (const regions of [inspectLeanDeclarationRegions(source), inspectLeanProjectionDeclarations(source)]) {
      expect(regions.map(item => item.name)).toEqual(['defaulted']);
      expect(regions[0].declarationType).toBe('defaulted : Witness');
      expect(regions[0].bodyOffset).toBe(source.length);
      expect(regions[0].endOffset).toBe(source.length);
    }
  });

  it.skipIf(!newestLeanBinary())('projects every field of a native-checked same-column where instance', () => {
    const instance = 'instance populated : Witness where\nmarker := 9\nother := 13';
    const source = [
      'class Witness where', '  marker : Nat := 7', '  other : Nat := 11', instance,
      'theorem goal : populated.marker = 9 ∧ populated.other = 13 := ⟨rfl, rfl⟩',
      '#print axioms goal', '',
    ].join('\n');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-where-projection-'));
    try {
      const file = path.join(root, 'SameColumn.lean');
      fs.writeFileSync(file, source);
      const checked = spawnSync(newestLeanBinary()!, [file], { encoding: 'utf8', timeout: 20_000 });
      expect(checked.error).toBeUndefined();
      expect(checked.status, `${checked.stdout}${checked.stderr}`).toBe(0);
      expect(checked.stdout).toContain("'goal' does not depend on any axioms");
      const region = inspectLeanProjectionDeclarations(source).find(item => item.name === 'populated')!;
      expect(source.slice(region.startOffset, region.endOffset).trim()).toBe(instance);
      expect(source.slice(region.bodyOffset, region.endOffset)).toContain('marker := 9\nother := 13');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('does not read attribute instance names or deriving clauses as declarations', () => {
    // 2026-10-30: `attribute [local instance 2000] inst` was read as `instance 2000`, swallowing the next def up to its `:=`.
    const source = [
      'attribute [local instance 2000] instPolynormableSpace',
      'def frequencyLattice : Nat := 1',
      'attribute [-instance] CStarAlgebra.toNormedRing CommCStarAlgebra.toNormedCommRing',
      'attribute [instance] Coarsening.topology',
      'def flattenVector : Nat := 2',
      '@[simp, instance 100] def bundled : Nat := 3',
      'inductive Shape | a | b',
      '  deriving DecidableEq',
      'deriving instance DecidableEq for Shape',
      'def ampleIsometry : Nat := 4',
      'instance real : Inhabited Shape := ⟨Shape.a⟩',
      '',
    ].join('\n');
    expect(inspectLeanDeclarationRegions(source).map(region => region.name))
      .toEqual(['frequencyLattice', 'flattenVector', 'bundled', 'ampleIsometry', 'real']);
    expect(inspectLeanDeclarations(source).map(item => item.kind))
      .toEqual(['definition', 'definition', 'definition', 'definition', 'instance']);
  });

  it('keeps anonymous projection regions out of frozen named declaration identities', () => {
    const source = [
      'namespace Fixture',
      'theorem original (n : Nat) : n = n := by rfl',
      'instance (n : Nat) : Inhabited (Fin (n + 1)) := ⟨⟨0, Nat.zero_lt_succ n⟩⟩',
      'instance named : Inhabited Nat := ⟨0⟩',
      'instance : Inhabited Bool := ⟨true⟩',
      'theorem goal : True := by trivial',
      'end Fixture', '',
    ].join('\n');
    const names = ['original', 'named', 'goal'];
    const hashes = declarationHashes(source);
    const scoped = inspectScopedLeanDeclarations(source);
    expect([...hashes.keys()]).toEqual(names);
    expect([...leanDeclarationKeys(source).values()]).toEqual(names);
    const projected = inspectLeanProjectionDeclarations(source);
    expect(projected.map(item => item.qualifiedName))
      .toEqual(['Fixture.original', undefined, 'Fixture.named', undefined, 'Fixture.goal']);
    expect(projected.filter(item => item.name === undefined).map(item =>
      source.slice(item.startOffset, item.endOffset).trim())).toEqual([
      'instance (n : Nat) : Inhabited (Fin (n + 1)) := ⟨⟨0, Nat.zero_lt_succ n⟩⟩',
      'instance : Inhabited Bool := ⟨true⟩',
    ]);
    // The two cached views must not change frozen task identities or type lookup.
    expect(declarationHashes(source)).toEqual(hashes);
    expect(inspectScopedLeanDeclarations(source)).toEqual(scoped);
    expect(inspectLeanDeclarationRegions(source).map(item => item.name)).toEqual(names);
    expect(hashMathFormalSourceDeclaration(source, 'Fixture.goal'))
      .toBe(hashMathFormalSourceDeclaration('theorem goal : True := by trivial\n', 'goal'));
    expect(leanDeclarationContextCommands(source, 'Fixture.goal'))
      .toEqual({ before: ['namespace Fixture'], after: ['end Fixture'] });
  });
});

describe('repeated final name components', () => {
  it('keys only the repeated declarations by qualified name', () => {
    const source = 'namespace A\ndef step : Nat := 1\ndef Literal.eval : Nat := 0\nend A\n' +
      'namespace B\ndef step : Nat := 2\ndef Clause.eval : Nat := 0\nend B\ndef unique : Nat := 3\n';
    expect([...leanDeclarationKeys(source).values()]).toEqual(['A.step', 'A.Literal.eval', 'B.step', 'B.Clause.eval', 'unique']);
    expect(repeatedLeanLocalNames(inspectLeanDeclarationRegions(source).map(region => region.name)))
      .toBe('[["eval",2],["step",2]]');
    expect(repeatedLeanLocalNames(['unique', 'other'])).toBe('[]');
  });
});

describe('mutual blocks', () => {
  it('closes a mutual block without closing the enclosing namespace', () => {
    const source = 'namespace OAI\nnoncomputable section\nnamespace W\nmutual\n' +
      'def even : Nat → Bool\n  | 0 => true\n  | n + 1 => odd n\n' +
      'def odd : Nat → Bool\n  | 0 => false\n  | n + 1 => even n\n' +
      'end\ntheorem even_zero : even 0 = true := rfl\nend W\ntheorem main : W.even 0 = true := by\n  sorry\nend\nend OAI\n';
    expect(inspectScopedLeanDeclarations(source).map(item => item.qualifiedName))
      .toEqual(['OAI.W.even', 'OAI.W.odd', 'OAI.W.even_zero', 'OAI.main']);
    expect(leanDeclarationContextCommands(source, 'OAI.main'))
      .toEqual({ before: ['namespace OAI', 'noncomputable section'], after: ['end', 'end OAI'] });
    expect(leanDeclarationContextCommands(source, 'OAI.W.odd'))
      .toEqual({ before: ['namespace OAI', 'noncomputable section', 'namespace W'], after: ['end W', 'end', 'end OAI'] });
  });
});
