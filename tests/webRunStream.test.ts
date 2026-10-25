import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createParser } from 'eventsource-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig, type WebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput, WorkerInput, WorkerMessage } from '../apps/web/shared';

const input = (): WebRunInput => ({ providerId: 'openai', apiKey: 'sk-local-stream-fixture', model: 'fixture', effort: 'high',
  source: 'theorem example : True := by sorry', task: 'Local stream fixture', maxTurns: 1,
  maxRunSeconds: 30, workers: 1, coordination: 'cooperative' });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class StreamFixtureRunner implements WebRunner {
  calls: Array<{ input: WorkerInput; send: (message: WorkerMessage) => void; finish: () => void }> = [];
  async readiness() { return { ready: true, message: 'Disposable stream fixture' }; }
  async run(value: WorkerInput, send: (message: WorkerMessage) => void, signal: AbortSignal) {
    await new Promise<void>(resolve => {
      this.calls.push({ input: value, send, finish: () => {
        send({ type: 'result', result: { status: 'incomplete', proof: '', report: {} } }); resolve();
      } });
      signal.addEventListener('abort', () => resolve(), { once: true });
      if (signal.aborted) resolve();
    });
  }
}
type Client = { cookie: string; owner: string };
type RunStream = { response: Response; versions: string[]; comments: string[]; ended: boolean; error?: unknown; stop: () => Promise<void> };

