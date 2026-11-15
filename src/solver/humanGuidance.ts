import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { canonicalMathJson, mathDigest, readMathText, withMathRuntimeLease, writeMathJsonDurable } from '../math/mathRuntimeIo';
import { isAllowedMathProofSource } from '../math/mathProofSourcePolicy';
import { repositoryRelativePath } from '../math/paths';
import { mathGitBytes } from '../math/mathGit';
import { ownedSourceDigest } from './cooperativeProof';
import type { SolverRunState } from './archive';
import { readRunInspection } from './inspection';
import { taskVersion } from './tasks';

const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u);
const taskRef = z.object({ id: identity, version: z.string().min(1).max(128) }).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const candidateSchema = z.object({
  source: z.string().min(1).max(128 * 1024).refine(value => !value.includes('\0') && Buffer.byteLength(value) <= 128 * 1024 &&
    Buffer.from(value, 'utf8').toString('utf8') === value),
  file: z.string().min(1).max(512).refine(value => repositoryRelativePath(value) === value &&
    !/[\u0000-\u001f\u007f]/u.test(value) && isAllowedMathProofSource(value)),
  sourceDigest: hash, baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  baseSourceDigest: hash, environmentDigest: hash, taskRef,
}).strict().refine(value => mathDigest(value.source) === value.sourceDigest, 'Candidate source digest does not match its UTF-8 bytes.');
export type HumanGuidanceCandidate = {
  source: string; file: string; sourceDigest: string; baseCommit: string; baseSourceDigest: string;
  environmentDigest: string; taskRef: { id: string; version: string };
};
const scopeSchema = z.object({ taskRef: taskRef.optional(), planVersion: z.string().min(1).max(128).optional() }).strict();
const evidenceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edit'), id: identity }).strict(),
  z.object({ kind: z.literal('task'), ...taskRef.shape }).strict(),
  z.object({ kind: z.literal('plan'), version: z.string().min(1).max(128) }).strict(),
]);
export const humanGuidanceDecisionSchema = z.object({
  guidanceId: identity, status: z.enum(['accepted', 'declined', 'needs-info']),
  reason: z.string().trim().min(1).max(2000).refine(value => !value.includes('\0')),
  evidenceRefs: z.array(evidenceRefSchema).max(32).default([]),
}).strict();
export type HumanGuidanceScope = { taskRef?: { id: string; version: string }; planVersion?: string };
export type HumanGuidanceDecisionInput = {
  guidanceId: string; status: 'accepted' | 'declined' | 'needs-info'; reason: string;
  evidenceRefs: ({ kind: 'edit'; id: string } | { kind: 'task'; id: string; version: string } | { kind: 'plan'; version: string })[];
};
export type HumanGuidanceDecision = HumanGuidanceDecisionInput & {
  workerId: string; decidedAt: string; sourceTaskRef?: { id: string; version: string }; sourcePlanVersion?: string;
};
const decisionRecordSchema = humanGuidanceDecisionSchema.extend({ workerId: identity, decidedAt: z.string().datetime(),
  sourceTaskRef: taskRef.optional(), sourcePlanVersion: z.string().min(1).max(128).optional() }).strict();
export const humanGuidanceInputSchema = z.object({
  id: identity,
  recipient: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('lead'), id: identity.optional() }).strict(),
    z.object({ kind: z.literal('task'), id: identity }).strict(),
    z.object({ kind: z.literal('worker'), id: identity }).strict(),
  ]),
  taskRef: taskRef.optional(),
  candidate: candidateSchema.optional(),
  text: z.string().min(1).max(8_000).refine(value => Boolean(value.trim()) && !value.includes('\0') && Buffer.byteLength(value) <= 16_000),
  observationRef: z.object({ sequence: z.number().int().nonnegative(), stateDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
}).strict().refine(value => (value.recipient.kind !== 'task' || value.taskRef?.id === value.recipient.id) &&
  (!value.candidate || value.recipient.kind === 'task' && value.taskRef !== undefined && value.taskRef.id === value.candidate.taskRef.id &&
    value.taskRef.version === value.candidate.taskRef.version),
  'Task guidance and candidate attachments require the exact observed task version.');

