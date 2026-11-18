import { describe, expect, it, vi } from 'vitest';
import { encodeTaskDraft, taskDraftStorageKey, type TaskDraft } from '../apps/web/client/draft';
import { DraftRecovery, draftRecoveryStorageKey, replacementReasons } from '../apps/web/client/draftRecovery';
import { webLimits } from '../apps/web/shared';

const draft = (changes: Partial<TaskDraft> = {}): TaskDraft => ({
  providerId: 'openai', model: 'fixture-recovery-model', effort: 'high', environment: 'standard',
  source: 'theorem original : True := by sorry', task: 'Preserve the original task', templateId: '',
  maxTurns: '3', maxRunSeconds: '90', workers: '1', coordination: 'independent', ...changes,
});
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }) };
}
const envelope = (value: TaskDraft = draft(), reason = 'template') => ({
  schema: draftRecoveryStorageKey, reason, task: JSON.parse(encodeTaskDraft(value)),
});

describe('one recoverable draft replacement', () => {
  it('restores expert release references together with their native team settings', () => {
    const saved = storage(), original = draft({ researchMode: 'skill', skillLoading: 'native', nativeTeamCapacity: 8,
      nativeTeamPreferredProfiles: ['engineer', 'D011'] }), release = { assetId: 'private-expert', version: 'v4', digest: 'e'.repeat(64) };
    new DraftRecovery(() => saved).remember(original, draft({ source: 'theorem next : True := by sorry' }), 'source', [release]);
    const restored = new DraftRecovery(() => saved); restored.load();
    expect(restored.current).toMatchObject({ draft: original, libraries: [release] });
  });
  it('restores project budget, shared provenance and fixed libraries as one recoverable context', () => {
    const saved = storage(), recovery = new DraftRecovery(() => saved);
    const original = draft({ problemBudget: { runId: 'a'.repeat(36), projectId: 'project-one' },
      sharedProofOrigin: { readingId: 'shared-one', title: 'Source proof', digest: 'b'.repeat(64) },
      libraryProposalOrigin: { projectId: 'project-one', feedbackId: 'feedback-one', trialDigest: 'c'.repeat(64) } });
    const libraries = [{ assetId: 'library-one', version: 'v1', digest: 'd'.repeat(64) }];
    recovery.remember(original, draft({ task: 'A different problem' }), 'reuse', libraries);
    libraries[0].version = 'mutated'; original.problemBudget!.projectId = 'mutated';
    const reloaded = new DraftRecovery(() => saved); reloaded.load();
    expect(reloaded.current?.draft.problemBudget?.projectId).toBe('project-one');
    expect(reloaded.current?.draft.sharedProofOrigin?.readingId).toBe('shared-one');
    expect(reloaded.current?.draft.libraryProposalOrigin?.feedbackId).toBe('feedback-one');
    expect(reloaded.current?.libraries).toEqual([{ assetId: 'library-one', version: 'v1', digest: 'd'.repeat(64) }]);
    reloaded.current!.libraries![0].version = 'also-mutated';
    expect(reloaded.current?.libraries?.[0].version).toBe('v1');
  });
  it('retains an explicit empty selection so Undo can clear the replacement problem’s libraries', () => {
    const saved = storage(), recovery = new DraftRecovery(() => saved);
    recovery.remember(draft(), draft({ task: 'New problem with a library' }), 'reuse', []);
    const reloaded = new DraftRecovery(() => saved); reloaded.load();
    expect(reloaded.current?.libraries).toEqual([]);
  });
  it('rejects malformed persisted dependency identities instead of silently removing them', () => {
    const saved = storage(), recovery = new DraftRecovery(() => saved);
    saved.values.set(draftRecoveryStorageKey, JSON.stringify({ ...envelope(), libraries: [{ assetId: '../foreign', version: 'v1' }] }));
    recovery.load(); expect(recovery.current).toBeUndefined();
  });
  it('restores the confirmed formalization reference along with the unchanged source', () => {
    const saved = storage(), recovery = new DraftRecovery(() => saved);
    const original = draft({ formalization: { id: 'd5a5c217-b5a4-4600-9aae-97846e615ab2', evidenceSha256: 'a'.repeat(64) } });
    recovery.remember(original, draft({ source: 'theorem replacement : True := by sorry' }), 'import');
    const reloaded = new DraftRecovery(() => saved); reloaded.load();
    expect(reloaded.current?.draft).toEqual(original);
    const exposed = reloaded.current!; exposed.draft.formalization!.id = 'changed';
    expect(reloaded.current?.draft.formalization).toEqual(original.formalization);
  });
  it('restores the chosen knowledge version and continuation in a replaced draft', () => {
    const saved = storage(), recovery = new DraftRecovery(() => saved);
    const original = draft({ knowledgeDigest: null, continueFrom: { runId: 'a'.repeat(36), taskId: 'goal',
      commit: 'b'.repeat(40), label: 'saved proof' } });
    recovery.remember(original, draft({ task: 'Replacement' }), 'reuse');
    const reloaded = new DraftRecovery(() => saved); reloaded.load();
    expect(reloaded.current?.draft).toEqual(original);
  });
  it('stores the full editable draft independently of autosave and restores it in a fresh controller', () => {
    const saved = storage(), before = draft(), recovery = new DraftRecovery(() => saved);
    saved.values.set(taskDraftStorageKey, 'unrelated autosave');
    recovery.remember(before, draft({ task: 'Replacement task' }), 'template');
    expect(recovery.current).toEqual({ draft: before, reason: 'template', persisted: true });
    expect(JSON.parse(saved.values.get(draftRecoveryStorageKey)!)).toEqual(envelope(before));
    expect(saved.values.get(taskDraftStorageKey)).toBe('unrelated autosave');
    const reloaded = new DraftRecovery(() => saved);
    reloaded.load();
    expect(reloaded.current).toEqual(recovery.current);
  });

  it('copies only editable fields without reading credentials, results or serialization hooks', () => {
    const before = draft(), after = draft({ task: 'Replacement task' }), saved = storage();
    const sensitive = vi.fn(() => { throw new Error('sensitive-unread-value'); });
    for (const input of [before, after]) {
      for (const name of ['apiKey', 'result', 'events', 'status', 'toJSON']) {
        Object.defineProperty(input, name, { enumerable: true, get: sensitive });
      }
    }
    const recovery = new DraftRecovery(() => saved);
    recovery.remember(before, after, 'import');
    expect(recovery.current).toEqual({ draft: draft(), reason: 'import', persisted: true });
    expect(sensitive).not.toHaveBeenCalled();
    expect(saved.values.get(draftRecoveryStorageKey)).not.toMatch(/apiKey|events|result|status|sensitive/);
  });

  it('does not share mutable draft objects with either input or callers', () => {
    const before = draft(), after = draft({ task: 'Replacement task' }), saved = storage();
    const recovery = new DraftRecovery(() => saved);
    recovery.remember(before, after, 'edit');
    before.source = 'mutated original'; after.task = 'mutated replacement';
    const exposed = recovery.current!;
    exposed.draft.task = 'mutated returned draft'; exposed.reason = 'reset'; exposed.persisted = false;
    expect(recovery.current).toEqual({ draft: draft(), reason: 'edit', persisted: true });
    expect(JSON.parse(saved.values.get(draftRecoveryStorageKey)!).task.draft).toEqual(draft());
  });

  it('keeps the existing backup and storage untouched for a replacement with identical editable fields', () => {
    const saved = storage(), recovery = new DraftRecovery(() => saved), replacement = draft({ task: 'Replacement' });
    recovery.remember(draft(), replacement, 'source');
    const previous = saved.values.get(draftRecoveryStorageKey);
    recovery.remember(replacement, { ...replacement, apiKey: 'ignored-extra-key' } as TaskDraft, 'reset');
    expect(recovery.current).toEqual({ draft: draft(), reason: 'source', persisted: true });
    expect(saved.values.get(draftRecoveryStorageKey)).toBe(previous);
    expect(saved.setItem).toHaveBeenCalledTimes(1);
    expect(saved.removeItem).not.toHaveBeenCalled();
  });

  it('retains only the most recent replacement and clearing it leaves no redo or stored backup', () => {
    const saved = storage(), recovery = new DraftRecovery(() => saved), second = draft({ task: 'Second' });
    recovery.remember(draft(), second, 'template');
    recovery.remember(second, draft({ task: 'Third' }), 'reuse');
    expect(recovery.current).toEqual({ draft: second, reason: 'reuse', persisted: true });
    expect(saved.values.size).toBe(1);
    recovery.clear();
    expect(recovery.current).toBeUndefined();
    expect(saved.values.has(draftRecoveryStorageKey)).toBe(false);
    recovery.load(); expect(recovery.current).toBeUndefined();
    expect(() => recovery.clear()).not.toThrow();
  });

  it('preserves empty text and numeric fields without applying submission validation', () => {
    const empty = draft({ providerId: '', model: '', source: '', task: '', templateId: '', maxTurns: '', maxRunSeconds: '', workers: '' });
    const saved = storage(), recovery = new DraftRecovery(() => saved);
    recovery.remember(empty, draft(), 'reset');
    expect(recovery.current).toEqual({ draft: empty, reason: 'reset', persisted: true });
    const reloaded = new DraftRecovery(() => saved); reloaded.load();
    expect(reloaded.current?.draft).toEqual(empty);
  });

  it.each([
    ['oversized source', { source: 'x'.repeat(webLimits.maxSourceBytes + 1) }],
    ['oversized task', { task: 'x'.repeat(8_001) }],
    ['invalid numeric text', { maxTurns: 'not-a-number' }],
    ['NUL in source', { source: 'unfinished\0source' }],
  ] as const)('keeps an %s draft in memory and removes an older persisted backup', (_, changes) => {
    const saved = storage(), recovery = new DraftRecovery(() => saved);
    recovery.remember(draft(), draft({ task: 'First replacement' }), 'template');
    const before = draft(changes);
    recovery.remember(before, draft(), 'reset');
    expect(recovery.current).toEqual({ draft: before, reason: 'reset', persisted: false });
    expect(saved.values.has(draftRecoveryStorageKey)).toBe(false);
    const reloaded = new DraftRecovery(() => saved); reloaded.load();
    expect(reloaded.current).toBeUndefined();
  });

  it.each(replacementReasons)('reloads the supported %s replacement reason', reason => {
    const saved = storage(), recovery = new DraftRecovery(() => saved);
    saved.values.set(draftRecoveryStorageKey, JSON.stringify(envelope(draft(), reason)));
    recovery.load();
    expect(recovery.current).toEqual({ draft: draft(), reason, persisted: true });
  });

  it('strips extra fields from a persisted backup', () => {
    const saved = storage(), recovery = new DraftRecovery(() => saved), incoming = envelope();
    Object.assign(incoming.task.draft, { apiKey: 'discarded-secret', result: { proof: 'discarded-proof' } });
    saved.values.set(draftRecoveryStorageKey, JSON.stringify(incoming));
    recovery.load();
    expect(recovery.current).toEqual({ draft: draft(), reason: 'template', persisted: true });
    expect(JSON.stringify(recovery.current)).not.toMatch(/discarded|apiKey|proof/);
  });

  it.each([
    '{broken-json', 'null', '[]', '{}',
    JSON.stringify({ ...envelope(), schema: 'unknown' }),
    JSON.stringify({ ...envelope(), reason: 'submit' }),
    JSON.stringify({ schema: draftRecoveryStorageKey, reason: 'template' }),
    JSON.stringify({ ...envelope(), task: { schema: 'unknown', draft: draft() } }),
    JSON.stringify({ ...envelope(), task: { schema: taskDraftStorageKey, draft: draft({ source: 'x'.repeat(webLimits.maxSourceBytes + 1) }) } }),
  ])('discards malformed or incompatible stored recovery without blocking the page: %s', raw => {
    const saved = storage(), recovery = new DraftRecovery(() => saved);
    recovery.remember(draft(), draft({ task: 'Previously valid' }), 'template');
    saved.values.set(draftRecoveryStorageKey, raw);
    expect(() => recovery.load()).not.toThrow();
    expect(recovery.current).toBeUndefined();
    expect(saved.values.has(draftRecoveryStorageKey)).toBe(false);
  });

  it.each(['access', 'get', 'set', 'remove'] as const)('survives storage %s exceptions and permits in-memory recovery', failure => {
    const saved = storage();
    const denied = () => { throw new DOMException('Fixture storage failure', 'SecurityError'); };
    if (failure === 'get') saved.getItem.mockImplementation(denied);
    if (failure === 'set') saved.setItem.mockImplementation(denied);
    if (failure === 'remove') saved.removeItem.mockImplementation(denied);
    const recovery = new DraftRecovery(failure === 'access' ? denied : () => saved);
    expect(() => recovery.load()).not.toThrow();
    expect(recovery.current).toBeUndefined();
    expect(() => recovery.remember(draft(), draft({ task: 'Replacement' }), 'source')).not.toThrow();
    expect(recovery.current).toEqual({ draft: draft(), reason: 'source', persisted: !['access', 'set'].includes(failure) });
    expect(() => recovery.clear()).not.toThrow();
    expect(recovery.current).toBeUndefined();
  });
});
