import evidence from '../../../docs/assets/replay.json';

export const practiceStorageKey = 'theorem-os.research-practice.v1';
export type PracticePlan = { route: 'direct' | 'split'; note: string };
export type PracticeInstruction = 'use-lemma' | 'drop-goal';
export type PracticeGuidance = { id: number; revision: number; instruction: PracticeInstruction; note: string; at: string; accepted: boolean };
export type PracticeState = { schema: 1; plan: PracticePlan; revision: number; approvedRevision: number | null;
  guidance: PracticeGuidance[]; savedReceipt?: { revision: number; at: string } };

export const recordedPracticeEvidence = evidence;
export const practiceFailedSource = 'namespace Tutorial\n\ntheorem add_zero (n : Nat) : n + 0 = n := by rfl\n\ntheorem zero_add (n : Nat) : 0 + n = n := by rfl\n\nend Tutorial\n';
export const practiceAcceptedSource = practiceFailedSource.replace('zero_add (n : Nat) : 0 + n = n := by rfl', 'zero_add (n : Nat) : 0 + n = n := by exact Nat.zero_add n');

export const initialPracticeState = (): PracticeState => ({ schema: 1, plan: { route: 'direct', note: '' }, revision: 1, approvedRevision: null, guidance: [] });
export const currentPracticeGuidance = (state: PracticeState) => state.guidance.filter(item => item.revision === state.revision);
export const practiceHasRepair = (state: PracticeState) => state.approvedRevision === state.revision && currentPracticeGuidance(state).some(item => item.accepted);

export function changePracticePlan(state: PracticeState, plan: PracticePlan): PracticeState {
  const note = plan.note.trim().slice(0, 600);
  if (state.plan.route === plan.route && state.plan.note === note) return state;
  return { ...state, plan: { route: plan.route, note }, revision: state.revision + 1, approvedRevision: null, savedReceipt: undefined };
}
export function approvePracticePlan(state: PracticeState): PracticeState {
  return { ...state, approvedRevision: state.revision };
}
export function sendPracticeGuidance(state: PracticeState, instruction: PracticeInstruction, note: string, at: string): PracticeState {
  if (state.approvedRevision !== state.revision || practiceHasRepair(state)) return state;
  const next = { id: (state.guidance.at(-1)?.id ?? 0) + 1, revision: state.revision, instruction, note: note.trim().slice(0, 600), at, accepted: instruction === 'use-lemma' };
  return { ...state, guidance: [...state.guidance, next].slice(-40), savedReceipt: undefined };
}
export function savePracticeReceipt(state: PracticeState, at: string): PracticeState {
  return practiceHasRepair(state) ? { ...state, savedReceipt: { revision: state.revision, at } } : state;
}

/** Keep only the small, typed local exercise. A previous exercise never creates a real run or acceptance record. */
export function restorePracticeState(serialized: string | null): PracticeState {
  if (!serialized) return initialPracticeState();
  try {
    const value = JSON.parse(serialized) as PracticeState;
    if (value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !value.plan || !['direct', 'split'].includes(value.plan.route) || typeof value.plan.note !== 'string'
      || value.plan.note.length > 600 || !Array.isArray(value.guidance) || value.guidance.length > 40
      || (value.approvedRevision !== null && value.approvedRevision !== value.revision)) return initialPracticeState();
    for (const item of value.guidance) {
      if (!item || !Number.isSafeInteger(item.id) || !Number.isSafeInteger(item.revision) || item.revision > value.revision
        || !['use-lemma', 'drop-goal'].includes(item.instruction) || typeof item.note !== 'string' || item.note.length > 600
        || typeof item.at !== 'string' || item.accepted !== (item.instruction === 'use-lemma')) return initialPracticeState();
    }
    if (value.savedReceipt && (value.savedReceipt.revision !== value.revision || typeof value.savedReceipt.at !== 'string' || !practiceHasRepair(value))) return initialPracticeState();
    return { schema: 1, plan: { ...value.plan }, revision: value.revision, approvedRevision: value.approvedRevision,
      guidance: value.guidance.map(item => ({ ...item })), ...(value.savedReceipt ? { savedReceipt: { ...value.savedReceipt } } : {}) };
  } catch { return initialPracticeState(); }
}

export function exportPracticeRecord(state: PracticeState) {
  return { schema: 'theoremos.research-practice.v1', mode: 'recorded-practice', modelInvoked: false, leanInvoked: false,
    exercise: state, originalRecording: { evidence: recordedPracticeEvidence, proof: practiceAcceptedSource },
    note: 'Exercise choices are local practice. The Lean receipts belong to the original recording and do not certify exercise inputs.' };
}
