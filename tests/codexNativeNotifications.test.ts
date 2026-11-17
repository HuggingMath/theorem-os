import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareSub2apiProfile } from '../src/runtime/sub2api';
import { deferred } from './helpers/async';

type Json = Record<string, any>;
const executable = process.env.THEOREMOS_TEST_CODEX_EXECUTABLE ?? 'codex';
const nativeVersion = spawnSync(executable, ['--version'], { env: { PATH: process.env.PATH },
  timeout: 5000, encoding: 'utf8' });
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];

class NativeRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

/** Real app-server protocol; the only provider is the disposable loopback server below. */
class NativeRpc {
  readonly child: ChildProcessWithoutNullStreams;
  readonly notifications: { method: string; params: Json }[] = [];
  readonly requests: { method: string; params: Json }[] = [];
  readonly methods: string[] = [];
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private stderr = '';
  private closed: Promise<void>;
  onRequest: (method: string, params: Json) => Promise<Json> = async method => { throw new Error('unexpected_native_request:' + method); };

  constructor(profile: string) {
    this.child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      env: { PATH: process.env.PATH, CODEX_HOME: profile, THEOREMOS_TEST_KEY: 'offline-synthetic-key',
        NO_PROXY: '127.0.0.1,localhost' }, stdio: 'pipe', detached: true,
    });
    this.closed = new Promise(resolve => this.child.once('close', () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer); entry.reject(new Error('native_fixture_closed:' + this.stderr));
      }
      this.pending.clear(); resolve();
    }));
    this.child.stderr.on('data', bytes => { this.stderr = (this.stderr + String(bytes)).slice(-8000); });
    createInterface({ input: this.child.stdout }).on('line', line => {
      const frame = JSON.parse(line) as Json;
      if (frame.method && frame.id !== undefined) {
        this.requests.push({ method: frame.method, params: frame.params ?? {} });
        void this.onRequest(frame.method, frame.params ?? {}).then(result => this.write({ id: frame.id, result }),
          error => this.write({ id: frame.id, error: { code: -32603, message: String(error) } }));
      } else if (frame.method) this.notifications.push({ method: frame.method, params: frame.params ?? {} });
      else {
        const entry = this.pending.get(frame.id);
        if (!entry) return;
        this.pending.delete(frame.id); clearTimeout(entry.timer);
        if (frame.error) entry.reject(new NativeRpcError(frame.error.code, frame.error.message));
        else entry.resolve(frame.result ?? {});
      }
    });
  }

  private write(frame: Json) { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(frame) + '\n'); }
  request(method: string, params: Json): Promise<Json> {
    const id = ++this.nextId; this.methods.push(method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error('native_fixture_timeout:' + method + ':' + this.stderr));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer }); this.write({ id, method, params });
    });
  }
  async initialize(experimentalApi: boolean) {
    await this.request('initialize', { clientInfo: { name: 'theoremos-native-notice-fixture', version: '0.1.0' },
      capabilities: { experimentalApi } });
    this.write({ method: 'initialized' });
  }
  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try { process.kill(-this.child.pid!, 'SIGTERM'); } catch { /* Disposable process already exited. */ }
    }
    await this.closed;
  }
}

