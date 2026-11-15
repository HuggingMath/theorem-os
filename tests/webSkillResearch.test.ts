import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebJobs } from '../apps/web/jobs';
import { WebStorage } from '../apps/web/storage';
import { WebResearchPersonal } from '../apps/web/researchPersonal';
import { WebResearchProjects } from '../apps/web/researchProjects';
import type { WebResearchProblems } from '../apps/web/researchProblems';
import { webResearchArguments, webResearchModeError } from '../apps/web/researchMode';
import { webSolverModules } from '../apps/web/worker';
import { directSolverModules } from '../src/solver/modules';
import { decodeTaskDraft, encodeTaskDraft, type TaskDraft } from '../apps/web/client/draft';
import { leanProblemDraft } from '../apps/web/client/problemDrafts';
import { matchesProblemRun } from '../apps/web/problemDraftSubmission';
import { loadWebSample } from '../apps/web/sample';
import { isWebObservation, parseWorkerMessage, type WebRunner } from '../apps/web/runner';
import type { WebObservation } from '../apps/web/collaboration';
import type { WebProvider, WebRunInput, WorkerInput, WorkerMessage } from '../apps/web/shared';
import { mathDigest } from '../src/math/mathRuntimeIo';

const provider: WebProvider = { id: 'fixture', name: 'Offline fixture', baseUrl: 'http://127.0.0.1:1/v1' };
const input = (overrides: Partial<WebRunInput> = {}): WebRunInput => ({ providerId: provider.id, apiKey: 'sk-disposable-fixture',
  model: 'fixture', environment: 'mathlib', effort: 'high', source: 'theorem goal : True := by sorry', task: 'Prove goal.',
  workers: 1, coordination: 'independent', maxTurns: 1, maxRunSeconds: 30, researchMode: 'skill', ...overrides });
const draft = (): TaskDraft => ({ providerId: provider.id, model: 'fixture', environment: 'mathlib', effort: 'high',
  source: input().source, task: input().task, workers: '1', coordination: 'independent', maxTurns: '1', maxRunSeconds: '30',
  researchMode: 'skill', skillLoading: 'file', templateId: '' });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const queues: WebJobs[] = [], roots: string[] = [];
