import { expect, it } from 'vitest';
import { OwnedDrafts, submissionStorageKey } from '../apps/web/client/ownedDrafts';
import { taskDraftStorageKey } from '../apps/web/client/draft';
import { draftRecoveryStorageKey } from '../apps/web/client/draftRecovery';
import { SubmissionIdentity } from '../apps/web/client/submissionIdentity';
import type { WebRunRequest } from '../apps/web/shared';
const storage = () => { const values = new Map<string, string>(); return {
  getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); }, values,
}; };
it('preserves same-owner drafts, rejects unbound and other-owner drafts, and disables writes after logout', () => {
  const raw = storage(), owned = new OwnedDrafts(() => raw);
  raw.setItem(taskDraftStorageKey, 'legacy private source'); owned.bind('alice');
  expect(owned.getItem(taskDraftStorageKey)).toBeNull();
  for (const key of [taskDraftStorageKey, draftRecoveryStorageKey, submissionStorageKey]) owned.setItem(key, 'alice private source');
  const refreshed = new OwnedDrafts(() => raw); refreshed.bind('alice');
  expect(refreshed.getItem(taskDraftStorageKey)).toBe('alice private source');
  refreshed.bind('bob');
  expect([...raw.values.values()]).toEqual(['bob']);
  expect(() => owned.setItem(taskDraftStorageKey, 'late Alice pagehide')).toThrow();
  refreshed.clear(); expect(() => refreshed.setItem(taskDraftStorageKey, 'late Bob pagehide')).toThrow();
  expect(raw.values.size).toBe(0);
});
it('retains uncertain submission identity through refresh and credential changes, but new work gets a new identity', async () => {
  const raw = storage(), first = new SubmissionIdentity(raw);
  const input = { apiKey: 'private-secret', task: 'prove t', source: 'theorem t : True := by sorry', model: 'fixture' } as WebRunRequest;
  const id = await first.prepare(input);
  expect(JSON.stringify([...raw.values.values()])).not.toContain('private-secret');
  expect(JSON.stringify([...raw.values.values()])).not.toContain('theorem t');
  const refreshed = new SubmissionIdentity(raw);
  expect(await refreshed.prepare({ ...input, apiKey: '', saveKey: true })).toBe(id);
  expect(await refreshed.prepare({ ...input, task: 'new task' })).not.toBe(id);
  refreshed.clear(); expect(await refreshed.prepare(input)).not.toBe(id);
});
