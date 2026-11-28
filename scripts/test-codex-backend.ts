#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
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
import { verifyNativeProofDelivery } from './test-codex-backend-delivery';

// Real Codex collaboration handlers and isolated writer processes. All Responses
// are deterministic fixture messages on this process's loopback server.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const capacityTest = process.argv.includes('--team-capacity');
const largeForkTest = process.argv.includes('--large-fork');
assert.ok(!capacityTest || !largeForkTest, 'Select only one fixture mode.');
const maxAgents = capacityTest ? 8 : 3;
const requestedExecutable = flag('--executable') ?? process.env.THEOREMOS_TEST_CODEX_EXECUTABLE ?? path.join(root, 'out/codex-backend/codex');
if (!fs.existsSync(requestedExecutable)) throw new Error('Native backend acceptance requires a real Codex binary. ' +
  'Pass --executable PATH or THEOREMOS_TEST_CODEX_EXECUTABLE; missing: ' + requestedExecutable);
const executable = fs.realpathSync(requestedExecutable);
const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 });
if (version.status !== 0) throw new Error('Native backend acceptance could not execute Codex: ' + executable);
const output = path.resolve(flag('--output') ?? path.join(process.env.TMPDIR ?? '/data/lzh/default-storage/tmp', 'codex-backend-verification'));
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/data/lzh/default-storage/tmp', 'codex-backend-e2e-'));
const requests: Record<string, any>[] = [], events: Record<string, unknown>[] = [];
const processes = new Map<string, HarnessProcessIdentity>();
const observations: Record<string, any> = { schema: 'theorem-os.codex-backend-verification.v1',
  executable, version: version.stdout.trim(), executableDigest: mathDigest(fs.readFileSync(executable)), paidModelCalls: 0, status: 'running' };
let team: AgentResearchTeam | undefined, lead: MathAgentSession | undefined;
let sequence = 0, rootStep = 0;
const memberSteps = new Map<string, number>();
let state: SolverRunState;
const controller = new AbortController();
// A disposable integration-test timeout, independent of solving/model budgets.
const deadline = setTimeout(() => controller.abort(new Error('offline-native-backend-test-timeout')), 240_000);
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

async function largeForkResponse(body: Record<string, any>, text: string, mode: string) {
  if (mode.includes('You are a member')) {
    assert.match(text, /LARGE_FORK_FRESH_WORKER/u);
    assert.doesNotMatch(text, /LARGE_FORK_HISTORY/u);
    return [message('Fresh worker completed.')];
  }
  if (!text.includes('LARGE_FORK_ACTION')) return [message('Stored a disposable history segment.')];
  const receipts = new Map<string, string>(body.input.filter((item: any) => item.type === 'function_call_output')
    .map((item: any) => [item.call_id, item.output]));
  if (!receipts.has('oversized_fork')) return [nativeCall('oversized_fork', 'spawn_agent', {
    task_name: 'large_fork', fork_turns: 'all', message: 'Try an oversized history transfer.' })];
  const rejection = receipts.get('oversized_fork')!;
  assert.match(rejection, /exceeds the 8 MiB transport limit.*fork_turns=none/u);
  if (!receipts.has('fresh_after_oversized_fork')) return [nativeCall('fresh_after_oversized_fork', 'spawn_agent', {
    task_name: 'large_fork', fork_turns: 'none', message: 'LARGE_FORK_FRESH_WORKER Continue this disposable fixture.' })];
  assert.equal(JSON.parse(receipts.get('fresh_after_oversized_fork')!).task_name, '/root/large_fork');
  await until(() => !team!.hasActiveWorkers);
  observations.largeFork = { rejection, leadThreadId: lead!.threadId,
    workerStatus: state.agentTeam!.workers[0]?.tasks.at(-1)?.status };
  return [message('Lead finished after recovering from the oversized fork.')];
}

