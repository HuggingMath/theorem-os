import { describe, expect, it } from 'vitest';
import { isWebEventDetails, recordWebModuleEvent, sanitizeWebEventDetails, webEventModule, webModuleSnapshots } from '../apps/web/moduleTelemetry';
import { createWebProgressForwarder, translateWebProgress, webProgressHeartbeatMs } from '../apps/web/progress';
import { parseWorkerMessage } from '../apps/web/runner';
import type { WebEvent, WebEventDetails, WebRun } from '../apps/web/shared';

const run = (overrides: Partial<WebRun> = {}): WebRun => ({
  id: 'run-modules', title: 'Test modules', status: 'running', phase: 'solve_started',
  createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z',
  providerId: 'openai', model: 'fixture', effort: 'high', environment: 'standard',
  source: 'theorem example : True := by sorry', task: 'Prove example', maxTurns: 4, maxRunSeconds: 60,
  workers: 4, coordination: 'cooperative', events: [], ...overrides,
});
const event = (type: string, sequence: number, details?: WebEventDetails): WebEvent => ({
  sequence, at: new Date(Date.parse('2026-10-18T00:00:00.000Z') + sequence * 1_000).toISOString(),
  type, message: type, ...(details ? { details } : {}),
});
const append = (value: WebRun, type: string, details?: WebEventDetails) => {
  const next = event(type, (value.events.at(-1)?.sequence ?? 0) + 1, details);
  recordWebModuleEvent(value, next);
  value.events.push(next);
  if (value.events.length > 200) value.events.shift();
  return next;
};

