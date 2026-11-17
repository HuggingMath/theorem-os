import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { DEFAULT_TACTIC_BATTERY_FAILURE_CACHE_ROOT, openTacticBatteryFailureCache,
  prepareTacticBatteryFailureCacheRoot } from '../src/solver/tacticBatteryFailureCache';
import { tacticBatteryCacheTestDefines } from './helpers/tacticBatteryCache';

declare module 'vitest' {
  export interface ProvidedContext { theoremosTestCacheRoot: string }
}

describe('test-only host tactic cache isolation', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('uses the disposable Vitest directory for default preparation and signed records', () => {
    const expected = path.join(inject('theoremosTestCacheRoot'), 'tactic-battery');
    expect(DEFAULT_TACTIC_BATTERY_FAILURE_CACHE_ROOT).toBe(expected);
    expect(prepareTacticBatteryFailureCacheRoot()).toBe(expected);
    const cache = openTacticBatteryFailureCache(), key = '8'.repeat(64), diagnostic = '9'.repeat(64);
    cache.remember(key, diagnostic);
    expect(cache.read(key)?.diagnosticDigest).toBe(diagnostic);
    expect(fs.statSync(path.join(expected, 'key')).mode & 0o777).toBe(0o600);
  });

  it('isolates frozen child processes while production defaults ignore inherited cache variables', () => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(inject('theoremosTestCacheRoot'), 'bundle-')));
    const isolated = path.join(directory, 'fixture-cache'), redirected = path.join(directory, 'environment-cache');
    const testBundle = path.join(directory, 'fixture.cjs'), productionBundle = path.join(directory, 'production.cjs');
    const options = { entryPoints: [path.resolve('src/solver/tacticBatteryFailureCache.ts')], bundle: true,
      platform: 'node' as const, format: 'cjs' as const, logLevel: 'silent' as const,
      loader: { '.py': 'text' as const, '.lean': 'text' as const } };
    buildSync({ ...options, outfile: testBundle, define: tacticBatteryCacheTestDefines(isolated) });
    buildSync({ ...options, outfile: productionBundle });
    const env = { ...process.env, __THEOREMOS_TEST_TACTIC_BATTERY_CACHE_ROOT__: redirected,
      THEOREMOS_TEST_TACTIC_BATTERY_CACHE_ROOT: redirected, THEOREMOS_TACTIC_BATTERY_CACHE_ROOT: redirected,
      DEEPSCIENTIST_TACTIC_BATTERY_FAILURE_CACHE_ROOT: redirected };
    const code = `const cache = require(process.argv[1]);
      if (process.argv[2] === 'write') {
        const key = 'a'.repeat(64); cache.openTacticBatteryFailureCache().remember(key, 'b'.repeat(64));
        if (!cache.openTacticBatteryFailureCache().read(key)) throw new Error('missing signed record');
      }
      process.stdout.write(cache.DEFAULT_TACTIC_BATTERY_FAILURE_CACHE_ROOT);`;
    const child = spawnSync(process.execPath, ['-e', code, testBundle, 'write'], { env, encoding: 'utf8', timeout: 10_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(isolated);
    expect(fs.existsSync(path.join(isolated, 'key'))).toBe(true);
    const production = spawnSync(process.execPath, ['-e', code, productionBundle], { env, encoding: 'utf8', timeout: 10_000 });
    expect(production.status, production.stderr).toBe(0);
    expect(production.stdout).toBe(`/var/tmp/theoremos-tactic-battery-${process.getuid?.() ?? production.pid}`);
    expect(fs.existsSync(redirected)).toBe(false);
  });
});
