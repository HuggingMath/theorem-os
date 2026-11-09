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

describe('owned conversation names and deletion', () => {
  it('persists an edited title without changing the original problem, and validates names and ownership', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-conversation-name-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const { service, run, resources } = fixture(new WebStorage(root));
    const conversation = service.create('alice', { runId: run.id });
    expect(() => service.rename('bob', conversation.id, 'Someone else')).toThrow('不存在');
    for (const title of ['', ' \n\t ', '题'.repeat(81)]) expect(() => service.rename('alice', conversation.id, title)).toThrow('80');
    expect(service.read('alice', conversation.id).title).toBe(conversation.title);
    const renamed = service.rename('alice', conversation.id, '  我的证明\n  交换律  ');
    expect(renamed).toMatchObject({ id: conversation.id, title: '我的证明 交换律', messages: conversation.messages });
    expect(run.title).toBe('Original problem');
    const restarted = new WebConversations(new WebStorage(root), resources, async () => ({ answer: 'unused' }));
    expect(restarted.list('alice')[0]?.title).toBe('我的证明 交换律');
    expect(restarted.rename('alice', conversation.id, '题'.repeat(80)).title).toHaveLength(80);
  });

  it('keeps a renamed title when a streaming answer completes', async () => {
    let input!: WebExplainCall, finish!: (answer: { answer: string }) => void;
    const { service, run } = fixture(undefined, (_owner, request) => {
      input = request; return new Promise(resolve => { finish = resolve; });
    });
    cleanups.push(() => { finish?.({ answer: 'cleanup' }); return service.close(); });
    const conversation = service.create('alice', { runId: run.id });
    service.send('alice', conversation.id, '解释当前证明', call); await tick();
    input.onText!('先使用交换律');
    service.rename('alice', conversation.id, '已改名的对话');
    finish({ answer: '先使用交换律，再核对目标。' }); await tick();
    expect(service.read('alice', conversation.id)).toMatchObject({ title: '已改名的对话' });
    expect(service.read('alice', conversation.id).messages.at(-1)).toMatchObject({ status: 'complete', text: '先使用交换律，再核对目标。' });
  });

  it('deletes only the owned conversation and allows its retained task to open a new conversation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-conversation-delete-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const { service, run, formalization, storage, resources } = fixture(new WebStorage(root));
    run.formalizationId = formalization.id; formalization.runId = run.id;
    storage.saveRun('alice', run);
    const formalizationPath = ['owners', mathDigest('alice'), 'formalizations', formalization.id, 'record.json'];
    storage.saveRecord(formalizationPath, { owner: 'alice', formalization });
    const conversation = service.create('alice', { formalizationId: formalization.id });
    expect(() => service.delete('bob', conversation.id)).toThrow('不存在');
    expect(service.list('alice')).toHaveLength(1);
    service.delete('alice', conversation.id);
    expect(() => service.read('alice', conversation.id)).toThrow('不存在');
    expect(service.list('alice')).toEqual([]);
    expect(storage.getRun('alice', run.id)).toMatchObject({ id: run.id, status: 'running' });
    expect(storage.getRecord(formalizationPath)).toEqual({ owner: 'alice', formalization });
    expect(resources.formalization('alice', formalization.id)).toBe(formalization);
    const restarted = new WebConversations(new WebStorage(root), resources, async () => ({ answer: 'unused' }));
    expect(restarted.list('alice')).toEqual([]);
    const reopened = restarted.create('alice', { runId: run.id });
    expect(reopened.id).not.toBe(conversation.id);
    expect(reopened.messages).toHaveLength(2);
  });

  it('aborts a deleted answer and ignores buffered text, late output and provider completion', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-conversation-delete-stream-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    let input!: WebExplainCall, signal!: AbortSignal, finish!: (answer: { answer: string }) => void;
    const { service, run, storage, resources } = fixture(new WebStorage(root), (_owner, request, active) => {
      input = request; signal = active; return new Promise(resolve => { finish = resolve; });
    });
    cleanups.push(() => { finish?.({ answer: 'cleanup' }); return service.close(); });
    const conversation = service.create('alice', { runId: run.id });
    service.send('alice', conversation.id, '逐步解释', call); await tick();
    input.onText!('已保存'); input.onText!('尚未刷新的最后一段');
    expect(storedConversation(storage, conversation.id).messages.at(-1)?.text).toBe('已保存');
    service.delete('alice', conversation.id);
    expect(signal.aborted).toBe(true);
    input.onText!('删除后到达的内容');
    await vi.advanceTimersByTimeAsync(250);
    expect(storedConversation(storage, conversation.id)).toBeUndefined();
    finish({ answer: '删除后到达的完整回答' }); await tick();
    expect(storedConversation(storage, conversation.id)).toBeUndefined();
    expect(service.list('alice')).toEqual([]);
    const restarted = new WebConversations(new WebStorage(root), resources, async () => ({ answer: 'unused' }));
    expect(restarted.list('alice')).toEqual([]);
    expect(run.status).toBe('running');
  });

  it.each(['before', 'after'] as const)('still aborts an answer when deletion fails %s removing its record, and allows deletion retry', async when => {
    let input!: WebExplainCall, signal!: AbortSignal, finish!: (answer: { answer: string }) => void;
    const { service, run, storage } = fixture(undefined, (_owner, request, active) => {
      input = request; signal = active; return new Promise(resolve => { finish = resolve; });
    });
    cleanups.push(async () => { finish?.({ answer: 'cleanup' }); await service.close(); });
    const conversation = service.create('alice', { runId: run.id });
    service.send('alice', conversation.id, '删除前的问题', call); await tick();
    input.onText!('已保存的部分');
    const remove = storage.deleteRecord.bind(storage);
    vi.spyOn(storage, 'deleteRecord').mockImplementationOnce(where => {
      if (when === 'after') remove(where);
      throw new Error('delete unavailable');
    });
    expect(() => service.delete('alice', conversation.id)).toThrow('delete unavailable');
    expect(signal.aborted).toBe(true);
    input.onText!('删除后迟到的文本'); finish({ answer: '删除后迟到的回答' }); await tick();
    if (when === 'before') {
      expect(storedConversation(storage, conversation.id).messages.at(-1)).toMatchObject({ status: 'interrupted', text: '已保存的部分' });
      service.delete('alice', conversation.id);
    }
    expect(storedConversation(storage, conversation.id)).toBeUndefined();
    const reopened = service.create('alice', { runId: run.id });
    expect(reopened.id).not.toBe(conversation.id);
    expect(() => service.send('alice', reopened.id, '新对话的问题', call)).not.toThrow(); await tick();
  });
});

