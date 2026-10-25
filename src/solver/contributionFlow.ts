import type { SolverRunState } from './archive';
import type { TaskProof } from './cooperativeProof';
import type { ProofCheck } from './modules/evidence';
import type { ProofReadyRecord } from './proofReady';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { buildProofContinuation, recordedTaskProofStatus } from './progress';
import { assignmentDeliveryFile, isAdvisoryTask, taskVersion, type CooperativeTask, type TaskRecord } from './tasks';

export type ContributionEvidence = { kind: 'state'; path: string } | { kind: 'journal'; line: number };
export type ContributionObservation<T> =
  | { status: 'recorded'; value: T; evidence: ContributionEvidence[] }
  | { status: 'unknown'; reason: string }
  | { status: 'ambiguous'; reason: string; evidence: ContributionEvidence[] };
export type ContributionJournal = Readonly<{
  runBinding: 'matched' | 'mismatched' | 'unknown'; digest?: string;
  events: readonly { line: number; data: Readonly<Record<string, unknown>> }[];
}>;

type Event = ContributionJournal['events'][number];
type TaskRef = { taskId: string; taskDigest: string };
type AttemptRef = TaskRef & { assignmentKey: string };
type TimedEvidence = { value: unknown; evidence: ContributionEvidence };
// Older history entries were typed and stored as bare ProofCheck records.
type StoredProof = ProofCheck & Partial<Omit<TaskProof, keyof ProofCheck>>;
type StoredCheck = { taskId: string; proof: StoredProof; receiptIds: readonly string[]; scopeMatches: boolean };
type Attempt = AttemptRef & {
  workerId?: string; seedCommit?: string;
  identity: ContributionObservation<{ workerId: string; seedCommit: string }>;
  identityRecords: { workerId?: string; seedCommit?: string; evidence: ContributionEvidence }[];
  assigned: ContributionObservation<number>;
  assignments: { planVersion?: string; at: ContributionObservation<number>; evidence: ContributionEvidence }[];
  starts: { turnId?: string; threadId?: string; at: ContributionObservation<number>; evidence: ContributionEvidence }[];
  firstObservedStart: ContributionObservation<number>;
  assignedToFirstObservedStartMs: ContributionObservation<number>;
  ready: {
    id: string; status: ProofReadyRecord['status']; snapshotCommit?: string; sourceDigest?: string;
    evidenceKind?: 'conditional' | 'unconditional'; conditions: NonNullable<ProofReadyRecord['conditions']>;
    receiptIds: string[]; requested: ContributionObservation<number>; frozen: ContributionObservation<number>;
    checkIds: string[]; readyToCheckMs: ContributionObservation<number>; frozenToCheckMs: ContributionObservation<number>;
  }[];
};
type ReadyObservation = { ready: ProofReadyRecord; entry: Attempt['ready'][number]; attempt: Attempt };

const stateRef = (path: string) => ({ kind: 'state' as const, path });
const eventRef = (event: Event) => ({ kind: 'journal' as const, line: event.line });
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const unknown = <T>(reason: string): ContributionObservation<T> => ({ status: 'unknown', reason });
const recorded = <T>(value: T, evidence: ContributionEvidence[]): ContributionObservation<T> => ({ status: 'recorded', value, evidence });
const ambiguous = <T>(reason: string, evidence: ContributionEvidence[]): ContributionObservation<T> =>
  ({ status: 'ambiguous', reason, evidence });
const taskKey = (task: TaskRef) => canonicalMathJson([task.taskId, task.taskDigest]);
const attemptKey = (attempt: AttemptRef) => canonicalMathJson([attempt.assignmentKey, attempt.taskId, attempt.taskDigest]);
const ref = (task: CooperativeTask): TaskRef => ({ taskId: task.id, taskDigest: taskVersion(task) });
const strings = (value: unknown): string[] => Array.isArray(value) && value.every(text) ? value : [];
const equalIds = (left: readonly string[], right: readonly string[]) => left.length > 0 &&
  canonicalMathJson([...left].sort()) === canonicalMathJson([...right].sort());
const compatible = (data: Event['data'], fields: Record<string, unknown>) =>
  Object.entries(fields).every(([name, value]) => data[name] === undefined || data[name] === value);

