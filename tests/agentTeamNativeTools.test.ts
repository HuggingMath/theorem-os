import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { createCodexMathSession, type MathAgentSession } from '../src/runtime/codexSession';
import { prepareSub2apiProfile } from '../src/runtime/sub2api';
import { AgentResearchTeam } from '../src/solver/agentTeam';
import { directSolverModules } from '../src/solver/modules';
import { readSolverProblem } from '../src/solver/problem';
import { solverState } from './helpers/solver';

type Json = Record<string, any>;
const executable = process.env.THEOREMOS_TEST_CODEX_EXECUTABLE ?? 'codex';
const nativeAvailable = spawnSync(executable, ['--version'], {
  env: { PATH: process.env.PATH }, timeout: 5000, stdio: 'ignore',
}).status === 0;
const operations = ['spawn', 'assign', 'budget', 'resume', 'history', 'publish', 'cancel',
  'message', 'poll', 'wait', 'inspect', 'inspect-research', 'adopt', 'stop'];

let directory: string | undefined, session: MathAgentSession | undefined, server: Server | undefined;
afterEach(async () => {
  await session?.close(); session = undefined;
  if (server) {
    const current = server; server = undefined;
    current.closeAllConnections();
    await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
  }
  if (directory) fs.rmSync(directory, { recursive: true, force: true }); directory = undefined;
});

function declaredTools(request: Json): Json[] {
  const declarations = [...(request.tools ?? []), ...(Array.isArray(request.input)
    ? request.input.filter((item: Json) => item.type === 'additional_tools').flatMap((item: Json) => item.tools) : [])];
  return declarations.flatMap((tool: Json) => tool.type === 'namespace' ? tool.tools : [tool]);
}

// This checks the real native client's wire protocol. The upstream is local and
// scripted, so passing this test says nothing about a model choosing to delegate.
describe.skipIf(!nativeAvailable)('real Codex dynamic team tool transport without a model', () => {
  it('advertises the complete Lead interface upstream and returns a real host operation to the native conversation', async () => {
    const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';
    fs.mkdirSync(temporaryRoot, { recursive: true });
    directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'agent-team-native-tools-')));
    const requests: Json[] = [], routes: string[] = [], errors: unknown[] = [];
    const summary = 'Transport fixture: the host received this advisory publication.';
    const call = { type: 'function_call', id: 'fc_team_probe', call_id: 'call_team_probe',
      name: 'theoremos_team', arguments: JSON.stringify({ operation: 'publish', summary }), status: 'completed' };
    server = createServer(async (request, response) => {
      try {
        routes.push(request.url ?? '');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const index = requests.length;
        const final = { type: 'message', id: 'msg_team_probe', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'The host publication was received.', annotations: [] }] };
        const item = index === 1 ? call : final;
        const base = { id: 'resp_team_probe_' + index, object: 'response', created_at: 1,
          model: 'deepseek-flash', status: 'in_progress', output: [] };
        const events: Json[] = [{ type: 'response.created', response: base },
          { type: 'response.output_item.added', output_index: 0, item: index === 1
            ? { ...call, status: 'in_progress', arguments: '' } : { ...final, status: 'in_progress', content: [] } }];
        if (index === 1) events.push(
          { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 0, delta: call.arguments },
          { type: 'response.function_call_arguments.done', item_id: call.id, output_index: 0, arguments: call.arguments });
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
    const team = new AgentResearchTeam({ state, root: process.cwd(), taskText: 'Offline transport fixture only.',
      leadAccess: { environment: {}, retrievalRoot: receipt.workspaceRoot }, modules: directSolverModules,
      executable, profile, signal: new AbortController().signal, maxAgents: 3, maxTurns: 4, maxTurnMs: 10_000,
      maxTotalTokens: 0, remainingMs: () => 10_000, save: () => {}, emit: () => {}, exclusiveCheck: operation => operation() });
    const tools = team.tools(), hostCalls: { name: string; arguments: unknown; threadId: string; turnId: string }[] = [];
    session = await createCodexMathSession({ executable, profile, workspace: receipt.workspaceRoot,
      model: 'deepseek-flash', effort: 'high', instructions: 'Offline team transport fixture.', turnTimeoutMs: 10_000,
      environment: { PATH: process.env.PATH, THEOREMOS_TEST_KEY: 'offline-synthetic-key', NO_PROXY: '127.0.0.1,localhost' },
      onUsage: () => {}, tools: { definitions: tools.definitions, call: async (name, args, context) => {
        hostCalls.push({ name, arguments: args, threadId: context.threadId, turnId: context.turnId });
        return tools.call(name, args, context);
      } } });
    expect(await session.run('Exercise the local team interface.', 'offline-native-tools', receipt.workspaceRoot, () => {})).toBe('completed');
    expect(errors).toEqual([]); expect(routes).toEqual(['/v1/responses', '/v1/responses']);
    expect(requests).toHaveLength(2);
    const advertised = declaredTools(requests[0]).find(tool => tool.name === 'theoremos_team');
    // Codex normalizes provider schemas (for example, omitting numeric bounds).
    // Capability names, required arguments and the host round trip are the contract.
    expect(advertised?.parameters).toMatchObject({ type: 'object', required: ['operation'], additionalProperties: false,
      properties: { operation: { type: 'string' }, agentId: { type: 'string' }, message: { type: 'string' },
        budget: { type: 'object', properties: { tokens: { type: 'integer' }, turns: { type: 'integer' } } } } });
    expect(advertised?.parameters.properties.operation.enum).toEqual(operations);
    expect(hostCalls).toEqual([{ name: 'theoremos_team', arguments: { operation: 'publish', summary },
      threadId: session.threadId, turnId: expect.any(String) }]);
    expect(state.agentTeam!.researchState).toMatchObject({ revision: 1, summary });
    const returned = requests[1].input.find((item: Json) => item.type === 'function_call_output' && item.call_id === call.call_id);
    expect(JSON.stringify(returned?.output)).toContain(summary);
    expect(session.lastCompletedResponse?.text).toBe('The host publication was received.');
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  }, 20_000);
});
