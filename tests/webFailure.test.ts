import { describe, expect, it } from 'vitest';
import { classifyWebError, classifyWebResult } from '../apps/web/failure';
import { checkReason, failureGuide, queueDescription, reportReason, resultDescription, stoppedLabel } from '../apps/web/presentation';
import { parseWebFailure, type WebRun } from '../apps/web/shared';
import { webIncompleteReason } from '../apps/web/worker';

const run = (changes: Partial<WebRun> = {}): WebRun => ({
  id: 'run', title: 'Example', status: 'completed', phase: 'finished', createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:01:00.000Z', providerId: 'openai', model: 'test-model', effort: 'high', environment: 'standard',
  source: 'theorem example : True := by sorry', task: 'Prove it', maxTurns: 5, maxRunSeconds: 30, workers: 1,
  coordination: 'independent', events: [], ...changes,
});

describe('web failure classification from solver results', () => {
  it('names the provider failure that stopped every Agent, preferring credentials over its symptoms', () => {
    expect(classifyWebResult({ status: 'incomplete', workers: [
      { id: 'w1', error: 'stream disconnected before completion' }, { id: 'w2', error: 'HTTP 401 Unauthorized: invalid api key sk-live-123' }] }))
      .toEqual({ kind: 'authentication', reason: 'math_model_authentication_failed' });
    expect(classifyWebResult({ status: 'incomplete', workers: [{ error: 'Concurrency limit exceeded (429)' }] }))
      .toEqual({ kind: 'rate_limit', reason: 'math_model_concurrency_limit' });
    expect(classifyWebResult({ status: 'runtime_error', reason: 'math_lean_toolchain_missing' }))
      .toEqual({ kind: 'environment', reason: 'math_lean_toolchain_missing' });
  });

  it('separates budget and time stops from an ordinary unfinished search', () => {
    expect(classifyWebResult({ status: 'limit_reached', reason: 'math_total_token_limit' })).toEqual({ kind: 'budget', reason: 'math_total_token_limit' });
    expect(classifyWebResult({ status: 'limit_reached' })).toEqual({ kind: 'time_limit' });
    expect(classifyWebResult({ status: 'runtime_error', reason: 'math_preparation_stopped' })).toEqual({ kind: 'time_limit', reason: 'math_preparation_stopped' });
    expect(classifyWebResult({ status: 'incomplete', workers: [{ error: 'unsolved goals' }] })).toBeUndefined();
    expect(classifyWebResult({ status: 'evaluated_failed', workers: [{ error: 'HTTP 401' }] })).toBeUndefined();
    expect(classifyWebResult({ status: 'evaluated_passed' })).toBeUndefined();
  });

  it('never copies provider text into the reason', () => {
    const failure = classifyWebResult({ status: 'runtime_error', reason: 'upstream said: key sk-live-123 is not allowed here' });
    expect(failure?.kind).toBe('unknown');
    expect(JSON.stringify(failure)).not.toContain('sk-live');
    expect(classifyWebError(new Error('lean_task_seed_invalid'))).toEqual({ kind: 'source', reason: 'lean_task_seed_invalid' });
    expect(classifyWebError(new Error('ENOSPC: no space left on device'))).toEqual({ kind: 'environment' });
  });

  it('accepts only the worker-produced shape', () => {
    expect(parseWebFailure({ kind: 'network', reason: 'math_model_request_timeout' })).toEqual({ kind: 'network', reason: 'math_model_request_timeout' });
    expect(parseWebFailure({ kind: 'network' })).toEqual({ kind: 'network' });
    for (const value of [undefined, 'network', { kind: 'billing' }, { kind: 'network', reason: 'sk-live-123' }, { kind: 'network', extra: 1 }])
      expect(parseWebFailure(value)).toBeUndefined();
  });

  it('names why an unfinished search stopped from the solver counters and the request limits', () => {
    const input = { maxTurns: 5, maxRunSeconds: 30 };
    expect(webIncompleteReason({ status: 'incomplete', turns: 5, solveWallMs: 12_000 }, input)).toBe('math_turn_limit_reached');
    expect(webIncompleteReason({ status: 'incomplete', turns: 6, solveWallMs: 31_000 }, input)).toBe('math_turn_limit_reached');
    expect(webIncompleteReason({ status: 'incomplete', turns: 3, solveWallMs: 30_000 }, input)).toBe('math_run_stopped');
    expect(webIncompleteReason({ status: 'incomplete', turns: 3, solveWallMs: 9_000 }, input)).toBe('math_research_routes_exhausted');
    expect(webIncompleteReason({ status: 'incomplete', turns: 3, solveWallMs: 600_000, solveExecutionMs: 9_000 }, input)).toBe('math_research_routes_exhausted');
    expect(webIncompleteReason({ status: 'incomplete' }, input)).toBe('math_research_routes_exhausted');
    expect(webIncompleteReason({ status: 'incomplete', turns: 1000, solveWallMs: 86_400_000 }, { maxTurns: 0, maxRunSeconds: 0 }))
      .toBe('math_research_routes_exhausted');
    for (const raw of [{ status: 'incomplete', reason: 'math_total_token_limit', turns: 5 }, { status: 'limit_reached', turns: 5 },
      { status: 'evaluated_failed', turns: 5 }, { status: 'evaluated_passed', turns: 1 }, { status: 'runtime_error' }])
      expect(webIncompleteReason(raw, input)).toBeUndefined();
  });

  it('does not report a zero time or turn allowance as exhausted', () => {
    const raw = { status: 'incomplete', turns: 1_000, solveExecutionMs: 86_400_000 };
    expect(webIncompleteReason(raw, { maxTurns: 0, maxRunSeconds: 0 })).toBe('math_research_routes_exhausted');
    expect(webIncompleteReason(raw, { maxTurns: 0, maxRunSeconds: 30 })).toBe('math_run_stopped');
    expect(webIncompleteReason(raw, { maxTurns: 5, maxRunSeconds: 0 })).toBe('math_turn_limit_reached');
  });
});

