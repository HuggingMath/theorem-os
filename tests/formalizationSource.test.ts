import { describe, expect, it } from 'vitest';
import { eraseFormalizationProofs, formalizationTargets, hasErasedFormalizationProofs } from '../src/math/formalizationSource';

const source = [
  'import Mathlib',
  'namespace FormalizationFixture',
  'def marker : Nat := 0',
  'theorem right (n : Nat) : n + 0 = n := by sorry',
  'lemma left (n : Nat) : 0 + n = n := by sorry',
  'end FormalizationFixture',
  '',
].join('\n');

describe('formalization source admission', () => {
  it('binds every theorem and lemma to its namespace and declaration, including Unicode names', () => {
    const input = [
      'universe u',
      'namespace 数学.測試',
      'noncomputable section Context',
      'variable {α : Type u}',
      '  (x : α)',
      'open scoped BigOperators',
      'def 標記 : Nat := 0',
      'theorem 恒等 : x = x := by sorry',
      'lemma _root_.全域 : True := by sorry',
      'end Context',
      'end 数学.測試',
    ].join('\n');
    const targets = formalizationTargets(input);
    expect(targets.map(target => target.name)).toEqual(['数学.測試.恒等', '全域']);
    expect(targets.every(target => /^[a-f0-9]{64}$/u.test(target.declarationHash))).toBe(true);
    expect(formalizationTargets(input.replace('x = x', 'x ≠ x'))[0]!.declarationHash).not.toBe(targets[0]!.declarationHash);
  });

  it('accepts complete theorem proofs and ignores comments and ordinary string/character contents', () => {
    const input = [
      '/- axiom hidden /- run_cmd -/ #eval -/',
      'def label : String := "sorry admit unsafe deriving ? _ #eval"',
      'def literalMacroName : String := "s!"',
      'def question : Char := \'?\'',
      'def underscore : Char := \'_\'',
      'def answer : Option Nat := [1].head?',
      source.replace(':= by sorry', ':= by\n  rfl'),
    ].join('\n');
    expect(formalizationTargets(input)).toEqual(formalizationTargets(source));
    expect(formalizationTargets(source.replaceAll(':= by sorry', ':= rfl'))).toEqual(formalizationTargets(source));
  });

  it('allows pure abbreviations and named instances without creating additional proof targets', () => {
    const input = 'abbrev Value := Nat\ninstance valueDefault : Inhabited Value := ⟨0⟩\n' + source;
    expect(formalizationTargets(input)).toEqual(formalizationTargets(source));
  });

  it.each([
    'axiom borrowed : False',
    'constant borrowed : Nat',
    'opaque borrowed : Nat := 0',
    'unsafe def borrowed : Nat := 0',
    'partial def borrowed : Nat := borrowed',
    'initialize IO.println "unexpected"',
    'builtin_initialize IO.println "unexpected"',
    'run_cmd IO.println "unexpected"',
    'run_elab logInfo "unexpected"',
    'macro "custom" : command => `(command| #eval 0)',
    'elab "custom" : command => pure ()',
    'syntax "custom" : command',
    'deriving instance Inhabited for Nat',
    'set_option debug.skipKernelTC true',
    '#eval IO.println "unexpected"',
    'attribute [implemented_by borrowed] Nat.add',
    '@[extern "unexpected"] def borrowed : Nat := 0',
    'custom_imported_command',
    'structure Unsupported where\n  value : Nat',
    'inductive Unsupported where\n  | value',
    'instance : Inhabited Nat := ⟨0⟩',
    'open Classical in custom_imported_command',
    'def hidden : String := s!"{by run_elab pure ()}"',
  ])('rejects unsupported or executable source constructs: %s', declaration => {
    expect(() => formalizationTargets(declaration + '\n' + source)).toThrow('formalization_unsupported_declaration');
  });

  it.each([
    'by run_tac IO.println "unexpected"',
    'by run_meta pure ()',
    'by exact Lean.sorryAx _ true',
  ])('rejects unsafe constructs even in a proof that would later be erased: %s', proof => {
    expect(() => formalizationTargets(source.replaceAll('by sorry', proof))).toThrow('formalization_unsupported_declaration');
  });

  it.each([
    ['def unknown : Nat := by sorry\n' + source],
    ['def unknown : Nat := _\n' + source],
    ['def unknown : Nat := ?missing\n' + source],
    [source.replace('(n : Nat)', '(n : _)')],
    [source.replace('n + 0 = n', 'n = (by sorry : Nat)')],
    [source.replace('n + 0 = n', 'n = ?missing')],
  ])('rejects placeholders in definitions and statement types', input => {
    expect(() => formalizationTargets(input)).toThrow('formalization_placeholder_outside_proof');
  });

  it('keeps unfinished tactic proofs separate from unfinished definitions and statement types', () => {
    const proof = 'by\n  have aux : n + 0 = n := by admit\n  exact aux';
    expect(formalizationTargets(source.replace('by sorry', proof))).toEqual(formalizationTargets(source));
  });

  it.each(['sorry', 'admit', '_', '?unfinished', '(show True from sorry)'])(
    'accepts placeholders in erased theorem term proofs: %s', proof => {
      const input = `theorem unfinished : True := ${proof}\n`;
      expect(eraseFormalizationProofs(input)).toBe('theorem unfinished : True := by sorry\n');
      expect(formalizationTargets(input)).toEqual(formalizationTargets(eraseFormalizationProofs(input)));
    });

  it('does not mistake a later indented variable command for part of a theorem proof', () => {
    expect(() => formalizationTargets('theorem first : True := by sorry\n  variable (x : _)\n' + source))
      .toThrow('formalization_placeholder_outside_proof');
  });

  it('rejects ambiguous names across namespaces and unsupported inline declaration layouts', () => {
    expect(() => formalizationTargets([
      'namespace A', 'theorem same : True := by sorry', 'end A',
      'namespace B', 'theorem same : True := by sorry', 'end B',
    ].join('\n'))).toThrow('formalization_declarations_ambiguous');
    expect(() => formalizationTargets('theorem first : True := by sorry; theorem second : True := by sorry'))
      .toThrow('formalization_unsupported_declaration');
  });

  it.each(['', 'def only : Nat := 0\n', source + '\0', source + '\ud800', source + ' '.repeat(128 * 1024)])(
    'rejects missing targets or malformed and oversized source', input => {
      expect(() => formalizationTargets(input)).toThrow(/^formalization_(?:source_invalid|targets_missing)$/u);
    });
});

