import type { EventEmitter } from 'node:events';

export const webWorkerDisconnectGraceMs = 30_000;
export const webWorkerHeartbeatMs = 5_000;
export const webWorkerShutdownMs = 20_000;

export function createWebHostDisconnectWatchdog(output: Pick<EventEmitter, 'on' | 'off'>,
  options: { graceMs?: number; onAbort?(): void } = {}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disconnected = false, stopped = false;
  const graceMs = options.graceMs ?? webWorkerDisconnectGraceMs;
  const arm = () => {
    timer = setTimeout(() => {
      timer = undefined;
      controller.abort('host_disconnected');
      options.onAbort?.();
    }, graceMs);
  };
  const disconnect = () => {
    disconnected = true;
    if (!stopped && !timer && !controller.signal.aborted) arm();
  };
  output.on('error', disconnect);
  output.on('close', disconnect);
  return {
    signal: controller.signal,
    disconnect,
    heartbeat() {
      if (stopped || disconnected || controller.signal.aborted) return;
      clearTimeout(timer);
      arm();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      output.off('error', disconnect);
      output.off('close', disconnect);
    },
  };
}
