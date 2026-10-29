/** A long positive budget must not overflow Node's 32-bit timer and expire immediately. */
export function scheduleMathTimeout(callback: () => void, delayMs: number): () => void {
  if (!Number.isFinite(delayMs)) return () => {};
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined, cancelled = false;
  const schedule = () => {
    const remaining = Math.max(0, delayMs - (Date.now() - startedAt));
    timer = setTimeout(() => {
      if (cancelled) return;
      if (delayMs - (Date.now() - startedAt) > 0) schedule();
      else callback();
    }, Math.min(remaining, 2_147_483_647));
  };
  schedule();
  return () => { cancelled = true; clearTimeout(timer); };
}
