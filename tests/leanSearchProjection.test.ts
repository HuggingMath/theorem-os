import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { leanSearchPrefix, prepareLeanSearchProjection, prepareRetainedLeanSearchProjection } from '../src/math/leanSearchProjection';
import { mathDigest } from '../src/math/mathRuntimeIo';

const host = vi.hoisted(() => ({ resolve: vi.fn(), identity: vi.fn(), compile: vi.fn() }));
vi.mock('../src/math/mathProofEnvironment', async original => ({
  ...await original<typeof import('../src/math/mathProofEnvironment')>(), resolveMathProofEnvironment: host.resolve,
}));
vi.mock('../src/math/leanResidualGoals', async original => ({
  ...await original<typeof import('../src/math/leanResidualGoals')>(), leanDiagnosticEnvironmentIdentity: host.identity,
}));
vi.mock('../src/math/leanDiagnostics', async original => ({
  ...await original<typeof import('../src/math/leanDiagnostics')>(), runLeanDiagnostics: host.compile,
}));

describe('proof search source prefix', () => {
  it('keeps real preceding declarations and literal comment markers while removing the target and downstream code', () => {
    const before = 'import Mathlib\n/-- Documentation for the real definition. -/\ndef marker : String := "/-- a  b"\n' +
      'theorem previous : True := by trivial';
    const type = 'marker = "/-- a  b"';
    const source = `${before}\n/-- Pending target documentation /- with nested notes -/ -/\n` +
      `-- final note\ntheorem target : ${type} := by sorry\ntheorem downstream : False := by sorry\n`;
    expect(leanSearchPrefix(source, 'target', type)).toBe(before + '\nset_option autoImplicit false\n');
  });

  it('keeps strings with escaped quotes, backslashes and comment-looking text unchanged', () => {
    const before = String.raw`def marker : String := "literal \" /-- \\ -- /- data -/"`;
    const source = `${before}\ntheorem target : True := by trivial\n`;
    expect(leanSearchPrefix(source, 'target', 'True')).toBe(before + '\nset_option autoImplicit false\n');
  });

  it('rejects task types with different string contents instead of collapsing literal whitespace', () => {
    const type = '"a  b" = "a  b"';
    const source = `theorem target : ${type} := by rfl\n`;
    expect(leanSearchPrefix(source, 'target', type)).toBe('\nset_option autoImplicit false\n');
    expect(() => leanSearchPrefix(source, 'target', '"a b" = "a b"'))
      .toThrow('proof_search_unsupported_nonclosed_header');
  });

  it('requires exact internal type text, including quoted identifiers and layout, while trimming outer whitespace', () => {
    const type = '∀ (x : Nat),\n  x = x';
    const source = `theorem target : ${type} := by intro x; rfl\n`;
    expect(() => leanSearchPrefix(source, 'target', `\n ${type}\n`)).not.toThrow();
    expect(() => leanSearchPrefix(source, 'target', '∀ (x : Nat), x = x'))
      .toThrow('proof_search_unsupported_nonclosed_header');
    const named = '«a  b» = «a  b»', namedSource = `theorem target : ${named} := by rfl\n`;
    expect(() => leanSearchPrefix(namedSource, 'target', '«a b» = «a b»'))
      .toThrow('proof_search_unsupported_nonclosed_header');
  });

  it('preserves namespace, lookup and universe commands for the inherited frontend scope', () => {
    const before = 'import Mathlib\nnamespace Example\nuniverse u\nopen Nat';
    const type = '∀ (α : Type u), α → α';
    const source = `${before}\ntheorem target : ${type} := by intro α a; exact a\nend Example\n`;
    expect(leanSearchPrefix(source, 'Example.target', type)).toBe(before + '\nset_option autoImplicit false\n');
  });

  it.each([
    ['binders in the declaration header', 'theorem target (x : Nat) : x = x := by rfl\n', '∀ (x : Nat), x = x'],
    ['local variables', 'variable (P : Prop)\ntheorem target : P → P := by intro h; exact h\n', 'P → P'],
    ['pending attribute', '@[simp]\ntheorem target : True := by trivial\n', 'True'],
    ['pending command scope', 'set_option maxRecDepth 100 in\ntheorem target : True := by trivial\n', 'True'],
  ])('rejects unsupported %s', (_label, source, type) => {
    expect(() => leanSearchPrefix(source, 'target', type)).toThrow(/proof_search_unsupported/u);
  });
});