describe('session-owned run notifications over disposable local HTTP streams', () => {
  let root: string, base: string, config: WebConfig, runner: StreamFixtureRunner;
  let service: ReturnType<typeof createWebService>;
  let closed = false;
  const streams: RunStream[] = [];
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-run-stream-'));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    base = `http://127.0.0.1:${port}`;
    config = { ...readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: base }),
      staticRoot: root, concurrency: 2, queueLimit: 4 };
    runner = new StreamFixtureRunner(); service = createWebService(config, runner); closed = false;
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(streams.splice(0).map(stream => stream.stop()));
    vi.useRealTimers();
    if (!closed) await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function session(): Promise<Client> {
    const response = await fetch(base + '/api/session'); await response.json();
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    return { cookie, owner: cookie.slice('theoremos_session='.length) };
  }
  async function open(client: Client): Promise<RunStream> {
    const controller = new AbortController();
    const response = await fetch(base + '/api/runs/stream', { headers: { Cookie: client.cookie }, signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-transform');
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    const stream: RunStream = { response, versions: [], comments: [], ended: false,
      stop: async () => { controller.abort(); await reading; } };
    const parser = createParser({ onEvent: event => {
      expect(event.event).toBe('runs-changed');
      const data = JSON.parse(event.data);
      expect(Object.keys(data)).toEqual(['version']);
      expect(typeof data.version).toBe('string');
      stream.versions.push(data.version);
    }, onComment: comment => stream.comments.push(comment) });
    const reading = (async () => {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          parser.feed(decoder.decode(chunk.value, { stream: true }));
        }
      } catch (error) { if (!controller.signal.aborted) stream.error = error; }
      finally { stream.ended = true; reader.releaseLock(); }
    })();
    streams.push(stream);
    await expect.poll(() => stream.versions.length).toBe(1);
    return stream;
  }
  const create = (client: Client) => service.jobs.create(client.owner, input(), { id: 'openai', name: 'Fixture', baseUrl: '' });
  const list = (client: Client, version?: string) => fetch(base + '/api/runs', {
    headers: { Cookie: client.cookie, ...(version ? { 'If-None-Match': version } : {}) },
  });

  it('authenticates the stream before sending any owner notifications', async () => {
    expect((await fetch(base + '/api/runs/stream')).status).toBe(401);
    const alice = await session();
    expect((await fetch(base + '/api/runs/stream', {
      headers: { Cookie: alice.cookie, Origin: 'https://other.example' },
    })).status).toBe(403);
    const foreignHost = await new Promise<number>((resolve, reject) => {
      http.get(base + '/api/runs/stream', { headers: { Cookie: alice.cookie, Host: 'other.example' } }, response => {
        response.resume(); resolve(response.statusCode!);
      }).on('error', reject);
    });
    expect(foreignHost).toBe(403);
    const stream = await open(alice), response = await list(alice);
    expect(stream.versions).toEqual([response.headers.get('etag')]);
    expect(await response.json()).toEqual({ runs: [] });
  });

  it('sends small owner-specific changes and coalesces synchronous updates before conditional reads', async () => {
    const alice = await session(), bob = await session();
    const aliceStream = await open(alice), bobStream = await open(bob);
    const initial = aliceStream.versions[0], bobInitial = bobStream.versions[0];
    expect(initial).not.toBe(bobInitial);
    const run = create(alice); await tick();
    await expect.poll(() => aliceStream.versions.at(-1)).toBe(service.jobs.version(alice.owner));
    expect(bobStream.versions).toEqual([bobInitial]);
    const before = aliceStream.versions.length;
    runner.calls[0].send({ type: 'progress', event: 'worker_activity', message: 'First local activity' });
    runner.calls[0].send({ type: 'progress', event: 'worker_activity', message: 'Latest local activity' });
    await expect.poll(() => aliceStream.versions.length).toBe(before + 1);
    expect(aliceStream.versions.at(-1)).toBe(service.jobs.version(alice.owner));
    const changed = await list(alice, initial);
    expect(changed.status).toBe(200); expect(changed.headers.get('etag')).toBe(aliceStream.versions.at(-1));
    const body = await changed.json();
    expect(body.runs[0].id).toBe(run.id); expect(body.runs[0].events.at(-1).message).toBe('Latest local activity');
    const unchanged = await list(alice, aliceStream.versions.at(-1));
    expect(unchanged.status).toBe(304); expect(await unchanged.text()).toBe('');
    expect(bobStream.versions).toEqual([bobInitial]);
    expect(aliceStream.error).toBeUndefined(); expect(bobStream.error).toBeUndefined();
  });

  it('notifies removal and forgetting of finished records and stops a detached listener', async () => {
    const alice = await session(), stream = await open(alice), run = create(alice); await tick();
    runner.calls[0].finish(); await tick();
    await expect.poll(() => stream.versions.at(-1)).toBe(service.jobs.version(alice.owner));
    const beforeRemoval = stream.versions.length;
    expect(service.jobs.remove(alice.owner, run.id)).toBe('deleted');
    await expect.poll(() => stream.versions.length).toBe(beforeRemoval + 1);
    expect((await (await list(alice)).json()).runs).toEqual([]);
    const second = create(alice); await tick(); runner.calls[1].finish(); await tick();
    await expect.poll(() => stream.versions.at(-1)).toBe(service.jobs.version(alice.owner));
    const listener = vi.fn(), unsubscribe = service.jobs.subscribe(alice.owner, listener);
    const beforeForget = stream.versions.length;
    service.jobs.forget(alice.owner); await tick();
    await expect.poll(() => stream.versions.length).toBe(beforeForget + 1);
    expect(service.jobs.get(alice.owner, second.id)).toBeUndefined();
    expect(listener).toHaveBeenCalledExactlyOnceWith(service.jobs.version(alice.owner));
    unsubscribe();
    create(alice); await tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps an idle HTTP stream alive without manufacturing run changes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const alice = await session(), stream = await open(alice), initial = stream.versions[0];
    await vi.advanceTimersByTimeAsync(20_000);
    await expect.poll(() => stream.comments).toContain('keep-alive');
    expect(stream.versions).toEqual([initial]); expect(stream.ended).toBe(false);
  });

  it('unsubscribes when the HTTP client disconnects and immediately provides current state on reconnect', async () => {
    const original = service.jobs.subscribe.bind(service.jobs), unsubscribe = vi.fn();
    vi.spyOn(service.jobs, 'subscribe').mockImplementation((owner, listener) => {
      const detach = original(owner, listener);
      return () => { unsubscribe(); detach(); };
    });
    const alice = await session(), stream = await open(alice);
    await stream.stop();
    await expect.poll(() => unsubscribe.mock.calls.length).toBe(1);
    const oldVersion = stream.versions[0]; create(alice); await tick();
    const reconnected = await open(alice);
    expect(reconnected.versions[0]).toBe(service.jobs.version(alice.owner));
    expect(reconnected.versions[0]).not.toBe(oldVersion);
    expect(stream.versions).toEqual([oldVersion]);
  });

  it('ends an expired session stream when session cleanup runs', async () => {
    const alice = await session(), stream = await open(alice); create(alice); await tick();
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + config.sessionTtlMs + 1);
    expect((await list(alice)).status).toBe(401);
    await expect.poll(() => stream.ended).toBe(true);
    expect(service.jobs.list(alice.owner)).toEqual([]); expect(stream.error).toBeUndefined();
  });

  it('ends open streams and shuts down without waiting for clients to disconnect', async () => {
    const alice = await session(), bob = await session(), first = await open(alice), second = await open(bob);
    create(alice); await tick();
    await service.close(); closed = true;
    await expect.poll(() => first.ended && second.ended).toBe(true);
    expect(first.error).toBeUndefined(); expect(second.error).toBeUndefined();
    expect(service.server.listening).toBe(false);
  });
});
