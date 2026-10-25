import { createCodexMathSession } from '../../runtime/codexSession';
import { checkSolverProof } from './evidence';
import { executeResearch } from './execution';
import { buildResearchContext, buildStatementReviewContext } from './context';
import { selectResearchAction, planResearchRetry, readyResearchTasks, criticalPathResearchTasks, continuationResearchTasks } from './search';
import { assignSharedResearchTask, researchWorkers, assignResearchReviewer } from './organization';
import { checkTaskProof } from '../cooperativeProof';
import { directSolverModuleIdentity, configuredSolverModuleIdentity } from './moduleIdentity';
export { solverModuleConfiguration, solverMethodDigest } from './moduleIdentity';

/** Frozen component versions compose one ordinary direct-proof program. */
export const directSolverModules = {
  id: directSolverModuleIdentity.id,
  M1: { version: directSolverModuleIdentity.versions.M1!, open: createCodexMathSession, execute: executeResearch },
  M2: { version: directSolverModuleIdentity.versions.M2!, check: checkSolverProof, checkTask: checkTaskProof },
  M3: { version: directSolverModuleIdentity.versions.M3!, select: selectResearchAction, retry: planResearchRetry, ready: readyResearchTasks },
  M4: { version: directSolverModuleIdentity.versions.M4!, build: buildResearchContext, statement: buildStatementReviewContext },
  M5: { version: directSolverModuleIdentity.versions.M5!, workers: researchWorkers, reviewer: assignResearchReviewer, assign: assignSharedResearchTask },
};

export type SolverModules = Omit<typeof directSolverModules, 'M2' | 'M5'> & {
  M2: Omit<typeof directSolverModules.M2, 'checkTask'> & { checkTask?: typeof checkTaskProof };
  M5: typeof directSolverModules.M5;
};

/** Named CLI policies bind search and assignment versions without changing host acceptance. */
export function configuredSolverModules(method: string, scheduler: string): SolverModules {
  const identity = configuredSolverModuleIdentity(method, scheduler);
  const base: SolverModules = directSolverModules;
  if (scheduler === 'critical-path') return { ...base,
    M3: { ...base.M3, version: identity.versions.M3!, ready: criticalPathResearchTasks },
    M5: { ...base.M5, version: identity.versions.M5!, assign: assignSharedResearchTask } };
  return scheduler === 'plan' ? base : { ...base,
    M3: { ...base.M3, version: identity.versions.M3!, ready: continuationResearchTasks },
    M5: { ...base.M5, version: identity.versions.M5!, assign: assignSharedResearchTask } };
}