function observedTime(values: TimedEvidence[], reason = 'not-recorded'): ContributionObservation<number> {
  const valid = values.filter((item): item is { value: number; evidence: ContributionEvidence } => time(item.value));
  if (!valid.length) return unknown(reason);
  if (new Set(valid.map(item => item.value)).size > 1)
    return ambiguous('conflicting-records', valid.map(item => item.evidence));
  return recorded(valid[0].value, valid.map(item => item.evidence));
}

function elapsed(start: ContributionObservation<number>, end: ContributionObservation<number>): ContributionObservation<number> {
  if (start.status === 'ambiguous' || end.status === 'ambiguous') return ambiguous('ambiguous-endpoint',
    [...('evidence' in start ? start.evidence : []), ...('evidence' in end ? end.evidence : [])]);
  if (start.status !== 'recorded' || end.status !== 'recorded') return unknown('endpoint-unavailable');
  if (end.value < start.value) return unknown('time-order-conflict');
  return recorded(end.value - start.value, [...start.evidence, ...end.evidence]);
}

function associateReadyCheck(check: StoredCheck, readyRecords: readonly ReadyObservation[], events: readonly Event[]): {
  boundReady: ReadyObservation[]; checkedEvents: Event[];
} {
  const { taskId, proof, receiptIds, scopeMatches } = check;
  if (!scopeMatches || !text(proof.taskDigest)) return { boundReady: [], checkedEvents: [] };
  const checkEvents = events.filter(event => event.data.event === 'proof_ready_checked');
  // Failed readiness records do not retain receipt IDs. Only an exact host event can supply that link.
  const exactFailedReadyEvent = (data: Event['data'], ready: ProofReadyRecord) =>
    !proof.passed && ready.status === 'failed' && ready.receiptIds === undefined && data.passed === false &&
    (data.readyId ?? data.receiptId) === ready.id && data.assignmentKey === ready.assignmentKey &&
    data.workerId === ready.workerId && data.seedCommit === ready.seedCommit && data.taskId === taskId &&
    data.taskDigest === proof.taskDigest && data.commit === proof.commit && data.sourceDigest === proof.sourceDigest &&
    equalIds(strings(data.receiptIds), receiptIds);
  const boundReady = readyRecords.filter(({ ready, attempt }) =>
    attempt.identity.status !== 'ambiguous' && ready.taskId === taskId && ready.taskDigest === proof.taskDigest &&
    ready.snapshotCommit === proof.commit && ready.sourceDigest === proof.sourceDigest &&
    ready.seedCommit === proof.seedCommit && (equalIds(ready.receiptIds ?? [], receiptIds) ||
      checkEvents.some(({ data }) => exactFailedReadyEvent(data, ready))));
  // Saved receipts support legacy observations; a journal-only link must remain exact for every observation.
  const checkedEvents = checkEvents.filter(({ data }) => boundReady.some(({ ready }) =>
    equalIds(ready.receiptIds ?? [], receiptIds)
      ? (data.readyId ?? data.receiptId) === ready.id && data.commit === proof.commit &&
        compatible(data, { taskId, taskDigest: proof.taskDigest, assignmentKey: ready.assignmentKey,
          workerId: ready.workerId, seedCommit: ready.seedCommit, sourceDigest: proof.sourceDigest }) &&
        (data.receiptIds === undefined || equalIds(strings(data.receiptIds), receiptIds))
      : exactFailedReadyEvent(data, ready)));
  return { boundReady, checkedEvents };
}

function associateIntegrationCheck({ taskId, proof, receiptIds, scopeMatches }: StoredCheck, events: readonly Event[]): Event[] {
  if (!scopeMatches || !text(proof.taskDigest)) return [];
  return events.filter(({ data }) => data.event === 'task_integrated' && data.taskId === taskId &&
    data.taskDigest === proof.taskDigest && data.commit === proof.commit && equalIds(strings(data.receiptIds), receiptIds) &&
    // The event's producer seed and a canonical recheck's merged-commit seed have different meanings.
    compatible(data, { sourceDigest: proof.sourceDigest }));
}

function associateSourceAttempt(source: Partial<AttemptRef>, attempts: ReadonlyMap<string, Attempt>): Attempt[] {
  const { assignmentKey, taskId, taskDigest } = source;
  if (!text(assignmentKey) || !text(taskId) || !text(taskDigest)) return [];
  const attempt = attempts.get(attemptKey({ assignmentKey, taskId, taskDigest }));
  return attempt ? [attempt] : [];
}

