import type { WebEvent, WebRunStatus } from '../shared';
import {
  trajectoryLimits, type TrajectoryCheck, type TrajectoryContext, type TrajectoryDelivery, type TrajectoryEdit, type TrajectoryGuidance,
  type TrajectoryIndex, type TrajectoryPage, type TrajectoryPlan, type TrajectoryPlanItem, type TrajectoryVersion,
} from '../trajectory';

/** What the browser has of one run's trajectory: merged pages, bounded like the server index. */
export type TrajectoryData = {
  instance?: string; revision: number; cursor: number;
  events: WebEvent[]; versions: Map<string, TrajectoryVersion>; plans: Map<number, TrajectoryPlan>;
  deliveries: Map<string, TrajectoryDelivery>; guidance: Map<string, TrajectoryGuidance>; edits: Map<string, TrajectoryEdit>;
  context: TrajectoryContext; dropped: TrajectoryIndex['dropped'];
};
export const emptyTrajectory = (): TrajectoryData => ({ revision: 0, cursor: 0, events: [], versions: new Map(), plans: new Map(),
  deliveries: new Map(), guidance: new Map(), edits: new Map(), context: { workers: [], targets: [] },
  dropped: { events: 0, versions: 0, plans: 0, deliveries: 0, guidance: 0, edits: 0 } });

function upsert<K, T>(map: Map<K, T>, items: readonly T[], key: (item: T) => K, limit: number) {
  for (const item of items) { map.delete(key(item)); map.set(key(item), item); }
  for (const old of map.keys()) { if (map.size <= limit) break; map.delete(old); }
}

/** Adds one page; a page from another server instance replaces everything the browser had. */
export function mergeTrajectory(current: TrajectoryData, page: TrajectoryPage): TrajectoryData {
  const data = page.instance === current.instance ? current : emptyTrajectory();
  data.instance = page.instance; data.revision = page.revision; data.cursor = page.cursor; data.dropped = page.dropped;
  const last = data.events.at(-1)?.sequence ?? 0;
  for (const event of page.events) if (event.sequence > last) data.events.push(event);
  if (data.events.length > trajectoryLimits.events) data.events.splice(0, data.events.length - trajectoryLimits.events);
  upsert(data.versions, page.versions, item => item.key, trajectoryLimits.versions);
  for (const plan of page.plans) data.plans.set(plan.observation, plan);
  // The first plan stays, as on the server.
  for (const key of [...data.plans.keys()].slice(1)) { if (data.plans.size <= trajectoryLimits.plans) break; data.plans.delete(key); }
  upsert(data.deliveries, page.deliveries, item => item.id, trajectoryLimits.deliveries);
  upsert(data.guidance, page.guidance, item => item.id, trajectoryLimits.guidance);
  upsert(data.edits, page.edits, item => item.id, trajectoryLimits.edits);
  if (page.context) data.context = page.context;
  return data;
}

export type TrajectoryOutcome = 'passed' | 'failed' | 'conditional' | 'running';
export type TrajectoryRef = { version: TrajectoryVersion; check?: TrajectoryCheck };
export type RecheckResult = { taskId: string; passed: boolean; conditional?: boolean; ref?: TrajectoryRef };
export type TrajectoryStep = { at: number } & (
  | { kind: 'problem'; targets: string[] }
  | { kind: 'plan'; plan: TrajectoryPlan; first: boolean; workerId?: string }
  | { kind: 'attempt'; taskId: string; workerId?: string; number: number; outcome: TrajectoryOutcome; ref?: TrajectoryRef;
      reused: boolean; integrated: boolean; previous?: TrajectoryVersion; note?: string }
  | { kind: 'proof'; assembled: boolean; workerId?: string; number: number; outcome: TrajectoryOutcome; ref?: TrajectoryRef }
  | { kind: 'recheck'; results: RecheckResult[] }
  | { kind: 'edit'; edit: TrajectoryEdit; plan?: TrajectoryPlan; results: RecheckResult[] }
  | { kind: 'guidance'; guidance: TrajectoryGuidance }
  | { kind: 'approval'; event: WebEvent }
  | { kind: 'delivery'; delivery: TrajectoryDelivery }
  | { kind: 'evaluation'; outcome: TrajectoryOutcome; status?: string }
  | { kind: 'notice'; event: WebEvent; count: number }
  | { kind: 'stop'; event: WebEvent }
  | { kind: 'end'; status: WebRunStatus }
  | { kind: 'live'; workers: { id: string; phase: string; task?: string }[] });

