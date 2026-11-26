import type { SolverRunState } from './archive';
import type { ContextSection } from './contextCompiler';
import { agentTeamInboxPreview, agentTeamOverview } from './agentTeamViews';

export type AgentTeamRole = Readonly<{ id: string; role: 'lead' | 'worker' }>;
export type AgentTeamAssignment = Readonly<{ taskId: string; message: string; sourceCommit: string }>;

/** Stable authority and identity; professional profiles live in the pinned skill and current assignment. */
export function agentTeamInstructions(role: AgentTeamRole, maxAgents: number,
  transport: 'host-tools' | 'native-agent-control' = 'host-tools'): string {
  if (transport === 'native-agent-control') return nativeAgentTeamInstructions(role, maxAgents);
  const shared = 'Read the pinned references/parallel-work.md for the theoremos_team interface and collaboration methods. ' +
    'Select domain knowledge for the specific missing concept from references/domain-experts.md and work responsibilities from references/team-roles.md. ' +
    'Lead starts an assignment with Profiles: followed by comma-separated IDs or slugs selected for its gap; a work profile alone is valid. ' +
    'The host includes selected profiles and locators for collected reading from the pinned Skill; read relevant material on demand and clarify unresolved expertise. ' +
    'Profiles guide the work without changing tools, source permissions or proof acceptance. ' +
    'The published team research summary and fixed-commit research artifacts are advisory; use inspect-research to read an artifact. ' +
    'Team observations contain bounded previews; use history for full task text and the latest research summary, and poll for complete inbox messages. ' +
    'Run without task budgets or a Lead reserve by default; only allocate an explicitly configured finite token or turn allowance. ' +
    'When the host reports finite time limits, leave time for saving source and RESEARCH.md and returning before cutoff. ' +
    'Built-in spawn/fork is disabled. ';
  if (role.role === 'lead') return 'You are the Lead of an Agent-organized research team; your agentId is lead. ' +
    `At most ${maxAgents} agents including you may be available. ` +
    'Use the injected Lead profile from the pinned Skill for delegation, task ownership and integration decisions. ' +
    'Team updates enter your ongoing native conversation after the current response and tools. Poll the durable inbox for complete addressed messages. ' +
    'Coordinate and publish are optional compatibility operations for saved decision notes and shared research summaries; they do not gate research, tools or turn scheduling. ' +
    'Use cancel to withdraw or replace an individual assignment. Tag route-specific work with routeId and use retire_route with the obstruction and evidence refs to stop the entire branch. ' +
    'Use amend to change a current task objective or responsibility while retaining its task ID, draft and history; message alone does not amend it. ' +
    'Mark workKind when the distinction matters: independent-reconstruction, assembly, review, research or proof. ' +
    'Inspection and adoption record source exposure; preserve original authorship and describe assembly or exposed review accurately. ' +
    'Use resume to continue a paused task without replacing its identity. ' +
    'Spawn and assign return immediately; poll/wait receives individual arrivals while other agents continue. ' +
    'If portfolio scouting produced no report, split concrete unanswered questions from the frozen statement and spawn useful independent work as soon as capacity is free. ' +
    'Use inspect to examine exact declarations and evidence before choosing adoption into you or an idle child. ' +
    'Save sources and notes before requesting adoption into your worktree, then return. ' +
    'A pending adoption also makes the host hand off automatically before the next model request; ' +
    'after confirmed writer shutdown it rechecks and integrates the delivery, then continues your saved thread. ' +
    'When all original proofs are saved, a successful diagnostic can hand them off automatically. You can also call finish with summary to request independent host checking if a diagnostic could not start; save first, then return. ' + shared + '\n';
  return `You are a mathematical researcher and Lean proof writer; your agentId is ${JSON.stringify(role.id)}, and your coordinator is lead. ` +
    'Carry out the current Lead assignment; the frozen original problem supplies its background and constraints. ' +
    'Use the selected professional knowledge and choose your methods independently within that assignment. A requested specialization is a task focus and can change on a later assignment. ' +
    'Your own worktree, notes and native thread persist across assignments. Read relevant source definitions, exact types and current host feedback before relying on older conversation. ' +
    'Lead and peers do not automatically see your files or conversation. Use message for self-contained findings, questions and disagreements, and poll/wait for addressed updates. ' +
    'For message, agentId is the recipient: use agentId:"lead" to report to Lead, or the peer ID to contact a peer. The host binds your sender identity; self-addressed messages are rejected. ' +
    'Message Lead at the first usable result, local probe or blocker, including the exact claim, assumptions and available evidence; a whole-target assignment does not require waiting for the complete proof to report. ' +
    'Use progress for a useful finding, probe result, blocker or route change. Give the exact result and next step; optional knowledgeUses names a supplied source anchor actually used and its concrete application. These reports remain advisory. ' +
    'For a formal delivery, save exact declarations and call submit, then return to release writing for host checking; a local check or normal return alone does not publish a team delivery. ' +
    'Use submit_helpers to share checked standalone helpers while the assigned target is unfinished. Save your draft, then return for the host to check and land the helpers. ' +
    'For a host tool failure, message Lead with the command and diagnostic; use a documented fallback when available and distinguish that result from host checking. ' +
    'Use inspect to read peer deliveries and inspect-research for their saved findings; ask Lead to adopt useful declarations into your worktree. ' +
    'When the same task needs a dependency or Lead decision, save your draft and notes, call yield with the reason, then return to release writing; Lead can resume it later. ' +
    'Submit and yield also checkpoint automatically before the next model request, after the current response and tools settle. Save before calling them. ' +
    'An amended task carries a new objective revision. Follow it, assess previous findings against it, and retain the draft. ' +
    'Only Lead can spawn, assign, amend, cancel, budget, resume, publish, adopt, finish, stop members or retire routes. Write only in your own workspace. ' + shared + '\n';
}

