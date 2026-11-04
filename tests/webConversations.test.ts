import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebConversations, webConversationInstructions } from '../apps/web/conversations';
import type { WebConversation } from '../apps/web/conversationTypes';
import { WebExplainError, type WebExplainCall } from '../apps/web/explain';
import { WebStorage } from '../apps/web/storage';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { WebFormalization } from '../apps/web/formalizationTypes';
import type { WebRun, WebSession } from '../apps/web/shared';
import { createWebService } from '../apps/web/server';
import { readWebConfig, webDefaults } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import type { WebCommandResult, WebGuidanceInput } from '../apps/web/collaboration';

const tick = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const key = 'sk-disposable-conversation-test';
const call = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: key, model: 'fixture' };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); } finally { vi.useRealTimers(); } });
function fixture(storage = new WebStorage(), answer?: ConstructorParameters<typeof WebConversations>[2]) {
  const run: WebRun = { ...webDefaults, id: crypto.randomUUID(), title: 'Original problem', status: 'running', phase: 'solving',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), providerId: 'fixture',
    source: 'theorem example : True := by sorry', task: 'Prove the original theorem', events: [] };
  const formalization: WebFormalization = { id: crypto.randomUUID(), original: '证明原题，保留全部假设。',
    environment: 'standard', model: 'fixture', effort: 'max', status: 'running', createdAt: run.createdAt, updatedAt: run.updatedAt };
  const calls: WebExplainCall[] = [];
  const receipts = new Map<string, WebCommandResult>();
  const resources = { run: (owner: string, id: string) => owner === 'alice' && id === run.id ? run : undefined,
    formalization: (owner: string, id: string) => owner === 'alice' && id === formalization.id ? formalization : undefined,
    commandReceipt: (owner: string, runId: string, id: string) => owner === 'alice' && runId === run.id ? receipts.get(id) : undefined };
  const service = new WebConversations(storage, resources, answer ?? (async (_owner, input) => { calls.push(input); return { answer: '从假设 A 使用引理 B。' }; }));
  return { service, run, formalization, calls, resources, storage, receipts };
}
const storedConversation = (storage: WebStorage, id: string) => storage.getRecord<WebConversation>(['owners', mathDigest('alice'), 'conversations', id + '.json'])!;
const guidanceInput = (): WebGuidanceInput => ({ id: 'chat-guidance-1', recipient: { kind: 'task', id: 'lemma-bridge' },
  taskRef: { id: 'lemma-bridge', version: 'bridge-v3' }, text: '  请先使用交换律。\n保留原来的假设。  ',
  observationRef: { sequence: 3, stateDigest: mathDigest('recorded-guidance-observation') } });

