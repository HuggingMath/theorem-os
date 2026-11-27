import fs from 'node:fs';
import path from 'node:path';
import { assertMathCanonicalPath } from '../math/paths';
import { mathDigest, readMathText } from '../math/mathRuntimeIo';
import type { ProofCheck } from './modules/evidence';
import type { ProofReferences } from './proofReferences';
import type { DeliveryArtifactManifest } from './deliveryArtifacts';
import type { CooperativeTask } from './tasks';
import type { KnowledgeUse } from './knowledgeUsage';
import type { ResearchRecord } from './researchRecords';
import { proofSearchCheckpointReferenceSchema, type ProofSearchCheckpointReference } from './proofSearchRecords';
import { mathematicalGapSchema, type MathematicalGap, type MathematicalGapScope } from './mathematicalGaps';
import { checkOutcomeSchema, type CheckOutcome, type NextCheckScope } from './nextCheckContract';
import { researchSourceUseSchema, type ResearchSourceUse } from './researchReferences';

// Long-lived task graphs can exceed a short prompt's display allowance. Keep the
// complete host response bounded by the committed-source reader's byte allowance.
export const MAX_RESEARCH_NOTES_BYTES = 1_000_000;
// Explicit research snapshots carry up to 1 MB of Lean sources alongside the
// complete finding. Allow bounded JSON escaping without rejecting existing files.
export const MAX_DELIVERY_LINE_BYTES = 16_000_000;

