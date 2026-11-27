import { z } from 'zod';
import { mathDigest } from '../../src/math/mathRuntimeIo';
import { WebStorage, WebStorageError } from './storage';
import type { WebJobs } from './jobs';
import type { WebResearchProjects } from './researchProjects';
import type { WebResearchAssets } from './researchAssets';
import type { WebKnowledgeService } from './knowledgeService';
import type { ResearchProjectDetail } from './researchProjectTypes';
import type { ResearchOverviewData } from './researchOverviewTypes';
import { buildResearchOverview } from './client/researchOverviewModel';
import type { WebConversation } from './conversationTypes';
import type { WebFormalization } from './formalizationTypes';
import type { WebRun } from './shared';
import { researchBriefDecisions, researchBriefTask } from './researchProblemEvidence';
import { researchHistoryRecords } from './researchHistory';
import type { ResearchBrief, ResearchSearchHit, ResearchSearchKind, ResearchSearchResult, ResearchTokenRate,
  ResearchUsageEntry, ResearchUsageLedger } from './researchWorkspaceTypes';

const enc = encodeURIComponent;
const validNumber = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
function tokens(usage: unknown): number | null {
  const value = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {};
  const total = validNumber(value.totalTokens), input = validNumber(value.inputTokens), output = validNumber(value.outputTokens);
  return total ?? (input !== null && output !== null ? input + output : null);
}
const duration = (start: string, end?: string) => {
  const value = Date.parse(end ?? '') - Date.parse(start);
  return Number.isFinite(value) ? Math.max(0, value) : null;
};
const accepted = (run: WebRun) => run.status === 'completed' && run.result?.status === 'evaluated_passed';
type TaskLink = { id: string; version: string; commit?: string };
const theoremHref = (projectId: string, runId?: string, task?: TaskLink) =>
  `theorems.html?${new URLSearchParams({ id: projectId, ...(runId ? { run: runId } : {}),
    ...(task ? { task: task.id, taskVersion: task.version, ...(task.commit ? { commit: task.commit } : {}) } : {}) })}`;
type RunView = { run: WebRun; projectId?: string; owned: boolean };
const runHref = (view: RunView, task?: TaskLink) => view.owned
  ? `./?${new URLSearchParams({ run: view.run.id, ...(task ? { view: 'route', task: task.id, taskVersion: task.version, ...(task.commit ? { commit: task.commit } : {}) } : {}) })}`
  : theoremHref(view.projectId!, view.run.id, task);
const rateSchema = z.object({ providerId: z.string().min(1).max(128), model: z.string().min(1).max(200),
  currency: z.enum(['CNY', 'USD']), perMillion: z.number().finite().min(0).max(1_000_000) }).strict();

