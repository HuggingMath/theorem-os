import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { parseCooperationPlan } from '../src/solver/tasks';
import { planApprovalLog } from '../src/solver/planApproval';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

it('keeps a CLI approval wait alive with no model sessions, then exits after approving the same run', async () => {
  const example = localExample('solver-plan-approval-process-', 'lead');
  const lead = leadWorker(example.problem, example.workspace), peer = peerWorker(example, 'engineer', { role: 'engineer' });
  const plan = parseCooperationPlan(example.problem, { tasks: example.problem.targets.map((target, index) => ({
    id: `goal_${index + 1}`, kind: 'goal', objective: `Prove ${target.theoremName}.`,
    theoremName: target.theoremName, proofPath: target.proofPath })) });
  const state = solverState(example.problem, example.workspace, { runId: 'approval-process-fixture', phase: 'running',
    planApproval: true, cooperation: { canonicalCommit: example.problem.baseCommit, planVersion: 'plan-v1',
      tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
      groups: plan.groups.map(group => ({ group, turns: 0 })) } });
  const input = path.join(example.directory, 'input.json'), script = path.join(example.directory, 'wait.ts');
  fs.writeFileSync(input, JSON.stringify({ state, workers: [lead, peer], retrievalRoot: example.directory }));
  fs.writeFileSync(script, `
    import fs from 'node:fs';
    import { cooperativeResearch } from ${JSON.stringify(path.resolve('tests/helpers/cooperation.ts'))};
    import { ExecutionDeadline } from ${JSON.stringify(path.resolve('src/runtime/executionDeadline.ts'))};
    const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const clock = new ExecutionDeadline(1000, () => { throw new Error('execution_allowance_expired'); });
    let announced = false;
    const cooperative = cooperativeResearch({ ...input, onPlanApprovalWaiting: waiting => {
      clock.setWaiting(waiting);
      if (waiting && !announced) { announced = true; process.stdout.write('ready\\n'); }
    } });
    cooperative.modelBudgetChanged();
    cooperative.start();
    const action = await cooperative.next(input.workers[1], { maxTurns: Infinity, remainingMs: clock.remainingMs() });
    clock.stop(); await cooperative.stop();
    process.stdout.write(JSON.stringify({ runId: input.state.runId, approved: input.state.cooperation.planApproval.approvedId,
      taskId: action?.kind === 'task' ? action.task.id : null }) + '\\n');
  `);
  const child = spawn('bun', [script, input], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`approval_wait_not_ready: ${stderr}`)), 5_000);
      const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      child.once('error', finish);
      child.once('exit', () => { if (!stdout.includes('ready\n')) finish(new Error(`approval_wait_exited: ${stderr}`)); });
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('ready\n')) finish(); });
    });
    await delay(1_200);
    expect(child.exitCode, stderr).toBeNull();
    fs.appendFileSync(planApprovalLog(path.join(example.directory, 'state.json')),
      JSON.stringify({ id: 'owner', planVersion: 'plan-v1' }) + '\n');
    expect(await exited, stderr).toBe(0);
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({ runId: state.runId, approved: 'owner', taskId: 'goal_1' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    fs.rmSync(example.directory, { recursive: true, force: true });
  }
});
