import { describe, expect, it } from 'vitest';
import { mergeOrganizationEdits, organizationDraftKey, organizationValues, readOrganizationDraft, writeOrganizationDraft } from '../apps/web/client/researchOrganizationDraft';

describe('personal organization editing continuity', () => {
  it('restores unsaved fields only and keeps untouched values from the latest account record', () => {
    const map = new Map<string, string>(), storage = { getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } };
    const key = organizationDraftKey('alice', { runId: 'run-a' });
    writeOrganizationDraft(storage, key, { baseRevision: 4, values: { pinned: false, status: 'active', tags: 'old', nextNote: 'New derivation during save' }, edited: ['nextNote'] });
    const restored = readOrganizationDraft(storage, key)!;
    const latest = { pinned: true, status: 'parked' as const, tags: 'new device tag', nextNote: 'Previously saved' };
    expect(mergeOrganizationEdits(latest, restored.values, new Set(restored.edited))).toEqual({ ...latest, nextNote: 'New derivation during save' });
    expect(restored.baseRevision).toBe(4);
  });
  it('separates accounts, projects and personal runs while treating project organization as project-wide', () => {
    const key = organizationDraftKey('alice', { runId: 'run-a' });
    expect(key).not.toBe(organizationDraftKey('bob', { runId: 'run-a' }));
    expect(key).not.toBe(organizationDraftKey('alice', { runId: 'run-b' }));
    expect(key).not.toBe(organizationDraftKey('alice', { projectId: 'project-a', runId: 'run-a' }));
    expect(organizationDraftKey('alice', { projectId: 'project-a', runId: 'run-a' })).toBe(organizationDraftKey('alice', { projectId: 'project-a', runId: 'run-b' }));
    expect(organizationDraftKey('alice', { projectId: 'project-a' })).not.toBe(organizationDraftKey('alice', { projectId: 'project-b' }));
  });
  it('reports storage failures and damaged drafts instead of using invalid input as account state', () => {
    const storage = { getItem: () => '{"values":{}}', setItem: () => { throw new Error('Quota'); }, removeItem() {} };
    expect(() => readOrganizationDraft(storage, 'key')).toThrow('Invalid organization draft');
    expect(() => writeOrganizationDraft(storage, 'key', { baseRevision: 0, values: organizationValues(), edited: ['nextNote'] })).toThrow('Quota');
  });
});
