import { describe, expect, it } from 'vitest';
import { buildResearchOverview, researchVerifiedRuns } from '../apps/web/client/researchOverviewModel';
import type { WebRun } from '../apps/web/shared';
import type { ResearchOverviewProject } from '../apps/web/researchOverviewTypes';

const at = '2026-11-11T00:00:00.000Z';
const run = (id: string, status: NonNullable<WebRun['result']>['status'], updatedAt = at): WebRun => ({
  id, title: id, status: 'completed', phase: 'completed', createdAt: at, updatedAt,
  providerId: 'fixture', model: 'fixture', effort: 'low', environment: 'standard', source: 'theorem target : True := by sorry',
  task: 'Prove the target', maxTurns: 1, maxRunSeconds: 30, workers: 1, coordination: 'independent', events: [], result: { status, proof: '' },
});
const binding = (runId: string, version: string) => ({ runId, statementVersionId: version, title: runId,
  owner: { id: 'author', displayName: 'Author' }, exposure: 'members' as const,
  grants: { guidance: true, edit: true, approve: true, proof: true }, status: 'completed' as const, createdAt: at,
  permissions: { read: true, manage: true, guidance: true, edit: true, approve: true, proof: true } });

describe('overview accepted evidence belongs to its statement version', () => {
  it('retains an accepted old version while the latest version is not accepted, without replacing the latest state', () => {
    const old = run('old-accepted', 'evaluated_passed'), latest = run('latest-unaccepted', 'limit_reached', '2026-11-11T00:02:00.000Z');
    const project: ResearchOverviewProject = { id: 'project', title: 'Two versions', description: '', updatedAt: latest.updatedAt,
      permissions: { manage: true, edit: true, discuss: true, member: true }, feedback: [],
      versions: ['v1', 'v2'].map(id => ({ id, statement: id, sourceDigest: 'a'.repeat(64), environment: 'standard', createdAt: at })),
      runs: [binding(old.id, 'v1'), binding(latest.id, 'v2')] };
    const card = buildResearchOverview({ runs: [old, latest], conversations: [], formalizations: [], research: { projects: [project], notifications: [] } }).cards[0];
    expect(researchVerifiedRuns(card)).toMatchObject([{ run: { id: old.id }, version: 1 }]);
    expect(card.runs[0]).toBe(latest);
    expect(card.runs[0].result?.status).toBe('limit_reached');
  });

  it('shows each accepted version once and never treats a local proof or an unfinished run as full acceptance', () => {
    const first = run('first', 'evaluated_passed'), newer = run('newer', 'evaluated_passed', '2026-11-11T00:01:00.000Z');
    const secondVersion = run('second-version', 'evaluated_passed', '2026-11-11T00:02:00.000Z');
    const local = run('local-only', 'incomplete'), unfinished = { ...run('not-completed', 'evaluated_passed'), status: 'running' as const };
    const project: ResearchOverviewProject = { id: 'project', title: 'Three versions', description: '', updatedAt: at,
      permissions: { manage: true, edit: true, discuss: true, member: true }, feedback: [],
      versions: ['v1', 'v2', 'v3'].map(id => ({ id, statement: id, sourceDigest: 'a'.repeat(64), environment: 'standard', createdAt: at })),
      runs: [binding(first.id, 'v1'), binding(newer.id, 'v1'), binding(secondVersion.id, 'v2'), binding(local.id, 'v3'), binding(unfinished.id, 'v3')] };
    const card = buildResearchOverview({ runs: [first, newer, secondVersion, local, unfinished], conversations: [], formalizations: [], research: { projects: [project], notifications: [] } }).cards[0];
    expect(researchVerifiedRuns(card).map(item => [item.run.id, item.version])).toEqual([[secondVersion.id, 2], [newer.id, 1]]);
  });

  it('gives a personal problem a readable accepted attempt without inventing a project statement version', () => {
    const old = run('old', 'evaluated_passed'), newer = run('newer', 'evaluated_passed', '2026-11-11T00:01:00.000Z');
    const card = buildResearchOverview({ runs: [old, newer], conversations: [], formalizations: [] }).cards[0];
    expect(researchVerifiedRuns(card)).toEqual([{ run: newer }]);
  });
});