function event(response: ServerResponse, value: Json) {
  response.write('event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n');
}
function message(text: string) {
  return { type: 'message', id: 'msg_' + text.replaceAll(/[^a-z0-9]/giu, '_'), role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
}
const notice = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const inputText = (request: Json) => request.input.filter((item: Json) => item.type === 'message' && item.role === 'user')
  .flatMap((item: Json) => item.content.filter((part: Json) => part.type === 'input_text').map((part: Json) => part.text as string));
const turnStarted = (rpc: NativeRpc) => rpc.notifications.filter(item => item.method === 'turn/started');
const turnCompleted = (rpc: NativeRpc) => rpc.notifications.filter(item => item.method === 'turn/completed');
async function until(predicate: () => boolean) { await expect.poll(predicate, { timeout: 10_000, interval: 10 }).toBe(true); }

async function fixture(experimentalApi = true) {
  const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'codex-native-notifications-')));
  const requests: Json[] = [], routes: string[] = [], errors: unknown[] = [], prematureCloses: number[] = [];
  const responses: { finish: (items: Json[]) => void; finished: boolean }[] = [];
  const server: Server = createServer(async (request, response) => {
    try {
      routes.push(request.url ?? '');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const index = requests.length, base = { id: 'resp_native_notice_' + index, object: 'response', created_at: 1,
        model: 'deepseek-flash', status: 'in_progress', output: [] };
      response.once('close', () => { if (!response.writableEnded) prematureCloses.push(index); });
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      event(response, { type: 'response.created', response: base });
      const stream = { finished: false, finish: (items: Json[]) => {
        if (stream.finished) return; stream.finished = true;
        for (const [output_index, item] of items.entries()) {
          event(response, { type: 'response.output_item.added', output_index, item: item.type === 'function_call'
            ? { ...item, status: 'in_progress', arguments: '' } : { ...item, status: 'in_progress', content: [] } });
          if (item.type === 'function_call') {
            event(response, { type: 'response.function_call_arguments.delta', item_id: item.id, output_index, delta: item.arguments });
            event(response, { type: 'response.function_call_arguments.done', item_id: item.id, output_index, arguments: item.arguments });
          } else {
            event(response, { type: 'response.output_text.delta', item_id: item.id, output_index, content_index: 0, delta: item.content[0].text });
            event(response, { type: 'response.output_text.done', item_id: item.id, output_index, content_index: 0, text: item.content[0].text });
          }
          event(response, { type: 'response.output_item.done', output_index, item });
        }
        event(response, { type: 'response.completed', response: { ...base, status: 'completed', output: items,
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
        response.end();
      } };
      responses.push(stream);
    } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const profile = path.join(directory, 'profile'), workspace = path.join(directory, 'work'); fs.mkdirSync(workspace);
  prepareSub2apiProfile(profile, 'deepseek-flash', 'high');
  const configFile = path.join(profile, 'config.toml'), config = parseToml(fs.readFileSync(configFile, 'utf8')) as Json;
  config.model_provider = 'offline_native_notice_fixture';
  config.model_providers = { offline_native_notice_fixture: { ...config.model_providers.sub2api,
    base_url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1', env_key: 'THEOREMOS_TEST_KEY' } };
  fs.chmodSync(configFile, 0o600); fs.writeFileSync(configFile, stringifyToml(config));
  const rpc = new NativeRpc(profile);
  const result = { rpc, directory, workspace, server, requests, routes, errors, responses, prematureCloses };
  fixtures.push(result); await rpc.initialize(experimentalApi); return result;
}

async function startThread(f: Awaited<ReturnType<typeof fixture>>, dynamicTools = false) {
  const result = await f.rpc.request('thread/start', { model: 'deepseek-flash', modelProvider: 'offline_native_notice_fixture',
    cwd: f.workspace, approvalPolicy: 'never', sandbox: 'read-only',
    baseInstructions: 'Offline native notification transport fixture.', developerInstructions: 'Use only the scripted fixture tools.',
    config: { 'features.apps': false, 'features.plugins': false, 'features.multi_agent': false, 'features.multi_agent_v2': false,
      'features.shell_snapshot': false },
    ...(dynamicTools ? { dynamicTools: ['probe_left', 'probe_right'].map(name => ({ type: 'function', name,
      description: 'Return a disposable fixture marker.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } })) } : {}) });
  expect(result.thread.id).toBeTypeOf('string'); return result.thread.id as string;
}
async function startTurn(f: Awaited<ReturnType<typeof fixture>>, threadId: string, text: string) {
  const result = await f.rpc.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
  return result.turn.id as string;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.rpc.close(); f.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => f.server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

// Audited against rust-v0.169.0: CodexThread::inject_response_items delegates to
// session/inject.rs::inject_client_response_items. Active items enter the existing
// turn's input queue; inactive/finishing items enter history without run_turn.
// These assertions exercise that implementation in the actual installed binary.
describe.skipIf(nativeVersion.status !== 0)('native Codex advisory injection with a local Responses provider', () => {
  it('reports atomic file replacement through fs/changed and stops events after fs/unwatch without model work', async () => {
    const f = await fixture(false), watchId = 'native-atomic-output';
    const file = path.join(f.workspace, 'OUTPUT.json');
    expect(await f.rpc.request('fs/watch', { watchId, path: f.workspace })).toEqual({ path: f.workspace });
    fs.writeFileSync(file + '.tmp', '{"fixture":true}'); fs.renameSync(file + '.tmp', file);
    await until(() => f.rpc.notifications.some(event => event.method === 'fs/changed' && event.params.watchId === watchId &&
      event.params.changedPaths.includes(file)));
    expect(await f.rpc.request('fs/unwatch', { watchId })).toEqual({});
    const events = f.rpc.notifications.filter(event => event.method === 'fs/changed').length;
    fs.writeFileSync(file + '.tmp', '{"fixture":"replaced"}'); fs.renameSync(file + '.tmp', file);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(f.rpc.notifications.filter(event => event.method === 'fs/changed')).toHaveLength(events);
    expect(f.requests).toEqual([]); expect(f.rpc.requests).toEqual([]);
    expect(f.rpc.methods).toEqual(['initialize', 'fs/watch', 'fs/unwatch']);
  });

  it('queues active notices without interrupting a response, retains parallel tool outputs, and keeps one native turn', async () => {
    const f = await fixture(), threadId = await startThread(f, true);
    const releaseLeft = deferred(), releaseRight = deferred();
    const toolCalls: Json[] = [];
    f.rpc.onRequest = async (method, params) => {
      if (method !== 'item/tool/call') throw new Error('unexpected_native_request:' + method);
      toolCalls.push(params); await (params.tool === 'probe_left' ? releaseLeft.promise : releaseRight.promise);
      return { success: true, contentItems: [{ type: 'inputText', text: 'preserved-output-' + params.tool }] };
    };
    try {
      const turnId = await startTurn(f, threadId, 'Exercise advisory notices and both probe tools.');
      await until(() => f.responses.length === 1 && turnStarted(f.rpc).length === 1);
      const activeNotices = ['Team update (advisory): first', 'Team update (advisory): second', 'Team update (advisory): third'];
      await Promise.all([
        f.rpc.request('thread/inject_items', { threadId, items: activeNotices.slice(0, 2).map(notice) }),
        f.rpc.request('thread/inject_items', { threadId, items: [notice(activeNotices[2]!)] }),
      ]);
      await f.rpc.request('thread/read', { threadId });
      expect(f.responses[0]!.finished).toBe(false); expect(f.requests).toHaveLength(1);
      expect(f.prematureCloses).toEqual([]); expect(turnCompleted(f.rpc)).toHaveLength(0);
      expect(turnStarted(f.rpc)).toHaveLength(1);
      f.responses[0]!.finish(['probe_left', 'probe_right'].map((name, index) => ({ type: 'function_call',
        id: 'fc_notice_' + index, call_id: 'call_notice_' + index, name, arguments: '{}', status: 'completed' })));
      // Both calls are outstanding at once; injection must retain the whole output group.
      await until(() => toolCalls.length === 2);
      expect(toolCalls.map(call => call.turnId)).toEqual([turnId, turnId]);
      const duringTools = 'Team update (advisory): arrived while both tools were running';
      await f.rpc.request('thread/inject_items', { threadId, items: [notice(duringTools)] });
      releaseLeft.resolve(); await f.rpc.request('thread/read', { threadId });
      expect(f.requests).toHaveLength(1); expect(turnCompleted(f.rpc)).toHaveLength(0);
      releaseRight.resolve(); await until(() => f.responses.length === 2);
      const text = inputText(f.requests[1]!);
      for (const item of [...activeNotices, duringTools]) expect(text.filter(value => value === item)).toHaveLength(1);
      expect(text.indexOf(activeNotices[0]!)).toBeLessThan(text.indexOf(activeNotices[1]!));
      const outputs = f.requests[1]!.input.filter((item: Json) => item.type === 'function_call_output');
      expect(outputs).toHaveLength(2);
      for (const [index, name] of ['probe_left', 'probe_right'].entries()) expect(outputs).toContainEqual(expect.objectContaining({
        call_id: 'call_notice_' + index, output: expect.anything(),
      }));
      expect(JSON.stringify(outputs)).toContain('preserved-output-probe_left');
      expect(JSON.stringify(outputs)).toContain('preserved-output-probe_right');
      f.responses[1]!.finish([message('The native queued notices and both outputs survived.')]);
      await until(() => turnCompleted(f.rpc).length === 1);
      expect(turnCompleted(f.rpc)[0]!.params.turn).toMatchObject({ id: turnId, status: 'completed' });
      expect(f.rpc.methods.filter(method => method === 'turn/start')).toHaveLength(1);
      expect(f.rpc.methods.filter(method => ['turn/interrupt', 'turn/steer'].includes(method))).toEqual([]);
      expect(turnStarted(f.rpc)).toHaveLength(1); expect(f.requests).toHaveLength(2);
      expect(f.routes).toEqual(['/v1/responses', '/v1/responses']); expect(f.errors).toEqual([]); expect(f.prematureCloses).toEqual([]);
    } finally { releaseLeft.resolve(); releaseRight.resolve(); }
  }, 30_000);

  it.each([false, true])('injects idle history without model work with experimentalApi = %s', async experimentalApi => {
    const f = await fixture(experimentalApi), threadId = await startThread(f);
    const initial = 'Team update (advisory): idle before the first turn';
    await f.rpc.request('thread/inject_items', { threadId, items: [notice(initial)] });
    await f.rpc.request('thread/read', { threadId });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(f.requests).toHaveLength(0); expect(turnStarted(f.rpc)).toHaveLength(0);
    const firstTurn = await startTurn(f, threadId, 'Explicitly start the first fixture turn.');
    await until(() => f.responses.length === 1);
    expect(inputText(f.requests[0]!)).toContain(initial);
    f.responses[0]!.finish([message('First explicit turn completed.')]); await until(() => turnCompleted(f.rpc).length === 1);
    expect(turnCompleted(f.rpc)[0]!.params.turn).toMatchObject({ id: firstTurn, status: 'completed' });
    const settled = 'Team update (advisory): idle after the completed turn';
    await f.rpc.request('thread/inject_items', { threadId, items: [notice(settled)] });
    await f.rpc.request('thread/read', { threadId });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(f.requests).toHaveLength(1); expect(turnStarted(f.rpc)).toHaveLength(1);
    const secondTurn = await startTurn(f, threadId, 'Explicitly continue the same fixture thread.');
    await until(() => f.responses.length === 2);
    expect(inputText(f.requests[1]!)).toContain(initial); expect(inputText(f.requests[1]!)).toContain(settled);
    f.responses[1]!.finish([message('Second explicit turn completed.')]); await until(() => turnCompleted(f.rpc).length === 2);
    expect(turnCompleted(f.rpc)[1]!.params.turn).toMatchObject({ id: secondTurn, status: 'completed' });
    expect(f.rpc.methods.filter(method => ['turn/interrupt', 'turn/steer'].includes(method))).toEqual([]);
    expect(f.routes).toEqual(['/v1/responses', '/v1/responses']); expect(f.errors).toEqual([]); expect(f.prematureCloses).toEqual([]);
  }, 30_000);
});
