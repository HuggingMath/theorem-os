import type { WebRun } from '../shared';
import type { ResearchProjectDetail } from '../researchProjectTypes';

/** Always follow the prepared run's frozen statement, even if the project now has a newer current version. */
export function budgetAttemptState(run: WebRun, project: ResearchProjectDetail) {
  const attached = project.runs.find(binding => binding.runId === run.id);
  if (attached) return { kind: 'attached' as const, versionId: attached.statementVersionId };
  const binding = project.runs.find(item => item.runId === run.budgetOrigin?.runId);
  const version = project.versions.find(item => item.id === binding?.statementVersionId);
  if (!version) return { kind: 'unavailable' as const };
  if (run.source !== version.source || run.environment !== version.environment)
    return { kind: 'different-statement' as const };
  if (version.environmentDigest && !run.observation && ['queued', 'running'].includes(run.status))
    return { kind: 'checking-environment' as const };
  if (version.environmentDigest && run.observation?.inspection.configuration.environmentDigest !== version.environmentDigest)
    return { kind: 'different-statement' as const };
  if (!project.permissions.edit) return { kind: 'read-only' as const };
  return { kind: 'ready' as const, versionId: version.id };
}
