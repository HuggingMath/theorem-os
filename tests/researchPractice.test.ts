import { describe, expect, it } from 'vitest';
import { LOCAL_EXAMPLE_FAILED_PROOF, LOCAL_EXAMPLE_PROOF } from '../src/math/localExample';
import { approvePracticePlan, changePracticePlan, currentPracticeGuidance, exportPracticeRecord, initialPracticeState,
  practiceAcceptedSource, practiceFailedSource, practiceHasRepair, recordedPracticeEvidence, restorePracticeState,
  savePracticeReceipt, sendPracticeGuidance } from '../apps/web/client/researchPracticeModel';

const at = '2026-11-10T12:00:00.000Z';
describe('an exercise keeps local decisions separate from original verification', () => {
  it('uses the canonical recorded tutorial sources and retains the original receipt identities and date', () => {
    expect(practiceFailedSource).toBe(LOCAL_EXAMPLE_FAILED_PROOF);
    expect(practiceAcceptedSource).toBe(LOCAL_EXAMPLE_PROOF);
    expect(recordedPracticeEvidence.targets.map(item => item.theorem)).toEqual(['Tutorial.add_zero', 'Tutorial.zero_add']);
    const record = exportPracticeRecord(initialPracticeState());
    expect(record.modelInvoked).toBe(false); expect(record.leanInvoked).toBe(false);
    expect(record.originalRecording.evidence.checkedAt).toBe('2026-10-15T20:07:24.675Z');
  });

  it('requires approval before accepting guidance or saving any original receipt reference', () => {
    const start = initialPracticeState();
    expect(sendPracticeGuidance(start, 'use-lemma', '', at)).toBe(start);
    expect(savePracticeReceipt(start, at)).toBe(start);
    expect(practiceHasRepair(start)).toBe(false);
  });

  it('rejects dropping an original target, then permits a repair without rewriting the original evidence', () => {
    const approved = approvePracticePlan(initialPracticeState());
    const declined = sendPracticeGuidance(approved, 'drop-goal', 'keep my note', at);
    expect(declined.guidance[0]).toMatchObject({ accepted: false, revision: 1, note: 'keep my note' });
    expect(savePracticeReceipt(declined, at)).toBe(declined);
    const repaired = sendPracticeGuidance(declined, 'use-lemma', 'keep both targets', at);
    expect(practiceHasRepair(repaired)).toBe(true);
    const saved = savePracticeReceipt(repaired, at);
    expect(saved.savedReceipt).toEqual({ revision: 1, at });
    expect(exportPracticeRecord(saved).originalRecording.evidence.targets).toHaveLength(2);
    expect(sendPracticeGuidance(saved, 'drop-goal', 'later', at)).toBe(saved);
  });

  it('invalidates approval and current receipt links after a plan change while retaining earlier guidance', () => {
    const completed = savePracticeReceipt(sendPracticeGuidance(approvePracticePlan(initialPracticeState()), 'use-lemma', '', at), at);
    const revised = changePracticePlan(completed, { route: 'split', note: 'Check the right goal first' });
    expect(revised.revision).toBe(2); expect(revised.approvedRevision).toBeNull();
    expect(revised.savedReceipt).toBeUndefined(); expect(practiceHasRepair(revised)).toBe(false);
    expect(revised.guidance).toHaveLength(1); expect(currentPracticeGuidance(revised)).toEqual([]);
    expect(practiceHasRepair(approvePracticePlan(revised))).toBe(false);
  });

  it('restores a completed exercise without generating new actions or a new verification date', () => {
    const completed = savePracticeReceipt(sendPracticeGuidance(approvePracticePlan(initialPracticeState()), 'use-lemma', 'A note', at), at);
    expect(restorePracticeState(JSON.stringify(completed))).toEqual(completed);
    expect(exportPracticeRecord(restorePracticeState(JSON.stringify(completed))).originalRecording.evidence.checkedAt).not.toBe(at);
    expect(restorePracticeState('{broken')).toEqual(initialPracticeState());
    expect(restorePracticeState(JSON.stringify({ ...completed, revision: 2 }))).toEqual(initialPracticeState());
  });
});
