#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, required } from './arguments';
import { bootstrapLeanTask } from '../../src/math/leanTask';
import { readMathBuildManifest } from '../../src/math/mathBuildManifest';
import { canonicalMathJson, mathDigest, readMathText, writeMathJsonDurable } from '../../src/math/mathRuntimeIo';
import type { MathAgentOptions, MathAgentSession } from '../../src/runtime/codexSession';
import { readSolverRunState, type SolverRunState } from '../../src/solver/archive';
import { directSolverModules, type SolverModules } from '../../src/solver/modules';
import { proofReceiptsMatch, type ProofCheck } from '../../src/solver/modules/evidence';
import { runSolver } from '../../src/solver/run';
import { inspectStoredRun } from '../../src/solver/storedRunInspection';
import { leadPlanDeliveryFile, taskVersion, type CooperativeAction, type CooperativeTask, type TaskRecord } from '../../src/solver/tasks';
import type { NextCheckRecord } from '../../src/solver/nextCheckContract';
import { queueResearchObservation } from '../../src/solver/researchObservation';
import { runLeanDiagnostics } from '../../src/math/leanDiagnostics';

/** Local arithmetic only: no benchmark statement, answer, model or search service is used. */
export const COOPERATIVE_REPLAY_SOURCE = `namespace Replay

def climb : Nat → Nat
  | 0 => 0
  | n + 1 => climb n + 1

theorem target (n : Nat) : climb n + climb n = n + n := by
  sorry

end Replay
`;
export const COOPERATIVE_REPLAY_TASK = 'Prove Replay.target. Research a precise reusable helper, check it, and apply it to the original target.';
const HELPER: CooperativeTask = { id: 'climb_identity', kind: 'lemma', ownerId: 'engineer',
  objective: 'Induct on n to prove climb is the identity; Replay.target consumes two instances at n.',
  proofPath: 'Submission.lean', theoremName: 'Replay.climb_eq', type: '∀ n : Nat, Replay.climb n = n',
  dependsOn: [], revision: 0 };
const QUESTION: CooperativeTask = { id: 'research_bridge', kind: 'research', ownerId: 'researcher-2',
  objective: 'Read the frozen recursion for climb and propose its closed induction invariant and its application to Replay.target.',
  dependsOn: [], revision: 0 };
const GOAL: CooperativeTask = { id: 'original', kind: 'goal', ownerId: 'engineer',
  objective: 'Prove the original Replay.target using the checked climb identity.', proofPath: 'Submission.lean',
  theoremName: 'Replay.target', status: 'paused', conditional: false, dependsOn: [], revision: 0 };
const HELPER_PROOF = 'by\n  intro n\n  induction n with\n  | zero => rfl\n  | succ n ih =>\n    change climb n + 1 = n + 1\n    exact congrArg (fun value : Nat => value + 1) ih';
const BAD_HELPER_PROOF = 'by\n  intro n\n  exact Nat.zero_ne_one';

export type CooperativeReplayScenario = 'clean' | 'repair-once' | 'next-check';
type ScopedCooperation = { tasks: TaskRecord[]; deliveries?: { kind: string; lemmaRequests?: CooperativeTask[] }[]; nextChecks?: NextCheckRecord[] };
export type CooperativeReplayTurn = { index: number; workerId: string; role: 'lead' | 'researcher' | 'engineer' | 'reviewer';
  threadId: string; turnId: string; action: CooperativeAction; context: string; output: string; source: string;
  injectedFailure: boolean };

/** Use the dispatched assignment, including the current nonce on saved-thread continuations. */
export function cooperativeReplayAssignment(message: string): CooperativeAction {
  const matches = [...message.matchAll(/(?:^|\n)(?:Current )?[Cc]ooperative assignment(?: \([^\n]*\))?:\n([^\n]+)/gu)];
  if (!matches.length) throw new Error('cooperative_replay_assignment_missing');
  const action = JSON.parse(matches.at(-1)![1]) as CooperativeAction;
  if (!['lead', 'task', 'review'].includes(action?.kind)) throw new Error('cooperative_replay_unexpected_assignment');
  return action;
}

