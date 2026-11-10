export type PersonalApprovalAttempt = { id: string; planVersion: string };
type ApprovalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const personalApprovalKey = (owner: string, runId: string) => `theoremos:personal-approval:v1:${encodeURIComponent(JSON.stringify([owner, runId]))}`;

/** Only the original command identity is retained; no source, credentials or profile is stored. */
export function readPersonalApproval(storage: ApprovalStorage, owner: string, runId: string): PersonalApprovalAttempt | undefined {
  const raw = storage.getItem(personalApprovalKey(owner, runId));
  if (raw === null) return;
  const value = JSON.parse(raw) as Partial<PersonalApprovalAttempt> | null;
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.planVersion !== 'string' || !value.planVersion) throw new Error('Invalid saved approval identity');
  return { id: value.id, planVersion: value.planVersion };
}
export function savePersonalApproval(storage: ApprovalStorage, owner: string, runId: string, attempt: PersonalApprovalAttempt) {
  storage.setItem(personalApprovalKey(owner, runId), JSON.stringify(attempt));
}
export function removePersonalApproval(storage: ApprovalStorage, owner: string, runId: string, id: string) {
  if (readPersonalApproval(storage, owner, runId)?.id === id) storage.removeItem(personalApprovalKey(owner, runId));
}