describe('streaming conversation persistence', () => {
  it('persists onText before completion, coalesces updates, and saves the final answer and truncation state', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let input!: WebExplainCall, finish!: (answer: { answer: string; truncated?: true }) => void;
    const { service, run, storage } = fixture(undefined, (_owner, request) => {
      input = request; return new Promise(resolve => { finish = resolve; });
    });
    cleanups.push(() => { finish?.({ answer: 'cleanup' }); return service.close(); });
    const conversation = service.create('alice', { runId: run.id });
    service.send('alice', conversation.id, '逐步解释', call); await tick();
    expect(input.onText).toBeTypeOf('function');
    input.onText!('先使用引理');
    expect(storedConversation(storage, conversation.id).messages.at(-1)).toMatchObject({ text: '先使用引理', status: 'pending' });
    input.onText!('先使用引理，再检查目标。');
    expect(storedConversation(storage, conversation.id).messages.at(-1)?.text).toBe('先使用引理');
    await vi.advanceTimersByTimeAsync(250);
    expect(storedConversation(storage, conversation.id).messages.at(-1)).toMatchObject({ text: '先使用引理，再检查目标。', status: 'pending' });
    finish({ answer: '先使用引理，再检查目标。仍需独立验收。', truncated: true }); await tick();
    expect(storedConversation(storage, conversation.id).messages.at(-1)).toMatchObject({ status: 'complete', text: '先使用引理，再检查目标。仍需独立验收。', truncated: true });
  });

  it('stop flushes the latest buffered text and ignores late text and completion', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let input!: WebExplainCall, finish!: (answer: { answer: string }) => void;
    const { service, run, storage } = fixture(undefined, (_owner, request) => {
      input = request; return new Promise(resolve => { finish = resolve; });
    });
    cleanups.push(() => { finish?.({ answer: 'cleanup' }); return service.close(); });
    const conversation = service.create('alice', { runId: run.id });
    service.send('alice', conversation.id, '解释到这里', call); await tick();
    input.onText!('已保存部分'); input.onText!('已保存部分与最后一段');
    expect(storedConversation(storage, conversation.id).messages.at(-1)?.text).toBe('已保存部分');
    expect(service.stop('alice', conversation.id).messages.at(-1)).toMatchObject({ status: 'interrupted', text: '已保存部分与最后一段' });
    input.onText!('停止后到达的内容'); finish({ answer: '停止后到达的完整回答' });
    await tick(); await vi.advanceTimersByTimeAsync(250);
    expect(storedConversation(storage, conversation.id).messages.at(-1)).toMatchObject({ status: 'interrupted', text: '已保存部分与最后一段' });
    expect(run.status).toBe('running');
  });

  it.each(['failure', 'restart'] as const)('retains partial output after %s without treating it as completed history', async mode => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-conversation-stream-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    let input!: WebExplainCall, finish!: (answer: { answer: string }) => void, fail!: (error: Error) => void;
    const { service, run, resources } = fixture(new WebStorage(root), (_owner, request) => {
      input = request; return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    });
    cleanups.push(() => { finish?.({ answer: 'cleanup' }); return service.close(); });
    const conversation = service.create('alice', { runId: run.id });
    service.send('alice', conversation.id, '解释证明', call); await tick();
    input.onText!('唯一的部分输出'); input.onText!('唯一的部分输出，尚未完成');
    if (mode === 'failure') { fail(new WebExplainError(502, '模拟连接失败')); await tick(); }
    else await vi.advanceTimersByTimeAsync(250);
    let retryInput: WebExplainCall | undefined;
    const restarted = new WebConversations(new WebStorage(root), resources, async (_owner, request) => { retryInput = request; return { answer: '新的回答' }; });
    cleanups.push(() => restarted.close());
    expect(restarted.read('alice', conversation.id).messages.at(-1)).toMatchObject({
      text: '唯一的部分输出，尚未完成', status: mode === 'failure' ? 'error' : 'interrupted',
      error: expect.stringContaining(mode === 'failure' ? '模拟连接失败' : '服务重启'),
    });
    input.onText!('旧进程迟到的内容'); finish({ answer: '旧进程迟到的完成' }); await tick();
    expect(storedConversation(new WebStorage(root), conversation.id).messages.at(-1)?.text).toBe('唯一的部分输出，尚未完成');
    restarted.send('alice', conversation.id, '重新解释', call); await tick();
    expect(JSON.stringify(retryInput?.input)).not.toContain('唯一的部分输出');
    expect(restarted.read('alice', conversation.id).messages.at(-1)).toMatchObject({ status: 'complete', text: '新的回答' });
  });
});

