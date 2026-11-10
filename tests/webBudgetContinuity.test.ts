import { afterEach, describe, expect, it } from 'vitest';
import { WebStorage } from '../apps/web/storage';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebResearchProjects } from '../apps/web/researchProjects';
import { WebResearchWorkspace } from '../apps/web/researchWorkspace';
import { WebResearchProblems } from '../apps/web/researchProblems';
import { WebResearchBudgets, createResearchBudgetsHandler } from '../apps/web/researchBudgets';
import { WebKnowledgeService } from '../apps/web/knowledgeService';
import { loadWebSample } from '../apps/web/sample';
import type { WebRun } from '../apps/web/shared';
import type { WebJobs } from '../apps/web/jobs';
import { mathDigest } from '../src/math/mathRuntimeIo';

const owner = 'account:budget-continuity', other = 'account:budget-other', services: WebResearchAssets[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
function setup() {
  const storage = new WebStorage(), assets = new WebResearchAssets(storage), projects = new WebResearchProjects(storage); services.push(assets);
  const runs = new Map<string, WebRun>(), jobs = { list: (viewer: string) => viewer === owner ? [...runs.values()] : [],
    get: (viewer: string, id: string) => viewer === owner ? runs.get(id) : undefined } as unknown as WebJobs;
  const workspace = new WebResearchWorkspace(storage, jobs, projects, assets, new WebKnowledgeService(storage));
  const problems = new WebResearchProblems(storage, jobs, projects, workspace), budgets = new WebResearchBudgets(storage, problems, workspace);
  const run = (marker: string) => { const sample = loadWebSample()!, record = structuredClone(sample.run); record.id = crypto.randomUUID(); record.source = record.source.trim() + `\n-- ${marker}`;
    record.title = marker; record.observation = structuredClone(sample.observations.at(-1)!); record.observation.webRunId = record.id;
    runs.set(record.id, record); storage.saveRun(owner, record); return record; };
  const attach = (records: WebRun[]) => { let project = projects.create(owner, { requestId: 'project', title: 'Shared budget problem', visibility: 'members' });
    project = projects.setMember(owner, project.id, projects.identity(other), { requestId: 'member', expectedRevision: project.revision, role: 'reader' });
    for (const record of records) {
      project = projects.addVersion(owner, project.id, { requestId: `version-${record.id}`, expectedRevision: project.revision, statement: 'Same research project', source: record.source, environment: record.environment });
      project = projects.bindRun(owner, project.id, { requestId: `bind-${record.id}`, expectedRevision: project.revision, runId: record.id, statementVersionId: project.versions.at(-1)!.id });
    } return project; };
  return { storage, assets, projects, jobs, workspace, problems, budgets, run, attach };
}
const budget = (requestId: string, amountLimit: number, tokenLimit = 500000) => ({ requestId, expectedRevision: 0, currency: 'USD' as const, amountLimit, tokenLimit });

describe('personal budgets continue when research joins a project', () => {
  it('reads the same private budget after attachment and creates the project record only on an explicit save', () => {
    const f = setup(), run = f.run('first'), saved = f.budgets.save(owner, run.id, undefined, budget('personal', 20)), project = f.attach([run]);
    const inherited = f.budgets.view(owner, run.id, project.id);
    expect(inherited.plan).toMatchObject({ currency: 'USD', amountLimit: 20, tokenLimit: 500000, revision: 1 });
    expect(inherited.continuity?.status).toBe('inherited'); expect(inherited.continuity?.sources[0].key).toBe(saved.plan.key);
    const path = ['owners', mathDigest(owner), 'problem-budgets', `${inherited.plan.key}.json`]; expect(f.storage.getRecord(path)).toBeUndefined();
    expect(f.budgets.view(other, run.id, project.id).plan.amountLimit).toBeNull();
    const updated = f.budgets.save(owner, run.id, project.id, { ...budget('project-update', 25), expectedRevision: 1 });
    expect(updated.plan).toMatchObject({ amountLimit: 25, revision: 2 }); expect(updated.continuity).toBeUndefined();
    expect(f.storage.getRecord<{ plan: { amountLimit: number } }>(['owners', mathDigest(owner), 'problem-budgets', `${saved.plan.key}.json`])?.plan.amountLimit).toBe(20);
  });
  it('requires explicit resolution for different source budgets and deduplicates a lost response retry', () => {
    const f = setup(), first = f.run('first'), second = f.run('second');
    const saved = f.budgets.save(owner, first.id, undefined, budget('first-budget', 20)); f.budgets.save(owner, second.id, undefined, budget('second-budget', 50));
    const project = f.attach([first, second]), value = f.budgets.view(owner, first.id, project.id);
    expect(value.continuity?.status).toBe('conflict'); expect(value.continuity?.sources).toHaveLength(2);
    expect(() => f.budgets.save(owner, first.id, project.id, budget('unreviewed', 30))).toThrow('先核对');
    const input = { requestId: 'choose-first', expectedRevision: 0, sourceKey: saved.plan.key, sourceRevision: saved.plan.revision, sourcesDigest: value.continuity!.digest };
    const resolved = f.budgets.inherit(owner, first.id, project.id, input);
    expect(resolved.plan).toMatchObject({ currency: 'USD', amountLimit: 20, tokenLimit: 500000 }); expect(resolved.continuity).toBeUndefined();
    expect(f.budgets.inherit(owner, first.id, project.id, input).plan).toEqual(resolved.plan);
    expect(() => f.budgets.inherit(owner, first.id, project.id, { ...input, sourceKey: null, sourceRevision: null })).toThrow('同一请求');
  });
  it('rejects stale or foreign choices and lets the user deliberately set a separate project budget', () => {
    const f = setup(), first = f.run('first'), second = f.run('second');
    f.budgets.save(owner, first.id, undefined, budget('first-budget', 20)); f.budgets.save(owner, second.id, undefined, budget('second-budget', 50));
    const project = f.attach([first, second]), value = f.budgets.view(owner, first.id, project.id), source = value.continuity!.sources[0];
    const input = { requestId: 'resolve', expectedRevision: 0, sourceKey: source.key, sourceRevision: source.plan.revision, sourcesDigest: value.continuity!.digest };
    expect(() => f.budgets.inherit(owner, first.id, project.id, { ...input, sourceKey: 'f'.repeat(64) })).toThrow('来源已更新');
    expect(() => f.budgets.inherit(owner, first.id, project.id, { ...input, sourceRevision: 100 })).toThrow('来源已更新');
    expect(() => f.budgets.inherit(owner, first.id, project.id, { ...input, sourcesDigest: 'f'.repeat(64) })).toThrow('来源已更新');
    const separate = f.budgets.inherit(owner, first.id, project.id, { ...input, sourceKey: null, sourceRevision: null });
    expect(separate.plan).toMatchObject({ revision: 1, tokenLimit: null, amountLimit: null }); expect(separate.continuity).toBeUndefined();
  });
  it('treats identical budgets as one choice while preserving a budget already set for the project', () => {
    const f = setup(), first = f.run('first'), second = f.run('second');
    f.budgets.save(owner, first.id, undefined, budget('first-budget', 20)); f.budgets.save(owner, second.id, undefined, budget('second-budget', 20));
    const project = f.attach([first, second]); expect(f.budgets.view(owner, first.id, project.id).continuity?.status).toBe('inherited');
    f.budgets.save(owner, first.id, project.id, { ...budget('clear-project', 0), expectedRevision: 1, amountLimit: null, tokenLimit: null });
    expect(f.budgets.view(owner, first.id, project.id)).toMatchObject({ plan: { amountLimit: null, tokenLimit: null } });
    expect(f.budgets.view(owner, first.id, project.id).continuity).toBeUndefined();
  });
  it('serves conflict resolution through the mounted handler and revokes private read access with membership', async () => {
    const f = setup(), first = f.run('first'), second = f.run('second');
    f.budgets.save(owner, first.id, undefined, budget('first-budget', 20)); f.budgets.save(owner, second.id, undefined, budget('second-budget', 50));
    const project = f.attach([first, second]), handler = createResearchBudgetsHandler(f), value = f.budgets.view(owner, first.id, project.id);
    expect(await handler.handle(new URL(`http://fixture/api/research/workspace/problem/${first.id}/budget/inherit?project=${project.id}`), 'POST', owner,
      async () => ({ requestId: 'separate', expectedRevision: 0, sourceKey: null, sourceRevision: null, sourcesDigest: value.continuity!.digest }))).toMatchObject({ status: 200 });
    f.projects.setMember(owner, project.id, f.projects.identity(other), { requestId: 'revoke', expectedRevision: project.revision, role: null });
    expect(() => f.budgets.view(other, first.id, project.id)).toThrow();
  });
});