export type TrajectoryInput = {
  data: TrajectoryData; status: WebRunStatus; createdAt: string; finishedAt?: string;
  /** Agents of the latest observation, for the "in progress" line of a running run. */
  live?: readonly { id: string; phase: string; task?: string }[];
};

type StepOf<K extends TrajectoryStep['kind']> = Extract<TrajectoryStep, { kind: K }>;
type Slot = { version: TrajectoryVersion; check: TrajectoryCheck; used: boolean };
const planEvents = new Set(['plan_updated', 'plan_published', 'initial_plan_published', 'initial_plan_fallback']);
const stopEvents = new Set(['error', 'cancelled', 'interrupted', 'preparation_failed']);
// Asking for, giving or never giving the approval a run started with: a person's step, kept in the 简洁 reading.
const approvalEvents = new Set(['plan_approval_requested', 'plan_approved', 'plan_approval_unanswered']);
// A check receipt is written a few ms before its event; the two come from different processes, so allow both orders.
const matchWindow = { before: 5_000, after: 2_000 };
// Rechecks this soon after a plan edit, of a task it touched, are read as that edit's rechecks.
const editWindow = 60_000;
const editPlanWindow = 5_000;
const time = (value: string | number) => typeof value === 'number' ? value : Date.parse(value);
export const versionDeliveryKey = (taskId: string, commit: string) => `${taskId}\u0000${commit}`;
// The host's fixed note on a task proof that came without an account of its own (src/solver/cooperation.ts); the step's
// own Lean outcome already says it.
const hostProofNote = 'Fixed declaration checked; unresolved lemma assumptions remain obligations.';

/**
 * The run as mathematical steps, oldest first: reading the problem, the plan and its revisions, each Agent's attempt at
 * each task with its Lean outcome and the version it checked, human edits and guidance, reviews, the assembled proof
 * and the final acceptance. Outcomes come from the events; checks are matched to them by task and time to find the
 * code, and checked versions no event accounts for become attempts of their own.
 */
