import type { MathAgentSession } from '../runtime/agentSession';
import type { SolverRunState } from './archive';

/** Opening can fail before the caller has a session to stop. */
export function recordUnconfirmedWriterStartup(record: Pick<SolverRunState, 'writerStopUnconfirmed'>, error: unknown, save: () => void): boolean {
  if (!(error instanceof Error) || error.message !== 'math_codex_startup_shutdown_unconfirmed') return false;
  record.writerStopUnconfirmed = { at: Date.now(), reason: error.message };
  save();
  return true;
}

/** Confirm that every writer has stopped before any caller freezes proof sources. */
export async function stopProofWriter(input: {
  session: MathAgentSession;
  record: Pick<SolverRunState, 'writerStopUnconfirmed'>;
  workerId: string;
  close: () => Promise<void>;
  save: () => void;
  deferred: (reason: string) => void;
}): Promise<void> {
  let stopped: Awaited<ReturnType<NonNullable<MathAgentSession['stopForFreeze']>>> | undefined;
  try { stopped = await input.session.stopForFreeze?.(); }
  catch { stopped = { status: 'unconfirmed', reason: 'shutdown-failed' }; }
  if (stopped?.status !== 'stopped') {
    const reason = stopped?.reason ?? 'writer-stop-confirmation-unavailable';
    input.record.writerStopUnconfirmed = { at: Date.now(), reason };
    input.deferred(reason);
    input.save();
    try { await input.close(); } catch { /* Persisted quarantine controls subsequent reuse. */ }
    throw new Error('math_writer_stop_unconfirmed:' + input.workerId + ':' + reason);
  }
  await input.close();
}
