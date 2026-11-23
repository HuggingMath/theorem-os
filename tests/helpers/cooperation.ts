import { CooperativeResearch } from '../../src/solver/cooperation';
import { reviewGoalPaths } from '../../src/solver/goalPathReview';
import { directSolverModules } from '../../src/solver/modules';
import type { ResearchWorker } from '../../src/solver/modules/organization';
import type { WorkerAccess } from '../../src/solver/research';
import type { SolverRunState } from '../../src/solver/archive';

type Input = ConstructorParameters<typeof CooperativeResearch>[0];

// Worker-delivery fixtures must keep their helper open even when real Lean can solve it at dispatch.
export const workerDeliveryModules: Input['modules'] = {
  ...directSolverModules, M2: { ...directSolverModules.M2, closeTask: undefined },
};

/** Access for every worker with an empty environment and a shared retrieval root. */
export function workerAccess(workers: readonly ResearchWorker[], retrievalRoot: string): Map<string, WorkerAccess> {
  return new Map(workers.map(worker => [worker.id, { environment: {}, retrievalRoot }]));
}

/**
 * Record the current goal-path stall, if any, as already answered by a Lead turn that saw it, as a live
 * decision on unchanged input would have. Fixtures that only simulate such a decision use this.
 */
export function answeredGoalPathStall(state: SolverRunState) {
  const cooperation = state.cooperation!;
  const review = reviewGoalPaths(cooperation.tasks, { groups: cooperation.groups, proofRoutes: cooperation.proofRoutes,
    environmentDigest: state.environmentDigest, candidates: false });
  if (review.stallDigest) cooperation.goalPathStall = { digest: review.stallDigest, active: true, at: 0,
    goalIds: review.stalledGoalIds, taskIds: review.stalledTaskIds.slice(0, 16), answeredAt: 0 };
  return review.stallDigest;
}

/**
 * CooperativeResearch with fixture defaults: shared-root access, a fresh signal, no-op save and emit,
 * the direct modules and an inline exclusive check. Any field in `input` replaces its default.
 */
export function cooperativeResearch(input: Pick<Input, 'state' | 'workers'> & Partial<Input> & { retrievalRoot: string }): CooperativeResearch {
  const { retrievalRoot, ...rest } = input;
  return new CooperativeResearch({ access: workerAccess(input.workers, retrievalRoot),
    signal: new AbortController().signal, save: () => {}, emit: () => {}, modules: directSolverModules,
    exclusiveCheck: async check => check(), ...rest });
}
