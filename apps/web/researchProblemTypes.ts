import type { ResearchBrief } from './researchWorkspaceTypes';
import type { ResearchAuthor, ResearchProjectDetail } from './researchProjectTypes';
import type { ResearchCollaborationView } from './researchCollaborationTypes';
import type { WebRunStatus } from './shared';
import type { NextStep } from './report';

export type ResearchProblemRunState = {
  status: WebRunStatus; phase: string; title: string; detail: string; updatedAt: string;
  elapsedMs: number | null; waitingForApproval: boolean; revisingPlan: boolean; hasTaskRoute: boolean;
  active: boolean; owned: boolean; stalledMinutes?: number;
  actions: { id: NextStep['id']; label: string; href: string }[];
  controlsHref: string;
};

export type ResearchStageConclusion = {
  id: string; requestId: string; createdAt: string; title: string; conclusion: string; boundaries: string;
  unresolved: string; next: string; evidenceDigest: string;
  snapshot: ResearchBrief; projectId?: string;
  author?: ResearchAuthor;
};
/** An explicitly shared copy of one conclusion and its selected route, without other private attempts or usage. */
export type ResearchStageReference = Omit<ResearchStageConclusion, 'id' | 'requestId' | 'projectId' | 'author'> & {
  stageId: string; author: ResearchAuthor;
};
export type ResearchProblem = {
  key: string; evidenceDigest: string; brief: ResearchBrief; project?: ResearchProjectDetail;
  runState?: ResearchProblemRunState;
  observationRef?: { sequence: number; stateDigest: string };
  conversations: { id: string; title: string; updatedAt: string; runId?: string;
    messages: { id: string; role: string; text: string; createdAt: string; href: string }[]; href: string }[];
  stages: ResearchStageConclusion[];
  collaboration?: ResearchCollaborationView;
};
export type ResearchRouteChange = {
  id: string; kind: 'added' | 'removed' | 'changed' | 'unchanged';
  changes: ('statement' | 'dependencies' | 'derivation' | 'proof' | 'checks' | 'feedback')[];
};
export type ResearchRouteComparison = {
  comparable: boolean; before: ResearchBrief; after: ResearchBrief; tasks: ResearchRouteChange[];
  edges: { from: string; to: string; kind: 'added' | 'removed' | 'unchanged' }[];
};