export type HumanGuidanceInput = {
  id: string; recipient: { kind: 'lead'; id?: string } | { kind: 'task' | 'worker'; id: string };
  taskRef?: { id: string; version: string }; text: string;
  candidate?: HumanGuidanceCandidate;
  observationRef: { sequence: number; stateDigest: string };
};
const recordSchema = z.object({ ...humanGuidanceInputSchema.innerType().shape,
  status: z.enum(['queued', 'delivered', 'deferred', 'failed']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  deliveredTo: z.array(identity).optional(), reason: z.string().max(2_000).optional(),
  deliveredScope: scopeSchema.optional(), decision: decisionRecordSchema.optional(),
}).strict();
export type HumanGuidanceRecord = HumanGuidanceInput & {
  status: 'queued' | 'delivered' | 'deferred' | 'failed'; createdAt: string; updatedAt: string;
  deliveredTo?: string[]; reason?: string; deliveredScope?: HumanGuidanceScope; decision?: HumanGuidanceDecision;
};
const storeSchema = z.object({ schema: z.literal('theorem-os.human-guidance.v1'), runId: z.string().min(1),
  records: z.array(recordSchema).max(512) }).strict();
const guidanceFile = (stateFile: string) => path.join(path.dirname(stateFile), 'human-guidance.json');
const maxBytes = 12 * 1024 * 1024;

/** Human input is separate from the mathematical checkpoint and never changes its plan. */
export function readHumanGuidance(stateFile: string, runId: string): HumanGuidanceRecord[] {
  const file = guidanceFile(stateFile);
  if (!fs.existsSync(file)) return [];
  const parsed = storeSchema.safeParse(JSON.parse(readMathText(file, maxBytes)));
  if (!parsed.success || parsed.data.runId !== runId) throw new Error('math_guidance_store_invalid');
  if (new Set(parsed.data.records.map(record => record.id)).size !== parsed.data.records.length)
    throw new Error('math_guidance_store_invalid');
  return parsed.data.records as HumanGuidanceRecord[];
}

function save(stateFile: string, runId: string, records: HumanGuidanceRecord[]) {
  writeMathJsonDurable(guidanceFile(stateFile), { schema: 'theorem-os.human-guidance.v1', runId, records });
}
const inputOf = (record: HumanGuidanceRecord) => ({ id: record.id, recipient: record.recipient,
  taskRef: record.taskRef, text: record.text, observationRef: record.observationRef, candidate: record.candidate });

function invalidTarget(state: SolverRunState, input: HumanGuidanceInput): string | undefined {
  if (input.taskRef && !state.cooperation?.tasks.some(node => node.task.id === input.taskRef!.id &&
      taskVersion(node.task) === input.taskRef!.version)) return 'math_guidance_task_superseded';
  if (input.candidate) {
    if (input.candidate.environmentDigest !== state.environmentDigest) return 'math_guidance_candidate_environment_changed';
    const file = input.candidate.file, task = state.cooperation?.tasks.find(node => node.task.id === input.candidate!.taskRef.id)?.task;
    if (task?.proofPath !== file || !state.problem.ownedFiles.includes(file) || Object.hasOwn(state.problem.frozenFiles ?? {}, file))
      return 'math_guidance_candidate_file_mismatch';
  }
  if (input.recipient.kind === 'worker' && !state.workers?.some(worker => worker.id === input.recipient.id))
    return 'math_guidance_worker_missing';
  if (input.recipient.kind === 'lead' && input.recipient.id && !state.workers?.some(worker =>
      worker.role === 'lead' && worker.id === input.recipient.id)) return 'math_guidance_lead_missing';
  return undefined;
}

function candidateBaseMatches(state: SolverRunState, candidate: HumanGuidanceCandidate): boolean {
  // Git is invoked with fixed argument arrays, never a shell or a candidate-supplied command.
  return [...new Set([state.worktree, ...(state.workers?.map(worker => worker.worktree) ?? [])])].some(root => {
    try {
      mathGitBytes(root, ['merge-base', '--is-ancestor', state.problem.baseCommit, candidate.baseCommit],
        { maxBuffer: 8192, timeout: 3000 });
      return ownedSourceDigest(state.problem, root, candidate.baseCommit) === candidate.baseSourceDigest;
    } catch { return false; }
  });
}

export async function queueHumanGuidance(run: string, value: unknown): Promise<HumanGuidanceRecord> {
  const parsed = humanGuidanceInputSchema.safeParse(value);
  if (!parsed.success) throw new Error('math_guidance_invalid');
  const input = parsed.data as HumanGuidanceInput, initial = readRunInspection(run);
  return withMathRuntimeLease({ lockPath: path.join(path.dirname(initial.stateFile), 'human-guidance.lock'),
    flockExecutable: '/usr/bin/flock' }, async lease => {
    const { state, stateFile } = readRunInspection(run), records = readHumanGuidance(stateFile, state.runId);
    const previous = records.find(record => record.id === input.id);
    if (previous) {
      if (canonicalMathJson(inputOf(previous)) !== canonicalMathJson(input)) throw new Error('math_guidance_id_conflict');
      return previous;
    }
    if (!state.cooperation || state.phase === 'finished') throw new Error('math_guidance_run_inactive');
    const invalid = invalidTarget(state, input);
    if (invalid) throw new Error(invalid);
    if (input.candidate && !candidateBaseMatches(state, input.candidate)) throw new Error('math_guidance_candidate_base_mismatch');
    if (records.length >= 512) throw new Error('math_guidance_limit');
    const now = new Date().toISOString();
    const record: HumanGuidanceRecord = { ...input, status: 'queued', createdAt: now, updatedAt: now };
    records.push(record); lease.assertHeld(); save(stateFile, state.runId, records);
    return record;
  });
}

/**
 * A person may take back a note that no agent has received. It shares the delivery lock, so a note is either delivered or
 * withdrawn, never both. Withdrawal reuses the `failed` status that every existing reader already skips, so runs started by
 * older hosts keep reading the store.
 */
export const GUIDANCE_WITHDRAWN = 'math_guidance_withdrawn';
export async function withdrawHumanGuidance(run: string, guidanceId: string): Promise<HumanGuidanceRecord> {
  if (!identity.safeParse(guidanceId).success) throw new Error('math_guidance_invalid');
  const initial = readRunInspection(run);
  return withMathRuntimeLease({ lockPath: path.join(path.dirname(initial.stateFile), 'human-guidance.lock'),
    flockExecutable: '/usr/bin/flock' }, async lease => {
    const { state, stateFile } = readRunInspection(run), records = readHumanGuidance(stateFile, state.runId);
    const record = records.find(item => item.id === guidanceId);
    if (!record) throw new Error('math_guidance_unknown');
    if (record.status === 'failed' && record.reason === GUIDANCE_WITHDRAWN) return record;
    if (record.status === 'delivered') throw new Error('math_guidance_already_delivered');
    if (record.status === 'failed') throw new Error('math_guidance_already_failed');
    record.status = 'failed'; record.reason = GUIDANCE_WITHDRAWN; record.updatedAt = new Date().toISOString();
    lease.assertHeld(); save(stateFile, state.runId, records);
    return record;
  });
}

export type HumanGuidanceRecipient = {
  workerId: string; role: string; taskRef?: { id: string; version: string };
  planVersion?: string;
  current(): boolean;
  notify(message: string): Promise<void>;
};

/** The active host invokes this at its checkpoint; only a resolved delivery earns a delivered receipt. */
export async function deliverHumanGuidance(input: {
  stateFile: string; state: SolverRunState;
  recipients(): readonly HumanGuidanceRecipient[];
  stopped?: boolean;
  onRecord?(record: HumanGuidanceRecord): void;
}): Promise<void> {
  if (!fs.existsSync(guidanceFile(input.stateFile))) return;
  await withMathRuntimeLease({ lockPath: path.join(path.dirname(input.stateFile), 'human-guidance.lock'),
    flockExecutable: '/usr/bin/flock' }, async lease => {
    const records = readHumanGuidance(input.stateFile, input.state.runId);
    for (const record of records) {
      if (record.status === 'delivered' || record.status === 'failed') continue;
      const previous = canonicalMathJson(record), invalid = invalidTarget(input.state, record);
      if (invalid || input.stopped || input.state.phase === 'finished') {
        record.status = 'failed'; record.reason = invalid ?? 'math_guidance_run_stopped';
      } else {
        const recipient = input.recipients().find(target => {
          if (!target.current()) return false;
          if (record.taskRef && (target.taskRef?.id !== record.taskRef.id || target.taskRef.version !== record.taskRef.version)) return false;
          if (record.recipient.kind === 'task') return target.taskRef?.id === record.recipient.id;
          if (record.recipient.kind === 'worker') return target.workerId === record.recipient.id;
          return target.role === 'lead' && (!record.recipient.id || target.workerId === record.recipient.id);
        });
        if (!recipient) { record.status = 'deferred'; record.reason = 'math_guidance_awaiting_recipient_checkpoint'; }
        else {
          try {
            let attachment = '';
            if (record.candidate) {
              const { source, ...metadata } = record.candidate;
              attachment = '\n\nAdvisory candidate proof attachment:\n' + JSON.stringify(metadata) +
                '\nComplete UTF-8 candidate source:\n```lean\n' + source + '\n```\n' +
                'Review this candidate against the exact assigned declaration. To use it, adapt/save and submit through the ordinary task delivery and declaration integration protocol. ' +
                'The host must recheck the saved proof and the original target must still pass independent S3 acceptance. This message changes no worktree or mathematical acceptance state.';
            }
            await recipient.notify(`Human research guidance ${record.id}${record.taskRef ? ` for ${record.taskRef.id}@${record.taskRef.version}` : ''}:\n` +
              record.text + attachment + '\nThis is advisory input. Preserve the frozen original problem and task contracts. Any mathematical plan change must use the ordinary versioned planning protocol; this message is never proof acceptance. ' +
              'Report your decision in guidanceDecisions:[{guidanceId:"' + record.id + '",status:"accepted"|"declined"|"needs-info",reason:"specific reason",evidenceRefs:[]}], in your normal JSON delivery or RESEARCH.md response. ' +
              (recipient.role === 'lead' ? 'Save this decision with the smallest useful math-plan revision and return before further searches. Delegate open searches, or report needs-info with the exact missing premise. ' : '') +
              'You may later add task, plan or applied-edit evidenceRefs with the same status and reason; the host retains prior references and validates each addition.');
            record.status = 'delivered'; record.deliveredTo = [recipient.workerId]; delete record.reason;
            record.deliveredScope = { ...(recipient.taskRef ? { taskRef: recipient.taskRef } : {}),
              ...((recipient.planVersion ?? input.state.cooperation?.planVersion) ? { planVersion: recipient.planVersion ?? input.state.cooperation?.planVersion } : {}) };
          } catch (error) {
            record.reason = error instanceof Error ? error.message.slice(0, 2_000) : 'math_guidance_delivery_failed';
            record.status = record.reason === 'math_guidance_recipient_not_running' ? 'deferred' : 'failed';
          }
        }
      }
      if (canonicalMathJson(record) !== previous) {
        record.updatedAt = new Date().toISOString(); lease.assertHeld(); save(input.stateFile, input.state.runId, records);
        input.onRecord?.(record);
      }
    }
  });
}

/** Delivered notes may be answered only in their host-bound task/plan scope. A decision never accepts proof or executes edits. */
export async function recordHumanGuidanceDecisions(input: {
  stateFile: string; state: SolverRunState; workerId: string; scope: HumanGuidanceScope; decisions: unknown;
  current(): boolean; onRecord?(record: HumanGuidanceRecord): void;
}): Promise<HumanGuidanceRecord[]> {
  const parsed = z.array(humanGuidanceDecisionSchema).max(32).safeParse(input.decisions);
  if (!parsed.success) throw new Error('math_guidance_decision_invalid');
  const decisions = parsed.data as HumanGuidanceDecisionInput[];
  if (!decisions.length) return [];
  if (new Set(decisions.map(item => item.guidanceId)).size !== decisions.length) throw new Error('math_guidance_decision_duplicate');
  return withMathRuntimeLease({ lockPath: path.join(path.dirname(input.stateFile), 'human-guidance.lock'),
    flockExecutable: '/usr/bin/flock' }, async lease => {
    if (!input.current()) throw new Error('math_guidance_decision_superseded');
    const records = readHumanGuidance(input.stateFile, input.state.runId), changed: HumanGuidanceRecord[] = [];
    const selected = decisions.map(decision => {
      const record = records.find(item => item.id === decision.guidanceId);
      if (!record || record.status !== 'delivered' || !record.deliveredTo?.includes(input.workerId))
        throw new Error('math_guidance_decision_not_delivered');
      const scope = record.deliveredScope, target = scope?.taskRef ?? record.taskRef;
      if (!scope || !target && !scope.planVersion) throw new Error('math_guidance_decision_delivery_unbound');
      if (target ? input.scope.taskRef?.id !== target.id || input.scope.taskRef?.version !== target.version ||
          !input.state.cooperation?.tasks.some(node => node.task.id === target.id && taskVersion(node.task) === target.version)
        : scope.planVersion !== input.scope.planVersion) throw new Error('math_guidance_decision_version_conflict');
      const previous = record.decision;
      if (previous && (previous.workerId !== input.workerId || previous.guidanceId !== decision.guidanceId ||
          previous.status !== decision.status || previous.reason !== decision.reason)) throw new Error('math_guidance_decision_conflict');
      const references = new Map((previous?.evidenceRefs ?? []).map(ref => [canonicalMathJson(ref), ref]));
      for (const ref of decision.evidenceRefs) {
        const identity = canonicalMathJson(ref);
        if (references.has(identity)) continue;
        const valid = ref.kind === 'edit' ? input.state.cooperation?.edits?.some(edit => edit.id === ref.id && edit.status === 'applied') :
          ref.kind === 'plan' ? input.state.cooperation?.planVersion === ref.version :
            input.state.cooperation?.tasks.some(node => node.task.id === ref.id && taskVersion(node.task) === ref.version);
        if (!valid) throw new Error('math_guidance_decision_evidence_unknown');
        references.set(identity, ref);
      }
      if (references.size > 32) throw new Error('math_guidance_decision_invalid');
      return { record, decision: { ...decision, evidenceRefs: [...references.values()] }, target, scope };
    });
    for (const { record, decision, target, scope } of selected) if (!record.decision || record.decision.evidenceRefs.length !== decision.evidenceRefs.length) {
      record.updatedAt = new Date().toISOString();
      record.decision = record.decision ? { ...record.decision, evidenceRefs: decision.evidenceRefs } :
        { ...decision, workerId: input.workerId, decidedAt: record.updatedAt,
          ...(target ? { sourceTaskRef: target } : {}), ...(scope.planVersion ? { sourcePlanVersion: scope.planVersion } : {}) };
      changed.push(record);
    }
    if (changed.length) {
      lease.assertHeld(); save(input.stateFile, input.state.runId, records);
      for (const record of changed) input.onRecord?.(record);
    }
    return selected.map(item => item.record);
  });
}
