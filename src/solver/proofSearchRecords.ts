import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { NextCheckRecord } from './nextCheckContract';
import { assertMathCanonicalPath } from '../math/paths';
import { canonicalMathJson, mathDigest, parseMathJson, readMathFile, writeMathTextDurable } from '../math/mathRuntimeIo';
import { localProofSearchPath, projectedProofSearchPath } from '../math/proofSearchCheckpointPath';
import type { DeliveryRecord } from './deliveries';

export function proofSearchCheckForAssignment(assignment: { taskId: string; taskDigest: string },
  currentChecks: readonly NextCheckRecord[], identity: { problemReceiptDigest: string; environmentDigest: string }) {
  return currentChecks.find(record => record.taskId === assignment.taskId && record.taskDigest === assignment.taskDigest &&
    record.status === 'pending' && record.scope.problemReceiptDigest === identity.problemReceiptDigest &&
    record.scope.environmentDigest === identity.environmentDigest && record.check.execution?.kind === 'proof-search' &&
    record.check.execution.taskId === record.scope.target.taskId && record.check.execution.taskDigest === record.scope.target.taskDigest);
}

/** The Lean target is shared. The assigned check owns its separate history. */
export function proofSearchTargetForAssignment(assignment: { taskId: string; taskDigest: string },
  currentChecks: readonly NextCheckRecord[], identity: { problemReceiptDigest: string; environmentDigest: string }) {
  return proofSearchCheckForAssignment(assignment, currentChecks, identity)?.scope.target ??
    { taskId: assignment.taskId, taskDigest: assignment.taskDigest };
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
  assignmentKey: z.string().min(1).max(4096).optional(),
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
  history: digest.optional(),
  workerId: identity, assignmentKey: z.string().min(1).max(4096),
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  checkpoint: proofSearchCheckpointReferenceSchema,
  /** Worker-reported tool counters only; these never replace host model usage or proof receipts. */
  toolUsage: toolUsageSchema.optional(),
  evidence: z.literal('advisory-proof-search'), proofAcceptance: z.literal('not-accepted'),
}).strict();
export type ProofSearchRecord = z.infer<typeof proofSearchRecordSchema>;

const invalid = () => new Error('math_proof_search_checkpoint_invalid');
function parseCheckpoint(bytes: Buffer, checkpointDigest: string) {
  if (bytes.length > MAX_PROOF_SEARCH_CHECKPOINT_BYTES || mathDigest(bytes) !== checkpointDigest) throw invalid();
  const parsed = proofSearchCheckpointEnvelopeSchema.safeParse(parseMathJson(bytes, 'math_proof_search_checkpoint_invalid'));
  if (!parsed.success) throw invalid();
  const checkpoint = parsed.data, basisDigest = mathDigest(canonicalMathJson(checkpoint.basis));
  return { checkpoint, basisDigest, bytes };
}

function parsedCheckpoint(reference: ProofSearchCheckpointReference, file: string) {
  assertMathCanonicalPath(file);
  return parseCheckpoint(readMathFile(file, MAX_PROOF_SEARCH_CHECKPOINT_BYTES).bytes, reference.digest);
}

function retainedCheckpointPath(runDirectory: string, checkpointDigest: string) {
  return path.join(path.resolve(runDirectory), 'proof-search-artifacts', digest.parse(checkpointDigest) + '.json');
}

function readRetainedCheckpoint(runDirectory: string, reference: ProofSearchCheckpointReference) {
  const file = retainedCheckpointPath(runDirectory, reference.digest);
  if (reference.path !== file) throw invalid();
  return parsedCheckpoint(reference, file);
}

function assertRetainedCheckpoint(record: ProofSearchRecord, saved: ReturnType<typeof parseCheckpoint>) {
  const { checkpoint, basisDigest, bytes } = saved;
  if (basisDigest !== record.basisDigest || checkpoint.generation !== record.generation ||
      !proofSearchRecordMatches(checkpoint.basis.scope, record) ||
      checkpoint.assignmentKey && checkpoint.assignmentKey !== record.assignmentKey ||
      checkpoint.basis.sourceDigest !== record.sourceDigest || checkpoint.basis.projectionDigest !== record.projectionDigest ||
      checkpoint.basis.backendDigest !== record.backendDigest) throw invalid();
  if (mathDigest(bytes.toString('utf8')) !== record.checkpoint.digest) throw invalid();
}

function writeCheckpoint(file: string, text: string) {
  assertMathCanonicalPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  assertMathCanonicalPath(file);
  writeMathTextDurable(file, text, 0o400);
}

