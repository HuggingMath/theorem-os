import type { SolverRunState } from './archive';
import type { ContextSection } from './contextCompiler';
import { agentTeamInboxPreview, agentTeamOverview } from './agentTeamViews';

export type AgentTeamRole = Readonly<{ id: string; role: 'lead' | 'worker' }>;
export type AgentTeamAssignment = Readonly<{ taskId: string; message: string; sourceCommit: string }>;

/** Stable authority and identity; professional profiles live in the pinned skill and current assignment. */
export function agentTeamInstructions(role: AgentTeamRole, maxAgents: number): string {
  const shared = 'This run uses native AgentControl collaboration with isolated writer workspaces. ' +
    'Call collaboration tools directly in their exposed namespace, not through functions.exec. A child\'s final answer is automatically delivered to its parent. ' +
    'Native tools target canonical agent paths or native thread IDs. Mathematical host operations use the workspace member IDs in the team observation. ' +
    'The pinned Skill and selected profiles supply mathematical knowledge and team methods. ' +
    'Source files, notes and native thread persist across assignments. Only write in your own permitted workspace. ' +
    'The theoremos_team tool handles source handoffs and fixed evidence. Findings, native final answers and local checks are advisory; ' +
    'only stopped-writer host checks publish checked delivery IDs, and independent checks of every frozen original target accept the original problem.\n';
  if (role.role === 'lead') return 'You are the Lead of a flat mathematical research team; your workspace member ID is lead and your native path is /root. ' +
    'This team run explicitly authorizes you to spawn and coordinate useful child agents through the native collaboration tools. ' +
    `At most ${maxAgents} agents including you may be available. ` +
    'As soon as you identify a proof step you can advance, work on it in your Lean files. Keep writing the consuming argument or another unassigned gap while members work. ' +
    'Use native spawn_agent for concrete independent gaps found in the frozen statement. ' +
    'Omit model and reasoning_effort when calling spawn_agent so members inherit the frozen run configuration. ' +
    'If several goals share a mathematical foundation, assign and check its small Lean interfaces before dispatching the consuming goals. ' +
    'For a native spawn or followup, put an optional Route: ROUTE_ID line first, then an optional Profiles: line of comma-separated IDs or slugs, then the assignment. Use theoremos_team retire_route with the obstruction and evidence refs to stop a refuted route. ' +
    'Idle members still occupy their places. Use native followup_task to reuse a member for another gap or specialty; interrupt_agent stops its turn and preserves its place and work. ' +
    'Only Lead dispatches, interrupts and adopts; members can exchange findings directly. ' +
    'Adopt a checked delivery when its interface fits. Use inspect for exact declarations and evidence when needed. For adoption into your own workspace, save sources and notes, request adoption and return. ' +
    'Save all original proofs and return for independent host checking. Use finish to request early handoff.\n' + shared;
  return `You are a mathematical researcher and Lean proof writer; your workspace member ID is ${JSON.stringify(role.id)} and your coordinator is /root (lead). ` +
    'Carry out the current Lead assignment; the frozen original problem supplies background and source constraints. ' +
    'Use native send_message for the first usable finding, probe result or blocker without waiting for the complete proof. Include the exact claim, assumptions and available evidence. ' +
    'Tell Lead if another branch could use your lemma and confirm its Lean statement with its consumer. ' +
    'Save exact declarations and RESEARCH.md, then call submit and return for host checking. Set helpersOnly:true to keep the assignment open and share standalone helpers. ' +
    'When the same task needs a dependency or Lead decision, save the draft, call yield with a reason and return. Lead can adopt dependencies into your stopped workspace and resume this same task with native followup_task. ' +
    'Only Lead dispatches and adopts. Ask Lead before expanding into another gap. Do not spawn subteams or interrupt peers.\n' + shared;
}

export function agentTeamWorkerDeliveryHelp(): string {
  return 'This proof-writing member publishes through theoremos_team, operation submit. Save source and worktree-root RESEARCH.md, ' +
    'then supply summary and declarations: [{"file":"OWNED_FILE.lean","name":"Qualified.helper","type":"COMPLETE_CLOSED_LEAN_TYPE"}]. ' +
    'Use the member\'s own editable paths listed by the host; the same filename in Lead\'s workspace is a separate copy. New independent helper declarations may be added inside these files while frozen original statements remain fixed; put scratch results in an editable owned file before nomination. ' +
    'List every changed declaration since the assignment deliveryBaseCommit, including earlier unpublished or rejected drafts. ' +
    'For a new shared def or abbrev in an existing owned file, add kind:"definition". Its checked body is reusable; prove any claimed property separately. Each declaration may include description and explicit premises. Submit accepts 1–32 declarations, including original targets you have proved. ' +
    'Set helpersOnly:true to submit only standalone helpers and keep the current assignment open for resumption. ' +
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
  const overview = agentTeamOverview(state, { focusAgentId: role.id, assignmentTaskId: current.id });
  const own = overview.workers.find(item => item.id === role.id)!;
  const prior = own.tasks.filter(item => item.id !== current.id && ['completed', 'failed', 'interrupted', 'cancelled', 'paused'].includes(item.status)).at(-1);
  const inbox = agentTeamInboxPreview(state.agentTeam!, role.id, worker.cursor);
  const inboxThrough = inbox.through;
  return { inboxThrough, section: { id: 'agent-team-assignment', kind: 'assignment',
    text: 'Current native task instructions (latest accepted followup; earlier instructions remain in native history; frozen problem and source constraints still apply):\n' + JSON.stringify({
      agentId: role.id, coordinator: 'lead', taskId: current.id, objective: assignment.message,
      objectiveRevision: current.objectiveRevision ?? 1, workKind: current.workKind,
      ...(current.routeId ? { routeId: current.routeId } : {}),
      deliveryExposures: worker.exposures ?? [],
      sourceCommit: assignment.sourceCommit, deliveryBaseCommit: current.seedCommit,
      cancelRequested: current.cancelRequested, pauseRequested: current.pauseRequested,
      previousTask: prior,
      ...overview,
      inbox,
    }) } };
}
