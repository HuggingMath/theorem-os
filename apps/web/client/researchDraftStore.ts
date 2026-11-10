import type { ResearchDraftScope as SharedResearchDraftScope } from '../researchPersonalTypes';
export type ResearchDraftScope = SharedResearchDraftScope & { localRevision?: string };
export type ResearchDraft<T = unknown> = { schema: 'theorem-os.human-draft.v1'; scope: ResearchDraftScope; value: T; summary: string; updatedAt: string; accountRevision?: number };
type DraftStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
const prefix = 'theoremos:human-draft:v1:';
export const researchDraftKey = (scope: ResearchDraftScope) => prefix + encodeURIComponent(JSON.stringify([
  scope.owner, scope.projectId, scope.kind, scope.statementVersionId ?? '', scope.runId ?? '', scope.taskId ?? '',
  scope.taskVersion ?? '', scope.commit ?? '', scope.issueId ?? '', scope.issueRevision ?? '', scope.sourceFeedbackId ?? '',
...(scope.localRevision ? [scope.localRevision] : []),
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
  save<T>(scope: ResearchDraftScope, value: T, summary: string, accountRevision?: number): ResearchDraft<T> {
    if (!scope.owner || !scope.projectId) throw new Error('Draft owner and project are required.');
    const item: ResearchDraft<T> = { schema: 'theorem-os.human-draft.v1', scope: { ...scope }, value, summary, updatedAt: new Date().toISOString(), ...(accountRevision !== undefined ? { accountRevision } : {}) };
    this.storage.setItem(researchDraftKey(scope), JSON.stringify(item)); return item;
  }
  /** Recovering a cloud version preserves different unsaved local work as a separate selectable backup. */
  restore<T>(item: ResearchDraft<T>): ResearchDraft<T> {
    const scope = { ...item.scope }; delete scope.localRevision;
    const saved = this.storage.getItem(researchDraftKey(scope));
    if (saved) {
      const previous = JSON.parse(saved) as ResearchDraft<T>;
      if (JSON.stringify(previous.value) !== JSON.stringify(item.value)) {
        const backup = { ...previous, scope: { ...scope, localRevision: crypto.randomUUID() } };
        this.storage.setItem(researchDraftKey(backup.scope), JSON.stringify(backup));
      }
    }
    return this.save(scope, item.value, item.summary, item.accountRevision);
  }
  markAccountRevision<T>(draft: ResearchDraft<T>, revision: number): ResearchDraft<T> | undefined {
    const key = researchDraftKey(draft.scope);
    if (this.storage.getItem(key) !== JSON.stringify(draft)) return;
    const updated = { ...draft, accountRevision: revision }; this.storage.setItem(key, JSON.stringify(updated)); return updated;
  }
  remove(scope: ResearchDraftScope) { this.storage.removeItem(researchDraftKey(scope)); }
  /** A delayed success must not remove edits made while the request was running. */
  removeIfUnchanged<T>(draft: ResearchDraft<T>) {
    const key = researchDraftKey(draft.scope), current = this.storage.getItem(key);
    if (current === JSON.stringify(draft)) this.storage.removeItem(key);
  }
}
