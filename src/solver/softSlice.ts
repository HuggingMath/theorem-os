export const SOFT_SLICE_MS = 30 * 60_000;
export const MAX_COMPACTIONS_PER_SLICE = 2;
const SOFT_SLICE_GRACE_MS = 60_000;
const BOUNDARY_WAIT_MS = 30_000;

export type SoftSliceSettings = {
  softSliceMs?: number;
  maxCompactionsPerSlice?: number;
  softSliceGraceMs?: number;
};

export function softSliceSettings(options: SoftSliceSettings, environment: NodeJS.ProcessEnv = process.env) {
  const setting = (option: number | undefined, name: string, fallback: number) => {
    const raw = option ?? (environment[name]?.trim() ? Number(environment[name]) : fallback);
    return Number.isSafeInteger(raw) && raw >= 0 && raw <= 2_147_483_647 ? raw : fallback;
  };
  return {
    timeMs: setting(options.softSliceMs, 'THEOREMOS_SOFT_SLICE_MS', SOFT_SLICE_MS),
    compactions: setting(options.maxCompactionsPerSlice, 'THEOREMOS_MAX_COMPACTIONS_PER_SLICE', MAX_COMPACTIONS_PER_SLICE),
    graceMs: setting(options.softSliceGraceMs, 'THEOREMOS_SOFT_SLICE_GRACE_MS', SOFT_SLICE_GRACE_MS),
  };
}

/** One turn owns the notice, grace period, and bounded wait for its next request boundary. */
export function createSoftSlice(settings: ReturnType<typeof softSliceSettings>, hooks: {
  current(): boolean;
  notice(reason: 'time' | 'compaction', completedCompactions: number): void;
  interrupt(): void;
}) {
  let completedCompactions = 0, started = false, requested = false, waiting = false, stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (callback: () => void, ms: number) => {
    timer = setTimeout(callback, ms);
    timer.unref();
  };
  const request = (reason: 'time' | 'compaction') => {
    if (stopped || requested || !hooks.current()) return;
    requested = true;
    clearTimeout(timer);
    hooks.notice(reason, completedCompactions);
    schedule(() => {
      if (!hooks.current()) return;
      waiting = true;
      schedule(() => {
        waiting = false;
        if (hooks.current()) hooks.interrupt();
      }, BOUNDARY_WAIT_MS);
    }, settings.graceMs);
  };
  const useBoundary = () => {
    if (!waiting || !hooks.current()) return false;
    waiting = false;
    clearTimeout(timer);
    return true;
  };
  return {
    start() {
      if (started || stopped) return;
      started = true;
      if (settings.compactions && completedCompactions >= settings.compactions) request('compaction');
      else if (settings.timeMs) schedule(() => request('time'), settings.timeMs);
    },
    compacted() {
      completedCompactions++;
      if (started && settings.compactions && completedCompactions >= settings.compactions) request('compaction');
    },
    useBoundary,
    get requested() { return requested; },
    stop() { stopped = true; waiting = false; clearTimeout(timer); },
  };
}
