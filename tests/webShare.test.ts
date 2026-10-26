import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shareSnapshot, webShareToken } from '../apps/web/share';
import type { WebRun } from '../apps/web/shared';
import { WebStorage } from '../apps/web/storage';

const run = (overrides: Partial<WebRun> = {}): WebRun => ({ id: '11111111-2222-4333-8444-555555555555', title: 'Shared identity',
  status: 'completed', phase: 'evaluation_finished', createdAt: '2026-10-26T01:00:00.000Z', updatedAt: '2026-10-26T01:05:00.000Z',
  finishedAt: '2026-10-26T01:05:00.000Z', providerId: 'private-provider', model: 'gpt-6.1-sol', effort: 'xhigh', environment: 'mathlib',
  source: 'theorem identity : True := by sorry', task: 'Prove identity', maxTurns: 4, maxRunSeconds: 600, workers: 2,
  coordination: 'cooperative', events: [{ sequence: 1, at: '2026-10-26T01:00:00.000Z', type: 'queued', message: 'private event' }],
  error: 'private error text',
  result: { status: 'evaluated_passed', proof: 'theorem identity : True := trivial', report: {
    runId: 'solver-internal-run', problemId: 'internal-problem', solution_commit: 'a'.repeat(40), turns: 3, solveWallMs: 42_000,
    usage: { totalTokens: 12_345 }, reason: 'private reason /home/someone/run',
    environment: { toolchain: 'leanprover/lean4:v4.33.0', mathlibRevision: 'b'.repeat(40), dependencyDigest: 'c'.repeat(64) },
    candidateCheck: { passed: true, results: [{ theoremName: 'identity', status: 'kernel_verified', sorryCount: 0,
      stderrPreview: '/home/someone/private/path.lean:1: warning' }] },
    evaluator: { status: 'passed', method: 'host-lean-kernel-all-targets', reason: 'private evaluator reason',
      verification: { commit: 'd'.repeat(40), sourceDigest: 'e'.repeat(64),
        verification: { results: [{ theoremName: 'identity', status: 'kernel_verified', error: 'private diagnostic' }] } } },
  } }, ...overrides });

describe('web share snapshots', () => {
  let root: string | undefined;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });

  it('shares only accepted runs with a proof', () => {
    expect(shareSnapshot(run())).toBeDefined();
    expect(shareSnapshot(run({ status: 'error' }))).toBeUndefined();
    expect(shareSnapshot(run({ result: { status: 'evaluated_failed', proof: 'x', report: {} } }))).toBeUndefined();
    expect(shareSnapshot(run({ result: { status: 'evaluated_passed', proof: '', report: {} } }))).toBeUndefined();
  });

  it('keeps outcomes and reproducibility pins but drops diagnostics, internal identifiers and private fields', () => {
    const snapshot = shareSnapshot(run(), '2026-10-26T02:00:00.000Z')!;
    expect(snapshot).toMatchObject({ schema: 'theorem-os.web-share.v1', title: 'Shared identity', task: 'Prove identity',
      proof: 'theorem identity : True := trivial', model: 'gpt-6.1-sol', workers: 2, sharedAt: '2026-10-26T02:00:00.000Z' });
    expect(snapshot.checks.map(check => check.label)).toEqual(['候选检查', '独立验收']);
    expect(snapshot.checks[1]).toMatchObject({ status: '验收阶段通过', method: 'Lean 内核 · 全部目标',
      targets: [{ name: 'identity', status: 'Lean 内核通过', tone: 'passed' }] });
    expect(snapshot.identity.map(item => item.label)).toEqual(['验收源码摘要', 'Lean 工具链', '依赖摘要', 'Mathlib 版本']);
    expect(snapshot.metrics).toContainEqual({ label: '总 Token', value: '12345' });
    const text = JSON.stringify(snapshot);
    for (const secret of ['private', '/home/someone', 'solver-internal-run', 'internal-problem', 'a'.repeat(40), 'd'.repeat(40)])
      expect(text).not.toContain(secret);
    expect(Object.keys(snapshot)).not.toEqual(expect.arrayContaining(['providerId', 'events', 'error', 'id']));
  });

  it('resolves a token only while the run-side record exists and removes the index with the run or owner', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-web-share-'));
    const storage = new WebStorage(root), owner = 'account:share-owner', value = run();
    storage.saveRun(owner, value);
    const token = 'A'.repeat(32), share = { token, createdAt: '2026-10-26T02:00:00.000Z', snapshot: shareSnapshot(value)! };
    expect(webShareToken.test(token)).toBe(true);
    storage.saveShare(owner, value.id, share);
    expect(new WebStorage(root).getShare(token)).toEqual(share);
    expect(storage.getShare('B'.repeat(32))).toBeUndefined();
    const index = path.join(root, 'shares');
    expect(fs.readdirSync(index)).toHaveLength(1);
    // The index never stores the owner itself, which is a session secret for anonymous visitors.
    expect(fs.readFileSync(path.join(index, fs.readdirSync(index)[0]!), 'utf8')).not.toContain(owner);

    storage.deleteShare(owner, value.id);
    expect(storage.getShare(token)).toBeUndefined();
    expect(fs.readdirSync(index)).toHaveLength(0);

    storage.saveShare(owner, value.id, share);
    storage.deleteRun(owner, value.id);
    expect(storage.getShare(token)).toBeUndefined();
    expect(fs.readdirSync(index)).toHaveLength(0);

    storage.saveRun(owner, value);
    storage.saveShare(owner, value.id, share);
    storage.deleteOwner(owner);
    expect(storage.getShare(token)).toBeUndefined();
    expect(fs.readdirSync(index)).toHaveLength(0);
  });
});
