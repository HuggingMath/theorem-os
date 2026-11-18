import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';

const count = z.number().int().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const marker = 'theorem-os.single-continuation-history.v1';
const tokens = z.object({ inputTokens: count.optional(), outputTokens: count.optional(), totalTokens: count.optional(),
  cachedInputTokens: count.optional(), reasoningOutputTokens: count.optional() });
const activity = z.object({ turns: count, usage: tokens.optional(), usageBeforeThread: tokens.optional(),
  dispatchCounts: z.object({ planning: count.optional(), research: count.optional(), proof: count.optional(), review: count.optional() }).optional(),
  usageAccounting: z.object({ startedTurns: count, reportedTurns: count, pending: z.boolean(), incomplete: z.boolean() }).optional(),
  requestUsageAccounting: z.object({ startedRequests: count, reportedRequests: count, pendingRequests: count, incomplete: z.boolean() }).optional() });
const worker = activity.extend({ id: z.string(), role: z.string() });
const history = activity.extend({ runId: z.string(), taskDigest: z.string(), buildDigest: z.string(),
  environmentDigest: z.string(), methodDigest: z.string().optional(), phase: z.string(),
  workers: z.array(worker).optional(),
  cooperation: z.object({ planVersion: z.string().optional(), canonicalCommit: z.string().optional() }).optional() });

/** Do not put a runnable checkpoint, private instructions or provider transcripts in a new run's attachments. */
export function singleContinuationHistory(state: unknown, stateDigest: string) {
  return canonicalMathJson({ schema: marker, stateDigest: hash.parse(stateDigest), ...history.parse(state) });
}

export function continuationActivity(state: unknown, workers: readonly unknown[]) {
  return { ...activity.parse(state), workers: workers.map(item => worker.parse(item)) };
}

const recordSchema = 'theorem-os.continuation-text-record.v1';
const record = z.object({ schema: z.literal(recordSchema), id: z.string(), kind: z.string(),
  provenance: z.object({ source: z.string().optional(), runId: z.string().optional(), commit: z.string().optional(),
    evidence: z.enum(['unverified', 'recorded-not-replayed']) }),
  textLength: count, textBytes: count, textSha256: hash });

/** Old snapshots renamed attachments on every generation and bundled overflow into length-framed records. */
export function inheritedContinuationText(kind: string, text: string, depth = 0): string {
  if (kind !== 'diagnostics') return text;
  const end = text.indexOf('\n');
  let first;
  try { first = JSON.parse(end < 0 ? text : text.slice(0, end)); } catch { /* pretty-printed JSON or ordinary prose */ }
  if (first?.schema === recordSchema) {
    if (depth >= 64) throw new Error('math_continuation_archive_nesting_invalid');
    const output: string[] = [];
    let offset = 0;
    while (offset < text.length) {
      const nl = text.indexOf('\n', offset);
      if (nl < 0) throw new Error('math_continuation_archive_record_invalid');
      const h = record.parse(JSON.parse(text.slice(offset, nl)));
      const body = text.slice(nl + 1, nl + 1 + h.textLength);
      offset = nl + 1 + h.textLength;
      if (text[offset++] !== '\n' || Buffer.byteLength(body) !== h.textBytes || mathDigest(body) !== h.textSha256)
        throw new Error('math_continuation_archive_record_changed');
      const clean = inheritedContinuationText(h.kind, body, depth + 1);
      output.push(canonicalMathJson({ ...h, textLength: clean.length, textBytes: Buffer.byteLength(clean), textSha256: mathDigest(clean) }),
        '\n', clean, '\n');
    }
    return output.join('');
  }
  let parsed;
  try { parsed = end < 0 ? first : JSON.parse(text); } catch { return text; }
  if (parsed?.schema === 'deepscientist.math.solver.v1') return singleContinuationHistory(parsed, mathDigest(text));
  if (parsed?.schema === marker) return singleContinuationHistory(parsed, parsed.stateDigest);
  if (parsed?.capture === 'canonical-commit-and-individually-stable-advisory-worker-files' && parsed.history?.activity) {
    const data = parsed.history.activity;
    return canonicalMathJson({ ...parsed, history: { ...parsed.history, activity: continuationActivity(data, data.workers) } });
  }
  return text;
}
