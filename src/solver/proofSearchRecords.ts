import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { NextCheckRecord } from './nextCheckContract';
import { assertMathCanonicalPath } from '../math/paths';
import { canonicalMathJson, mathDigest, parseMathJson, readMathFile, writeMathTextDurable } from '../math/mathRuntimeIo';

/** Select a host-authorized next-check target from the current projected records, otherwise the assigned task. */
export function proofSearchTargetForAssignment(assignment: { taskId: string; taskDigest: string },
  currentChecks: readonly NextCheckRecord[], identity: { problemReceiptDigest: string; environmentDigest: string }) {
  const check = currentChecks.find(record => record.taskId === assignment.taskId && record.taskDigest === assignment.taskDigest &&
    record.status === 'pending' && record.scope.problemReceiptDigest === identity.problemReceiptDigest &&
    record.scope.environmentDigest === identity.environmentDigest && record.check.execution?.kind === 'proof-search' &&
    record.check.execution.taskId === record.scope.target.taskId && record.check.execution.taskDigest === record.scope.target.taskDigest);
  return check ? { ...check.scope.target } : { taskId: assignment.taskId, taskDigest: assignment.taskDigest };
}

/** Search state is advisory process history, never a proof receipt or acceptance cache. */
export const MAX_PROOF_SEARCH_CHECKPOINT_BYTES = 4_000_000;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = z.string().min(1).max(256);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const toolUsageSchema = z.object({ issued: counter, completed: counter, replay: counter, durationMs: counter }).strict();
export const proofSearchCheckpointReferenceSchema = z.object({
  path: z.string().min(1).max(4096).refine(value => !value.includes('\0')),
  digest,
}).strict();
export type ProofSearchCheckpointReference = z.infer<typeof proofSearchCheckpointReferenceSchema>;

export const proofSearchScopeSchema = z.object({
  taskId: identity, taskDigest: identity, problemReceiptDigest: identity, environmentDigest: identity,
}).strict();
export type ProofSearchScope = z.infer<typeof proofSearchScopeSchema>;

/** Validate the handoff envelope; the math module owns the full nodes/actions/counters parser. */
export const proofSearchCheckpointEnvelopeSchema = z.object({
  schema: z.literal('theorem-os.proof-search-checkpoint.v1'),
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  basis: z.object({
    scope: proofSearchScopeSchema,
    sourceDigest: digest, projectionDigest: digest, backendDigest: digest,
  }).passthrough(),
}).passthrough();

export const proofSearchRecordSchema = z.object({
  schema: z.literal('theorem-os.proof-search-record.v1'),
  taskId: identity, taskDigest: identity, problemReceiptDigest: identity, environmentDigest: identity,
  sourceDigest: digest, projectionDigest: digest, backendDigest: digest, basisDigest: digest,
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  workerId: identity, assignmentKey: z.string().min(1).max(4096),
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  checkpoint: proofSearchCheckpointReferenceSchema,
  /** Worker-reported tool counters only; these never replace host model usage or proof receipts. */
  toolUsage: toolUsageSchema.optional(),
  evidence: z.literal('advisory-proof-search'), proofAcceptance: z.literal('not-accepted'),
}).strict();
export type ProofSearchRecord = z.infer<typeof proofSearchRecordSchema>;

const invalid = () => new Error('math_proof_search_checkpoint_invalid');
function parsedCheckpoint(reference: ProofSearchCheckpointReference, file: string) {
  assertMathCanonicalPath(file);
  const bytes = readMathFile(file, MAX_PROOF_SEARCH_CHECKPOINT_BYTES).bytes;
  if (mathDigest(bytes) !== reference.digest) throw invalid();
  const parsed = proofSearchCheckpointEnvelopeSchema.safeParse(parseMathJson(bytes, 'math_proof_search_checkpoint_invalid'));
  if (!parsed.success) throw invalid();
  const checkpoint = parsed.data, basisDigest = mathDigest(canonicalMathJson(checkpoint.basis));
  return { checkpoint, basisDigest, bytes };
}

function checkpointPath(projectRoot: string, basisDigest: string, generation: number): string {
  return path.join(path.resolve(projectRoot), '.lake', 'proof-search', basisDigest, `${generation}.json`);
}

