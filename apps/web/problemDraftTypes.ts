import type { TaskDraft } from './client/draft';
import type { ChatDraftSettings } from './client/chatDraft';
import type { ResearchReleaseRef } from './researchAssetTypes';

/** Unsubmitted work has no acceptance, continuation or execution identity. */
export type ProblemDraftValue =
  | { mode: 'natural'; text: string; settings: ChatDraftSettings }
  | { mode: 'lean'; draft: Omit<TaskDraft, 'continueFrom' | 'formalization' | 'problemBudget'>; libraries?: ResearchReleaseRef[] };