describe('bounded web module observations', () => {
  it.each([
    ['turn_started', 'M1'], ['worker_activity', 'M1'], ['turn_checkpoint', 'M1'],
    ['proof_checked', 'M2'], ['task_checked', 'M2'], ['lemma_checked', 'M2'],
    ['research_action', 'M3'], ['turn_retry', 'M3'], ['context_compiled', 'M4'],
    ['context_restarted', 'M4'], ['task_assigned', 'M5'], ['review_completed', 'M5'],
    ['evaluation_started', 'S3'], ['evaluation_finished', 'S3'],
    ['task_canonical_probe', 'M2'], ['proof_ready_checked', 'M2'], ['task_conditional_recheck_finished', 'M2'],
    ['goal_path_stalled', 'M3'], ['route_blocker_recorded', 'M3'], ['task_repeated_input_blocked', 'M3'],
    ['context_compaction_started', 'M4'], ['worker_context_recovering', 'M4'], ['knowledge_retrieval_observed', 'M4'],
    ['plan_published', 'M5'], ['edit_applied', 'M5'], ['delivery_rejected', 'M5'], ['statement_review_reused', 'M5'],
  ])('maps the actual %s event to %s', (type, module) => {
    expect(webEventModule(type)).toBe(module);
  });

  it('does not invent archive, preparation, acceptance or inherited module events', () => {
    for (const type of ['ready', 'finished', 'queued', 'S1', 'S2', 'constructor', 'toString', 'unknown'])
      expect(webEventModule(type)).toBeUndefined();
  });

  it('keeps concurrent model and checker intervals separate by worker identity', () => {
    const value = run();
    append(value, 'turn_started', { workerId: 'solver', turn: 1 });
    append(value, 'turn_started', { workerId: 'researcher-1', turn: 1 });
    append(value, 'proof_check_started', { workerId: 'solver', turn: 1 });
    expect(value.modules?.M1?.activeWorkers).toEqual(['researcher-1']);
    expect(value.modules?.M2?.activeWorkers).toEqual(['solver']);
    append(value, 'proof_check_started', { workerId: 'researcher-1', turn: 1 });
    expect(value.modules?.M1?.activeWorkers).toEqual([]);
    expect(value.modules?.M2?.activeWorkers).toEqual(['solver', 'researcher-1']);
    append(value, 'proof_checked', { workerId: 'solver', passed: false });
    expect(value.modules?.M2?.activeWorkers).toEqual(['researcher-1']);
    append(value, 'proof_checked', { workerId: 'researcher-1', passed: true });
    expect(value.modules?.M2?.activeWorkers).toEqual([]);
    expect(value.status).toBe('running');
    expect(value.result).toBeUndefined();
  });

  it('does not clear other workers when an old event has no structured identity', () => {
    const value = run();
    append(value, 'turn_started', { workerId: 'solver' });
    append(value, 'turn_started', { workerId: 'engineer' });
    append(value, 'turn_checkpoint', { workerId: 'solver' });
    append(value, 'task_checked', { taskId: 'goal-1', passed: true, conditional: true });
    append(value, 'turn_failed');
    expect(value.modules?.M1?.activeWorkers).toEqual(['engineer']);
    expect(value.modules?.M2?.activeWorkers).toEqual([]);
    expect(value.modules?.M2?.lastEvent.details).toEqual({ taskId: 'goal-1', passed: true, conditional: true });
  });

  it('records decisions, context and assignment as observations rather than running intervals', () => {
    const value = run();
    append(value, 'research_action', { workerId: 'solver', operation: 'decompose' });
    append(value, 'context_compiled', { workerId: 'solver', usedBytes: 1_024, maxBytes: 8_192 });
    append(value, 'task_assigned', { workerId: 'engineer', taskId: 'goal-1' });
    expect(value.modules?.M3?.activeWorkers).toEqual([]);
    expect(value.modules?.M4?.activeWorkers).toEqual([]);
    expect(value.modules?.M5?.activeWorkers).toEqual([]);
    expect(value.modules?.M1).toBeUndefined();
  });

  it('records a checked library application in M2 without exposing its private candidates or accepting the run', () => {
    const translated = translateWebProgress({ event: 'task_library_application', workerId: 'solver', taskId: 'goal-1',
      passed: true, status: 'candidate', candidates: [{ name: 'private-declaration' }], receiptIds: ['private-receipt'] });
    expect(translated).toEqual({ type: 'progress', event: 'task_library_application', message: '已检查库定理的实际应用 · solver',
      details: { workerId: 'solver', taskId: 'goal-1', passed: true } });
    expect(parseWorkerMessage(JSON.stringify(translated))).toEqual(translated);
    const value = run();
    append(value, translated!.event, translated!.details);
    expect(value.modules?.M2).toMatchObject({ eventCount: 1, lastEvent: { type: 'task_library_application',
      details: { workerId: 'solver', taskId: 'goal-1', passed: true } }, activeWorkers: [] });
    expect(value.status).toBe('running');
    expect(value.result).toBeUndefined();
    expect(webModuleSnapshots({ ...value, modules: undefined })).toEqual(value.modules);
  });

  it('ends research intervals at independent evaluation and retains its separate outcome', () => {
    const value = run();
    append(value, 'ready');
    expect(value.modules?.S3).toBeUndefined();
    append(value, 'turn_started', { workerId: 'solver' });
    append(value, 'proof_check_started', { workerId: 'engineer' });
    append(value, 'evaluation_started', { workerId: 'solver' });
    expect(value.modules?.M1?.activeWorkers).toEqual([]);
    expect(value.modules?.M2?.activeWorkers).toEqual([]);
    expect(value.modules?.S3?.activeWorkers).toEqual(['solver']);
    append(value, 'evaluation_finished', { status: 'passed' });
    expect(value.modules?.S3?.activeWorkers).toEqual([]);
    expect(value.modules?.S3?.lastEvent.details?.status).toBe('passed');
    expect(value.status).toBe('running');
    expect(value.result).toBeUndefined();
  });

  it.each(['finished', 'cancelled', 'error'])('clears outstanding activity on %s without creating a proof outcome', type => {
    const value = run();
    append(value, 'turn_started', { workerId: 'solver' });
    append(value, 'proof_check_started', { workerId: 'engineer' });
    append(value, type);
    expect(value.modules?.M1?.activeWorkers).toEqual([]);
    expect(value.modules?.M2?.activeWorkers).toEqual([]);
    expect(value.modules?.M1?.lastEvent.type).toBe('turn_started');
    expect(value.result).toBeUndefined();
  });

  it('retains first observation and total observation count when the activity window rotates', () => {
    const value = run();
    const first = append(value, 'context_compiled', { workerId: 'solver', usedBytes: 0, maxBytes: 1_024 });
    for (let index = 0; index < 220; index++) append(value, 'worker_activity', { workerId: 'solver' });
    append(value, 'context_compiled', { workerId: 'solver', usedBytes: 512, maxBytes: 1_024 });
    expect(value.events).toHaveLength(200);
    expect(value.events.some(item => item.sequence === first.sequence)).toBe(false);
    expect(value.modules?.M4?.firstAt).toBe(first.at);
    expect(value.modules?.M4?.eventCount).toBe(2);
    expect(value.modules?.M1?.eventCount).toBe(220);
    expect(webModuleSnapshots(value)).toBe(value.modules);
  });

  it('reconstructs older runs only from retained events without mutating their records', () => {
    const value = run({ events: [event('turn_started', 5, { workerId: 'solver' }),
      event('proof_check_started', 6, { workerId: 'solver' }), event('proof_checked', 7, { workerId: 'solver', passed: false })] });
    const before = JSON.stringify(value);
    const snapshots = webModuleSnapshots(value);
    expect(snapshots.M1).toMatchObject({ eventCount: 1, firstAt: value.events[0].at, activeWorkers: [] });
    expect(snapshots.M2).toMatchObject({ eventCount: 2, firstAt: value.events[1].at, activeWorkers: [] });
    expect(JSON.stringify(value)).toBe(before);
    expect(value.modules).toBeUndefined();
  });

  it.each(['completed', 'cancelled', 'error'] as const)('does not revive activity when reconstructing %s legacy runs', status => {
    const value = run({ status, events: [event('turn_started', 1, { workerId: 'solver' })] });
    expect(webModuleSnapshots(value).M1?.activeWorkers).toEqual([]);
  });

  it('bounds active identities and counters, and copies structured evidence into the summary', () => {
    const value = run();
    const details = { workerId: 'solver', turn: 1 };
    append(value, 'turn_started', details);
    details.turn = 99;
    expect(value.modules?.M1?.lastEvent.details?.turn).toBe(1);
    for (let index = 0; index < 12; index++) append(value, 'turn_started', { workerId: `worker-${index}` });
    expect(value.modules?.M1?.activeWorkers).toHaveLength(4);
    value.modules!.M1!.eventCount = Number.MAX_SAFE_INTEGER;
    append(value, 'worker_activity', { workerId: 'solver' });
    expect(value.modules?.M1?.eventCount).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('allowlisted web progress translation', () => {
  it('preserves real context identity and size but discards private and unneeded fields', () => {
    const message = translateWebProgress({ event: 'context_compiled', workerId: 'researcher-1',
      taskId: 'lemma-1', usedBytes: 4_096, maxBytes: 16_384, included: 4, omitted: 2,
      contentDigest: 'private-digest', worktree: '/work/run-1', instructions: 'private instructions',
      apiKey: 'sk-private', sections: ['private-section'], threadId: 'private-thread' });
    expect(message).toEqual({ type: 'progress', event: 'context_compiled',
      message: '本轮上下文已整理 · researcher-1', details: { workerId: 'researcher-1', usedBytes: 4_096, maxBytes: 16_384 } });
    expect(parseWorkerMessage(JSON.stringify(message))).toEqual(message);
    expect(JSON.stringify(message)).not.toMatch(/private|worktree|sections|instructions|threadId/);
  });

  it('forwards only exact event evidence and keeps conditional proof and model outcomes separate', () => {
    const task = translateWebProgress({ event: 'task_checked', taskId: 'goal-1', passed: true, conditional: true,
      commit: 'private-commit', verification: { status: 'kernel_verified' } });
    expect(task?.details).toEqual({ taskId: 'goal-1', passed: true, conditional: true });
    const lemma = translateWebProgress({ event: 'lemma_checked', workerId: 'solver', bridge: true, lemma: false,
      passed: true, status: 'evaluated_passed', error: 'private-lean-error' });
    expect(lemma?.details).toEqual({ workerId: 'solver' });
    const model = translateWebProgress({ event: 'worker_activity', workerId: 'solver', status: 'completed', passed: true });
    expect(model?.details).toEqual({ workerId: 'solver' });
    expect(translateWebProgress({ event: 'proof_checked', workerId: 'solver', passed: false, reused: false })?.details)
      .toEqual({ workerId: 'solver', passed: false, reused: false });
    expect(translateWebProgress({ event: 'evaluation_finished', status: 'failed', durationMs: 100 })?.details)
      .toEqual({ status: 'failed' });
  });

  it('translates genuine search and cooperation events with bounded role and task identifiers', () => {
    expect(translateWebProgress({ event: 'research_action', workerId: 'solver', operation: 'decompose',
      reason: 'private strategy', estimates: [{ private: true }] })?.details)
      .toEqual({ workerId: 'solver', operation: 'decompose' });
    expect(translateWebProgress({ event: 'task_assigned', workerId: 'engineer', taskId: 'goal-1',
      kind: 'goal', seedCommit: 'private-commit' })?.details).toEqual({ workerId: 'engineer', taskId: 'goal-1' });
    expect(translateWebProgress({ event: 'review_assigned', workerId: 'researcher-1', role: 'reviewer' })?.details)
      .toEqual({ workerId: 'researcher-1', role: 'reviewer' });
  });

  it('uses fixed failure descriptions and drops malformed details instead of exposing raw logs', () => {
    const message = translateWebProgress({ event: 'turn_failed', workerId: '../secret', turn: -1,
      reason: 'math_model_authentication_failed', error: 'sk-private', message: 'private log' });
    expect(message).toEqual({ type: 'progress', event: 'turn_failed', message: 'API Key 认证失败，请检查密钥和服务商' });
    expect(translateWebProgress({ event: 'research_action', operation: 'run-shell', workerId: 'x'.repeat(65) })?.details).toBeUndefined();
    expect(translateWebProgress({ event: 'context_compiled', usedBytes: Infinity, maxBytes: 0 })?.details).toEqual({ maxBytes: 0 });
  });

  it.each([
    ['turn_failed', 'math_total_token_limit', '已达到模型用量门槛，后续调用已停止'],
    ['turn_failed', 'math_model_usage_unavailable', '模型用量回执不完整，后续调用已停止'],
    ['planning_budget_stopped', 'math_initial_planning_limit', '初始规划已达到限额，正在交接研究任务'],
  ])('distinguishes budget stops from authentication failures (%s, %s)', (event, reason, message) => {
    const translated = translateWebProgress({ event, reason, workerId: 'solver', error: 'private diagnostics' });
    expect(translated).toEqual({ type: 'progress', event, message: message + ' · solver', details: { workerId: 'solver' } });
    expect(parseWorkerMessage(JSON.stringify(translated))).toEqual(translated);
  });

  it.each([null, [], 'private log', {}, { event: 'unknown' }, { event: 'constructor' }, { event: 'toString' }])
    ('ignores unrecognized or unstructured runtime output (%#)', value => {
      expect(translateWebProgress(value)).toBeUndefined();
    });

  it('validates safe scalar metadata and rejects malformed protocol detail objects', () => {
    const valid = { workerId: 'solver', taskId: 'goal-1', turn: 0, passed: false, conditional: true, reused: false,
      operation: 'direct', usedBytes: 0, maxBytes: 1_024, status: 'changes_requested', role: 'reviewer' };
    expect(isWebEventDetails(valid)).toBe(true);
    expect(sanitizeWebEventDetails({ ...valid, instructions: 'private', nested: {} })).toEqual(valid);
    for (const invalid of [null, [], 'private', { workerId: '/work/private' }, { taskId: 'x'.repeat(65) },
      { usedBytes: -1 }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }, { turn: 1.5 }, { passed: 'true' },
      { status: 'private log' }, { operation: 'shell' }, { role: 'admin' }, { arbitrary: 'private' },
      { workerId: 'solver', nested: { apiKey: 'sk-private' } }]) expect(isWebEventDetails(invalid)).toBe(false);
    expect(isWebEventDetails({})).toBe(true);
    expect(sanitizeWebEventDetails(Object.create({ workerId: 'private-inherited' }))).toBeUndefined();
  });

  it('forwards the runtime reason code but never the text after it', () => {
    const rejected = translateWebProgress({ event: 'delivery_rejected', workerId: 'engineer',
      reason: 'math_research_lemma_requests_invalid: math_plan_invalid_task', error: 'private' });
    expect(rejected).toEqual({ type: 'progress', event: 'delivery_rejected', message: 'Agent 交付未通过宿主校验 · engineer',
      details: { workerId: 'engineer', reason: 'math_research_lemma_requests_invalid' } });
    // The service drops a progress line whose details it does not fully recognise, so it must accept the reason.
    expect(parseWorkerMessage(JSON.stringify(rejected))).toEqual(rejected);
    expect(parseWorkerMessage(JSON.stringify({ ...rejected, details: { workerId: 'engineer', reason: 'Lean said: no' } }))).toBeUndefined();
    expect(translateWebProgress({ event: 'route_reopened', taskId: 'goal-1', reason: 'contract-changed' })?.details)
      .toEqual({ taskId: 'goal-1', reason: 'contract-changed' });
    expect(translateWebProgress({ event: 'task_tactic_battery', taskId: 'lemma-2', reason: 'battery-did-not-close' })?.details)
      .toEqual({ taskId: 'lemma-2', reason: 'battery-did-not-close' });
    for (const reason of ['Lean said: unsolved goals', '/work/run-1/worktree', 'sk-live-123', 'MATH_DELIVERY_INVALID',
      'a'.repeat(40), 'deadbeef00112233', 'math_' + 'x'.repeat(80), 'two words', 7, null])
      expect(translateWebProgress({ event: 'route_reopened', taskId: 'goal-1', reason })?.details).toEqual({ taskId: 'goal-1' });
    for (const reason of ['math_delivery_invalid', 'lean_task_seed_invalid', 'no-durable-progress', 'unchanged-mathematical-input'])
      expect(isWebEventDetails({ reason })).toBe(true);
  });

  it('names a known stop by its fixed description and keeps the code for the module record', () => {
    expect(translateWebProgress({ event: 'worker_failed', workerId: 'prover-1',
      reason: 'math_context_mandatory_overflow:767016>524288' }))
      .toEqual({ type: 'progress', event: 'worker_failed', message: '必需上下文超出容量，会话已停止 · prover-1',
        details: { workerId: 'prover-1', reason: 'math_context_mandatory_overflow' } });
    expect(translateWebProgress({ event: 'worker_failed', workerId: 'engineer', reason: 'math_source_outside_ownership' })?.message)
      .toBe('Agent 修改了不属于本任务的源码，会话已停止 · engineer');
    expect(translateWebProgress({ event: 'cooperation_poll_failed', reason: 'math_delivery_line_too_large' })?.message)
      .toBe('Agent 交付记录过大，未能读取');
  });

  it('reports a recovery as a recovery even when it names the provider failure it recovered from', () => {
    expect(translateWebProgress({ event: 'worker_recovered', workerId: 'solver', reason: 'math_model_request_timeout' }))
      .toEqual({ type: 'progress', event: 'worker_recovered', message: 'Agent 已恢复，保留已检查成果 · solver',
        details: { workerId: 'solver', reason: 'math_model_request_timeout' } });
  });

  it('translates lead, goal-path and human-input events that the workbench shows', () => {
    expect(translateWebProgress({ event: 'goal_path_stalled', workerId: 'lead', candidates: ['private-id'] }))
      .toEqual({ type: 'progress', event: 'goal_path_stalled', message: '原题目标路径停滞，等待 Lead 决定 · lead',
        details: { workerId: 'lead' } });
    expect(translateWebProgress({ event: 'edit_rejected', reason: 'math_plan_invalid_task', plan: { private: true } }))
      .toEqual({ type: 'progress', event: 'edit_rejected', message: '计划修改未通过校验，计划未改变',
        details: { reason: 'math_plan_invalid_task' } });
    expect(translateWebProgress({ event: 'human_guidance_delivered', workerId: 'prover-1', text: 'private guidance' }))
      .toEqual({ type: 'progress', event: 'human_guidance_delivered', message: '数学指导已送达 Agent · prover-1',
        details: { workerId: 'prover-1' } });
    expect(translateWebProgress({ event: 'task_conditional_recheck_finished', taskId: 'goal-1', passed: true, conditional: true })?.details)
      .toEqual({ taskId: 'goal-1', passed: true });
  });
});

describe('bounded web progress forwarding', () => {
  const forwarder = () => {
    let clock = 0;
    const sent: { event: string; message: string }[] = [];
    const forward = createWebProgressForwarder(message => sent.push(message), () => clock);
    return { sent, forward, at: (value: number) => { clock = value; } };
  };

  it('keeps one activity heartbeat per worker per interval and drops the rest', () => {
    const { sent, forward, at } = forwarder();
    for (let index = 0; index < 50; index++) forward({ event: 'worker_activity', workerId: 'solver' });
    forward({ event: 'worker_activity', workerId: 'researcher-1' });
    at(webProgressHeartbeatMs - 1);
    forward({ event: 'worker_activity', workerId: 'solver' });
    at(webProgressHeartbeatMs);
    forward({ event: 'worker_activity', workerId: 'solver' });
    expect(sent.map(message => message.message)).toEqual(['Agent 正在运行 · solver', 'Agent 正在运行 · researcher-1', 'Agent 正在运行 · solver']);
  });

  it('forwards activity at once after any other event from that worker, so module intervals reopen', () => {
    const { sent, forward, at } = forwarder();
    forward({ event: 'worker_activity', workerId: 'solver' });
    forward({ event: 'worker_activity', workerId: 'engineer' });
    at(1_000);
    forward({ event: 'proof_check_started', workerId: 'solver', turn: 1 });
    forward({ event: 'worker_activity', workerId: 'solver' });
    forward({ event: 'worker_activity', workerId: 'engineer' });
    forward({ event: 'unknown_event', workerId: 'engineer' });
    forward({ event: 'worker_activity', workerId: 'engineer' });
    expect(sent.map(message => message.event + '/' + message.message.split(' · ')[1]))
      .toEqual(['worker_activity/solver', 'worker_activity/engineer', 'proof_check_started/solver', 'worker_activity/solver']);
  });

  it('keeps one repeat of the same poll failure per interval but forwards a different one', () => {
    const { sent, forward, at } = forwarder();
    for (let index = 0; index < 20; index++) forward({ event: 'cooperation_poll_failed', reason: 'math_delivery_line_too_large' });
    forward({ event: 'cooperation_poll_failed', reason: 'math_delivery_log_invalid' });
    at(webProgressHeartbeatMs);
    forward({ event: 'cooperation_poll_failed', reason: 'math_delivery_line_too_large' });
    expect(sent.map(message => message.message)).toEqual(['Agent 交付记录过大，未能读取', '读取 Agent 交付记录失败',
      'Agent 交付记录过大，未能读取']);
  });

  it('never throttles ordinary events', () => {
    const { sent, forward } = forwarder();
    for (let index = 0; index < 5; index++) forward({ event: 'task_checked', taskId: 'goal-1', passed: false });
    forward('private log');
    expect(sent).toHaveLength(5);
  });
});
