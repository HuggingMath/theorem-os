import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mathGitBytes } from '../src/math/mathGit';
import { committedSource } from '../src/solver/problem';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawnSync: vi.fn(),
}));
const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');

describe('Git source failure diagnostics', () => {
  let directory: string;
  const failure = (call: () => unknown) => {
    try { call(); } catch (error) { return error as Error & { diagnostic: Record<string, unknown> }; }
    throw new Error('fixture_expected_git_failure');
  };
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset().mockImplementation(native.spawnSync);
  });
  afterEach(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

  it('keeps the source error classification while identifying a missing committed file', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'math-git-diagnostic-'));
    const git = (args: string[]) => {
      const result = native.spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git(['init', '--quiet']);
    fs.writeFileSync(path.join(directory, 'Source.lean'), 'theorem goal : True := by trivial\n');
    git(['add', 'Source.lean']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--no-gpg-sign', '--quiet', '-m', 'source']);
    const commit = git(['rev-parse', 'HEAD']);
    const error = failure(() => committedSource(directory, commit, 'missing.lean'));
    expect(error.message).toBe('math_task_source_unavailable');
    expect(error.diagnostic).toMatchObject({ command: 'show', commit, file: 'missing.lean',
      exitCode: 128, signal: null, stderr: expect.stringContaining('missing.lean') });
    expect(committedSource(directory, commit, 'Source.lean')).toBe('theorem goal : True := by trivial\n');
  });

  it.each([
    { signal: 'SIGTERM', code: undefined },
    { signal: 'SIGTERM', code: 'ETIMEDOUT' },
    { signal: 'SIGTERM', code: 'ENOBUFS' },
  ])('distinguishes interrupted source reads with %j', ({ signal, code }) => {
    const cause = code ? Object.assign(new Error('spawnSync git failed'), { code }) : undefined;
    vi.mocked(spawnSync).mockReturnValueOnce({ status: null, signal, error: cause,
      pid: 123, output: [], stdout: Buffer.from('private candidate bytes'), stderr: Buffer.from('read interrupted') } as any);
    const commit = 'a'.repeat(40);
    const error = failure(() => committedSource('/fixture/source', commit, 'generated/p/Submission.lean'));
    expect(error.message).toBe('math_task_source_unavailable');
    expect(error.diagnostic).toEqual({ command: 'show', commit, file: 'generated/p/Submission.lean',
      exitCode: null, signal, ...(code ? { code } : {}), stderr: 'read interrupted' });
    expect(JSON.stringify(error.diagnostic)).not.toContain('private candidate bytes');
    if (cause) expect(error.cause).toBe(cause);
  });

  it('bounds diagnostics for source stderr and does not copy candidate output', () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1, signal: null,
      pid: 123, output: [], stdout: Buffer.from('private output'), stderr: Buffer.from('e'.repeat(20_000)) } as any);
    const error = failure(() => committedSource('/fixture/source', 'b'.repeat(40), 'Submission.lean'));
    expect(Buffer.byteLength(String(error.diagnostic.stderr))).toBe(4096);
    expect(JSON.stringify(error.diagnostic)).not.toContain('private output');
  });

  it('does not copy arbitrary Git arguments or stderr into structured events', () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1, signal: null,
      pid: 123, output: [], stdout: Buffer.from('private output'), stderr: Buffer.from('private configuration value') } as any);
    const error = failure(() => mathGitBytes('/fixture/source', ['config', 'private.key', 'do-not-log'],
      { maxBuffer: 1024, errorMessage: 'math_git_failed:config' }));
    expect(error.message).toBe('math_git_failed:config');
    expect(error.diagnostic).toEqual({ command: 'config', exitCode: 1, signal: null });
    expect(JSON.stringify(error.diagnostic)).not.toMatch(/private|do-not-log/u);
  });
});
