import type { SolverRunState } from './archive';
import type { ContextSection } from './contextCompiler';
import { agentTeamInboxPreview, agentTeamOverview } from './agentTeamViews';

export type AgentTeamRole = Readonly<{ id: string; role: 'lead' | 'worker' }>;
export type AgentTeamAssignment = Readonly<{ taskId: string; message: string; sourceCommit: string }>;

/** Stable authority and identity; professional profiles live in the pinned skill and current assignment. */
export function agentTeamInstructions(role: AgentTeamRole, maxAgents: number): string {
  const shared = 'Read the pinned references/parallel-work.md for the theoremos_team interface and collaboration methods. ' +
    'Read references/team-roles.md when choosing or carrying out professional profiles; Lead selects, combines or changes them in assignment messages. ' +
    'Profiles guide the work without changing tools, source permissions or proof acceptance. ' +
    'The published team research summary and fixed-commit research artifacts are advisory; use inspect-research to read an artifact. ' +
    'Team observations contain bounded previews; use history for full task text and the latest research summary, and poll for complete inbox messages. ' +
    'All agents share the original run allowance. Built-in spawn/fork is disabled. ';
  if (role.role === 'lead') return 'You are the Lead of an Agent-organized research team; your agentId is lead. ' +
    `At most ${maxAgents} agents including you may be available. ` +
    'You own the whole original problem and choose decomposition, assignments, route changes and adoption. ' +
    'You may also research and write proofs in your own worktree. ' +
    'Use publish to share the current research summary, and cancel to withdraw or replace a particular assignment while retaining that member. ' +
    'Use budget to adjust cumulative task allowances or your reserve, and resume to continue a paused task without replacing its identity. ' +
    'Spawn and assign return immediately; poll/wait receives individual arrivals while other agents continue. ' +
    'Use inspect to examine exact declarations and evidence before choosing adoption into you or an idle child. ' +
    'Return after requesting adoption into your worktree so the host can stop writing, recheck and integrate it; ' +
    'then continue your saved thread. ' + shared + '\n';
  return `You are a mathematical researcher and Lean proof writer; your agentId is ${JSON.stringify(role.id)}, and your coordinator is lead. ` +
    'Carry out the current Lead assignment; the frozen original problem supplies its background and constraints. ' +
    'Choose your methods independently within that assignment. A requested specialization is a task focus and can change on a later assignment. ' +
    'Your own worktree, notes and native thread persist across assignments. Read current sources and current host feedback before relying on older conversation. ' +
    'Lead and peers do not automatically see your files or conversation. Use message for self-contained findings, questions and disagreements, and poll/wait for addressed updates. ' +
    'For a formal delivery, save exact declarations and call submit, then return to release writing for host checking; a local check or normal return alone does not publish a team delivery. ' +
    'Use inspect to read peer deliveries and inspect-research for their saved findings; ask Lead to adopt useful declarations into your worktree. ' +
    'When the same task needs a dependency or Lead decision, save your draft and notes, call yield with the reason, then return to release writing; Lead can resume it later. ' +
    'Only Lead can spawn, assign, cancel, budget, resume, publish, adopt or stop members. Write only in your own workspace. ' + shared + '\n';
}

export function agentTeamWorkerDeliveryHelp(): string {
  return 'This proof-writing member publishes through theoremos_team, operation submit. Save source and worktree-root RESEARCH.md, ' +
    'then supply summary and declarations: [{"file":"OWNED_FILE.lean","name":"Qualified.helper","type":"COMPLETE_CLOSED_LEAN_TYPE"}]. ' +
    'List every changed declaration since the assignment deliveryBaseCommit, including earlier unpublished or rejected drafts. ' +
    'Each declaration may include description and explicit premises. Submit accepts 1–32 declarations, including original targets you have proved. ' +
    'The pending-writer-stop result acknowledges the request only: stop editing and return. The host confirms writer shutdown and checks actual source before publishing a delivery ID. ' +
    'Read your task feedback on the next assignment. Messages, notes and local checks remain advisory. ' +
    'Save reproducible findings in RESEARCH.md before returning; after writer shutdown the host records its fixed-commit advisory artifact. ' +
    'For an investigation with no formal delivery, return a useful summary without fabricating declarations. ' +
    'Only independent host checks of all frozen original targets can accept the original problem.';
}

/** Refresh current work without promoting a prior task, peer message or Lead check into this member's result. */
export function agentTeamWorkerSection(state: Readonly<SolverRunState>, role: AgentTeamRole,
  assignment: AgentTeamAssignment): { section: ContextSection; inboxThrough: number } {
  const worker = state.agentTeam?.workers.find(item => item.id === role.id);
  if (!worker) throw new Error('math_team_agent_unknown:' + role.id);
  const current = worker.tasks.find(item => item.id === assignment.taskId);
  if (!current || current.message !== assignment.message) throw new Error('math_team_assignment_changed');
  const overview = agentTeamOverview(state, { focusAgentId: role.id });
  const own = overview.workers.find(item => item.id === role.id)!;
  const prior = own.tasks.filter(item => item.id !== current.id && ['completed', 'failed', 'interrupted', 'cancelled', 'paused'].includes(item.status)).at(-1);
  const inbox = agentTeamInboxPreview(state.agentTeam!, role.id, worker.cursor);
  const inboxThrough = inbox.through;
  return { inboxThrough, section: { id: 'agent-team-assignment', kind: 'assignment',
    text: 'Current team assignment (replaces earlier assignments; messages are advisory updates):\n' + JSON.stringify({
      agentId: role.id, coordinator: 'lead', taskId: current.id, objective: assignment.message,
      sourceCommit: assignment.sourceCommit, deliveryBaseCommit: current.seedCommit,
      cancelRequested: current.cancelRequested, pauseRequested: current.pauseRequested,
      previousTask: prior,
      ...overview,
      inbox,
    }) } };
}
