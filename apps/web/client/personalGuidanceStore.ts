import type { WebGuidanceInput, WebObservation } from '../collaboration';
import type { ResearchDraftValues } from '../researchPersonalTypes';
import type { ResearchDraft } from './researchDraftStore';
export type PersonalGuidanceAttempt = {
  body: Pick<WebGuidanceInput, 'id' | 'recipient' | 'taskRef' | 'text' | 'observationRef'>;
  planVersion: string;
  draft?: ResearchDraft<ResearchDraftValues['guidance']>;
  value: ResearchDraftValues['guidance'];
};
type GuidanceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const personalGuidanceKey = (owner: string, runId: string) => `theoremos:personal-guidance:v1:${encodeURIComponent(JSON.stringify([owner, runId]))}`;
export function readPersonalGuidance(storage: GuidanceStorage, owner: string, runId: string): PersonalGuidanceAttempt | undefined {
  const raw = storage.getItem(personalGuidanceKey(owner, runId)); if (raw === null) return;
  const value = JSON.parse(raw) as PersonalGuidanceAttempt | null, body = value?.body;
  if (!value || !body || !body.id || typeof body.id !== 'string' || typeof body.text !== 'string'
    || typeof value.planVersion !== 'string' || !value.value || value.value.text !== body.text
    || !['lead', 'task'].includes(body.recipient?.kind) || !Number.isInteger(body.observationRef?.sequence) || typeof body.observationRef?.stateDigest !== 'string'
    || body.recipient.kind === 'task' && (!body.taskRef?.id || !body.taskRef.version || body.recipient.id !== body.taskRef.id)
    || value.draft && (value.draft.scope.owner !== owner || value.draft.scope.runId !== runId || value.draft.scope.kind !== 'guidance')) throw new Error('Invalid saved guidance identity');
  return value;
}
export function savePersonalGuidance(storage: GuidanceStorage, owner: string, runId: string, value: PersonalGuidanceAttempt) {
  storage.setItem(personalGuidanceKey(owner, runId), JSON.stringify(value));
}
export function removePersonalGuidance(storage: GuidanceStorage, owner: string, runId: string, id: string) {
  if (readPersonalGuidance(storage, owner, runId)?.body.id === id) storage.removeItem(personalGuidanceKey(owner, runId));
}
export function personalGuidanceTargetCurrent(attempt: PersonalGuidanceAttempt, observation: WebObservation, running: boolean) {
  return running && attempt.planVersion === (observation.inspection.planVersion ?? '')
    && (!attempt.body.taskRef || observation.inspection.tasks.some(task => task.id === attempt.body.taskRef!.id && task.version === attempt.body.taskRef!.version));
}