function checkpointRecord(saved: ReturnType<typeof parsedCheckpoint>, reference: ProofSearchCheckpointReference,
  origin: Pick<ProofSearchRecord, 'workerId' | 'assignmentKey' | 'createdAt' | 'history'>): ProofSearchRecord {
  const { checkpoint, basisDigest } = saved;
  const usage = toolUsageSchema.safeParse(checkpoint.counters);
  return proofSearchRecordSchema.parse({
    schema: 'theorem-os.proof-search-record.v1', ...checkpoint.basis.scope,
    sourceDigest: checkpoint.basis.sourceDigest, projectionDigest: checkpoint.basis.projectionDigest,
    backendDigest: checkpoint.basis.backendDigest, basisDigest, generation: checkpoint.generation,
    ...origin, checkpoint: reference, ...(usage.success ? { toolUsage: usage.data } : {}),
    evidence: 'advisory-proof-search', proofAcceptance: 'not-accepted',
  });
}

/** Read only an exact, regular project scratch checkpoint; an arbitrary artifact path is not an input. */
export function readProofSearchCheckpoint(projectRoot: string, value: ProofSearchCheckpointReference, history?: string) {
  try {
    const parsed = proofSearchCheckpointReferenceSchema.safeParse(value);
    if (!parsed.success) throw invalid();
    const reference = parsed.data;
    const file = path.isAbsolute(reference.path) ? reference.path : path.join(path.resolve(projectRoot), reference.path);
    const scratch = path.join(path.resolve(projectRoot), '.lake', 'proof-search');
    const relative = path.relative(scratch, file).split(path.sep), name = relative.pop() ?? '';
    if (history && relative.pop() !== digest.parse(history)) throw invalid();
    if (path.resolve(file) !== file || relative.length !== 1 || !/^[a-f0-9]{64}$/u.test(relative[0]!) ||
        !/^(?:0|[1-9][0-9]*|retained-(?:0|[1-9][0-9]*)-[a-f0-9]{64})\.json$/u.test(name)) throw invalid();
    const result = parsedCheckpoint(reference, file);
    const root = path.resolve(projectRoot);
    if (file !== localProofSearchPath(root, result.basisDigest, result.checkpoint.generation, history) &&
        file !== projectedProofSearchPath(root, result.basisDigest, result.checkpoint.generation, reference.digest, history)) throw invalid();
    return { ...result, reference: { path: file, digest: reference.digest } };
  } catch { throw invalid(); }
}

export function proofSearchRecordMatches<T extends ProofSearchScope>(record: T | undefined, scope: ProofSearchScope): record is T {
  return Boolean(record && record.taskId === scope.taskId && record.taskDigest === scope.taskDigest &&
    record.problemReceiptDigest === scope.problemReceiptDigest && record.environmentDigest === scope.environmentDigest);
}

/** The host keeps one record per independent task, or starts the check at its pinned seed. */
export function proofSearchRecordForAssignment(records: Readonly<Record<string, ProofSearchRecord>> | undefined,
  scope: ProofSearchScope, check?: NextCheckRecord) {
  const target = records?.[scope.taskId];
  if (!check) return proofSearchRecordMatches(target, scope) ? target : undefined;
  const basis = check.scope.executionBasisDigest;
  const own = records?.[check.taskId];
  if (proofSearchRecordMatches(own, scope) && own.history === check.id && (!basis || own.basisDigest === basis)) return own;
  const seed = check.proofSearchSeed ?? target; // Older archives only retained the target's latest checkpoint.
  if (basis && proofSearchRecordMatches(seed, scope) && seed.basisDigest === basis) return seed;
}

/** Capture the worker's exact bytes before its scratch directory is reset or reassigned. */
export function retainProofSearchCheckpoint(input: {
  projectRoot: string; runDirectory: string; reference: ProofSearchCheckpointReference; scope: ProofSearchScope;
  workerId: string; assignmentKey: string; now?: number; history?: string; requiredBasisDigest?: string;
}): ProofSearchRecord {
  const saved = readProofSearchCheckpoint(input.projectRoot, input.reference, input.history);
  if (!proofSearchRecordMatches(saved.checkpoint.basis.scope, input.scope) ||
      saved.checkpoint.assignmentKey && saved.checkpoint.assignmentKey !== input.assignmentKey ||
      input.requiredBasisDigest && saved.basisDigest !== input.requiredBasisDigest)
    throw new Error('math_proof_search_checkpoint_scope_changed');
  try {
    const file = retainedCheckpointPath(input.runDirectory, input.reference.digest);
    writeCheckpoint(file, saved.bytes.toString('utf8'));
    return checkpointRecord(saved, { path: file, digest: input.reference.digest }, {
      history: input.history, workerId: input.workerId, assignmentKey: input.assignmentKey, createdAt: input.now ?? Date.now(),
    });
  } catch { throw new Error('math_proof_search_checkpoint_unavailable'); }
}

