import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebJobs } from '../apps/web/jobs';
import { WebStorage } from '../apps/web/storage';
import { WebResearchPersonal } from '../apps/web/researchPersonal';
import { WebResearchProjects } from '../apps/web/researchProjects';
import type { WebResearchProblems } from '../apps/web/researchProblems';
import { webAgentTeamPreset, webResearchArguments, webResearchModeError } from '../apps/web/researchMode';
import { webSolverModules } from '../apps/web/worker';
import { directSolverModules } from '../src/solver/modules';
import { decodeTaskDraft, encodeTaskDraft, type TaskDraft } from '../apps/web/client/draft';
import { leanProblemDraft } from '../apps/web/client/problemDrafts';
import { matchesProblemRun } from '../apps/web/problemDraftSubmission';
import { loadWebSample } from '../apps/web/sample';
import { isWebObservation, parseWorkerMessage, type WebRunner } from '../apps/web/runner';
import { projectWebNativeTeam } from '../apps/web/nativeTeamObservation';
import type { WebObservation } from '../apps/web/collaboration';
import { retiredPortfolioMessage, retiredResearchCoordinationMessage, type WebProvider, type WebRunInput, type WorkerInput, type WorkerMessage } from '../apps/web/shared';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { personalExpertCardsDigest } from '../src/solver/personalExperts';
import { defaultResearchModulePlan } from '../src/solver/modules/policy';
import { buildRunInspection } from '../src/solver/inspection';
import { localExample, solverState } from './helpers/solver';

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

