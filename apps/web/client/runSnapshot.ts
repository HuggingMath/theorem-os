import type { WebRun } from '../shared';

/** Chat reads and live list updates share one run; a late response must not revive its older state. */
export function retainLatestRun(run: WebRun, previous?: WebRun): WebRun {
  if (!previous || previous.id !== run.id) return run;
  const before = previous.solverAttempt ?? (previous.observation && {
    solverRunId: previous.observation.solverRunId, round: 0, sequence: previous.observation.sequence });
  const declared = run.solverAttempt;
  // Only the host can move a Web run to another solver attempt. Its sequences continue across restarts.
  const accepted = declared && (!before || declared.sequence >= before.sequence &&
    (declared.round === before.round && declared.solverRunId === before.solverRunId ||
      declared.round > before.round && declared.solverRunId !== before.solverRunId));
  const attempt = accepted ? declared : previous.solverAttempt;
  const solverRunId = attempt?.solverRunId ?? before?.solverRunId ?? run.observation?.solverRunId;
  let observation = run.observation?.solverRunId === solverRunId ? run.observation : undefined;
  const previousObservation = previous.observation;
  if (previousObservation && previousObservation.solverRunId === solverRunId &&
    (!observation || previousObservation.sequence >= observation.sequence)) observation = previousObservation;
  const latest = previous.updatedAt > run.updatedAt ? previous : run;
  return { ...latest, solverAttempt: attempt, observation };
}
