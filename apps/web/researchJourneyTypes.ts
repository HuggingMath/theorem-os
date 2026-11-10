import type { WebCheckReceipt, WebTaskSource } from './collaboration';
import type { ResearchBriefDecision, ResearchBriefTask } from './researchWorkspaceTypes';

export type ResearchJourneySourceRef = {
  runId: string; projectId?: string; taskId: string; taskVersion: string;
  commit: string; sourceDigest: string; environmentDigest: string; file: string;
  observation: { sequence: number; stateDigest: string };
};
export type ResearchJourneyTask = {
  task: ResearchBriefTask; source?: ResearchJourneySourceRef;
  sourceStatus: 'available' | 'unrecorded' | 'ambiguous'; dependents: string[];
};
export type ResearchJourneyAttempt = {
  id: string; projectId?: string; statementVersionId?: string; title: string; status: string;
  accepted: boolean; createdAt: string; href: string; statement: string; sourceDigest: string;
  observation?: { sequence: number; stateDigest: string }; failure?: string;
  tasks: ResearchJourneyTask[]; checks: WebCheckReceipt[]; decisions: ResearchBriefDecision[];
};
export type ResearchJourneyLineage = {
  id: string; fromRunId: string; toRunId: string; taskId: string; commit: string;
  status: 'recorded' | 'unavailable' | 'ambiguous'; source?: ResearchJourneySourceRef; task?: ResearchBriefTask;
};
export type ResearchJourney = {
  schema: 'theorem-os.research-journey.v1'; key: string; selectedRunId: string;
  title: string; attempts: ResearchJourneyAttempt[]; lineage: ResearchJourneyLineage[];
};
export type ResearchJourneySource = { ref: ResearchJourneySourceRef; task?: ResearchBriefTask; source: WebTaskSource };

/** This is a frozen reading record, not a new proof or an inferred human effect. */
export type ResearchJourneyRecord = {
  id: string; kind: 'task' | 'check' | 'human'; runId: string; projectId?: string;
  title: string; version: string; digest: string;
  sections: { title: string; text: string }[];
  task?: ResearchBriefTask; check?: WebCheckReceipt; decision?: ResearchBriefDecision;
  source?: ResearchJourneySourceRef;
  authority: { kind: 'task' | 'check' | 'decision' | 'feedback' | 'assignment' | 'handoff' | 'issue'; id: string };
};
export type ResearchChangeRecordLink = {
  id: string; kind: ResearchJourneyRecord['kind']; runId: string; title: string; version: string;
  snapshotDigest: string; href: string;
};
export type ResearchUnreadChange = {
  id: string; kind: ResearchJourneyRecord['kind']; change: 'added' | 'updated' | 'removed';
  title: string; runId: string; before?: ResearchChangeRecordLink; after?: ResearchChangeRecordLink;
};
export type ResearchUnreadChanges = {
  schema: 'theorem-os.research-unread.v1'; key: string; revision: number; readAt: string;
  snapshotDigest: string; capturedAt: string; baselineCreated: boolean;
  changes: ResearchUnreadChange[]; counts: { task: number; check: number; human: number };
};
export type ResearchReadReceipt = { revision: number; snapshotDigest: string; readAt: string };
