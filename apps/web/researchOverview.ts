import type { WebResearchProjects } from './researchProjects';
import type { ResearchOverviewData } from './researchOverviewTypes';

/** The personal overview reuses the project's existing visibility and membership projections. */
export function researchOverview(projects: WebResearchProjects, viewer: string): ResearchOverviewData {
  if (viewer === 'public') return { projects: [], notifications: [] };
  const items: ResearchOverviewData['projects'] = [];
  for (let offset = 0;; offset += 100) {
    const page = projects.list(viewer, { offset, limit: 100 });
    for (const summary of page.items) {
      if (!summary.permissions.member) continue;
      const detail = projects.detail(viewer, summary.id);
      items.push({ id: detail.id, title: detail.title, description: detail.description, updatedAt: detail.updatedAt, permissions: detail.permissions,
        versions: detail.versions.map(({ id, statement, sourceDigest, environment, environmentDigest, formalizationId, createdAt }) =>
          ({ id, statement, sourceDigest, environment, environmentDigest, formalizationId, createdAt })), runs: detail.runs,
        feedback: detail.feedback.map(({ id, kind, text, author, target, statementVersionId, decision, delivery, execution, updatedAt }) =>
          ({ id, kind, text, author, target, statementVersionId, decision, delivery, execution, updatedAt })) });
    }
    if (page.nextOffset === undefined) break;
  }
  return { projects: items, notifications: projects.notifications(viewer, { limit: 100 }).items };
}
