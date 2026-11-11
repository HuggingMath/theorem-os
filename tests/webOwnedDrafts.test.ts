import { expect, it } from 'vitest';
import { OwnedDrafts, researchEntryStorageKey, researchEnvironmentStorageKey, researchSelectionStorageKey, submissionStorageKey } from '../apps/web/client/ownedDrafts';
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
  const privateKeys = [taskDraftStorageKey, draftRecoveryStorageKey, submissionStorageKey, researchSelectionStorageKey, researchEnvironmentStorageKey, researchEntryStorageKey];
  for (const key of privateKeys) owned.setItem(key, 'alice private source');
  const refreshed = new OwnedDrafts(() => raw); refreshed.bind('alice');
  for (const key of privateKeys) expect(refreshed.getItem(key)).toBe('alice private source');
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
it('separates creation identities by owner and surface and protects newer work from a late response', async () => {
  const raw = storage(), chat = new SubmissionIdentity(raw, 'chat:alice');
  const input = { original: 'private original', environment: 'standard', effort: 'max', solve: true, apiKey: 'secret' };
  const first = await chat.prepare(input);
  expect(new SubmissionIdentity(raw, 'chat:alice').unresolved).toBe(true);
  expect(await new SubmissionIdentity(raw, 'chat:alice').prepare({ ...input, apiKey: '' })).toBe(first);
  expect(await new SubmissionIdentity(raw, 'chat:bob').prepare(input)).not.toBe(first);
  expect(await new SubmissionIdentity(raw, 'formalize:alice').prepare(input)).not.toBe(first);
  chat.clear();
  const next = await chat.prepare(input);
  expect(next).not.toBe(first);
  chat.clear(first);
  expect(await new SubmissionIdentity(raw, 'chat:alice').prepare(input)).toBe(next);
  expect(JSON.stringify([...raw.values.values()])).not.toMatch(/secret|private original/u);
});
it('preserves a pending submission created by the previous client digest format', async () => {
  const raw = storage();
  const visible = { task: 'prove t', source: 'theorem t : True := by sorry', model: 'fixture' };
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(visible)));
  const digest = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const requestId = crypto.randomUUID();
  raw.setItem(submissionStorageKey, JSON.stringify({ requestId, digest }));
  expect(await new SubmissionIdentity(raw).prepare({ ...visible, apiKey: '' })).toBe(requestId);
});