const pendingMembers = new Set<string>();
let releaseMembers = false;
async function capacityResponse(body: Record<string, any>, text: string, mode: string) {
  if (mode.includes('You are a member')) {
    const name = text.match(/NATIVE_CAPACITY_MEMBER (seat_[1-7])\b/u)?.[1];
    assert.ok(name && !pendingMembers.has(name), 'one real writer request per accepted seat');
    pendingMembers.add(name);
    try { await until(() => releaseMembers); }
    finally { pendingMembers.delete(name); }
    return [message('Capacity fixture worker finished.')];
  }
  const receipts = new Map<string, string>(body.input.filter((item: any) => item.type === 'function_call_output')
    .map((item: any) => [item.call_id, item.output]));
  for (let n = 1; n <= 7; n++) {
    const name = 'seat_' + n, receipt = receipts.get(name);
    if (!receipt) return [nativeCall(name, 'spawn_agent', { task_name: name, fork_turns: 'none',
      message: 'NATIVE_CAPACITY_MEMBER ' + name + ' Hold this disposable fixture assignment.' })];
    assert.equal(JSON.parse(receipt).task_name, '/root/' + name, 'native spawn must accept ' + name + ': ' + receipt);
  }
  await until(() => pendingMembers.size === 7 || releaseMembers);
  if (!receipts.has('capacity_roster')) return [nativeCall('capacity_roster', 'list_agents', {})];
  const roster = JSON.parse(receipts.get('capacity_roster')!).agents;
  const expected = ['/root', ...Array.from({ length: 7 }, (_, i) => '/root/seat_' + (i + 1))];
  assert.deepEqual(roster.filter((agent: any) => agent.agent_status === 'running').map((agent: any) => agent.agent_name).sort(), expected);
  if (!receipts.has('overflow')) return [nativeCall('overflow', 'spawn_agent', {
    task_name: 'overflow', fork_turns: 'none', message: 'Overflow fixture; must never reach a writer.' })];
  const overflow = receipts.get('overflow')!;
  assert.match(overflow, /math_team_capacity_exceeded/u);
  assert.equal(processes.size, maxAgents, 'one isolated writer process per occupied seat');
  assert.equal(state.agentTeam!.workers.length, 7, 'overflow must not allocate a worker');
  observations.capacity = { maxAgents, activeNativeAgents: expected, simultaneousMemberRequests: 7,
    writerProcesses: processes.size, overflowReceipt: overflow };
  releaseMembers = true;
  await until(() => !team!.hasActiveWorkers);
  return [message('Capacity verified.')];
}

/** Native resumes/full forks preserve history; a later mode supersedes older hints. */
const effectiveMultiAgentMode = (body: Record<string, any>): string | undefined => {
  const messages = [body.instructions, ...body.input.filter((item: any) => ['system', 'developer'].includes(item.role))
    .map((item: any) => typeof item.content === 'string' ? item.content
      : (item.content ?? []).map((part: any) => part.text ?? '').join('\n'))];
  return messages.filter((text): text is string => typeof text === 'string')
    .flatMap(text => [...text.matchAll(/<multi_agent_mode>([\s\S]*?)<\/multi_agent_mode>/gu)].map(match => match[1]!.trim())).at(-1);
};

function sendResponse(response: ServerResponse, items: any[]) {
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
}