/** Only M1.open changes. M1.execute, scheduling, proof checks, integration and S3 remain the normal runtime. */
export function cooperativeReplayActors(scenario: CooperativeReplayScenario, traceDirectory: string) {
  fs.mkdirSync(traceDirectory, { recursive: true, mode: 0o700 });
  const turns: CooperativeReplayTurn[] = [];
  let sessions = 0, helperAttempts = 0;
  const open = async (options: MathAgentOptions): Promise<MathAgentSession> => {
    const workerId = options.environment?.DEEPSCIENTIST_MATH_WORKER_ID;
    if (!workerId) throw new Error('cooperative_replay_worker_identity_missing');
    const threadId = options.threadId ?? `scripted-${workerId}-${++sessions}`;
    return { threadId, interrupt: async () => {}, close: async () => {}, run: async (message, _id, worktree, onStarted) => {
      const action = cooperativeReplayAssignment(message), index = turns.length + 1;
      const turnId = `scripted-turn-${index}`;
      onStarted(turnId);
      const viewFile = path.join(worktree, 'COOPERATION.json');
      const view = fs.existsSync(viewFile) ? JSON.parse(readMathText(viewFile)) as ScopedCooperation : { tasks: [] };
      const sourceFile = path.join(worktree, 'generated/problem/Submission.lean');
      let output: unknown, role: CooperativeReplayTurn['role'], injectedFailure = false;
      if (action.kind === 'lead') {
        role = 'lead';
        if (!view.tasks.length) output = { tasks: [QUESTION, GOAL] };
        else {
          const helper = view.tasks.find(node => node.task.id === HELPER.id);
          const proposal = view.deliveries?.flatMap(delivery => delivery.lemmaRequests ?? []).find(task => task.id === HELPER.id);
          // Keep a live original frontier; conditional:false waits for genuine helper integration.
          const changes = !helper && proposal
            ? [proposal, { id: GOAL.id, status: 'active', dependsOn: [HELPER.id] }] : [];
          output = { baseVersion: action.planVersion, upsert: changes,
            ...(scenario === 'next-check' ? { nextCheckDecisions: (view.nextChecks ?? [])
              .filter(check => check.status === 'awaiting-decision').map(check => ({ checkId: check.id,
                outcomeDeliveryId: check.outcome!.deliveryId, action: 'continue',
                reason: 'The saved Lean probe checks the induction invariant. Adopt the exact helper for independent proof checking.' })) } : {}) };
        }
        // Publish through the same nonce-bound live intake used by a real Lead.
        const file = leadPlanDeliveryFile(action);
        if (!file) throw new Error('cooperative_replay_plan_delivery_missing');
        fs.appendFileSync(path.join(worktree, file), JSON.stringify({ kind: 'plan',
          dispatchNonce: action.planNonce ?? action.initialPlanNonce, baseVersion: action.planVersion,
          summary: 'Adopt the exact research interface, then connect the independently checked helper to the original goal.',
          ...output as Record<string, unknown> }) + '\n', { mode: 0o600 });
        fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), 'The recursion is closed by induction; the target uses the checked identity twice.\n\n' +
          '```math-plan\n' + JSON.stringify(output) + '\n```\n');
      } else if (action.kind === 'review') {
        role = 'reviewer';
        output = { commit: action.seedCommit, verdict: 'accepted',
          summary: 'The fixed original target uses the checked climb identity; its premises and frozen statement are preserved.',
          evidenceRefs: ['Replay.target', 'Replay.climb_eq'] };
        fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), '```math-review\n' + JSON.stringify(output) + '\n```\n');
      } else if (action.kind === 'task' && action.task.id === QUESTION.id) {
        role = 'researcher';
        output = scenario === 'next-check' ? {
          summary: 'Test the induction invariant before assigning its formal proof.', conclusion: 'inconclusive', needsDecision: true,
          mathematicalGap: { consumer: { taskId: GOAL.id, taskDigest: taskVersion(view.tasks.find(node => node.task.id === GOAL.id)!.task) },
            previousGap: 'The recursion must be connected to the target.', reduced: 'The two occurrences share one candidate invariant.',
            remaining: 'Prove climb n = n for every natural number n and then apply it twice.', evidenceScope: 'Proposed invariant, not yet checked.',
            reconsiderWhen: ['A Lean check of the induction invariant.'],
            nextCheck: { action: 'construction-check', objective: 'Check the induction proof for climb n = n in a disposable probe.',
              expectedEvidence: 'A complete saved Lean probe compiling without errors, or its exact failed goal.', targetTaskId: GOAL.id } },
        } : { summary: 'Induction proves climb n = n. Rewrite both climb applications in Replay.target.',
          conclusion: 'supporting', needsDecision: true, lemmaRequests: [HELPER],
          evidenceRefs: ['generated/problem/Challenge.lean:Replay.climb', 'Nat.rec'], remainingObligations: [],
          finding: 'Base case is reflexivity. In the successor case apply congrArg (fun value : Nat => value + 1) to the induction hypothesis. ' +
            'The consumer is Replay.target; rewriting by the resulting identity closes both occurrences.' };
        fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), JSON.stringify(output) + '\n');
      } else if (action.kind === 'task' && scenario === 'next-check' && view.nextChecks?.some(check => check.taskId === action.task.id)) {
        role = 'researcher';
        const check = view.nextChecks.find(check => check.taskId === action.task.id)!;
        const project = path.join(worktree, 'generated/problem');
        const probe = path.join(project, 'InvariantProbe.lean');
        fs.mkdirSync(path.dirname(probe), { recursive: true });
        fs.writeFileSync(probe, COOPERATIVE_REPLAY_SOURCE.replace('theorem target (n : Nat) : climb n + climb n = n + n := by\n  sorry',
          'theorem climb_eq : ∀ n : Nat, climb n = n := ' + HELPER_PROOF));
        const diagnostics = await runLeanDiagnostics({ projectRoot: project, files: [path.basename(probe)],
          env: process.env, timeoutMs: 60_000, signal: new AbortController().signal });
        if (diagnostics.exitCode !== 0 || diagnostics.timedOut) throw new Error('cooperative_replay_probe_failed:' + JSON.stringify(diagnostics));
        output = { summary: 'The complete induction probe passed Lean; the formal helper still needs host acceptance.',
          conclusion: 'supporting', needsDecision: true, lemmaRequests: [HELPER],
          checkOutcome: { checkId: check.id, conclusion: 'supporting', summary: 'The local induction probe compiles.', evidenceRefs: ['RESEARCH.md:Replay.climb_eq'] },
          leanChecks: [{ status: 'passed', path: 'RESEARCH.md', declarations: ['Replay.climb_eq'] }] };
        queueResearchObservation({ worktree, finding: output, probes: [probe] });
        fs.rmSync(probe);
        fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), 'The observation has been published with its retained probe. Read its host receipt.\n');
      } else if (action.kind === 'task' && action.task.id === HELPER.id) {
        role = 'engineer';
        injectedFailure = scenario === 'repair-once' && helperAttempts++ === 0;
        const declaration = 'theorem climb_eq : ∀ n : Nat, climb n = n := ' +
          (injectedFailure ? BAD_HELPER_PROOF : HELPER_PROOF) + '\n\n';
        const source = readMathText(sourceFile);
        fs.writeFileSync(sourceFile, source.includes('theorem climb_eq')
          ? source.replace(/theorem climb_eq[\s\S]*?(?=theorem target)/u, declaration)
          : source.replace('theorem target', declaration + 'theorem target'));
        output = { summary: injectedFailure ? 'One intentionally invalid induction proof tests normal host rejection and repair.'
          : 'The exact typed helper is proved by induction. The original target can now use the checked identity.',
        evidenceRefs: ['Replay.climb_eq'] };
        fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), JSON.stringify(output) + '\n');
      } else if (action.kind === 'task' && action.task.id === GOAL.id) {
        role = 'engineer';
        fs.writeFileSync(sourceFile, readMathText(sourceFile).replace(
          /theorem target[^]*?(?=\nend Replay)/u,
          'theorem target (n : Nat) : climb n + climb n = n + n := by\n  rw [climb_eq n]\n'));
        output = { summary: 'Replay.target applies the independently checked climb identity to both summands.',
          evidenceRefs: ['Replay.climb_eq', 'Replay.target'] };
        fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), JSON.stringify(output) + '\n');
      } else throw new Error(`cooperative_replay_unexpected_task:${action.kind === 'task' ? action.task.id : action.kind}`);
      options.onUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      const prefix = path.join(traceDirectory, String(index).padStart(3, '0'));
      fs.writeFileSync(prefix + '.context.txt', options.instructions + '\n\n' + message, { mode: 0o600 });
      fs.writeFileSync(prefix + '.output.md', readMathText(path.join(worktree, 'RESEARCH.md')), { mode: 0o600 });
      fs.writeFileSync(prefix + '.lean', readMathText(sourceFile), { mode: 0o600 });
      turns.push({ index, workerId, role, threadId, turnId, action, context: prefix + '.context.txt',
        output: prefix + '.output.md', source: prefix + '.lean', injectedFailure });
      writeMathJsonDurable(path.join(traceDirectory, 'turns.json'), turns);
      return 'completed';
    } };
  };
  const modules: SolverModules = { ...directSolverModules, id: `${directSolverModules.id}/scripted-zero-model-${scenario}`,
    M1: { ...directSolverModules.M1, version: `scripted-zero-model-${scenario}-v1`, open } };
  return { modules, turns };
}