describe('retained proof search projection', () => {
  let directory: string, project: string, packages: string, sources: Record<string, string>;
  let projections: ReturnType<typeof prepareLeanSearchProjection>[];
  const input = () => ({ projectRoot: project, file: 'Submission.lean', theoremName: 'Current.target', type: 'True', env: {} });
  const snapshots = () => Object.entries(sources).map(([file, source]) => ({ file, source }));
  const replayRoot = () => path.join(project, '.lake/proof-search-replay');
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-search-projection-'));
    project = path.join(directory, 'project'); packages = path.join(directory, 'sealed-packages');
    fs.mkdirSync(project); fs.mkdirSync(path.join(packages, 'mathlib'), { recursive: true });
    sources = {
      'Submission.lean': 'import Shared\nnamespace Current\ntheorem target : True := by sorry\nend Current\n',
      'Shared.lean': 'theorem support : True := by trivial\n',
      'lean-toolchain': 'leanprover/lean4:v4.33.1\n',
      'lakefile.toml': 'name = "fixture"\n[[lean_lib]]\nname = "Fixture"\n',
      'lake-manifest.json': JSON.stringify({ packages: [{ name: 'mathlib', type: 'git', url: 'fixture', rev: 'fixed' }] }),
      '.lake/package-overrides.json': JSON.stringify({ packages: [{ name: 'mathlib', type: 'path', dir: '/owner/project/.lake/packages/mathlib' }] }),
    };
    for (const [file, source] of Object.entries(sources)) {
      fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true }); fs.writeFileSync(path.join(project, file), source);
    }
    projections = [];
    host.identity.mockReset().mockReturnValue({ environmentDigest: mathDigest('sealed-environment'), toolIdentity: mathDigest('tools') });
    host.compile.mockReset().mockImplementation(() => { throw new Error('Lean must not run in projection tests'); });
    host.resolve.mockReset().mockImplementation((root: string) => {
      const verify = () => {
        for (const file of ['lean-toolchain', 'lakefile.toml', 'lake-manifest.json'])
          if (fs.readFileSync(path.join(root, file), 'utf8') !== sources[file]) throw new Error('fixture_configuration_changed');
      };
      verify(); return { packagesRoot: packages, identity: mathDigest('sealed-packages'), verify };
    });
  });
  afterEach(() => {
    for (const projection of projections) projection.dispose();
    expect(host.compile).not.toHaveBeenCalled();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('replays the exact saved input after the owner source changed without editing the current files', () => {
    const saved = prepareLeanSearchProjection(input()); projections.push(saved); saved.dispose();
    const changed = 'theorem another : False := by sorry\n';
    fs.writeFileSync(path.join(project, 'Submission.lean'), changed);
    fs.writeFileSync(path.join(project, 'Shared.lean'), 'theorem changed : True := by trivial\n');
    const replay = prepareRetainedLeanSearchProjection({ ...input(), sources: saved.replaySources }); projections.push(replay);
    expect(replay.sourceFiles).toEqual(saved.sourceFiles);
    expect(replay.sourceDigest).toBe(saved.sourceDigest); expect(replay.projectionDigest).toBe(saved.projectionDigest);
    expect(replay.replaySources).toEqual(saved.replaySources);
    expect(replay.replaySources.find(item => item.file === 'Submission.lean')!.source).toBe(sources['Submission.lean']);
    expect(fs.readFileSync(path.join(project, 'Submission.lean'), 'utf8')).toBe(changed);
    expect(replay.verify).not.toThrow();
    const outer = path.join(replayRoot(), fs.readdirSync(replayRoot())[0]);
    expect(fs.readFileSync(path.join(outer, 'project/.lake/package-overrides.json'), 'utf8'))
      .toBe(sources['.lake/package-overrides.json']);
    const overrides = JSON.parse(fs.readFileSync(path.join(replay.project, '.lake/package-overrides.json'), 'utf8'));
    expect(overrides.packages[0].dir).toBe(path.join(replay.project, '.lake/packages/mathlib'));
    expect(fs.realpathSync(path.join(replay.project, '.lake/packages'))).toBe(packages);
    replay.dispose(); expect(fs.existsSync(outer)).toBe(false); expect(fs.existsSync(replay.project)).toBe(false);
  });

  it('still detects changes to live search inputs and retained replay inputs', () => {
    const live = prepareLeanSearchProjection(input()); projections.push(live);
    fs.appendFileSync(path.join(project, 'Shared.lean'), '\n');
    expect(live.verify).toThrow('proof_search_stale_source');
    const replay = prepareRetainedLeanSearchProjection({ ...input(), sources: live.replaySources }); projections.push(replay);
    const outer = path.join(replayRoot(), fs.readdirSync(replayRoot())[0], 'project');
    fs.appendFileSync(path.join(outer, 'Shared.lean'), '\n');
    expect(replay.verify).toThrow('proof_search_stale_source');
  });

  it('binds replay to the current sealed environment even when its retained inputs remain intact', () => {
    const replay = prepareRetainedLeanSearchProjection({ ...input(), sources: snapshots() }); projections.push(replay);
    fs.writeFileSync(path.join(project, 'lean-toolchain'), 'another-toolchain\n');
    expect(replay.verify).toThrow('fixture_configuration_changed');
  });

  it('rejects a different assigned target and cleans its replay directory', () => {
    expect(() => prepareRetainedLeanSearchProjection({ ...input(), type: 'False', sources: snapshots() }))
      .toThrow('proof_search_unsupported_nonclosed_header');
    expect(fs.readdirSync(replayRoot())).toEqual([]);
    expect(fs.readFileSync(path.join(project, 'Submission.lean'), 'utf8')).toBe(sources['Submission.lean']);
  });

  it('rejects extra sources outside the recomputed import closure and removes both clones', () => {
    expect(() => prepareRetainedLeanSearchProjection({ ...input(), sources: [...snapshots(),
      { file: 'Unused.lean', source: 'theorem unused : True := by trivial\n' }] }))
      .toThrow('proof_search_retained_sources_not_closed');
    expect(fs.readdirSync(replayRoot())).toEqual([]);
  });

  it.each(['../Escape.lean', '/Escape.lean', 'C:/Escape.lean', './Shared.lean', 'A//B.lean', 'A\\B.lean',
    'payload.txt', '.lake/packages/Injected.lean', '.git/Hook.lean'])(
    'rejects the forbidden retained path %s before creating scratch files', file => {
      expect(() => prepareRetainedLeanSearchProjection({ ...input(), sources: [...snapshots(), { file, source: '' }] }))
        .toThrow('proof_search_retained_sources_invalid');
      expect(fs.existsSync(replayRoot())).toBe(false);
    });

  it('rejects duplicate files and bounds both source count and UTF-8 bytes', () => {
    const retained = snapshots();
    expect(() => prepareRetainedLeanSearchProjection({ ...input(), sources: [...retained, retained[0]] }))
      .toThrow('proof_search_retained_sources_invalid');
    expect(() => prepareRetainedLeanSearchProjection({ ...input(), sources: Array(4097).fill(retained[0]) }))
      .toThrow('proof_search_retained_sources_limit');
    expect(() => prepareRetainedLeanSearchProjection({ ...input(), sources: [{ file: 'Submission.lean', source: '∀'.repeat(666667) }] }))
      .toThrow('proof_search_retained_sources_limit');
    expect(fs.existsSync(replayRoot())).toBe(false);
  });

  it('requires a sealed environment and refuses a linked replay directory', () => {
    host.resolve.mockReturnValueOnce(undefined);
    expect(() => prepareRetainedLeanSearchProjection({ ...input(), sources: snapshots() }))
      .toThrow('proof_search_retained_environment_unsealed');
    expect(fs.existsSync(replayRoot())).toBe(false);
    const outside = path.join(directory, 'unrelated'); fs.mkdirSync(outside); fs.symlinkSync(outside, replayRoot());
    expect(() => prepareRetainedLeanSearchProjection({ ...input(), sources: snapshots() })).toThrow('math_path_invalid');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
