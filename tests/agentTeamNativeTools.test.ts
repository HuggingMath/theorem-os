import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { createCodexMathSession, type MathAgentSession } from '../src/runtime/codexSession';
import type { ModelRequestGate, ModelRequestReceipt } from '../src/runtime/modelRequest';
import { prepareSub2apiProfile, SUB2API_PROVIDER } from '../src/runtime/sub2api';
import { AgentResearchTeam } from '../src/solver/agentTeam';
import { directSolverModules } from '../src/solver/modules';
import { readSolverProblem } from '../src/solver/problem';
import { beginRequestUsage, initializeRequestUsageAccounting } from '../src/solver/usageBudget';
import { solverState } from './helpers/solver';

type Json = Record<string, any>;
const executable = process.env.THEOREMOS_TEST_CODEX_EXECUTABLE ?? 'codex';
const nativeAvailable = spawnSync(executable, ['--version'], {
  env: { PATH: process.env.PATH }, timeout: 5000, stdio: 'ignore',
}).status === 0;
const nativeLeadOperations = ['finish', 'history', 'inspect', 'inspect-research', 'adopt', 'retire_route', 'route_summary'];
const nativeMemberOperations = ['yield', 'history', 'inspect', 'inspect-research', 'submit', 'route_summary'];

/** Codex may normalize validation keywords, but it must preserve every branch and field. */
function expectAdvertisedOperations(host: Json, expected: string[], schema: Json) {
  expect(host).toBeDefined();
  const parameters = host.parameters;
  expect(parameters).toMatchObject({ type: 'object', required: ['operation'], additionalProperties: false,
    properties: { operation: { type: 'string', enum: expected } } });
  expect(Object.keys(parameters.properties).sort()).toEqual(Object.keys(schema.properties).sort());
  if (expected.length > 16) expect(parameters).not.toHaveProperty('oneOf');
  else {
    expect(parameters.oneOf.map((branch: Json) => branch.properties.operation.enum[0])).toEqual(expected);
    for (const [index, branch] of schema.oneOf.entries()) {
      expect(parameters.oneOf[index]).toMatchObject({ type: 'object', required: branch.required, additionalProperties: false });
      expect(Object.keys(parameters.oneOf[index].properties).sort()).toEqual(Object.keys(branch.properties).sort());
    }
  }
  for (const operation of expected) expect(host.description).toContain(operation + ': required ');
}

let directory: string | undefined, session: MathAgentSession | undefined, server: Server | undefined;
afterEach(async () => {
  await session?.close(); session = undefined;
  if (server) {
    const current = server; server = undefined;
    current.closeAllConnections();
    await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
  }
  vi.restoreAllMocks();
  if (directory) fs.rmSync(directory, { recursive: true, force: true }); directory = undefined;
});

function declaredTools(request: Json): Json[] {
  const declarations = [...(request.tools ?? []), ...(Array.isArray(request.input)
    ? request.input.filter((item: Json) => item.type === 'additional_tools').flatMap((item: Json) => item.tools) : [])];
  return declarations.flatMap((tool: Json) => tool.type === 'namespace' ? tool.tools : [tool]);
}

/** Full forks retain earlier role hints; only the latest privileged mode applies. */
function effectiveMultiAgentMode(request: Json): string | undefined {
  const messages = [request.instructions, ...(Array.isArray(request.input) ? request.input
    .filter((item: Json) => ['system', 'developer'].includes(item.role))
    .map((item: Json) => typeof item.content === 'string' ? item.content
      : (item.content ?? []).map((part: Json) => part.text ?? '').join('\n')) : [])];
  return messages.filter((text): text is string => typeof text === 'string')
    .flatMap(text => [...text.matchAll(/<multi_agent_mode>([\s\S]*?)<\/multi_agent_mode>/gu)].map(match => match[1]!.trim())).at(-1);
}

