import fs from 'node:fs';
import path from 'node:path';
import { mathDigest } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import type { SolverRunState } from './archive';
import { appendDeliveryEvent, MAX_RESEARCH_NOTES_BYTES } from './deliveries';

type CheckpointResearch = Pick<SolverRunState, 'threadId' | 'contextCheckpoint'>;
export type ContextCheckpointRejection = { threadId: string; requestId: string; file: string; offset: number; reason: string };
const digestPattern = /^[a-f0-9]{64}$/u;

/** Diagnostics belong to the current thread's request, including after its plan was published. */
export function contextCheckpointRejection(research: CheckpointResearch): ContextCheckpointRejection | undefined {
  const request = research.contextCheckpoint;
  if (!research.threadId || request?.threadId !== research.threadId || !request.requestId || !request.rejection) return;
  return { threadId: request.threadId, requestId: request.requestId, ...request.rejection };
}

export function contextCheckpointRejectionFeedback(rejection: ContextCheckpointRejection | undefined,
  file: string | undefined): string | undefined {
  if (!rejection || !file) return;
  return 'Host rejected the current context checkpoint acknowledgment:\n' + JSON.stringify(rejection) + '\n' +
    'Save the current argument and unresolved inference in RESEARCH.md. From the worktree root rerun checkpoint with ' +
    '--log ' + file + ' --request-id ' + JSON.stringify(rejection.requestId) + ', then return.';
}

export function queueContextCheckpoint(worktree: string, file: string, requestId: string) {
  const notesDigest = readCheckpointNotesDigest(worktree);
  if (!notesDigest) throw new Error('Save your current research in a nonempty RESEARCH.md before acknowledging the checkpoint.');
  appendDeliveryEvent(worktree, file, { kind: 'checkpoint', requestId, notesDigest });
  return { status: 'queued', file };
}

export function readCheckpointNotesDigest(worktree: string): string | undefined {
  const file = path.join(worktree, 'RESEARCH.md');
  let fd: number | undefined;
  try {
    assertMathCanonicalPath(file);
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RESEARCH_NOTES_BYTES) return undefined;
    const text = fs.readFileSync(fd, 'utf8');
    return text.trim() ? mathDigest(text) : undefined;
  } catch { return undefined; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** A fresh publication hands back writing; unchanged accurate notes are sufficient. */
export function savedContextCheckpoint(research: CheckpointResearch, worktree: string): string | undefined {
  const request = research.contextCheckpoint;
  if (!research.threadId || request?.threadId !== research.threadId || !request.requestId ||
      !request.publishedNotesDigest || !digestPattern.test(request.publishedNotesDigest)) return undefined;
  return readCheckpointNotesDigest(worktree) === request.publishedNotesDigest ? request.publishedNotesDigest : undefined;
}

/** Scheduling acknowledgment only: this neither publishes mathematics nor accepts a proof. */
export function acceptContextCheckpoint(research: CheckpointResearch, worktree: string, value: unknown): void {
  const request = research.contextCheckpoint;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('math_delivery_invalid');
  const event = value as Record<string, unknown>;
  if (event.kind !== 'checkpoint' || !research.threadId || request?.threadId !== research.threadId ||
      !request.requestId || event.requestId !== request.requestId || typeof event.notesDigest !== 'string' ||
      !digestPattern.test(event.notesDigest) || readCheckpointNotesDigest(worktree) !== event.notesDigest)
    throw new Error('math_delivery_invalid');
  request.publishedNotesDigest = event.notesDigest;
  request.publishedAt = Date.now();
  delete request.rejection;
}