const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/responses');
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    // Exercise the production relay's contract against actual native requests,
    // including child message history. A permissive fixture server hid this boundary.
    admitResponsesRequest(body, 'deepseek-flash', 'high');
    requests.push(largeForkTest ? { bytes: chunks.reduce((total, chunk) => total + chunk.length, 0) } : body);
    const text = body.input.filter((item: any) => ['message', 'agent_message'].includes(item.type))
      .flatMap((item: any) => item.content ?? []).map((part: any) => part.text ?? part.encrypted_content ?? '').join('\n');
    let items: any[];
    const member = /NATIVE_INTERRUPT_TEST/u.test(text) ? 'interrupt' : /NATIVE_FORK_TEST/u.test(text) ? 'forked' : /NATIVE_FOLLOWUP_TEST/u.test(text) ? 'followup'
      : /NATIVE_WORKER_TEST/u.test(text) ? 'expert' : undefined;
    const mode = effectiveMultiAgentMode(body);
    assert.ok(mode, 'Every native writer request must carry an effective multi-agent mode.');
    assert.doesNotMatch(mode, /Any earlier instruction enabling proactive multi-agent delegation no longer applies|Do not spawn sub-agents unless/u,
      'The current native mode must honor the explicitly requested team.');
    assert.equal(body.tool_choice, 'auto', 'Native collaboration must remain a model choice.');
    if (capacityTest) return sendResponse(response, await capacityResponse(body, text, mode));
    if (largeForkTest) return sendResponse(response, await largeForkResponse(body, text, mode));
    if (member) {
      assert.match(mode, /You are a member of an explicitly requested flat team\./u);
      assert.match(mode, /Do not spawn sub-agents or dispatch, redirect or interrupt other members\./u);
      assert.match(mode, /first usable finding, probe result or blocker without waiting for a complete proof/u);
      assert.doesNotMatch(mode, /Proactively delegate useful complementary work|You are the Lead/u,
        'A cold resume or full-history fork must not inherit Lead authority as its current mode.');
    } else {
      assert.match(mode, /You are the Lead of an explicitly requested flat team\./u);
      assert.match(mode, /Proactively delegate useful complementary work/u);
      assert.match(mode, /concrete gaps with a consumer and first usable result/u);
      assert.match(mode, /instead of competing for the same deliverable/u);
    }
    const modeChecks = observations.modeChecks ??= {};
    modeChecks[member ?? 'lead'] = (modeChecks[member ?? 'lead'] ?? 0) + 1;
    if (member) {
      const id = ['followup', 'interrupt'].includes(member) ? 'expert' : member;
      const worker = state.agentTeam!.workers.find(worker => worker.id === id)!;
      assert.ok(worker, 'native bootstrap must reserve the host worker before model startup');
      const step = memberSteps.get(member) ?? 0; memberSteps.set(member, step + 1);
      if (member === 'interrupt') {
        const history = JSON.stringify(body.input);
        observations.busySteerSeen ||= history.includes('FIXTURE_BUSY_FOLLOWUP');
        observations.effectiveFollowupSeen ||= history.includes('FIXTURE_EFFECTIVE_FOLLOWUP');
        if (observations.effectiveFollowupSeen) {
          assert.match(text, /The ideal class group measures the obstruction to principality/u,
            'The changed specialty must reach the actual busy writer request with its native followup.');
          assert.ok(text.includes(path.join(worker.worktree, '.agents/skills/theoremos-research/references/domain-materials/number-theory.md')),
            'Domain reading must be located in the recipient workspace.');
          observations.hotProfileSeen = true;
        }
      }
      if (step === 0) {
        assert.equal(text.includes('NATIVE_ROOT_TEST'), member === 'forked', 'only a full-history fork inherits the parent turn');
        if (member === 'followup') assert.match(text, /Queue only; stay idle\./u, 'cold resume must receive its saved mailbox');
      }
      if (member === 'interrupt' && step === 1) await until(() => observations.waitRequested === true);
      if (member === 'interrupt' && step >= 2) {
        observations.interruptModelPending = true;
        // Native followups finish the current response and tools first.
        // Give each steering action that boundary, then hold the final response for interruption.
        if (!observations.busySteerSeen || !observations.effectiveFollowupSeen) {
          const busy = !observations.busySteerSeen;
          await until(() => response.destroyed || (busy ? observations.busyFollowupAccepted === true
            : worker.tasks.at(-1)!.objectiveRevision === 3));
          if (response.destroyed) return;
          items = [call((busy ? 'busy' : 'followup') + '_boundary_' + step, 'exec_command', {
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
      // Resume and full-history forks retain prior tool calls. Advance the scripted
      // workflow only after the original tool's actual receipt is in history.
      const receipts = new Map<string, string>(body.input.filter((item: any) => item.type === 'function_call_output')
        .map((item: any) => [item.call_id, item.output]));
      if (!receipts.has('spawn_wrong_effort')) return sendResponse(response, [nativeCall('spawn_wrong_effort', 'spawn_agent', {
        task_name: 'expert', message: 'This assignment should be rejected before a writer opens.',
        fork_turns: 'none', reasoning_effort: 'low',
      })]);
      assert.match(receipts.get('spawn_wrong_effort')!, /math_team_native_run_config_frozen/u);
      if (!receipts.has('spawn_fresh')) {
        assert.equal(state.agentTeam!.workers.length, 0, 'Changing the frozen effort must not reserve a worker.');
        assert.equal(processes.size, 1, 'Changing the frozen effort must not open a writer.');
      }
      const stages = ['spawn_fresh', 'queue_idle', 'followup', 'spawn_fork', 'native_list', 'interrupt_idle',
        'followup_interrupt', 'native_wait', 'followup_busy', 'followup_effective', 'interrupt_active'];
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
        assert.ok(processes.size > observations.opensAfterIdleQueue, 'The cold followup must open a new isolated writer.');
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
        items = [nativeCall('followup_effective', 'followup_task', { target: '/root/expert',
          message: 'Profiles: D012, engineer\nNATIVE_INTERRUPT_TEST FIXTURE_EFFECTIVE_FOLLOWUP Inspect the updated disposable fixture.' })];
      } else if (step === 10) {
        await until(() => observations.effectiveFollowupSeen === true);
        items = [nativeCall('interrupt_active', 'interrupt_agent', { target: '/root/expert' })];
      } else {
        await until(() => !team!.hasActiveWorkers);
        items = [message('Native backend fixture complete.')];
      }
    }
    sendResponse(response, items);
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
    researchSkillWorkflow: 'full', researchSkill: identity, researchDelegation: { mode: 'team', maxAgents },
    agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control', workers: [],
      events: [], deliveries: [], adoptions: [], operations: [] } };
  const profile = path.join(directory, 'profile');
  prepareSub2apiProfile(profile, state.model, state.effort);
  const configFile = path.join(profile, 'config.toml'), config = parse(fs.readFileSync(configFile, 'utf8')) as any;
  config.model_provider = 'offline_native_backend';
  config.model_providers = { offline_native_backend: { ...config.model_providers.sub2api,
    base_url: `http://127.0.0.1:${(server.address() as any).port}/v1`, env_key: 'OFFLINE_NATIVE_BACKEND_KEY' } };
  if (largeForkTest) {
    // Each user-message notification stays under the stdio frame limit. The
    // scripted provider accepts their combined history without auto-compacting.
    const window = 8_000_000;
    config.model_context_window = window;
    config.model_auto_compact_token_limit = window;
    const catalogFile = path.resolve(profile, config.model_catalog_json);
    const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    for (const model of catalog.models) Object.assign(model, { context_window: window, max_context_window: window });
    fs.chmodSync(catalogFile, 0o600);
    fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  }
  fs.chmodSync(configFile, 0o600); fs.writeFileSync(configFile, stringify(config));
  const userHome = os.homedir();
  const elanHome = process.env.ELAN_HOME || path.join(userHome, '.elan');
  const toolchain = path.join(elanHome, 'toolchains/leanprover--lean4---v4.33.0');
  const environment = { HOME: userHome, PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    ELAN_HOME: elanHome, LEAN_PATH: '', LEAN_SYSROOT: '', NO_PROXY: '127.0.0.1,localhost',
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
    signal: controller.signal, maxAgents, maxTurns: Infinity, maxTurnMs: Infinity, maxTotalTokens: 0,
    remainingMs: () => Infinity, save, emit: (event, details) => { events.push({ event, ...details }); },
    exclusiveCheck: async operation => operation() });
  lead = await open({ executable, profile, workspace: worktree, proofProjectRoot: path.join(worktree, problem.projectRelative),
    model: state.model, effort: state.effort, environment, skills: [skill], tools: team.tools(),
    nativeAgentControl: team.nativeAgentControlOptions(), isolateProcess: true, hiddenRoots: team.hiddenRoots,
    instructions: agentTeamInstructions({ id: 'lead', role: 'lead' }, maxAgents),
    signal: controller.signal, onUsage: () => {} });
  team.setLeadSession(lead); state.writerProcess = lead.processIdentity; save();
  if (largeForkTest) for (const index of [1, 2, 3, 4]) {
    const text = `LARGE_FORK_HISTORY ${index} ` + '界'.repeat(800_000);
    assert.equal(await lead.run(text, 'history-' + index, worktree, () => {}), 'completed');
  }
  observations.rootStatus = await lead.run(largeForkTest ? 'LARGE_FORK_ACTION' :
    'NATIVE_ROOT_TEST Execute the scripted disposable backend fixture.', 'root-task', worktree, () => {});
  assert.equal(observations.rootStatus, 'completed');
  if (capacityTest) {
    assert.ok(observations.capacity, 'must reach the full team and observe the failed overflow spawn');
    assert.ok(state.agentTeam!.workers.every(w => w.tasks.at(-1)?.status === 'completed'));
    observations.loopbackRequests = requests.length;
  } else if (largeForkTest) {
    assert.equal(observations.largeFork?.workerStatus, 'completed');
    assert.equal(state.agentTeam!.workers.length, 1, 'The oversized fork must not reserve a worker.');
    assert.equal(events.filter(event => event.event === 'native_host_callback' && event.operation === 'spawn').length, 1);
  } else checkLifecycle(worktree, problem.projectRelative);
  await team.close(); await lead.close(); team = undefined; lead = undefined;
  if (!capacityTest && !largeForkTest) observations.proofDelivery = await verifyNativeProofDelivery({ repository: root, executable,
    output: path.join(output, 'proof-delivery'), signal: controller.signal, webProvider: process.argv.includes('--web-provider') });
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

function checkLifecycle(worktree: string, projectRelative: string) {
  assert.equal(rootStep, 12);
  assert.deepEqual(state.agentTeam!.workers.map(worker => worker.native!.agentPath).sort(), ['/root/expert', '/root/forked']);
  const expert = state.agentTeam!.workers.find(worker => worker.id === 'expert')!;
  assert.equal(expert.native!.spawnHistory, 'fresh');
  assert.equal(state.agentTeam!.workers.find(worker => worker.id === 'forked')!.native!.spawnHistory, 'parent-history');
  assert.equal(expert.tasks.length, 3);
  assert.equal(expert.tasks.at(-1)!.status, 'interrupted');
  assert.equal(expert.tasks.at(-1)!.objectiveRevision, 3);
  assert.deepEqual(expert.tasks.at(-1)!.profileEvidence?.loaded, ['D012', 'engineer']);
  assert.equal(observations.hotProfileSeen, true);
  for (const role of ['lead', 'expert', 'followup', 'forked', 'interrupt'])
    assert.ok(observations.modeChecks[role] > 0, 'Actual provider requests must validate the current mode for ' + role);
  assert.match(state.agentTeam!.nativeControl!.rootRuntimeConfiguration!.overrides.multiAgentModeHintText!, /You are the Lead/u);
  for (const worker of state.agentTeam!.workers)
    assert.match(worker.native!.runtimeConfiguration!.overrides.multiAgentModeHintText!, /You are a member/u);
  assert.ok(expert.tasks.at(-1)!.sourceCommit, 'interruption must preserve the stopped writer draft');
  assert.equal(state.agentTeam!.deliveries.length, 0, 'native completed replies must not become Lean deliveries');
  assert.match(fs.readFileSync(path.join(worktree, projectRelative, 'Submission.lean'), 'utf8'), /sorry/u);
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
}
