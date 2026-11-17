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
    'Select domain knowledge from references/domain-experts.md and work responsibilities from references/team-roles.md. ' +
    'Lead puts selected IDs or slugs on the first line of an assignment, for example Profiles: D006, prover. ' +
    'The host includes those profiles and their collected reading notes from the pinned Skill in the member context; clarify unresolved or custom expertise. ' +
    'Profiles guide the work without changing tools, source permissions or proof acceptance. ' +
    'The published team research summary and fixed-commit research artifacts are advisory; use inspect-research to read an artifact. ' +
    'Team observations contain bounded previews; use history for full task text and the latest research summary, and poll for complete inbox messages. ' +
    'Run without task budgets or a Lead reserve by default; only allocate an explicitly configured finite token or turn allowance. ' +
    'When the host reports finite time limits, leave time for saving source and RESEARCH.md and returning before cutoff. ' +
    'Built-in spawn/fork is disabled. ';
  if (role.role === 'lead') return 'You are the Lead of an Agent-organized research team; your agentId is lead. ' +
    `At most ${maxAgents} agents including you may be available. ` +
    'You own the whole original problem and choose decomposition, assignments, route changes and adoption. ' +
    'After reading the frozen statement, read the opening team protocol in references/parallel-work.md and make an early collaboration decision before extended solo investigation. ' +
    'Spawn a useful complementary question when one can advance the proof or inform a route decision; an investigation does not require a finished proof route or exact helper type. ' +
    'Spawn/assign records a delegation decision. If you defer, call coordinate with decision:"defer", reason and nextStep: the concrete reason and bounded research step needed to reconsider. ' +
    'Team updates enter your ongoing native conversation after the current response and tools. Poll the durable inbox for complete addressed messages. ' +
    'The host can hand off at an unpaid request boundary for an unanswered opening decision, completed deferred step or update unavailable through the native queue, then continues this saved thread. ' +
    'This scheduling handoff has no token, time or turn quota. Read the current coordination observation and act on it before extended solo work. ' +
    'Example theoremos_team arguments (adapt the assignment to the useful question): ' +
    '{"operation":"spawn","agentId":"researcher-1","message":"Profiles: statement-analyst\\nReview the frozen statement and definitions. Identify independently checkable obligations and boundary cases; send Lead exact statements and source references, and save reproducible findings in RESEARCH.md."}. ' +
    'Choose expertise from the actual mathematical objects; give the question, known inputs, intended consumer and useful deliverable, leaving the proof approach to the member. ' +
    'After dispatch, publish the shared route, ownership of each gap and what you will handle yourself before extended solo work. ' +
    'You may also research and write proofs in your own worktree. Choose a complementary gap; if you need to overlap a member, explain and coordinate that change. ' +
    'At a useful finding, route change, blocker or completed local probe, poll the durable inbox and assess arrivals before beginning another substantial investigation. ' +
    'Respond to findings and dependency questions, inspect available results and keep the published summary current. ' +
    'After assessing an update, publish the resulting route, dispatch the next work, or record coordinate with decision:"continue", reason and nextStep. ' +
    'Use cancel to withdraw or replace a particular assignment while retaining that member. ' +
    'Use amend to change a current task objective or responsibility while retaining its task ID, draft and history; message alone does not amend it. ' +
    'Mark workKind when the distinction matters: independent-reconstruction, assembly, review, research or proof. ' +
    'Inspection and adoption record source exposure; preserve original authorship and describe assembly or exposed review accurately. ' +
    'Use resume to continue a paused task without replacing its identity. ' +
    'Spawn and assign return immediately; poll/wait receives individual arrivals while other agents continue. ' +
    'Use inspect to examine exact declarations and evidence before choosing adoption into you or an idle child. ' +
    'Save sources and notes before requesting adoption into your worktree, then return. ' +
    'A pending adoption also makes the host hand off automatically before the next model request; ' +
    'after confirmed writer shutdown it rechecks and integrates the delivery, then continues your saved thread. ' +
    'When all original proofs are saved, a successful diagnostic can hand them off automatically. You can also call finish with summary to request independent host checking if a diagnostic could not start; save first, then return. ' + shared + '\n';
  return `You are a mathematical researcher and Lean proof writer; your agentId is ${JSON.stringify(role.id)}, and your coordinator is lead. ` +
    'Carry out the current Lead assignment; the frozen original problem supplies its background and constraints. ' +
    'Use the selected professional knowledge and choose your methods independently within that assignment. A requested specialization is a task focus and can change on a later assignment. ' +
    'Your own worktree, notes and native thread persist across assignments. Read current sources and current host feedback before relying on older conversation. ' +
    'Lead and peers do not automatically see your files or conversation. Use message for self-contained findings, questions and disagreements, and poll/wait for addressed updates. ' +
    'For message, agentId is the recipient: use agentId:"lead" to report to Lead, or the peer ID to contact a peer. The host binds your sender identity; self-addressed messages are rejected. ' +
    'Message Lead when you obtain a usable result or encounter a blocker, including the exact claim, assumptions and available evidence; do not leave a completed result only in your private transcript. ' +
    'Use progress for a useful finding, probe result, blocker or route change. Give the exact result and next step; optional knowledgeUses names a loaded file#anchor and its concrete application. These reports remain advisory. ' +
    'For a formal delivery, save exact declarations and call submit, then return to release writing for host checking; a local check or normal return alone does not publish a team delivery. ' +
    'Deliver an independent helper as soon as it answers the assignment, even while other original goals remain open. Ask Lead before expanding into another member\'s gap; finish the handoff before starting unrelated work. ' +
    'For a host tool failure, message Lead with the command and diagnostic; use a documented fallback when available and distinguish that result from host checking. ' +
    'Use inspect to read peer deliveries and inspect-research for their saved findings; ask Lead to adopt useful declarations into your worktree. ' +
    'When the same task needs a dependency or Lead decision, save your draft and notes, call yield with the reason, then return to release writing; Lead can resume it later. ' +
    'Submit and yield also checkpoint automatically before the next model request, after the current response and tools settle. Save before calling them. ' +
    'An amended task carries a new objective revision. Follow it, assess previous findings against it, and retain the draft. ' +
    'Only Lead can spawn, assign, amend, cancel, budget, resume, publish, adopt, finish or stop members. Write only in your own workspace. ' + shared + '\n';
}