/** A delivery binds an older exact artifact to the worker and assignment that produced it. */
export function historicalProofSearchRecord(input: {
  digest: string; runDirectory: string; scope: ProofSearchScope; basisDigest?: string;
  deliveries: readonly DeliveryRecord[]; nextChecks?: readonly NextCheckRecord[];
}): ProofSearchRecord | undefined {
  const { scope } = input;
  for (const delivery of input.deliveries) {
    const { searchCheckpoint, assignmentKey } = delivery;
    if (delivery.kind !== 'progress' || delivery.status === 'superseded' || !assignmentKey ||
        searchCheckpoint?.digest !== input.digest) continue;
    const owner = delivery.taskId === scope.taskId && delivery.taskDigest === scope.taskDigest;
    const check = owner ? undefined : input.nextChecks?.find(record => record.taskId === delivery.taskId &&
      record.taskDigest === delivery.taskDigest && record.scope.target.taskId === scope.taskId &&
      record.scope.target.taskDigest === scope.taskDigest && record.scope.problemReceiptDigest === scope.problemReceiptDigest &&
      record.scope.environmentDigest === scope.environmentDigest && record.check.execution?.kind === 'proof-search');
    if (!owner && !check) continue;
    try {
      const saved = readRetainedCheckpoint(input.runDirectory, searchCheckpoint);
      if (!proofSearchRecordMatches(saved.checkpoint.basis.scope, scope) ||
          saved.checkpoint.assignmentKey && saved.checkpoint.assignmentKey !== assignmentKey ||
          input.basisDigest && saved.basisDigest !== input.basisDigest ||
          check?.scope.executionBasisDigest && saved.basisDigest !== check.scope.executionBasisDigest) continue;
      return checkpointRecord(saved, searchCheckpoint, { history: check?.id, workerId: delivery.producer,
        assignmentKey, createdAt: delivery.createdAt });
    } catch { continue; }
  }
}

/** Arrival order cannot roll back a newer generation of the same fixed search basis. */
export function latestProofSearchRecord(current: ProofSearchRecord | undefined, incoming: ProofSearchRecord): ProofSearchRecord {
  if (!current || current.basisDigest !== incoming.basisDigest || current.generation < incoming.generation) return incoming;
  if (current.generation === incoming.generation && current.checkpoint.digest !== incoming.checkpoint.digest) throw invalid();
  return current;
}

/** Project host-retained bytes to an accessible worker scratch path; old/missing records remain unusable. */
export function projectProofSearchRecord(input: {
  record: ProofSearchRecord | undefined; scope: ProofSearchScope; projectRoot: string; runDirectory: string; history?: string;
}): ProofSearchRecord | undefined {
  if (!proofSearchRecordMatches(input.record, input.scope)) return;
  try {
    const record = proofSearchRecordSchema.parse(input.record);
    const text = readRetainedProofSearchText(input.runDirectory, record);
    const file = projectedProofSearchPath(path.resolve(input.projectRoot), record.basisDigest, record.generation, record.checkpoint.digest,
      digest.optional().parse(input.history ?? record.history));
    writeCheckpoint(file, text);
    return { ...record, checkpoint: { path: file, digest: record.checkpoint.digest } };
  } catch { return undefined; }
}

export function readRetainedProofSearchText(runDirectory: string, record: ProofSearchRecord) {
  const saved = readRetainedCheckpoint(runDirectory, record.checkpoint);
  assertRetainedCheckpoint(record, saved);
  return saved.bytes.toString('utf8');
}

export function installRetainedProofSearchText(runDirectory: string, record: ProofSearchRecord, text: string) {
  assertRetainedCheckpoint(record, parseCheckpoint(Buffer.from(text, 'utf8'), record.checkpoint.digest));
  writeCheckpoint(retainedCheckpointPath(runDirectory, record.checkpoint.digest), text);
}

export function relocateRetainedProofSearchRecord(runDirectory: string, record: ProofSearchRecord): ProofSearchRecord {
  return { ...record, checkpoint: { ...record.checkpoint, path: retainedCheckpointPath(runDirectory, record.checkpoint.digest) } };
}
