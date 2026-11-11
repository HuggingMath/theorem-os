import type { WebCommandResult, WebObservation } from '../collaboration';

export type PersonalApprovalAttempt = { id: string; planVersion: string };
type ApprovalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const personalApprovalKey = (owner: string, runId: string) => `theoremos:personal-approval:v1:${encodeURIComponent(JSON.stringify([owner, runId]))}`;
const reviewKey = (owner: string, runId: string) => `theoremos:personal-approval-review:v1:${encodeURIComponent(JSON.stringify([owner, runId]))}`;
export function personalApprovalNeedsReview(storage: ApprovalStorage, owner: string, runId: string): boolean {
  return storage.getItem(reviewKey(owner, runId)) !== null;
}
export function requirePersonalApprovalReview(storage: ApprovalStorage, owner: string, runId: string) {
  storage.setItem(reviewKey(owner, runId), 'required');
}
export function completePersonalApprovalReview(storage: ApprovalStorage, owner: string, runId: string) {
  storage.removeItem(reviewKey(owner, runId));
}

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

/** A transport failure or unknown result never settles the owner's decision. */
export function personalApprovalSettled(attempt: PersonalApprovalAttempt, receipt: WebCommandResult): boolean {
  if (receipt.id !== attempt.id) throw new Error('Approval receipt does not match the original submission');
  return ['approved', 'rejected', 'failed'].includes(receipt.status);
}
export function observedPersonalApproval(attempt: PersonalApprovalAttempt, observation?: WebObservation): WebCommandResult | undefined {
  const approval = observation?.inspection.planApproval;
  if (approval?.approvedId === attempt.id) return { id: attempt.id, status: 'approved', planVersion: approval.approvedVersion };
  const rejected = approval?.rejections.find(item => item.id === attempt.id);
  if (rejected) return { id: attempt.id, status: 'rejected', reason: rejected.reason, planVersion: rejected.planVersion };
}

/** Read first; only an explicit retry of a missing receipt may resend the original exact plan. */
export async function checkPersonalApproval({ root, attempt, request, missing, retry, currentPlanVersion }: {
  root: string; attempt: PersonalApprovalAttempt;
  request(url: string, init?: RequestInit): Promise<{ receipt: WebCommandResult }>;
  missing(error: unknown): boolean; retry: boolean; currentPlanVersion?: string;
}): Promise<WebCommandResult | undefined> {
  let receipt: WebCommandResult;
  try { receipt = (await request(`${root}/commands/${encodeURIComponent(attempt.id)}`)).receipt; }
  catch (cause) {
    if (!missing(cause)) throw cause;
    if (!retry || currentPlanVersion !== attempt.planVersion) return;
    receipt = (await request(`${root}/plan-approval`, { method: 'POST', body: JSON.stringify(attempt) })).receipt;
  }
  personalApprovalSettled(attempt, receipt);
  return receipt;
}
