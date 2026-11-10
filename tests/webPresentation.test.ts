import { describe, expect, it } from 'vitest';
import { acceptedTitle, endedSummary, formatDuration, formatTokens, isAcceptedRun, isRejectedRun, planGated, readableDuration, readableMetric, resultDescription, runProgress, runTokens, shownLines, stalledMinutes, statementConfirmation, stoppedLabel } from '../apps/web/presentation';
import type { WebRun } from '../apps/web/shared';

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 16) + seconds * 1000).toISOString();
const run = (changes: Partial<WebRun> = {}): WebRun => ({
  id: 'run', title: 'Square expansion', status: 'running', phase: 'proof_environment',
  createdAt: at(0), updatedAt: at(10), timings: { preparing: at(10) },
  providerId: 'openai', model: 'test-model', effort: 'high', environment: 'mathlib',
  source: 'theorem example : True := by sorry', task: 'Prove the theorem',
  maxTurns: 5, maxRunSeconds: 30, workers: 1, coordination: 'independent', events: [],
  ...changes,
});

describe('workbench phase and elapsed-time presentation', () => {
  it('requires a completed job before showing an accepted result', () => {
    const result = { status: 'evaluated_passed', proof: 'by trivial', report: {} };
    for (const status of ['queued', 'running', 'cancelled', 'error'] as const) {
      const value = run({ status, result, phase: 'evaluated_passed' });
      expect(isAcceptedRun(value)).toBe(false);
      expect(runProgress(value).phaseLabel).not.toBe('验收通过');
      expect(resultDescription(value)).not.toBe('完整原题通过独立 Lean 验收。');
    }
    expect(isAcceptedRun(run({ status: 'completed', result }))).toBe(true);
  });

  it.each(['automatic', 'manual', undefined] as const)('describes an accepted %s formalization as a proved Lean statement', confirmation => {
    const accepted = run({ status: 'completed', phase: 'evaluation_finished',
      result: { status: 'evaluated_passed', proof: 'by trivial', report: {} },
      formalization: { id: 'formalization', original: 'Prove that True holds.', evidenceSha256: 'f'.repeat(64), confirmedAt: at(0),
        ...(confirmation ? { confirmation } : {}) } });
    expect(isAcceptedRun(accepted)).toBe(true);
    for (const text of [acceptedTitle(accepted), resultDescription(accepted), endedSummary(accepted)]) {
      expect(text).toContain('Lean 陈述');
      expect(text).not.toContain('原题已通过');
      expect(text).not.toContain('完整原题');
    }
    const directLean = { ...accepted, formalization: undefined };
    expect(acceptedTitle(directLean)).toContain('完整原题');
    expect(resultDescription(directLean)).toBe('完整原题通过独立 Lean 验收。');
    expect(endedSummary(directLean)).toBe('研究已结束，原题已通过验收。');
  });

  it('keeps direct formalization separate from proof acceptance and independent meaning review', () => {
    const accepted = run({ status: 'completed', result: { status: 'evaluated_passed', proof: 'by trivial', report: {} },
      formalization: { id: 'formalization', original: 'Prove that True holds.', evidenceSha256: 'f'.repeat(64),
        confirmedAt: at(0), confirmation: 'automatic', reviewMode: 'direct' } });
    expect(resultDescription(accepted)).toContain('Lean 陈述已通过独立验收');
    expect(resultDescription(accepted)).toContain('原题含义请查看形式化记录');
    expect(statementConfirmation('automatic', false, 'direct')).toBe('Lean 陈述编译通过；原题含义请查看形式化记录。');
    expect(statementConfirmation('automatic', true, 'direct')).not.toContain('模型审核通过');
    expect(statementConfirmation('automatic')).toContain('模型审核通过');
  });

  it('keeps queue and Mathlib preparation separate from the solving clock', () => {
    const queued = runProgress(run({ status: 'queued', phase: 'queued', timings: {} }), Date.parse(at(9)));
    expect(queued.index).toBe(0);
    expect(queued.elapsed).toBe(9000);
    expect(queued.solvingElapsed).toBeNull();
    const preparing = runProgress(run(), Date.parse(at(120)));
    expect(preparing.index).toBe(1);
    expect(preparing.elapsed).toBe(120000);
    expect(preparing.steps[1].elapsed).toBe(110000);
    expect(preparing.solvingElapsed).toBeNull();
    expect(resultDescription(run())).toContain('解题尚未开始');
    const solving = runProgress(run({ phase: 'proof_check_started',
      timings: { preparing: at(10), solving: at(130) } }), Date.parse(at(150)));
    expect(solving.steps[0].elapsed).toBe(10000);
    expect(solving.steps[1].elapsed).toBe(120000);
    expect(solving.solvingElapsed).toBe(20000);
    expect(solving.phaseLabel).toBe('检查候选证明');
  });

  it('stops the solving clock at independent evaluation and freezes completed durations', () => {
    const value = run({ phase: 'evaluation_started', timings: { preparing: at(10), solving: at(130), evaluating: at(160) } });
    const evaluating = runProgress(value, Date.parse(at(170)));
    expect(evaluating.solvingElapsed).toBe(30000);
    expect(evaluating.steps[3].elapsed).toBe(10000);
    const completed = runProgress({ ...value, status: 'completed', finishedAt: at(180),
      result: { status: 'evaluated_passed', proof: 'by trivial', report: {} } }, Date.parse(at(1000)));
    expect(completed.phaseLabel).toBe('验收通过');
    expect(completed.elapsed).toBe(180000);
    expect(completed.solvingElapsed).toBe(30000);
    expect(completed.steps[3].elapsed).toBe(20000);
    expect(completed.steps.every(step => step.state === 'done')).toBe(true);
  });

  it.each(['cancelled', 'error', 'completed'] as const)('shows unexecuted evaluation after a %s solve', status => {
    const value = run({ status, phase: status, finishedAt: at(150), timings: { preparing: at(10), solving: at(130) },
      ...(status === 'completed' ? { result: { status: 'incomplete', proof: 'by sorry', report: {} } } : {}) });
    const progress = runProgress(value, Date.parse(at(1000)));
    expect(progress.elapsed).toBe(150000);
    expect(progress.solvingElapsed).toBe(20000);
    expect(progress.steps[2].state).toBe(status === 'error' ? 'error' : 'stopped');
    expect(progress.steps[3].state).toBe('skipped');
    expect(progress.steps[3].elapsed).toBeNull();
    expect(progress.phaseLabel).not.toBe('验收通过');
  });

  it('does not mark skipped work complete when a queued task is cancelled', () => {
    const progress = runProgress(run({ status: 'cancelled', phase: 'cancelled', timings: {}, finishedAt: at(9) }), Date.parse(at(1000)));
    expect(progress.steps.map(step => step.state)).toEqual(['stopped', 'skipped', 'skipped', 'skipped']);
    expect(progress.solvingElapsed).toBeNull();
  });

  it.each(['evaluated_failed', 'evaluated_rejected'])('keeps %s distinct from successful acceptance', status => {
    const value = run({ status: 'completed', phase: status, finishedAt: at(180), result: { status, proof: 'by sorry', report: {} } });
    expect(runProgress(value).phaseLabel).toBe('验收未通过');
    expect(runProgress(value).steps[3].state).toBe('error');
    expect(resultDescription(value)).not.toBe('完整原题通过独立 Lean 验收。');
  });

  it('says why a run without an acceptance verdict stopped, and tells a failed acceptance from none', () => {
    const ended = (result: Partial<NonNullable<WebRun['result']>>, changes: Partial<WebRun> = {}) =>
      run({ status: 'completed', phase: 'finished', finishedAt: at(180), result: { status: 'incomplete', proof: '', report: {}, ...result }, ...changes });
    expect(stoppedLabel(ended({ status: 'limit_reached' }))).toBe('解题时间用完');
    expect(stoppedLabel(ended({}, { failure: { kind: 'time_limit', reason: 'math_run_stopped' } }))).toBe('解题时间用完');
    expect(stoppedLabel(ended({}, { failure: { kind: 'budget', reason: 'math_total_token_limit' } }))).toBe('用量到达上限');
    expect(stoppedLabel(ended({ report: { stopReason: 'math_turn_limit_reached' } }))).toBe('研究轮次用完');
    expect(stoppedLabel(ended({ report: { stopReason: 'math_research_routes_exhausted' } }))).toBe('研究路线用尽');
    expect(stoppedLabel(ended({ report: { stopReason: 'math_run_stopped' } }))).toBe('解题时间用完');
    expect(stoppedLabel(ended({}))).toBe('运行结束');
    expect(['evaluated_failed', 'evaluated_rejected', 'evaluated_passed', 'incomplete'].map(status => isRejectedRun(ended({ status }))))
      .toEqual([true, true, false, false]);
    // The route map's closing line: a run stopped on a limit never reached acceptance, so it must not say acceptance failed.
    expect(endedSummary(ended({ status: 'evaluated_passed' }))).toBe('研究已结束，原题已通过验收。');
    expect(endedSummary(ended({ status: 'evaluated_failed' }))).toBe('研究已结束，候选证明没有通过验收。');
    expect(endedSummary(ended({ status: 'limit_reached' }))).toBe('研究已结束：解题时间用完，没有得到通过验收的完整证明。');
    expect(endedSummary(ended({ report: { stopReason: 'math_turn_limit_reached' } }))).toBe('研究已结束：研究轮次用完，没有得到通过验收的完整证明。');
    expect(endedSummary(ended({}))).toBe('研究已结束，没有得到通过验收的完整证明。');
    expect(endedSummary(run({ status: 'cancelled', phase: 'cancelled', finishedAt: at(180) }))).toBe('研究已取消，没有得到通过验收的完整证明。');
    expect(endedSummary(run({ status: 'error', phase: 'error', finishedAt: at(180), failure: { kind: 'network' } }))).toBe('运行出错后中止，没有得到通过验收的完整证明。');
  });

  it('falls back to legacy events and terminal update time without requiring a new archive schema', () => {
    const value = run({ timings: undefined, phase: 'finished', status: 'completed', updatedAt: at(180),
      events: [{ sequence: 1, at: at(10), type: 'preparing', message: '' },
        { sequence: 2, at: at(130), type: 'solve_started', message: '' },
        { sequence: 3, at: at(160), type: 'evaluation_started', message: '' }],
      result: { status: 'evaluated_passed', proof: 'by trivial', report: {} } });
    const progress = runProgress(value);
    expect(progress.elapsed).toBe(180000);
    expect(progress.steps.map(step => step.elapsed)).toEqual([10000, 120000, 30000, 20000]);
  });

  it('formats long, unknown and skewed durations without invalid or negative clocks', () => {
    expect(formatDuration(89999)).toBe('01:29');
    expect(formatDuration(3661000)).toBe('01:01:01');
    expect(formatDuration(null)).toBe('--:--');
    expect(formatDuration(Number.NaN)).toBe('--:--');
    expect(runProgress(run(), Date.parse(at(-10))).elapsed).toBe(0);
    expect(runProgress(run({ createdAt: 'invalid' })).elapsed).toBeNull();
  });

  it('says finished durations and report metrics the way a reader does', () => {
    expect([26_302, 60_000, 378_000, 3_600_000, 3_900_000].map(readableDuration)).toEqual(['26 秒', '1 分钟', '6 分 18 秒', '1 小时', '1 小时 5 分']);
    expect(readableMetric({ label: '求解耗时', value: '26.302 秒' })).toEqual({ label: '求解耗时', value: '26 秒' });
    expect(readableMetric({ label: '总 Token', value: '48000' })).toEqual({ label: '总 Token', value: '4.8 万' });
    expect(readableMetric({ label: '研究轮次', value: '2' })).toEqual({ label: '研究轮次', value: '2' });
    expect(readableMetric({ label: '总 Token', value: 'unknown' })).toEqual({ label: '总 Token', value: 'unknown' });
  });

  it('keeps one decimal of 万 below 100 万, so a task and its run total read in the same units', () => {
    expect([800, 9_999, 10_000, 48_000, 64_211, 207_455, 999_900, 1_230_000, 250_000_000].map(formatTokens))
      .toEqual(['800', '9999', '1 万', '4.8 万', '6.4 万', '20.7 万', '100 万', '123 万', '2.5 亿']);
  });

  it('numbers the lines a reader sees: a final newline ends the last line rather than starting an empty one', () => {
    expect(shownLines('a\nb\n')).toEqual(['a', 'b']);
    expect(shownLines('a\r\nb')).toEqual(['a', 'b']);
    expect(shownLines('a\n\n')).toEqual(['a', '']);
    expect(shownLines('')).toEqual(['']);
    expect(shownLines('\n')).toEqual(['']);
  });

  it('counts a solving run as stuck after ten minutes without progress, from its last passing check', () => {
    const solving = run({ phase: 'turn_started', timings: { preparing: at(10), solving: at(60) } });
    expect(stalledMinutes(solving, Date.parse(at(60 + 9 * 60 + 59)))).toBeUndefined();
    expect(stalledMinutes(solving, Date.parse(at(60 + 10 * 60)))).toBe(10);
    expect(stalledMinutes({ ...solving, progressAt: at(300) }, Date.parse(at(60 + 10 * 60)))).toBeUndefined();
    expect(stalledMinutes({ ...solving, progressAt: at(300) }, Date.parse(at(300 + 25 * 60)))).toBe(25);
    // Preparing, evaluating and finished runs are never stuck in this sense.
    expect(stalledMinutes(run({ timings: { preparing: at(10) } }), Date.parse(at(3_600)))).toBeUndefined();
    expect(stalledMinutes({ ...solving, timings: { ...solving.timings, evaluating: at(120) } }, Date.parse(at(3_600)))).toBeUndefined();
    expect(stalledMinutes({ ...solving, status: 'completed' }, Date.parse(at(3_600)))).toBeUndefined();
  });

  it('does not count waiting for plan approval as stuck, and restarts the count at approval', () => {
    const solving = run({ phase: 'turn_started', timings: { preparing: at(10), solving: at(60) } });
    const approval = (planApproval: Record<string, unknown>) => ({ ...solving,
      observation: { inspection: { planApproval: { required: true, planVersion: 'plan-v1', rejections: [], leadRevising: false, ...planApproval } } } }) as unknown as WebRun;
    const pending = approval({ status: 'pending' });
    expect(stalledMinutes(pending, Date.parse(at(3_600)))).toBeUndefined();
    expect([pending, approval({ status: 'awaiting-plan' }), approval({ status: 'approved' }), solving].map(planGated)).toEqual([true, true, false, false]);
    expect(resultDescription(pending)).toBe('Lead 已经拟好研究计划，等你批准后 Agent 才开始工作。');
    expect(resultDescription(approval({ status: 'pending', leadRevising: true }))).toBe('Lead 正在按你的留言修改研究计划，改完后再请你批准。');
    // While the Lead revises, the header must not ask the owner for an approval they cannot give yet.
    expect([pending, approval({ status: 'pending', leadRevising: true }), approval({ status: 'approved' })].map(item => runProgress(item).phaseLabel))
      .toEqual(['等你批准计划', 'Lead 正在改计划', '构造证明']);
    expect(resultDescription(approval({ status: 'awaiting-plan' }))).toBe('Lead 正在拟定研究计划，拟好后会请你批准。');
    const approved = approval({ status: 'approved', approvedAt: Date.parse(at(1_800)) });
    expect(stalledMinutes(approved, Date.parse(at(1_800 + 9 * 60)))).toBeUndefined();
    expect(stalledMinutes(approved, Date.parse(at(1_800 + 10 * 60)))).toBe(10);
    // The budget ran out before anyone approved: the guide says so instead of blaming the Agents.
    const expired = { ...pending, status: 'error', failure: { kind: 'time_limit' } } as unknown as WebRun;
    expect(resultDescription(expired)).toContain('研究计划直到解题时间用完都没有批准');
  });
});

describe('runTokens', () => {
  const observed = (usage: unknown) => ({ observation: { inspection: { usage } } }) as unknown as Partial<WebRun>;
  it('reads the report once there is one, else the latest observation, else nothing', () => {
    expect(runTokens(run())).toBeUndefined();
    expect(runTokens(run(observed({ inputTokens: 900, outputTokens: 100 })))).toBe(1_000);
    expect(runTokens(run({ ...observed({ totalTokens: 1_000 }), result: { status: 'limit_reached', proof: '', report: { usage: { totalTokens: 1_200 } } } } as Partial<WebRun>))).toBe(1_200);
    expect(runTokens(run({ ...observed({ totalTokens: 1_000 }), result: { status: 'limit_reached', proof: '', report: { usage: {} } } } as Partial<WebRun>))).toBe(1_000);
    expect(runTokens(run(observed({ totalTokens: -1 })))).toBeUndefined();
  });
});
