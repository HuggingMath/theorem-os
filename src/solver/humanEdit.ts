import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalMathJson, parseMathJson, readMathFile, withMathRuntimeLease } from '../math/mathRuntimeIo';
import { parseCooperationPlan, taskGroup, taskVersion } from './tasks';
import type { SolverRunState } from './archive';
import { assertPlanTaskTypeContracts } from './taskTypeContract';
import { readRunInspection } from './inspection';
import { assertPlanAssignments } from './modules/organization';
import { planApprovalInputSchema, planApprovalLog, planApprovalStatus } from './planApproval';

/** A damaged complete record must not block later requests or hide a queued ID. */
function* readQueuedObjects(log: string, maxBytes: number, incomplete: string): Generator<Record<string, unknown>> {
  if (!fs.existsSync(log)) return;
  const { bytes } = readMathFile(log, maxBytes);
  if (bytes.length && bytes[bytes.length - 1] !== 0x0a) throw new Error(incomplete);
  for (let start = 0; start < bytes.length;) {
    const end = bytes.indexOf(0x0a, start);
    const line = bytes.subarray(start, end);
    start = end + 1;
    if (!line.length) continue;
    let value: unknown;
    try { value = parseMathJson(line, 'math_human_log_invalid_json'); } catch { continue; }
    if (value && typeof value === 'object' && !Array.isArray(value)) yield value as Record<string, unknown>;
  }
}

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

function summarizeEdit(current: NonNullable<SolverRunState['cooperation']>, proposed: ReturnType<typeof parseCooperationPlan>) {
  const previous = new Map(current.tasks.map(node => [node.task.id, node.task]));
  const changes: { taskId: string; fields: string[] }[] = [];
  const oldGroups = new Map(current.groups?.map(record => [record.group.id, record.group]) ?? []);
  const affected = new Set<string>(), mathematical = new Set<string>();
  for (const task of proposed.tasks) {
    const before = previous.get(task.id), fields: string[] = [];
    if (!before) fields.push('added');
    else for (const key of new Set([...Object.keys(before), ...Object.keys(task)])) {
      if (canonicalMathJson((before as Record<string, unknown>)[key] ?? null) !== canonicalMathJson((task as Record<string, unknown>)[key] ?? null)) fields.push(key);
    }
    const group = proposed.groups.find(item => item.id === taskGroup(task)), oldGroup = oldGroups.get(taskGroup(task));
    if (group && oldGroup) for (const key of new Set([...Object.keys(group), ...Object.keys(oldGroup)])) {
      if (canonicalMathJson((group as Record<string, unknown>)[key] ?? null) !== canonicalMathJson((oldGroup as Record<string, unknown>)[key] ?? null)) fields.push(`group.${key}`);
    }
    if (fields.length) { changes.push({ taskId: task.id, fields }); affected.add(task.id); }
    if (!before || taskVersion(before) !== taskVersion(task) || fields.some(field => ['group.objective', 'group.revision'].includes(field))) mathematical.add(task.id);
  }
  for (const id of previous.keys()) if (!proposed.tasks.some(task => task.id === id)) { changes.push({ taskId: id, fields: ['removed'] }); affected.add(id); mathematical.add(id); }
  if (canonicalMathJson(current.proofRoutes ?? []) !== canonicalMathJson(proposed.proofRoutes ?? [])) {
    for (const route of [...(current.proofRoutes ?? []), ...(proposed.proofRoutes ?? [])]) {
      affected.add(route.targetTaskId); mathematical.add(route.targetTaskId);
      const existing = changes.find(change => change.taskId === route.targetTaskId);
      if (existing) { if (!existing.fields.includes('proofRoutes')) existing.fields.push('proofRoutes'); }
      else changes.push({ taskId: route.targetTaskId, fields: ['proofRoutes'] });
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const task of proposed.tasks) if (!mathematical.has(task.id) && task.dependsOn.some(id => mathematical.has(id))) {
      mathematical.add(task.id); affected.add(task.id); changed = true;
    }
  }
  return { affectedTaskIds: [...affected], changes };
}

/** Queue an edit through the existing host protocol; never write the checkpoint. */
export async function queueRunEdit(run: string, proposal: unknown, dryRun = false) {
  if (!proposal || typeof proposal !== 'object') throw new Error('math_edit_invalid');
  const value = proposal as Record<string, unknown>, { baseVersion } = value;
  if (typeof baseVersion !== 'string' || !baseVersion) throw new Error('math_edit_base_version_required');
  const id = value.id ?? crypto.randomUUID();
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(id)) throw new Error('math_edit_invalid_id');
  const initial = readRunInspection(run);
  const directory = path.dirname(initial.stateFile);
  return withMathRuntimeLease({ lockPath: path.join(directory, 'edits.lock'), flockExecutable: '/usr/bin/flock' }, async lease => {
    const { state } = readRunInspection(run);
    const current = state.cooperation;
    if (!current?.planVersion) throw new Error('math_edit_plan_unavailable');
    const plan = parseCooperationPlan(state.problem, value);
    assertPlanTaskTypeContracts(plan.tasks, current.tasks.map(node => node.task));
    assertPlanAssignments(plan, current.tasks, state.workers ?? []);
    const edit = { id, baseVersion, ...plan };
    const receipt = (status: 'already_queued' | 'validated' | 'queued') =>
      ({ id, status, baseVersion, ...summarizeEdit(current, plan) });
    const log = path.join(directory, 'edits.jsonl');
    for (const previous of readQueuedObjects(log, 8 * 1024 * 1024, 'math_edit_incomplete_log')) {
      if (previous.id !== id) continue;
      if (canonicalMathJson(previous) !== canonicalMathJson(edit)) throw new Error('math_edit_id_conflict');
      return receipt('already_queued');
    }
    if (current.edits?.some(item => item.id === id)) throw new Error('math_edit_id_already_used');
    if (baseVersion !== current.planVersion) throw new Error('math_edit_version_conflict');
    const bytes = Buffer.from(JSON.stringify(edit) + '\n');
    if (bytes.length > 1024 * 1024) throw new Error('math_edit_too_large');
    if (dryRun) return receipt('validated');
    const queued = receipt('queued');
    lease.assertHeld();
    appendDurableLine(log, bytes, 'math_edit_log_invalid');
    return queued;
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
    let approvalCount = 0;
    for (const previous of readQueuedObjects(log, 1024 * 1024, 'math_plan_approval_incomplete_log')) {
      const approval = planApprovalInputSchema.safeParse(previous);
      if (!approval.success) continue;
      approvalCount++;
      if (approval.data.id !== id) continue;
      if (approval.data.planVersion !== planVersion) throw new Error('math_plan_approval_id_conflict');
      return { id, status: 'already_queued', planVersion };
    }
    const status = planApprovalStatus(state);
    if (status === 'not-required') throw new Error('math_plan_approval_not_required');
    if (state.phase === 'finished') throw new Error('math_plan_approval_run_inactive');
    if (status === 'approved') throw new Error('math_plan_approval_already_approved');
    if (status === 'awaiting-plan') throw new Error('math_plan_approval_plan_unavailable');
    if (planVersion !== state.cooperation?.planVersion) throw new Error('math_plan_approval_version_conflict');
    if (approvalCount >= 64) throw new Error('math_plan_approval_limit');
    lease.assertHeld();
    appendDurableLine(log, Buffer.from(JSON.stringify({ id, planVersion }) + '\n'), 'math_plan_approval_log_invalid');
    return { id, status: 'queued', planVersion };
  });
}