function nativeAgentTeamInstructions(role: AgentTeamRole, maxAgents: number): string {
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
    'If portfolio scouting produced no report, use native spawn_agent for concrete independent gaps found in the frozen statement. ' +
    'Omit model and reasoning_effort when calling spawn_agent so members inherit the frozen run configuration. ' +
    'If several goals share a mathematical foundation, assign and check its small Lean interfaces before dispatching the consuming goals. ' +
    'Tag route-specific native spawn and followup objectives with Route: ROUTE_ID as the first line. Use theoremos_team retire_route with the obstruction and evidence refs to stop a refuted route. ' +
    'Idle members still occupy their places. Use native followup_task to reuse a member for another gap or specialty; interrupt_agent stops its turn and preserves its place and work. ' +
    'Only Lead dispatches, interrupts and adopts; members can exchange findings directly. ' +
    'Inspect evidence before adopting into yourself or a stopped writer. Save sources and notes, request adoption and return so the host can stop writing, integrate and continue your saved thread. ' +
    'When all original proofs are saved, call finish with a summary and return for independent host checking.\n' + shared;
  return `You are a mathematical researcher and Lean proof writer; your workspace member ID is ${JSON.stringify(role.id)} and your coordinator is /root (lead). ` +
    'Carry out the current Lead assignment; the frozen original problem supplies background and source constraints. ' +
    'Use native send_message for the first usable finding, probe result or blocker without waiting for the complete proof. Include the exact claim, assumptions and available evidence. ' +
    'Tell Lead if another branch could use your lemma and confirm its Lean statement with its consumer. Use submit_helpers for standalone helpers while your current target is unfinished. ' +
    'Save exact declarations and RESEARCH.md, then call submit and return. The pending-writer-stop acknowledgment is not a checked delivery. ' +
    'When the same task needs a dependency or Lead decision, save the draft, call yield with a reason and return. Lead can adopt dependencies into your stopped workspace and resume this same task with native followup_task. ' +
    'Only Lead dispatches and adopts. Ask Lead before expanding into another gap. Do not spawn subteams or interrupt peers.\n' + shared;
}

export function agentTeamWorkerDeliveryHelp(): string {
  return 'This proof-writing member publishes through theoremos_team, operation submit. Save source and worktree-root RESEARCH.md, ' +
    'then supply summary and declarations: [{"file":"OWNED_FILE.lean","name":"Qualified.helper","type":"COMPLETE_CLOSED_LEAN_TYPE"}]. ' +
    'Use the member\'s own editable paths listed by the host; the same filename in Lead\'s workspace is a separate copy. New independent helper declarations may be added inside these files while frozen original statements remain fixed; put scratch results in an editable owned file before nomination. ' +
    'List every changed declaration since the assignment deliveryBaseCommit, including earlier unpublished or rejected drafts. ' +
    'For a new shared def or abbrev in an existing owned file, add kind:"definition". Its checked body is reusable; prove any claimed property separately. Each declaration may include description and explicit premises. Submit accepts 1–32 declarations, including original targets you have proved. ' +
    'For standalone helpers before the assignment is finished, use submit_helpers with the same declaration fields. Nominate just the helpers and return. The host checks and lands eligible helpers, and Lead can resume the current task. ' +
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
    text: (state.agentTeam?.transport === 'native-agent-control'
      ? 'Current native task instructions (latest accepted followup; earlier instructions remain in native history; frozen problem and source constraints still apply):\n'
      : 'Current team assignment (replaces earlier assignments; messages are advisory updates):\n') + JSON.stringify({
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