export function appendDeliveryEvent(worktree: string, file: string, event: unknown): void {
  if (!/^DELIVERIES-[a-f0-9]{64}\.jsonl$/u.test(file)) throw new Error('math_delivery_log_invalid');
  const output = path.join(worktree, file);
  assertMathCanonicalPath(output);
  const line = JSON.stringify(event) + '\n';
  if (Buffer.byteLength(line) > MAX_DELIVERY_LINE_BYTES) throw new Error('math_delivery_line_too_large');
  const fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
    fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('math_delivery_log_invalid');
    fs.writeFileSync(fd, line);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/** JSON for host decisions, optional Markdown for explanations; legacy fences remain readable. */
export function readMathResponse(worktree: string, legacyFence: string, bindings: Record<string, unknown> = {}, textField?: string): any {
  const file = path.join(worktree, 'RESEARCH.md');
  const errorPrefix = `math_${legacyFence}`;
  let text: string;
  try { assertMathCanonicalPath(file); text = readMathText(file, MAX_RESEARCH_NOTES_BYTES).trim(); }
  catch { throw new Error(`${errorPrefix}_missing_or_too_large`); }
  return parseMathResponse(text, legacyFence, bindings, textField);
}

/** A research control response is explicit; JSON used to explain mathematics stays prose. */
function researchResponse(text: string, textField?: string): unknown {
  const blocks = [...text.matchAll(/```([a-z-]+)\s*\n([\s\S]*?)\n```/gu)];
  const explicit = blocks.filter(block => block[1] === 'math-result');
  if (explicit.length > 1) throw new Error('math_math-result_requires_one_block');
  if (explicit.length) return JSON.parse(explicit[0][2]);
  // A different control response must never become an ordinary research finding.
  if (/```math-[a-z-]+\s*\n/u.test(text)) throw new Error('math_math-result_requires_one_block');
  if (text.startsWith('{')) return JSON.parse(text);
  const researchKeys = /"(?:summary|conclusion|taskId|taskDigest|mathematicalGap|lemmaRequests|remainingObligations|evidenceRefs|blockers|knowledgeUses|leanChecks)"\s*:/u;
  const legacy = blocks.filter(block => {
    if (!['math', 'json'].includes(block[1]) || !block[2].trimStart().startsWith('{')) return false;
    try {
      const value = JSON.parse(block[2]);
      return value && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).some(key => researchKeys.test(JSON.stringify(key) + ':'));
    } catch { return researchKeys.test(block[2]); }
  });
  if (legacy.length > 1) throw new Error('math_math-result_requires_one_block');
  if (legacy.length) return JSON.parse(legacy[0][2]);
  return textField && text ? { [textField]: text } : undefined;
}

const planKeys = /"(?:tasks|groups|proofRoutes|dispatchNonce|baseVersion|upsert|remove)"\s*:/u;
const noteFences = /```([a-z-]+)\s*\n([\s\S]*?)\n```/gu;
/** A fence carries Lead control JSON, not illustrative mathematical JSON. */
function isPlanFence(label: string, body: string): boolean {
  if (label === 'math-plan') return true;
  if (!['math', 'json'].includes(label) || !body.trimStart().startsWith('{')) return false;
  try {
    const value = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) &&
      (Object.keys(value).some(key => planKeys.test(JSON.stringify(key) + ':')) || value.kind === 'plan');
  } catch { return planKeys.test(body); }
}

/** Select the Lead control object without counting illustrative mathematical JSON as a plan. */
function planResponseBody(text: string): string | undefined {
  const blocks = [...text.matchAll(noteFences)];
  const explicit = blocks.filter(block => block[1] === 'math-plan');
  if (explicit.length > 1) throw new Error('math_math-plan_requires_one_block');
  if (explicit.length) return explicit[0][2];
  if (/```math-[a-z-]+\s*\n/u.test(text)) throw new Error('math_math-plan_requires_one_block');
  if (text.startsWith('{')) return text;
  const legacy = blocks.filter(block => isPlanFence(block[1], block[2]));
  if (legacy.length > 1) throw new Error('math_math-plan_requires_one_block');
  return legacy[0]?.[2];
}

/** An explicit but malformed response still needs host validation and feedback. */
export function hasPlanResponse(notes: string): boolean {
  try { return planResponseBody(notes.trim()) !== undefined; } catch { return true; }
}

/** Save one plan block while keeping the surrounding mathematical notes. */
export function replacePlanInNotes(source: string, json: string): string {
  const fence = '```math-plan\n' + json + '\n```';
  const bare = source.trim();
  if (bare.startsWith('{') && isPlanFence('json', bare)) {
    try { JSON.parse(bare); return fence + '\n'; } catch { /* Preserve incomplete text. */ }
  }
  let replaced = false;
  const notes = source.replace(noteFences, (block, label: string, body: string) => {
    if (!isPlanFence(label, body)) return block;
    if (replaced) return '';
    replaced = true;
    return fence;
  });
  return replaced ? notes : fence + '\n' + (source ? '\n' + source : '');
}

/** The same parser also reads immutable checkpoint text without consulting a live workspace. */
export function parseMathResponse(text: string, legacyFence: string, bindings: Record<string, unknown> = {}, textField?: string): any {
  const errorPrefix = `math_${legacyFence}`;
  text = text.trim();
  if (legacyFence === 'math-result' || legacyFence === 'math-plan') {
    const body = legacyFence === 'math-plan' ? planResponseBody(text) : undefined;
    const value = legacyFence === 'math-result' ? researchResponse(text, textField) :
      body === undefined ? undefined : JSON.parse(body);
    if (value === undefined) throw new Error(errorPrefix + '_requires_one_block');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('math_response_invalid');
    return { ...bindings, ...value };
  }
  const blocks = [...text.matchAll(new RegExp('```(?:math|json|' + legacyFence + ')\\s*\\n([\\s\\S]*?)\\n```', 'gu'))]
    .filter(block => !textField || block[1].trimStart().startsWith('{'));
  if (blocks.length > 1) throw new Error(`${errorPrefix}_requires_one_block`);
  // A different control response is not an ordinary Markdown finding.
  if (textField && !blocks.length && /```math-[a-z-]+\s*\n/u.test(text)) throw new Error(`${errorPrefix}_requires_one_block`);
  const value = text.startsWith('{') ? JSON.parse(text) : blocks.length === 1 ? JSON.parse(blocks[0][1]) :
    textField && text ? { [textField]: text } : undefined;
  if (value === undefined) throw new Error(`${errorPrefix}_requires_one_block`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('math_response_invalid');
  return { ...bindings, ...value };
}

export function advisoryEvidenceRefs(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter((ref): ref is string => typeof ref === 'string');
}

export function reviewVerdict(value: unknown, errorCode: string): 'accepted' | 'changes_requested' {
  if (value !== 'accepted' && value !== 'changes_requested') throw new Error(errorCode);
  return value;
}

/** One versioned record for hints, conditional sketches, proofs, reviews and failures. */
export type DeliveryRecord = {
  id: string; submissionId?: string; assignmentKey?: string; statementReviewId?: string; producer: string; taskId?: string; taskDigest?: string; groupId?: string;
  /** Additional submission IDs coalesced into this record within the same assignment. */
  submissionAliases?: readonly string[];
  kind: 'progress' | 'research' | 'proof' | 'review' | 'backtranslation' | 'statement-review' | 'failure';
  status: 'advisory' | 'conditional' | 'verified' | 'failed' | 'superseded' | 'accepted' | 'changes_requested';
  statement: string; premises: readonly string[];
  dependencies: { taskId: string; taskDigest: string }[]; remainingObligations: readonly string[];
  summary: string; evidenceRefs: readonly string[]; createdAt: number; commit?: string; sourceDigest?: string;
  /** Host probe finding retained across publication and archive recovery. */
  hostAdvisorySummary?: string;
  /** Host identity for the complete advisory finding, separate from the short delivery summary. */
  findingDigest?: string;
  /** Each publication retains its own complete finding, including during an active proof. */
  finding?: string;
  /** A later handoff requested a Lead decision on this same immutable finding. */
  leadDecisionRequested?: true;
  researchRecord?: ResearchRecord;
  knowledgeUses?: readonly KnowledgeUse[];
  mathematicalGap?: MathematicalGap;
  mathematicalGapScope?: MathematicalGapScope;
  checkOutcome?: CheckOutcome;
  checkOutcomeScope?: NextCheckScope;
  evidence?: { passed: boolean; verification: Pick<ProofCheck['verification'], 'status' | 'targetCommit'> & { results: { receiptId: string }[] } };
  actualReferences?: ProofReferences;
  artifacts?: DeliveryArtifactManifest;
  artifactWarning?: string;
  /** Host-retained advisory search history; COOPERATION exposes a task-scoped worker copy for recovery. */
  searchCheckpoint?: ProofSearchCheckpointReference;
  lemmaRequests?: readonly CooperativeTask[];
  sourceUses?: readonly ResearchSourceUse[];
};

export function deliveryFinding(record: DeliveryRecord, nodeFinding?: string): string | undefined {
  const finding = record.finding ?? nodeFinding;
  return record.kind === 'research' && typeof finding === 'string' && record.findingDigest === mathDigest(finding)
    ? finding : undefined;
}

export function researchFindingRequestsDecision(record: DeliveryRecord, nodeFinding?: string): boolean {
  if (record.leadDecisionRequested) return true;
  try {
    const finding = JSON.parse(deliveryFinding(record, nodeFinding) ?? 'null');
    return finding?.needsDecision === true || finding?.conclusion === 'refuted';
  } catch { return false; }
}

export function deliveryDetails(value: any): Pick<DeliveryRecord, 'summary' | 'evidenceRefs'> &
  Partial<Pick<DeliveryRecord, 'statement' | 'premises' | 'remainingObligations' | 'mathematicalGap' | 'sourceUses' | 'checkOutcome' | 'searchCheckpoint'>> {
  const strings = (items: unknown) => Array.isArray(items) && items.every(item => typeof item === 'string');
  if (!value || (value.summary !== undefined && typeof value.summary !== 'string') ||
      (value.statement !== undefined && (typeof value.statement !== 'string' || !value.statement.trim())) ||
      (value.premises !== undefined && !strings(value.premises)) ||
      (value.remainingObligations !== undefined && !strings(value.remainingObligations)) ||
      (value.mathematicalGap !== undefined && !mathematicalGapSchema.safeParse(value.mathematicalGap).success) ||
      (value.checkOutcome !== undefined && !checkOutcomeSchema.safeParse(value.checkOutcome).success) ||
      (value.searchCheckpoint !== undefined && (value.kind !== 'progress' ||
        !proofSearchCheckpointReferenceSchema.safeParse(value.searchCheckpoint).success)) ||
      (value.sourceUses !== undefined && (!Array.isArray(value.sourceUses) || value.sourceUses.length > 32 ||
        value.sourceUses.some((item: unknown) => !researchSourceUseSchema.safeParse(item).success)))) throw new Error('math_delivery_invalid');
  const summary = value.summary ?? '';
  // The raw response remains in RESEARCH.md; a long advisory note does not invalidate its verdict or evidence.
  return { summary: summary.length <= 3000 ? summary : summary.slice(0, 2999).replace(/[\uD800-\uDBFF]$/u, '') + '…', evidenceRefs: advisoryEvidenceRefs(value.evidenceRefs),
    ...(value.statement === undefined ? {} : { statement: value.statement }),
    ...(value.premises === undefined ? {} : { premises: value.premises }),
    ...(value.remainingObligations === undefined ? {} : { remainingObligations: value.remainingObligations }),
    ...(value.mathematicalGap === undefined ? {} : { mathematicalGap: mathematicalGapSchema.parse(value.mathematicalGap) }),
    ...(value.checkOutcome === undefined ? {} : { checkOutcome: checkOutcomeSchema.parse(value.checkOutcome) }),
    ...(value.searchCheckpoint === undefined ? {} : { searchCheckpoint: proofSearchCheckpointReferenceSchema.parse(value.searchCheckpoint) }),
    ...(value.sourceUses === undefined ? {} : { sourceUses: value.sourceUses.map((item: unknown) => researchSourceUseSchema.parse(item)) }) };
}

type DeliveryLogEntry = { line?: string; error?: 'math_delivery_line_too_large' | 'math_delivery_log_rewritten'; offset: number;
  discardingOversized: boolean };
type DeliveryLogBatch = { entries: DeliveryLogEntry[]; offset: number; discardingOversized: boolean; hasMore: boolean };

/** Read one bounded batch of complete appended lines, starting at the durable cursor. */
export function readDeliveryLines(file: string, offset: number, discardingOversized = false): DeliveryLogBatch {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('math_delivery_log_invalid');
  if (!fs.existsSync(file)) return { entries: [], offset, discardingOversized, hasMore: false };
  assertMathCanonicalPath(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('math_delivery_log_invalid');
    if (stat.size < offset) {
      // The rewritten bytes may repeat old events. Skip the snapshot and discard any unfinished line.
      const last = Buffer.alloc(1);
      const partial = stat.size > 0 && fs.readSync(fd, last, 0, 1, stat.size - 1) === 1 && last[0] !== 10;
      const entry: DeliveryLogEntry = { error: 'math_delivery_log_rewritten', offset: stat.size, discardingOversized: partial };
      return { entries: [entry], offset: entry.offset, discardingOversized: partial, hasMore: false };
    }
    const buffer = Buffer.alloc(Math.min(stat.size - offset, MAX_DELIVERY_LINE_BYTES + 1));
    const size = fs.readSync(fd, buffer, 0, buffer.length, offset);
    const hasMore = offset + size < stat.size;
    let start = 0;
    // A rejected long line may span several polls; never parse its trailing fragment.
    if (discardingOversized) {
      const newline = buffer.subarray(0, size).indexOf(10);
      if (newline < 0) return { entries: [], offset: offset + size, discardingOversized: true, hasMore };
      start = newline + 1;
      discardingOversized = false;
    }
    const entries: DeliveryLogEntry[] = [];
    while (start < size) {
      const newline = buffer.subarray(0, size).indexOf(10, start);
      if (newline < 0) {
        if (start === 0 && size > MAX_DELIVERY_LINE_BYTES) {
          start = size; discardingOversized = true;
          entries.push({ error: 'math_delivery_line_too_large', offset: offset + start, discardingOversized: true });
        }
        break;
      }
      const line = buffer.subarray(start, newline).toString('utf8');
      start = newline + 1;
      entries.push({ line, offset: offset + start, discardingOversized: false });
    }
    return { entries, offset: offset + start, discardingOversized, hasMore };
  } finally { fs.closeSync(fd); }
}

/** Advance only after the caller handles an entry. Failed intake leaves it available for retry. */
export function* pendingDeliveryLines(file: string, cursors: Record<string, number>, key: string, onAdvance: () => void,
  mode: 'batch' | 'drain' = 'batch') {
  const discardKey = key + '/discardingOversized';
  const advance = ({ offset, discardingOversized }: Pick<DeliveryLogBatch, 'offset' | 'discardingOversized'>) => {
    const discarding = Number(discardingOversized);
    if ((cursors[key] ?? 0) === offset && (cursors[discardKey] ?? 0) === discarding) return;
    cursors[key] = offset;
    cursors[discardKey] = discarding;
    onAdvance();
  };
  for (;;) {
    const offset = cursors[key] ?? 0;
    const batch = readDeliveryLines(file, offset, cursors[discardKey] === 1);
    for (const entry of batch.entries) {
      yield entry;
      advance(entry);
    }
    advance(batch);
    if (mode === 'batch' || !batch.hasMore || batch.offset <= offset) return;
  }
}
