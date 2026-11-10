import { useRef, useState } from 'preact/hooks';
import type { WebTaskSource } from '../collaboration';

export type ResearchStatementDraft = {
  statement: string; source: string; environment: 'standard' | 'mathlib'; assumptions: string; targets: string; confirmed: boolean;
  importedRun: string; formalizationId?: string; environmentDigest?: string;
};
export type ResearchDiscussionDraft = { text: string; visibility: 'members' | 'public' };
export type ResearchProofDraft = {
  source: string; text: string; edited: boolean; baseSource?: WebTaskSource;
  baseObservation?: { sequence: number; stateDigest: string };
};
type Drafts = { statement: ResearchStatementDraft; discussion: ResearchDiscussionDraft; proof: ResearchProofDraft };
type DraftScope = { owner: string; projectId: string; runId?: string; statementVersionId?: string };
type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const schema = 'theorem-os.research-project-draft.v1';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string');
const optionalStrings = (value: Record<string, unknown>, keys: string[]) => keys.every(key => value[key] === undefined || typeof value[key] === 'string');
const defaults = {
  statement: (): ResearchStatementDraft => ({ statement: '', source: '', environment: 'mathlib', assumptions: '', targets: '', confirmed: false, importedRun: '' }),
  discussion: (): ResearchDiscussionDraft => ({ text: '', visibility: 'members' }),
  proof: (): ResearchProofDraft => ({ source: '', text: '', edited: false }),
};
function decode(kind: keyof Drafts, value: unknown): Drafts[keyof Drafts] | undefined {
  if (!record(value)) return;
  if (kind === 'statement' && strings(value, ['statement', 'source', 'environment', 'assumptions', 'targets', 'importedRun'])
    && ['standard', 'mathlib'].includes(String(value.environment)) && typeof value.confirmed === 'boolean'
    && optionalStrings(value, ['formalizationId', 'environmentDigest']))
    return { statement: value.statement as string, source: value.source as string, environment: value.environment as ResearchStatementDraft['environment'],
      assumptions: value.assumptions as string, targets: value.targets as string, importedRun: value.importedRun as string, confirmed: value.confirmed,
      ...(value.formalizationId !== undefined ? { formalizationId: value.formalizationId as string } : {}),
      ...(value.environmentDigest !== undefined ? { environmentDigest: value.environmentDigest as string } : {}) };
  if (kind === 'discussion' && typeof value.text === 'string' && ['members', 'public'].includes(String(value.visibility)))
    return { text: value.text, visibility: value.visibility as ResearchDiscussionDraft['visibility'] };
  if (kind !== 'proof' || !strings(value, ['source', 'text']) || typeof value.edited !== 'boolean') return;
  const base = value.baseSource, observation = value.baseObservation;
  if ((base === undefined) !== (observation === undefined)) return;
  if (base !== undefined && (!record(base) || !strings(base, ['taskId', 'taskVersion', 'commit', 'sourceDigest', 'environmentDigest', 'file', 'source'])
    || base.scope !== 'owned-file' || !record(observation) || !Number.isSafeInteger(observation.sequence) || Number(observation.sequence) < 0
    || typeof observation.stateDigest !== 'string')) return;
  return { source: value.source as string, text: value.text as string, edited: value.edited,
    ...(base && record(observation) ? { baseSource: structuredClone(base) as WebTaskSource,
      baseObservation: { sequence: Number(observation.sequence), stateDigest: String(observation.stateDigest) } } : {}) };
}

/** Per-owner form state. A save receipt can clear only the exact input revision that was sent. */
export class ResearchProjectDraft<K extends keyof Drafts> {
  readonly key: string;
  value: Drafts[K];
  revision = '';
  restored = false;
  private persisted = false;
  constructor(readonly scope: DraftScope, readonly kind: K, private readonly storage: () => StorageAccess = () => sessionStorage) {
    this.key = `${schema}.${encodeURIComponent(JSON.stringify([scope.owner, scope.projectId, kind, scope.runId ?? '', scope.statementVersionId ?? '']))}`;
    this.value = defaults[kind]() as Drafts[K];
    try {
      const saved: unknown = JSON.parse(this.storage().getItem(this.key) ?? 'null');
      if (!record(saved) || saved.schema !== schema || saved.owner !== scope.owner || typeof saved.revision !== 'string') return;
      const value = decode(kind, saved.value); if (!value) return;
      this.value = value as Drafts[K]; this.revision = saved.revision; this.restored = this.persisted = true;
    } catch { /* Editing remains available if storage is unavailable or an old draft cannot be read. */ }
  }
  update(value: Partial<Drafts[K]>) {
    this.value = { ...this.value, ...value }; this.revision = crypto.randomUUID();
    try {
      this.storage().setItem(this.key, JSON.stringify({ schema, owner: this.scope.owner, revision: this.revision, value: this.value }));
      this.persisted = true;
    } catch { this.persisted = false; }
  }
  clearSubmitted(revision: string): boolean {
    if (this.revision !== revision) return false;
    try {
      if (this.persisted) {
        const saved: unknown = JSON.parse(this.storage().getItem(this.key) ?? 'null');
        if (!record(saved) || saved.revision !== revision) return false;
      }
      this.storage().removeItem(this.key);
    } catch { /* The current input can still clear after a successful submission without storage. */ }
    const previous = this.value;
    this.value = { ...defaults[this.kind](),
      ...(this.kind === 'statement' ? { environment: (previous as ResearchStatementDraft).environment } : {}),
      ...(this.kind === 'discussion' ? { visibility: (previous as ResearchDiscussionDraft).visibility } : {}) } as Drafts[K];
    this.revision = ''; this.restored = this.persisted = false;
    return true;
  }
}

export function useResearchProjectDraft<K extends keyof Drafts>(scope: DraftScope, kind: K) {
  const ref = useRef<ResearchProjectDraft<K>>(), [, redraw] = useState(0);
  ref.current ??= new ResearchProjectDraft(scope, kind);
  const draft = ref.current;
  return { value: draft.value, revision: draft.revision, restored: draft.restored,
    update: (value: Partial<Drafts[K]>) => { draft.update(value); redraw(value => value + 1); },
    clearSubmitted: (revision: string) => { const cleared = draft.clearSubmitted(revision); if (cleared) redraw(value => value + 1); return cleared; } };
}