/** Read only an exact, regular project scratch checkpoint; an arbitrary artifact path is not an input. */
export function readProofSearchCheckpoint(projectRoot: string, value: ProofSearchCheckpointReference) {
  try {
    const parsed = proofSearchCheckpointReferenceSchema.safeParse(value);
    if (!parsed.success) throw invalid();
    const reference = parsed.data;
    const file = path.isAbsolute(reference.path) ? reference.path : path.join(path.resolve(projectRoot), reference.path);
    const scratch = path.join(path.resolve(projectRoot), '.lake', 'proof-search');
    const relative = path.relative(scratch, file).split(path.sep).join('/');
    if (path.resolve(file) !== file || !/^[a-f0-9]{64}\/(?:0|[1-9][0-9]*)\.json$/u.test(relative)) throw invalid();
    const result = parsedCheckpoint(reference, file);
    if (file !== checkpointPath(projectRoot, result.basisDigest, result.checkpoint.generation)) throw invalid();
    return { ...result, reference: { path: file, digest: reference.digest } };
  } catch { throw invalid(); }
}

export function proofSearchRecordMatches(record: ProofSearchRecord | undefined, scope: ProofSearchScope): record is ProofSearchRecord {
  return Boolean(record && record.taskId === scope.taskId && record.taskDigest === scope.taskDigest &&
    record.problemReceiptDigest === scope.problemReceiptDigest && record.environmentDigest === scope.environmentDigest);
}

/** Capture the worker's exact bytes before its scratch directory is reset or reassigned. */
export function retainProofSearchCheckpoint(input: {
  projectRoot: string; runDirectory: string; reference: ProofSearchCheckpointReference; scope: ProofSearchScope;
  workerId: string; assignmentKey: string; now?: number;
}): ProofSearchRecord {
  const { checkpoint, basisDigest, bytes } = readProofSearchCheckpoint(input.projectRoot, input.reference);
  if (canonicalMathJson(checkpoint.basis.scope) !== canonicalMathJson(input.scope))
    throw new Error('math_proof_search_checkpoint_scope_changed');
  const directory = path.join(path.resolve(input.runDirectory), 'proof-search-artifacts');
  const usage = toolUsageSchema.safeParse(checkpoint.counters);
  try {
    assertMathCanonicalPath(directory);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertMathCanonicalPath(directory);
    const file = path.join(directory, `${input.reference.digest}.json`);
    assertMathCanonicalPath(file);
    writeMathTextDurable(file, bytes.toString('utf8'), 0o400);
    return proofSearchRecordSchema.parse({
      schema: 'theorem-os.proof-search-record.v1', ...input.scope,
      sourceDigest: checkpoint.basis.sourceDigest, projectionDigest: checkpoint.basis.projectionDigest,
      backendDigest: checkpoint.basis.backendDigest, basisDigest, generation: checkpoint.generation,
      workerId: input.workerId, assignmentKey: input.assignmentKey, createdAt: input.now ?? Date.now(),
      checkpoint: { path: file, digest: input.reference.digest },
      ...(usage.success ? { toolUsage: usage.data } : {}),
      evidence: 'advisory-proof-search', proofAcceptance: 'not-accepted',
    });
  } catch { throw new Error('math_proof_search_checkpoint_unavailable'); }
}

/** Arrival order cannot roll back a newer generation of the same fixed search basis. */
export function latestProofSearchRecord(current: ProofSearchRecord | undefined, incoming: ProofSearchRecord): ProofSearchRecord {
  if (!current || current.basisDigest !== incoming.basisDigest || current.generation < incoming.generation) return incoming;
  if (current.generation === incoming.generation && current.checkpoint.digest !== incoming.checkpoint.digest) throw invalid();
  return current;
}

/** Project host-retained bytes to an accessible worker scratch path; old/missing records remain unusable. */
export function projectProofSearchRecord(input: {
  record: ProofSearchRecord | undefined; scope: ProofSearchScope; projectRoot: string; runDirectory: string;
}): ProofSearchRecord | undefined {
  if (!proofSearchRecordMatches(input.record, input.scope)) return;
  try {
    const record = proofSearchRecordSchema.parse(input.record);
    const retained = path.join(path.resolve(input.runDirectory), 'proof-search-artifacts', `${record.checkpoint.digest}.json`);
    if (record.checkpoint.path !== retained) return;
    const { checkpoint, basisDigest, bytes } = parsedCheckpoint(record.checkpoint, retained);
    if (basisDigest !== record.basisDigest || checkpoint.generation !== record.generation ||
        canonicalMathJson(checkpoint.basis.scope) !== canonicalMathJson(input.scope) ||
        checkpoint.basis.sourceDigest !== record.sourceDigest || checkpoint.basis.projectionDigest !== record.projectionDigest ||
        checkpoint.basis.backendDigest !== record.backendDigest) return;
    const file = checkpointPath(input.projectRoot, basisDigest, checkpoint.generation);
    assertMathCanonicalPath(file);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    assertMathCanonicalPath(file);
    writeMathTextDurable(file, bytes.toString('utf8'), 0o400);
    return { ...record, checkpoint: { path: file, digest: record.checkpoint.digest } };
  } catch { return undefined; }
}
