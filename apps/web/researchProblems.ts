import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { WebStorage, WebStorageError } from './storage';
import type { WebJobs } from './jobs';
import type { WebResearchProjects } from './researchProjects';
import type { WebResearchWorkspace } from './researchWorkspace';
import type { WebConversation } from './conversationTypes';
import type { ResearchBrief } from './researchWorkspaceTypes';
import type { ResearchProblem, ResearchStageConclusion, ResearchStageReference } from './researchProblemTypes';
import { researchStatementIdentity } from './client/researchOverviewModel';

const stageSchema = z.object({ requestId: z.string().min(1).max(200), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  title: z.string().trim().min(1).max(200), conclusion: z.string().trim().min(1).max(8000),
  boundaries: z.string().trim().max(8000), unresolved: z.string().trim().max(8000), next: z.string().trim().max(8000) }).strict();
/** The digest names saved mathematical evidence, not the time a page happened to be opened. */
export function researchProblemEvidence(brief: ResearchBrief): string {
  const { generatedAt: _generated, usage: _usage, attempts: _attempts, outcomes: _outcomes, ...evidence } = brief;
  return mathDigest(canonicalMathJson(evidence));
}

/** A personal stage conclusion freezes the evidence its author actually reviewed. */
export class WebResearchProblems {
  constructor(private storage: WebStorage, private jobs: WebJobs, private projects: WebResearchProjects,
    private workspace: WebResearchWorkspace) {}
  private locate(viewer: string, runId: string, projectId?: string) {
    if (viewer === 'public') throw new WebStorageError(401, '请先登录。');
    let project = projectId ? this.projects.detail(viewer, projectId) : undefined;
    if (!project) for (let offset = 0;; offset += 100) {
      const page = this.projects.list(viewer, { offset, limit: 100 });
      const match = page.items.filter(item => item.permissions.member).map(item => this.projects.detail(viewer, item.id))
        .find(item => item.runs.some(binding => binding.runId === runId));
      if (match) { project = match; break; }
      if (page.nextOffset === undefined) break;
    }
    const brief = this.workspace.brief(viewer, runId, project?.id);
    const run = project ? this.projects.resolveBinding(viewer, project.id, runId).run : this.jobs.get(viewer, runId);
    if (!run) throw new WebStorageError(404, '研究记录不存在。');
    const key = mathDigest(project ? `project:${project.id}` : researchStatementIdentity(run));
    return { brief, project, key, evidenceDigest: researchProblemEvidence(brief),
      ...(run.observation ? { observationRef: { sequence: run.observation.sequence, stateDigest: run.observation.snapshot.stateDigest } } : {}) };
  }
  private path(viewer: string, key: string) { return ['owners', mathDigest(viewer), 'stage-conclusions', `${key}.json`]; }
  private stages(viewer: string, result: { key: string; brief: ResearchBrief }) {
    const keys = new Set([result.key]);
    // Attaching a personal run to a project must preserve conclusions written before that attachment.
    for (const attempt of result.brief.attempts) {
      const owned = this.jobs.get(viewer, attempt.id);
      if (owned) keys.add(mathDigest(researchStatementIdentity(owned)));
    }
    return [...new Map([...keys].flatMap(key => this.storage.getRecord<ResearchStageConclusion[]>(this.path(viewer, key)) ?? [])
      .map(stage => [stage.id, stage])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  private visible(viewer: string, stage: ResearchStageConclusion) {
    try {
      this.workspace.brief(viewer, stage.snapshot.selectedRunId, stage.projectId);
      for (const attempt of stage.snapshot.attempts) if (attempt.id !== stage.snapshot.selectedRunId) {
        try { this.workspace.brief(viewer, attempt.id, stage.projectId); }
        catch { this.workspace.brief(viewer, attempt.id); }
      }
      return true;
    } catch { return false; }
  }
  detail(viewer: string, runId: string, projectId?: string): ResearchProblem {
    const result = this.locate(viewer, runId, projectId), ids = new Set(result.brief.attempts.map(item => item.id));
    const root = ['owners', mathDigest(viewer), 'conversations'];
    const conversations = this.storage.listRecords(root).flatMap(file => {
      if (!/^[a-f0-9-]{36}\.json$/u.test(file)) return [];
      const conversation = this.storage.getRecord<WebConversation>([...root, file]);
      if (!conversation?.runId || !ids.has(conversation.runId)) return [];
      return [{ id: conversation.id, title: conversation.title, runId: conversation.runId, updatedAt: conversation.updatedAt,
        href: `./?chat=${encodeURIComponent(conversation.id)}`, messages: conversation.messages.map(item => ({ id: item.id,
          role: item.role, text: item.text, createdAt: item.createdAt,
          href: `./?${new URLSearchParams({ chat: conversation.id, message: item.id })}` })) }];
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    // A saved note must not revive content after a project has been unshared or a source has been deleted.
    const stages = this.stages(viewer, result).filter(stage => this.visible(viewer, stage));
    return { ...result, conversations, stages,
      ...(result.project?.permissions.member ? { collaboration: this.projects.collaboration(viewer, result.project.id) } : {}) };
  }
  saveStage(viewer: string, runId: string, projectId: string | undefined, input: unknown): ResearchStageConclusion {
    const parsed = stageSchema.safeParse(input);
    if (!parsed.success) throw new WebStorageError(400, '请填写阶段名称、结论和有效的研究证据。');
    const value = parsed.data as { requestId: string; evidenceDigest: string; title: string; conclusion: string; boundaries: string; unresolved: string; next: string };
    const result = this.locate(viewer, runId, projectId), path = this.path(viewer, result.key);
    const saved = this.storage.getRecord<ResearchStageConclusion[]>(path) ?? [];
    const previous = this.stages(viewer, result).find(item => item.requestId === value.requestId);
    if (previous) {
      if (!this.visible(viewer, previous)) throw new WebStorageError(404, '研究记录不存在。');
      const same = ['title', 'conclusion', 'boundaries', 'unresolved', 'next', 'evidenceDigest'].every(key =>
        previous[key as keyof typeof value] === value[key as keyof typeof value]);
      if (!same || previous.snapshot.selectedRunId !== runId) throw new WebStorageError(409, '此提交已用于另一份阶段结论。');
      return previous;
    }
    if (value.evidenceDigest !== result.evidenceDigest) throw new WebStorageError(409, '研究已有变化，请核对最新路线和检查记录后再定稿。');
    const stage: ResearchStageConclusion = { ...value, id: crypto.randomUUID(), createdAt: new Date().toISOString(),
      author: (() => { const person = this.projects.profile(viewer, this.projects.identity(viewer)); return { id: person.id, displayName: person.displayName || 'Researcher' }; })(),
      snapshot: structuredClone(result.brief), ...(result.project ? { projectId: result.project.id } : {}) };
    this.storage.saveRecord(path, [...saved, stage]); return stage;
  }
  referenceStage(viewer: string, runId: string, stageId: string, value: unknown) {
    const parsed = z.object({ requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u), projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
      title: z.string().trim().min(1).max(200).optional(), text: z.string().trim().min(1).max(4000).optional() }).strict().safeParse(value);
    if (!parsed.success) throw new WebStorageError(400, '请选择项目并填写有效的议题内容。');
    const input = parsed.data, result = this.locate(viewer, runId, input.projectId);
    if (!result.project?.permissions.edit) throw new WebStorageError(403, '没有修改权限。');
    const stage = this.stages(viewer, result).find(item => item.id === stageId && item.snapshot.selectedRunId === runId);
    if (!stage || !this.visible(viewer, stage)) throw new WebStorageError(404, '阶段结论不存在。');
    const binding = result.project.runs.find(item => item.runId === runId);
    if (!binding?.permissions.read) throw new WebStorageError(404, '研究记录不存在。');
    const author = stage.author ?? { id: this.projects.identity(viewer), displayName: 'Researcher' };
    const snapshot = structuredClone(stage.snapshot);
    const taskHref = (task: typeof snapshot.tasks[number]) => `problem.html?${new URLSearchParams({ project: input.projectId, run: runId, tab: 'route', task: task.id, taskVersion: task.version, ...(task.commit ? { commit: task.commit } : {}) })}`;
    snapshot.runHref = `problem.html?${new URLSearchParams({ project: input.projectId, run: runId, tab: 'route' })}`;
    snapshot.tasks = snapshot.tasks.map(task => ({ ...task, href: taskHref(task) }));
    for (const decision of snapshot.decisions) for (const evidence of [decision.before, decision.after])
      if (evidence) evidence.tasks = evidence.tasks.map(task => ({ ...task, href: taskHref(task) }));
    // Explicitly sharing one stage never carries the author's other attempts or personal usage into a project.
    snapshot.attempts = []; snapshot.outcomes = []; snapshot.usage = { knownTokens: 0, missingEntries: 0, entries: [] };
    const reference: ResearchStageReference = { stageId: stage.id, author, createdAt: stage.createdAt, title: stage.title,
      conclusion: stage.conclusion, boundaries: stage.boundaries, unresolved: stage.unresolved, next: stage.next,
      evidenceDigest: stage.evidenceDigest, snapshot };
    // The stored stage is the sole source of the frozen reference; clients cannot supply a replacement snapshot.
    return this.projects.createIssue(viewer, input.projectId, { requestId: input.requestId,
      expectedRevision: result.project.revision, title: input.title ?? stage.title,
      text: input.text ?? '请基于这份阶段结论讨论下一步。', statementVersionId: binding.statementVersionId }, reference);
  }
}
