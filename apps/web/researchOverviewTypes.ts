import type { ResearchFeedback, ResearchNotification, ResearchProjectDetail, ResearchRunBinding, ResearchStatementVersion } from './researchProjectTypes';

export type ResearchOverviewProject = Pick<ResearchProjectDetail, 'id' | 'title' | 'description' | 'updatedAt' | 'permissions'> & {
  versions: Pick<ResearchStatementVersion, 'id' | 'statement' | 'sourceDigest' | 'environment' | 'environmentDigest' | 'formalizationId' | 'createdAt'>[];
  runs: ResearchRunBinding[];
  feedback: Pick<ResearchFeedback, 'id' | 'kind' | 'text' | 'author' | 'target' | 'statementVersionId' | 'decision' | 'delivery' | 'execution' | 'updatedAt'>[];
};
export type ResearchOverviewData = { projects: ResearchOverviewProject[]; notifications: ResearchNotification[];
  feedbackActions?: { feedbackId: string; projectId: string; title: string; href: string; updatedAt: string }[] };
