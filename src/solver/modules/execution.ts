import crypto from 'node:crypto';
import type { MathAgentSession } from '../../runtime/codexSession';
import type { SolverProblem } from '../problem';
import type { ContextBundle } from './context';
import type { ResearchOperation } from './value';
import type { ResearchWorker } from './organization';
import { MAX_RESEARCH_NOTES_BYTES } from '../deliveries';

export type ResearchCandidate = Readonly<{
  status: string;
  worktree: string;
  problemReceiptDigest: string;
  operation: ResearchOperation;
  provenance: Readonly<{ workerId: string; threadId: string }>;
}>;

/** Only an explicit JSON final from this completed turn can add advisory handling decisions. */
export function completedGuidanceDecisions(session: MathAgentSession, turnId: string | undefined, status: string): unknown {
  const response = session.lastCompletedResponse;
  if (status !== 'completed' || !turnId || response?.turnId !== turnId ||
      Buffer.byteLength(response.text) > MAX_RESEARCH_NOTES_BYTES) return;
  const text = response.text.trim();
  const fence = /^```(?:json|math|math-plan|math-result|math-review)\s*\n([\s\S]*?)\n```$/u.exec(text);
  try {
    const value: unknown = JSON.parse(fence ? fence[1] : text);
    if (value && typeof value === 'object' && !Array.isArray(value))
      return (value as Record<string, unknown>).guidanceDecisions;
  } catch { /* Ordinary prose and partial JSON never declare a handling decision. */ }
}

/** A closed transport is a failed turn; aborts and other errors keep their original meaning. */
export async function runResearchTurn(session: MathAgentSession, message: string, worktree: string,
  signal: AbortSignal, onStarted: (turnId: string) => void): Promise<string> {
  let status: string;
  try {
    status = await session.run(message, crypto.randomUUID(), worktree, onStarted);
  } catch (error) {
    if (!(error instanceof Error) || !/^math_codex_(?:transport_closed|rpc_timeout:)/u.test(error.message)) throw error;
    status = 'failed';
  }
  signal.throwIfAborted();
  return status;
}

/** M1 writes a candidate; M2 subsequently freezes and fingerprints its actual source. */
export async function executeResearch(task: SolverProblem, context: ContextBundle, operation: ResearchOperation,
  worker: ResearchWorker, session: MathAgentSession, signal: AbortSignal,
  onStarted: (turnId: string) => void): Promise<ResearchCandidate> {
  const status = await runResearchTurn(session, context.message, worker.worktree, signal, onStarted);
  return { status, worktree: worker.worktree, problemReceiptDigest: task.receiptDigest, operation,
    provenance: { workerId: worker.id, threadId: session.threadId } };
}