describe('proof erasure for formalization snapshots', () => {
  it('checks every theorem while preserving complete definitions and string-valued data', () => {
    const input = [
      'namespace SourceContract',
      'def label : String := "-- by sorry; a  b /- literal -/"',
      'def zero : Nat := by\n  exact 0',
      'theorem first (n : Nat) : n = n := by sorry',
      '',
      'lemma second : zero = 0 := by\n  sorry',
      '',
      'end SourceContract',
      '',
    ].join('\n');
    const targets = formalizationTargets(input);
    expect(hasErasedFormalizationProofs(input)).toBe(true);
    expect(formalizationTargets(input)).toEqual(targets);
    expect(input).toContain('a  b');
    expect(input).toContain('def zero : Nat := by\n  exact 0');
    expect(hasErasedFormalizationProofs(input.replace('zero = 0 := by\n  sorry', 'zero = 0 := by\n  rfl'))).toBe(false);
    expect(hasErasedFormalizationProofs(input.replace('n = n := by sorry', 'n = n := by sorry\n  done'))).toBe(false);
    expect(hasErasedFormalizationProofs('/- a real comment -/\n' + input)).toBe(false);
  });

  it('removes all theorem proofs and comments while preserving definitions, strings, scopes and target identities', () => {
    const input = [
      'namespace Snapshot',
      '/-- Definition documentation mentions a candidate proof. -/',
      'def label : String := "-- retained text /- retained text -/"',
      'def marker : Nat := by\n  exact 0',
      '  /- A dedented block comment inside a proof must not end its region. -/',
      'theorem first (n : Nat) : n + 0 = n := by',
      '  have candidate := Nat.add_zero n',
      '/- proof-only comment with misleading theorem fake : False := by sorry -/',
      '  exact candidate',
      'lemma second : True := True.intro -- another proof',
      'end Snapshot',
      '',
    ].join('\n');
    const output = eraseFormalizationProofs(input);
    expect(output).toContain('def label : String := "-- retained text /- retained text -/"');
    expect(output).toContain('def marker : Nat := by\n  exact 0');
    expect(output).toContain('theorem first (n : Nat) : n + 0 = n := by sorry\n');
    expect(output).toContain('lemma second : True := by sorry\nend Snapshot');
    expect(output).not.toMatch(/documentation|candidate|True\.intro|another proof|misleading/u);
    expect(formalizationTargets(output)).toEqual(formalizationTargets(input));
    expect(eraseFormalizationProofs(output)).toBe(output);
  });

  it('erases equation-style proofs using an assignment separator', () => {
    const input = 'theorem pointwise : ∀ n : Nat, n = n\n  | n => rfl\n';
    const output = eraseFormalizationProofs(input);
    expect(output).toContain(':= by sorry');
    expect(output).not.toContain('| n =>');
    expect(formalizationTargets(output)).toEqual(formalizationTargets(input));
  });

  it('preserves indented scope commands and subsequent declarations outside a proof', () => {
    const input = [
      'namespace Outer',
      'theorem inner : True := True.intro',
      '  end Outer',
      'def outside : Nat := 42',
      'theorem outer : True := True.intro',
    ].join('\n');
    const output = eraseFormalizationProofs(input);
    expect(output).toContain('  end Outer\ndef outside : Nat := 42\n');
    expect(formalizationTargets(output).map(target => target.name)).toEqual(['Outer.inner', 'outer']);
    expect(formalizationTargets(output)).toEqual(formalizationTargets(input));
  });

  it('does not sanitize forbidden input into an apparently admitted snapshot', () => {
    expect(() => eraseFormalizationProofs('axiom hidden : False\n' + source)).toThrow('formalization_unsupported_declaration');
    expect(() => eraseFormalizationProofs('def unknown : Nat := by sorry\n' + source)).toThrow('formalization_placeholder_outside_proof');
  });
});
