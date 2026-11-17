import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareSub2apiProfile } from '../src/runtime/sub2api';

type Json = Record<string, any>;
const executable = process.env.THEOREMOS_TEST_CODEX_EXECUTABLE ?? 'codex';
const version = spawnSync(executable, ['--version'], {
  env: { PATH: process.env.PATH }, timeout: 5000, encoding: 'utf8',
});
const nativeAvailable = version.status === 0;
let directory: string | undefined, child: ChildProcessWithoutNullStreams | undefined, server: Server | undefined;

afterEach(async () => {
  if (child) {
    const current = child; child = undefined;
    if (current.exitCode === null && current.signalCode === null) {
      const closed = new Promise<void>(resolve => current.once('close', () => resolve()));
      current.kill('SIGKILL');
      await closed;
    }
  }
  if (server) {
    const current = server; server = undefined;
    current.closeAllConnections();
    await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
  }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

// Uses the nativeTools fixture's disposable provider and scripted Responses SSE,
// but talks directly to app-server: no codexSession, rollout reader, or host steer.
describe.skipIf(!nativeAvailable)(`native shell feedback (${version.stdout?.trim() ?? 'unavailable'}) without a model`, () => {
  it.each([
    { name: 'login', invalid: { login: true },
      rejection: 'login shell is disabled by config; omit `login` or set it to false.' },
    { name: 'justification', invalid: { login: false, justification: 'Invalid without sandbox_permissions.' },
      rejection: '`justification` requires an explicit `sandbox_permissions`; use `sandbox_permissions: "require_escalated"` for unsandboxed execution, or omit `justification`.' },
  ])('returns $name argument refusal in the next native request, then executes the corrected call once', async ({ name, invalid, rejection }) => {
    const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';
    fs.mkdirSync(temporaryRoot, { recursive: true });
    directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'codex-native-shell-feedback-')));
    const workspace = path.join(directory, 'work'); fs.mkdirSync(workspace);
    const marker = path.join(workspace, 'executed.txt'), output = 'native-shell-feedback-ok';
    const command = "printf '%s\\n' 'native-shell-feedback-ok' >> executed.txt\ncat executed.txt";
    const requests: Json[] = [], routes: string[] = [], errors: unknown[] = [];
    const markerBeforeRequest: (string | undefined)[] = [];
    const refusedCall = { type: 'function_call', id: 'fc_refused_' + name, call_id: 'call_refused_' + name,
      name: 'exec_command', arguments: JSON.stringify({ cmd: command, ...invalid }), status: 'completed' };
    const correctedCall = { type: 'function_call', id: 'fc_corrected_' + name, call_id: 'call_corrected_' + name,
      name: 'exec_command', arguments: JSON.stringify({ cmd: command, login: false }), status: 'completed' };
    const finalText = 'The corrected native shell call executed once.';
    const final = { type: 'message', id: 'msg_shell_feedback_' + name, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: finalText, annotations: [] }] };
    server = createServer(async (request, response) => {
      try {
        routes.push(request.url ?? '');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        markerBeforeRequest.push(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : undefined);
        const index = requests.length;
        if (index > 3) throw new Error('Unexpected extra native model request.');
        const item: Json = index === 1 ? refusedCall : index === 2 ? correctedCall : final;
        const base = { id: 'resp_shell_feedback_' + name + '_' + index, object: 'response', created_at: 1,
          model: 'deepseek-flash', status: 'in_progress', output: [] };
        const events: Json[] = [{ type: 'response.created', response: base },
          { type: 'response.output_item.added', output_index: 0, item: index < 3
            ? { ...item, status: 'in_progress', arguments: '' } : { ...final, status: 'in_progress', content: [] } }];
        if (index < 3) events.push(
          { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
          { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments });
        else events.push(
          { type: 'response.output_text.delta', item_id: final.id, output_index: 0, content_index: 0, delta: finalText },
          { type: 'response.output_text.done', item_id: final.id, output_index: 0, content_index: 0, text: finalText });
        events.push({ type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { ...base, status: 'completed', output: [item],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        response.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''));
      } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const profile = path.join(directory, 'profile');
    prepareSub2apiProfile(profile, 'deepseek-flash', 'high');
    const configFile = path.join(profile, 'config.toml'), config = parseToml(fs.readFileSync(configFile, 'utf8')) as Json;
    config.model_provider = 'offline_native_shell_fixture';
    config.model_providers = { offline_native_shell_fixture: { ...config.model_providers.sub2api,
      base_url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1', env_key: 'THEOREMOS_TEST_KEY' } };
    config.allow_login_shell = false;
    config.features = { ...config.features, apps: false, plugins: false, shell_snapshot: false };
    config.shell_environment_policy = { inherit: 'all', exclude: ['THEOREMOS_TEST_KEY'] };
    fs.chmodSync(configFile, 0o600); fs.writeFileSync(configFile, stringifyToml(config));

    child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      cwd: workspace, env: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: profile, SHELL: '/bin/bash',
        THEOREMOS_TEST_KEY: 'offline-synthetic-key', NO_PROXY: '127.0.0.1,localhost' }, stdio: 'pipe',
    });
    let stderr = '', nextId = 0;
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const frames: Json[] = [], sentMethods: string[] = [];
    const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
    const fail = (error: Error) => { for (const call of pending.values()) call.reject(error); pending.clear(); };
    child.once('error', fail);
    child.once('exit', code => fail(new Error('Native app-server exited: ' + code + '\n' + stderr)));
    createInterface({ input: child.stdout }).on('line', line => {
      const frame = JSON.parse(line) as Json; frames.push(frame);
      if (frame.id === undefined) return;
      const call = pending.get(frame.id);
      if (!call) return;
      pending.delete(frame.id);
      if (frame.error) call.reject(new Error(JSON.stringify(frame.error)));
      else call.resolve(frame.result);
    });
    const rpc = (method: string, params: Json): Promise<Json> => {
      sentMethods.push(method);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child!.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    };
    await rpc('initialize', { clientInfo: { name: 'theoremos_offline_shell_fixture', version: '1.0.0' },
      capabilities: { experimentalApi: true } });
    sentMethods.push('initialized'); child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const started = await rpc('thread/start', { model: 'deepseek-flash', cwd: workspace, approvalPolicy: 'never',
      sandbox: 'danger-full-access', ephemeral: true,
      developerInstructions: 'For shell commands set login:false and omit justification and sandbox_permissions.' });
    // This native session has no persisted rollout for a host reader to inspect.
    expect(started.thread.path).toBeNull();
    const turn = await rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text',
      text: 'Exercise the offline native shell fixture.', text_elements: [] }] });
    await expect.poll(() => frames.find(frame => frame.method === 'turn/completed'
      && frame.params.threadId === started.thread.id && frame.params.turn.id === turn.turn.id), { timeout: 10_000 }).toBeDefined();
    const completed = frames.find(frame => frame.method === 'turn/completed' && frame.params.turn.id === turn.turn.id)!;
    expect(completed.params.turn.status, JSON.stringify(completed)).toBe('completed');
    expect(errors).toEqual([]);
    expect(routes).toEqual(['/v1/responses', '/v1/responses', '/v1/responses']);
    const returned = (request: Json, callId: string) => request.input.find((item: Json) => item.type === 'function_call_output' && item.call_id === callId);
    expect(returned(requests[1], refusedCall.call_id)?.output).toBe(rejection);
    expect(JSON.stringify(returned(requests[2], correctedCall.call_id)?.output)).toContain(output);
    expect(markerBeforeRequest).toEqual([undefined, undefined, output + '\n']);
    expect(fs.readFileSync(marker, 'utf8')).toBe(output + '\n');
    const commands = frames.filter(frame => frame.method === 'item/completed' && frame.params.item.type === 'commandExecution');
    expect(commands).toHaveLength(1);
    expect(commands[0].params.item).toMatchObject({ exitCode: 0 });
    expect(frames.filter(frame => frame.method === 'item/completed' && frame.params.item.type === 'agentMessage')
      .at(-1)?.params.item.text).toBe(finalText);
    // The complete host-to-Codex method list has no correction or shell replay.
    expect(sentMethods).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    for (const request of requests.slice(1))
      expect(request.input.filter((item: Json) => item.role === 'user'))
        .toEqual(requests[0].input.filter((item: Json) => item.role === 'user'));
  }, 20_000);
});
