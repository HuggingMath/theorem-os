import type { WebRun } from '../shared';
import type { ResearchProjectDetail } from '../researchProjectTypes';

/** The proposal identifies the starting evidence; attachment always uses this run's exact source. */
export function libraryProposalAttemptState(run: WebRun, project: ResearchProjectDetail) {
  const origin = run.libraryProposalOrigin;
  const feedback = project.feedback.find(item => item.id === origin?.feedbackId);
  const attachment = feedback?.payload && 'libraryTrial' in feedback.payload ? feedback.payload.libraryTrial : undefined;
  if (!origin || origin.projectId !== project.id || attachment?.trial.digest !== origin.trialDigest || !feedback?.target)
    return { kind: 'source-unavailable' as const };
  const attached = project.runs.find(binding => binding.runId === run.id);
  if (attached) return { kind: 'attached' as const, feedback, versionId: attached.statementVersionId };
  if (!project.permissions.edit) return { kind: 'read-only' as const, feedback };
  const version = project.versions.find(item => item.source === run.source && item.environment === run.environment
    && (!item.environmentDigest || item.environmentDigest === run.observation?.inspection.configuration.environmentDigest));
  return { kind: version ? 'ready' as const : 'new-version' as const, feedback, versionId: version?.id };
}
