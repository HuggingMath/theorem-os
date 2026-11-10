import { describe, expect, it } from 'vitest';
import { ResearchProjectDraft } from '../apps/web/client/researchProjectDraft';

function store() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const scope = { owner: 'alice', projectId: 'project-a', runId: 'run-a', statementVersionId: 'statement-a' };
const baseSource = { taskId: 'lemma', taskVersion: 'v1', commit: 'commit-a', sourceDigest: 'source-a', environmentDigest: 'mathlib-a',
  file: 'Submission.lean', source: 'original source', scope: 'owned-file' as const };

describe('research project input recovery', () => {
  it('restores candidate text and its original base after leaving a run and refreshing', () => {
    const storage = store(), draft = new ResearchProjectDraft(scope, 'proof', () => storage);
    draft.update({ source: '  edited source\n', text: 'Why the proof changes.', edited: true, baseSource,
      baseObservation: { sequence: 17, stateDigest: 'snapshot-a' } });
    const other = new ResearchProjectDraft({ ...scope, runId: 'run-b' }, 'proof', () => storage);
    other.update({ source: 'another run' });
    const restored = new ResearchProjectDraft(scope, 'proof', () => storage);
    expect(restored.restored).toBe(true);
    expect(restored.value).toEqual(draft.value);
    expect(restored.value.baseSource?.taskVersion).toBe('v1');
    expect(new ResearchProjectDraft({ ...scope, owner: 'bob' }, 'proof', () => storage).value.source).toBe('');
    expect(new ResearchProjectDraft({ ...scope, projectId: 'project-b' }, 'proof', () => storage).value.source).toBe('');
    expect(new ResearchProjectDraft({ ...scope, statementVersionId: 'statement-b' }, 'proof', () => storage).value.source).toBe('');
  });

  it('a delayed successful submission preserves edits made after it, including from a remounted form', () => {
    const storage = store(), submitted = new ResearchProjectDraft(scope, 'discussion', () => storage);
    submitted.update({ text: 'First question', visibility: 'public' });
    const revision = submitted.revision;
    const returned = new ResearchProjectDraft(scope, 'discussion', () => storage);
    returned.update({ text: 'A newer question' });
    expect(submitted.clearSubmitted(revision)).toBe(false);
    expect(new ResearchProjectDraft(scope, 'discussion', () => storage).value.text).toBe('A newer question');
    expect(returned.clearSubmitted(returned.revision)).toBe(true);
    expect(new ResearchProjectDraft(scope, 'discussion', () => storage).restored).toBe(false);
  });

  it('restores the full unsent statement independently of discussion and candidate inputs', () => {
    const storage = store(), draft = new ResearchProjectDraft(scope, 'statement', () => storage);
    draft.update({ statement: 'A statement', source: 'Lean source', assumptions: 'Hypothesis A', targets: 'Main.result | Main.lean',
      importedRun: 'run-a', formalizationId: 'formal-a', environmentDigest: 'env-a', confirmed: true });
    expect(new ResearchProjectDraft(scope, 'statement', () => storage).value).toEqual(draft.value);
    expect(new ResearchProjectDraft(scope, 'discussion', () => storage).value.text).toBe('');
    expect(draft.clearSubmitted(draft.revision)).toBe(true);
    expect(new ResearchProjectDraft(scope, 'statement', () => storage).value.statement).toBe('');
  });

  it('ignores incomplete stored proof bases and keeps editing usable when storage fails', () => {
    const storage = store(), draft = new ResearchProjectDraft(scope, 'proof', () => storage);
    draft.update({ source: 'edited', baseSource });
    expect(new ResearchProjectDraft(scope, 'proof', () => storage).restored).toBe(false);
    const unavailable = new ResearchProjectDraft(scope, 'discussion', () => { throw new Error('Storage unavailable'); });
    unavailable.update({ text: 'Keep editing' });
    expect(unavailable.value.text).toBe('Keep editing');
    expect(unavailable.clearSubmitted(unavailable.revision)).toBe(true);
  });
});
