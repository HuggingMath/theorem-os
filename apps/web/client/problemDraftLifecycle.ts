import type { ProblemDraftValue } from '../problemDraftTypes';
import type { ResearchAccountDraft, ResearchAccountDraftResult, ResearchDraftSubmission } from '../researchPersonalTypes';

export type ProblemDraftRequest = <T>(url: string, init?: RequestInit) => Promise<T>;
export type ProblemDraftBinding = { draftKey: string; revision: number; title: string; draftId?: string; versionId?: string; savedSignature?: string };
export const problemDraftApi = '/api/research/personal/drafts';
const bindingKey = (owner: string, mode: ProblemDraftValue['mode']) => `theorem-os.problem-draft.${owner}.${mode}`;
const pendingKey = (owner: string) => `theorem-os.problem-draft-pending.${owner}`;
const memory = new Map<string, string>();
function read(key: string) { try { return sessionStorage.getItem(key) ?? undefined; } catch { return memory.get(key); } }
function write(key: string, value: unknown) {
  const encoded = JSON.stringify(value); memory.set(key, encoded);
  try { sessionStorage.setItem(key, encoded); } catch { /* Saving account drafts still works without tab storage. */ }
}
export function clearProblemDraftTabMemory() { memory.clear(); }
export const problemDraftSignature = (value: ProblemDraftValue, title: string) => JSON.stringify([title, value], (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
export function readProblemDraftBinding(owner: string, mode: ProblemDraftValue['mode']): ProblemDraftBinding {
  try {
    const value = JSON.parse(read(bindingKey(owner, mode)) ?? 'null') as ProblemDraftBinding | null;
    if (value && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value.draftKey) && Number.isSafeInteger(value.revision) && value.revision >= 0 && typeof value.title === 'string') return value;
  } catch { /* An unavailable tab backup does not block the editor. */ }
  const value = { draftKey: crypto.randomUUID(), revision: 0, title: '' }; write(bindingKey(owner, mode), value); return value;
}
export function rememberProblemDraftBinding(owner: string, mode: ProblemDraftValue['mode'], binding: ProblemDraftBinding, announce = false) {
  write(bindingKey(owner, mode), binding);
  if (announce && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('theoremos-problem-draft-restored', { detail: { owner, mode, binding } }));
}
export function resetProblemDraftBinding(owner: string, mode: ProblemDraftValue['mode']) {
  rememberProblemDraftBinding(owner, mode, { draftKey: crypto.randomUUID(), revision: 0, title: '' }, true);
}
export function problemDraftDeviceId() {
  try { const key = 'theoremos:research-draft-device', id = localStorage.getItem(key) ?? crypto.randomUUID(); localStorage.setItem(key, id); return id; }
  catch { return crypto.randomUUID(); }
}
export type ProblemDraftSubmissionSnapshot = { owner: string; binding: ProblemDraftBinding; value: ProblemDraftValue };
/** Capture before sending; a later response must never archive a different editor value. */
export function captureProblemDraftSubmission(owner: string, value: ProblemDraftValue): ProblemDraftSubmissionSnapshot | undefined {
  const binding = readProblemDraftBinding(owner, value.mode);
  return binding.revision > 0 ? { owner, binding: structuredClone(binding), value: structuredClone(value) } : undefined;
}
type Completion = { snapshot: ProblemDraftSubmissionSnapshot; submission: Pick<ResearchDraftSubmission, 'kind' | 'id'>;
  requestId: string; deviceId: string; clientUpdatedAt: string };
function pending(owner: string): Completion[] {
  try { return JSON.parse(read(pendingKey(owner)) ?? '[]') as Completion[]; } catch { return []; }
}
export function problemDraftSyncPending(owner: string) { return pending(owner).length > 0; }
const synchronizing = new Map<string, Promise<boolean>>();
export async function syncProblemDraftSubmissions(owner: string, request: ProblemDraftRequest): Promise<boolean> {
  const current = synchronizing.get(owner); if (current) return current;
  const work = (async () => {
    while (pending(owner).length) {
      const item = pending(owner)[0];
      try {
        const { binding, value } = item.snapshot;
        let draftId = binding.draftId, versionId = binding.versionId;
        if (!draftId || !versionId) {
          const { items } = await request<{ items: ResearchAccountDraft[] }>(`${problemDraftApi}?kind=problem&status=all`);
          const draft = items.find(draft => draft.scope.draftKey === binding.draftKey);
          draftId = draft?.id; versionId = draft?.versions.find(version => version.revision === binding.revision)?.id;
        }
        if (!draftId || !versionId) throw new Error('Saved problem draft version is unavailable.');
        const { item: saved } = await request<{ item: ResearchAccountDraftResult<ProblemDraftValue> }>(`${problemDraftApi}/${encodeURIComponent(draftId)}?version=${encodeURIComponent(versionId)}`);
        if (problemDraftSignature(saved.version.value, saved.version.summary) !== problemDraftSignature(value, binding.title.trim())
          || saved.version.status === 'submitted' && (saved.version.submission?.kind !== item.submission.kind || saved.version.submission.id !== item.submission.id)) {
          const { item: submitted } = await request<{ item: ResearchAccountDraftResult<ProblemDraftValue> }>(problemDraftApi, { method: 'POST', body: JSON.stringify({
            requestId: item.requestId, expectedRevision: binding.revision, scope: { kind: 'problem', draftKey: binding.draftKey },
            value, summary: binding.title.trim() || saved.version.summary, deviceId: item.deviceId, deviceName: saved.version.deviceName, clientUpdatedAt: item.clientUpdatedAt,
          }) });
          versionId = submitted.version.id;
        }
        await request(`${problemDraftApi}/${encodeURIComponent(draftId)}`, { method: 'PATCH', body: JSON.stringify({
          requestId: `${item.requestId}-archive`, versionId, action: 'submitted', submission: item.submission,
        }) });
        write(pendingKey(owner), pending(owner).filter(other => other.requestId !== item.requestId));
        const active = readProblemDraftBinding(owner, value.mode);
        if (JSON.stringify(active) === JSON.stringify(binding)) resetProblemDraftBinding(owner, value.mode);
      } catch { return false; }
    }
    return true;
  })();
  synchronizing.set(owner, work);
  try { return await work; } finally { synchronizing.delete(owner); }
}
/** Call only after the server has returned an actual task. Unknown or rejected sends never enter this queue. */
export async function completeProblemDraftSubmission(snapshot: ProblemDraftSubmissionSnapshot | undefined,
  submission: Pick<ResearchDraftSubmission, 'kind' | 'id'>, request: ProblemDraftRequest): Promise<boolean> {
  if (!snapshot) return true;
  const items = pending(snapshot.owner);
  if (!items.some(item => item.submission.kind === submission.kind && item.submission.id === submission.id)) {
    items.push({ snapshot, submission, requestId: crypto.randomUUID(), deviceId: problemDraftDeviceId(), clientUpdatedAt: new Date().toISOString() });
    write(pendingKey(snapshot.owner), items);
  }
  return syncProblemDraftSubmissions(snapshot.owner, request);
}
