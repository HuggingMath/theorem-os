#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'smol-toml';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { mathDigest, writeMathJsonDurable } from '../src/math/mathRuntimeIo';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import { createCodexMathSession } from '../src/runtime/codexSession';
import { admitResponsesRequest } from '../src/runtime/formalizationRelay';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import { confirmHarnessProcessStopped, type HarnessProcessIdentity } from '../src/runtime/harnessProcess';
import { prepareSub2apiProfile } from '../src/runtime/sub2api';
import { AgentResearchTeam } from '../src/solver/agentTeam';
import { agentTeamInstructions } from '../src/solver/agentTeamContext';
import type { SolverRunState } from '../src/solver/archive';
import { directSolverModules } from '../src/solver/modules';
import { git, readSolverProblem } from '../src/solver/problem';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';

// Real Codex collaboration handlers and isolated writer processes. All Responses
// are deterministic fixture messages on this process's loopback server.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const executable = fs.realpathSync(flag('--executable') ?? path.join(root, 'out/codex-backend/codex'));
const output = path.resolve(flag('--output') ?? path.join(process.env.TMPDIR ?? '/data/lzh/default-storage/tmp', 'codex-backend-verification'));
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/data/lzh/default-storage/tmp', 'codex-backend-e2e-'));
const requests: Record<string, any>[] = [], events: Record<string, unknown>[] = [];
const processes = new Map<string, HarnessProcessIdentity>();
const observations: Record<string, any> = { schema: 'theorem-os.codex-backend-verification.v1',
  executable, executableDigest: mathDigest(fs.readFileSync(executable)), paidModelCalls: 0, status: 'running' };
