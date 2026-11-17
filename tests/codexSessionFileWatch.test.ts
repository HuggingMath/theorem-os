import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexMathSession, type MathAgentOptions, type MathAgentSession } from '../src/runtime/codexSession';
import { nativeFileWatchFixture } from './helpers/nativeFileWatchFixture';

const host = vi.hoisted(() => ({ sandbox: vi.fn() }));
vi.mock('../src/runtime/formalizationSandbox', () => ({ prepareFormalizationSandbox: host.sandbox }));

// The only writer is this disposable stdio peer. Controlled notifications also
// exercise native noop/debounce races without a model or timing-based discovery.
const peer = String.raw`
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const output = process.env.FIXTURE_OUTPUT, root = process.env.FIXTURE_ROOT;
let settings, turn, watch;
fs.writeFileSync(path.join(root, 'pid'), String(process.pid));
const complete = status => send({ method: 'turn/completed', params: { threadId: 'watch-thread', turn: { id: turn, status } } });
const change = command => send({ method: 'fs/changed', params: {
  watchId: command.watchId || watch.watchId,
  changedPaths: command.paths || [path.join(watch.path, path.basename(output))],
} });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const call = JSON.parse(line), params = call.params || {};
  fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(call) + '\n');
  const reply = result => send({ id: call.id, result });
  if (call.method === 'initialize') return reply({});
  if (call.method === 'fs/watch') { watch = params; return; }
  if (call.method === 'thread/start') {
    settings = params;
    return reply({ thread: { id: 'watch-thread' }, model: params.model, modelProvider: params.config.model_provider,
      reasoningEffort: params.config.model_reasoning_effort, approvalPolicy: 'never', activePermissionProfile: { id: 'math-worker' } });
  }
  if (call.method === 'turn/start') {
    turn = params.clientUserMessageId;
    if (params.input[0].text === 'start-error') return send({ id: call.id, error: { code: -32603, message: 'Fixture failure' } });
    if (params.input[0].text === 'early-output') { fs.writeFileSync(output, '{"approved":true}'); change({}); }
    return reply({ turn: { id: turn } });
  }
  if (call.method === 'turn/steer') {
    const command = JSON.parse(params.input[0].text);
    if (command.action === 'change') { change(command); if (command.duplicate) change(command); }
    reply({ turnId: turn });
    if (command.action === 'complete') { fs.writeFileSync(output, '{"approved":true}'); complete('completed'); }
  }
  if (call.method === 'turn/interrupt') {
    if (process.env.FIXTURE_TERMINAL_OUTPUT === 'valid') fs.writeFileSync(output, '{"approved":true}');
    if (process.env.FIXTURE_TERMINAL_OUTPUT === 'changed') fs.writeFileSync(output, '{"approved":false}');
    if (process.env.FIXTURE_TERMINAL_OUTPUT === 'missing') fs.rmSync(output);
    complete('interrupted'); return reply({});
  }
});
`;