describe('conversation guidance persists the original command and its real receipt', () => {
  it('saves the exact payload before sending, persists its receipt, and rejects another owner or changed content under the same ID', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-conversation-guidance-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const { service, run, storage, resources } = fixture(new WebStorage(root));
    const conversation = service.create('alice', { runId: run.id }), input = guidanceInput();
    let finish!: (receipt: WebCommandResult) => void;
    const send = vi.fn((_runId: string, _input: WebGuidanceInput) => new Promise<WebCommandResult>(resolve => { finish = resolve; }));
    const pending = service.guide('alice', conversation.id, input, send);
    expect(send).toHaveBeenCalledExactlyOnceWith(run.id, input);
    expect(storedConversation(storage, conversation.id).messages.at(-1)).toMatchObject({ kind: 'guidance', role: 'user', status: 'pending', text: input.text, guidance: { runId: run.id, input } });
    await expect(service.guide('bob', conversation.id, input, send)).rejects.toThrow('不存在');
    await expect(service.guide('alice', conversation.id, { ...input, text: '替换内容' }, send)).rejects.toThrow('命令 ID 已用于另一份内容');
    expect(send).toHaveBeenCalledTimes(1);
    finish({ id: input.id, status: 'queued' }); await pending;
    const restarted = new WebConversations(new WebStorage(root), resources, async () => ({ answer: 'unused' }));
    const saved = restarted.read('alice', conversation.id).messages.at(-1)!;
    expect(saved).toMatchObject({ status: 'complete', text: input.text, guidance: { runId: run.id, input, receipt: { id: input.id, status: 'queued' } } });
    expect(saved.guidance?.input).toEqual(input);
    expect(() => restarted.read('bob', conversation.id)).toThrow('不存在');
    const again = await restarted.guide('alice', conversation.id, structuredClone(input), async () => ({ id: input.id, status: 'queued' }));
    expect(again.messages.filter(message => message.kind === 'guidance')).toHaveLength(1);
    expect(again.messages.at(-1)?.id).toBe(saved.id);
  });

  it('refreshes an unknown receipt to delivered after restart and keeps its recorded recipients', async () => {
    const { service, run, storage, resources, receipts } = fixture();
    const conversation = service.create('alice', { runId: run.id }), input = guidanceInput();
    await service.guide('alice', conversation.id, input, async () => ({ id: input.id, status: 'unknown', reason: '等待运行时回执' }));
    const restarted = new WebConversations(storage, resources, async () => ({ answer: 'unused' }));
    expect(restarted.read('alice', conversation.id).messages.at(-1)).toMatchObject({ kind: 'guidance', status: 'pending', guidance: { receipt: { status: 'unknown' } } });
    expect(restarted.list('alice')[0]?.answering).toBe(false);
    const at = new Date().toISOString();
    receipts.set(input.id, { id: input.id, status: 'queued', guidance: { ...input, status: 'delivered', createdAt: at, updatedAt: at, deliveredTo: ['engineer-2'] } });
    expect(restarted.read('alice', conversation.id).messages.at(-1)).toMatchObject({ status: 'complete', guidance: { input, receipt: { id: input.id, status: 'delivered', deliveredTo: ['engineer-2'] } } });
    expect(storedConversation(storage, conversation.id).messages.at(-1)?.guidance?.receipt?.status).toBe('delivered');
    receipts.set(input.id, { id: input.id, status: 'unknown' });
    expect(restarted.read('alice', conversation.id).messages.at(-1)?.guidance?.receipt?.status).toBe('delivered');
  });

  it('stopping an answer preserves pending guidance and lets its eventual receipt settle', async () => {
    const { service, run, receipts } = fixture(undefined, (_owner, _input, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new WebExplainError(499, '已停止')), { once: true });
    }));
    const conversation = service.create('alice', { runId: run.id }), input = guidanceInput();
    service.send('alice', conversation.id, '请解释现有进展', call); await tick();
    await service.guide('alice', conversation.id, input, async () => ({ id: input.id, status: 'unknown' }));
    const stopped = service.stop('alice', conversation.id); await tick();
    expect(stopped.messages.find(message => message.role === 'assistant' && message.kind === 'text')?.status).toBe('interrupted');
    expect(stopped.messages.at(-1)).toMatchObject({ kind: 'guidance', status: 'pending', guidance: { input, receipt: { status: 'unknown' } } });
    receipts.set(input.id, { id: input.id, status: 'delivered' });
    expect(service.read('alice', conversation.id).messages.at(-1)).toMatchObject({ kind: 'guidance', status: 'complete', guidance: { input, receipt: { status: 'delivered' } } });
    expect(run.status).toBe('running');
  });
});