export function buildTrajectory(input: TrajectoryInput): TrajectoryStep[] {
  const { data } = input, targets = data.context.targets;
  const slots: Slot[] = [...data.versions.values()].flatMap(version => version.checks.map(check => ({ version, check, used: false })))
    .sort((a, b) => a.check.at - b.check.at);
  const firstAt = (at: number) => { let low = 0, high = slots.length; while (low < high) { const middle = (low + high) >> 1; if (slots[middle]!.check.at < at) low = middle + 1; else high = middle; } return low; };
  /** The unused accepted check nearest before `at` (or else just after), marked used. */
  const claim = (at: number, accept: (slot: Slot) => boolean) => {
    let before: Slot | undefined, after: Slot | undefined;
    for (let position = firstAt(at - matchWindow.before); position < slots.length && slots[position]!.check.at <= at + matchWindow.after; position++) {
      const slot = slots[position]!;
      if (slot.used || !accept(slot)) continue;
      if (slot.check.at <= at) before = slot; else after ??= slot;
    }
    const found = before ?? after;
    if (found) found.used = true;
    return found;
  };
  /** An assembled check covers every target; the copies stored under each goal task are one check. */
  const claimAssembly = (at: number, passed: boolean) => {
    const found = claim(at, slot => slot.check.passed === passed && (!targets.length || targets.every(name => slot.check.theorems.includes(name))));
    if (found) for (let position = firstAt(found.check.at); position < slots.length && slots[position]!.check.at === found.check.at; position++)
      if (slots[position]!.version.commit === found.version.commit) slots[position]!.used = true;
    return found;
  };
  const latestCheck = (taskId: string, at: number) => {
    for (let position = firstAt(at + 1) - 1; position >= 0; position--) if (slots[position]!.version.taskId === taskId) return slots[position];
  };
  const refOf = (slot: Slot | undefined): TrajectoryRef | undefined => slot && { version: slot.version, check: slot.check };
  const notes = new Map<string, string>();
  for (const delivery of data.deliveries.values()) if (delivery.kind === 'proof' && delivery.taskId && delivery.commit && delivery.summary && delivery.summary !== hostProofNote)
    notes.set(versionDeliveryKey(delivery.taskId, delivery.commit), delivery.summary);
  const noteOf = (taskId: string, ref?: TrajectoryRef) => ref && notes.get(versionDeliveryKey(taskId, ref.version.commit));
  const lead = data.context.workers.find(worker => worker.role === 'lead')?.id;

  const steps: TrajectoryStep[] = [];
  const add = <S extends TrajectoryStep>(step: S) => { steps.push(step); return step; };
  const owners = new Map<string, string>(), lastAttempt = new Map<string, StepOf<'attempt'>>();
  let assembly: { workerId?: string } | undefined, lastProof: StepOf<'proof'> | undefined;
  let evaluation: StepOf<'evaluation'> | undefined, edit: StepOf<'edit'> | undefined;
  const editTime = (step: StepOf<'edit'>) => step.edit.appliedAt ?? step.edit.receivedAt ?? step.at;

  const attempt = (event: WebEvent, at: number) => {
    const details = event.details ?? {}, taskId = details.taskId;
    if (!taskId) return;
    const reused = event.type !== 'task_checked';
    let passed = details.passed, slot: Slot | undefined;
    if (reused) {
      // A reused check is the latest recorded one of the task; it is not claimed again.
      slot = latestCheck(taskId, at);
      passed ??= event.type === 'task_failure_check_reused' ? false : slot?.check.passed;
    } else slot = claim(at, item => item.version.taskId === taskId && (passed === undefined || item.check.passed === passed));
    if (passed === undefined) return;
    const ref = refOf(slot), outcome: TrajectoryOutcome = passed ? details.conditional ? 'conditional' : 'passed' : 'failed';
    const previous = lastAttempt.get(taskId);
    if (reused && previous && steps.at(-1) === previous && previous.ref?.version === ref?.version && previous.outcome === outcome) return;
    lastAttempt.set(taskId, add<StepOf<'attempt'>>({ kind: 'attempt', at, taskId, workerId: details.workerId ?? owners.get(taskId), number: 0,
      outcome, ref, reused, integrated: false, note: noteOf(taskId, ref) }));
  };
  const integrated = (event: WebEvent, at: number) => {
    const taskId = event.details?.taskId;
    if (!taskId) return;
    // Integrating checks the task on the main line; that check belongs to this step, not to a new attempt.
    claim(at, item => item.version.taskId === taskId && item.check.passed);
    const step = lastAttempt.get(taskId);
    if (step) step.integrated = true;
  };
  const recheck = (event: WebEvent, at: number) => {
    const taskId = event.details?.taskId, passed = event.details?.passed;
    if (!taskId) return;
    const slot = claim(at, item => item.version.taskId === taskId && (passed === undefined || item.check.passed === passed));
    const result: RecheckResult = { taskId, passed: passed ?? slot?.check.passed ?? false, ref: refOf(slot),
      ...(event.type === 'task_conditional_recheck_finished' ? { conditional: true } : {}) };
    const last = steps.at(-1);
    const results = edit && at - editTime(edit) <= editWindow && edit.edit.affectedTasks?.includes(taskId) ? edit.results
      : last?.kind === 'recheck' ? last.results : add<StepOf<'recheck'>>({ kind: 'recheck', at, results: [] }).results;
    const existing = results.findIndex(item => item.taskId === taskId);
    if (existing >= 0) results[existing] = result;
    else results.push(result);
  };
  const proof = (event: WebEvent, at: number) => {
    const passed = event.details?.passed === true, outcome: TrajectoryOutcome = passed ? 'passed' : 'failed';
    // Rechecking an unchanged candidate repeats the last outcome; only a different result is a step.
    if (event.details?.reused && (!lastProof || lastProof.outcome === outcome)) { assembly = undefined; return; }
    lastProof = add<StepOf<'proof'>>({ kind: 'proof', at, assembled: assembly !== undefined, workerId: event.details?.workerId ?? assembly?.workerId,
      number: 0, outcome, ref: refOf(claimAssembly(at, passed)) });
    assembly = undefined;
  };
  const evaluate = (event: WebEvent, at: number) => {
    if (event.type === 'evaluation_started') { evaluation = add<StepOf<'evaluation'>>({ kind: 'evaluation', at, outcome: 'running' }); return; }
    const status = event.details?.status, outcome: TrajectoryOutcome = status === 'passed' ? 'passed' : 'failed';
    if (evaluation?.outcome === 'running') { evaluation.outcome = outcome; evaluation.status = status; }
    else evaluation = add<StepOf<'evaluation'>>({ kind: 'evaluation', at, outcome, status });
  };
  const notice = (event: WebEvent, at: number) => {
    const last = steps.at(-1);
    if (last?.kind === 'notice' && last.event.type === event.type && last.event.details?.taskId === event.details?.taskId) { last.count++; return; }
    add({ kind: 'notice', at, event, count: 1 });
  };
  const onEvent = (event: WebEvent, at: number) => {
    const type = event.type, details = event.details;
    if (type === 'task_assigned') { if (details?.taskId && details.workerId) owners.set(details.taskId, details.workerId); return; }
    if (type === 'task_checked' || type === 'task_check_reused' || type === 'task_failure_check_reused') return attempt(event, at);
    if (type === 'task_integrated') return integrated(event, at);
    if (type === 'task_recheck_finished' || type === 'task_conditional_recheck_finished') return recheck(event, at);
    if (type === 'assembly_started') { assembly = { workerId: details?.workerId }; return; }
    if (type === 'proof_checked') return proof(event, at);
    if (type === 'evaluation_started' || type === 'evaluation_finished') return evaluate(event, at);
    // Reading the problem opens the trajectory; plan events only date the plan revisions.
    if (type === 'ready' || type === 'solve_started' || planEvents.has(type)) return;
    if (stopEvents.has(type)) { add({ kind: 'stop', at, event }); return; }
    if (approvalEvents.has(type)) { add({ kind: 'approval', at, event }); return; }
    notice(event, at);
  };

  type Input = { at: number; order: number; sequence: number; run: () => void };
  const inputs: Input[] = data.events.map(event => ({ at: time(event.at), order: 0, sequence: event.sequence, run: () => onEvent(event, time(event.at)) }));
  const edits = [...data.edits.values()].map(item => ({ item, at: item.appliedAt ?? item.receivedAt }));
  const editSteps = new Map<string, StepOf<'edit'>>();
  for (const { item, at } of edits) if (at !== undefined)
    inputs.push({ at, order: 1, sequence: 0, run: () => { edit = add<StepOf<'edit'>>({ kind: 'edit', at, edit: item, results: [] }); editSteps.set(item.id, edit); } });
  // A plan revision is first seen in an observation; it is dated by the earliest plan event since the observation before.
  const anchors = data.events.filter(event => planEvents.has(event.type));
  const plans = [...data.plans.values()].sort((a, b) => a.observation - b.observation);
  plans.forEach((plan, position) => {
    const anchor = anchors.find(event => time(event.at) > (plan.previousAt ?? -Infinity) && time(event.at) <= plan.at);
    const at = anchor ? time(anchor.at) : plan.at, first = position === 0;
    const folded = first ? undefined : edits.find(({ at: editAt }) => editAt !== undefined && at - editAt >= -1_000 && at - editAt <= editPlanWindow);
    inputs.push({ at, order: 2, sequence: anchor?.sequence ?? 0, run: () => {
      const target = folded && editSteps.get(folded.item.id);
      if (target) { target.plan = plan; return; }
      add<StepOf<'plan'>>({ kind: 'plan', at, plan, first, workerId: anchor?.details?.workerId ?? (anchor?.type === 'initial_plan_fallback' ? undefined : lead) });
    } });
  });
  for (const guidance of data.guidance.values()) {
    const at = time(guidance.createdAt);
    if (Number.isFinite(at)) inputs.push({ at, order: 3, sequence: 0, run: () => { add({ kind: 'guidance', at, guidance }); } });
  }
  // A proof delivery is the attempt's own account and joins it; the other kinds are steps.
  for (const delivery of data.deliveries.values()) if (delivery.kind !== 'proof')
    inputs.push({ at: delivery.createdAt, order: 3, sequence: 0, run: () => { add({ kind: 'delivery', at: delivery.createdAt, delivery }); } });
  inputs.sort((a, b) => a.at - b.at || a.order - b.order || a.sequence - b.sequence);
  for (const item of inputs) item.run();

  // Checked versions that no event accounts for (their events rotated out, or were never recorded) are attempts too.
  const accounted = new Set(slots.filter(slot => slot.used).map(slot => slot.version.key));
  for (const step of steps) if ((step.kind === 'attempt' || step.kind === 'proof') && step.ref) accounted.add(step.ref.version.key);
  for (const version of data.versions.values()) {
    const check = version.checks[0];
    if (accounted.has(version.key) || !check) continue;
    steps.push({ kind: 'attempt', at: check.at, taskId: version.taskId, workerId: owners.get(version.taskId), number: 0,
      outcome: check.passed ? 'passed' : 'failed', ref: { version, check }, reused: false, integrated: false, note: noteOf(version.taskId, { version, check }) });
  }

  const ordered = steps.map((step, position) => ({ step, position })).sort((a, b) => a.step.at - b.step.at || a.position - b.position).map(item => item.step);
  const attempts = new Map<string, number>(), versions = new Map<string, TrajectoryVersion>();
  let proofs = 0;
  for (const step of ordered) {
    if (step.kind === 'attempt') {
      step.number = (attempts.get(step.taskId) ?? 0) + 1; attempts.set(step.taskId, step.number);
      const previous = versions.get(step.taskId);
      if (step.ref && previous && previous.commit !== step.ref.version.commit) step.previous = previous;
      if (step.ref) versions.set(step.taskId, step.ref.version);
    } else if (step.kind === 'proof' && !step.assembled) step.number = ++proofs;
  }

  const opening = data.events.find(event => event.type === 'ready' || event.type === 'solve_started');
  if (opening || targets.length) ordered.unshift({ kind: 'problem', at: opening ? time(opening.at) : time(input.createdAt), targets });
  const terminal = ['completed', 'cancelled', 'error'].includes(input.status);
  const stopped = ordered.some(step => step.kind === 'stop'), evaluated = ordered.some(step => step.kind === 'evaluation' && step.outcome !== 'running');
  if (terminal && !stopped && !(input.status === 'completed' && evaluated)) {
    const at = input.finishedAt ? time(input.finishedAt) : ordered.at(-1)?.at ?? time(input.createdAt);
    ordered.push({ kind: 'end', at, status: input.status });
  }
  if (input.status === 'running') {
    const workers = (input.live ?? []).filter(worker => ['running', 'checking', 'evaluating'].includes(worker.phase)).map(worker => ({ ...worker }));
    if (workers.length) ordered.push({ kind: 'live', at: ordered.at(-1)?.at ?? time(input.createdAt), workers });
  }
  return ordered;
}