/** Aggregation stays in the optional web service; it never starts a model or changes a frozen research record. */
export class WebResearchWorkspace {
  constructor(private storage: WebStorage, private jobs: WebJobs, private projects: WebResearchProjects,
    private assets: WebResearchAssets, private knowledge: WebKnowledgeService) {}
  private ownerPath(viewer: string) { return ['owners', mathDigest(viewer)]; }
  private personal(viewer: string) {
    if (viewer === 'public') throw new WebStorageError(401, '请先登录。');
  }
  private records(viewer: string) {
    this.personal(viewer);
    const path = this.ownerPath(viewer);
    const conversations = this.storage.listRecords([...path, 'conversations']).flatMap(file => {
      if (!/^[a-f0-9-]{36}\.json$/u.test(file)) return [];
      const value = this.storage.getRecord<WebConversation>([...path, 'conversations', file]);
      return value ? [value] : [];
    });
    const formalizations = this.storage.listRecords([...path, 'formalizations']).flatMap(id => {
      if (!/^[a-f0-9-]{36}$/u.test(id)) return [];
      const record = this.storage.getRecord<{ formalization: WebFormalization }>([...path, 'formalizations', id, 'record.json']);
      return record ? [record.formalization] : [];
    });
    const projects: ResearchProjectDetail[] = [];
    for (let offset = 0;; offset += 100) {
      const page = this.projects.list(viewer, { offset, limit: 100 });
      projects.push(...page.items.map(item => this.projects.detail(viewer, item.id)));
      if (page.nextOffset === undefined) break;
    }
    const runs = new Map<string, RunView>(this.jobs.list(viewer).map(run => [run.id, { run, owned: true }]));
    for (const project of projects) if (project.permissions.member) for (const binding of project.runs) {
      if (!binding.permissions.read || runs.has(binding.runId)) continue;
      const resolved = this.projects.resolveBinding(viewer, project.id, binding.runId);
      runs.set(binding.runId, { run: resolved.run, projectId: project.id, owned: resolved.runOwner === viewer });
    }
    return { conversations, formalizations, projects, runs: [...runs.values()] };
  }
  rates(viewer: string): ResearchTokenRate[] {
    this.personal(viewer);
    return this.storage.getRecord<ResearchTokenRate[]>([...this.ownerPath(viewer), 'usage-rates.json']) ?? [];
  }
  saveRate(viewer: string, value: unknown) {
    this.personal(viewer);
    const parsed = rateSchema.extend({ requestId: z.string().min(1).max(200) }).strict().safeParse(value);
    if (!parsed.success) throw new WebStorageError(400, '请填写有效的模型、币种和每百万 Token 单价。');
    const { requestId: _requestId, ...rate } = parsed.data as ResearchTokenRate & { requestId: string };
    const rates = this.rates(viewer).filter(item => item.providerId !== rate.providerId || item.model !== rate.model);
    if (rates.length >= 64) throw new WebStorageError(409, '最多保存 64 项模型单价。');
    rates.push(rate); this.storage.saveRecord([...this.ownerPath(viewer), 'usage-rates.json'], rates);
    return rate;
  }
  knowledgeRecord(viewer: string, id: string) {
    this.personal(viewer);
    const catalog = this.knowledge.getCatalog(viewer), entry = catalog?.entries.find(item => item.id === id);
    if (entry) return { id: entry.id, name: entry.name, type: entry.type, description: entry.description,
      declaration: entry.declaration, premises: entry.premises, environmentDigest: entry.environmentDigest };
    const finding = catalog?.routeFindings?.find(item => item.id === id);
    if (finding) return { id: finding.id, name: finding.summary, type: finding.scope.source.statement, description: finding.finding,
      declaration: finding.notes, premises: finding.scope.source.premises, environmentDigest: finding.scope.environmentDigest };
    throw new WebStorageError(404, '研究记录不存在或不属于当前会话。');
  }
  historyRecord(viewer: string, id: string) {
    const data = this.records(viewer);
    const record = researchHistoryRecords(viewer, { storage: this.storage, projects: this.projects, runs: data.runs, projectViews: data.projects })
      .find(item => item.id === id);
    if (!record) throw new WebStorageError(404, '研究记录不存在或不属于当前会话。');
    return record;
  }
  search(viewer: string, query: string, kind?: ResearchSearchKind, offset = 0, limit = 40): ResearchSearchResult {
    const data = this.records(viewer), terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    const counts: ResearchSearchResult['counts'] = { problem: 0, conversation: 0, lemma: 0, route: 0, library: 0, history: 0, decision: 0, stage: 0 };
    if (!terms.length) return { query, items: [], counts, total: 0 };
    const matches: { hit: ResearchSearchHit; score: number }[] = [];
    const add = (hit: Omit<ResearchSearchHit, 'excerpt'>, text: string) => {
      const corpus = `${hit.title}\n${hit.context}\n${text}`.toLocaleLowerCase();
      if (!terms.every(term => corpus.includes(term))) return;
      counts[hit.kind]++;
      const position = Math.max(0, text.toLocaleLowerCase().indexOf(terms[0]!));
      const start = Math.max(0, position - 70);
      const excerpt = `${start ? '…' : ''}${text.slice(start, start + 340)}${text.length > start + 340 ? '…' : ''}`;
      matches.push({ hit: { ...hit, excerpt }, score: terms.reduce((score, term) => score + (hit.title.toLocaleLowerCase().includes(term) ? 10 : 1), 0) });
    };
    for (const project of data.projects) {
      add({ id: `project:${project.id}`, kind: 'problem', title: project.title, context: project.fields.join(' · '),
        href: theoremHref(project.id), updatedAt: project.updatedAt },
      [project.description, ...project.versions.map(version => `${version.statement}\n${version.source}`)].join('\n'));
    }
    for (const view of data.runs) {
      const { run } = view;
      add({ id: `run:${run.id}`, kind: 'problem', title: run.title, context: run.environment, href: runHref(view), updatedAt: run.updatedAt },
        [run.formalization?.original, run.task, run.source].filter(Boolean).join('\n'));
      for (const task of run.observation?.inspection.tasks ?? []) add({ id: `task:${run.id}:${task.id}:${task.version}`,
        kind: task.kind === 'lemma' || task.kind === 'goal' ? 'lemma' : 'route', title: task.theorem || task.objective,
        context: run.title, version: task.version, href: runHref(view, task), updatedAt: run.updatedAt },
      [task.objective, task.type, task.informalStatement, task.informalProof, task.finding, task.feedback].filter(Boolean).join('\n'));
      for (const route of run.observation?.plan?.proofRoutes ?? []) add({ id: `route:${run.id}:${route.id}`, kind: 'route', title: route.id,
        context: run.title, href: `${runHref(view)}${view.owned ? '&view=route' : ''}`, updatedAt: run.updatedAt },
      [route.targetTaskId, ...route.prerequisiteTaskIds, route.closingTaskId].map(id => {
        const task = run.observation!.inspection.tasks.find(task => task.id === id);
        return `${id}: ${task?.objective ?? ''} ${task?.informalProof ?? ''}`;
      }).join('\n'));
    }
    for (const conversation of data.conversations) for (const message of conversation.messages) add({
      id: `message:${conversation.id}:${message.id}`, kind: 'conversation', title: conversation.title,
      context: message.role === 'user' ? 'User' : 'TheoremOS', updatedAt: message.createdAt,
      href: `./?${new URLSearchParams({ chat: conversation.id, message: message.id })}` }, message.text);
    for (const asset of this.assets.list(viewer, {})) {
      if (asset.editable && asset.draft) add({ id: `asset:${asset.id}:draft`, kind: 'library', title: asset.name, context: asset.area,
        href: `library.html?entry=${enc(asset.id)}`, updatedAt: asset.updatedAt }, `${asset.description}\n${JSON.stringify(asset.draft)}`);
      for (const info of asset.releases) {
        if (info.withdrawn) continue;
        const release = this.assets.release(viewer, asset.id, info.version);
        add({ id: `asset:${asset.id}:${release.version}`, kind: 'library', title: release.name, context: release.area,
          href: `library.html?${new URLSearchParams({ entry: asset.id, version: release.version })}`,
          updatedAt: release.createdAt, version: release.version }, [release.description, release.releaseNotes,
          ...release.mathematics?.declarations.map(declaration => `${declaration.name} ${declaration.type}`) ?? [], JSON.stringify(release.content)].filter(Boolean).join('\n'));
      }
    }
    const catalog = this.knowledge.getCatalog(viewer);
    for (const entry of catalog?.entries ?? []) {
      const origin = entry.provenance.find(origin => origin.runId && data.runs.some(view => view.run.id === origin.runId));
      const view = origin && data.runs.find(view => view.run.id === origin.runId);
      // A catalog can outlive its source run. The saved declaration remains readable in the workspace.
      add({ id: `knowledge:${entry.id}`, kind: 'lemma', title: entry.name, context: entry.file,
        href: view ? runHref(view, origin?.taskId && origin.taskDigest ? { id: origin.taskId, version: origin.taskDigest } : undefined)
          : `workspace.html?tab=search&q=${enc(query)}&record=${enc(entry.id)}`,
        updatedAt: view?.run.updatedAt ?? '', version: entry.id }, `${entry.description}\n${entry.type}\n${entry.declaration}`);
    }
    for (const finding of catalog?.routeFindings ?? []) {
      const origin = finding.provenance.find(origin => data.runs.some(view => view.run.id === origin.runId));
      const view = origin && data.runs.find(view => view.run.id === origin.runId);
      add({ id: `finding:${finding.id}`, kind: 'route', title: finding.summary, context: finding.conclusion,
        href: view ? `${runHref(view)}${view.owned ? '&view=route' : ''}` : `workspace.html?tab=search&q=${enc(query)}&record=${enc(finding.id)}`,
        updatedAt: view?.run.updatedAt ?? '', version: finding.id }, `${finding.finding}\n${finding.notes}\n${finding.remainingObligations.join('\n')}`);
    }
    for (const record of researchHistoryRecords(viewer, { storage: this.storage, projects: this.projects, runs: data.runs, projectViews: data.projects }))
      add({ id: record.id, kind: record.kind, title: record.title, context: record.context, href: record.href,
        updatedAt: record.updatedAt, version: record.version }, record.text);
    const sorted = matches.filter(item => !kind || item.hit.kind === kind)
      .sort((a, b) => b.score - a.score || b.hit.updatedAt.localeCompare(a.hit.updatedAt) || a.hit.id.localeCompare(b.hit.id));
    return { query, counts, total: sorted.length, items: sorted.slice(offset, offset + limit).map(item => item.hit),
      ...(sorted.length > offset + limit ? { nextOffset: offset + limit } : {}) };
  }
  ledger(viewer: string): ResearchUsageLedger {
    const data = this.records(viewer), rates = this.rates(viewer);
    const research: ResearchOverviewData = { projects: data.projects.filter(project => project.permissions.member), notifications: [] };
    const overview = buildResearchOverview({ research, runs: data.runs.map(view => view.run),
      conversations: data.conversations.map(item => ({ ...item, answering: false })), formalizations: data.formalizations });
    const estimate = (entry: ResearchUsageEntry): ResearchUsageEntry => {
      const rate = rates.find(rate => rate.providerId === entry.providerId && rate.model === entry.model);
      return rate && entry.tokens !== null ? { ...entry, estimate: { amount: entry.tokens / 1_000_000 * rate.perMillion,
        currency: rate.currency, perMillion: rate.perMillion } } : entry;
    };
    const groups: ResearchUsageLedger['groups'] = overview.cards.map(card => {
      const entries: ResearchUsageEntry[] = [];
      for (const record of card.formalizations) entries.push({ id: `formalization:${record.id}`, stage: 'formalization',
        title: record.original, href: `formalize.html?id=${enc(record.id)}`, model: record.model, providerId: record.providerId,
        tokens: validNumber(record.progress?.tokens), tokenLimit: record.maxTotalTokens,
        startedAt: record.createdAt, durationMs: duration(record.createdAt, record.finishedAt), shared: false, status: record.status });
      for (const run of card.runs) {
        const view = data.runs.find(item => item.run.id === run.id)!;
        entries.push({ id: `proof:${run.id}`, stage: 'proof', title: run.title, href: runHref(view), model: run.model,
          providerId: run.providerId, tokens: tokens(run.result?.report.usage) ?? tokens(run.observation?.inspection.usage), tokenLimit: run.maxTotalTokens,
          startedAt: run.createdAt, durationMs: duration(run.createdAt, run.finishedAt), shared: !view.owned,
          status: accepted(run) ? 'accepted' : run.status });
        if (view.owned) for (const { explanation } of this.storage.listExplanations(viewer, run.id)) entries.push({
          id: `explanation:${explanation.id}`, stage: 'explanation', title: explanation.target,
          href: `explain.html?${new URLSearchParams({ run: run.id, target: explanation.target, lang: explanation.language })}`,
          model: explanation.model, providerId: run.providerId, tokens: validNumber(explanation.progress?.tokens),
          tokenLimit: explanation.maxTotalTokens, startedAt: explanation.createdAt,
          durationMs: duration(explanation.createdAt, explanation.finishedAt), shared: false, status: explanation.status });
      }
      const priced = entries.map(estimate).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      return { id: card.id, title: card.title, href: card.project ? theoremHref(card.project.id) : entries[0]?.href ?? './',
        updatedAt: card.updatedAt, entries: priced, knownTokens: priced.reduce((total, entry) => total + (entry.tokens ?? 0), 0),
        missingEntries: priced.filter(entry => entry.tokens === null).length,
        attempts: card.runs.length, acceptedAttempts: card.runs.filter(accepted).length };
    }).filter(group => group.entries.length);
    const entries = groups.flatMap(group => group.entries);
    const estimates = (['CNY', 'USD'] as const).flatMap(currency => {
      const priced = entries.flatMap(entry => entry.estimate?.currency === currency ? [entry.estimate] : []);
      return priced.length ? [{ currency, amount: priced.reduce((total, estimate) => total + estimate.amount, 0), entries: priced.length }] : [];
    });
    return { groups, rates, estimates, knownTokens: groups.reduce((total, group) => total + group.knownTokens, 0),
      missingEntries: groups.reduce((total, group) => total + group.missingEntries, 0), entryCount: entries.length,
      unpricedEntries: entries.filter(entry => !entry.estimate).length };
  }
  brief(viewer: string, runId: string, projectId?: string): ResearchBrief {
    const data = this.records(viewer);
    const view = projectId ? (() => {
      const resolved = this.projects.resolveBinding(viewer, projectId, runId);
      if (!this.projects.detail(viewer, projectId).permissions.member && resolved.runOwner !== viewer)
        throw new WebStorageError(403, '研究简报仅向有权查看运行的成员提供。');
      return { run: resolved.run, projectId, owned: resolved.runOwner === viewer };
    })() : data.runs.find(view => view.run.id === runId && view.owned);
    if (!view) throw new WebStorageError(404, '运行不存在或不属于当前会话。');
    const { run } = view, observation = run.observation;
    const approval = run.initialPlanApproval?.receipt ?? observation?.inspection.planApproval;
    const runOwner = view.owned ? viewer : this.projects.resolveBinding(viewer, projectId!, runId).runOwner;
    const recorded = this.storage.listObservations(runOwner, runId);
    const project = projectId ? data.projects.find(project => project.id === projectId)
      : data.projects.find(project => project.permissions.member && project.runs.some(binding => binding.runId === runId));
    const ledger = this.ledger(viewer), group = ledger.groups.find(group => group.entries.some(entry => entry.id === `proof:${runId}`));
    const runIds = new Set(group?.entries.filter(entry => entry.stage === 'proof').map(entry => entry.id.slice(6)) ?? [runId]);
    const decisions = researchBriefDecisions({ observation, recorded, commands: this.storage.listCommands(runOwner, runId), project, runId,
      href: task => runHref(view, task) });
    const checks = [...new Map([...recorded, ...(observation ? [observation] : [])].flatMap(item => item.checks).map(check => [check.id, check])).values()];
    const outcomes: ResearchBrief['outcomes'] = [];
    for (const asset of this.assets.list(viewer, {})) if (asset.release?.mathematics?.source.kind === 'run' && runIds.has(asset.release.mathematics.source.runId))
      outcomes.push({ title: asset.name, href: `library.html?${new URLSearchParams({ entry: asset.id, version: asset.release.version })}`,
        detail: `${asset.release.version} · ${asset.release.digest}` });
    if (accepted(run) && view.owned) outcomes.unshift({ title: 'Lean', href: `${runHref(view)}&view=source`, detail: mathDigest(run.result!.proof) });
    if (view.owned) for (const { explanation } of this.storage.listExplanations(viewer, runId)) if (explanation.status === 'approved') outcomes.push({
      title: explanation.target, href: `explain.html?${new URLSearchParams({ run: runId, target: explanation.target, lang: explanation.language })}`,
      detail: `${explanation.language} · ${explanation.id}` });
    return { schema: 'theorem-os.research-brief.v1', generatedAt: new Date().toISOString(), title: project?.title ?? run.title,
      statement: run.formalization?.original ?? observation?.inspection.problem.statement ?? run.task,
      leanStatement: run.source, sourceDigest: mathDigest(run.source), environment: run.environment,
      environmentDigest: observation?.inspection.configuration.environmentDigest,
      ...(run.formalization ? { formalization: { id: run.formalization.id, confirmation: run.formalization.confirmation,
        ...(run.formalization.reviewMode ? { reviewMode: run.formalization.reviewMode } : {}),
        evidenceDigest: run.formalization.evidenceSha256 } } : {}),
      selectedRunId: runId, runHref: runHref(view), accepted: accepted(run), status: run.result?.status ?? run.status,
      attempts: data.runs.filter(view => runIds.has(view.run.id)).sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt)).map(view => ({ id: view.run.id, title: view.run.title,
        status: view.run.result?.status ?? view.run.status, accepted: accepted(view.run), createdAt: view.run.createdAt,
        href: runHref(view), failure: view.run.failure?.kind, sourceDigest: mathDigest(view.run.source),
        failedChecks: (view.run.observation?.checks ?? []).filter(check => check.record.passed === false).length,
        tasks: view.run.observation?.inspection.tasks.length ?? 0 })),
      tasks: observation?.inspection.tasks.map(task => researchBriefTask(task, observation, checks, task => runHref(view, task))) ?? [],
      routes: (observation?.plan?.proofRoutes ?? []).map(route => ({ id: route.id, prerequisites: [...route.prerequisiteTaskIds],
        closingTaskId: route.closingTaskId, targetTaskId: route.targetTaskId })), decisions,
      ...(approval ? { planApproval: { status: approval.status,
        planVersion: run.initialPlanApproval?.receipt.approvedVersion ?? approval.planVersion } } : {}),
      blockers: (observation?.inspection.mathematics.snapshot.blockers ?? []).filter(blocker =>
        observation?.inspection.tasks.some(task => task.id === blocker.taskId && task.version === blocker.taskDigest))
        .map(blocker => ({ id: blocker.id, taskId: blocker.taskId, taskVersion: blocker.taskDigest, mechanism: blocker.mechanism,
          status: blocker.status, evidenceRefs: [...(blocker.evidenceRefs ?? [])] })),
      acceptance: { status: run.result?.status ?? 'not-assessed', checks: checks.map(check => ({ id: check.id,
        taskId: check.taskId, version: check.taskVersion, passed: check.record.passed === true })) }, outcomes,
      usage: { knownTokens: group?.knownTokens ?? 0, missingEntries: group?.missingEntries ?? 1, entries: group?.entries ?? [] } };
  }
}
