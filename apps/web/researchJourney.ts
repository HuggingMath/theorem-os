import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { WebStorage, WebStorageError } from './storage';
import { researchBriefTask } from './researchProblemEvidence';
import type { WebJobs } from './jobs';
import type { WebResearchProjects } from './researchProjects';
import type { WebResearchProblems } from './researchProblems';
import type { WebResearchWorkspace } from './researchWorkspace';
import type { ResearchProblem } from './researchProblemTypes';
import type { ResearchBriefTask } from './researchWorkspaceTypes';
import type { WebObservation, WebTaskSource } from './collaboration';
import type { WebRun } from './shared';
import type { ResearchJourney, ResearchJourneyAttempt, ResearchJourneyLineage, ResearchJourneyRecord, ResearchJourneySource,
  ResearchJourneySourceRef, ResearchReadReceipt, ResearchUnreadChange, ResearchUnreadChanges } from './researchJourneyTypes';

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u), hash = z.string().regex(/^[a-f0-9]{64}$/u);
const textId = z.string().min(1).max(500), commitId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> => {
  const result = schema.safeParse(value);
  if (!result.success) throw new WebStorageError(400, '研究路线请求格式无效。');
  return result.data;
};
const fail = (status: number, message: string): never => { throw new WebStorageError(status, message); };
const digest = (value: unknown) => mathDigest(canonicalMathJson(value));
const unavailable = (error: unknown) => error instanceof WebStorageError && [403, 404].includes(error.status);
type Dependencies = { storage: WebStorage; projects: WebResearchProjects; jobs: WebJobs; problems: WebResearchProblems; workspace: WebResearchWorkspace };
type Located = { run: WebRun; owner: string; projectId?: string; problem: ResearchProblem; observations: WebObservation[] };
type Snapshot = { key: string; digest: string; capturedAt: string; records: ResearchJourneyRecord[] };
type ReadState = { revision: number; snapshotDigest: string; readAt: string;
  operations: Record<string, { digest: string; receipt: ResearchReadReceipt }> };
const problemHref = (runId: string, projectId?: string, fields: Record<string, string> = {}) =>
  `problem.html?${new URLSearchParams({ run: runId, ...(projectId ? { project: projectId } : {}), ...fields })}`;
const sameSource = (source: WebTaskSource, ref: Pick<ResearchJourneySourceRef, 'taskId' | 'taskVersion' | 'commit' | 'sourceDigest' | 'environmentDigest' | 'file'>) =>
  source.taskId === ref.taskId && source.taskVersion === ref.taskVersion && source.commit === ref.commit
  && source.sourceDigest === ref.sourceDigest && source.environmentDigest === ref.environmentDigest && source.file === ref.file;
const recordId = (run: string, kind: string, id: string) => digest([run, kind, id]);