let team: AgentResearchTeam | undefined, lead: MathAgentSession | undefined;
let sequence = 0, rootStep = 0;
const memberSteps = new Map<string, number>();
let state: SolverRunState;
const controller = new AbortController();
// A disposable integration-test timeout, independent of solving/model budgets.
const deadline = setTimeout(() => controller.abort(new Error('offline-native-backend-test-timeout')), 180_000);
const until = async (predicate: () => boolean) => {
  while (!predicate()) { controller.signal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const quote = (value: string) => "'" + value.replace(/'/gu, "'\\''") + "'";
const message = (text: string) => ({ type: 'message', id: 'msg_' + ++sequence, role: 'assistant',
  status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const call = (id: string, name: string, args: unknown, namespace?: string) => ({
  type: 'function_call', id, call_id: id, ...(namespace ? { namespace } : {}), name,
  arguments: JSON.stringify(args), status: 'completed',
});
const nativeCall = (id: string, name: string, args: unknown) => call(id, name, args, 'collaboration');

const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/responses');
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    // Exercise the production relay's contract against actual native requests,
    // including child message history. A permissive fixture server hid this boundary.
    admitResponsesRequest(body, 'deepseek-flash', 'high');
    requests.push(body);
    const text = body.input.filter((item: any) => ['message', 'agent_message'].includes(item.type))
      .flatMap((item: any) => item.content ?? []).map((part: any) => part.text ?? part.encrypted_content ?? '').join('\n');
    let items: any[];
    const member = /NATIVE_INTERRUPT_TEST/u.test(text) ? 'interrupt' : /NATIVE_FORK_TEST/u.test(text) ? 'forked' : /NATIVE_FOLLOWUP_TEST/u.test(text) ? 'followup'
      : /NATIVE_WORKER_TEST/u.test(text) ? 'expert' : undefined;
    if (member) {
      const id = ['followup', 'interrupt'].includes(member) ? 'expert' : member;
      const worker = state.agentTeam!.workers.find(worker => worker.id === id)!;
      assert.ok(worker, 'native bootstrap must reserve the host worker before model startup');
      const step = memberSteps.get(member) ?? 0; memberSteps.set(member, step + 1);
      if (member === 'interrupt') {
        const history = JSON.stringify(body.input);
        observations.busySteerSeen ||= history.includes('FIXTURE_BUSY_FOLLOWUP');
        observations.effectiveAmendSeen ||= history.includes('FIXTURE_EFFECTIVE_AMEND');
      }
      if (step === 0) {
        assert.equal(text.includes('NATIVE_ROOT_TEST'), member === 'forked', 'only a full-history fork inherits the parent turn');
        if (member === 'followup') assert.match(text, /Queue only; stay idle\./u, 'cold resume must receive its saved mailbox');
      }
      if (member === 'interrupt' && step === 1) await until(() => observations.waitRequested === true);
      if (member === 'interrupt' && step >= 2) {
        observations.interruptModelPending = true;
        // Effective host notifications finish the current response and tools first.
        // Give each steering action that boundary, then hold the final response for interruption.
        if (!observations.busySteerSeen || !observations.effectiveAmendSeen) {
          const busy = !observations.busySteerSeen;
          await until(() => response.destroyed || (busy ? observations.busyFollowupAccepted === true
            : worker.tasks.at(-1)!.objectiveRevision === 2));
          if (response.destroyed) return;
          items = [call((busy ? 'busy' : 'amend') + '_boundary_' + step, 'exec_command', {
            login: false, cmd: 'printf continuation-boundary' })];
        } else {
          await new Promise<void>(resolve => response.once('close', resolve));
          return;
        }
      } else items = [step === 0 ? call('shell_' + member, 'exec_command', { login: false,
        cmd: 'test "$PWD" = ' + quote(worker.worktree) + ' && test ! -r ' + quote(path.join(state.worktree, 'lead-private')) +
          ' && test ! -r ' + quote(path.join(directory, 'team-workspaces', id === 'expert' ? 'forked' : 'expert', '.scratch/own.txt')) +
          ' && mkdir -p .scratch && printf fixture > .scratch/own.txt && printf isolation-ok' })
        : step === 1 ? nativeCall('peer_' + member, 'send_message', { target: '/root', message: 'Native member result ' + member })
          : message('Independent member research saved.')];
    } else {
      // Native mailbox arrivals may cancel sampling and retry the same model request.
      // Advance the scripted workflow only after its actual tool receipt is in history.
      const receipts = new Set(body.input.filter((item: any) => item.type === 'function_call_output').map((item: any) => item.call_id));
      const stages = ['spawn_fresh', 'queue_idle', 'followup', 'spawn_fork', 'native_list', 'interrupt_idle',
        'followup_interrupt', 'native_wait', 'followup_busy', 'amend_active', 'interrupt_active'];
      let step = 0; while (receipts.has(stages[step])) step++;
      rootStep = Math.max(rootStep, step + 1);
      if (step === 0) items = [nativeCall('spawn_fresh', 'spawn_agent', {
        task_name: 'expert', message: 'NATIVE_WORKER_TEST Read the fixed skill and inspect this disposable fixture.', fork_turns: 'none' })];
      else if (step === 1) {
        assert.ok(state.agentTeam!.workers.some(worker => worker.id === 'expert'), 'native spawn must create its host worker');
        await until(() => !team!.hasActiveWorkers);
        assert.equal(state.agentTeam!.workers.find(worker => worker.id === 'expert')!.tasks.at(-1)!.status, 'completed');
        observations.opensBeforeIdleQueue = processes.size;
        items = [nativeCall('queue_idle', 'send_message', { target: '/root/expert', message: 'Queue only; stay idle.' })];
      } else if (step === 2) {
        observations.opensAfterIdleQueue = processes.size;
        assert.equal(observations.opensBeforeIdleQueue, observations.opensAfterIdleQueue, 'queue-only must not start an idle worker');
        items = [nativeCall('followup', 'followup_task', { target: '/root/expert', message: 'NATIVE_FOLLOWUP_TEST Continue the disposable fixture.' })];
      } else if (step === 3) {
        await until(() => !team!.hasActiveWorkers);
        assert.equal(state.agentTeam!.workers.find(worker => worker.id === 'expert')!.tasks.length, 2);
        assert.equal(state.agentTeam!.workers.find(worker => worker.id === 'expert')!.tasks.at(-1)!.status, 'completed', 'native cold followup must complete');
        items = [nativeCall('spawn_fork', 'spawn_agent', {
          task_name: 'forked', message: 'NATIVE_FORK_TEST Retain the parent history in this disposable fixture.', fork_turns: 'all' })];
      } else if (step === 4) {
        assert.ok(state.agentTeam!.workers.some(worker => worker.id === 'forked'), 'native fork must create its host worker');
        items = [nativeCall('native_list', 'list_agents', {})];
      } else if (step === 5) {
        await until(() => !team!.hasActiveWorkers);
        observations.opensBeforeIdleInterrupt = processes.size;
        items = [nativeCall('interrupt_idle', 'interrupt_agent', { target: '/root/expert' })];
      } else if (step === 6) {
        assert.equal(processes.size, observations.opensBeforeIdleInterrupt, 'interrupting an unloaded member must not launch it');
        items = [nativeCall('followup_interrupt', 'followup_task', { target: '/root/expert', message: 'NATIVE_INTERRUPT_TEST Inspect this fixture until interrupted.' })];
      } else if (step === 7) {
        observations.waitRequested = true;
        items = [nativeCall('native_wait', 'wait_agent', { timeout_ms: 10000 })];
      } else if (step === 8) {
        await until(() => observations.interruptModelPending === true);
        items = [nativeCall('followup_busy', 'followup_task', { target: '/root/expert', message: 'FIXTURE_BUSY_FOLLOWUP Adjust this fixture within its current task.' })];
      } else if (step === 9) {
        await until(() => observations.busySteerSeen === true);
        const worker = state.agentTeam!.workers.find(worker => worker.id === 'expert')!;
        assert.equal(worker.tasks.length, 3, 'busy followup must retain the current task');
        items = [call('amend_active', 'theoremos_team', { operation: 'amend', agentId: worker.id,
          taskId: worker.tasks.at(-1)!.id, message: 'NATIVE_INTERRUPT_TEST FIXTURE_EFFECTIVE_AMEND Inspect the amended disposable fixture.',
          reason: 'Verify attributed effective notifications in an active native child.' })];
      } else if (step === 10) {
        await until(() => observations.effectiveAmendSeen === true);
        items = [nativeCall('interrupt_active', 'interrupt_agent', { target: '/root/expert' })];
      } else {
        await until(() => !team!.hasActiveWorkers);
        items = [message('Native backend fixture complete.')];
      }
    }
    const base = { id: 'resp_' + ++sequence, object: 'response', created_at: 1,
      model: 'deepseek-flash', status: 'in_progress', output: [] };
    const emit = (value: unknown) => response.write('event: ' + (value as any).type + '\ndata: ' + JSON.stringify(value) + '\n\n');
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    emit({ type: 'response.created', response: base });
    for (const [output_index, item] of items.entries()) {
      emit({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress',
        ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } });
      if (item.type === 'function_call') {
        emit({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index, delta: item.arguments });
        emit({ type: 'response.function_call_arguments.done', item_id: item.id, output_index, arguments: item.arguments });
      } else {
        emit({ type: 'response.output_text.delta', item_id: item.id, output_index, content_index: 0, delta: item.content[0].text });
        emit({ type: 'response.output_text.done', item_id: item.id, output_index, content_index: 0, text: item.content[0].text });
      }
      emit({ type: 'response.output_item.done', output_index, item });
    }
    emit({ type: 'response.completed', response: { ...base, status: 'completed', output: items,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
    response.end();
  } catch (error) {
    observations.providerFailure ??= String(error); controller.abort(error);
    response.writeHead(500); response.end('Offline fixture failed.');
  }
});

try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const receipt = bootstrapLeanTask(path.join(directory, 'primary'), {
    task: 'Disposable native execution integration fixture.', source: 'theorem native_backend_fixture : True := by sorry\n' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const worktree = path.join(directory, 'lead');
  git(receipt.workspaceRoot, ['worktree', 'add', '--quiet', '--detach', worktree, problem.baseCommit]);
  fs.writeFileSync(path.join(worktree, 'lead-private'), 'private fixture canary');
  const identity = researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md')));
  const skill = prepareResearchSkill(root, worktree, identity, problem);
  state = { schema: 'deepscientist.math.solver.v1', runId: 'offline-native-backend', phase: 'prepared', problem,
    worktree, model: 'deepseek-flash', effort: 'high', turns: 0, taskDigest: mathDigest('fixture'), buildDigest: 'fixture',
    environmentDigest: mathDigest('offline-native-backend'), evaluatorDigest: 'fixture', researchMode: 'skill',
    researchSkillWorkflow: 'full', researchSkill: identity, researchDelegation: { mode: 'team', maxAgents: 3 },
    agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control', workers: [],
      events: [], deliveries: [], adoptions: [], operations: [] } };
  const profile = path.join(directory, 'profile');
  prepareSub2apiProfile(profile, state.model, state.effort);
  const configFile = path.join(profile, 'config.toml'), config = parse(fs.readFileSync(configFile, 'utf8')) as any;
  config.model_provider = 'offline_native_backend';
  config.model_providers = { offline_native_backend: { ...config.model_providers.sub2api,
    base_url: `http://127.0.0.1:${(server.address() as any).port}/v1`, env_key: 'OFFLINE_NATIVE_BACKEND_KEY' } };
  fs.chmodSync(configFile, 0o600); fs.writeFileSync(configFile, stringify(config));
  const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
  const environment = { PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    ELAN_HOME: path.join(os.homedir(), '.elan'), LEAN_PATH: '', LEAN_SYSROOT: '', NO_PROXY: '127.0.0.1,localhost',
    OFFLINE_NATIVE_BACKEND_KEY: 'synthetic-offline-key', DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap',
    DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'missing.env') };
  const save = () => {
    for (const current of [state.writerProcess, ...(state.agentTeam?.workers.map(worker => worker.writerProcess) ?? [])])
      if (current) processes.set(current.pid + ':' + current.startTime, current);
    writeMathJsonDurable(path.join(output, 'state.json'), state);
  };
  const open = async (options: MathAgentOptions) => {
    const native = options.nativeAgentControl;
    const session = await createCodexMathSession({ ...options, ...(native ? { nativeAgentControl: { ...native,
      connected: async connection => {
        const update = connection.update;
        Object.defineProperty(connection, 'update', { value: async (params: Record<string, unknown>) => {
          try {
            const result = await update(params);
            events.push({ event: 'native_mailbox_update', params, result });
            return result;
          } catch (error) {
            events.push({ event: 'native_mailbox_update_failed', params,
              error: error instanceof Error ? { message: error.message, cause: error.cause } : String(error) });
            throw error;
          }
        } });
        await native.connected?.(connection);
      },
      request: async (request, connection, context) => {
        try {
          const result = await native.request(request, connection, context);
          const input = request.payload.input as any;
          if (request.operation === 'send' && input?.message?.text?.includes('FIXTURE_BUSY_FOLLOWUP'))
            observations.busyFollowupAccepted = true;
          events.push({ event: 'native_host_callback', operation: request.operation, threadId: request.threadId,
            payload: request.payload, result });
          return result;
        } catch (error) {
          events.push({ event: 'native_host_callback_failed', operation: request.operation, threadId: request.threadId,
            payload: request.payload, error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) });
          throw error;
        }
      },
    } } : {}) }).catch(error => {
      events.push({ event: 'native_writer_open_failed', workspace: options.workspace,
        error: error instanceof Error ? { message: error.message, cause: error.cause } : String(error) });
      throw error;
    });
    if (session.processIdentity) processes.set(session.processIdentity.pid + ':' + session.processIdentity.startTime, session.processIdentity);
    return session;
  };
  team = new AgentResearchTeam({ state, root, taskText: 'Disposable integration fixture.', leadAccess: {
    environment, researchSkill: skill, retrievalRoot: path.join(worktree, problem.projectRelative) },
    modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open } }, executable, profile,
    signal: controller.signal, maxAgents: 3, maxTurns: Infinity, maxTurnMs: Infinity, maxTotalTokens: 0,
    remainingMs: () => Infinity, save, emit: (event, details) => { events.push({ event, ...details }); },
    exclusiveCheck: async operation => operation() });
  lead = await open({ executable, profile, workspace: worktree, proofProjectRoot: path.join(worktree, problem.projectRelative),
    model: state.model, effort: state.effort, environment, skills: [skill], tools: team.tools(),
    nativeAgentControl: team.nativeAgentControlOptions(), isolateProcess: true, hiddenRoots: team.hiddenRoots,
    instructions: agentTeamInstructions({ id: 'lead', role: 'lead' }, 3, 'native-agent-control'),
    signal: controller.signal, onUsage: () => {} });
  team.setLeadSession(lead); state.writerProcess = lead.processIdentity; save();
  observations.rootStatus = await lead.run('NATIVE_ROOT_TEST Execute the scripted disposable backend fixture.', 'root-task', worktree, () => {});
  assert.equal(observations.rootStatus, 'completed');
  assert.equal(rootStep, 12);
  assert.deepEqual(state.agentTeam!.workers.map(worker => worker.native!.agentPath).sort(), ['/root/expert', '/root/forked']);
  const expert = state.agentTeam!.workers.find(worker => worker.id === 'expert')!;
  assert.equal(expert.tasks.length, 3);
  assert.equal(expert.tasks.at(-1)!.status, 'interrupted');
  assert.equal(expert.tasks.at(-1)!.objectiveRevision, 2);
  assert.ok(expert.tasks.at(-1)!.sourceCommit, 'interruption must preserve the stopped writer draft');
  assert.equal(state.agentTeam!.deliveries.length, 0, 'native completed replies must not become Lean deliveries');
  assert.match(fs.readFileSync(path.join(worktree, problem.projectRelative, 'Submission.lean'), 'utf8'), /sorry/u);
  const outputs = requests.flatMap(body => body.input ?? []).filter(item => item.type === 'function_call_output');
  // Native forks mark the parent's unfinished tool as aborted in copied history.
  // Retain the original producer's receipt before later inherited copies.
  observations.toolOutputs = {};
  for (const item of outputs) observations.toolOutputs[item.call_id] ??= item.output;
  for (const member of ['expert', 'followup', 'forked', 'interrupt']) assert.match(String(observations.toolOutputs['shell_' + member]), /isolation-ok/u);
  assert.equal(JSON.parse(observations.toolOutputs.native_wait).timed_out, false);
  assert.equal(JSON.parse(observations.toolOutputs.interrupt_idle).previous_status, 'not_found');
  assert.equal(JSON.parse(observations.toolOutputs.interrupt_active).previous_status, 'running');
  observations.nativePaths = state.agentTeam!.workers.map(worker => worker.native!.agentPath);
  observations.taskCounts = state.agentTeam!.workers.map(worker => ({ id: worker.id, count: worker.tasks.length }));
  observations.loopbackRequests = requests.length;
  observations.relayAdmission = {
    acceptedRequests: requests.length,
    namespaceRequests: requests.filter(body => body.tools?.some((tool: any) => tool.type === 'namespace')).length,
    agentMessageRequests: requests.filter(body => body.input?.some((item: any) => item.type === 'agent_message')).length,
  };
  assert.ok(observations.relayAdmission.namespaceRequests > 0, 'native namespaces must pass production relay admission');
  assert.ok(observations.relayAdmission.agentMessageRequests > 0, 'native child messages must pass production relay admission');
  observations.status = 'passed';
} catch (error) {
  observations.status = 'failed'; observations.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline); controller.abort();
  await team?.close(); await lead?.close();
  observations.processes = [...processes.values()].map(identity => ({ ...identity, stop: confirmHarnessProcessStopped(identity) }));
  if (observations.processes.some((process: any) => process.stop.status !== 'stopped')) { observations.status = 'failed'; process.exitCode = 1; }
  writeMathJsonDurable(path.join(output, 'verification.json'), observations);
  writeMathJsonDurable(path.join(output, 'trace.json'), { requests, events });
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log(JSON.stringify(observations, null, 2));
