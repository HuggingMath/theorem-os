import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadClassicPreparation, readClassicId } from '../apps/web/client/classicPreparation';
import { decodeTaskDraft, encodeTaskDraft, type TaskDraft } from '../apps/web/client/draft';
import { DraftRecovery } from '../apps/web/client/draftRecovery';

const source = 'import Mathlib\n\ntheorem original (n : ℕ) : n + 0 = n := by\n  sorry\n';
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const record = { id: 'original-one', title: 'The original theorem', summary: '证明原题。', en: { summary: 'Prove the original problem.' },
  campaign: { targets: ['original'] }, sources: [{ name: 'Challenge.lean', sha256: sourceSha256 }, { name: 'Submission.lean', sha256: 'f'.repeat(64) }] };
const draft = (classicOrigin?: TaskDraft['classicOrigin']): TaskDraft => ({ providerId: 'fixture', model: 'fixture', source, task: 'Prove original',
  maxTurns: '10', maxRunSeconds: '300', workers: '1', effort: 'max', environment: 'mathlib', coordination: 'cooperative', templateId: '',
  ...(classicOrigin ? { classicOrigin } : {}) });

describe('classic problem preparation', () => {
  it('prepares the exact original challenge without reading an accepted proof', async () => {
    const paths: string[] = [];
    const request = (async input => {
      const path = String(input); paths.push(path);
      return path.endsWith('index.json') ? Response.json({ records: [record] }) : new Response(source);
    }) as typeof fetch;
    const prepared = await loadClassicPreparation(record.id, 'en', request);
    expect(prepared.source).toBe(source);
    expect(prepared.origin).toEqual({ id: record.id, title: record.title, sourceSha256 });
    expect(prepared.task).toContain(record.en.summary);
    expect(prepared.task).toContain('original');
    expect(paths).toEqual(['classics/data/index.json', 'classics/data/proofs/original-one/Challenge.lean']);
  });

  it('leaves the draft untouched if the original is missing or does not match its fixed source', async () => {
    const missing = (async () => Response.json({ records: [{ ...record, sources: record.sources.slice(1) }] })) as typeof fetch;
    await expect(loadClassicPreparation(record.id, 'zh', missing)).rejects.toThrow('原始题目');
    const changed = (async input => String(input).endsWith('index.json') ? Response.json({ records: [record] }) : new Response('theorem other : True := by trivial')) as typeof fetch;
    await expect(loadClassicPreparation(record.id, 'en', changed)).rejects.toThrow('differs');
    expect(readClassicId(new URLSearchParams('fromClassic=../../private'))).toBeUndefined();
  });

  it('retains the source identity with edited drafts and restores it through Undo', () => {
    const origin = { id: record.id, title: record.title, sourceSha256 };
    const before = { ...draft(origin), source: `${source}-- my edited question\n` };
    const restored = decodeTaskDraft(JSON.parse(encodeTaskDraft(before)));
    expect(restored).toEqual(before);
    const values = new Map<string, string>();
    const recovery = new DraftRecovery(() => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }));
    recovery.remember(restored, draft(), 'reuse'); recovery.load();
    expect(recovery.current?.draft.classicOrigin).toEqual(origin);
    expect(recovery.current?.draft.source).toBe(before.source);
  });
});
