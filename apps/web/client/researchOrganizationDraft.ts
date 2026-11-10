import type { ResearchPersonalProblem, ResearchPersonalTarget } from '../researchPersonalTypes';

export type OrganizationValues = { pinned: boolean; status: ResearchPersonalProblem['status']; tags: string; nextNote: string };
export type OrganizationField = keyof OrganizationValues;
export type OrganizationDraft = { baseRevision: number; values: OrganizationValues; edited: OrganizationField[] };
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const organizationDraftKey = (owner: string, target: ResearchPersonalTarget) => 'theorem-os.organization-draft.v1:' + encodeURIComponent(JSON.stringify([
  owner, target.projectId ?? '', target.projectId ? '' : target.runId ?? '',
]));
export const organizationValues = (item?: ResearchPersonalProblem): OrganizationValues => ({
  pinned: item?.pinned ?? false, status: item?.status ?? 'active', tags: item?.tags.join(', ') ?? '', nextNote: item?.nextNote ?? '',
});

export function readOrganizationDraft(storage: DraftStorage, key: string): OrganizationDraft | undefined {
  const raw = storage.getItem(key); if (raw === null) return;
  const draft = JSON.parse(raw) as OrganizationDraft;
  if (!draft || !Number.isInteger(draft.baseRevision) || !draft.values || typeof draft.values.pinned !== 'boolean'
    || !['active', 'parked', 'archived'].includes(draft.values.status) || typeof draft.values.tags !== 'string'
    || typeof draft.values.nextNote !== 'string' || !Array.isArray(draft.edited)
    || draft.edited.some(field => !['pinned', 'status', 'tags', 'nextNote'].includes(field))) throw new Error('Invalid organization draft');
  return draft;
}
export function writeOrganizationDraft(storage: DraftStorage, key: string, draft: OrganizationDraft) { storage.setItem(key, JSON.stringify(draft)); }
export function mergeOrganizationEdits(saved: OrganizationValues, current: OrganizationValues, edited: ReadonlySet<OrganizationField>): OrganizationValues {
  return Object.fromEntries((Object.keys(saved) as OrganizationField[]).map(field => [field, edited.has(field) ? current[field] : saved[field]])) as OrganizationValues;
}
