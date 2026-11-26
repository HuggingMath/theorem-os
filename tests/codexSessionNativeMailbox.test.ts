import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareWebProviderProfile, webSolverModules } from '../apps/web/worker';
import type { WorkerInput } from '../apps/web/shared';
import { createCodexMathSession } from '../src/runtime/codexSession';
import type { MathAgentSession } from '../src/runtime/agentSession';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import { SUB2API_PROVIDER, prepareSub2apiProfile } from '../src/runtime/sub2api';
import type { ModelRequestReceipt } from '../src/runtime/modelRequest';
import { deferred } from './helpers/async';

type Json = Record<string, any>;
const executable = process.env.THEOREMOS_TEST_CODEX_EXECUTABLE ?? path.resolve('out/codex-backend/codex');
const nativeAvailable = spawnSync(executable, ['--version'], { env: { PATH: process.env.PATH },
  timeout: 5000, stdio: 'ignore' }).status === 0;
const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';

function event(response: ServerResponse, value: Json) {
  response.write('event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n');
}

describe.skipIf(!nativeAvailable)('native AgentControl mailbox through the production Responses relay', () => {
  let directory: string | undefined, server: Server | undefined, session: MathAgentSession | undefined;
  const activeResponses = new Set<ServerResponse>();
  afterEach(async () => {
    await session?.close(); session = undefined;
    for (const response of activeResponses) response.destroy();
    activeResponses.clear();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined; vi.unstubAllGlobals();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it.each(['CLI', 'Web'])('retains a tool and final usage after mail in a %s research session', async client => {
    fs.mkdirSync(temporaryRoot, { recursive: true });
    directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'native-mailbox-relay-')));
    const workspace = path.join(directory, 'work'), profile = path.join(directory, 'profile');
    fs.mkdirSync(workspace);
    const apiKey = 'synthetic-fixture-key';
    const webRequest: WorkerInput = { id: 'fixture', provider: { id: 'sub2api', name: 'Fixture gateway',
      baseUrl: 'http://host.docker.internal:8080/v1' }, input: { apiKey, providerId: 'sub2api', model: 'deepseek-flash', effort: 'high',
      task: 'Offline fixture.', source: '', workers: 1, coordination: 'independent', maxTurns: 0, maxRunSeconds: 0,
      researchMode: 'skill', nativeTeamCapacity: 2 } };
    const web = client === 'Web';
    if (web) prepareWebProviderProfile(profile, webRequest);
    else prepareSub2apiProfile(profile, 'deepseek-flash', 'high');
    const pinnedDirectory = path.join(workspace, '.agents', 'skills', 'pinned-mailbox-fixture');
    fs.mkdirSync(pinnedDirectory, { recursive: true });
    const pinnedFile = path.join(pinnedDirectory, 'SKILL.md');
    const pinnedMarker = 'PINNED_MATH_SKILL_BODY_74fd';
    fs.writeFileSync(pinnedFile, '---\nname: pinned-mailbox-fixture\ndescription: Disposable mathematics transport fixture.\n---\n' + pinnedMarker + '\n');
    const unrelated = path.join(profile, 'runtime', 'skills', 'unrelated-catalog-fixture');
    fs.mkdirSync(unrelated, { recursive: true });
    fs.writeFileSync(path.join(unrelated, 'SKILL.md'), '---\nname: unrelated-catalog-fixture\ndescription: Unrelated disposable catalog entry.\n---\nUNRELATED_BODY\n');

    const requests: Json[] = [], receipts: ModelRequestReceipt[] = [], premature: number[] = [];
    const firstResponse = deferred<{ reasoningDone(): void; finish(): void }>();
    const observedItems: { phase: string; type: unknown; id: unknown }[] = [];
    const errors: unknown[] = [];
    server = createServer(async (request, response) => {
      activeResponses.add(response); response.once('close', () => activeResponses.delete(response));
      try {
        expect(request.headers.authorization).toBe(`Bearer ${apiKey}`);
        const bytes: Buffer[] = []; for await (const chunk of request) bytes.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(bytes).toString('utf8')); requests.push(body);
        const index = requests.length;
        response.once('close', () => { if (!response.writableEnded) premature.push(index); });
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        const base = { id: 'resp_mailbox_' + index, object: 'response', created_at: 1,
          model: 'deepseek-flash', status: 'in_progress', output: [] };
        event(response, { type: 'response.created', response: base });
        const finish = (items: Json[]) => {
          for (const [output_index, item] of items.entries()) {
            if (item.type === 'reasoning') continue;
            event(response, { type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress',
              ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } });
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
        };
        if (index === 1) {
          const reasoning = { type: 'reasoning', id: 'mailbox_reasoning', summary: [{ type: 'summary_text', text: 'Fixture reasoning.' }] };
          event(response, { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, summary: [] } });
          firstResponse.resolve({ reasoningDone: () => event(response, { type: 'response.output_item.done', output_index: 0, item: reasoning }),
            finish: () => finish([reasoning, { type: 'function_call', id: 'write_once', call_id: 'write_once',
              name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf x >> executed-once', login: false, workdir: workspace }), status: 'completed' }]) });
        } else finish([{ type: 'message', id: 'mailbox_done', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Mailbox fixture complete.', annotations: [] }] }]);
      } catch (error) { errors.push(error); response.destroy(); }
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const originalFetch = globalThis.fetch;
    const upstream = (web ? webRequest.provider.baseUrl : SUB2API_PROVIDER.baseUrl) + '/responses';
    // The production relay still parses, admits, streams and accounts for the
    // request. Only its fixed upstream endpoint is redirected to this fixture.
    vi.stubGlobal('fetch', ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== upstream) throw new Error('unexpected_fixture_upstream:' + String(input));
      return originalFetch(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/responses`, init);
    }) as typeof fetch);

    const open = web ? webSolverModules(webRequest).M1.open : createCodexMathSession;
    session = await open({ executable, profile, workspace, model: 'deepseek-flash', effort: 'high',
      instructions: 'Execute the disposable transport fixture. Follow the pinned skill.',
      skills: [readMathAgentSkill(pinnedFile)],
      environment: { PATH: process.env.PATH, ...(!web && { SUB2API_WESTLAKE_API_KEY: apiKey }), NO_PROXY: '127.0.0.1,localhost' },
      requestGate: () => ({ allowed: true, settle: receipt => receipts.push(receipt) }), onUsage: () => {},
      onItem: (phase, item) => { observedItems.push({ phase, type: item.type, id: item.id }); },
      nativeAgentControl: { request: async request => ({ result: request.operation === 'attach'
        ? { sessionId: request.sessionId } : request.operation === 'admitTurn' ? { admitted: true } : {} }) },
    });
    expect(session.usageSource).toBe('upstream-requests');
    const running = session.run('Exercise the mailbox fixture.', 'fixture-turn', workspace, () => {});
    const response = await Promise.race([firstResponse.promise, running.then(status => {
      throw new Error(`fixture ended before its first upstream request (${status}): ${session!.lastError ?? 'no error'}`);
    })]);
    const info = session.nativeAgentControl!.info!;
    await session.nativeAgentControl!.update({ sessionId: info.sessionId, threadId: session.threadId, sequence: 1,
      mailbox: [{ id: 'fixture-mail', author: '/root/peer', recipient: '/root',
        message: { kind: 'plaintext', text: 'ORDINARY_MAILBOX_UPDATE_63b8' } }] });
    response.reasoningDone();
    await expect.poll(() => observedItems, { timeout: 5000 }).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'started', type: 'reasoning' }),
    ]));
    // Keep the tool/usage frames separate from the reasoning boundary so native
    // mailbox preemption has an opportunity to cancel this exact HTTP response.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(premature).toEqual([]);
    response.finish();
    expect(await running).toBe('completed');
    expect(errors).toEqual([]);
    expect(premature).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(fs.readFileSync(path.join(workspace, 'executed-once'), 'utf8')).toBe('x');
    expect(JSON.stringify(requests[1].input)).toContain('ORDINARY_MAILBOX_UPDATE_63b8');
    expect(requests[1].input.some((item: Json) => item.type === 'function_call_output' && item.call_id === 'write_once')).toBe(true);
    expect(receipts).toHaveLength(2);
    expect(receipts.every(receipt => receipt.complete && receipt.usage?.totalTokens === 12)).toBe(true);
    expect(JSON.stringify(requests[0].input)).toContain(pinnedMarker);
    expect(JSON.stringify(requests[0].input)).not.toContain('unrelated-catalog-fixture');

    if (web) {
      const threadId = session.threadId;
      await session.compact!();
      expect(session.threadId).toBe(threadId);
      expect(requests).toHaveLength(3);
      expect(receipts).toHaveLength(3);
      expect(await session.run('Continue after compaction.', 'after-compaction', workspace, () => {})).toBe('completed');
      expect(requests).toHaveLength(4);
    }
  }, 45_000);
});
