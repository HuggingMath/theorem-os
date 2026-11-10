import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import type { WebStorage } from './storage';
import type { WebResearchProjects } from './researchProjects';
import type { WebRun } from './shared';
import type { ResearchProjectDetail } from './researchProjectTypes';
import type { ResearchStageConclusion } from './researchProblemTypes';
import type { ResearchHistoryRecord } from './researchWorkspaceTypes';
import { researchBriefDecisions, researchBriefTask } from './researchProblemEvidence';

export type ResearchHistoryRun = { run: WebRun; projectId?: string; owned: boolean };
/** Historical results are rebuilt from currently readable records, never from a permission-blind index. */
export function researchHistoryRecords(viewer: string, input: { storage: WebStorage; projects: WebResearchProjects;
  runs: ResearchHistoryRun[]; projectViews: ResearchProjectDetail[] }): ResearchHistoryRecord[] {
  const { storage, projects, runs, projectViews } = input, records: ResearchHistoryRecord[] = [];
  const id = (value: string) => mathDigest(value);
  const runHref = (view: ResearchHistoryRun, task?: { id: string; version: string; commit?: string }) => {
    const parameters = new URLSearchParams({ run: view.run.id, ...(view.projectId ? { project: view.projectId } : {}),
      ...(task ? { task: task.id, taskVersion: task.version, ...(task.commit ? { commit: task.commit } : {}) } : {}) });
    return `problem.html?${parameters}`;
  };
  for (const view of runs) {
    const owner = view.owned ? viewer : projects.resolveBinding(viewer, view.projectId!, view.run.id).runOwner;
    const observations = [...new Map([...storage.listObservations(owner, view.run.id), ...(view.run.observation ? [view.run.observation] : [])]
      .filter(item => item.webRunId === view.run.id).map(item => [`${item.sequence}:${item.snapshot.stateDigest}`, item])).values()]
      .sort((a, b) => a.sequence - b.sequence);
    const sources = observations.flatMap(item => item.sources), seen = new Set<string>();
    for (const observation of observations) for (const observed of [...observation.inspection.tasks, ...(observation.history ?? [])]) {
      const task = researchBriefTask(observed, observation, observation.checks, target => runHref(view, target));
      const signature = canonicalMathJson({ task: observed, environment: observation.inspection.configuration.environmentDigest,
        checks: task.checks });
      if (seen.has(signature)) continue;
      seen.add(signature);
      const recordId = id(`history:${view.run.id}:${observation.sequence}:${observation.snapshot.stateDigest}:${task.id}:${mathDigest(signature)}`);
      const source = task.commit && task.sourceDigest && task.environmentDigest ? sources.find(source => source.taskId === task.id
        && source.taskVersion === task.version && source.commit === task.commit && source.sourceDigest === task.sourceDigest
        && source.environmentDigest === task.environmentDigest && mathDigest(source.source) === source.sourceDigest) : undefined;
      records.push({ id: recordId, kind: 'history', title: task.title, context: view.run.title,
        text: [task.objective, task.statement, task.premises.join('\n'), task.derivation, task.finding, task.feedback,
          task.status, task.proofStatus, ...observation.checks.filter(check => check.taskId === task.id && check.taskVersion === task.version)
            .map(check => `${check.id}: ${check.record.passed ? 'passed' : 'failed'}`)].filter(Boolean).join('\n'),
        updatedAt: observation.observedAt, version: task.version, task, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest },
        href: `workspace.html?${new URLSearchParams({ tab: 'search', history: recordId })}`,
        ...(source ? { source: { file: source.file, text: source.source, digest: source.sourceDigest, commit: source.commit } } : {}) });
    }
    for (const observation of observations) {
      for (const check of observation.checks) {
        const recordId = id(`check:${view.run.id}:${check.id}:${canonicalMathJson(check)}`);
        records.push({ id: recordId, kind: 'history', title: check.id, context: view.run.title, updatedAt: observation.observedAt,
          version: check.taskVersion, check, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest },
          text: `${check.taskId ?? ''}\n${canonicalMathJson(check.record)}`, href: `workspace.html?${new URLSearchParams({ tab: 'search', history: recordId })}` });
      }
      for (const decision of researchBriefDecisions({ recorded: [observation], commands: [], runId: view.run.id, href: target => runHref(view, target) })) {
        const recordId = id(`decision:${view.run.id}:${canonicalMathJson(decision)}`);
        records.push({ id: recordId, kind: 'decision', title: decision.text, context: view.run.title, updatedAt: observation.observedAt,
          version: decision.planVersion, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest },
          text: [decision.text, decision.reason, decision.delivery, decision.decision, ...decision.evidenceRefs].filter(Boolean).join('\n'),
          originHref: runHref(view), href: `workspace.html?${new URLSearchParams({ tab: 'search', history: recordId })}` });
      }
    }
  }
  for (const project of projectViews) {
    for (const feedback of project.feedback) {
      const recordId = id(`feedback:${project.id}:${feedback.id}`);
      records.push({ id: recordId, kind: 'decision', title: feedback.text || feedback.kind, context: project.title,
        updatedAt: feedback.updatedAt, version: String(feedback.revision),
        href: `workspace.html?${new URLSearchParams({ tab: 'search', history: recordId })}`,
        originHref: `theorems.html?${new URLSearchParams({ id: project.id, feedback: feedback.id,
          ...(feedback.target ? { run: feedback.target.runId, ...(feedback.target.taskRef ? { task: feedback.target.taskRef.id, taskVersion: feedback.target.taskRef.version } : {}) } : {}) })}#feedback-${enc(feedback.id)}`,
        text: [feedback.text, feedback.decision.reason, ...feedback.reviewComments?.map(comment => comment.text) ?? [],
          ...feedback.candidateRevision?.responses.map(response => response.text) ?? [], ...feedback.decisionHistory?.map(item => item.reason) ?? [],
          ...feedback.reviewHistory?.map(item => item.text) ?? [], feedback.payload && 'source' in feedback.payload ? feedback.payload.source : ''].filter(Boolean).join('\n') });
    }
    if (!project.permissions.member) continue;
    const collaboration = projects.collaboration(viewer, project.id);
    for (const issue of collaboration.issues) {
      const recordId = id(`issue:${project.id}:${issue.id}`);
      records.push({ id: recordId, kind: 'decision', title: issue.title, context: project.title,
        text: [issue.text, ...issue.replies.map(reply => reply.text), ...issue.resolutionHistory?.map(resolution => resolution.text) ?? [], issue.resolution?.text].filter(Boolean).join('\n'),
        version: String(issue.revision), updatedAt: issue.updatedAt,
        href: `workspace.html?${new URLSearchParams({ tab: 'search', history: recordId })}`,
        originHref: `theorems.html?${new URLSearchParams({ id: project.id, issue: issue.id })}#issue-${enc(issue.id)}` });
    }
  }
  const stageRoot = ['owners', mathDigest(viewer), 'stage-conclusions'], readableRuns = new Set(runs.map(view => view.run.id));
  for (const file of storage.listRecords(stageRoot)) {
    if (!/^[a-f0-9]{64}\.json$/u.test(file)) continue;
    for (const stage of storage.getRecord<ResearchStageConclusion[]>([...stageRoot, file]) ?? []) {
      if (!readableRuns.has(stage.snapshot.selectedRunId) || stage.snapshot.attempts.some(attempt => !readableRuns.has(attempt.id))) continue;
      if (stage.projectId && !projectViews.some(project => project.id === stage.projectId && project.permissions.member
        && project.runs.some(binding => binding.runId === stage.snapshot.selectedRunId && binding.permissions.read))) continue;
      const recordId = id(`stage:${stage.id}`);
      records.push({ id: recordId, kind: 'stage', title: stage.title, context: stage.snapshot.title, updatedAt: stage.createdAt,
        text: [stage.conclusion, stage.boundaries, stage.unresolved, stage.next, ...stage.snapshot.tasks.map(task =>
          [task.title, task.statement, task.derivation, task.finding].filter(Boolean).join('\n'))].join('\n'),
        version: stage.evidenceDigest, snapshot: stage.snapshot,
        href: `workspace.html?${new URLSearchParams({ tab: 'search', history: recordId })}` });
    }
  }
  return [...new Map(records.map(record => [record.id, record])).values()];
}
const enc = encodeURIComponent;
