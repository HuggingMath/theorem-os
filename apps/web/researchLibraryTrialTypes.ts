import type { ResearchConfigurationSelection, ResearchLibraryPack, ResearchMathDeclaration, ResearchReleaseRef } from './researchAssetTypes';
import type { ResearchFeedbackTarget } from './researchProjectTypes';
import type { WebPrecheckDiagnostic } from './shared';
import type { ResearchModulePlan } from '../../src/solver/modules/policy';

export type ResearchLibraryTrialTargetRef = {
  runId: string; projectId?: string; taskId: string; taskVersion: string;
  commit: string; sourceDigest: string; environmentDigest: string; file: string;
};
export type ResearchLibraryTrialTarget = {
  ref: ResearchLibraryTrialTargetRef; runTitle: string; projectTitle?: string; taskTitle: string; declaration: string; type: string;
  environment: 'standard' | 'mathlib'; premises: string[]; compatible: boolean; incompatibility?: string;
};
export type ResearchLibraryTrialReceipt = {
  schema: 'theorem-os.research-library-trial-check.v1';
  trialId: string; draftDigest: string; release: ResearchReleaseRef; target: ResearchLibraryTrialTargetRef;
  declaration: ResearchMathDeclaration; checkedDeclaration: string; environment: 'standard' | 'mathlib';
  sourceDigest: string; libraryPackDigest: string;
  dependencies: { file: string; digest: string }[];
  passed: boolean; exitCode: number | null; timedOut: boolean;
  diagnostics: WebPrecheckDiagnostic[]; remainingOriginalSorries: number;
  scope: 'isolated-task-trial'; acceptance: 'not-assessed'; checkedAt: string; reason?: string;
};
export type ResearchLibraryTrial = {
  id: string; digest: string; release: ResearchReleaseRef; target: ResearchLibraryTrialTarget;
  declaration: ResearchMathDeclaration; proof: string; argumentNotes: string; missingPremises: string;
  source: string; sourceDigest: string; imports: string[]; libraryPackDigest: string; createdAt: string;
  status: 'prepared' | 'checking' | 'passed' | 'failed';
  check?: { receiptId: string; receipt: ResearchLibraryTrialReceipt };
};

/** Shared only after the trial owner confirms disclosure to the named project. */
export type ResearchLibraryCandidateAttachment = {
  schema: 'theorem-os.research-library-candidate.v1';
  trial: ResearchLibraryTrial;
  projectId: string;
  imports: string[];
  libraryPack: ResearchLibraryPack;
  dependencySources: { file: string; source: string }[];
  candidateTarget: { name: string; expectedType?: string };
  requiresNewAttempt: boolean;
};
export type ResearchLibraryProposalTarget = {
  projectId: string; title: string; target: ResearchFeedbackTarget; requiresNewAttempt: boolean;
};
export type ResearchLibraryAttemptPreparation = {
  projectId: string; feedbackId: string; source: string; task: string; environment: 'standard' | 'mathlib';
  selection: ResearchConfigurationSelection; refs: ResearchReleaseRef[]; configurationDigest: string; libraryPackDigest: string;
  modulePlan?: ResearchModulePlan;
  target: ResearchLibraryTrialTargetRef; trialDigest: string;
};
export type ResearchLibraryPersonalAttemptPreparation = Omit<ResearchLibraryAttemptPreparation, 'projectId' | 'feedbackId'> & { trialId: string; originRunId: string };
export type ResearchLibraryTrialHistoryItem = Pick<ResearchLibraryTrial, 'id' | 'digest' | 'release' | 'createdAt' | 'status'> & {
  target: ResearchLibraryTrialTargetRef; runTitle: string; taskTitle: string; declaration: string;
  current: boolean; reason?: string; receiptId?: string; checkedAt?: string;
};
export type ResearchLibraryTrialHistory = {
  trial: ResearchLibraryTrial; current: boolean; reason?: string; personalAttempt: boolean;
  libraryPack: ResearchLibraryPack; dependencySources: { file: string; source: string }[];
};
