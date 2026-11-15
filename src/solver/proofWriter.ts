import type { MathAgentSession } from '../runtime/agentSession';
import type { SolverRunState } from './archive';

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
