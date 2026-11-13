import { describe, expect, it } from 'vitest';
import { chatMathematics, chatMathematicsSummary } from '../apps/web/client/chatMathematics';
import type { WebFormalizationActivity, WebFormalizationRoleSummary } from '../apps/web/formalizationTypes';
import type { WebRun } from '../apps/web/shared';

type Task = NonNullable<WebRun['observation']>['inspection']['tasks'][number];
const task = (id: string, changes: Partial<Task> = {}): Task => ({ id, kind: 'lemma', objective: `Objective ${id}`, group: 'main',
  status: 'completed', control: 'active', version: 'v1', premises: [], plannedDependencies: [], attempts: 1,
  proof: { status: 'checked', receiptIds: [id], conditions: [] }, parkedBy: [], parkedRoutes: {}, ...changes });
const recorded = (tasks: Task[]) => ({ updatedAt: '2099-01-01T00:00:00.000Z',
  observation: { observedAt: '2098-01-01T00:00:00.000Z', inspection: { tasks } } } as WebRun);
function role(sequence: number, summary: WebFormalizationRoleSummary, kind: 'plan' | 'backtranslate' | 'compare' = 'plan'): WebFormalizationActivity {
  return { type: 'step', sequence, at: `2026-11-10T07:0${sequence}:00.000Z`, step: { step: 'role', state: 'finished', role: kind,
    workerId: `role-${sequence}`, slot: kind, round: 1, summary } };
}

