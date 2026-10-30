import { describe, expect, it } from 'vitest';
import { headingLine, leanOutline, writtenNames } from '../apps/web/client/leanOutline';

const source = `import Mathlib

/-- A doc comment that mentions theorem not_a_heading. -/
namespace Fixture

@[simp] theorem helper (n : Nat) : n + 0 = n := by
  simp

-- lemma commented_out : True := trivial
private lemma open_one : 1 = 1 := by
  sorry

noncomputable def choice : Nat := 0

instance : Inhabited Nat := ⟨0⟩
instance (priority := low) named : Inhabited Bool := ⟨true⟩

structure Point where
  x : Nat

theorem _root_.global_fact : True := by
  exact "sorry".length = 5 |> fun _ => trivial

end Fixture

class inductive Shape
  | dot

axiom trustMe : False
`;

describe('Lean declaration outline', () => {
  it('lists named declarations with their line, kind and namespace, skipping comments and unnamed instances', () => {
    const outline = leanOutline(source);
    expect(outline.map(({ line, kind, keyword, name, qualifiedName }) => [line, kind, keyword, name, qualifiedName])).toEqual([
      [6, 'theorem', 'theorem', 'helper', 'Fixture.helper'],
      [10, 'theorem', 'lemma', 'open_one', 'Fixture.open_one'],
      [13, 'definition', 'def', 'choice', 'Fixture.choice'],
      [16, 'instance', 'instance', 'named', 'Fixture.named'],
      [18, 'structure', 'structure', 'Point', 'Fixture.Point'],
      [21, 'theorem', 'theorem', '_root_.global_fact', 'global_fact'],
      [26, 'structure', 'class inductive', 'Shape', 'Shape'],
      [29, 'axiom', 'axiom', 'trustMe', 'trustMe'],
    ]);
  });

  it('marks a body that still has a placeholder, ignoring one inside a string or comment', () => {
    const open = leanOutline(source).filter(item => item.sorry).map(item => item.name);
    expect(open).toEqual(['open_one']);
    expect(leanOutline('theorem a : True := by\n  admit\ntheorem b : True := trivial -- sorry\n').map(item => item.sorry)).toEqual([true, false]);
  });

  it('finds a declaration by its full name or as written, and reads Windows line endings', () => {
    const outline = leanOutline(source.replace(/\n/gu, '\r\n'));
    expect(headingLine(outline, 'Fixture.helper')).toBe(6);
    expect(headingLine(outline, 'global_fact')).toBe(21);
    expect(headingLine(outline, 'Point')).toBe(18);
    expect(headingLine(outline, 'missing')).toBeUndefined();
  });

  it('writes a declaration the way the file does, keeping names it does not declare or declares twice in full', () => {
    const written = writtenNames(leanOutline(source));
    expect(['Fixture.helper', 'Fixture.Point', 'global_fact', 'trustMe', 'Nat.add_zero', 'propext'].map(written))
      .toEqual(['helper', 'Point', 'global_fact', 'trustMe', 'Nat.add_zero', 'propext']);
    const twice = writtenNames(leanOutline('namespace A\ntheorem same : True := trivial\nend A\nnamespace B\ntheorem same : True := trivial\nend B\n'));
    expect([twice('A.same'), twice('B.same')]).toEqual(['A.same', 'B.same']);
  });
});