/** All cross-attempt evidence is resolved through its original run's current permission boundary. */
export class WebResearchJourney {
  constructor(private readonly dependencies: Dependencies) {}
  private account(viewer: string) { if (!viewer || viewer === 'public') fail(401, '请先登录。'); return mathDigest(viewer); }
  private locate(viewer: string, runId: string, projectId?: string): Located {
    this.account(viewer); parse(key, runId); if (projectId) parse(key, projectId);
    const problem = this.dependencies.problems.detail(viewer, runId, projectId);
    const boundProject = problem.project?.runs.some(binding => binding.runId === runId) ? problem.project.id : projectId;
    const own = this.dependencies.jobs.get(viewer, runId);
    const bound = boundProject ? this.dependencies.projects.resolveBinding(viewer, boundProject, runId) : undefined;
    const run = bound?.run ?? own ?? fail(404, '研究记录不存在。');
    return { run, owner: bound?.runOwner ?? viewer, ...(boundProject ? { projectId: boundProject } : {}), problem,
      observations: this.dependencies.storage.listObservations(bound?.runOwner ?? viewer, runId) };
  }
  private sourceCandidates(located: Located, taskId: string, commit?: string) {
    const observations = [...located.observations, ...(located.run.observation ? [located.run.observation] : [])];
    const candidates = new Map<string, { source: WebTaskSource; observation: WebObservation }>();
    for (const observation of observations) for (const source of observation.sources) {
      if (source.taskId !== taskId || commit && source.commit !== commit) continue;
      const identity = digest([source.taskId, source.taskVersion, source.commit, source.sourceDigest, source.environmentDigest, source.file]);
      if (!candidates.has(identity)) candidates.set(identity, { source, observation });
    }
    return [...candidates.values()];
  }
  private sourceRef(located: Located, selected: { source: WebTaskSource; observation: WebObservation }): ResearchJourneySourceRef {
    const { source, observation } = selected;
    return { runId: located.run.id, ...(located.projectId ? { projectId: located.projectId } : {}), taskId: source.taskId,
      taskVersion: source.taskVersion, commit: source.commit, sourceDigest: source.sourceDigest,
      environmentDigest: source.environmentDigest, file: source.file,
      observation: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest } };
  }
  private exactTask(located: Located, selected: { source: WebTaskSource; observation: WebObservation }): ResearchBriefTask | undefined {
    const { source, observation } = selected;
    const task = [...observation.inspection.tasks, ...(observation.history ?? [])].find(task =>
      task.id === source.taskId && task.version === source.taskVersion);
    if (!task) return;
    // The source reference, rather than the latest proof head, chooses this historical record.
    const frozen = { ...task, proof: { ...task.proof, commit: source.commit, sourceDigest: source.sourceDigest } };
    return researchBriefTask(frozen, { ...observation, inspection: { ...observation.inspection,
      configuration: { ...observation.inspection.configuration, environmentDigest: source.environmentDigest } } }, observation.checks,
    target => problemHref(located.run.id, located.projectId, { tab: 'route', task: target.id, taskVersion: target.version, commit: source.commit }));
  }
  private attempt(located: Located): ResearchJourneyAttempt {
    const { run, problem, observations } = located, brief = problem.brief;
    const tasks = brief.tasks.map(task => {
      const sources = this.sourceCandidates(located, task.id, task.commit).filter(({ source }) => source.taskVersion === task.version
        && Boolean(task.commit && task.sourceDigest && task.environmentDigest) && source.sourceDigest === task.sourceDigest
        && source.environmentDigest === task.environmentDigest);
      return { task, sourceStatus: sources.length === 1 ? 'available' as const : sources.length > 1 ? 'ambiguous' as const : 'unrecorded' as const,
        ...(sources.length === 1 ? { source: this.sourceRef(located, sources[0]!) } : {}),
        dependents: brief.tasks.filter(next => next.dependsOn.includes(task.id)).map(next => next.id) };
    });
    const checks = [...new Map([...observations, ...(run.observation ? [run.observation] : [])].flatMap(item => item.checks).map(check => [check.id, check])).values()];
    return { id: run.id, ...(located.projectId ? { projectId: located.projectId } : {}),
      ...(problem.project?.runs.find(item => item.runId === run.id)?.statementVersionId
        ? { statementVersionId: problem.project.runs.find(item => item.runId === run.id)!.statementVersionId } : {}),
      title: run.title, status: brief.status, accepted: brief.accepted, createdAt: run.createdAt,
      href: problemHref(run.id, located.projectId, { tab: 'route' }), statement: brief.statement, sourceDigest: brief.sourceDigest,
      ...(problem.observationRef ? { observation: problem.observationRef } : {}),
      ...(run.failure || run.error ? { failure: run.failure?.kind ?? run.error } : {}), tasks, checks, decisions: brief.decisions };
  }
  private collect(viewer: string, runId: string, projectId?: string) {
    const selected = this.locate(viewer, runId, projectId), located = new Map<string, Located>([[runId, selected]]);
    const candidates = selected.problem.project?.permissions.member ? selected.problem.project.runs.map(binding => binding.runId)
      : selected.problem.brief.attempts.map(attempt => attempt.id);
    const add = (id: string, context?: string) => {
      if (located.has(id)) return;
      try { located.set(id, this.locate(viewer, id, context)); }
      catch (error) { if (!unavailable(error)) throw error; }
    };
    for (const id of candidates) {
      add(id, selected.projectId);
      if (!located.has(id)) add(id);
    }
    // Follow only saved continuation references; dates and matching task names create no lineage.
    for (const attempt of located.values()) if (attempt.run.continueFrom) {
      const origin = attempt.run.continueFrom.runId;
      if (located.has(origin)) continue;
      add(origin, attempt.projectId);
      if (!located.has(origin)) add(origin);
    }
    // A continuation may change the original statement. Its saved link still belongs in this journey.
    const owned = this.dependencies.jobs.list(viewer);
    let added = true;
    while (added) {
      const size = located.size;
      for (const run of owned) if (run.continueFrom && located.has(run.continueFrom.runId)) add(run.id);
      added = located.size !== size;
    }
    const attempts = [...located.values()].map(item => this.attempt(item)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const lineage: ResearchJourneyLineage[] = [];
    for (const child of located.values()) {
      const continuation = child.run.continueFrom;
      if (!continuation) continue;
      const origin = located.get(continuation.runId), candidates = origin ? this.sourceCandidates(origin, continuation.taskId, continuation.commit)
        .filter(({ source }) => (['taskVersion', 'sourceDigest', 'environmentDigest', 'file'] as const)
          .every(field => continuation[field] === undefined || continuation[field] === source[field])) : [];
      const source = origin && candidates.length === 1 ? this.sourceRef(origin, candidates[0]!) : undefined;
      lineage.push({ id: digest([child.run.id, continuation]), fromRunId: continuation.runId, toRunId: child.run.id,
        taskId: continuation.taskId, commit: continuation.commit, status: source ? 'recorded' : candidates.length > 1 ? 'ambiguous' : 'unavailable',
        ...(source ? { source, task: this.exactTask(origin!, candidates[0]!) } : {}) });
    }
    const journey: ResearchJourney = { schema: 'theorem-os.research-journey.v1', key: selected.problem.key,
      title: selected.problem.brief.title, selectedRunId: runId, attempts, lineage };
    return { journey, located, selected };
  }
  journey(viewer: string, runId: string, projectId?: string) { return this.collect(viewer, runId, projectId).journey; }
  source(viewer: string, runId: string, projectId: string | undefined, raw: unknown): ResearchJourneySource {
    const ref = parse(z.object({ taskId: textId, taskVersion: textId, commit: commitId, sourceDigest: hash, environmentDigest: hash, file: textId }).strict(), raw) as
      Pick<ResearchJourneySourceRef, 'taskId' | 'taskVersion' | 'commit' | 'sourceDigest' | 'environmentDigest' | 'file'>;
    const located = this.locate(viewer, runId, projectId), matching = this.sourceCandidates(located, ref.taskId, ref.commit).filter(item => sameSource(item.source, ref));
    if (matching.length !== 1) fail(404, '此任务的精确源码版本没有保存或已不可访问。');
    return { ref: this.sourceRef(located, matching[0]!), task: this.exactTask(located, matching[0]!), source: matching[0]!.source };
  }
  private records(collected: ReturnType<WebResearchJourney['collect']>): ResearchJourneyRecord[] {
    const records: ResearchJourneyRecord[] = [];
    const add = (record: Omit<ResearchJourneyRecord, 'digest'>) => {
      const evidence = record.kind === 'task' && record.task ? { ...record, task: { ...record.task, checks: [], href: '' } } : record;
      records.push({ ...record, digest: digest(evidence) });
    };
    for (const attempt of collected.journey.attempts) {
      const context = { runId: attempt.id, ...(attempt.projectId ? { projectId: attempt.projectId } : {}) };
      for (const item of attempt.tasks) add({ ...context, id: recordId(attempt.id, 'task', item.task.id), kind: 'task', title: item.task.title,
        version: item.task.version, task: item.task, ...(item.source ? { source: item.source } : {}),
        authority: { kind: 'task', id: item.task.id }, sections: [
          { title: 'Status', text: `${item.task.status} · ${item.task.proofStatus}` },
          { title: 'Statement', text: item.task.statement ?? item.task.objective }, { title: 'Premises', text: item.task.premises.join('\n') },
          { title: 'Derivation', text: item.task.derivation ?? '' }, { title: 'Dependencies', text: item.task.dependsOn.join('\n') },
          { title: 'Finding', text: item.task.finding ?? '' }, { title: 'Feedback', text: item.task.feedback ?? '' },
        ] });
      for (const check of attempt.checks) {
        const item = collected.located.get(attempt.id)!, source = this.sourceCandidates(item, check.taskId, check.commit).find(candidate =>
          candidate.source.taskVersion === check.taskVersion && candidate.source.sourceDigest === check.sourceDigest && candidate.source.environmentDigest === check.environmentDigest);
        add({ ...context, id: recordId(attempt.id, 'check', check.id), kind: 'check', title: check.taskId, version: check.taskVersion,
          check, ...(source ? { source: this.sourceRef(item, source) } : {}), authority: { kind: 'check', id: check.id },
          sections: [{ title: 'Check receipt', text: check.id }, { title: 'Status', text: check.record.passed === true ? 'passed' : 'failed' },
            { title: 'Recorded result', text: JSON.stringify(check.record, null, 2) }] });
      }
      for (const decision of attempt.decisions) add({ ...context, id: recordId(attempt.id, 'human', decision.id), kind: 'human',
        title: decision.text, version: decision.after?.planVersion ?? decision.planVersion ?? decision.before?.planVersion ?? decision.id,
        decision, authority: { kind: 'decision', id: decision.id }, sections: [
          { title: 'Human action', text: decision.text }, { title: 'Delivery', text: decision.delivery }, { title: 'Decision', text: decision.decision },
          { title: 'Reason', text: decision.reason ?? '' }, { title: 'Execution', text: decision.execution ?? '' },
          { title: 'Evidence', text: decision.evidenceRefs.join('\n') },
        ] });
    }
    const projects = new Map([...collected.located.values()].flatMap(item => item.problem.project?.permissions.member ? [[item.problem.project.id, item.problem] as const] : []));
    for (const [projectId, problem] of projects) {
      const addHuman = (kind: ResearchJourneyRecord['authority']['kind'], item: { id: string }, runId: string, title: string, value: unknown) => {
        if (!collected.located.has(runId)) return;
        add({ id: recordId(runId, kind, item.id), runId, projectId, kind: 'human', title,
          version: String((item as { revision?: number }).revision ?? item.id), authority: { kind, id: item.id },
          sections: [{ title: 'Recorded action', text: JSON.stringify(value, null, 2) }] });
      };
      for (const feedback of problem.project!.feedback) {
        const runId = feedback.target?.runId ?? collected.selected.run.id;
        const decisions = collected.journey.attempts.find(attempt => attempt.id === runId)?.decisions ?? [];
        if (!decisions.some(decision => decision.id === feedback.id || decision.id === feedback.requestId))
          addHuman('feedback', feedback, runId, feedback.text, feedback);
      }
      for (const assignment of problem.project!.assignments) addHuman('assignment', assignment, assignment.target.runId, assignment.target.taskRef?.id ?? assignment.id, assignment);
      for (const handoff of problem.collaboration?.handoffs ?? []) addHuman('handoff', handoff, handoff.target.runId, handoff.note, handoff);
      for (const issue of problem.collaboration?.issues ?? []) addHuman('issue', issue, issue.target?.runId ?? collected.selected.run.id, issue.title, issue);
    }
    return records.sort((a, b) => a.id.localeCompare(b.id));
  }
  private readPath(viewer: string, problemKey: string) { return ['owners', this.account(viewer), 'research-reading', `${problemKey}.json`]; }
  private snapshotPath(viewer: string, problemKey: string, snapshot: string) { return ['owners', this.account(viewer), 'research-reading', problemKey, `${snapshot}.json`]; }
  private capture(viewer: string, collected: ReturnType<WebResearchJourney['collect']>): Snapshot {
    const records = this.records(collected), key = collected.journey.key, snapshotDigest = digest({ key, records: records.map(record => [record.id, record.digest]) });
    const path = this.snapshotPath(viewer, key, snapshotDigest), previous = this.dependencies.storage.getRecord<Snapshot>(path);
    if (previous) return previous;
    const snapshot = { key, digest: snapshotDigest, capturedAt: new Date().toISOString(), records };
    this.dependencies.storage.saveRecord(path, snapshot, true); return snapshot;
  }
  private recordVisible(viewer: string, record: ResearchJourneyRecord, visibleRuns = new Map<string, Located>()) {
    try {
      const located = visibleRuns.get(record.runId) ?? this.locate(viewer, record.runId, record.projectId), { kind, id } = record.authority;
      visibleRuns.set(record.runId, located);
      if (kind === 'task') return [...located.observations, ...(located.run.observation ? [located.run.observation] : [])].some(observation =>
        [...observation.inspection.tasks, ...(observation.history ?? [])].some(task => task.id === id && task.version === record.version));
      if (kind === 'check') return [...located.observations, ...(located.run.observation ? [located.run.observation] : [])].some(observation => observation.checks.some(check => check.id === id));
      if (kind === 'decision') return located.problem.brief.decisions.some(decision => decision.id === id);
      const project = located.problem.project;
      if (!project?.permissions.member) return false;
      if (kind === 'feedback') return project.feedback.some(item => item.id === id);
      if (kind === 'assignment') return project.assignments.some(item => item.id === id);
      if (kind === 'handoff') return located.problem.collaboration?.handoffs.some(item => item.id === id) ?? false;
      return located.problem.collaboration?.issues.some(item => item.id === id) ?? false;
    } catch (error) { if (unavailable(error)) return false; throw error; }
  }
  changes(viewer: string, runId: string, projectId?: string): ResearchUnreadChanges {
    const collected = this.collect(viewer, runId, projectId), current = this.capture(viewer, collected), path = this.readPath(viewer, current.key);
    let state = this.dependencies.storage.getRecord<ReadState>(path), baselineCreated = false;
    if (!state) {
      state = { revision: 1, snapshotDigest: current.digest, readAt: current.capturedAt, operations: {} }; baselineCreated = true;
      this.dependencies.storage.saveRecord(path, state);
    }
    const baseline = this.dependencies.storage.getRecord<Snapshot>(this.snapshotPath(viewer, current.key, state.snapshotDigest));
    const visible = new Set(collected.journey.attempts.map(attempt => attempt.id));
    const before = new Map((baseline?.records ?? []).filter(record => visible.has(record.runId) && this.recordVisible(viewer, record, collected.located)).map(record => [record.id, record]));
    const after = new Map(current.records.map(record => [record.id, record])), changes: ResearchUnreadChange[] = [];
    const link = (record: ResearchJourneyRecord, snapshot: string) => ({ id: record.id, kind: record.kind, runId: record.runId,
      title: record.title, version: record.version, snapshotDigest: snapshot,
      href: `${problemHref(runId, collected.selected.projectId, { tab: 'overview', snapshot, changeRecord: record.id })}#research-changes` });
    if (baseline) for (const id of new Set([...before.keys(), ...after.keys()])) {
      const old = before.get(id), next = after.get(id);
      if (old?.digest === next?.digest) continue;
      const value = next ?? old!;
      changes.push({ id, kind: value.kind, change: !old ? 'added' : !next ? 'removed' : 'updated', title: value.title, runId: value.runId,
        ...(old ? { before: link(old, baseline.digest) } : {}), ...(next ? { after: link(next, current.digest) } : {}) });
    }
    return { schema: 'theorem-os.research-unread.v1', key: current.key, revision: state.revision, readAt: state.readAt,
      snapshotDigest: current.digest, capturedAt: current.capturedAt, baselineCreated, changes,
      counts: { task: changes.filter(item => item.kind === 'task').length, check: changes.filter(item => item.kind === 'check').length, human: changes.filter(item => item.kind === 'human').length } };
  }
  markRead(viewer: string, runId: string, projectId: string | undefined, raw: unknown): ResearchReadReceipt {
    const input = parse(z.object({ requestId: textId, expectedRevision: z.number().int().positive(), snapshotDigest: hash }).strict(), raw);
    const collected = this.collect(viewer, runId, projectId), problemKey = collected.journey.key, path = this.readPath(viewer, problemKey);
    const state = this.dependencies.storage.getRecord<ReadState>(path) ?? fail(409, '请先读取变化摘要。');
    const requestDigest = digest({ problemKey, ...input }), previous = state.operations[input.requestId];
    if (previous) { if (previous.digest !== requestDigest) fail(409, '此请求 ID 已用于另一项已阅操作。'); return previous.receipt; }
    if (state.revision !== input.expectedRevision) fail(409, '另一页面已更新已阅位置，请刷新摘要后重试。');
    const snapshot = this.dependencies.storage.getRecord<Snapshot>(this.snapshotPath(viewer, problemKey, input.snapshotDigest)) ?? fail(409, '请先读取要标记的变化记录。');
    if (snapshot.key !== problemKey || snapshot.records.some(record => !this.recordVisible(viewer, record, collected.located))) fail(409, '部分研究记录已不可访问，请刷新摘要后重试。');
    const receipt = { revision: state.revision + 1, snapshotDigest: snapshot.digest, readAt: new Date().toISOString() };
    this.dependencies.storage.saveRecord(path, { ...state, ...receipt, operations: { ...state.operations, [input.requestId]: { digest: requestDigest, receipt } } });
    return receipt;
  }
  record(viewer: string, runId: string, projectId: string | undefined, snapshotDigest: string, id: string): ResearchJourneyRecord {
    parse(hash, snapshotDigest); parse(hash, id);
    const located = this.locate(viewer, runId, projectId), snapshot = this.dependencies.storage.getRecord<Snapshot>(this.snapshotPath(viewer, located.problem.key, snapshotDigest));
    const record = snapshot?.records.find(record => record.id === id) ?? fail(404, '变化对应的保存记录不存在。');
    if (!this.recordVisible(viewer, record, new Map([[runId, located]]))) fail(404, '变化对应的记录已不可访问。');
    return record;
  }
}