describe('persistent conversations use saved owned task context', () => {
  it('associates owned resources idempotently and follows the formalization into its run', () => {
    const { service, run, formalization } = fixture();
    const created = service.create('alice', { formalizationId: formalization.id });
    expect(created.messages.map(message => message.kind)).toEqual(['text', 'task']);
    expect(created.messages[0]?.text).toBe(formalization.original);
    expect(created.runId).toBeUndefined();
    expect(() => service.create('bob', { formalizationId: formalization.id })).toThrow('不存在');
    expect(() => service.read('bob', created.id)).toThrow('不存在');
    expect(service.list('bob')).toEqual([]);
    formalization.runId = run.id; run.formalizationId = formalization.id;
    expect(service.read('alice', created.id).runId).toBe(run.id);
    expect(service.create('alice', { runId: run.id }).id).toBe(created.id);
    expect(service.list('alice')).toHaveLength(1);
    expect(() => service.create('alice', { formalizationId: crypto.randomUUID(), runId: run.id })).toThrow('不存在');
  });

  it('retains history across restart and supplies original, previous answer and current evidence to follow-ups', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-conversations-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const { service, run, calls, resources } = fixture(new WebStorage(root));
    const created = service.create('alice', { runId: run.id });
    expect(service.send('alice', created.id, '为什么需要引理 B？', call).messages.at(-1)?.status).toBe('pending');
    await tick();
    expect(service.read('alice', created.id).messages.at(-1)?.status).toBe('complete');
    const restarted = new WebConversations(new WebStorage(root), resources, async (_owner, input) => { calls.push(input); return { answer: '因为前面假设 A。' }; });
    run.status = 'completed'; run.result = { status: 'evaluated_passed', proof: 'theorem example : True := by trivial', report: { accepted: true } };
    restarted.send('alice', created.id, '你刚才提到的假设是什么？', call); await tick();
    expect(calls[1]?.instructions).toBe(webConversationInstructions);
    const input = JSON.stringify(calls[1]?.input);
    for (const text of [run.source, run.result.proof, '为什么需要引理 B？', '从假设 A 使用引理 B。', '你刚才提到的假设是什么？', 'accepted']) expect(input).toContain(text);
    expect(restarted.read('alice', created.id).messages).toHaveLength(6);
    expect(JSON.stringify(new WebStorage(root).getRecord(['owners', mathDigest('alice'), 'conversations', `${created.id}.json`]))).not.toContain(key);
  });

  it('persists failure and supports retry without using failed attempts as completed history', async () => {
    let attempt = 0;
    const inputs: unknown[][] = [];
    const { service, run } = fixture(undefined, async (_owner, input) => {
      inputs.push(input.input);
      if (!attempt++) throw new WebExplainError(502, '模型服务没有给出回答。');
      return { answer: '重新回答。' };
    });
    const created = service.create('alice', { runId: run.id });
    service.send('alice', created.id, '解释一下', call); await tick();
    expect(service.read('alice', created.id).messages.at(-1)).toMatchObject({ status: 'error', error: '模型服务没有给出回答。' });
    service.send('alice', created.id, '解释一下', call); await tick();
    expect(service.read('alice', created.id).messages.at(-1)).toMatchObject({ status: 'complete', text: '重新回答。' });
    expect(inputs[1]).toHaveLength(1);
  });

  it('keeps conversation history when its run and formalization have been deleted', () => {
    const { service, run, formalization, resources } = fixture();
    run.formalizationId = formalization.id; formalization.runId = run.id;
    const created = service.create('alice', { formalizationId: formalization.id });
    resources.run = () => undefined;
    resources.formalization = () => undefined;
    expect(service.read('alice', created.id).messages).toEqual(created.messages);
    expect(service.list('alice')[0]?.id).toBe(created.id);
  });

  it('merges a late answer without reverting a newly associated run', async () => {
    let finish!: (value: { answer: string }) => void;
    const { service, run, formalization, storage } = fixture(undefined, () => new Promise(resolve => { finish = resolve; }));
    const created = service.create('alice', { formalizationId: formalization.id });
    service.send('alice', created.id, '进展怎么样？', call); await tick();
    formalization.runId = run.id; run.formalizationId = formalization.id;
    expect(service.read('alice', created.id).runId).toBe(run.id);
    finish({ answer: '依据记录说明当前进展。' }); await tick();
    // Inspect storage directly: another read would otherwise mask a reverted association by repairing it.
    const saved = storage.getRecord<WebConversation>(['owners', mathDigest('alice'), 'conversations', `${created.id}.json`]);
    expect(saved?.runId).toBe(run.id);
    expect(saved?.messages.at(-1)?.text).toBe('依据记录说明当前进展。');
  });

  it('accepts the next question immediately after stop without an old completion overwriting either message', async () => {
    const replies: ((value: { answer: string }) => void)[] = [];
    const { service, run } = fixture(undefined, () => new Promise(resolve => replies.push(resolve)));
    const created = service.create('alice', { runId: run.id });
    service.send('alice', created.id, '旧问题', call); await tick();
    service.stop('alice', created.id);
    expect(service.send('alice', created.id, '新的问题', call).messages.at(-1)?.status).toBe('pending');
    expect(replies).toHaveLength(1);
    replies[0]!({ answer: '迟到的旧回答' }); await tick();
    expect(replies).toHaveLength(2);
    replies[1]!({ answer: '新回答' }); await tick();
    const saved = service.read('alice', created.id);
    expect(saved.messages).toHaveLength(6);
    expect(saved.messages[3]).toMatchObject({ status: 'interrupted', text: '' });
    expect(saved.messages.at(-1)).toMatchObject({ status: 'complete', text: '新回答' });
    expect(run.status).toBe('running');
  });

  it('stops only the answer, marks interrupted records on restart and prevents owner deletion from resurrecting history', async () => {
    const { service, run, storage, resources } = fixture(undefined, (_owner, _input, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new WebExplainError(499, '已停止。')), { once: true });
    }));
    const created = service.create('alice', { runId: run.id });
    service.send('alice', created.id, '等一等', call);
    expect(() => service.send('alice', created.id, '另一个问题', call)).toThrow('上一个问题');
    expect(service.stop('alice', created.id).messages.at(-1)?.status).toBe('interrupted');
    await tick();
    expect(service.read('alice', created.id).messages.at(-1)?.status).toBe('interrupted');
    expect(run.status).toBe('running');
    service.send('alice', created.id, '下一问', call);
    const restarted = new WebConversations(storage, resources, async () => ({ answer: 'unused' }));
    expect(restarted.read('alice', created.id).messages.at(-1)).toMatchObject({ status: 'interrupted', error: expect.stringContaining('服务重启') });
    service.forget('alice'); storage.deleteOwner('alice'); await tick();
    expect(storage.listRecords(['owners', mathDigest('alice'), 'conversations'])).toEqual([]);
  });
});