afterEach(async () => { await Promise.all(queues.splice(0).map(jobs => jobs.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function controlled() {
  let send!: (message: WorkerMessage) => void, actual!: WorkerInput;
  const runner: WebRunner = { async readiness() { return { ready: true, message: 'Offline fixture' }; },
    async run(value, emit, signal) { actual = value; send = emit;
      await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); }); } };
  return { runner, get send() { return send; }, get actual() { return actual; } };
}
function observation(id: string, sequence: number): WebObservation {
  const record = structuredClone(loadWebSample().observations[0]);
  record.webRunId = id; record.sequence = sequence;
  record.inspection.configuration.researchMode = 'skill';
  record.inspection.configuration.researchSkill = { name: 'mathematical-research', digest: mathDigest('frozen skill'), loading: 'file' };
  record.inspection.tasks = []; record.plan = null; record.sources = []; record.checks = [];
  return record;
}

describe('Web single researcher creation and frozen skill identity', () => {
  it('forwards explicit skill CLI arguments while preserving the legacy default and rejecting conflicting module choices', () => {
    expect(webResearchArguments(input())).toEqual(['--research-mode', 'skill', '--skill-loading', 'native']);
    expect(webResearchArguments(input({ skillLoading: 'file' }))).toEqual(['--research-mode', 'skill', '--skill-loading', 'file']);
    expect(webResearchArguments(input({ researchMode: undefined }))).toEqual([]);
    expect(webResearchModeError(input({ researchSelection: { libraries: [{ assetId: 'library', version: '1.0.0' }] } }))).toBeUndefined();
    for (const change of [{ workers: 2 }, { coordination: 'cooperative' }, { planApproval: true },
      { modulePlan: { scheduler: 'plan', context: 'full', custom: [] } },
      { researchSelection: { skills: [{ assetId: 'custom-strategy', version: '1.0.0' }] } }])
      expect(webResearchModeError(input(change as Partial<WebRunInput>))).toMatch(/单研究者/);
    expect(webResearchModeError(input({ researchMode: undefined, skillLoading: 'native' }))).toMatch(/单研究者/);
    const modules = webSolverModules({ id: 'fixture', input: input(), provider });
    expect(modules.M3).toBe(directSolverModules.M3); expect(modules.M5).toBe(directSolverModules.M5);
    expect(webSolverModules({ id: 'fixture', input: input(), provider }, undefined,
      { tools: '/offline/agent-tools/math.mjs', hiddenRoots: ['/offline/application'] }).M4.tools).toBe('/offline/agent-tools/math.mjs');
  });

  it('persists the selected loading, freezes the first actual skill and refuses a different engine or skill later', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-skill-identity-')); roots.push(root);
    const fixture = controlled(), storage = new WebStorage(root), jobs = new WebJobs(fixture.runner,
      { concurrency: 1, queueLimit: 4 }, { storage }); queues.push(jobs);
    const run = jobs.create('owner', input({ skillLoading: 'file' }), provider, undefined, 'frozen-skill');
    await tick(); expect(fixture.actual.input).toMatchObject({ researchMode: 'skill', skillLoading: 'file' });
    expect(run).not.toHaveProperty('moduleConfiguration');
    expect(jobs.replay('owner', input({ skillLoading: 'file' }), provider, 'frozen-skill')?.id).toBe(run.id);
    expect(() => jobs.replay('owner', input({ skillLoading: 'native' }), provider, 'frozen-skill')).toThrow(/不同/);
    const first = observation(run.id, 1); fixture.send({ type: 'observation', observation: first });
    expect(run.researchSkill).toEqual(first.inspection.configuration.researchSkill);
    for (const change of [
      { researchMode: 'legacy' as const },
      { researchSkill: { ...run.researchSkill!, loading: 'native' as const } },
      { researchSkill: { ...run.researchSkill!, digest: mathDigest('changed skill') } },
    ]) { const next = observation(run.id, 2); Object.assign(next.inspection.configuration, change);
      fixture.send({ type: 'observation', observation: next }); expect(run.observation?.sequence).toBe(1); }
    fixture.send({ type: 'observation', observation: observation(run.id, 2) });
    expect(run.observation?.sequence).toBe(2);
    const stored = new WebStorage(root).loadRuns()[0]!.run;
    expect(stored.researchSkill).toEqual(run.researchSkill); expect(stored).toMatchObject({ researchMode: 'skill', skillLoading: 'file' });
    expect(stored.status).toBe('running'); expect(stored.result).toBeUndefined();
  });

  it('keeps skill mode through local drafts, archive imports and account drafts, and includes it in submission matching', () => {
    const original = draft();
    expect(decodeTaskDraft(JSON.parse(encodeTaskDraft(original)))).toEqual(original);
    const { templateId: _template, ...archived } = original;
    expect(decodeTaskDraft({ schema: 'theorem-os.web-export.v1', run: { ...archived,
      maxTurns: 1, maxRunSeconds: 30, workers: 1 } })).toEqual(original);
    const storage = new WebStorage(), jobs = new WebJobs(controlled().runner, { concurrency: 1, queueLimit: 4 }); queues.push(jobs);
    const personal = new WebResearchPersonal({ storage, projects: new WebResearchProjects(storage), jobs,
      problems: {} as WebResearchProblems });
    const value = leanProblemDraft(original), saved = personal.saveDraft('account:alice@example.org', {
      scope: { kind: 'problem', draftKey: 'skill-draft' }, value, requestId: 'save-skill', expectedRevision: 0,
      summary: 'Skill draft', deviceId: 'fixture', deviceName: 'Fixture', clientUpdatedAt: new Date().toISOString() });
    expect(personal.draft('account:alice@example.org', saved.draft.id).version.value).toEqual(value);
    const run = jobs.create('owner', input({ skillLoading: 'file' }), provider);
    expect(matchesProblemRun(value, run)).toBe(true);
    expect(matchesProblemRun(value, { ...run, researchMode: 'legacy' })).toBe(false);
    expect(matchesProblemRun(value, { ...run, skillLoading: 'native' })).toBe(false);
  });

  it('validates declaration evidence and actual skill identity without accepting an observation as proof', () => {
    const value = observation('web-fixture', 1);
    value.declarations = { status: 'absent', evidence: 'recorded-not-replayed', acceptance: 'not-assessed', requiresFreshCheck: true };
    expect(isWebObservation(value)).toBe(true);
    expect(parseWorkerMessage(JSON.stringify({ type: 'observation', observation: value }))).toMatchObject({ type: 'observation' });
    expect(isWebObservation({ ...value, declarations: { ...value.declarations, acceptance: 'accepted' } })).toBe(false);
    value.inspection.configuration.researchSkill!.digest = 'not-a-digest';
    expect(isWebObservation(value)).toBe(false);
  });
});
