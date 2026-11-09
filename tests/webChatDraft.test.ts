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

it('recovers a natural submission across refresh without retaining the key or statement in its identity', async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const input = { original: 'Private mathematical statement', apiKey: 'never-save-this-key', solve: true, ...settings };
  const first = new SubmissionIdentity(storage, 'natural.alice'), id = await first.prepare(input);
  const refreshed = new SubmissionIdentity(storage, 'natural.alice');
  expect(refreshed.unresolved).toBe(true);
  expect(await refreshed.prepare({ ...input, apiKey: '' })).toBe(id);
  expect(JSON.stringify([...values])).not.toContain(input.apiKey);
  expect(JSON.stringify([...values])).not.toContain(input.original);
  expect(await new SubmissionIdentity(storage, 'natural.bob').prepare(input)).not.toBe(id);
  expect(await new SubmissionIdentity(storage, 'lean.alice').prepare(input)).not.toBe(id);
  refreshed.clear(id);
  expect(refreshed.unresolved).toBe(false);
  expect(await refreshed.prepare(input)).not.toBe(id);
});
