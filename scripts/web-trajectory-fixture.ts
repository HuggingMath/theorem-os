import type { WebSampleFile } from '../apps/web/sample';
import type { WorkerMessage } from '../apps/web/shared';

/** The shipped sample with one failed attempt added: zero_add is first tried `by rfl`, Lean rejects it, then the recorded proof passes. */
export function withFailedAttempt(base: WebSampleFile): WebSampleFile {
  const sample = structuredClone(base);
  const passing = sample.observations[4]!.checks.find(check => check.taskId === 'goal_2')!;
  const passingSource = sample.observations[3]!.sources.find(source => source.taskId === 'goal_2')!;
  const commit = 'f00dfa11'.padEnd(40, '0'), checkedAt = 1793021604850;
  const source = { ...passingSource, commit, sourceDigest: 'f'.repeat(64), source: passingSource.source.replace('by exact Nat.zero_add n', 'by rfl') };
  const stdout = 'Submission.lean:4:44: error: The rfl tactic failed. Possible reasons:\n- The goal is not a reflexive relation (neither `=` nor a relation with a @[refl] lemma).\n- The arguments of the relation are not equal.\nTry using the reflexivity lemma for your relation explicitly, e.g. `exact Eq.refl _` or\n`exact HEq.rfl` etc.\nn : Nat\n⊢ 0 + n = n';
  const check = { ...passing, id: 'lean-failed-attempt', commit, sourceDigest: source.sourceDigest,
    record: { theoremName: 'Tutorial.zero_add', passed: false, status: 'failed', stdoutPreview: stdout, checkedAt,
      verification: { checkedAt, startedAt: checkedAt - 480, status: 'failed', schema: 'deepscientist.mathematics.verification-batch/v1' } } };
  const latest = sample.run.observation ? [sample.run.observation] : [];
  for (const observation of [...sample.observations.slice(3), ...latest]) { observation.sources.push(source); observation.checks.push(check); }
  const failed = { sequence: 36, at: new Date(checkedAt + 12).toISOString(), type: 'task_checked', message: '局部任务检查完成',
    details: { conditional: false, passed: false, taskId: 'goal_2' } };
  for (const events of [sample.events, sample.run.events]) {
    for (const event of events) if (event.sequence >= 36) event.sequence++;
    events.splice(events.findIndex(event => event.sequence === 37), 0, structuredClone(failed));
  }
  return sample;
}

/**
 * Replays a recording through a runner at its recorded pace, with every recorded time moved to now, so the server
 * stamps events at the same offsets from the receipts as in the recording. The host's own events are left to the host.
 * With `until`, the replay ends after the first event of that type and sends no result. `hold` may return a promise
 * before a message; the replay waits for it and moves what the recording has from that message on later by the wait,
 * so what came before keeps its times when later observations repeat it.
 */
export async function replaySample(sample: WebSampleFile, runId: string, send: (message: WorkerMessage) => void, signal: AbortSignal,
  options: { until?: string; hold?: (message: WorkerMessage) => Promise<void> | undefined } = {}) {
  const times = [...sample.events.map(event => Date.parse(event.at)), ...sample.observations.map(item => Date.parse(item.observedAt))];
  const start = Math.min(...times), end = Math.max(...times), offset = Date.now() - start, holds: { at: number; ms: number }[] = [];
  const moved = (at: number) => at + offset + holds.reduce((sum, hold) => at >= hold.at ? sum + hold.ms : sum, 0);
  const shift = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(shift);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shift(item)]));
    if (typeof value === 'number' && value >= start - 60_000 && value <= end + 60_000) return moved(value);
    if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/u.test(value)) return new Date(moved(Date.parse(value))).toISOString();
    return value;
  };
  const steps = [
    ...sample.events.filter(event => !['queued', 'preparing', 'finished'].includes(event.type)).map(event => ({ at: Date.parse(event.at),
      message: () => ({ type: 'progress', event: event.type, message: event.message, ...(event.details ? { details: event.details } : {}) }) as WorkerMessage })),
    // Shifted when sent, so a hold just before it moves its own times too.
    ...sample.observations.map(observation => ({ at: Date.parse(observation.observedAt),
      message: () => ({ type: 'observation', observation: { ...shift(observation) as typeof observation, webRunId: runId } }) as WorkerMessage })),
    // The worker reports an action without a place or time; the server gives it both when it arrives.
    ...(sample.actions ?? []).map(({ sequence: _sequence, at, ...action }) => ({ at: Date.parse(at),
      message: () => ({ type: 'action', action }) as WorkerMessage })),
  ].sort((a, b) => a.at - b.at);
  for (const step of steps) {
    const wait = moved(step.at) - Date.now();
    if (wait > 0) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('stopped')); }, { once: true });
    });
    let message = step.message();
    const held = options.hold?.(message);
    if (held) { const before = Date.now(); await held; holds.push({ at: step.at, ms: Date.now() - before }); message = step.message(); }
    send(message);
    if (options.until && message.type === 'progress' && message.event === options.until) return;
  }
  send({ type: 'artifact', artifact: sample.run.artifact! });
  send({ type: 'result', result: sample.run.result! });
}