const trackedEvents = new Set(['delivery_published', 'task_assigned', 'turn_started',
  'proof_ready_frozen', 'proof_ready_checked', 'task_checked', 'task_integrated']);

/** Pure host report. Saved records never restore process-local proof trust or grant acceptance. */
export function buildResearchContributionFlow(state: SolverRunState, journal?: ContributionJournal) {
  const archive = state.cooperation, tasks = archive?.tasks ?? [], deliveries = archive?.deliveries ?? [];
  const continuation = buildProofContinuation(tasks, { groups: archive?.groups, environmentDigest: state.environmentDigest,
    proofRoutes: archive?.proofRoutes });
  const unresolved: { event: string; evidence: ContributionEvidence; reason: string }[] = [];
  const used = new Set<number>();
  const events = (journal?.runBinding === 'matched' ? journal.events : []).filter(event => {
    const mismatch = !compatible(event.data, { runId: state.runId, problemReceiptDigest: state.problem.receiptDigest,
      environmentDigest: state.environmentDigest });
    if (mismatch && trackedEvents.has(String(event.data.event))) unresolved.push({ event: String(event.data.event),
      evidence: eventRef(event), reason: 'run-problem-or-environment-mismatch' });
    return !mismatch;
  }).toSorted((left, right) => left.line - right.line);
  const matching = (name: string, predicate: (data: Event['data']) => boolean) =>
    events.filter(event => event.data.event === name && predicate(event.data));
  const use = (matches: Event[]) => { matches.forEach(event => used.add(event.line)); return matches; };
  const times = (matches: Event[]) => matches.map(event => ({ value: event.data.at, evidence: eventRef(event) }));
  const journalReason = !journal ? 'journal-unavailable' : journal.runBinding !== 'matched' ? 'journal-unbound' : 'not-recorded';

  const definitions = new Map<string, { task: CooperativeTask; current: boolean; status?: TaskRecord['status'] }>();
  const proofs: { task: CooperativeTask; proof: StoredProof; path: string; integrated: boolean }[] = [];
  const addProof = (task: CooperativeTask, proof: StoredProof | undefined, path: string, integrated: boolean) => {
    if (proof) proofs.push({ task, proof, path, integrated });
  };
  for (const [index, node] of (archive?.history ?? []).entries()) {
    definitions.set(taskKey(ref(node.task)), { task: node.task, current: false });
    addProof(node.task, node.proof, 'cooperation.history[' + index + '].proof', false);
    addProof(node.task, node.integratedCheck, 'cooperation.history[' + index + '].integratedCheck', true);
  }
  for (const [index, node] of tasks.entries()) {
    definitions.set(taskKey(ref(node.task)), { task: node.task, current: true, status: node.status });
    addProof(node.task, node.proof, 'cooperation.tasks[' + index + '].proof', false);
    addProof(node.task, node.integratedCheck, 'cooperation.tasks[' + index + '].integratedCheck', true);
  }

  const attempts = new Map<string, Attempt>();
  const ensureAttempt = (input: AttemptRef & { workerId?: string; seedCommit?: string }, evidence: ContributionEvidence) => {
    const key = attemptKey(input);
    let attempt = attempts.get(key);
    if (!attempt) {
      attempt = { taskId: input.taskId, taskDigest: input.taskDigest, assignmentKey: input.assignmentKey,
        identity: unknown('assignment-details-missing'), identityRecords: [], assigned: unknown(journalReason), assignments: [],
        starts: [], firstObservedStart: unknown(journalReason), assignedToFirstObservedStartMs: unknown('endpoint-unavailable'), ready: [] };
      attempts.set(key, attempt);
    }
    attempt.identityRecords.push({ workerId: input.workerId, seedCommit: input.seedCommit, evidence });
    return attempt;
  };
  for (const [index, node] of tasks.entries()) if (node.assignment) ensureAttempt({ ...node.assignment,
    assignmentKey: assignmentDeliveryFile(node.assignment) }, stateRef('cooperation.tasks[' + index + '].assignment'));
  for (const event of events) {
    const data = event.data;
    if (!['task_assigned', 'turn_started'].includes(String(data.event)) ||
        !text(data.assignmentKey) || !text(data.taskId) || !text(data.taskDigest)) continue;
    const attempt = ensureAttempt({ taskId: data.taskId, taskDigest: data.taskDigest, assignmentKey: data.assignmentKey,
      workerId: text(data.workerId) ? data.workerId : undefined, seedCommit: text(data.seedCommit) ? data.seedCommit : undefined }, eventRef(event));
    const at = observedTime([{ value: data.at, evidence: eventRef(event) }]);
    if (data.event === 'task_assigned') attempt.assignments.push({
      planVersion: text(data.planVersion) ? data.planVersion : undefined, at, evidence: eventRef(event) });
    else attempt.starts.push({ turnId: text(data.turnId) ? data.turnId : undefined,
      threadId: text(data.threadId) ? data.threadId : undefined, at, evidence: eventRef(event) });
    used.add(event.line);
  }

  const readyRecords = (archive?.proofReadyRecords ?? []).flatMap((ready, index) => {
    const evidence = stateRef('cooperation.proofReadyRecords[' + index + ']');
    if (ready.problemReceiptDigest !== state.problem.receiptDigest || ready.environmentDigest !== state.environmentDigest ||
        !text(ready.taskId) || !text(ready.taskDigest) || !text(ready.assignmentKey)) {
      unresolved.push({ event: 'stored_ready', evidence, reason: 'ready-identity-mismatch' }); return [];
    }
    const attempt = ensureAttempt({ taskId: ready.taskId, taskDigest: ready.taskDigest, assignmentKey: ready.assignmentKey,
      workerId: ready.workerId, seedCommit: ready.seedCommit }, evidence);
    const frozenEvents = use(matching('proof_ready_frozen', data => data.readyId === ready.id &&
      data.assignmentKey === ready.assignmentKey && data.taskId === ready.taskId && data.taskDigest === ready.taskDigest &&
      data.snapshotCommit === ready.snapshotCommit && data.sourceDigest === ready.sourceDigest &&
      compatible(data, { workerId: ready.workerId, seedCommit: ready.seedCommit })));
    const entry: Attempt['ready'][number] = { id: ready.id, status: ready.status, snapshotCommit: ready.snapshotCommit,
      sourceDigest: ready.sourceDigest, evidenceKind: ready.evidence, conditions: ready.conditions ?? [], receiptIds: ready.receiptIds ?? [],
      requested: observedTime([{ value: ready.requestedAt, evidence: stateRef(evidence.path + '.requestedAt') }]),
      frozen: observedTime([{ value: ready.frozenAt, evidence: stateRef(evidence.path + '.frozenAt') },
        ...frozenEvents.map(event => ({ value: event.data.frozenAt, evidence: eventRef(event) }))]),
      checkIds: [], readyToCheckMs: unknown('endpoint-unavailable'), frozenToCheckMs: unknown('endpoint-unavailable') };
    attempt.ready.push(entry);
    return [{ ready, entry, attempt }];
  });
  for (const attempt of attempts.values()) {
    const workerIds = [...new Set(attempt.identityRecords.flatMap(item => item.workerId ? [item.workerId] : []))];
    const seeds = [...new Set(attempt.identityRecords.flatMap(item => item.seedCommit ? [item.seedCommit] : []))];
    if (workerIds.length > 1 || seeds.length > 1) attempt.identity = ambiguous('assignment-identity-conflict',
      attempt.identityRecords.map(item => item.evidence));
    else if (workerIds.length && seeds.length) {
      attempt.workerId = workerIds[0]; attempt.seedCommit = seeds[0];
      attempt.identity = recorded({ workerId: workerIds[0], seedCommit: seeds[0] }, attempt.identityRecords.map(item => item.evidence));
    }
    // Re-dispatch of a saved assignment is an occurrence, not a replacement timestamp.
    attempt.assigned = attempt.assignments.length > 1 ? ambiguous('repeated-assignment',
      attempt.assignments.map(item => item.evidence)) : attempt.assignments[0]?.at ?? unknown(journalReason);
    attempt.firstObservedStart = attempt.starts[0]?.at ?? unknown(journalReason);
    const assignmentEvidence = attempt.assignments[0]?.evidence, startEvidence = attempt.starts[0]?.evidence;
    attempt.assignedToFirstObservedStartMs = attempt.identity.status === 'ambiguous'
      ? ambiguous('assignment-identity-conflict', attempt.identity.evidence)
      : assignmentEvidence?.kind === 'journal' && startEvidence?.kind === 'journal' && startEvidence.line <= assignmentEvidence.line
        ? unknown('event-order-conflict') : elapsed(attempt.assigned, attempt.firstObservedStart);
  }

  // The same check can be stored as both task proof and integration proof. Retain both paths once.
  const proofGroups = new Map<string, { proof: StoredProof; taskId: string; storedAs: {
    kind: 'task-check' | 'integrated-check'; evidence: ContributionEvidence; taskDigest: string;
    recordedProof: ReturnType<typeof recordedTaskProofStatus> | 'unknown';
  }[] }>();
  for (const { task, proof, path, integrated } of proofs) {
    const id = mathDigest(canonicalMathJson({ taskId: task.id, proof }));
    const group = proofGroups.get(id) ?? { proof, taskId: task.id, storedAs: [] };
    group.storedAs.push({ kind: integrated ? 'integrated-check' : 'task-check', evidence: stateRef(path),
      taskDigest: taskVersion(task),
      recordedProof: text(proof.taskDigest) ? recordedTaskProofStatus({
        task, proof: proof as TaskProof, status: 'delivered', attempts: 0,
      }, state.environmentDigest) : 'unknown' });
    proofGroups.set(id, group);
  }
  const checks = [...proofGroups].map(([id, { taskId, proof, storedAs }]) => {
    const receiptIds = proof.verification.results.map(result => result.receiptId).filter(text);
    const scopeMatches = (!proof.projection || proof.projection.environmentDigest === state.environmentDigest &&
      proof.projection.problemReceiptDigest === state.problem.receiptDigest) &&
      (!proof.references || proof.references.environmentDigest === state.environmentDigest);
    const storedCheck = { taskId, proof, receiptIds, scopeMatches };
    const association = associateReadyCheck(storedCheck, readyRecords, events);
    const boundReady = association.boundReady, checkedEvents = use(association.checkedEvents);
    const integrationEvents = use(associateIntegrationCheck(storedCheck, events));
    const started = observedTime(storedAs.map(item => ({
      value: proof.verification.startedAt, evidence: stateRef((item.evidence as { path: string }).path + '.verification.startedAt'),
    })));
    const checked = observedTime(storedAs.map(item => ({
      value: proof.verification.checkedAt, evidence: stateRef((item.evidence as { path: string }).path + '.verification.checkedAt'),
    })));
    const integratedAt = observedTime(times(integrationEvents), journalReason);
    for (const { entry } of boundReady) entry.checkIds.push(id);
    return { id, taskId, taskDigest: proof.taskDigest, commit: proof.commit, sourceDigest: proof.sourceDigest,
      seedCommit: proof.seedCommit, receiptIds, storedAs, scopeMatches,
      currentTaskVersion: tasks.some(node => node.task.id === taskId && taskVersion(node.task) === proof.taskDigest),
      evidenceKind: proof.conditions?.length ? 'conditional' as const : 'unconditional' as const, conditions: proof.conditions ?? [],
      readyIds: boundReady.map(({ ready }) => ready.id), checkEvents: checkedEvents.map(eventRef),
      checkObserved: observedTime(times(checkedEvents), journalReason), started, checked, integrated: integratedAt,
      checkDurationMs: elapsed(started, checked), checkedToIntegratedMs: elapsed(checked, integratedAt) };
  });
  for (const { entry } of readyRecords) {
    const linked = checks.filter(check => entry.checkIds.includes(check.id));
    const start = observedTime(linked.flatMap(check => check.started.status === 'recorded'
      ? check.started.evidence.map(evidence => ({ value: check.started.status === 'recorded' ? check.started.value : undefined, evidence })) : []));
    entry.readyToCheckMs = elapsed(entry.requested, start);
    entry.frozenToCheckMs = elapsed(entry.frozen, start);
  }

  const sources = deliveries.flatMap((delivery, index) => {
    if (delivery.kind !== 'research') return [];
    const publications = use(matching('delivery_published', data => data.deliveryId === delivery.id &&
      compatible(data, { taskId: delivery.taskId, taskDigest: delivery.taskDigest, commit: delivery.commit,
        assignmentKey: delivery.assignmentKey, sourceDigest: delivery.sourceDigest })));
    return [{ deliveryId: delivery.id, producer: delivery.producer, taskId: delivery.taskId, taskDigest: delivery.taskDigest,
      assignmentKey: delivery.assignmentKey, commit: delivery.commit, sourceDigest: delivery.sourceDigest,
      findingDigest: delivery.findingDigest, status: delivery.status,
      proposals: (delivery.lemmaRequests ?? []).map(task => ({ task, taskDigest: taskVersion(task) })),
      currentTaskVersion: tasks.some(node => node.task.id === delivery.taskId && taskVersion(node.task) === delivery.taskDigest),
      created: observedTime([{ value: delivery.createdAt, evidence: stateRef('cooperation.deliveries[' + index + '].createdAt') }]),
      publication: observedTime(times(publications), journalReason), publicationInThisRun: publications.length > 0,
      publicationEvents: publications.map(eventRef),
      attempts: associateSourceAttempt(delivery, attempts),
    }];
  });

  const obligations = new Map<string, TaskRef>();
  const advisoryKeys = new Set([
    ...[...definitions.values()].filter(item => isAdvisoryTask(item.task)).map(item => taskKey(ref(item.task))),
    ...sources.flatMap(source => text(source.taskId) && text(source.taskDigest)
      ? [taskKey({ taskId: source.taskId, taskDigest: source.taskDigest })] : []),
  ]);
  for (const definition of definitions.values()) if (!isAdvisoryTask(definition.task))
    obligations.set(taskKey(ref(definition.task)), ref(definition.task));
  for (const attempt of attempts.values()) {
    if (!advisoryKeys.has(taskKey(attempt))) obligations.set(taskKey(attempt), { taskId: attempt.taskId, taskDigest: attempt.taskDigest });
  }
  for (const check of checks) if (text(check.taskDigest)) {
    const task = { taskId: check.taskId, taskDigest: check.taskDigest }; obligations.set(taskKey(task), task);
  }
  const obligationReports = [...obligations.values()].map(task => {
    const definition = definitions.get(taskKey(task));
    const reuse = definition?.current ? continuation.reuse.find(item => item.taskId === task.taskId) : undefined;
    return { ...task, currentTaskVersion: definition?.current ?? false, task: definition?.task, status: definition?.status,
      attempts: [...attempts.values()].filter(attempt => taskKey(attempt) === taskKey(task)),
      checkIds: checks.filter(check => check.taskId === task.taskId && check.taskDigest === task.taskDigest).map(check => check.id),
      // Reuse the continuation module's planned / proof / statement / conditional distinctions.
      uses: reuse, referenceCoverage: 'unknown' as const };
  });

  for (const event of events) if (trackedEvents.has(String(event.data.event)) && !used.has(event.line)) {
    const data = event.data;
    if (data.event === 'turn_started' && !data.taskId && !data.assignmentKey) continue;
    unresolved.push({ event: String(data.event), evidence: eventRef(event),
      reason: ['task_assigned', 'turn_started'].includes(String(data.event)) && !text(data.assignmentKey)
        ? 'assignment-identity-missing' : 'exact-record-match-unavailable' });
  }
  return { schema: 'theoremos.contribution-flow.v1' as const, evidence: 'recorded-not-replayed' as const,
    runId: state.runId, problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest,
    stateDigest: mathDigest(canonicalMathJson(state)), journalDigest: journal?.digest,
    coverage: { journal: journal?.runBinding ?? 'absent', executionHistory: 'partial' as const },
    continuation: state.continuationDigest ? { snapshotDigest: state.continuationDigest, executionHistory: 'not-inferred' as const } : undefined,
    sources, obligations: obligationReports, checks,
    modelReportedUses: [
      ...(state.knowledgeUses ?? []).map(item => ({ ...item, origin: 'run-original' as const })),
      ...deliveries.flatMap(delivery => (delivery.knowledgeUses ?? []).map(item => ({ ...item,
        deliveryId: delivery.id, origin: 'delivery' as const }))),
    ],
    unresolved };
}

export type ResearchContributionFlow = ReturnType<typeof buildResearchContributionFlow>;

/** Reported executions in presentation order: obligations first, then sources, once per exact assignment identity. */
export function contributionExecutionAttempts(flow: ResearchContributionFlow): readonly Attempt[] {
  return [...new Map([
    ...flow.obligations.flatMap(item => item.attempts), ...flow.sources.flatMap(item => item.attempts),
  ].map(attempt => [attemptKey(attempt), attempt])).values()];
}
