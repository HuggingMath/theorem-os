import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECLARATION_INDEX_FILE, MAX_DECLARATION_INDEX_TYPE_CHARS, ownedSourceDeclarations,
  writeOwnedDeclarationIndex } from '../src/solver/declarationIndex';
import { temporaryDirectory } from './helpers/files';

const helpers = [
  'import Mathlib.Tactic',
  'namespace Submission',
  '/-- A doc comment that mentions sorry. -/',
  'def double (n : Nat) : Nat := 2 * n',
  '',
  'theorem double_zero : double 0 = 0 := by',
  '  -- sorry in a comment does not count',
  '  simp [double]',
  '',
  'lemma pending (n : Nat) : double n = n + n := by',
  '  sorry',
  '',
  'theorem _root_.Outside.fact : True := trivial',
  'instance instInhabitedBox : Inhabited Nat := ⟨0⟩',
  'theorem text : "sorry".length = 5 := rfl',
  'end Submission',
  '',
].join('\n');

describe('owned declaration index', () => {
  let directory: string, worktree: string, project: string;
  const problem = { projectRelative: 'generated/p', ownedFiles: ['Submission.lean', 'Submission/Helpers.lean'] };
  const read = () => fs.readFileSync(path.join(worktree, DECLARATION_INDEX_FILE), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));

  beforeEach(() => {
    directory = temporaryDirectory('declaration-index-');
    worktree = path.join(directory, 'worktree'); project = path.join(worktree, 'generated', 'p');
    fs.mkdirSync(path.join(project, 'Submission'), { recursive: true });
    fs.writeFileSync(path.join(project, 'Submission.lean'), 'import Submission.Helpers\nnamespace Submission\ntheorem goal : True := by sorry\nend Submission\n');
    fs.writeFileSync(path.join(project, 'Submission', 'Helpers.lean'), helpers);
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('lists qualified names, kinds, lines and headers, and flags only a lexical sorry in a body', () => {
    expect(ownedSourceDeclarations('Submission/Helpers.lean', helpers)).toEqual([
      { name: 'Submission.double', kind: 'definition', file: 'Submission/Helpers.lean', line: 4, sorry: false, type: 'double (n : Nat) : Nat' },
      { name: 'Submission.double_zero', kind: 'theorem', file: 'Submission/Helpers.lean', line: 6, sorry: false, type: 'double_zero : double 0 = 0' },
      { name: 'Submission.pending', kind: 'theorem', file: 'Submission/Helpers.lean', line: 10, sorry: true, type: 'pending (n : Nat) : double n = n + n' },
      { name: 'Outside.fact', kind: 'theorem', file: 'Submission/Helpers.lean', line: 13, sorry: false, type: '_root_.Outside.fact : True' },
      { name: 'Submission.instInhabitedBox', kind: 'instance', file: 'Submission/Helpers.lean', line: 14, sorry: false, type: 'instInhabitedBox : Inhabited Nat' },
      { name: 'Submission.text', kind: 'theorem', file: 'Submission/Helpers.lean', line: 15, sorry: false, type: 'text : "sorry".length = 5' },
    ]);
  });

  it('truncates a long header without splitting a surrogate pair', () => {
    const name = 'long : ';
    const source = `theorem long : ${'a'.repeat(MAX_DECLARATION_INDEX_TYPE_CHARS - name.length - 1)}𝓝 = 𝓝 := rfl\n`;
    const [declaration] = ownedSourceDeclarations('Submission.lean', source);
    expect(declaration).toMatchObject({ name: 'long', truncated: true });
    expect(declaration!.type).toHaveLength(MAX_DECLARATION_INDEX_TYPE_CHARS - 1);
    expect(declaration!.type.endsWith('a')).toBe(true);
    expect(ownedSourceDeclarations('Submission.lean', 'theorem short : True := trivial\n')[0]).not.toHaveProperty('truncated');
  });

  it('writes one line per owned declaration, refreshes on change and lists files it would not read', () => {
    expect(writeOwnedDeclarationIndex(problem, worktree)).toMatchObject({ declarations: 7 });
    const first = read();
    expect(first.map(entry => [entry.file, entry.name])).toEqual([['Submission.lean', 'Submission.goal'],
      ...['double', 'double_zero', 'pending'].map(name => ['Submission/Helpers.lean', `Submission.${name}`]),
      ['Submission/Helpers.lean', 'Outside.fact'], ['Submission/Helpers.lean', 'Submission.instInhabitedBox'],
      ['Submission/Helpers.lean', 'Submission.text']]);
    expect(first[0]).toMatchObject({ sorry: true, line: 3 });

    fs.writeFileSync(path.join(project, 'Submission.lean'), 'namespace Submission\ntheorem goal : True := trivial\nend Submission\n');
    // A linked owned file could name protected material outside the worktree; it is not read.
    fs.writeFileSync(path.join(directory, 'Outside.lean'), 'theorem secret : True := trivial\n');
    fs.symlinkSync(path.join(directory, 'Outside.lean'), path.join(project, 'Linked.lean'));
    const linked = { ...problem, ownedFiles: [...problem.ownedFiles, 'Linked.lean', 'Missing.lean'] };
    expect(writeOwnedDeclarationIndex(linked, worktree)).toMatchObject({ declarations: 7 });
    const next = read();
    expect(next[0]).toMatchObject({ name: 'Submission.goal', sorry: false, line: 2 });
    expect(next.at(-1)).toEqual({ omitted: { declarations: 0, unreadableFiles: ['Linked.lean', 'Missing.lean'] } });
    expect(JSON.stringify(next)).not.toContain('secret');
  });
});
