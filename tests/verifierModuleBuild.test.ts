import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { checkManyFormalVerifications } from '../src/math/verifier';

// Opt-in: needs bwrap and the v4.35.0-rc3 toolchain under ~/.elan (no Mathlib).
const elan = path.join(os.homedir(), '.elan');
const enabled = process.env.DEEPSCIENTIST_TEST_LEAN_SANDBOX === '1';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const git = (root: string, args: string[]) => {
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args],
    { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) throw result.error ?? new Error(result.stderr);
  return result.stdout.trim();
};
const write = (root: string, files: Record<string, string>) => {
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '--no-gpg-sign', '-m', 'fixture']);
  return git(root, ['rev-parse', 'HEAD']);
};

it.skipIf(!enabled)('compiles local modules in isolated sandboxes once and restores them in a later batch', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-modules-')));
  roots.push(root);
  vi.stubEnv('DEEPSCIENTIST_CACHE_DIR', path.join(root, '.cache'));
  fs.writeFileSync(path.join(root, '.gitignore'), '.cache/\n.lake/\n');
  git(root, ['init', '--quiet']);
  const submission = (suffix: string) => `import Helper.B\ntheorem Submission.main : Helper.b = 4 := rfl\n${suffix}`;
  const env = { PATH: `${path.join(elan, 'bin')}:/usr/bin:/bin`, ELAN_HOME: elan, HOME: os.homedir() };
  const run = async (targetCommit: string) => {
    const result = await checkManyFormalVerifications({ projectRoot: root, targetCommit, timeoutMs: 120_000,
      items: [{ proofPath: 'Submission.lean', theoremName: 'Submission.main', statementHash: 'a'.repeat(64), claim: 'statement' }] },
    { env, prepareLocalDependencies: true });
    const notes = result.events.flatMap(event => event.kind === 'diagnostic.emitted' ? [event.payload.message] : []);
    return { status: result.results[0]?.status, error: result.results[0]?.error, modules: notes.find(note => note.startsWith('Local modules:')), notes };
  };
  const first = await run(write(root, {
    'lean-toolchain': 'leanprover/lean4:v4.35.0-rc3\n',
    'lakefile.toml': 'name = "fixture"\n\n[[lean_lib]]\nname = "Helper"\n',
    'Helper/A.lean': 'def Helper.a : Nat := 2\n',
    'Helper/B.lean': 'import Helper.A\ndef Helper.b : Nat := Helper.a + Helper.a\n',
    'Submission.lean': submission(''),
  }));
  expect(first, first.notes.join('\n')).toMatchObject({ status: 'kernel_verified', modules: 'Local modules: 2 compiled, 0 restored from the module cache.' });
  const second = await run(write(root, { 'Submission.lean': submission('-- revised\n') }));
  expect(second, second.notes.join('\n')).toMatchObject({ status: 'kernel_verified', modules: 'Local modules: 0 compiled, 2 restored from the module cache.' });
  const broken = await run(write(root, { 'Helper/B.lean': 'import Helper.A\ndef Helper.b : Nat := Helper.missing\n' }));
  expect(broken.status).toBe('failed');
  expect(broken.notes.join('\n')).toContain('Helper.missing');
}, 300_000);
