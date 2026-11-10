import { expect, it } from 'vitest';
import { decodeChatDraft, encodeChatDraft, type ChatDraftSettings } from '../apps/web/client/chatDraft';
import { SubmissionIdentity } from '../apps/web/client/submissionIdentity';

const settings: ChatDraftSettings = { providerId: 'openai', model: 'chosen-model', environment: 'standard', effort: 'low',
  participation: 'automatic', maxRunSeconds: 120, maxTotalTokens: 20_000,
  research: { maxRunSeconds: 60, maxTotalTokens: 15_000, maxTurns: 2 } };

it('retains exact draft text and selected budgets while projecting out credentials', () => {
  const draft = { text: '  Original statement\nSecond line.\n', settings: { ...settings, apiKey: 'never-save-this-key' } };
  const encoded = encodeChatDraft(draft);
  expect(encoded).not.toContain('never-save-this-key');
  expect(decodeChatDraft(encoded)).toEqual({ text: draft.text, settings });
  for (const text of ['plain original', '{"a":"valid JSON original"}', '  \ntext\n']) expect(decodeChatDraft(text)).toEqual({ text });
});

it('restores guidance to the exact run and task version together with an independently pending question', () => {
  const draft = { text: '新的指导草稿', settings, guidance: { runId: 'run-a', taskRef: { id: 'goal', version: 'goal-v1' }, apiKey: 'secret-guidance-key' },
    pendingMessage: { requestId: 'send-1', text: '原来尚未确认的问题', apiKey: 'secret-message-key' } };
  const encoded = encodeChatDraft(draft);
  expect(encoded).not.toContain('secret');
  expect(decodeChatDraft(encoded)).toEqual({ text: draft.text, settings,
    guidance: { runId: 'run-a', taskRef: { id: 'goal', version: 'goal-v1' } }, pendingMessage: { requestId: 'send-1', text: draft.pendingMessage.text } });
  expect(decodeChatDraft(encodeChatDraft({ text: 'lead guidance', guidance: { runId: 'run-a' } })))
    .toEqual({ text: 'lead guidance', guidance: { runId: 'run-a' } });
});

it('discards incomplete task references and invalid pending sends without losing the typed draft', () => {
  for (const guidance of [{ runId: '' }, { runId: 'run-a', taskRef: { id: 'goal' } }, { runId: 'run-a', taskRef: { id: 'goal', version: 1 } }]) {
    expect(decodeChatDraft(JSON.stringify({ schema: 'theorem-os.chat-draft.v1', text: '保留', guidance }))).toEqual({ text: '保留' });
  }
  for (const pendingMessage of [{ requestId: 'bad/id', text: 'old' }, { requestId: 'send-1', text: '' }, { requestId: 'send-1', text: 'x'.repeat(4001) }]) {
    expect(decodeChatDraft(JSON.stringify({ schema: 'theorem-os.chat-draft.v1', text: '保留', pendingMessage }))).toEqual({ text: '保留' });
  }
});

it('recovers a natural submission across refresh without retaining the key or statement in its identity', async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const input = { original: 'Private mathematical statement', apiKey: 'never-save-this-key', solve: true, ...settings };
  const first = new SubmissionIdentity(storage, 'natural.alice'), id = await first.prepare(input);
  const refreshed = new SubmissionIdentity(storage, 'natural.alice');
  expect(refreshed.unresolved).toBe(true);
  expect(await refreshed.prepare({ ...input, apiKey: '' })).toBe(id);
  const { maxRunSeconds, maxTotalTokens, maxTurns } = input.research;
  expect(await refreshed.prepare({ ...input, research: { maxTurns, maxTotalTokens, maxRunSeconds } })).toBe(id);
  expect(JSON.stringify([...values])).not.toContain(input.apiKey);
  expect(JSON.stringify([...values])).not.toContain(input.original);
  expect(await new SubmissionIdentity(storage, 'natural.bob').prepare(input)).not.toBe(id);
  expect(await new SubmissionIdentity(storage, 'lean.alice').prepare(input)).not.toBe(id);
  refreshed.clear(id);
  expect(refreshed.unresolved).toBe(false);
  expect(await refreshed.prepare(input)).not.toBe(id);
});