describe('conversation HTTP boundary with local fake provider only', () => {
  it('requires owner and CSRF, rejects supplied history, and persists a real provider reply', async () => {
    const seen: Record<string, unknown>[] = [];
    const provider = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        seen.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '来自本地模拟服务的回答。' }] }] }));
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>(resolve => { provider.closeAllConnections(); provider.close(() => resolve()); }));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`;
    const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: base });
    config.providers = [{ id: 'fixture', name: 'Fixture', baseUrl: `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}/v1` }];
    const runner: WebRunner = { readiness: async () => ({ ready: true, message: 'fixture' }),
      run: async (_input, _send, signal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) };
    const service = createWebService(config, runner, { sample: null });
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
    cleanups.push(() => service.close());
    const response = await fetch(`${base}/api/session`), session = await response.json() as WebSession;
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!, owner = cookie.split('=')[1]!;
    const headers = { Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' };
    const run = service.jobs.create(owner, { ...webDefaults, apiKey: key, providerId: 'fixture', model: 'fixture',
      source: 'theorem fixture : True := by sorry', task: 'Prove fixture' }, config.providers[0]!);
    expect((await fetch(`${base}/api/conversations`)).status).toBe(401);
    expect((await fetch(`${base}/api/conversations`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: run.id }) })).status).toBe(403);
    const created = await fetch(`${base}/api/conversations`, { method: 'POST', headers, body: JSON.stringify({ runId: run.id }) });
    expect(created.status).toBe(201);
    const { conversation } = await created.json() as { conversation: WebConversation };
    const route = `${base}/api/conversations/${conversation.id}`;
    expect((await fetch(route + '/messages', { method: 'POST', headers, body: JSON.stringify({ text: '为什么', apiKey: key, turns: [] }) })).status).toBe(400);
    expect((await fetch(route + '/messages', { method: 'POST', headers, body: JSON.stringify({ text: '为什么', apiKey: key }) })).status).toBe(202);
    let saved: WebConversation = conversation;
    for (let i = 0; i < 100; i++) {
      saved = (await (await fetch(route, { headers })).json() as { conversation: WebConversation }).conversation;
      if (saved.messages.at(-1)?.status === 'complete') break;
      await tick();
    }
    expect(saved.messages.at(-1)).toMatchObject({ status: 'complete', text: '来自本地模拟服务的回答。' });
    expect(seen[0]?.instructions).toBe(webConversationInstructions);
    expect(JSON.stringify(seen[0]?.input)).toContain(run.source);
    const other = await fetch(`${base}/api/session`), otherCookie = other.headers.get('set-cookie')!.split(';')[0]!;
    expect((await fetch(route, { headers: { Cookie: otherCookie } })).status).toBe(404);
    const otherSession = await other.json() as WebSession;
    const guidance = guidanceInput();
    expect((await fetch(route + '/guidance', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(guidance) })).status).toBe(403);
    expect((await fetch(route + '/guidance', { method: 'POST', headers: { ...headers, Cookie: otherCookie, 'X-CSRF-Token': otherSession.csrfToken }, body: JSON.stringify(guidance) })).status).toBe(404);
    expect((await fetch(route + '/guidance', { method: 'POST', headers, body: JSON.stringify({ ...guidance, receipt: { status: 'delivered' } }) })).status).toBe(400);
    expect((await (await fetch(route, { headers })).json() as { conversation: WebConversation }).conversation.messages).toHaveLength(saved.messages.length);
  });
});