describe('mathematical progress from recorded work', () => {
  it('omits empty summaries and statements already shown without changing the saved records', () => {
    expect(chatMathematicsSummary(undefined, [])).toBeUndefined();
    expect(chatMathematicsSummary(chatMathematics(), [])).toBeUndefined();
    const recorded = { ...chatMathematics(), latest: { kind: 'statement' as const, text: 'For every n, n + 1 = 1 + n.' } };
    expect(chatMathematicsSummary(recorded, ['  For every n, n + 1 = 1 + n.\n'])).toBeUndefined();
    expect(recorded.latest.text).toBe('For every n, n + 1 = 1 + n.');
  });

  it('retains different statements, research findings and actual mathematical work beside a repeated statement', () => {
    const work = { ...chatMathematics(), latest: { kind: 'statement' as const, text: 'The goal also needs n > 0.' } };
    expect(chatMathematicsSummary(work, ['For every n, n + 1 = 1 + n.'])).toEqual(work);
    const finding = { ...work, latest: { kind: 'finding' as const, text: 'The goal also needs n > 0.' } };
    expect(chatMathematicsSummary(finding, [finding.latest.text])).toEqual(finding);
    const blocked = { ...work, blockers: [{ id: 'goal', text: 'The induction step is still missing.' }] };
    expect(chatMathematicsSummary(blocked, [work.latest.text])).toEqual({ ...blocked, latest: undefined });
    expect(blocked.latest).toEqual(work.latest);
  });

  it('does not invent work, acceptance or timestamps when there are no records', () => {
    expect(chatMathematics()).toEqual({ checked: [], working: [], blockers: [] });
    expect(chatMathematics(recorded([]))).toEqual({ checked: [], working: [], blockers: [] });
  });

  it('counts only active unconditional checked lemma and goal tasks', () => {
    const value = chatMathematics(recorded([
      task('lemma', { theorem: 'Algebra.helper', informalStatement: 'A reusable group identity.' }), task('goal', { kind: 'goal' }),
      task('conditional', { proof: { status: 'conditional', receiptIds: [], conditions: [{ taskId: 'pending', taskDigest: 'v1' }] } }),
      task('checked-with-conditions', { proof: { status: 'checked', receiptIds: [], conditions: [{ taskId: 'pending', taskDigest: 'v1' }] } }),
      task('paused', { control: 'paused' }), task('abandoned', { control: 'abandoned' }),
      task('research', { kind: 'research' }), task('candidate', { proof: { status: 'unchecked', receiptIds: [], conditions: [] } }),
    ]));
    expect(value.checked).toEqual([{ id: 'lemma', name: 'Algebra.helper', statement: 'A reusable group identity.' },
      { id: 'goal', name: 'goal', statement: 'Objective goal' }]);
    expect(value).not.toHaveProperty('accepted');
  });

  it('keeps active attempts distinct from checked helpers and uses meaningful statement fallbacks', () => {
    const value = chatMathematics(recorded([
      task('checked', { status: 'running' }),
      task('running', { status: 'running', proof: { status: 'none', receiptIds: [] }, objective: '', type: 'n = n' }),
      task('delivered', { status: 'delivered', proof: { status: 'unchecked', receiptIds: [] }, theorem: 'My.delivered' }),
      task('conditional', { status: 'conditional', proof: { status: 'conditional', receiptIds: [] } }),
      task('paused', { status: 'running', control: 'paused', proof: { status: 'none', receiptIds: [] } }),
    ]));
    expect(value.working.map(item => item.id)).toEqual(['running', 'delivered', 'conditional']);
    expect(value.working.map(item => item.status)).toEqual(['running', 'delivered', 'conditional']);
    expect(value.working[0]!.statement).toBe('n = n'); expect(value.working[1]!.name).toBe('My.delivered');
    expect(value.checked.map(item => item.id)).toEqual(['checked']);
  });

  it('reads active blockers from findings, feedback or the task contract and ignores paused failures', () => {
    const value = chatMathematics(recorded([
      task('blocked', { status: 'blocked', finding: 'A normal closure construction is still missing.' }),
      task('failed', { status: 'failed', feedback: 'The current Lean lemma has an unsolved goal.' }),
      task('contract', { status: 'blocked', informalStatement: 'Prove the embedding extends.' }),
      task('paused', { status: 'failed', control: 'paused', finding: 'Old, paused route' }),
    ]));
    expect(value.blockers).toEqual([{ id: 'blocked', text: 'A normal closure construction is still missing.' },
      { id: 'failed', text: 'The current Lean lemma has an unsolved goal.' }, { id: 'contract', text: 'Prove the embedding extends.' }]);
    expect(value.latest).toEqual({ kind: 'finding', text: 'A normal closure construction is still missing.' });
    expect(value.latest).not.toHaveProperty('at');
  });

  it('preserves an actual statement record timestamp and prioritizes explicit mathematical sections', () => {
    const activity = [role(1, { text: 'General progress prose', sections: [{ kind: 'conclusions', items: ['The target is a field isomorphism.'] },
      { kind: 'unresolved', items: ['Not a conclusion'] }] }),
      role(2, { text: 'Blind backtranslation', sections: [{ kind: 'definitions', items: ['Adjoin all required roots of unity.'] },
        { kind: 'targets', items: ['Compare the radical tower with the Galois group.'] }] }, 'backtranslate'),
      role(3, { text: 'Reviewer approval is not a mathematical finding.', sections: [] }, 'compare')];
    expect(chatMathematics(undefined, activity).latest).toEqual({ kind: 'statement', at: activity[1]!.at,
      text: 'Adjoin all required roots of unity.\n\nCompare the radical tower with the Galois group.' });
  });

  it('uses findings as recorded notes without presenting observation heartbeats as their timestamps or claiming proof acceptance', () => {
    const value = chatMathematics(recorded([task('first', { finding: 'Earlier saved route.' }),
      task('last', { finding: 'Try adjoining roots of unity before taking the normal closure.', proof: { status: 'none', receiptIds: [] } }),
      task('paused', { control: 'paused', finding: 'This inactive note must not replace active work.' })]),
    [role(1, { text: 'Earlier recorded statement', sections: [] })]);
    expect(value.latest).toEqual({ kind: 'finding', text: 'Try adjoining roots of unity before taking the normal closure.' });
    expect(value.latest).not.toHaveProperty('at'); expect(value).not.toHaveProperty('accepted');
  });
});
