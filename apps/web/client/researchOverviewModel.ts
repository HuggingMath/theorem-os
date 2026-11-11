import type { WebRun } from '../shared';
import type { WebConversationSummary } from '../conversationTypes';
import type { WebFormalization } from '../formalizationTypes';
import type { ResearchOverviewData, ResearchOverviewProject } from '../researchOverviewTypes';
import { isAcceptedRun } from '../presentation';

export type ResearchOverviewAction = {
  id: string; kind: 'statement' | 'research' | 'plan' | 'feedback' | 'update'; title: string; href: string; updatedAt: string;
  runId?: string; conversationId?: string;
};
export type ResearchOverviewCard = {
  id: string; title: string; updatedAt: string; project?: ResearchOverviewProject;
  runs: WebRun[]; conversations: WebConversationSummary[]; formalizations: WebFormalization[];
  actions: ResearchOverviewAction[];
};
const newest = <T extends { updatedAt: string }>(items: T[]) => items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
const theoremHref = (projectId: string, runId?: string, version?: string, feedbackId?: string, task?: { id: string; version: string }) => {
  const parameters = new URLSearchParams({ id: projectId });
  if (runId) parameters.set('run', runId);
  if (version) parameters.set('version', version);
  if (task) { parameters.set('task', task.id); parameters.set('taskVersion', task.version); }
  return `theorems.html?${parameters}${feedbackId ? `#feedback-${encodeURIComponent(feedbackId)}` : ''}`;
};
export const overviewProjectHref = theoremHref;

/** Show a directly readable accepted run for each statement version, including older versions. */
export function researchVerifiedRuns(card: ResearchOverviewCard) {
  const versions = new Set<string>();
  return newest(card.runs.filter(isAcceptedRun)).flatMap(run => {
    const binding = card.project?.runs.find(item => item.runId === run.id);
    const versionId = binding?.statementVersionId ?? '';
    if (versions.has(versionId)) return [];
    versions.add(versionId);
    const index = card.project?.versions.findIndex(version => version.id === versionId) ?? -1;
    return [{ run, ...(index >= 0 ? { version: index + 1 } : {}) }];
  });
}

/** Exact source bytes, environment and frozen formalization identity distinguish unbound statements. */
export function researchStatementIdentity(run: WebRun): string {
  return JSON.stringify([run.environment, run.source,
    run.formalization ? [run.formalization.id, run.formalization.evidenceSha256] : run.formalizationId ?? null]);
}

export function buildResearchOverview(input: { runs: readonly WebRun[]; conversations: readonly WebConversationSummary[];
  formalizations: readonly WebFormalization[]; research?: ResearchOverviewData }): { cards: ResearchOverviewCard[]; actions: ResearchOverviewAction[] } {
  const cards: ResearchOverviewCard[] = [], byRun = new Map<string, ResearchOverviewCard>(), byFormalization = new Map<string, ResearchOverviewCard>();
  const unbound = new Map<string, ResearchOverviewCard>(), actions = new Map<string, ResearchOverviewAction>();
  const make = (id: string, title: string, updatedAt: string, project?: ResearchOverviewProject) => {
    const card: ResearchOverviewCard = { id, title, updatedAt, project, runs: [], conversations: [], formalizations: [], actions: [] };
    cards.push(card); return card;
  };
  const touch = (card: ResearchOverviewCard, at: string) => { if (at > card.updatedAt) card.updatedAt = at; };
  const act = (card: ResearchOverviewCard | undefined, action: ResearchOverviewAction) => {
    if (actions.has(action.id)) return;
    actions.set(action.id, action); card?.actions.push(action);
  };
  for (const project of input.research?.projects ?? []) {
    const card = make(`project:${project.id}`, project.title, project.updatedAt, project);
    for (const binding of project.runs) if (!byRun.has(binding.runId)) byRun.set(binding.runId, card);
    for (const version of project.versions) if (version.formalizationId && !byFormalization.has(version.formalizationId)) byFormalization.set(version.formalizationId, card);
  }
  // The collaboration inbox owns current responsibility, permissions and candidate lifecycle.
  for (const feedback of input.research?.feedbackActions ?? [])
    act(cards.find(card => card.project?.id === feedback.projectId), { id: `feedback:${feedback.feedbackId}`, kind: 'feedback',
      title: feedback.title, updatedAt: feedback.updatedAt, href: feedback.href });
  // Oldest first makes each unbound group's key stable as newer attempts arrive.
  for (const run of [...input.runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const identity = researchStatementIdentity(run);
    let card = byRun.get(run.id) ?? unbound.get(identity);
    if (!card) { card = make(`statement:${run.id}`, run.formalization?.original ?? run.title, run.updatedAt); unbound.set(identity, card); }
    byRun.set(run.id, card); card.runs.push(run); touch(card, run.updatedAt);
    const formalizationId = run.formalization?.id ?? run.formalizationId;
    if (formalizationId) byFormalization.set(formalizationId, card);
    const approval = run.observation?.inspection.planApproval;
    if (run.status === 'running' && approval?.status === 'pending' && !approval.leadRevising)
      act(card, { id: `plan:${run.id}`, kind: 'plan', title: run.title, updatedAt: run.updatedAt, runId: run.id, href: `?run=${encodeURIComponent(run.id)}` });
  }
  for (const record of input.formalizations) {
    let card = (record.runId ? byRun.get(record.runId) : undefined) ?? byFormalization.get(record.id);
    if (!card) card = make(`formalization:${record.id}`, record.original, record.updatedAt);
    byFormalization.set(record.id, card); card.formalizations.push(record); touch(card, record.updatedAt);
  }
  for (const conversation of input.conversations) {
    let card = (conversation.runId ? byRun.get(conversation.runId) : undefined)
      ?? (conversation.formalizationId ? byFormalization.get(conversation.formalizationId) : undefined);
    if (!card) card = make(`conversation:${conversation.id}`, conversation.title, conversation.updatedAt);
    card.conversations.push(conversation); touch(card, conversation.updatedAt);
  }
  for (const card of cards) {
    newest(card.runs); newest(card.conversations); newest(card.formalizations);
    for (const record of card.formalizations) {
      if (record.runId || !record.humanReview || !['review', 'confirmed'].includes(record.status)) continue;
      const conversation = card.conversations.find(item => item.formalizationId === record.id);
      act(card, { id: `statement:${record.id}`, kind: record.status === 'confirmed' ? 'research' : 'statement', title: record.original, updatedAt: record.updatedAt,
        ...(conversation ? { conversationId: conversation.id } : {}),
        href: conversation ? `?chat=${encodeURIComponent(conversation.id)}` : `formalize.html?id=${encodeURIComponent(record.id)}` });
    }
  }
  for (const update of input.research?.notifications ?? []) {
    if (update.read || update.feedbackId && actions.has(`feedback:${update.feedbackId}`)) continue;
    const card = cards.find(item => item.project?.id === update.projectId);
    const href = update.assetId ? `library.html?${new URLSearchParams({ entry: update.assetId, ...(update.assetVersion ? { version: update.assetVersion } : {}) })}`
      : update.projectId ? theoremHref(update.projectId, update.runId, update.statementVersionId, update.feedbackId) : undefined;
    if (href) act(card, { id: `update:${update.id}`, kind: 'update', title: update.summary, updatedAt: update.createdAt, href });
  }
  for (const card of cards) newest(card.actions);
  return { cards: cards.sort((a, b) => Number(Boolean(b.actions.length)) - Number(Boolean(a.actions.length)) || b.updatedAt.localeCompare(a.updatedAt)),
    actions: newest([...actions.values()]) };
}
