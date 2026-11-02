import { describe, expect, it } from 'vitest';
import { leanTheoremTypeLookup } from '../apps/web/client/leanTheoremType';

describe('frozen theorem signature lookup', () => {
  it('retains multiline parameters, defaults, strings and comments without reading them as the proof boundary', () => {
    const signature = '(n : Nat := 0) (label : String := ":=") :\n  -- := is part of a comment\n  n = n /- nested /- := -/ comment -/';
    const read = leanTheoremTypeLookup(`namespace Outer\nsection\nnamespace Inner\nprivate lemma same ${signature} := by\n  rfl\nend Inner\nend\nend Outer\n`);
    expect(read('Outer.Inner.same')).toBe(signature);
    expect(read('same')).toBe(signature);
    expect(read('Outer.same')).toBeUndefined();
  });

  it('matches exact complete names, root escapes and quoted names with Windows line endings', () => {
    const source = 'namespace A\nlemma same : True := by trivial\ntheorem _root_.global (n : Nat) : n = n := by rfl\nlemma «quoted name» : True := by trivial\nend A\nnamespace B\nlemma same : False := by sorry\nend B\n';
    const read = leanTheoremTypeLookup(source.replace(/\n/gu, '\r\n'));
    expect(read('A.same')).toBe(': True');
    expect(read('B.same')).toBe(': False');
    expect(read('same')).toBeUndefined();
    expect(read('global')).toBe('(n : Nat) : n = n');
    expect(read('_root_.global')).toBe('(n : Nat) : n = n');
    expect(read('A.«quoted name»')).toBe(': True');
  });

  it('leaves absent, duplicate and unfinished declarations unknown instead of borrowing another declaration body', () => {
    const read = leanTheoremTypeLookup('namespace A\ntheorem duplicate : True := by trivial\ntheorem duplicate : False := by sorry\ntheorem unfinished : Nat\nend A\ndef other := 3\ntheorem valid : True := by trivial\n');
    for (const name of ['missing', 'other', 'duplicate', 'A.duplicate', 'A.unfinished']) expect(read(name)).toBeUndefined();
    expect(read('valid')).toBe(': True');
  });
});
