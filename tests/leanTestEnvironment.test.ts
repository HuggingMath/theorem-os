import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newestLeanBinary } from './helpers/lean';

describe('native Lean regression prerequisites', () => {
  let directory: string;
  const install = (version: string) => {
    const executable = path.join(directory, '.elan', 'toolchains', `leanprover--lean4---v${version}`, 'bin', 'lean');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, 'fixture executable');
    return executable;
  };
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-test-environment-'));
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    vi.stubEnv('THEOREMOS_TEST_LEAN_VERSION', '');
    vi.stubEnv('THEOREMOS_TEST_REQUIRE_LEAN', '');
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('checks the selected supported release even when a newer release candidate is installed', () => {
    const expected = install('4.33.0'); install('4.35.0-rc3');
    vi.stubEnv('THEOREMOS_TEST_LEAN_VERSION', '4.33.0');
    expect(newestLeanBinary()).toBe(expected);
  });

  it('fails a requested toolchain instead of silently testing another version', () => {
    install('4.35.0-rc3');
    vi.stubEnv('THEOREMOS_TEST_LEAN_VERSION', '4.34.1');
    expect(() => newestLeanBinary()).toThrow('Lean 4.34.1 is required');
  });

  it('fails required native checks instead of silently skipping them', () => {
    vi.stubEnv('THEOREMOS_TEST_REQUIRE_LEAN', '1');
    expect(() => newestLeanBinary()).toThrow('Lean is required');
  });

  it('allows optional local native checks to skip when Lean is absent', () => {
    expect(newestLeanBinary()).toBeUndefined();
  });

  it('otherwise orders installed releases and release candidates by version', () => {
    install('4.8.0'); install('4.34.1-rc2');
    const expected = install('4.34.1'); install('4.33.0');
    expect(newestLeanBinary()).toBe(expected);
  });
});