/** Read only recorded acceptance. A scripted completed/verdict string never establishes this value. */
export function cooperativeReplayAccepted(state: SolverRunState, result: Record<string, unknown>) {
  const evaluator = result.evaluator as { status?: string; method?: string; verification?: ProofCheck } | undefined;
  const check = evaluator?.verification;
  return state.phase === 'finished' && result.status === 'evaluated_passed' && result.completion_signal_valid === true &&
    result.solver_ready_receipt_valid === true && state.check?.passed === true && result.solution_commit === state.check.commit &&
    evaluator?.status === 'passed' && evaluator.method === 'host-lean-kernel-all-targets' && check?.passed === true &&
    check.commit === state.check.commit && check.sourceDigest === state.check.sourceDigest && state.problem.targets.length > 0 &&
    proofReceiptsMatch(check.verification, check.commit, state.problem.targets.map(target => ({
      proofPath: target.proofPath, theoremName: target.theoremName, expectedSourceDeclarationHash: target.declarationHash,
      statementHash: state.problem.contract.statementHash, leanStatementHash: state.problem.contract.leanStatementHash, claim: 'statement' })));
}

async function replayScenario(directory: string, root: string, buildManifestRef: string, scenario: CooperativeReplayScenario) {
  fs.mkdirSync(directory, { mode: 0o700 });
  const workspace = path.join(directory, 'workspace'), output = path.join(directory, 'result.json');
  const task = path.join(directory, 'task.md'), log = path.join(directory, 'events.jsonl');
  fs.writeFileSync(task, COOPERATIVE_REPLAY_TASK + '\n', { mode: 0o400 });
  bootstrapLeanTask(workspace, { source: COOPERATIVE_REPLAY_SOURCE, task: COOPERATIVE_REPLAY_TASK, environment: 'standard' });
  const actors = cooperativeReplayActors(scenario, path.join(directory, 'turns'));
  const previousLog = console.log;
  let code: number;
  // runSolver's normal event sink is stdout. Persist every line and restore it even on failure.
  console.log = (...values: unknown[]) => {
    fs.appendFileSync(log, values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ') + '\n', { mode: 0o600 });
  };
  try {
    code = await runSolver(['--workspace', workspace, '--task-file', task, '--output', output,
      '--build-manifest', buildManifestRef, '--workers', '4', '--coordination', 'cooperative',
      '--max-turns', '24', '--max-run-seconds', '600', '--max-turn-seconds', '120',
      '--model', 'scripted-zero-model', '--effort', 'none', '--codex', 'scripted-zero-model'], root, actors.modules);
  } finally { console.log = previousLog; }
  const stateFile = path.join(output + '.runtime', 'state.json');
  const state = readSolverRunState(stateFile), result = JSON.parse(readMathText(output)) as Record<string, unknown>;
  const events = readMathText(log).trim().split('\n').flatMap(line => {
    try { const event = JSON.parse(line) as Record<string, unknown>; return typeof event.event === 'string' ? [event] : []; }
    catch { return []; }
  });
  const inspection = await inspectStoredRun(output, { journal: { logFile: log } });
  const inspectionFile = path.join(directory, 'inspection.json');
  writeMathJsonDurable(inspectionFile, inspection);
  const helper = state.cooperation?.tasks.find(node => node.task.id === HELPER.id);
  const goal = state.cooperation?.tasks.find(node => node.task.id === GOAL.id);
  const helperUsed = goal?.integratedCheck?.references?.proof.some(reference => reference.name === HELPER.theoremName) ?? false;
  const count = (name: string) => events.filter(event => event.event === name).length;
  const report = { scenario, mode: 'scripted-zero-model' as const, modelInvoked: false, exitCode: code,
    accepted: cooperativeReplayAccepted(state, result), status: result.status, runId: state.runId,
    problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest, buildDigest: state.buildDigest,
    roles: ['lead', 'researcher', 'engineer', 'reviewer'].map(role => ({ role,
      turns: actors.turns.filter(turn => turn.role === role).length,
      workerIds: [...new Set(actors.turns.filter(turn => turn.role === role).map(turn => turn.workerId))] })),
    dispatchCounts: state.dispatchCounts, workerDispatches: state.workers?.map(worker => ({ id: worker.id,
      role: worker.role, turns: worker.turns, dispatchCounts: worker.dispatchCounts })),
    planPublications: count('initial_plan_published') + count('plan_published'), planRevisions: count('plan_published'),
    failedChecks: events.filter(event => event.event === 'task_checked' && event.passed === false).length,
    failedInputRecords: (state.cooperation?.failedTaskInputs ?? []).length,
    repeatedFailures: count('task_attempt_repeated_advisory'),
    injectedFailures: actors.turns.filter(turn => turn.injectedFailure).length,
    waits: { observations: count('dispatch_wait'), ended: count('dispatch_wait_ended'),
      duration: 'not-inferred-from-observation-times' },
    helper: { integrated: helper?.status === 'integrated' && helper.integratedCheck?.passed === true, usedByOriginal: helperUsed },
    reviewer: state.cooperation?.review, evaluation: result.evaluator,
    nextChecks: (state.cooperation?.nextChecks ?? []).map(check => ({ id: check.id, status: check.status,
      outcome: check.outcome?.conclusion, decision: check.decision?.action,
      decisionApplied: Boolean(check.decision && events.some(event => event.event === 'next_check_decided' &&
        event.checkId === check.id && event.outcomeDeliveryId === check.outcome?.deliveryId && event.action === check.decision!.action)) })),
    artifacts: { output, stateFile, log, inspection: inspectionFile, turns: path.join(directory, 'turns/turns.json') } };
  writeMathJsonDurable(path.join(directory, 'report.json'), report);
  return report;
}

/** Same local mathematics through clean proof, proof repair and the research next-check loop. */
export async function replayCooperative(directory: string, root: string, buildManifestRef: string) {
  if (fs.existsSync(directory)) throw new Error('Replay directory already exists; use a new directory.');
  const manifest = readMathBuildManifest(buildManifestRef, root, path.join(root, 'out/main'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeMathJsonDurable(path.join(directory, 'fixture.json'), { schema: 'theorem-os.cooperative-replay-fixture.v1',
    source: COOPERATIVE_REPLAY_SOURCE, task: COOPERATIVE_REPLAY_TASK,
    sourceDigest: mathDigest(COOPERATIVE_REPLAY_SOURCE), taskDigest: mathDigest(COOPERATIVE_REPLAY_TASK + '\n'),
    buildManifestRef, buildManifestDigest: mathDigest(canonicalMathJson(manifest)),
    roles: 'default four workers; researcher-1 supplies the independently assigned fixed-candidate review',
    configuration: { workers: 4, maxTurns: 24, maxRunSeconds: 600, maxTurnSeconds: 120 },
    scenarios: ['clean', 'repair-once', 'next-check'] });
  const runs = [];
  for (const scenario of ['clean', 'repair-once', 'next-check'] as const)
    runs.push(await replayScenario(path.join(directory, scenario), root, buildManifestRef, scenario));
  const passed = runs.every(run => run.accepted && run.exitCode === 0 && run.helper.integrated && run.helper.usedByOriginal &&
    run.roles.every(role => role.turns > 0)) && runs[1].injectedFailures === 1 && runs[1].failedChecks >= 1 &&
    // Adopting the helper changes the consumer contract: the consumed historical check becomes stale.
    runs[2].nextChecks.some(check => check.decisionApplied && check.outcome === 'supporting' && check.decision === 'continue');
  const report = { schema: 'theorem-os.cooperative-replay.v1', mode: 'scripted-zero-model', modelInvoked: false,
    passed, directory, runs, comparisonKind: 'controlled-fault-recovery',
    evidence: 'Fresh Git commits, real Lean checks, independent fixed-candidate review and S3; only model transport is scripted.',
    limitation: 'These controlled scenarios verify collaboration and rejection/recovery. They do not estimate model solve rates, token savings, or a causal improvement over another solver policy.' };
  writeMathJsonDurable(path.join(directory, 'report.json'), report);
  return report;
}

export async function cooperativeReplay(argv: string[], root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')) {
  const flags = parseFlags(argv, ['directory', 'build-manifest']);
  if (flags.has('help')) {
    console.log('Usage: bun scripts/mathematics/cooperativeReplay.ts --directory NEW_EXTERNAL_DIR --build-manifest FILE\n' +
      'Uses an existing current build; writes no runtime bundle and invokes no model. Saves all three complete four-role scenarios.');
    return 0;
  }
  const report = await replayCooperative(path.resolve(required(flags, 'directory')), root, fs.realpathSync(required(flags, 'build-manifest')));
  console.log(JSON.stringify(report, null, 2));
  return report.passed ? 0 : 1;
}

if (import.meta.main) cooperativeReplay(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  console.error(error); process.exitCode = 1;
});
