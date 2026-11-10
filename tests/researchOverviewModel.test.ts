import { describe, expect, it } from 'vitest';
import { buildResearchOverview, researchStatementIdentity } from '../apps/web/client/researchOverviewModel';
import type { WebRun } from '../apps/web/shared';
import type { WebObservation } from '../apps/web/collaboration';
import type { WebFormalization } from '../apps/web/formalizationTypes';
import type { ResearchOverviewProject } from '../apps/web/researchOverviewTypes';
import { WebStorage } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';
import { researchOverview } from '../apps/web/researchOverview';

const at = '2026-11-10T00:00:00.000Z';
function run(id: string, changes: Partial<WebRun> = {}): WebRun {
  return { id, title: 'Same title', status: 'completed', phase: 'completed', createdAt: at, updatedAt: at,
    providerId: 'fixture', model: 'fixture', effort: 'low', environment: 'standard', source: 'theorem target : True := by sorry\n',
    task: 'Prove the target', maxTurns: 1, maxRunSeconds: 30, workers: 1, coordination: 'independent', events: [], ...changes };
}
function project(): ResearchOverviewProject {
  return { id: 'project-1', title: 'Bound problem', description: '', updatedAt: at,
    permissions: { manage: true, edit: true, discuss: true, member: true },
    versions: [{ id: 'statement-1', statement: 'A frozen problem', sourceDigest: 'a'.repeat(64), environment: 'standard', formalizationId: 'formal-1', createdAt: at }],
    runs: [{ runId: 'run-1', statementVersionId: 'statement-1', title: 'Attempt one', owner: { id: 'author', displayName: 'Author' },
      exposure: 'members', grants: { guidance: true, edit: true, approve: true, proof: true }, status: 'running', createdAt: at,
      permissions: { read: true, manage: true, guidance: true, edit: true, approve: true, proof: true } }], feedback: [] };
}

describe('problem research overview', () => {
  it('groups exact unbound statements while separating same-title source, environment and formalization changes', () => {
    const first = run('one'), second = run('two', { createdAt: '2026-11-10T00:10:00.000Z' });
    const changed = run('changed', { source: first.source + '\n' }), otherEnvironment = run('mathlib', { environment: 'mathlib' });
    const formalized = run('formalized', { formalization: { id: 'formal-1', evidenceSha256: 'a'.repeat(64), original: 'First reading', confirmedAt: at } });
    const revised = run('revised', { formalization: { ...formalized.formalization!, evidenceSha256: 'b'.repeat(64) } });
    const model = buildResearchOverview({ runs: [second, first, changed, otherEnvironment, formalized, revised], formalizations: [], conversations: [] });
    expect(model.cards).toHaveLength(5);
    expect(model.cards.find(card => card.runs.some(item => item.id === 'one'))!.runs.map(item => item.id).sort()).toEqual(['one', 'two']);
    expect(researchStatementIdentity(first)).not.toBe(researchStatementIdentity(changed));
  });

  it('uses explicit project bindings and retains formalization/chat links even when their run is not loaded', () => {
    const bound = project();
    const record: WebFormalization = { id: 'formal-1', runId: 'not-loaded', original: 'Original problem', environment: 'standard', model: 'fixture',
      effort: 'low', status: 'confirmed', createdAt: at, updatedAt: at };
    const model = buildResearchOverview({ runs: [run('run-1')], research: { projects: [bound], notifications: [] }, formalizations: [record],
      conversations: [{ id: 'chat-1', title: 'Question about this proof', runId: 'not-loaded', formalizationId: record.id, createdAt: at, updatedAt: at, answering: false }] });
    expect(model.cards).toHaveLength(1);
    expect(model.cards[0].id).toBe('project:project-1');
    expect(model.cards[0].runs.map(item => item.id)).toEqual(['run-1']);
    expect(model.cards[0].formalizations.map(item => item.id)).toEqual(['formal-1']);
    expect(model.cards[0].conversations.map(item => item.id)).toEqual(['chat-1']);
  });

  it('shows actionable reviews and preserves the feedback statement/task version in its link', () => {
    const bound = project();
    bound.feedback = [{ id: 'feedback-1', kind: 'guidance', text: 'Use the other lemma', author: { id: 'reader', displayName: 'Reader' },
      statementVersionId: 'statement-1', target: { runId: 'run-1', statementVersionId: 'statement-1',
        observationRef: { sequence: 1, stateDigest: 'a'.repeat(64) }, taskRef: { id: 'helper', version: 'helper-v2' } },
      decision: { status: 'pending', evidenceRefs: [] }, delivery: { status: 'delivered' },
      execution: { status: 'running', taskRefs: [], resultRefs: [] }, updatedAt: at }];
    const waiting = run('run-1', { status: 'running', observation: { inspection: { planApproval: { status: 'pending', leadRevising: false } } } as WebObservation });
    const model = buildResearchOverview({ runs: [waiting], formalizations: [], conversations: [], research: { projects: [bound], notifications: [] } });
    expect(model.actions.map(action => action.kind).sort()).toEqual(['feedback', 'plan']);
    const link = new URL(model.actions.find(action => action.kind === 'feedback')!.href, 'https://fixture.local/');
    expect(Object.fromEntries(link.searchParams)).toEqual({ id: bound.id, run: waiting.id, version: 'statement-1', task: 'helper', taskVersion: 'helper-v2' });
    expect(link.hash).toBe('#feedback-feedback-1');
    bound.permissions.manage = false;
    expect(buildResearchOverview({ runs: [], formalizations: [], conversations: [], research: { projects: [bound], notifications: [] } }).actions).toEqual([]);
  });

  it('distinguishes a statement review from an already-confirmed statement waiting for research', () => {
    const formalization: WebFormalization = { id: 'formal-1', original: 'Original problem', environment: 'standard', model: 'fixture', effort: 'low',
      status: 'review', humanReview: true, createdAt: at, updatedAt: at };
    expect(buildResearchOverview({ runs: [], conversations: [], formalizations: [formalization] }).actions[0].kind).toBe('statement');
    formalization.status = 'confirmed';
    expect(buildResearchOverview({ runs: [], conversations: [], formalizations: [formalization] }).actions[0].kind).toBe('research');
    formalization.runId = 'already-started';
    expect(buildResearchOverview({ runs: [], conversations: [], formalizations: [formalization] }).actions).toEqual([]);
  });

  it('exposes only the viewer’s member projects and omits internal owner keys from the API projection', () => {
    const service = new WebResearchProjects(new WebStorage());
    const own = service.create('account:alice-private-owner', { requestId: 'own-project', title: 'Own', visibility: 'private' });
    service.create('account:bob-private-owner', { requestId: 'other-project', title: 'Other private', visibility: 'private' });
    service.create('account:bob-private-owner', { requestId: 'public-project', title: 'Public discovery', visibility: 'public' });
    const result = researchOverview(service, 'account:alice-private-owner');
    expect(result.projects.map(item => item.id)).toEqual([own.id]);
    expect(JSON.stringify(result)).not.toContain('account:');
    expect(researchOverview(service, 'public')).toEqual({ projects: [], notifications: [] });
  });
});
