import type { SolverRunState } from './archive';

export const legacyCollaborationRetired = 'math_legacy_collaboration_retired: resume with the historical TheoremOS revision that created this run.';

/** Archive readers accept historical research state. A writer only accepts solo or native team state. */
export function assertActiveResearchState(state: Pick<SolverRunState,
  'workerCount' | 'workers' | 'researchDelegation' | 'agentTeam' | 'planApproval' | 'cooperation' | 'portfolioExploration'>) {
  const nativeTeam = state.agentTeam?.transport === 'native-agent-control';
  if (state.portfolioExploration || (state.workerCount ?? 1) > 1 || state.workers?.length ||
      state.researchDelegation?.mode === 'read-only' ||
      (state.researchDelegation?.mode === 'team' || state.agentTeam || state.cooperation || state.planApproval) && !nativeTeam)
    throw new Error(legacyCollaborationRetired);
}