describe('Web Skill research arrangement and frozen identity', () => {
  it('retires standalone scouting and accepts an explicit false as an old-client no-op', () => {
    const team = input(webAgentTeamPreset());
    for (const historical of [{ portfolioExploration: true }, { portfolioSeconds: 45 }]) {
      const requested = { ...team, ...historical };
      expect(webResearchModeError(requested, provider)).toBe(retiredPortfolioMessage);
      expect(() => webResearchArguments(requested, provider)).toThrow(retiredPortfolioMessage);
    }
    expect(webResearchArguments({ ...team, portfolioExploration: false }, provider)).toEqual(webResearchArguments(team, provider));
  });
  it('restores a native team with the chosen capacity, rejects host scheduling, and binds observations to the same team', async () => {
    const selected = { ...draft(), nativeTeamCapacity: 3 };
    expect(decodeTaskDraft(JSON.parse(encodeTaskDraft(selected)))).toEqual(selected);
    expect(leanProblemDraft(selected).draft.nativeTeamCapacity).toBe(3);
    const team = input({ ...webAgentTeamPreset(), skillLoading: 'file' });
    expect(webResearchArguments(team, provider)).toEqual(['--research-mode', 'skill', '--skill-loading', 'file',
      '--skill-delegation', 'team', '--skill-max-agents', '3']);
    expect(webResearchArguments({ ...team, planApproval: true }, provider)).toEqual(webResearchArguments(team, provider));
    for (const change of [{ workers: 3 }, { coordination: 'cooperative' as const }, { nativeTeamCapacity: 1 }, { nativeTeamCapacity: 9 }])
      expect(() => webResearchArguments({ ...team, ...change }, provider)).toThrow();
    expect(() => webResearchArguments(team, { harness: 'cli' })).toThrow(/Codex/);
    const fixture = controlled(), jobs = new WebJobs(fixture.runner, { concurrency: 1, queueLimit: 4 }); queues.push(jobs);
    const run = jobs.create('owner', team, provider, undefined, 'native-team');
    await tick(); expect(fixture.actual.input.nativeTeamCapacity).toBe(3);
    const record = observation(run.id, 1);
    fixture.send({ type: 'observation', observation: record }); expect(run.observation).toBeUndefined();
    record.inspection.configuration.researchDelegation = { mode: 'team', maxAgents: 3 };
    // A startup downgrade of the tool transport leaves the team arrangement frozen.
    const { directory, workspace, problem } = localExample('web-team-fallback-'); roots.push(directory);
    const state = solverState(problem, workspace, { runId: record.solverRunId,
      researchDelegation: { mode: 'team', maxAgents: 3 }, agentTeam: {
        schema: 'theorem-os.agent-team.v1', transport: 'host-tools', workers: [], events: [], deliveries: [], adoptions: [], operations: [],
      } });
    record.inspection.nativeTeam = projectWebNativeTeam(state, directory, buildRunInspection(state).agentTeam!, () => {
      throw new Error('There are no proof commits in this fixture');
    });
    expect(record.inspection.nativeTeam).toMatchObject({ transport: 'host-tools', maxAgents: 3, taskCount: 0 });
    expect(isWebObservation(record)).toBe(true);
    fixture.send({ type: 'observation', observation: record }); expect(run.observation?.sequence).toBe(1);
    expect(() => jobs.replay('owner', { ...team, nativeTeamCapacity: 4 }, provider, 'native-team')).toThrow(/不同/);
  });
  it('resolves preferred profiles before dispatch and replay, and only accepts observations with the frozen preference', async () => {
    const fixture = controlled(), jobs = new WebJobs(fixture.runner, { concurrency: 1, queueLimit: 4 }); queues.push(jobs);
    const team = input({ nativeTeamCapacity: 2, skillLoading: 'file', nativeTeamPreferredProfiles: ['engineer', 'elementary-number-theory', 'D011'] });
    const run = jobs.create('owner', team, provider, undefined, 'preferred-team');
    await tick();
    expect(run.nativeTeamPreferredProfiles).toEqual(['D011', 'engineer']);
    expect(webResearchArguments(fixture.actual.input, provider).slice(-2)).toEqual(['--skill-preferred-profiles', 'D011,engineer']);
    expect(jobs.replay('owner', { ...team, nativeTeamPreferredProfiles: ['D011', 'engineer'] }, provider, 'preferred-team')?.id).toBe(run.id);
    expect(() => jobs.replay('owner', { ...team, nativeTeamPreferredProfiles: ['reviewer'] }, provider, 'preferred-team')).toThrow(/不同/);
    for (const name of ['lead', 'unlisted']) expect(() => jobs.create('owner', { ...team, nativeTeamPreferredProfiles: [name] }, provider)).toThrow(name);
    expect(webResearchModeError({ ...team, nativeTeamCapacity: undefined })).toMatch(/角色偏好/);
    const record = observation(run.id, 1);
    record.inspection.configuration.researchDelegation = { mode: 'team', maxAgents: 2 };
    fixture.send({ type: 'observation', observation: record }); expect(run.observation).toBeUndefined();
    record.inspection.configuration.researchDelegation.preferredProfiles = ['D011', 'engineer'];
    fixture.send({ type: 'observation', observation: record }); expect(run.observation?.sequence).toBe(1);
  });
  it('forwards explicit Skill arguments and refuses to execute a retired host team', () => {
    expect(webResearchArguments(input())).toEqual(['--research-mode', 'skill', '--skill-loading', 'native']);
    expect(webResearchArguments(input({ skillLoading: 'file' }))).toEqual(['--research-mode', 'skill', '--skill-loading', 'file']);
    expect(webResearchArguments(input({ researchMode: undefined }))).toEqual([]);
    expect(webResearchModeError(input({ researchSelection: { libraries: [{ assetId: 'library', version: '1.0.0' }] } }))).toBeUndefined();
    for (const change of [{ workers: 2 }, { coordination: 'cooperative' }, { planApproval: true },
      { modulePlan: { scheduler: 'plan', context: 'full', custom: [] } },
      { researchSelection: { skills: [{ assetId: 'custom-strategy', version: '1.0.0' }] } }])
      expect(webResearchModeError(input(change as Partial<WebRunInput>))).toBeUndefined();
    expect(webResearchModeError(input({ researchMode: undefined, skillLoading: 'native' }))).toMatch(/Skill/);
    expect(() => webResearchArguments(input({ workers: 4, coordination: 'cooperative', planApproval: true })))
      .toThrow(retiredResearchCoordinationMessage);
    const modules = webSolverModules({ id: 'fixture', input: input(), provider });
    expect(modules.M3).toBe(directSolverModules.M3); expect(modules.M5).toBe(directSolverModules.M5);
    expect(webSolverModules({ id: 'fixture', input: input(), provider }, undefined,
      { tools: '/offline/agent-tools/math.mjs', hiddenRoots: ['/offline/application'] }).M4.tools).toBe('/offline/agent-tools/math.mjs');
  });

  it('matches native drafts to explicit asset versions and rejects progress with missing or different frozen knowledge', async () => {
    const fixture = controlled(), jobs = new WebJobs(fixture.runner, { concurrency: 1, queueLimit: 4 }); queues.push(jobs);
    const ref = { assetId: 'asset-space', version: 'v1', digest: mathDigest('release') };
    const card = { ...ref, name: 'Topologist', summary: 'Compactness', knowledge: 'Finite subcover' };
    const pick = { skills: [ref] };
    const run = jobs.create('owner', input({ nativeTeamCapacity: 3, skillLoading: 'file', researchSelection: pick }), provider,
      undefined, undefined, undefined, { schema: 'theorem-os.research-configuration.v1', environment: 'mathlib',
        modulePlan: defaultResearchModulePlan(), preferences: {}, skills: [], libraries: [], personalExperts: [card],
        personalExpertSelection: pick, digest: mathDigest('frozen') });
    await tick();
    const value = leanProblemDraft({ ...draft(), nativeTeamCapacity: 3 }, [ref]);
    expect(matchesProblemRun(value, run)).toBe(true);
    expect(matchesProblemRun({ ...value, libraries: [{ ...ref, version: 'v2' }] }, run)).toBe(false);
    const record = observation(run.id, 1);
    const delegation: NonNullable<WebObservation['inspection']['configuration']['researchDelegation']> = { mode: 'team', maxAgents: 3 };
    record.inspection.configuration.researchDelegation = delegation;
    fixture.send({ type: 'observation', observation: record }); expect(run.observation).toBeUndefined();
    delegation.personalExperts = { digest: mathDigest('other material'), cards: [{ ...ref, name: card.name }] };
    fixture.send({ type: 'observation', observation: record }); expect(run.observation).toBeUndefined();
    delegation.personalExperts.digest = personalExpertCardsDigest([card]);
    fixture.send({ type: 'observation', observation: record }); expect(run.observation?.sequence).toBe(1);
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
    const original = { ...draft(), planApproval: true as const, nativeTeamCapacity: 8, nativeTeamPreferredProfiles: ['D011', 'engineer'] };
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
    const run = jobs.create('owner', input({ skillLoading: 'file', planApproval: true, nativeTeamCapacity: 8, nativeTeamPreferredProfiles: original.nativeTeamPreferredProfiles }), provider);
    expect(matchesProblemRun(value, run)).toBe(true);
    expect(matchesProblemRun(value, { ...run, researchMode: 'legacy' })).toBe(false);
    expect(matchesProblemRun(value, { ...run, skillLoading: 'native' })).toBe(false);
    expect(matchesProblemRun(value, { ...run, nativeTeamCapacity: 4 })).toBe(false);
    expect(matchesProblemRun(value, { ...run, nativeTeamPreferredProfiles: ['prover'] })).toBe(false);
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