/** The tasks a step is about, for the task filter; steps about the whole problem have none. */
export function stepTasks(step: TrajectoryStep): string[] {
  const planned = (plan?: TrajectoryPlan) => plan ? [...plan.added, ...plan.changed.map(change => change.after), ...plan.removed].map(item => item.id) : [];
  if (step.kind === 'attempt') return [step.taskId];
  if (step.kind === 'plan') return [...new Set(planned(step.plan))];
  if (step.kind === 'recheck') return step.results.map(result => result.taskId);
  if (step.kind === 'edit') return [...new Set([...(step.edit.affectedTasks ?? []), ...planned(step.plan), ...step.results.map(result => result.taskId)])];
  if (step.kind === 'notice') return step.event.details?.taskId ? [step.event.details.taskId] : [];
  if (step.kind === 'guidance') return step.guidance.recipient.kind === 'task' && step.guidance.recipient.id ? [step.guidance.recipient.id] : [];
  if (step.kind === 'delivery') return step.delivery.taskId ? [step.delivery.taskId] : [];
  return [];
}

/** A task as the trajectory names it: its theorem's last name, from the latest plan that names it, or else from its own
 * checks when every one of them is about the same single theorem (a run without a plan). */
export function trajectoryTaskNames(data: TrajectoryData): Map<string, string> {
  const names = new Map<string, string>();
  const name = (item: TrajectoryPlanItem) => { if (item.name) names.set(item.id, item.name.split('.').at(-1)!); };
  for (const plan of [...data.plans.values()].sort((a, b) => a.observation - b.observation)) {
    for (const item of plan.added) name(item);
    for (const change of plan.changed) name(change.after);
  }
  const checked = new Map<string, Set<string>>();
  for (const version of data.versions.values()) for (const check of version.checks) if (check.theorems.length === 1)
    checked.set(version.taskId, (checked.get(version.taskId) ?? new Set()).add(check.theorems[0]!));
  for (const [taskId, theorems] of checked) if (!names.has(taskId) && theorems.size === 1) names.set(taskId, [...theorems][0]!.split('.').at(-1)!);
  return names;
}
