import { expect, it } from 'vitest';
import { decodeChatDraft, encodeChatDraft, readEditedProblemId, type ChatDraftSettings } from '../apps/web/client/chatDraft';
import { decodeLibraryReferences, libraryReferenceId, withLibraryReferences, type ChatLibraryReference } from '../apps/web/client/chatReference';
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

it('retains one recoverable original with its settings while excluding nested backups and credentials', () => {
  const backup = { text: '  原题 $n+0=n$\n第二行\n', settings: { ...settings, apiKey: 'backup-secret' },
    originalBackup: { text: 'must-not-chain' }, apiKey: 'other-secret' };
  const encoded = encodeChatDraft({ text: 'A selected example', settings, originalBackup: backup });
  expect(encoded).not.toContain('secret'); expect(encoded).not.toContain('must-not-chain');
  expect(decodeChatDraft(encoded)).toEqual({ text: 'A selected example', settings, originalBackup: { text: backup.text, settings } });
  expect(decodeChatDraft(JSON.stringify({ schema: 'theorem-os.chat-draft.v1', text: 'Still editable', originalBackup: { text: 42 } })))
    .toEqual({ text: 'Still editable' });
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

it('keeps library references separate from exact question text and deduplicates by pinned identity across languages', () => {
  const reference: ChatLibraryReference = { catalogDigest: 'a'.repeat(64), file: 'Library.lean', declaration: 'Library.bound',
    title: { zh: '有限求和', en: 'Finite sums' }, summary: { zh: '给出有限和的界。', en: 'Bounds a finite sum.' },
    expression: '∑ i, w i ≤ c', type: 'theorem bound (w : ι → ℝ) : ∑ i, w i ≤ c', import: 'import Library',
    source: 'https://example.invalid/library.html?catalogDigest=pinned', conditions: [{ expression: '[Fintype ι]', meaning: { zh: '索引类型有限', en: 'finite index type' } }],
    context: ['variable {ι : Type*} [Fintype ι]'] };
  const question = '  Keep this question.\n  ';
  const stored = encodeChatDraft({ text: question, settings, references: [{ ...reference, apiKey: 'never-save-this-key' } as ChatLibraryReference, reference] });
  expect(stored).not.toContain('never-save-this-key');
  const restored = decodeChatDraft(stored); expect(restored.text).toBe(question); expect(restored.references).toEqual([reference]);
  expect(libraryReferenceId(reference)).toBe(libraryReferenceId({ ...reference, title: { zh: '另一标题', en: 'Another title' } }));
  for (const language of ['zh', 'en'] as const) {
    const sent = withLibraryReferences(question, restored.references!, language);
    expect(sent.startsWith(question)).toBe(true);
    for (const expected of [reference.type, '[Fintype ι]', reference.source, reference.catalogDigest, `#check @${reference.declaration}`]) expect(sent).toContain(expected);
  }
  expect(withLibraryReferences(question, [], 'zh')).toBe(question);
  expect(decodeLibraryReferences([{ ...reference, source: 'javascript:alert(1)' }])).toEqual([]);
});

it('recognizes separate edited-problem draft routes without treating arbitrary URL text as a storage key', () => {
  expect(readEditedProblemId(new URLSearchParams({ editProblem: 'recorded-task-123' }))).toBe('recorded-task-123');
  expect(readEditedProblemId(new URLSearchParams({ editProblem: '../home' }))).toBe('');
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
