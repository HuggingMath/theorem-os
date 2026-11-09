import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { libraryDependencyLockDigest, resolveHostLibrary } from '../src/math/libraryHostConfig';
import { bootstrapLeanTask, readLeanTaskReceipt } from '../src/math/leanTask';
import { canonicalMathProblemStatementPayloads } from '../src/math/contracts';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { writeLibraryHostFixture } from './helpers/libraryHostFixture';
import { prepareWebProblem } from '../apps/web/formalizationSeed';
import { webDefaults } from '../apps/web/config';

describe('trusted host library configuration', () => {
  let root: string;
  const source = 'import Mathlib\ntheorem host_goal : True := by sorry\n', task = 'Prove the target';
  const taskId = `lean-task-${mathDigest(canonicalMathProblemStatementPayloads({ informalStatement: task,
    formalStatement: source, assumptions: [] }).lean).slice(0, 16)}`;
  const tasks = [{ taskId, selection: { mode: 'mapped' as const, exclusionKeys: ['FixtureTask'] } }];
  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-library-'))); });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
  function setup() {
    const fixture = writeLibraryHostFixture(root, tasks);
    vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', fixture.configPath);
    return { ...fixture, target: { toolchain: fixture.environment.toolchain,
      lakeManifest: fixture.environment.files['lake-manifest.json']!, runtimeEnvironmentDigest: fixture.environment.dependencyDigest } };
  }
  const bootstrap = () => bootstrapLeanTask(path.join(root, 'solver'), { source, task, environment: 'openai-math' });

  it('installs a filtered set through the shared ordinary entry and revalidates on resume', () => {
    const fixture = setup(), receipt = bootstrap();
    expect(Object.keys(receipt.libraryPack!.files)).toHaveLength(2);
    expect(receipt.libraryBinding!.hostConfiguration).toBeDefined();
    expect(readLeanTaskReceipt(receipt.activeProblemPath)).toEqual(receipt);
    fs.appendFileSync(fixture.configPath, ' ');
    expect(() => readLeanTaskReceipt(receipt.activeProblemPath)).toThrow(/binding_changed/);
  });
  it('uses the same policy at the ordinary Web handoff', () => {
    setup(); const directory = path.join(root, 'web'); fs.mkdirSync(directory);
    const seed = prepareWebProblem(directory, { input: { ...webDefaults, providerId: 'sub2api',
      apiKey: 'fixture-unused', source, task, environment: 'openai-math' } });
    const receipt = readLeanTaskReceipt(seed.activeProblemPath);
    expect(Object.keys(receipt.libraryPack!.files)).toHaveLength(2);
    expect(receipt.libraryBinding).toEqual(bootstrap().libraryBinding);
  });
  it('blocks the legacy held-out CLI flag before reading a pack or creating a workspace', () => {
    setup(); const workspace = path.join(root, 'cli-solver');
    const result = spawnSync('bun', ['bin/math.ts', 'bootstrap-lean-eval', '--repo', root, '--problem', 'p',
      '--workspace', workspace, '--library-pack', path.join(root, 'missing-pack.json')],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('library_host_sources_conflict');
    expect(fs.existsSync(workspace)).toBe(false);
  });
  it('rejects removal of configuration or receipt binding and cannot fall back to raw packs', () => {
    setup(); const receipt = bootstrap();
    const { libraryBinding: _binding, ...tampered } = receipt;
    fs.writeFileSync(receipt.activeProblemPath, JSON.stringify(tampered));
    expect(() => readLeanTaskReceipt(receipt.activeProblemPath)).toThrow(/identity_changed/);
    fs.writeFileSync(receipt.activeProblemPath, JSON.stringify(receipt));
    vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', undefined);
    expect(() => readLeanTaskReceipt(receipt.activeProblemPath)).toThrow(/binding_changed/);
    setup();
    expect(() => bootstrapLeanTask(path.join(root, 'other'), { source, task, environment: 'openai-math',
      libraryPack: {} as never })).toThrow(/sources_conflict/);
    expect(fs.existsSync(path.join(root, 'other'))).toBe(false);
  });
  it('requires an exact unique task and benchmark identity, including explicit unrestricted tasks', () => {
    const { config, configPath, target } = setup();
    expect(() => resolveHostLibrary({ taskId: 'unknown' }, target, path.join(root, 'solver'))).toThrow(/unmapped/);
    expect(() => resolveHostLibrary({ taskId, benchmarkCommit: '1'.repeat(40) }, target, path.join(root, 'solver'))).toThrow(/unmapped/);
    fs.writeFileSync(configPath, JSON.stringify({ ...config, tasks: [...tasks, ...tasks] }));
    expect(bootstrap).toThrow(/duplicate/);
    fs.writeFileSync(configPath, JSON.stringify({ ...config, tasks: [{ taskId, selection: { mode: 'unrestricted' } }] }));
    expect(Object.keys(bootstrap().libraryPack!.files)).toHaveLength(5);
  });
  it('rejects a changed non-mathlib dependency, duplicate package, path package, and unbound source lock', () => {
    const { config, target } = setup();
    const lock = JSON.parse(target.lakeManifest);
    lock.packages[0].rev = '0'.repeat(40);
    expect(() => resolveHostLibrary({ taskId }, { ...target, lakeManifest: JSON.stringify(lock) }, path.join(root, 'solver')))
      .toThrow(/dependency_mismatch/);
    lock.packages.push(lock.packages[0]);
    expect(() => libraryDependencyLockDigest(Buffer.from(JSON.stringify(lock)))).toThrow(/duplicate/);
    lock.packages.pop(); lock.packages[0].type = 'path';
    expect(() => libraryDependencyLockDigest(Buffer.from(JSON.stringify(lock)))).toThrow();
    fs.appendFileSync(config.sourceLakeManifest, ' ');
    expect(bootstrap).toThrow(/dependency_mismatch/);
  });
  it('ignores package ordering and root metadata, but compares URLs and config files', () => {
    const { target } = setup(); const lock = JSON.parse(target.lakeManifest);
    const digest = libraryDependencyLockDigest(Buffer.from(target.lakeManifest));
    lock.name = 'other_root'; lock.packages.reverse(); lock.packages[0].scope = '';
    expect(libraryDependencyLockDigest(Buffer.from(JSON.stringify(lock)))).toBe(digest);
    lock.packages[0].configFile = lock.packages[0].configFile === 'lakefile.lean' ? 'lakefile.toml' : 'lakefile.lean';
    expect(libraryDependencyLockDigest(Buffer.from(JSON.stringify(lock)))).not.toBe(digest);
  });
  it('rejects mutable solver-local paths, symlinks, duplicate keys, and wrong manifest pins', () => {
    const { config, configPath } = setup();
    expect(() => resolveHostLibrary({ taskId }, {} as never, root)).toThrow(/in_workspace/);
    const link = path.join(root, 'link.json'); fs.symlinkSync(configPath, link);
    vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', link); expect(bootstrap).toThrow();
    vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', configPath);
    fs.writeFileSync(configPath, JSON.stringify({ ...config, manifestSha256: '0'.repeat(64) }));
    expect(bootstrap).toThrow(/manifest_digest/);
    fs.writeFileSync(configPath, JSON.stringify(config).replace('{', '{"tasks":[],'));
    expect(bootstrap).toThrow(/duplicate_json_key/);
  });
});