describe('streaming conversation persistence', () => {
  it.each(['immediate', 'delayed'] as const)('aborts an answer without throwing from its %s text checkpoint when persistence fails', async when => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let input!: WebExplainCall, signal!: AbortSignal, finish!: (answer: { answer: string }) => void;
    const { service, run, storage } = fixture(undefined, (_owner, request, active) => {
      input = request; signal = active; return new Promise(resolve => { finish = resolve; });
    });
    const save = vi.spyOn(storage, 'saveRecord');
    cleanups.push(async () => { save.mockRestore(); finish?.({ answer: 'cleanup' }); await service.close().catch(() => {}); });
    const conversation = service.create('alice', { runId: run.id });
    service.send('alice', conversation.id, '解释保存故障', call); await tick();
    if (when === 'delayed') input.onText!('第一个检查点');
    save.mockImplementationOnce(() => { throw new Error(`disk unavailable ${key}`); });
    if (when === 'immediate') expect(() => input.onText!('未能保存的部分')).not.toThrow();
    else {
      input.onText!('未能保存的部分');
      expect(() => vi.advanceTimersByTime(250)).not.toThrow();
    }
    expect(signal.aborted).toBe(true);
    input.onText!('取消后迟到的文本'); finish({ answer: '取消后迟到的完整回答' }); await tick();
    const reply = storedConversation(storage, conversation.id).messages.at(-1)!;
    expect(reply).toMatchObject({ status: 'error', text: '未能保存的部分', error: expect.stringContaining('保存') });
    expect(JSON.stringify(reply)).not.toContain(key);
    expect(() => service.send('alice', conversation.id, '恢复后的新问题', call)).not.toThrow(); await tick();
  });

  it('still aborts the provider when flushing text during stop fails', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let input!: WebExplainCall, signal!: AbortSignal, finish!: (answer: { answer: string }) => void;
    const { service, run, storage } = fixture(undefined, (_owner, request, active) => {
      input = request; signal = active; return new Promise(resolve => { finish = resolve; });
    });
    const save = vi.spyOn(storage, 'saveRecord');
    cleanups.push(async () => { save.mockRestore(); finish?.({ answer: 'cleanup' }); await service.close().catch(() => {}); });
    const conversation = service.create('alice', { runId: run.id });
    service.send('alice', conversation.id, '停止前保存', call); await tick();
    input.onText!('已保存'); input.onText!('最后一段');
    save.mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    expect(() => service.stop('alice', conversation.id)).toThrow('disk unavailable');
    expect(signal.aborted).toBe(true);
    finish({ answer: '停止后完成' }); await tick();
    expect(storedConversation(storage, conversation.id).messages.at(-1)).toMatchObject({ status: 'interrupted', text: '最后一段' });
  });

  it.each(['before', 'after'] as const)('releases an answer after its final save fails %s writing, preserving an already-saved completion', async when => {
    let finish!: (answer: { answer: string }) => void, attempts = 0;
    const { service, run, storage } = fixture(undefined, async () => {
      if (++attempts > 1) return { answer: '恢复后的回答' };
      return new Promise(resolve => { finish = resolve; });
    });
    const persist = storage.saveRecord.bind(storage), save = vi.spyOn(storage, 'saveRecord');
    cleanups.push(async () => { save.mockRestore(); finish?.({ answer: 'cleanup' }); await service.close().catch(() => {}); });
    const conversation = service.create('alice', { runId: run.id });
    service.send('alice', conversation.id, '完成前保存', call); await tick();
    save.mockImplementationOnce((where, value, immutable) => {
      if (when === 'after') persist(where, value, immutable);
      throw new Error(`disk unavailable ${key}`);
    });
    finish({ answer: '完整回答' }); await tick();
    expect(storedConversation(storage, conversation.id).messages.at(-1)).toMatchObject({ status: when === 'after' ? 'complete' : 'error' });
    expect(() => service.send('alice', conversation.id, '恢复后再问', call)).not.toThrow(); await tick();
    expect(storedConversation(storage, conversation.id).messages.at(-1)).toMatchObject({ status: 'complete', text: '恢复后的回答' });
    expect(JSON.stringify(storedConversation(storage, conversation.id))).not.toContain(key);
  });

  it('starts a stopped answer replacement after the old provider cleanup fails to read its checkpoint', async () => {
    let finish!: (answer: { answer: string }) => void, attempts = 0;
    const { service, run, storage } = fixture(undefined, async () => {
      if (++attempts > 1) return { answer: '新回答' };
      return new Promise(resolve => { finish = resolve; });
    });
    const read = vi.spyOn(storage, 'getRecord');
    cleanups.push(async () => { read.mockRestore(); finish?.({ answer: 'cleanup' }); await service.close().catch(() => {}); });
    const conversation = service.create('alice', { runId: run.id });
    service.send('alice', conversation.id, '旧问题', call); await tick();
    service.stop('alice', conversation.id);
    service.send('alice', conversation.id, '新问题', call);
    read.mockImplementationOnce(() => { throw new Error('checkpoint unavailable'); });
    finish({ answer: '旧回答' }); await tick();
    expect(attempts).toBe(2);
    expect(storedConversation(storage, conversation.id).messages.at(-1)).toMatchObject({ status: 'complete', text: '新回答' });
  });

  it('waits for every provider cleanup before reporting a failed shutdown save', async () => {
    const storage = new WebStorage(), { run } = fixture();
    const finishes: (() => void)[] = [], signals: AbortSignal[] = [];
    const service = new WebConversations(storage, { run: (_owner, id) => id === run.id ? run : undefined, formalization: () => undefined },
      (_owner, _input, signal) => new Promise(resolve => { signals.push(signal); finishes.push(() => resolve({ answer: 'late completion' })); }));
    const save = vi.spyOn(storage, 'saveRecord');
    cleanups.push(async () => { save.mockRestore(); for (const finish of finishes) finish(); await service.close().catch(() => {}); });
    for (const owner of ['alice', 'bob']) {
      const conversation = service.create(owner, { runId: run.id }); service.send(owner, conversation.id, '解释', call);
    }
    await tick();
    save.mockImplementation(() => { throw new Error('disk unavailable'); });
    let closed = false;
    const closing = service.close().then(() => { closed = true; return undefined; }, error => { closed = true; return error; });
    expect(signals.every(signal => signal.aborted)).toBe(true);
    finishes[0]!(); await tick();
    expect(closed).toBe(false);
    finishes[1]!();
    expect(await closing).toMatchObject({ message: 'disk unavailable' });
  });

  it('does not access deleted owner data when a forgotten answer flushes or finishes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let input!: WebExplainCall, finish!: (answer: { answer: string }) => void;
    const { service, run, storage } = fixture(undefined, (_owner, request) => {
      input = request; return new Promise(resolve => { finish = resolve; });
    });
    const read = vi.spyOn(storage, 'getRecord');
    cleanups.push(async () => { read.mockRestore(); finish?.({ answer: 'cleanup' }); await service.close().catch(() => {}); });
    const conversation = service.create('alice', { runId: run.id });
    service.send('alice', conversation.id, '账号清理前的问题', call); await tick();
    input.onText!('已保存'); input.onText!('缓冲文本');
    service.forget('alice'); storage.deleteOwner('alice');
    read.mockImplementation(() => { throw new Error('owner data unavailable'); });
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
    finish({ answer: '删除后完成' });
    await expect(service.close()).resolves.toBeUndefined();
    read.mockRestore();
    expect(storedConversation(storage, conversation.id)).toBeUndefined();
  });

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
  it.each(['delivered', 'failed', 'rejected'] as const)('keeps a recorded %s outcome when an older queued acknowledgement returns', async status => {
    const { service, run, storage, receipts } = fixture();
    const conversation = service.create('alice', { runId: run.id }), input = guidanceInput();
    let finish!: (receipt: WebCommandResult) => void;
    const pending = service.guide('alice', conversation.id, input, () => new Promise(resolve => { finish = resolve; }));
    const at = new Date().toISOString(), reason = status === 'delivered' ? undefined : '记录的终态原因';
    receipts.set(input.id, { id: input.id, status, reason, ...(status === 'rejected' ? {} : {
      guidance: { ...input, status, reason, createdAt: at, updatedAt: at, ...(status === 'delivered' ? { deliveredTo: ['engineer-2'] } : {}) },
    }) });
    finish({ id: input.id, status: 'queued' });
    const returned = await pending;
    const expected = { status: status === 'delivered' ? 'complete' : 'error',
      guidance: { receipt: { status, ...(status === 'delivered' ? { deliveredTo: ['engineer-2'] } : { reason }) } } };
    expect(returned.messages.at(-1)).toMatchObject(expected);
    expect(storedConversation(storage, conversation.id).messages.at(-1)).toMatchObject(expected);
    expect(storedConversation(storage, conversation.id).messages.filter(message => message.kind === 'guidance')).toHaveLength(1);
  });

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
  it('recovers the same accepted send during answering, after completion and after restart without calling the provider again', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-message-receipt-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    let finish!: (answer: { answer: string }) => void;
    const answer = vi.fn(async () => new Promise<{ answer: string }>(resolve => { finish = resolve; }));
    const { service, run, storage, resources } = fixture(new WebStorage(root), answer);
    cleanups.push(async () => { finish?.({ answer: 'cleanup' }); await service.close(); });
    const conversation = service.create('alice', { runId: run.id });
    const first = service.send('alice', conversation.id, '  请解释原问题  ', call, 'send-original'); await tick();
    const duplicate = service.send('alice', conversation.id, '请解释原问题', call, 'send-original');
    expect(duplicate.messages.map(message => message.id)).toEqual(first.messages.map(message => message.id));
    expect(duplicate.messages.at(-1)).toMatchObject({ status: 'pending' }); expect(answer).toHaveBeenCalledTimes(1);
    expect(() => service.send('alice', conversation.id, '另一条内容', call, 'send-original')).toThrow('另一条问题');
    expect(() => service.messageReceipt('bob', conversation.id, 'send-original', '请解释原问题')).toThrow('不存在');
    finish({ answer: '已保存回答' }); await tick();
    expect(service.send('alice', conversation.id, '请解释原问题', call, 'send-original').messages.at(-1)).toMatchObject({ text: '已保存回答', status: 'complete' });
    expect(answer).toHaveBeenCalledTimes(1);
    const restartedAnswer = vi.fn(async () => ({ answer: '不应调用' }));
    const restarted = new WebConversations(new WebStorage(root), resources, restartedAnswer);
    expect(restarted.send('alice', conversation.id, '请解释原问题', call, 'send-original').messages.at(-1)).toMatchObject({ text: '已保存回答' });
    expect(restartedAnswer).not.toHaveBeenCalled();
    expect(JSON.stringify(storedConversation(storage, conversation.id))).not.toContain(key);
    await restarted.close();
  });

  it('allows identical questions as new explicit sends and preserves no-ID callers', async () => {
    const { service, run, calls } = fixture();
    const conversation = service.create('alice', { runId: run.id });
    for (const requestId of ['first', 'second', undefined, undefined]) {
      service.send('alice', conversation.id, '相同问题', call, requestId); await tick();
    }
    expect(calls).toHaveLength(4);
    const questions = service.read('alice', conversation.id).messages.filter(message => message.role === 'user' && message.text === '相同问题');
    expect(questions).toHaveLength(4); expect(new Set(questions.map(message => message.id)).size).toBe(4);
    expect(questions.map(message => message.requestId)).toEqual(['first', 'second', undefined, undefined]);
    await service.close();
  });

  it('returns the saved interruption for the original send after restart instead of starting another answer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-message-restart-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    let finish!: (answer: { answer: string }) => void;
    const { service, run, resources } = fixture(new WebStorage(root), async () => new Promise(resolve => { finish = resolve; }));
    cleanups.push(async () => { finish?.({ answer: 'cleanup' }); await service.close(); });
    const conversation = service.create('alice', { runId: run.id });
    service.send('alice', conversation.id, '中断前的问题', call, 'interrupted-send'); await tick();
    const answer = vi.fn(async () => ({ answer: '不应自动重答' }));
    const restarted = new WebConversations(new WebStorage(root), resources, answer);
    expect(restarted.send('alice', conversation.id, '中断前的问题', call, 'interrupted-send').messages.at(-1)).toMatchObject({ status: 'interrupted' });
    expect(answer).not.toHaveBeenCalled(); await restarted.close();
  });

  it('uses the newly associated research and current formalization when a replacement waits for old provider cleanup', async () => {
    let finish!: (answer: { answer: string }) => void;
    const inputs: WebExplainCall[] = [];
    const { service, run, formalization, resources, storage } = fixture(undefined, async (_owner, request) => {
      inputs.push(request);
      return inputs.length === 1 ? new Promise(resolve => { finish = resolve; }) : { answer: '依据最新研究回答。' };
    });
    cleanups.push(async () => { finish?.({ answer: 'cleanup' }); await service.close(); });
    // The real formalization reader projects review/confirmed records into fresh objects.
    resources.formalization = (owner, id) => owner === 'alice' && id === formalization.id ? structuredClone(formalization) : undefined;
    const conversation = service.create('alice', { formalizationId: formalization.id });
    service.send('alice', conversation.id, '旧问题', call); await tick();
    service.stop('alice', conversation.id);
    service.send('alice', conversation.id, '新研究完成了吗？', call); await tick();
    expect(inputs).toHaveLength(1);
    formalization.status = 'confirmed'; formalization.runId = run.id; run.formalizationId = formalization.id;
    run.status = 'completed'; run.result = { status: 'evaluated_passed', proof: 'theorem latest_evidence : True := by trivial', report: { accepted: true } };
    finish({ answer: '迟到的旧回答' }); await tick();
    expect(inputs).toHaveLength(2);
    const context = JSON.stringify(inputs[1]!.input);
    for (const part of [run.source, run.result.proof, 'confirmed', 'evaluated_passed']) expect(context).toContain(part);
    expect(storedConversation(storage, conversation.id)).toMatchObject({ runId: run.id });
    expect(storedConversation(storage, conversation.id).messages.at(-1)).toMatchObject({ status: 'complete', text: '依据最新研究回答。' });
  });

  it('omits removed research evidence when a replacement starts after the task was deleted', async () => {
    let finish!: (answer: { answer: string }) => void;
    const inputs: WebExplainCall[] = [];
    const { service, run, resources } = fixture(undefined, async (_owner, request) => {
      inputs.push(request);
      return inputs.length === 1 ? new Promise(resolve => { finish = resolve; }) : { answer: '当前研究记录已不在。' };
    });
    cleanups.push(async () => { finish?.({ answer: 'cleanup' }); await service.close(); });
    run.status = 'completed'; run.result = { status: 'evaluated_passed', proof: 'theorem removed_evidence : True := by trivial', report: { accepted: true } };
    const conversation = service.create('alice', { runId: run.id });
    service.send('alice', conversation.id, '旧问题', call); await tick();
    service.stop('alice', conversation.id);
    service.send('alice', conversation.id, '还有什么记录？', call); await tick();
    resources.run = () => undefined;
    finish({ answer: '迟到的旧回答' }); await tick();
    expect(inputs).toHaveLength(2);
    expect(JSON.stringify(inputs[1]!.input)).not.toContain(run.result.proof);
    expect(service.read('alice', conversation.id).messages.at(-1)).toMatchObject({ status: 'complete', text: '当前研究记录已不在。' });
  });

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

  it('opens a Lean run with its request and its source as a Lean block, titled like the run', () => {
    const { service, run } = fixture();
    run.title = '帮我证明高斯定理'; run.task = '帮我证明高斯定理';
    run.source = 'namespace Tutorial\n\ntheorem add_zero (n : Nat) : n + 0 = n := by\n  sorry\n\nend Tutorial\n';
    const created = service.create('alice', { runId: run.id });
    expect(created.title).toBe('帮我证明高斯定理');
    expect(created.messages[0]?.text).toBe('帮我证明高斯定理\n\n```lean\nnamespace Tutorial\n\ntheorem add_zero (n : Nat) : n + 0 = n := by\n  sorry\n\nend Tutorial\n```');
    // A source holding a fence of its own gets a longer one, so the block cannot end early.
    const { service: other, run: fenced } = fixture();
    fenced.task = ''; fenced.source = '/-- ```\nexample\n``` -/\ntheorem t : True := trivial';
    const block = other.create('alice', { runId: fenced.id });
    expect(block.title).toBe('Original problem');
    expect(block.messages[0]?.text).toBe('````lean\n/-- ```\nexample\n``` -/\ntheorem t : True := trivial\n````');
  });

  it('rewrites a Lean run conversation saved with its raw source and the title flattened from it', () => {
    const { service, run, storage } = fixture();
    run.title = '帮我证明高斯定理'; run.task = '帮我证明高斯定理';
    run.source = 'namespace Tutorial\n\ntheorem add_zero (n : Nat) : n + 0 = n := by\n  sorry\n\nend Tutorial\n';
    const created = service.create('alice', { runId: run.id }), stored = storedConversation(storage, created.id);
    Object.assign(stored, { title: run.source.replace(/\s+/gu, ' ').slice(0, 80) }); stored.messages[0]!.text = run.source;
    storage.saveRecord(['owners', mathDigest('alice'), 'conversations', `${created.id}.json`], stored);
    expect(service.list('alice')[0]?.title).toBe('帮我证明高斯定理');
    expect(storedConversation(storage, created.id).messages[0]?.text).toBe(created.messages[0]?.text);
    // A title that was not flattened from the source stays.
    Object.assign(stored, { title: 'My own name' }); stored.messages[0]!.text = run.source;
    storage.saveRecord(['owners', mathDigest('alice'), 'conversations', `${created.id}.json`], stored);
    const read = service.read('alice', created.id);
    expect([read.title, read.messages[0]?.text]).toEqual(['My own name', created.messages[0]?.text]);
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
    const identified = { text: '按发送身份恢复', apiKey: key, requestId: 'http-send-1' };
    for (const requestId of ['', 'bad/id', 'x'.repeat(129)]) expect((await fetch(route + '/messages', {
      method: 'POST', headers, body: JSON.stringify({ ...identified, requestId }) })).status).toBe(400);
    const identifiedResponse = await fetch(route + '/messages', { method: 'POST', headers, body: JSON.stringify(identified) });
    expect(identifiedResponse.status).toBe(202);
    const identifiedFirst = (await identifiedResponse.json() as { conversation: WebConversation }).conversation;
    // Acceptance can be recovered without the key even after maintenance begins. It dispatches no new answer.
    service.storage.saveRecord(['operations', 'maintenance.json'], { enabled: true });
    const recovered = await fetch(route + '/messages', { method: 'POST', headers, body: JSON.stringify({ ...identified, apiKey: '' }) });
    expect(recovered.status).toBe(202);
    expect((await recovered.json() as { conversation: WebConversation }).conversation.messages.map(message => message.id))
      .toEqual(identifiedFirst.messages.map(message => message.id));
    expect((await fetch(route + '/messages', { method: 'POST', headers, body: JSON.stringify({ ...identified, text: '不能更换原内容' }) })).status).toBe(409);
    expect((await fetch(route + '/messages', { method: 'POST', headers, body: JSON.stringify({ ...identified, requestId: 'http-send-new' }) })).status).toBe(503);
    service.storage.saveRecord(['operations', 'maintenance.json'], { enabled: false });
    for (let i = 0; i < 100; i++) {
      saved = (await (await fetch(route, { headers })).json() as { conversation: WebConversation }).conversation;
      if (saved.messages.at(-1)?.status === 'complete') break;
      await tick();
    }
    expect(seen).toHaveLength(2);
    const other = await fetch(`${base}/api/session`), otherCookie = other.headers.get('set-cookie')!.split(';')[0]!;
    expect((await fetch(route, { headers: { Cookie: otherCookie } })).status).toBe(404);
    const otherSession = await other.json() as WebSession;
    const guidance = guidanceInput();
    expect((await fetch(route + '/guidance', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(guidance) })).status).toBe(403);
    expect((await fetch(route + '/guidance', { method: 'POST', headers: { ...headers, Cookie: otherCookie, 'X-CSRF-Token': otherSession.csrfToken }, body: JSON.stringify(guidance) })).status).toBe(404);
    expect((await fetch(route + '/guidance', { method: 'POST', headers, body: JSON.stringify({ ...guidance, receipt: { status: 'delivered' } }) })).status).toBe(400);
    expect((await (await fetch(route, { headers })).json() as { conversation: WebConversation }).conversation.messages).toHaveLength(saved.messages.length);
    const title = { title: '  我的证明\n  第一版  ' };
    expect((await fetch(route, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(title) })).status).toBe(401);
    expect((await fetch(route, { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(title) })).status).toBe(403);
    const otherHeaders = { ...headers, Cookie: otherCookie, 'X-CSRF-Token': otherSession.csrfToken };
    expect((await fetch(route, { method: 'PATCH', headers: otherHeaders, body: JSON.stringify(title) })).status).toBe(404);
    for (const body of [{}, { title: 3 }, { title: 'Valid', messages: [] }, { title: ' \n ' }, { title: '题'.repeat(81) }]) {
      expect((await fetch(route, { method: 'PATCH', headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    const renamed = await fetch(route, { method: 'PATCH', headers, body: JSON.stringify(title) });
    expect(renamed.status).toBe(200);
    expect((await renamed.json() as { conversation: WebConversation }).conversation).toMatchObject({
      id: conversation.id, title: '我的证明 第一版', messages: saved.messages,
    });
    expect((await fetch(route, { method: 'DELETE', headers: { Cookie: cookie } })).status).toBe(403);
    expect((await fetch(route, { method: 'DELETE', headers: otherHeaders })).status).toBe(404);
    const deleted = await fetch(route, { method: 'DELETE', headers });
    expect(deleted.status).toBe(200); expect(await deleted.json()).toEqual({ deleted: true });
    expect((await fetch(route, { headers })).status).toBe(404);
    expect(service.jobs.get(owner, run.id)?.status).toBe('running');
    const reopened = await fetch(`${base}/api/conversations`, { method: 'POST', headers, body: JSON.stringify({ runId: run.id }) });
    expect(reopened.status).toBe(201);
    expect((await reopened.json() as { conversation: WebConversation }).conversation.id).not.toBe(conversation.id);
    expect(seen).toHaveLength(2);
  });

  it('refuses a rename after logout while its body is still arriving', async () => {
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`, mail: { text: string }[] = [];
    const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: base,
      THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'alice@example.org' });
    const runner: WebRunner = { readiness: async () => ({ ready: true, message: 'fixture' }),
      run: async (_input, _send, signal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) };
    const service = createWebService(config, runner, { sample: null, captchaAnswer: () => '12345', mailer: async message => { mail.push(message); } });
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
    cleanups.push(() => service.close());
    const visitor = await fetch(`${base}/api/session`), visitorSession = await visitor.json() as WebSession;
    const visitorHeaders = { Cookie: visitor.headers.get('set-cookie')!.split(';')[0]!, 'X-CSRF-Token': visitorSession.csrfToken, 'Content-Type': 'application/json' };
    const captcha = await (await fetch(`${base}/api/auth/captcha`, { method: 'POST', headers: visitorHeaders, body: '{}' })).json() as { id: string };
    expect((await fetch(`${base}/api/auth/code`, { method: 'POST', headers: visitorHeaders,
      body: JSON.stringify({ email: 'alice@example.org', captchaId: captcha.id, captcha: '12345' }) })).status).toBe(200);
    const verified = await fetch(`${base}/api/auth/verify`, { method: 'POST', headers: visitorHeaders,
      body: JSON.stringify({ email: 'alice@example.org', code: mail.at(-1)!.text.match(/\b\d{6}\b/u)![0] }) });
    expect(verified.status).toBe(200);
    const signedIn = await verified.json() as { csrfToken: string };
    const headers = { ...visitorHeaders, Cookie: verified.headers.get('set-cookie')!.split(';')[0]!, 'X-CSRF-Token': signedIn.csrfToken };
    const owner = `account:${service.auth!.getAccount('alice@example.org')!.id}`;
    const run = service.jobs.create(owner, { ...webDefaults, apiKey: key, providerId: config.providers[0]!.id,
      source: 'theorem fixture : True := by sorry', task: 'Prove fixture' }, config.providers[0]!);
    const conversation = service.conversations.create(owner, { runId: run.id });
    const started = new Promise<void>(resolve => service.server.once('request', () => setImmediate(resolve)));
    const upload = http.request(`${base}/api/conversations/${conversation.id}`, { method: 'PATCH', headers });
    cleanups.push(() => { upload.destroy(); });
    const completed = new Promise<number | undefined>((resolve, reject) => {
      upload.on('error', reject);
      upload.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode)); response.on('error', reject); });
    });
    upload.write('{"title":'); await started;
    expect((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers, body: '{}' })).status).toBe(200);
    upload.end('"Signed out title"}');
    expect(await completed).toBe(401);
    expect(service.conversations.read(owner, conversation.id).title).toBe(conversation.title);
    expect(service.jobs.get(owner, run.id)).toBeDefined();
  });
});