function fixtureResponse(response: ServerResponse, id: string, items: Json[]) {
  const base = { id, object: 'response', created_at: 1, model: 'deepseek-flash', status: 'in_progress', output: [] };
  const stream: Json[] = [{ type: 'response.created', response: base }];
  for (const [output_index, item] of items.entries()) {
    const isCall = item.type === 'function_call';
    stream.push({ type: 'response.output_item.added', output_index, item: isCall
      ? { ...item, status: 'in_progress', arguments: '' } : { ...item, status: 'in_progress', content: [] } });
    if (isCall) stream.push(
      { type: 'response.function_call_arguments.delta', item_id: item.id, output_index, delta: item.arguments },
      { type: 'response.function_call_arguments.done', item_id: item.id, output_index, arguments: item.arguments });
    else stream.push(
      { type: 'response.output_text.delta', item_id: item.id, output_index, content_index: 0, delta: item.content[0].text },
      { type: 'response.output_text.done', item_id: item.id, output_index, content_index: 0, text: item.content[0].text });
    stream.push({ type: 'response.output_item.done', output_index, item });
  }
  stream.push({ type: 'response.completed', response: { ...base, status: 'completed', output: items,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  response.end(stream.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''));
}

// This checks the real native client's wire protocol. The upstream is local and
// scripted, so passing this test says nothing about a model choosing to delegate.
describe.skipIf(!nativeAvailable || !process.env.THEOREMOS_TEST_CODEX_EXECUTABLE)('real Codex dynamic team tool transport without a model', () => {
  it.each(['lead', 'member'])('round trips the %s mathematical tool contract', async actor => {
    const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';
    fs.mkdirSync(temporaryRoot, { recursive: true });
    directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'agent-team-native-tools-')));
    const requests: Json[] = [], routes: string[] = [], errors: unknown[] = [];
    const summary = 'Transport fixture: save Lead finish intent.';
    const args = actor === 'lead' ? { operation: 'finish', summary } : { operation: 'route_summary' };
    const call = { type: 'function_call', id: 'fc_team_probe', call_id: 'call_team_probe',
      name: 'theoremos_team', arguments: JSON.stringify(args), status: 'completed' };
    server = createServer(async (request, response) => {
      try {
        routes.push(request.url ?? '');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const index = requests.length;
        const final = { type: 'message', id: 'msg_team_probe', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'The host result was received.', annotations: [] }] };
        const item = index === 1 ? call : final;
        const isCall = item.type === 'function_call';
        const base = { id: 'resp_team_probe_' + index, object: 'response', created_at: 1,
          model: 'deepseek-flash', status: 'in_progress', output: [] };
        const events: Json[] = [{ type: 'response.created', response: base },
          { type: 'response.output_item.added', output_index: 0, item: isCall
            ? { ...item, status: 'in_progress', arguments: '' } : { ...final, status: 'in_progress', content: [] } }];
        if (isCall) events.push(
          { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
          { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments });
        else events.push(
          { type: 'response.output_text.delta', item_id: final.id, output_index: 0, content_index: 0, delta: final.content[0].text },
          { type: 'response.output_text.done', item_id: final.id, output_index: 0, content_index: 0, text: final.content[0].text });
        events.push({ type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { ...base, status: 'completed', output: [item],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        response.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''));
      } catch (error) {
        errors.push(error); response.writeHead(500); response.end();
      }
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const endpoint = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1';
    const profile = path.join(directory, 'profile');
    prepareSub2apiProfile(profile, 'deepseek-flash', 'high');
    const configFile = path.join(profile, 'config.toml'), config = parseToml(fs.readFileSync(configFile, 'utf8')) as Json;
    // A disposable provider ID bypasses production endpoint selection entirely.
    config.model_provider = 'offline_team_fixture';
    config.model_providers = { offline_team_fixture: { ...config.model_providers.sub2api,
      base_url: endpoint, env_key: 'THEOREMOS_TEST_KEY' } };
    fs.chmodSync(configFile, 0o600); fs.writeFileSync(configFile, stringifyToml(config));
    const receipt = bootstrapLeanTask(path.join(directory, 'work'), {
      task: 'Offline transport fixture only.', source: 'theorem original : True := by sorry\n',
    });
    const state = solverState(readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath), receipt.workspaceRoot,
      { runId: 'offline-native-tools', phase: 'running', researchMode: 'skill',
        researchDelegation: { mode: 'team', maxAgents: 3 } });
    state.agentTeam = { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control',
      events: [], deliveries: [], adoptions: [], operations: [], workers: [] };
    const team = new AgentResearchTeam({ state, root: process.cwd(), taskText: 'Offline transport fixture only.',
      leadAccess: { environment: {}, retrievalRoot: receipt.workspaceRoot }, modules: directSolverModules,
      executable, profile, signal: new AbortController().signal, maxAgents: 3, maxTurns: 4, maxTurnMs: 10_000,
      maxTotalTokens: 0, remainingMs: () => 10_000, save: () => {}, emit: () => {}, exclusiveCheck: operation => operation() });
    const tools = team.tools(actor), hostCalls: { name: string; arguments: unknown; threadId: string; turnId: string }[] = [];
    session = await createCodexMathSession({ executable, profile, workspace: receipt.workspaceRoot,
      model: 'deepseek-flash', effort: 'high', instructions: 'Offline team transport fixture.', turnTimeoutMs: 10_000,
      environment: { PATH: process.env.PATH, THEOREMOS_TEST_KEY: 'offline-synthetic-key',
        [SUB2API_PROVIDER.apiKeyEnvironment]: 'offline-synthetic-key', NO_PROXY: '127.0.0.1,localhost' },
      onUsage: () => {}, tools: { definitions: tools.definitions, call: async (name, args, context) => {
        hostCalls.push({ name, arguments: args, threadId: context.threadId, turnId: context.turnId });
        return tools.call(name, args, context);
      } } });
    expect(await session.run('Exercise the local team interface.', 'offline-native-tools', receipt.workspaceRoot, () => {})).toBe('completed');
    expect(errors).toEqual([]); expect(routes).toEqual(Array(2).fill('/v1/responses'));
    expect(requests).toHaveLength(2);
    const advertised = declaredTools(requests[0]).find(tool => tool.name === 'theoremos_team');
    expectAdvertisedOperations(advertised!, actor === 'member' ? nativeMemberOperations : nativeLeadOperations,
      tools.definitions[0]!.inputSchema);
    expect(advertised!.parameters.properties).not.toHaveProperty('budget');
    expect(advertised!.parameters.properties).not.toHaveProperty('leadReserve');
    expect(hostCalls).toEqual([{ name: 'theoremos_team', arguments: args,
      threadId: session.threadId, turnId: expect.any(String) }]);
    if (actor === 'lead') expect(state.agentTeam!.completionRequested).toMatchObject({ summary });
    const returned = requests.at(-1)!.input.find((item: Json) => item.type === 'function_call_output' && item.call_id === call.call_id);
    expect(JSON.stringify(returned?.output)).toContain(actor === 'lead' ? 'pending-writer-stop' : 'routes');
    expect(session.lastCompletedResponse?.text).toBe('The host result was received.');
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  }, 20_000);

  it.skipIf(!process.env.THEOREMOS_TEST_CODEX_EXECUTABLE).each(['opening', 'defer', 'continue'] as const)(
    'ignores archived %s coordination state while native research and collaboration remain available', async savedDecision => {
    const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';
    fs.mkdirSync(temporaryRoot, { recursive: true });
    directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'agent-team-native-autonomy-')));
    const requests: Json[] = [], errors: unknown[] = [], events: string[] = [], hostCalls: Json[] = [];
    const functionCall = (id: string, name: string, args: Json, namespace?: string) => ({
      type: 'function_call', id, call_id: id, name, ...(namespace ? { namespace } : {}),
      arguments: JSON.stringify(args), status: 'completed',
    });
    // Archived decisions, a failed probe and native recipient feedback cannot
    // introduce a host coordination prerequisite for ordinary research.
    const calls = [
      functionCall('probe_before_decision', 'ordinary_research_probe', { stage: 'before-decision' }),
      functionCall('saved_history', 'theoremos_team', { operation: 'history' }),
      functionCall('native_list', 'list_agents', {}, 'collaboration'),
      functionCall('native_recipient_probe', 'send_message', {
        target: '/root', message: 'Offline self-addressed recipient probe; no team task is dispatched.',
      }, 'collaboration'),
      functionCall('probe_after_updates', 'ordinary_research_probe', { stage: 'after-updates' }),
    ];
    const finalText = 'Native research continued without a host coordination gate.';
    server = createServer(async (request, response) => {
      try {
        if (request.url !== '/v1/responses') throw new Error('unexpected_native_autonomy_route');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const index = requests.length;
        const item = calls[index - 1] ?? { type: 'message', id: 'msg_native_autonomy', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: finalText, annotations: [] }] };
        fixtureResponse(response, 'resp_native_autonomy_' + index, [item]);
      } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const endpoint = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1/responses';
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== SUB2API_PROVIDER.baseUrl + '/responses') throw new Error('unexpected_native_autonomy_upstream');
      return realFetch(endpoint, init);
    });
    const profile = path.join(directory, 'profile'); prepareSub2apiProfile(profile, 'deepseek-flash', 'high');
    const receipt = bootstrapLeanTask(path.join(directory, 'work'), {
      task: 'Offline native autonomy fixture.', source: 'theorem original : True := by sorry\n',
    });
    const state = solverState(readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath), receipt.workspaceRoot,
      { runId: 'offline-native-autonomy', phase: 'running', researchMode: 'skill',
        researchDelegation: { mode: 'team', maxAgents: 3 },
        agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control',
          workers: [], events: [], deliveries: [], adoptions: [], operations: [] } });
    if (savedDecision !== 'opening') {
      state.agentTeam!.coordination = { decision: savedDecision, reason: 'Saved archived decision.', nextStep: 'Inspect a local probe.',
        revision: 1, at: 1, startedRequests: 0, observationRevision: 0, activeAssignments: false,
        eventSequence: 0, nativeMessageSequence: 0 };
      state.agentTeam!.coordinationObservation = { key: 'saved-failed-probe', kind: 'tool-result', failed: true,
        description: 'A previous local probe failed.', revision: 1, at: 1 };
    }
    // A persisted presentation from the old scheduler must remain harmless on resume.
    state.agentTeam!.coordinationPresentation = { at: 1, reason: savedDecision === 'opening' ? 'opening' : 'research-update',
      decisionRevision: state.agentTeam!.coordination?.revision ?? 0, eventSequence: 0, nativeMessageSequence: 0,
      observationRevision: state.agentTeam!.coordinationObservation?.revision ?? 0, startedRequests: 0 };
    const savedJournal = structuredClone({ coordination: state.agentTeam!.coordination,
      observation: state.agentTeam!.coordinationObservation, presentation: state.agentTeam!.coordinationPresentation });
    const receipts: ModelRequestReceipt[] = [];
    const team = new AgentResearchTeam({ state, root: process.cwd(), taskText: 'Offline native autonomy fixture.',
      leadAccess: { environment: {}, retrievalRoot: receipt.workspaceRoot }, modules: directSolverModules,
      executable, profile, signal: new AbortController().signal, maxAgents: 3, maxTurns: Infinity, maxTurnMs: Infinity,
      maxTotalTokens: 0, remainingMs: () => Infinity, save: () => {}, emit: event => { events.push(event); },
      exclusiveCheck: operation => operation() });
    const tools = team.tools(), onUsageIncomplete = vi.fn();
    const gate = team.leadRequestGate(() => ({ allowed: true, settle: value => { receipts.push(value); } }));
    try {
      team.beginLeadTurn();
      session = await createCodexMathSession({ executable, profile, workspace: receipt.workspaceRoot,
        model: 'deepseek-flash', effort: 'high', instructions: 'Offline native autonomy fixture.', turnTimeoutMs: 10_000,
        nativeAgentControl: team.nativeAgentControlOptions(), requestGate: gate,
        environment: { PATH: process.env.PATH, [SUB2API_PROVIDER.apiKeyEnvironment]: 'offline-synthetic-key', NO_PROXY: '127.0.0.1,localhost' },
        onUsage: () => {}, onUsageIncomplete, tools: { definitions: [...tools.definitions, {
          name: 'ordinary_research_probe', description: 'Disposable local research observation.',
          inputSchema: { type: 'object', properties: { stage: { type: 'string' } }, required: ['stage'], additionalProperties: false },
        }], call: async (name, args, context) => {
          hostCalls.push({ name, arguments: args });
          if (name === 'ordinary_research_probe') {
            const stage = (args as Json).stage;
            return { ok: false, diagnostic: stage };
          }
          return tools.call(name, args, context);
        } } });
      team.setLeadSession(session);
      expect(await session.run('Exercise native research with archived coordination state.', 'offline-native-autonomy', receipt.workspaceRoot, () => {})).toBe('completed');
      expect(errors).toEqual([]); expect(requests).toHaveLength(calls.length + 1);
      for (const request of requests) {
        expect(request.tool_choice).toBe('auto');
        const advertised = declaredTools(request);
        expect(advertised.map(tool => tool.name)).toEqual(expect.arrayContaining([
          'spawn_agent', 'followup_task', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
          'theoremos_team', 'ordinary_research_probe', 'exec_command',
        ]));
        const host = advertised.find(tool => tool.name === 'theoremos_team');
        expectAdvertisedOperations(host!, nativeLeadOperations, tools.definitions[0]!.inputSchema);
        for (const property of ['decision', 'nextStep', 'budget', 'leadReserve', 'objectiveRevision'])
          expect(host!.parameters.properties).not.toHaveProperty(property);
      }
      expect(hostCalls).toEqual(calls.filter(call => !('namespace' in call)).map(call => ({
        name: call.name, arguments: JSON.parse(call.arguments),
      })));
      const listOutput = requests.at(-1)!.input.find((item: Json) => item.type === 'function_call_output' && item.call_id === 'native_list');
      expect(JSON.stringify(listOutput?.output)).toContain('/root');
      expect(requests.at(-1)!.input).toContainEqual(expect.objectContaining({
        type: 'function_call_output', call_id: 'native_recipient_probe',
      }));
      expect(state.agentTeam!.workers).toHaveLength(0); expect(state.agentTeam!.deliveries).toHaveLength(0);
      expect({ coordination: state.agentTeam!.coordination, observation: state.agentTeam!.coordinationObservation,
        presentation: state.agentTeam!.coordinationPresentation }).toEqual(savedJournal);
      expect(state.agentTeam!.researchState).toBeUndefined();
      expect(events.filter(event => event.startsWith('team_coordination') || event === 'team_research_observed')).toEqual([]);
      expect(receipts).toHaveLength(requests.length); expect(receipts.every(value => value.complete)).toBe(true);
      expect(onUsageIncomplete).not.toHaveBeenCalled(); expect(session.lastCompletedResponse?.text).toBe(finalText);
      expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
    } finally { await team.close(); }
  }, 20_000);

  it.skipIf(!process.env.THEOREMOS_TEST_CODEX_EXECUTABLE)(
    'runs official native spawn, isolated child tools, mailbox wakeup and native completion with minimal host operations', async () => {
    const [{ readMathAgentSkill }, { prepareResearchSkill, researchSkillIdentity }, { agentTeamInstructions }] = await Promise.all([
      import('../src/runtime/agentSkills'), import('../src/solver/researchSkill'), import('../src/solver/agentTeamContext'),
    ]);
    const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';
    fs.mkdirSync(temporaryRoot, { recursive: true });
    directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'agent-team-native-dispatch-')));
    const root = process.cwd(), requests: Json[] = [], errors: unknown[] = [], events: string[] = [];
    const controller = new AbortController();
    const receipt = bootstrapLeanTask(path.join(directory, 'work'), {
      task: 'Offline native dispatch fixture.', source: 'theorem original : True := by sorry\n',
    });
    const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
    const identity = researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md')));
    const state = solverState(problem, receipt.workspaceRoot, { runId: 'offline-native-dispatch', phase: 'running',
      environmentDigest: 'e'.repeat(64), model: 'deepseek-flash', effort: 'high', researchMode: 'skill', researchSkill: identity,
      researchDelegation: { mode: 'team', maxAgents: 2 },
      agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control',
        workers: [], events: [], deliveries: [], adoptions: [], operations: [] } });
    const researchSkill = prepareResearchSkill(root, state.worktree, identity, problem);
    const privateFile = path.join(state.worktree, 'lead-private'); fs.writeFileSync(privateFile, 'fixture-private');
    const profile = path.join(directory, 'profile'); prepareSub2apiProfile(profile, 'deepseek-flash', 'high');
    const toolchain = path.join(process.env.HOME!, '.elan/toolchains/leanprover--lean4---v4.33.0');
    const environment = { PATH: `${toolchain}/bin:${process.env.PATH}`,
      ELAN_HOME: path.join(process.env.HOME!, '.elan'), LEAN_PATH: '', LEAN_SYSROOT: '',
      DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap', DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'missing.env'),
      [SUB2API_PROVIDER.apiKeyEnvironment]: 'offline-synthetic-key', NO_PROXY: '127.0.0.1,localhost' };
    const opened: Parameters<typeof directSolverModules.M1.open>[0][] = [];
    const modules = { ...directSolverModules, M1: { ...directSolverModules.M1,
      open: async (options: Parameters<typeof directSolverModules.M1.open>[0]) => {
        opened.push(options); return createCodexMathSession(options);
      } } };
    const team = new AgentResearchTeam({ state, root, taskText: 'Offline native dispatch fixture.', modules, executable, profile,
      leadAccess: { environment, researchSkill, retrievalRoot: receipt.workspaceRoot }, signal: controller.signal,
      maxAgents: 2, maxTurns: Infinity, maxTurnMs: Infinity, maxTotalTokens: 0, remainingMs: () => Infinity,
      save: () => {}, emit: event => { events.push(event); }, exclusiveCheck: check => check() });
    const functionCall = (id: string, name: string, args: Json, namespace?: string) => ({ type: 'function_call', id, call_id: id,
      name, ...(namespace ? { namespace } : {}), arguments: JSON.stringify(args), status: 'completed' });
    const finalMessage = (id: string, text: string) => ({ type: 'message', id, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }] });
    const quote = (value: string) => "'" + value.replace(/'/gu, "'\\''") + "'";
    const finding = 'The native child verified its isolated fixture workspace.';
    const childFinal = 'The native child completed its independent fixture assignment.';
    const rootFinal = 'The Lead received the child message and native completion.';
    let rootStep = 0, childStep = 0, waitStarted = false;
    const modes = { lead: new Set<string>(), member: new Set<string>() };
    server = createServer(async (request, response) => {
      try {
        if (request.url !== '/v1/responses') throw new Error('unexpected_native_dispatch_route');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
        const requestIndex = requests.length;
        const text = body.input.filter((item: Json) => ['message', 'agent_message'].includes(item.type))
          .flatMap((item: Json) => item.content ?? []).map((part: Json) => part.text ?? part.encrypted_content ?? '').join('\n');
        const host = declaredTools(body).find(tool => tool.name === 'theoremos_team');
        const child = text.includes('NATIVE_ACTUAL_CHILD_FIXTURE');
        const allowed = child ? nativeMemberOperations : nativeLeadOperations;
        expectAdvertisedOperations(host!, allowed, team.tools(child ? 'member' : 'lead').definitions[0]!.inputSchema);
        const mode = effectiveMultiAgentMode(body);
        expect(mode).toBeDefined();
        expect(mode).not.toContain('Any earlier instruction enabling proactive multi-agent delegation no longer applies');
        expect(mode).not.toContain('Do not spawn sub-agents unless');
        expect(body.tool_choice).toBe('auto');
        if (child) {
          expect(mode).toContain('You are a member of an explicitly requested flat team.');
          expect(mode).toContain('Do not spawn sub-agents or dispatch, redirect or interrupt other members.');
          expect(mode).not.toContain('Proactively delegate useful complementary work');
          modes.member.add(mode!);
        } else {
          expect(mode).toContain('You are the Lead of an explicitly requested flat team.');
          expect(mode).toContain('Proactively delegate useful complementary work');
          modes.lead.add(mode!);
        }
        let item: Json;
        if (text.includes('NATIVE_ACTUAL_CHILD_FIXTURE')) {
          const worker = team.archive.workers[0]!;
          if (childStep++ === 0) item = functionCall('child_isolation', 'exec_command', { login: false,
            cmd: 'test "$PWD" = ' + quote(worker.worktree) + ' && test ! -r ' + quote(privateFile) +
              ' && mkdir -p .scratch && printf native-isolation-ok > .scratch/native-receipt.txt && cat .scratch/native-receipt.txt' });
          else if (childStep === 2) {
            await expect.poll(() => waitStarted, { timeout: 10_000 }).toBe(true);
            item = functionCall('child_message', 'send_message', { target: '/root', message: finding }, 'collaboration');
          } else item = finalMessage('child_final', childFinal);
        } else if (rootStep++ === 0) item = functionCall('native_spawn', 'spawn_agent', { task_name: 'expert', fork_turns: 'none',
          message: 'Profiles: researcher\nNATIVE_ACTUAL_CHILD_FIXTURE Inspect the disposable fixture and report the observed isolation result.' }, 'collaboration');
        else if (rootStep === 2) item = functionCall('native_wait', 'wait_agent', { timeout_ms: 10000 }, 'collaboration');
        else if (rootStep === 3) {
          await expect.poll(() => team.hasActiveWorkers, { timeout: 20_000 }).toBe(false);
          // Completion can arrive after this model request started. Finish one
          // native tool boundary before expecting it in the next request's history.
          item = functionCall('native_list', 'list_agents', {}, 'collaboration');
        } else item = finalMessage('root_final', rootFinal);
        fixtureResponse(response, 'resp_native_dispatch_' + requestIndex, [item]);
      } catch (error) { errors.push(error); controller.abort(error); response.writeHead(500); response.end(); }
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const endpoint = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1/responses';
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== SUB2API_PROVIDER.baseUrl + '/responses') throw new Error('unexpected_native_dispatch_upstream');
      return realFetch(endpoint, init);
    });
    try {
      team.beginLeadTurn();
      session = await createCodexMathSession({ executable, profile, workspace: state.worktree, environment,
        model: state.model, effort: state.effort, signal: controller.signal, skills: [researchSkill],
        instructions: agentTeamInstructions({ id: 'lead', role: 'lead' }, 2),
        nativeAgentControl: team.nativeAgentControlOptions(), requestGate: team.leadRequestGate(() => ({ allowed: true, settle: () => {} })),
        onUsage: () => {}, onItem: (phase, item) => {
          if (phase === 'started' && item.id === 'native_wait') waitStarted = true;
        }, tools: team.tools() });
      team.setLeadSession(session);
      expect(await session.run('Run the offline native team fixture.', 'offline-native-dispatch', state.worktree, () => {})).toBe('completed');
      expect(errors).toEqual([]); expect(rootStep).toBe(4); expect(childStep).toBe(3);
      expect(opened).toHaveLength(1); expect(opened[0]!.nativeAgentControl).toBeDefined(); expect(opened[0]!.isolateProcess).toBe(true);
      const worker = team.archive.workers[0]!;
      expect(worker.worktree).not.toBe(state.worktree); expect(worker.native?.agentPath).toBe('/root/expert');
      expect(worker.native?.parentThreadId).toBe(session.threadId); expect(worker.tasks[0]!.status).toBe('completed');
      expect(worker.native?.lastOutcome).toMatchObject({ status: { completed: childFinal } });
      expect([...modes.lead]).toEqual([session.nativeConfiguration!.overrides.multiAgentModeHintText]);
      expect([...modes.member]).toEqual([worker.native!.runtimeConfiguration!.overrides.multiAgentModeHintText]);
      expect(fs.readFileSync(path.join(worker.worktree, '.scratch/native-receipt.txt'), 'utf8')).toBe('native-isolation-ok');
      const history = JSON.stringify(requests.at(-1)!.input);
      expect(history).toContain(finding); expect(history).toContain(childFinal);
      const waitOutput = requests.at(-1)!.input.find((item: Json) => item.type === 'function_call_output' && item.call_id === 'native_wait');
      expect(JSON.stringify(waitOutput?.output)).toContain('Wait completed.');
      expect(requests.every(request => request.tool_choice === 'auto')).toBe(true);
      expect(events.filter(event => event.startsWith('team_coordination') || event === 'team_research_observed')).toEqual([]);
      expect(team.archive.coordination).toBeUndefined();
      expect(requests.flatMap(request => request.input.filter((item: Json) => item.type === 'function_call' && item.name === 'theoremos_team'))).toEqual([]);
      expect(team.archive.deliveries).toHaveLength(0); expect(state.check).toBeUndefined();
      expect(worker.writerStopUnconfirmed).toBeUndefined(); expect(team.hasActiveWorkers).toBe(false);
      expect(session.lastCompletedResponse?.text).toBe(rootFinal); expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
    } finally { controller.abort(); await team.close(); }
  }, 60_000);

  it('checkpoints native continuation after a Lead adoption and resumes the saved thread after writer shutdown', async () => {
    const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';
    fs.mkdirSync(temporaryRoot, { recursive: true });
    directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'agent-team-native-adopt-')));
    const traceFile = path.join(directory, 'trace.jsonl'), launcher = path.join(directory, 'codex-traced');
    const trace = (event: Json) => fs.appendFileSync(traceFile, JSON.stringify(event) + '\n');
    const readTrace = (): Json[] => fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    // Transparent stdin tracing observes real RPC methods without replacing Codex.
    fs.writeFileSync(launcher, '#!' + process.execPath + '\n' + String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const child = spawn(process.env.THEOREMOS_NATIVE_TEST_EXECUTABLE, process.argv.slice(2), { stdio: ['pipe', 'inherit', 'inherit'] });
let pending = '';
process.stdin.on('data', chunk => {
  pending += chunk;
  const lines = pending.split('\n'); pending = lines.pop();
  for (const line of lines) {
    const frame = JSON.parse(line);
    if (frame.method) fs.appendFileSync(process.env.THEOREMOS_NATIVE_TEST_TRACE, JSON.stringify({ event: 'rpc', method: frame.method,
      threadId: frame.params?.threadId }) + '\n');
  }
});
process.stdin.pipe(child.stdin);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => process.exit(1));
child.on('close', code => process.exit(code ?? 0));
`, { mode: 0o700 });
    const requests: Json[] = [], routes: string[] = [], errors: unknown[] = [], prematureCloses: number[] = [];
    const deliveryId = 'a'.repeat(64), finalText = 'The saved Lead thread continued after the adoption checkpoint.';
    const args = { operation: 'adopt', deliveryId };
    const call = { type: 'function_call', id: 'fc_native_adopt', call_id: 'call_native_adopt',
      name: 'theoremos_team', arguments: JSON.stringify(args), status: 'completed' };
    server = createServer(async (request, response) => {
      try {
        routes.push(request.url ?? '');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const index = requests.length;
        response.once('close', () => { if (!response.writableEnded) prematureCloses.push(index); });
        const final = { type: 'message', id: 'msg_native_adopt', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: finalText, annotations: [] }] };
        const item = index === 1 ? call : final;
        const base = { id: 'resp_native_adopt_' + index, object: 'response', created_at: 1,
          model: 'deepseek-flash', status: 'in_progress', output: [] };
        const events: Json[] = [{ type: 'response.created', response: base },
          { type: 'response.output_item.added', output_index: 0, item: index === 1
            ? { ...call, status: 'in_progress', arguments: '' } : { ...final, status: 'in_progress', content: [] } }];
        if (index === 1) events.push(
          { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 0, delta: call.arguments },
          { type: 'response.function_call_arguments.done', item_id: call.id, output_index: 0, arguments: call.arguments });
        else events.push(
          { type: 'response.output_text.delta', item_id: final.id, output_index: 0, content_index: 0, delta: finalText },
          { type: 'response.output_text.done', item_id: final.id, output_index: 0, content_index: 0, text: finalText });
        events.push({ type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { ...base, status: 'completed', output: [item],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12,
              input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 1 } } } });
        trace({ event: 'upstream-terminal', index });
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        response.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''));
      } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const endpoint = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1/responses';
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // Keep the production relay/profile path, but never contact its configured upstream.
      if (url !== SUB2API_PROVIDER.baseUrl + '/responses') throw new Error('unexpected_native_test_upstream');
      return realFetch(endpoint, init);
    });
    const profile = path.join(directory, 'profile');
    prepareSub2apiProfile(profile, 'deepseek-flash', 'high');
    const receipt = bootstrapLeanTask(path.join(directory, 'work'), {
      task: 'Offline adoption scheduling fixture.', source: 'theorem original : True := by sorry\n',
    });
    const state = solverState(readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath), receipt.workspaceRoot,
      { runId: 'offline-native-adopt', phase: 'running', researchMode: 'skill',
        researchDelegation: { mode: 'team', maxAgents: 3 },
        agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control', workers: [], events: [], adoptions: [], operations: [],
          deliveries: [{ id: deliveryId, agentId: 'producer', taskId: 'offline-delivery',
            path: path.join(directory, 'unused-delivery.json') }] } });
    initializeRequestUsageAccounting(state);
    const receipts: ModelRequestReceipt[] = [], hostCalls: Json[] = [], events: Json[] = [];
    const baseGate: ModelRequestGate = identity => {
      const settle = beginRequestUsage(state, identity);
      trace({ event: 'admitted', requestId: identity?.requestId });
      return { allowed: true, settle: value => {
        settle(value); receipts.push(value);
        trace({ event: 'settled', complete: value.complete, outcome: value.outcome });
      } };
    };
    const team = new AgentResearchTeam({ state, root: process.cwd(), taskText: 'Offline adoption scheduling fixture.',
      leadAccess: { environment: {}, retrievalRoot: receipt.workspaceRoot }, modules: directSolverModules,
      executable: launcher, profile, signal: new AbortController().signal, maxAgents: 3, maxTurns: Infinity, maxTurnMs: Infinity,
      maxTotalTokens: 0, remainingMs: () => Infinity, save: () => {},
      emit: (event, details) => events.push({ event, details }), exclusiveCheck: operation => operation() });
    const tools = team.tools(), onUsageIncomplete = vi.fn();
    const open = (threadId?: string) => createCodexMathSession({ executable: launcher, profile, workspace: receipt.workspaceRoot,
      model: 'deepseek-flash', effort: 'high', instructions: 'Offline adoption scheduling fixture.', threadId,
      environment: { PATH: process.env.PATH, [SUB2API_PROVIDER.apiKeyEnvironment]: 'offline-synthetic-key',
        THEOREMOS_NATIVE_TEST_EXECUTABLE: executable, THEOREMOS_NATIVE_TEST_TRACE: traceFile, NO_PROXY: '127.0.0.1,localhost' },
      onUsage: () => {}, onUsageIncomplete, requestGate: team.leadRequestGate(baseGate),
      tools: { definitions: tools.definitions, call: async (name, value, context) => {
        hostCalls.push({ name, arguments: value, threadId: context.threadId });
        return tools.call(name, value, context);
      } } });
    try {
      team.beginLeadTurn();
      session = await open(); team.setLeadSession(session);
      const threadId = session.threadId;
      expect(session.usageSource).toBe('upstream-requests');
      expect(await session.run('Adopt the supplied fixture delivery.', 'native-adopt-first', receipt.workspaceRoot, () => {})).toBe('checkpoint');
      expect(requests).toHaveLength(1);
      expect(hostCalls).toEqual([{ name: 'theoremos_team', arguments: args, threadId }]);
      expect(team.archive.adoptions).toEqual([expect.objectContaining({ deliveryId, targetId: 'lead', status: 'queued' })]);
      expect(events.filter(item => item.event === 'team_adoption_checkpoint')).toHaveLength(1);
      expect(receipts).toEqual([{ complete: true, outcome: 'completed', providerRequestId: 'resp_native_adopt_1',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 4, reasoningOutputTokens: 1 } }]);
      expect(state.requestUsageAccounting).toMatchObject({ startedRequests: 1, reportedRequests: 1, pendingRequests: 0, incomplete: false });
      expect(onUsageIncomplete).not.toHaveBeenCalled();
      expect(prematureCloses).toEqual([]);
      expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
      const firstTrace = readTrace(), interrupt = firstTrace.findIndex(item => item.event === 'rpc' && item.method === 'turn/interrupt');
      expect(firstTrace.filter(item => item.event === 'rpc' && item.method === 'turn/steer')).toEqual([]);
      expect(interrupt).toBeGreaterThan(firstTrace.findIndex(item => item.event === 'settled'));
      expect(requests).toHaveLength(1);

      // This fixture covers scheduling only; Git/Lean integration has its own test.
      team.archive.adoptions[0]!.status = 'completed';
      team.beginLeadTurn();
      session = await open(threadId); team.setLeadSession(session);
      expect(session.threadId).toBe(threadId);
      expect(await session.run('Continue after the fixture adoption checkpoint.', 'native-adopt-resumed', receipt.workspaceRoot, () => {})).toBe('completed');
      expect(session.lastCompletedResponse?.text).toBe(finalText);
      expect(requests).toHaveLength(2); expect(routes).toEqual(['/v1/responses', '/v1/responses']);
      expect(hostCalls).toHaveLength(1); expect(receipts).toHaveLength(2);
      expect(receipts.every(item => item.complete && item.outcome === 'completed')).toBe(true);
      expect(state.requestUsageAccounting).toMatchObject({ startedRequests: 2, reportedRequests: 2, pendingRequests: 0, incomplete: false });
      expect(errors).toEqual([]); expect(prematureCloses).toEqual([]); expect(onUsageIncomplete).not.toHaveBeenCalled();
      expect(readTrace()).toContainEqual({ event: 'rpc', method: 'thread/resume', threadId });
      expect(readTrace().filter(item => item.event === 'rpc' && item.method === 'turn/steer')).toEqual([]);
      expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
    } finally { await team.close(); }
  }, 20_000);
});

describe.skipIf(!nativeAvailable || !process.env.THEOREMOS_TEST_CODEX_EXECUTABLE)('native child decision checkpoints without a model', () => {
  it.each(['submit', 'yield'] as const)('finishes the paid tool group before %s releases the writer', async operation => {
    const [{ readMathAgentSkill }, { prepareResearchSkill, researchSkillIdentity }, { deferred }] = await Promise.all([
      import('../src/runtime/agentSkills'), import('../src/solver/researchSkill'), import('./helpers/async'),
    ]);
    const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';
    fs.mkdirSync(temporaryRoot, { recursive: true });
    directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'agent-team-native-child-')));
    const root = process.cwd(), requests: Json[] = [], errors: unknown[] = [], prematureCloses: number[] = [];
    const releaseTail = deferred();
    let tailRunning = false, tailFinished = false;
    const declarations = [{ file: 'Submission.lean', name: 'Team.reusable', type: '∀ n : Nat, n = n' }];
    const decision = operation === 'submit'
      ? { operation, summary: 'The fixture equality helper is ready.', declarations }
      : { operation, reason: 'The saved fixture draft needs a peer interface.' };
    const toolCalls = [decision, { operation: 'history' }]
      .map((arguments_, index) => ({ type: 'function_call', id: `fc_native_${operation}_${index}`,
        call_id: `call_native_${operation}_${index}`, name: 'theoremos_team',
        arguments: JSON.stringify(arguments_), status: 'completed' }));
    let leadRequests = 0;
    server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const text = body.input.filter((item: Json) => ['message', 'agent_message'].includes(item.type))
          .flatMap((item: Json) => item.content ?? []).map((part: Json) => part.text ?? part.encrypted_content ?? '').join('\n');
        const final = (text: string) => ({ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }] });
        if (!text.includes('NATIVE_CHILD_PAID_TOOLS')) {
          const index = ++leadRequests;
          const spawn = { type: 'function_call', id: 'spawn_child', call_id: 'spawn_child', name: 'spawn_agent',
            namespace: 'collaboration', status: 'completed', arguments: JSON.stringify({ task_name: 'child', fork_turns: 'none',
              message: 'NATIVE_CHILD_PAID_TOOLS Save the fixture handoff.' }) };
          fixtureResponse(response, 'resp_child_fixture_lead_' + index, [index === 1 ? spawn : final('Child dispatched.')]);
          return;
        }
        const index = requests.push(body);
        response.once('close', () => { if (!response.writableEnded) prematureCloses.push(index); });
        fixtureResponse(response, `resp_native_${operation}_${index}`, index === 1 ? toolCalls : [final('Unexpected extra paid continuation.')]);
      } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const endpoint = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1/responses';
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== SUB2API_PROVIDER.baseUrl + '/responses') throw new Error('unexpected_native_child_upstream');
      return realFetch(endpoint, init);
    });
    const profile = path.join(directory, 'profile'); prepareSub2apiProfile(profile, 'deepseek-flash', 'high');
    const original = 'namespace Team\ntheorem original : True := by sorry\nend Team\n';
    const helper = 'theorem reusable (n : Nat) : n = n := by rfl\n';
    const receipt = bootstrapLeanTask(path.join(directory, 'work'), { task: 'Offline native child fixture.', source: original });
    const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
    const identity = researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md')));
    const state = solverState(problem, receipt.workspaceRoot, { runId: `offline-native-${operation}`, phase: 'running',
      environmentDigest: 'e'.repeat(64),
      model: 'deepseek-flash', effort: 'high', researchMode: 'skill', researchSkill: identity,
      researchDelegation: { mode: 'team', maxAgents: 2 },
      agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control', workers: [], events: [],
        deliveries: [], adoptions: [], operations: [] } });
    const researchSkill = prepareResearchSkill(root, state.worktree, identity, problem);
    const toolchain = path.join(process.env.HOME!, '.elan/toolchains/leanprover--lean4---v4.33.0');
    const environment = { PATH: `${toolchain}/bin:${process.env.PATH}`,
      ELAN_HOME: path.join(process.env.HOME!, '.elan'), LEAN_PATH: '', LEAN_SYSROOT: '',
      DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap', DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'missing.env'),
      [SUB2API_PROVIDER.apiKeyEnvironment]: 'offline-synthetic-key', NO_PROXY: '127.0.0.1,localhost' };
    const opened: Parameters<typeof directSolverModules.M1.open>[0][] = [], hostCalls: string[] = [];
    const modules = { ...directSolverModules, M1: { ...directSolverModules.M1,
      open: async (options: Parameters<typeof directSolverModules.M1.open>[0]) => {
        opened.push(options);
        fs.writeFileSync(path.join(options.workspace, problem.projectRelative, 'Submission.lean'),
          original.replace('end Team', helper + 'end Team'));
        session = await createCodexMathSession({ ...options, tools: { definitions: options.tools!.definitions,
          call: async (name, value, context) => {
            const args = value as Json; hostCalls.push(args.operation);
            if (args.operation === 'history') {
              tailRunning = true; await releaseTail.promise;
              fs.writeFileSync(path.join(options.workspace, 'RESEARCH.md'), 'The final paid tool output was preserved.');
              tailFinished = true;
            }
            return options.tools!.call(name, value, context);
          } } });
        return session;
      } } };
    const controller = new AbortController();
    const team = new AgentResearchTeam({ state, root, taskText: 'Offline native child fixture.', modules, executable, profile,
      leadAccess: { environment, researchSkill, retrievalRoot: receipt.workspaceRoot }, signal: controller.signal,
      maxAgents: 2, maxTurns: Infinity, maxTurnMs: Infinity, maxTotalTokens: 0, remainingMs: () => Infinity,
      save: () => {}, emit: () => {}, exclusiveCheck: check => check() });
    const lead = await createCodexMathSession({ executable, profile, workspace: state.worktree, environment,
      model: state.model, effort: state.effort, signal: controller.signal, skills: [researchSkill],
      instructions: 'Dispatch the disposable child fixture.', nativeAgentControl: team.nativeAgentControlOptions(), tools: team.tools(),
      requestGate: team.leadRequestGate(() => ({ allowed: true, settle: () => {} })), onUsage: () => {} });
    try {
      team.setLeadSession(lead);
      expect(await lead.run('Run the isolated child checkpoint fixture.', 'native-child-fixture', state.worktree, () => {})).toBe('completed');
      expect(leadRequests).toBe(2);
      const worker = team.archive.workers[0]!;
      await expect.poll(() => ({ tailRunning, error: worker.error ?? worker.tasks[0]?.error,
        requests: requests.length, opened: opened.length, activity: worker.activity, status: worker.tasks[0]?.status }),
      { timeout: 10_000 }).toEqual({ tailRunning: true, error: undefined, requests: 1, opened: 1, activity: 'running', status: 'running' });
      expect(requests).toHaveLength(1); expect(opened).toHaveLength(1);
      expect(worker.tasks[0]!.status).toBe('running'); expect(worker.tasks[0]!.researchArtifactId).toBeUndefined();
      expect(team.archive.deliveries).toHaveLength(0); expect(tailFinished).toBe(false);
      expect(opened[0]!.signal?.aborted).toBe(false);
      releaseTail.resolve();
      await expect.poll(() => team.hasActiveWorkers, { timeout: 60_000 }).toBe(false);
      expect(tailFinished).toBe(true); expect(requests).toHaveLength(1);
      expect(hostCalls).toEqual([operation, 'history']);
      expect(worker.error).toBeUndefined(); expect(worker.writerStopUnconfirmed).toBeUndefined();
      expect(worker.requestUsageAccounting).toMatchObject({ startedRequests: 1, reportedRequests: 1, pendingRequests: 0, incomplete: false });
      expect(worker.usageAccounting).toMatchObject({ reportedTurns: 1, pending: false, incomplete: false });
      expect(fs.readFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'utf8')).toBe('The final paid tool output was preserved.');
      if (operation === 'submit') {
        expect(worker.tasks[0]).toMatchObject({ status: 'completed', deliveryId: expect.any(String) });
        expect(worker.tasks[0]!.pauseRequested).toBeUndefined(); expect(team.archive.deliveries).toHaveLength(1);
      } else {
        expect(worker.tasks[0]).toMatchObject({ status: 'paused', pauseRequested: { kind: 'handoff' } });
        expect(team.archive.deliveries).toHaveLength(0);
      }
      expect(errors).toEqual([]); expect(prematureCloses).toEqual([]);
      expect(state.tokenBudget?.status).toBe('unlimited'); expect(state.check).toBeUndefined();
    } finally { releaseTail.resolve(); controller.abort(); await lead.close(); await team.close(); }
  }, 90_000);
});
