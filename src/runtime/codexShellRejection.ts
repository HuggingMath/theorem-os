import fs from 'node:fs';
import path from 'node:path';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';

type Json = Record<string, unknown>;
export type CodexShellRejection = Readonly<{ callId: string; reason: 'justification' | 'login' }>;
const record = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Json : undefined;
const rejectionReasons = new Map<string, CodexShellRejection['reason']>([
  ['`justification` requires an explicit `sandbox_permissions`; use `sandbox_permissions: "require_escalated"` for unsandboxed execution, or omit `justification`.', 'justification'],
  ['login shell is disabled by config; omit `login` or set it to false.', 'login'],
]);
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Native argument rejections have no public commandExecution item. Read only the
 * exact session rollout returned by app-server, never search other sessions or
 * infer execution failure from shell output. No command or reasoning is returned.
 */
export class CodexShellRejectionReader {
  private offset = 0;
  private identity?: string;
  private partial = Buffer.alloc(0);
  private oversized = false;
  private turn?: string;
  private calls = new Set<string>();
  private reported = new Set<string>();

  private constructor(private file: string) {}

  static create(profile: string, threadId: string, rolloutPath: unknown): CodexShellRejectionReader | undefined {
    if (typeof rolloutPath !== 'string' || !path.isAbsolute(rolloutPath)
      || !isMathPathWithin(path.join(profile, 'sessions'), rolloutPath)
      || !path.basename(rolloutPath).endsWith(`-${threadId}.jsonl`)) return;
    try { assertMathCanonicalPath(rolloutPath); }
    catch { return; }
    return new CodexShellRejectionReader(rolloutPath);
  }

  /** Skip existing history on every run, including resumed threads. */
  beginTurn(): void {
    this.reset(); this.identity = undefined; this.offset = 0;
    try {
      assertMathCanonicalPath(this.file);
      const status = fs.lstatSync(this.file);
      if (status.isFile() && status.nlink === 1) {
        this.offset = status.size; this.identity = `${status.dev}:${status.ino}`;
      }
    } catch { /* A fresh thread may not have flushed its rollout yet. */ }
  }

  private reset(): void {
    this.partial = Buffer.alloc(0); this.oversized = false;
    this.turn = undefined; this.calls.clear(); this.reported.clear();
  }

  poll(activeTurn: string): CodexShellRejection[] {
    let descriptor: number | undefined;
    try {
      assertMathCanonicalPath(this.file);
      descriptor = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const status = fs.fstatSync(descriptor);
      if (!status.isFile() || status.nlink !== 1) return [];
      const identity = `${status.dev}:${status.ino}`;
      if (this.identity !== undefined && (this.identity !== identity || status.size < this.offset)) {
        // Replaced or truncated history is not new tool evidence. Rejoin at its
        // current end and wait for a newly appended turn_context and call pair.
        this.reset(); this.identity = identity; this.offset = status.size; return [];
      }
      this.identity = identity;
      const buffer = Buffer.alloc(Math.min(Math.max(0, status.size - this.offset), MAX_READ_BYTES));
      const size = fs.readSync(descriptor, buffer, 0, buffer.length, this.offset);
      this.offset += size;
      const rejected: CodexShellRejection[] = [];
      let start = 0;
      while (start < size) {
        const newline = buffer.indexOf(10, start), end = newline < 0 || newline >= size ? size : newline;
        const piece = buffer.subarray(start, end);
        if (this.partial.length + piece.length > MAX_LINE_BYTES) { this.oversized = true; this.partial = Buffer.alloc(0); }
        if (!this.oversized) this.partial = Buffer.concat([this.partial, piece]);
        if (end === size) break;
        if (!this.oversized) {
          const event = this.consume(this.partial, activeTurn);
          if (event) rejected.push(event);
        }
        this.partial = Buffer.alloc(0); this.oversized = false; start = end + 1;
      }
      return rejected;
    } catch { return []; /* Optional observation cannot change the native execution outcome. */ }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }

  private consume(line: Buffer, activeTurn: string): CodexShellRejection | undefined {
    let event: Json | undefined;
    try { event = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))); }
    catch { return; }
    const payload = record(event?.payload);
    if (!event || !payload) return;
    if (event.type === 'turn_context') {
      const turn = typeof payload.turn_id === 'string' ? payload.turn_id : undefined;
      if (this.turn !== turn) { this.calls.clear(); this.turn = turn; }
      return;
    }
    if (event.type !== 'response_item' || this.turn !== activeTurn || typeof payload.call_id !== 'string') return;
    const callId = payload.call_id;
    if (payload.type === 'function_call' && payload.name === 'exec_command') { this.calls.add(callId); return; }
    if (payload.type !== 'function_call_output' || !this.calls.delete(callId) || this.reported.has(callId)) return;
    const reason = typeof payload.output === 'string' ? rejectionReasons.get(payload.output) : undefined;
    if (!reason) return;
    this.reported.add(callId);
    return { callId, reason };
  }
}