function nativeAgentTeamInstructions(role: AgentTeamRole, maxAgents: number): string {
  const shared = 'This run uses the real native AgentControl backend. Use native spawn_agent, followup_task, send_message, list_agents, wait_agent and interrupt_agent for collaboration. ' +
    'The theoremos_team tool supplies mathematical host operations; it does not duplicate native identities or mailboxes. ' +
    'Native tools target canonical agent paths or native thread IDs. Mathematical host operations use the workspace member IDs in the team observation. ' +
    'Read the pinned references/parallel-work.md for cooperation and delivery rules. For this run, the native transport instructions here supersede historical theoremos_team spawn/message/poll examples. ' +
    'Choose domain knowledge from references/domain-experts.md and responsibilities from references/team-roles.md. ' +
    'Start each new assignment with Profiles: followed by the selected IDs or slugs; the host loads those profiles and source notes into the member context. ' +
    'Profiles supply knowledge and responsibility without changing source permissions or proof acceptance. ' +
    'Each member writes in its own isolated workspace. Source files, notes and native thread persist across assignments. ' +
    'Findings, native final answers, local checks and saved research artifacts are advisory. Only stopped-writer host checks publish checked delivery IDs; independent checks of every frozen original target accept the original problem. ' +
    'Use history for complete task text, inspect for checked declarations and inspect-research for saved research. ' +
    'Run without task budgets or a Lead reserve unless a finite allowance was explicitly configured. Native turn completion never grants proof acceptance.\n';
  if (role.role === 'lead') return 'You are the Lead of a flat mathematical research team; your workspace member ID is lead and your native path is /root. ' +
    `At most ${maxAgents} agents including you may be available. ` +
    'You own the whole frozen problem, choose complementary assignments and routes, and decide which checked results to adopt. ' +
    'Make an early collaboration decision before extended solo investigation. Spawn a useful complementary question; if deferring, record coordinate with a concrete reason and bounded nextStep. ' +
    'After dispatch, publish the shared route and ownership of each gap. Work on a complementary gap and assess arriving findings at useful discoveries, blockers or route changes. ' +
    'Use native followup to continue an existing member: an idle member receives a new task, a yielded member resumes the same task and draft, and a busy member receives steering within its current task. ' +
    'A native message or followup does not change the effective objective revision of a running or yielded task. Use amend for that change and cancel to withdraw a particular assignment. ' +
    'Native interruption stops the current turn while preserving member identity and saved drafts. Only the Lead dispatches, amends, cancels, interrupts and adopts. Members can exchange findings directly. ' +
    'Inspect evidence before adopting into yourself or a stopped writer. Save sources and notes, request adoption and return so the host can stop writing, integrate and continue your saved thread. ' +
    'When all original proofs are saved, call finish with a summary and return for independent host checking.\n' + shared;
  return `You are a mathematical researcher and Lean proof writer; your workspace member ID is ${JSON.stringify(role.id)} and your coordinator is /root (lead). ` +
    'Carry out the current Lead assignment using the selected specialist knowledge and your own methods. Read current task/revision, source and feedback when resuming. ' +
    'Send self-contained findings, questions and disagreements to Lead or peers through native send_message, and use native wait_agent when waiting for updates. ' +
    'Report useful findings and blockers promptly, including the exact claim, assumptions and available evidence. Use progress with the current objectiveRevision; optional knowledgeUses records a loaded file#anchor and its application. ' +
    'Save exact declarations and RESEARCH.md, then call submit and return. The pending-writer-stop acknowledgment is not a checked delivery. Submit useful helpers once they answer the assignment, even if other original goals remain open. ' +
    'When the same task needs a dependency or Lead decision, save the draft, call yield with a reason and return. Lead can adopt dependencies into your stopped workspace and resume this same task by native followup. ' +
    'Only Lead dispatches and adopts. Ask Lead before expanding into another gap. Do not spawn subteams or interrupt peers.\n' + shared;
}

export function agentTeamWorkerDeliveryHelp(): string {
  return 'This proof-writing member publishes through theoremos_team, operation submit. Save source and worktree-root RESEARCH.md, ' +
    'then supply summary and declarations: [{"file":"OWNED_FILE.lean","name":"Qualified.helper","type":"COMPLETE_CLOSED_LEAN_TYPE"}]. ' +
    'List every changed declaration since the assignment deliveryBaseCommit, including earlier unpublished or rejected drafts. ' +
    'Each declaration may include description and explicit premises. Submit accepts 1–32 declarations, including original targets you have proved. ' +
    'Submit useful independent declarations when they answer the assignment; other original goals may remain unfinished. Message Lead about the result before extending the scope. ' +
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
      objectiveRevision: current.objectiveRevision ?? 1, workKind: current.workKind,
      profileEvidence: current.profileEvidence, deliveryExposures: worker.exposures ?? [],
      sourceCommit: assignment.sourceCommit, deliveryBaseCommit: current.seedCommit,
      cancelRequested: current.cancelRequested, pauseRequested: current.pauseRequested,
      previousTask: prior,
      ...overview,
      inbox,
    }) } };
}
