import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalMathJson, readMathText, withMathRuntimeLease } from '../math/mathRuntimeIo';
import { parseCooperationPlan } from './tasks';
import { readRunInspection } from './inspection';
import { researchWorkerCanNode } from './modules/organization';
import { planApprovalInputSchema, planApprovalLog, planApprovalStatus } from './planApproval';

/** Append one complete line to a host-owned JSONL log; the solver reads it with its own cursor. */
function appendDurableLine(log: string, bytes: Buffer, invalid: string) {
  const fd = fs.openSync(log, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(invalid);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/** Queue an edit through the existing host protocol; never write the checkpoint. */
export async function queueRunEdit(run: string, proposal: unknown, dryRun = false) {
  if (!proposal || typeof proposal !== 'object') throw new Error('math_edit_invalid');
  const value = proposal as Record<string, unknown>;
  if (typeof value.baseVersion !== 'string' || !value.baseVersion) throw new Error('math_edit_base_version_required');
  const id = value.id ?? crypto.randomUUID();
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(id)) throw new Error('math_edit_invalid_id');
  const initial = readRunInspection(run);
  const directory = path.dirname(initial.stateFile);
  return withMathRuntimeLease({ lockPath: path.join(directory, 'edits.lock'), flockExecutable: '/usr/bin/flock' }, async lease => {
    const { state } = readRunInspection(run);
    if (!state.cooperation?.planVersion) throw new Error('math_edit_plan_unavailable');
    const plan = parseCooperationPlan(state.problem, value);
    const workers = state.workers ?? [];
    for (const task of plan.tasks) if (task.ownerId) {
      const previous = state.cooperation.tasks.find(node => node.task.id === task.id);
      const ownershipTask = previous?.capacityExploration ? { ...task, status: 'active' as const } : task;
      if (!workers.some(worker => worker.id === task.ownerId && researchWorkerCanNode(worker,
        { ...(previous ?? { status: 'pending', attempts: 0 }), task: ownershipTask })))
        throw new Error('math_plan_task_owner_unavailable');
    }
    for (const group of plan.groups) if (group.engineerId && !workers.some(worker => worker.id === group.engineerId && worker.role === 'engineer'))
      throw new Error('math_plan_group_engineer_unavailable');
    const edit = { id, baseVersion: value.baseVersion, ...plan };
    const log = path.join(directory, 'edits.jsonl');
    const existing = fs.existsSync(log) ? readMathText(log, 8 * 1024 * 1024) : '';
    if (existing && !existing.endsWith('\n')) throw new Error('math_edit_incomplete_log');
    const previous = existing.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(item => item.id === id);
    if (previous) {
      if (canonicalMathJson(previous) !== canonicalMathJson(edit)) throw new Error('math_edit_id_conflict');
      return { id, status: 'already_queued', baseVersion: edit.baseVersion };
    }
    if (state.cooperation.edits?.some(item => item.id === id)) throw new Error('math_edit_id_already_used');
    if (value.baseVersion !== state.cooperation.planVersion) throw new Error('math_edit_version_conflict');
    if (dryRun) return { id, status: 'validated', baseVersion: edit.baseVersion };
    const bytes = Buffer.from(JSON.stringify(edit) + '\n');
    if (bytes.length > 1024 * 1024) throw new Error('math_edit_too_large');
    lease.assertHeld();
    appendDurableLine(log, bytes, 'math_edit_log_invalid');
    return { id, status: 'queued', baseVersion: edit.baseVersion };
  });
}

/**
 * Queue a human approval of one exact plan version. The running solver records it, or rejects it when the
 * plan changed first; this only checks what the saved checkpoint already shows.
 */
export async function queuePlanApproval(run: string, value: unknown) {
  const parsed = planApprovalInputSchema.safeParse(value);
  if (!parsed.success) throw new Error('math_plan_approval_invalid');
  const { id, planVersion } = parsed.data, initial = readRunInspection(run);
  const directory = path.dirname(initial.stateFile);
  return withMathRuntimeLease({ lockPath: path.join(directory, 'plan-approvals.lock'), flockExecutable: '/usr/bin/flock' }, async lease => {
    const { state, stateFile } = readRunInspection(run);
    const log = planApprovalLog(stateFile);
    const existing = fs.existsSync(log) ? readMathText(log, 1024 * 1024) : '';
    if (existing && !existing.endsWith('\n')) throw new Error('math_plan_approval_incomplete_log');
    const lines = existing.split('\n').filter(Boolean).map(line => JSON.parse(line) as { id?: unknown; planVersion?: unknown });
    const previous = lines.find(item => item.id === id);
    if (previous) {
      if (previous.planVersion !== planVersion) throw new Error('math_plan_approval_id_conflict');
      return { id, status: 'already_queued', planVersion };
    }
    const status = planApprovalStatus(state);
    if (status === 'not-required') throw new Error('math_plan_approval_not_required');
    if (state.phase === 'finished') throw new Error('math_plan_approval_run_inactive');
    if (status === 'approved') throw new Error('math_plan_approval_already_approved');
    if (status === 'awaiting-plan') throw new Error('math_plan_approval_plan_unavailable');
    if (planVersion !== state.cooperation?.planVersion) throw new Error('math_plan_approval_version_conflict');
    if (lines.length >= 64) throw new Error('math_plan_approval_limit');
    lease.assertHeld();
    appendDurableLine(log, Buffer.from(JSON.stringify({ id, planVersion }) + '\n'), 'math_plan_approval_log_invalid');
    return { id, status: 'queued', planVersion };
  });
}