describe('native output watch lifecycle', () => {
  let root: string, file: string, options: MathAgentOptions, session: MathAgentSession | undefined;
  const calls = () => fs.existsSync(path.join(root, 'calls.jsonl'))
    ? fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const methods = (method: string) => calls().filter(call => call.method === method);
  const notify = (command: unknown) => session!.notify!(JSON.stringify(command), { waitForRequest: false });
  const validate = vi.fn((value: unknown) => {
    if ((value as { approved?: boolean }).approved !== true) throw new Error('fixture_invalid_output');
  });
  beforeEach(() => {
    const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';
    fs.mkdirSync(temporaryRoot, { recursive: true });
    root = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'codex-file-watch-')));
    file = path.join(root, '.lake', 'OUTPUT.json');
    const executable = path.join(root, 'fake-codex');
    fs.writeFileSync(executable, '#!' + process.execPath + '\n' + nativeFileWatchFixture + peer, { mode: 0o700 });
    options = { executable, profile: root, workspace: root, model: 'fixture-model', effort: 'high',
      instructions: 'Offline file watch fixture.', onUsage: () => {}, completedOutput: { file, validate },
      environment: { PATH: process.env.PATH, FIXTURE_OUTPUT: file, FIXTURE_ROOT: root, FIXTURE_NOOP_WATCH: '1' } };
    validate.mockClear();
    host.sandbox.mockReset().mockResolvedValue({ command: process.execPath, args: [executable],
      profile: root, workspace: '/workspace', providerId: 'web_provider', providerBaseUrl: 'http://127.0.0.1:9/v1',
      receipt: { fixture: 'namespace-mapping-only' }, env: options.environment, close: async () => {} });
  });
  afterEach(async () => {
    await session?.close(); session = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const run = async (message = 'work', id = 'watch-turn') => {
    session ??= await createCodexMathSession(options);
    const started = vi.fn(), running = session.run(message, id, root, started); void running.catch(() => {});
    await expect.poll(() => started.mock.calls.length).toBe(1);
    return { running };
  };

  it('watches a missing output parent before turn/start, discovers atomic rename, and unregisters on completion', async () => {
    options.environment!.FIXTURE_NOOP_WATCH = '0';
    const { running } = await run();
    expect(fs.statSync(path.dirname(file)).isDirectory()).toBe(true);
    fs.writeFileSync(file + '.tmp', '{"approved":true}'); fs.renameSync(file + '.tmp', file);
    expect(await running).toBe('submitted');
    const trace = calls();
    expect(trace.findIndex(call => call.method === 'fs/watch')).toBeLessThan(trace.findIndex(call => call.method === 'turn/start'));
    expect(methods('fs/watch')[0].params.path).toBe(path.dirname(file));
    expect(methods('fs/unwatch').map(call => call.params.watchId)).toEqual(methods('fs/watch').map(call => call.params.watchId));
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('ignores foreign watch IDs and unrelated paths, deduplicates events, and replaces watch IDs for the next turn', async () => {
    const { running } = await run();
    const first = methods('fs/watch')[0].params.watchId;
    fs.writeFileSync(file, '{"approved":true}');
    await notify({ action: 'change', watchId: 'another-watch' });
    await notify({ action: 'change', paths: [file + '.tmp'] });
    expect(validate).not.toHaveBeenCalled(); expect(methods('turn/interrupt')).toEqual([]);
    await notify({ action: 'change', duplicate: true }).catch(() => {});
    expect(await running).toBe('submitted'); expect(validate).toHaveBeenCalledTimes(1);
    fs.rmSync(file); validate.mockClear();
    const next = await run('work', 'next-watch-turn');
    expect(methods('fs/watch')[1].params.watchId).not.toBe(first);
    fs.writeFileSync(file, '{"approved":true}');
    await notify({ action: 'change', watchId: first });
    expect(validate).not.toHaveBeenCalled();
    await notify({ action: 'change' }).catch(() => {});
    expect(await next.running).toBe('submitted');
    expect(methods('fs/unwatch')).toHaveLength(2);
  });

  it('checks early events after binding the acknowledged turn', async () => {
    const { running } = await run('early-output');
    expect(await running).toBe('submitted'); expect(validate).toHaveBeenCalledTimes(1);
  });

  it('discovers a valid terminal output even when native watch registration succeeds without events', async () => {
    const { running } = await run();
    await notify({ action: 'complete' }).catch(() => {});
    expect(await running).toBe('completed');
    expect(validate).toHaveBeenCalledTimes(1); expect(methods('turn/interrupt')).toEqual([]);
    expect(methods('fs/unwatch')).toHaveLength(1);
  });

  it('checks final checkpoint writes before classifying an interrupted turn', async () => {
    options.turnTimeoutMs = 40; options.environment!.FIXTURE_TERMINAL_OUTPUT = 'valid';
    const { running } = await run();
    expect(await running).toBe('submitted'); expect(validate).toHaveBeenCalledTimes(1);
  });

  it.each(['changed', 'missing'])('does not submit when accepted output is %s before the writer stops', async mutation => {
    options.environment!.FIXTURE_TERMINAL_OUTPUT = mutation;
    const { running } = await run();
    fs.writeFileSync(file, '{"approved":true}');
    await notify({ action: 'change' }).catch(() => {});
    expect(await running).toBe('interrupted'); expect(validate).toHaveBeenCalledTimes(1);
    expect(methods('fs/unwatch')).toHaveLength(1);
  });

  it('maps watched paths and events into the formalization namespace while reading the host file', async () => {
    options.readIsolation = { environment: 'standard' };
    const { running } = await run();
    expect(methods('fs/watch')[0].params.path).toBe('/workspace/.lake');
    fs.writeFileSync(file, '{"approved":true}');
    await notify({ action: 'change', paths: [file] });
    expect(validate).not.toHaveBeenCalled();
    await notify({ action: 'change', paths: ['/workspace/.lake/OUTPUT.json'] }).catch(() => {});
    expect(await running).toBe('submitted'); expect(validate).toHaveBeenCalledTimes(1);
  });

  it('closes the watched connection if turn/start fails before binding a writer', async () => {
    session = await createCodexMathSession(options);
    await expect(session.run('start-error', 'broken-start', root, () => {})).rejects.toThrow('math_codex_rpc_failed:-32603:turn/start');
    expect(methods('fs/watch')).toHaveLength(1);
    const pid = Number(fs.readFileSync(path.join(root, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(validate).not.toHaveBeenCalled();
  });

  it('closes the connection when unwatch fails so an abandoned watch cannot survive into a later turn', async () => {
    options.environment!.FIXTURE_UNWATCH_FAILURE = '1';
    const { running } = await run('early-output');
    expect(await running).toBe('submitted');
    const pid = Number(fs.readFileSync(path.join(root, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(session!.run('work', 'after-failed-unwatch', root, () => {})).rejects.toThrow('math_codex_transport_closed');
  });
});
