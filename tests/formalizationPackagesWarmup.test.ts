import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT } from '../src/math/mathProofEnvironmentCache';
import { warmFormalizationPackages } from '../src/runtime/formalizationSandbox';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), cache: vi.fn(), prepare: vi.fn(), dispose: vi.fn() }));
vi.mock('../src/math/verifier', () => ({ resolveMathematicsLakePackagesCache: mocks.cache }));
vi.mock('../src/math/mathProofEnvironment', async original => ({
  ...await original<typeof import('../src/math/mathProofEnvironment')>(),
  resolveMathProofEnvironment: mocks.resolve, prepareMathProofEnvironment: mocks.prepare,
}));

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.cache.mockReturnValue('/authorized/mathlib/packages');
  mocks.dispose.mockResolvedValue(undefined);
  mocks.prepare.mockResolvedValue({ environmentValue: 'host-only-descriptor', dispose: mocks.dispose });
});
afterEach(() => vi.restoreAllMocks());

describe('formalization package cache warmup', () => {
  const env = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS: '/authorized/mathlib/packages' };
  const probe = () => mocks.resolve.mock.calls[0]![0] as string;

  it('does no dependency work for a standard-library environment', async () => {
    await warmFormalizationPackages('standard', { env });
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.cache).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('warms the exact pinned configuration without credentials and disposes its mount before removing the probe', async () => {
    const config = getLeanTaskEnvironment('mathlib'), controller = new AbortController(), deadlineAt = Date.now() + 30_000;
    mocks.prepare.mockImplementation(async (project, root, options) => {
      expect(root).toBe(env.DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS);
      expect(fs.statSync(project).mode & 0o777).toBe(0o700);
      for (const [name, text] of Object.entries(config.files)) {
        expect(fs.readFileSync(path.join(project, name), 'utf8')).toBe(text);
        expect(fs.statSync(path.join(project, name)).mode & 0o777).toBe(0o400);
      }
      expect(fs.readdirSync(project).sort()).toEqual(Object.keys(config.files).sort());
      expect(options).toMatchObject({ signal: controller.signal, deadlineAt,
        cacheRoot: DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT });
      expect(options.env).toMatchObject(env);
      expect(JSON.stringify(options.env)).not.toMatch(/PRIVATE_PROVIDER_KEY|HOST_PRIVATE_CANARY/);
      return { environmentValue: 'host-only-descriptor', dispose: mocks.dispose };
    });
    mocks.dispose.mockImplementation(async () => { expect(fs.existsSync(probe())).toBe(true); });
    await expect(warmFormalizationPackages('mathlib', { env: { ...env,
      SUB2API_WESTLAKE_API_KEY: 'PRIVATE_PROVIDER_KEY', THEOREMOS_PROVIDER_API_KEY: 'PRIVATE_PROVIDER_KEY',
      HOST_PRIVATE_CANARY: 'HOST_PRIVATE_CANARY' }, signal: controller.signal, deadlineAt })).resolves.toBeUndefined();
    expect(mocks.prepare).toHaveBeenCalledOnce(); expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(fs.existsSync(probe())).toBe(false);
  });

  it('uses an existing verified environment without preparing or disposing its owner', async () => {
    mocks.resolve.mockReturnValue({ packagesRoot: '/already-sealed', identity: 'a'.repeat(64), verify: vi.fn() });
    await warmFormalizationPackages('mathlib', { env });
    expect(mocks.cache).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.dispose).not.toHaveBeenCalled(); expect(fs.existsSync(probe())).toBe(false);
  });

  it('removes its probe when no authorized package source is available', async () => {
    mocks.cache.mockReturnValue(undefined);
    await expect(warmFormalizationPackages('mathlib', { env })).rejects.toThrow('formalization_sandbox_pinned_mathlib_unavailable');
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(fs.existsSync(probe())).toBe(false);
  });

  it.each(['failure', 'cancellation'] as const)('removes its probe after preparation %s', async mode => {
    const controller = new AbortController(), failure = new Error('preparation failed');
    mocks.prepare.mockImplementation(async (_project, _root, options) => {
      if (mode === 'cancellation') { controller.abort(); options.signal.throwIfAborted(); }
      throw failure;
    });
    const result = warmFormalizationPackages('mathlib', { env, signal: controller.signal });
    await expect(result).rejects.toThrow(mode === 'cancellation' ? 'aborted' : failure.message);
    expect(mocks.dispose).not.toHaveBeenCalled(); expect(fs.existsSync(probe())).toBe(false);
  });

  it('disposes a completed preparation if the owner is cancelled before it returns', async () => {
    const controller = new AbortController();
    mocks.prepare.mockImplementation(async () => {
      controller.abort();
      return { environmentValue: 'host-only-descriptor', dispose: mocks.dispose };
    });
    await expect(warmFormalizationPackages('mathlib', { env, signal: controller.signal })).rejects.toThrow('aborted');
    expect(mocks.dispose).toHaveBeenCalledOnce(); expect(fs.existsSync(probe())).toBe(false);
  });

  it.each(['cancelled', 'expired'] as const)('rejects a %s owner before creating a probe', async mode => {
    const controller = new AbortController();
    if (mode === 'cancelled') controller.abort();
    const temporary = vi.spyOn(fs, 'mkdtempSync');
    await expect(warmFormalizationPackages('mathlib', { env, signal: controller.signal,
      ...(mode === 'expired' ? { deadlineAt: Date.now() - 1 } : {}) })).rejects.toThrow();
    expect(temporary).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('removes its probe even if the completed preparation fails to dispose', async () => {
    mocks.dispose.mockRejectedValue(new Error('disposal failed'));
    await expect(warmFormalizationPackages('mathlib', { env })).rejects.toThrow('disposal failed');
    expect(mocks.dispose).toHaveBeenCalledOnce(); expect(fs.existsSync(probe())).toBe(false);
  });
});