describe('web failure and queue presentation', () => {
  it('gives each failure a title, plain explanation and a recovery action', () => {
    const auth = failureGuide(run({ status: 'error', failure: { kind: 'authentication' }, error: '运行环境已退出，未返回验收结果。' }))!;
    expect(auth.title).toContain('API Key');
    expect(auth.actions.map(action => action.id)).toEqual(['key']);
    expect(resultDescription(run({ status: 'error', failure: { kind: 'authentication' }, error: 'docker exited' }))).not.toContain('docker');
    expect(failureGuide(run({ result: { status: 'limit_reached', proof: '', report: {} }, failure: { kind: 'time_limit', reason: 'math_preparation_stopped' } }))!.detail)
      .toContain('准备证明环境');
    expect(failureGuide(run({ result: { status: 'incomplete', proof: '', report: {} } }))!.actions[0].id).toBe('turns');
  });

  it('explains an unfinished search by the stop reason the worker recorded', () => {
    const incomplete = (stopReason?: string) => failureGuide(run({ result: { status: 'incomplete', proof: '',
      report: stopReason ? { stopReason } : {} } }))!;
    expect(incomplete('math_turn_limit_reached')).toMatchObject({ title: '研究轮次已用完' });
    expect(incomplete('math_turn_limit_reached').actions.map(action => action.id)).toEqual(['turns', 'report']);
    expect(incomplete('math_research_routes_exhausted')).toMatchObject({ title: '没有可以继续的研究路线' });
    expect(incomplete('math_research_routes_exhausted').actions.map(action => action.id)).toEqual(['retry', 'report']);
    expect(incomplete('math_run_stopped')).toMatchObject({ kind: 'time_limit', title: '已达到解题时间预算' });
    expect(incomplete('math_run_stopped').actions.map(action => action.id)).toEqual(['budget', 'report']);
    for (const legacy of [undefined, 'math_unknown_stop']) {
      expect(incomplete(legacy).title).toBe('没有得到完整证明');
      expect(incomplete(legacy).kind).toBeUndefined();
    }
  });

  it('names the solve budget, and offers a longer one only below the highest allowed', () => {
    const timed = (maxRunSeconds: number) => failureGuide(run({ maxRunSeconds, result: { status: 'limit_reached', proof: '', report: {} },
      failure: { kind: 'time_limit', reason: 'math_run_stopped' } }))!;
    expect(timed(300).detail).toContain('5 分钟的解题预算用完时');
    expect(timed(300).actions.map(action => action.id)).toEqual(['budget', 'report']);
    expect(timed(900).detail).toContain('15 分钟的解题预算（已是上限）');
    expect(timed(900).actions.map(action => action.id)).toEqual(['task', 'report']);
    // Older runs had no solve budget; their stop is described without a length.
    expect(timed(0).detail).toBe('运行在解题预算内没有完成，已检查的成果保存在报告中。可以提高解题预算后重新运行。');
    const turns = (maxTurns: number) => failureGuide(run({ maxTurns, result: { status: 'incomplete', proof: '', report: { stopReason: 'math_turn_limit_reached' } } }))!;
    expect(turns(20).actions.map(action => action.id)).toEqual(['task', 'report']);
  });

  it('keeps the preparation time apart from the solve budget', () => {
    for (const value of [run({ environment: 'mathlib', result: { status: 'limit_reached', proof: '', report: {} }, failure: { kind: 'time_limit', reason: 'math_preparation_stopped' } }),
      // Records from before failures were classified name the stop only in the report.
      run({ environment: 'mathlib', result: { status: 'limit_reached', proof: '', report: { reason: 'math_preparation_stopped' } } })]) {
      const guide = failureGuide(value)!;
      expect(guide).toMatchObject({ kind: 'environment', title: '证明环境准备超时' });
      expect(guide.detail).toContain('10 分钟的准备时限');
      expect(guide.detail).toContain('提高解题预算不会改变它');
      expect(guide.actions.map(action => action.id)).toEqual(['retry', 'report']);
      expect(stoppedLabel(value)).toBe('环境准备超时');
    }
    expect(failureGuide(run({ result: { status: 'limit_reached', proof: '', report: {} }, failure: { kind: 'time_limit', reason: 'math_preparation_stopped' } }))!.detail)
      .toContain('2 分钟的准备时限');
  });

  it('says report reasons in words, leaves out what the verdict explains and folds unknown codes', () => {
    expect(reportReason('math_run_stopped')).toEqual({});
    expect(reportReason('math_preparation_stopped')).toEqual({});
    expect(reportReason(undefined)).toEqual({});
    expect(reportReason('proof_incomplete')).toEqual({ text: '没有通过 Lean 检查的完整候选证明，所以没有进行独立验收。' });
    expect(reportReason('math_build_source_changed')).toEqual({ code: 'math_build_source_changed' });
    expect(reportReason('worker unavailable')).toEqual({ text: 'worker unavailable' });
    expect(checkReason({ skipped: true, reason: 'proof_incomplete' })).toBe('没有通过 Lean 检查的完整候选证明，所以没有进行独立验收。');
    expect(checkReason({ skipped: true })).toBe('运行在独立验收之前停止，没有进行独立验收。');
    expect(checkReason({ reason: 'known failure' })).toBe('known failure');
    expect(checkReason({})).toBeUndefined();
  });

  it('keeps legacy and non-failure runs on their existing wording', () => {
    expect(failureGuide(run({ status: 'error', phase: 'interrupted', error: '服务已重启' }))!.title).toContain('服务重启');
    expect(failureGuide(run({ status: 'error', error: 'old error' }))!.actions.map(action => action.id)).toContain('retry');
    for (const value of [run({ status: 'cancelled' }), run({ result: { status: 'evaluated_failed', proof: '', report: {} } }),
      run({ result: { status: 'evaluated_passed', proof: 'x', report: {} } }), run({ status: 'running', failure: { kind: 'network' } })])
      expect(failureGuide(value)).toBeUndefined();
  });

  it('describes the queue by position and occupied slots', () => {
    expect(queueDescription(run({ status: 'queued' }))).toBe('等待可用的运行环境。');
    expect(queueDescription(run({ status: 'queued', queue: { position: 3, ahead: 2, running: 2, slots: 2 } }))).toContain('前面还有 2 个任务');
    expect(queueDescription(run({ status: 'queued', queue: { position: 1, ahead: 0, running: 2, slots: 2 } }))).toContain('有任务结束后自动开始');
  });
});
