import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { canonicalMathJson, readMathText, withMathRuntimeLease, writeMathJsonDurable } from '../math/mathRuntimeIo';
import type { SolverRunState } from './archive';
import { readRunInspection } from './inspection';
import { taskVersion } from './tasks';

const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u);
const taskRef = z.object({ id: identity, version: z.string().min(1).max(128) }).strict();
export const humanGuidanceInputSchema = z.object({
  id: identity,
  recipient: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('lead'), id: identity.optional() }).strict(),
    z.object({ kind: z.literal('task'), id: identity }).strict(),
    z.object({ kind: z.literal('worker'), id: identity }).strict(),
  ]),
  taskRef: taskRef.optional(),
  text: z.string().min(1).max(8_000).refine(value => Boolean(value.trim()) && !value.includes('\0') && Buffer.byteLength(value) <= 16_000),
  observationRef: z.object({ sequence: z.number().int().nonnegative(), stateDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
}).strict().refine(value => value.recipient.kind !== 'task' || value.taskRef?.id === value.recipient.id,
  'Task guidance requires the exact observed task version.');

export type HumanGuidanceInput = {
  id: string; recipient: { kind: 'lead'; id?: string } | { kind: 'task' | 'worker'; id: string };
  taskRef?: { id: string; version: string }; text: string;
  observationRef: { sequence: number; stateDigest: string };
};
const recordSchema = z.object({ ...humanGuidanceInputSchema.innerType().shape,
  status: z.enum(['queued', 'delivered', 'deferred', 'failed']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  deliveredTo: z.array(identity).optional(), reason: z.string().max(2_000).optional(),
}).strict();
export type HumanGuidanceRecord = HumanGuidanceInput & {
  status: 'queued' | 'delivered' | 'deferred' | 'failed'; createdAt: string; updatedAt: string;
  deliveredTo?: string[]; reason?: string;
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
  taskRef: record.taskRef, text: record.text, observationRef: record.observationRef });

function invalidTarget(state: SolverRunState, input: HumanGuidanceInput): string | undefined {
  if (input.taskRef && !state.cooperation?.tasks.some(node => node.task.id === input.taskRef!.id &&
      taskVersion(node.task) === input.taskRef!.version)) return 'math_guidance_task_superseded';
  if (input.recipient.kind === 'worker' && !state.workers?.some(worker => worker.id === input.recipient.id))
    return 'math_guidance_worker_missing';
  if (input.recipient.kind === 'lead' && input.recipient.id && !state.workers?.some(worker =>
      worker.role === 'lead' && worker.id === input.recipient.id)) return 'math_guidance_lead_missing';
  return undefined;
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
    if (records.length >= 512) throw new Error('math_guidance_limit');
    const now = new Date().toISOString();
    const record: HumanGuidanceRecord = { ...input, status: 'queued', createdAt: now, updatedAt: now };
    records.push(record); lease.assertHeld(); save(stateFile, state.runId, records);
    return record;
  });
}

export type HumanGuidanceRecipient = {
  workerId: string; role: string; taskRef?: { id: string; version: string };
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
            await recipient.notify(`Human research guidance ${record.id}${record.taskRef ? ` for ${record.taskRef.id}@${record.taskRef.version}` : ''}:\n` +
              record.text + '\nThis is advisory input. Preserve the frozen original problem and task contracts. Any mathematical plan change must use the ordinary versioned planning protocol; this message is never proof acceptance.');
            record.status = 'delivered'; record.deliveredTo = [recipient.workerId]; delete record.reason;
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
