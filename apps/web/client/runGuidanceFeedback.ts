import type { ResearchFeedback } from '../researchProjectTypes';
import type { ResearchOverviewData } from '../researchOverviewTypes';
import type { WebApi } from './collaborationUi';

/** Read once per run, then match each chat receipt by its request ID. No project binding means no follow-up record. */
export async function loadRunGuidanceFeedback(runId: string, request: WebApi): Promise<ResearchFeedback[]> {
  const overview = await request<ResearchOverviewData>('/api/research/overview');
  const projects = overview.projects.filter(project => project.runs.some(run => run.runId === runId));
  const results = await Promise.all(projects.map(async project => {
    const { items } = await request<{ items: ResearchFeedback[] }>(`/api/research/theorems/${encodeURIComponent(project.id)}/feedback`);
    const versions = new Set(project.runs.filter(run => run.runId === runId).map(run => run.statementVersionId));
    return items.filter(item => item.kind === 'guidance' && item.projectId === project.id && item.target?.runId === runId
      && versions.has(item.target.statementVersionId));
  }));
  return results.flat();
}
