export type ResearchDraftScope = {
  owner: string; projectId: string; kind: 'candidate' | 'discussion' | 'issue' | 'issue-reply'; statementVersionId?: string;
  runId?: string; taskId?: string; taskVersion?: string; commit?: string; issueId?: string; issueRevision?: number; sourceFeedbackId?: string;
};
export type ResearchDraft<T = unknown> = { schema: 'theorem-os.human-draft.v1'; scope: ResearchDraftScope; value: T; summary: string; updatedAt: string };
type DraftStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
const prefix = 'theoremos:human-draft:v1:';
export const researchDraftKey = (scope: ResearchDraftScope) => prefix + encodeURIComponent(JSON.stringify([
  scope.owner, scope.projectId, scope.kind, scope.statementVersionId ?? '', scope.runId ?? '', scope.taskId ?? '',
  scope.taskVersion ?? '', scope.commit ?? '', scope.issueId ?? '', scope.issueRevision ?? '', scope.sourceFeedbackId ?? '',
]));

/** Exact owner and frozen source identities are part of the storage key, never inferred at restore time. */
export class ResearchDraftStore {
  constructor(private readonly storage: DraftStorage) {}
  list<T>(owner: string, projectId: string, kind: ResearchDraftScope['kind']): ResearchDraft<T>[] {
    const result: ResearchDraft<T>[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(prefix)) continue;
      try {
        const item = JSON.parse(this.storage.getItem(key) ?? 'null') as ResearchDraft<T> | null;
        if (item?.schema === 'theorem-os.human-draft.v1' && item.scope?.owner === owner && item.scope.projectId === projectId
          && item.scope.kind === kind && typeof item.updatedAt === 'string' && key === researchDraftKey(item.scope)) result.push(item);
      } catch { /* A damaged record does not prevent reading another saved draft. */ }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  save<T>(scope: ResearchDraftScope, value: T, summary: string): ResearchDraft<T> {
    if (!scope.owner || !scope.projectId) throw new Error('Draft owner and project are required.');
    const item: ResearchDraft<T> = { schema: 'theorem-os.human-draft.v1', scope: { ...scope }, value, summary, updatedAt: new Date().toISOString() };
    this.storage.setItem(researchDraftKey(scope), JSON.stringify(item)); return item;
  }
  remove(scope: ResearchDraftScope) { this.storage.removeItem(researchDraftKey(scope)); }
  /** A delayed success must not remove edits made while the request was running. */
  removeIfUnchanged<T>(draft: ResearchDraft<T>) {
    const key = researchDraftKey(draft.scope), current = this.storage.getItem(key);
    if (current === JSON.stringify(draft)) this.storage.removeItem(key);
  }
}
