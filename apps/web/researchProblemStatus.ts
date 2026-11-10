import type { WebRun } from './shared';
import type { ResearchProblemRunState } from './researchProblemTypes';
import { failureGuide, planAwaitingApproval, resultDescription, runProgress, stalledMinutes } from './presentation';
import { nextSteps, summarizeGoals } from './report';

/** The problem page reuses the run page's status and recovery decisions, without exposing a second copy of the run. */
export function researchProblemRunState(run: WebRun, controlsHref: string, owned: boolean): ResearchProblemRunState {
  const progress = runProgress(run), failure = failureGuide(run), approval = planAwaitingApproval(run), stalled = stalledMinutes(run);
  return { status: run.status, phase: run.phase, title: failure?.title ?? progress.phaseLabel,
    detail: resultDescription(run), updatedAt: run.updatedAt, elapsedMs: progress.elapsed,
    active: !progress.terminal, waitingForApproval: Boolean(approval), revisingPlan: approval?.leadRevising ?? false,
    hasTaskRoute: Boolean(run.observation?.inspection.tasks.length), owned, controlsHref,
    ...(stalled === undefined ? {} : { stalledMinutes: stalled }),
    actions: owned ? nextSteps(run, summarizeGoals(run)).map(action => ({ id: action.id, label: action.label,
      href: `./?${new URLSearchParams({ run: run.id, recovery: action.id })}` })) : [],
  };
}