/** Mount after the host's authentication and write guards, before generic workspace routes. */
export function createResearchJourneyHandler(dependencies: Dependencies) {
  const service = new WebResearchJourney(dependencies);
  return async (url: URL, method: string, viewer: string, readBody: () => Promise<unknown>): Promise<{ status: number; body: unknown } | undefined> => {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'api' || parts[1] !== 'research' || parts[2] !== 'workspace' || parts[3] !== 'problem' || !parts[4] || !['journey', 'changes'].includes(parts[5] ?? '')) return;
    const [, , , , runId, section, action] = parts, projectId = url.searchParams.get('project') ?? undefined;
    const item = (value: unknown) => ({ status: 200, body: { item: value } });
    if (parts.length === 6 && method === 'GET') return item(section === 'journey' ? service.journey(viewer, runId!, projectId) : service.changes(viewer, runId!, projectId));
    if (section === 'changes' && action === 'read' && parts.length === 7 && method === 'POST') return item(service.markRead(viewer, runId!, projectId, await readBody()));
    if (section === 'journey' && action === 'source' && parts.length === 7 && method === 'GET') return item(service.source(viewer, runId!, projectId, {
      taskId: url.searchParams.get('task'), taskVersion: url.searchParams.get('taskVersion'), commit: url.searchParams.get('commit'),
      sourceDigest: url.searchParams.get('sourceDigest'), environmentDigest: url.searchParams.get('environmentDigest'), file: url.searchParams.get('file') }));
    if (section === 'journey' && action === 'record' && parts.length === 7 && method === 'GET') return item(service.record(viewer, runId!, projectId,
      url.searchParams.get('snapshot') ?? '', url.searchParams.get('record') ?? ''));
    return { status: 405, body: { error: '此研究路线操作不支持该请求方式。' } };
  };
}
