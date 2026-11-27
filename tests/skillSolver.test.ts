import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readMathAgentSkill } from '../src/runtime/codexSkills';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { directSolverModules } from '../src/solver/modules';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { runSolver } from '../src/solver/run';
import { assertSolverSources, git } from '../src/solver/problem';
import { localExample } from './helpers/solver';
import { bindResearchHarness, researchHarness } from '../src/runtime/researchHarness';
import { prepareWestlakeProfile } from '../src/runtime/westlake';

vi.mock('../src/math/mathBuildManifest', async original => ({
  ...await original<typeof import('../src/math/mathBuildManifest')>(), readMathBuildManifest: vi.fn(),
}));
vi.mock('../src/math/leanToolchainReadiness', () => ({ checkResolvedLeanToolchainReadiness: () => ({ status: 'ready' }) }));
vi.mock('../src/math/leanDiagnostics', async original => ({
  ...await original<typeof import('../src/math/leanDiagnostics')>(),
  runLeanDiagnostics: async () => ({ exitCode: 0, timedOut: false, phases: [] }),
}));
vi.mock('../src/math/verifier', async original => ({
  ...await original<typeof import('../src/math/verifier')>(), resolveMathematicsLakePackagesCache: () => undefined,
}));

describe('opt-in skill research CLI and pinned identity', () => {
  let example: ReturnType<typeof localExample>;
  let root: string;
  let output: string;
  let args: string[];
  const open = vi.fn(async () => { throw new Error('startup must never call a model'); });
  const modules = { ...directSolverModules, M1: { ...directSolverModules.M1, open } };
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  beforeEach(() => {
    example = localExample('skill-run-cli-'); root = path.join(example.directory, 'runtime');
    fs.mkdirSync(root);
    fs.cpSync(path.join(repository, 'skills'), path.join(root, 'skills'), { recursive: true });
    output = path.join(example.directory, 'run.json');
    const task = path.join(example.directory, 'task.md'), build = path.join(example.directory, 'build.json');
    fs.writeFileSync(task, 'Prove the original example.'); fs.writeFileSync(build, '{}');
    args = ['--workspace', example.workspace, '--task-file', task, '--build-manifest', build,
      '--output', output, '--startup-only'];
    vi.stubEnv('DEEPSCIENTIST_MATH_ENV_FILE', path.join(example.directory, 'empty.env'));
    vi.stubEnv('DEEPSCIENTIST_MATH_PANTOGRAPH_MANIFEST', undefined);
    vi.stubEnv('DEEPSCIENTIST_MATH_PANTOGRAPH_SHA256', undefined);
    vi.stubEnv('THEOREMOS_CODEX_BACKEND_EXECUTABLE', process.execPath);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    open.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(example.directory, { recursive: true, force: true });
  });
  const state = () => readSolverRunState(output + '.runtime/state.json');
  const rejected = (reason: string) => expect(vi.mocked(console.log).mock.calls
    .map(([line]) => JSON.parse(String(line))).filter(event => event.event === 'rejected'))
    .toContainEqual(expect.objectContaining({ reason }));

  it('prepares one researcher and pins the full skill without creating task or role state', async () => {
    expect(await runSolver([...args, '--research-mode', 'skill'], root, modules)).toBe(0);
    const saved = state();
    expect(saved).toMatchObject({ researchMode: 'skill', coordination: 'independent', workerCount: 1,
      researchSkill: { name: 'theoremos-research', loading: 'native' }, turns: 0 });
    expect(saved.workers).toBeUndefined(); expect(saved.cooperation).toBeUndefined();
    expect(saved.threadId).toBeUndefined(); expect(open).not.toHaveBeenCalled();
    const projected = readMathAgentSkill(path.join(saved.worktree, '.agents/skills/theoremos-research/SKILL.md'));
    expect(researchSkillIdentity(projected)).toEqual(saved.researchSkill);
    prepareResearchSkill(root, saved.worktree, saved.researchSkill!, saved.problem);
    expect(() => assertSolverSources(saved.problem, saved.worktree)).not.toThrow();
    expect(git(example.workspace, ['rev-parse', 'HEAD'])).toBe(example.problem.baseCommit);
  });

  it('inherits the frozen strategy and explicit file loading on resume', async () => {
    expect(await runSolver([...args, '--research-mode', 'skill', '--skill-loading', 'file'], root, modules)).toBe(0);
    const before = state();
    expect(await runSolver([...args, '--resume'], root, modules)).toBe(0);
    expect(state()).toMatchObject({ runId: before.runId, researchMode: 'skill', researchSkill: before.researchSkill, turns: 0 });
    expect(open).not.toHaveBeenCalled();
  });

  const harnessArguments = (id: 'claude-code' | 'opencode') => {
    const profile = path.join(example.directory, id + '-profile'); fs.mkdirSync(profile);
    const executable = path.join(example.directory, id + '-peer');
    fs.copyFileSync(path.join(repository, 'tests/fixtures', id === 'claude-code' ? 'claudeCodeProtocolPeer.cjs' : 'openCodeNativePeer.mjs'), executable);
    fs.chmodSync(executable, 0o700);
    if (id === 'opencode') fs.writeFileSync(path.join(profile, 'opencode.json'), JSON.stringify({ provider: { fixture: {
      npm: '@ai-sdk/openai-compatible', models: { model: { name: 'Fixture', variants: { high: {} } } },
    } } }));
    return { profile, executable, flags: ['--harness', id, '--harness-profile', profile,
      '--harness-executable', executable, '--model', id === 'claude-code' ? 'claude-fixture' : 'fixture/model'] };
  };

  it.each(['claude-code', 'opencode'] as const)('prepares and resumes %s with the same portable Skill and frozen native binding', async id => {
    const h = harnessArguments(id);
    expect(await runSolver([...args, ...h.flags], root, modules)).toBe(0);
    const before = state();
    expect(before).toMatchObject({ researchMode: 'skill', workerCount: 1, coordination: 'independent',
      researchSkill: { loading: 'file' }, agentHarness: { id, executable: h.executable, profile: h.profile }, turns: 0 });
    expect(await runSolver([...args, '--resume'], root, modules)).toBe(0);
    expect(state().agentHarness).toEqual(before.agentHarness);
    expect(state().model).toBe(before.model); expect(state().methodDigest).toBe(before.methodDigest);
    expect(open).not.toHaveBeenCalled();
  });

  it('inherits an explicitly pinned Codex executable and profile without changing historical defaults', async () => {
    const h = harnessArguments('claude-code');
    const flags = [...h.flags]; flags[flags.indexOf('claude-code')] = 'codex';
    expect(await runSolver([...args, ...flags, '--research-mode', 'skill', '--skill-loading', 'file'], root, modules)).toBe(0);
    const before = state(); expect(before.agentHarness).toMatchObject({ id: 'codex', profile: h.profile, executable: h.executable });
    expect(await runSolver([...args, '--resume'], root, modules)).toBe(0);
    expect(state().agentHarness).toEqual(before.agentHarness); expect(open).not.toHaveBeenCalled();
  });

  it.each(['claude-code', 'opencode'] as const)('executes an actual %s protocol process through the shared Skill solver', async id => {
    const h = harnessArguments(id);
    const execution = [...args.filter(arg => arg !== '--startup-only'), ...h.flags, '--max-turns', '1'];
    const native = { ...modules, M1: { ...modules.M1, open: researchHarness(id).open } };
    expect(await runSolver(execution, root, native)).toBe(4);
    const saved = state();
    expect(saved.threadId).toBeTruthy(); expect(saved.turns).toBe(1);
    expect(saved.usage!.totalTokens).toBe(id === 'claude-code' ? 36 : 32);
    expect(saved.usageAccounting).toMatchObject({ reportedTurns: 1, pending: false, incomplete: false });
    expect(saved.tokenBudget!.usageComplete).toBe(true);
    expect(saved.check?.passed).not.toBe(true); expect(saved.pendingProofCheck).toBeUndefined();
    expect(saved.workers).toBeUndefined(); expect(saved.cooperation).toBeUndefined();
    // Reopening the same native conversation charges the new invocation, rather than taking a maximum.
    expect(await runSolver([...execution, '--resume', '--max-turns', '2'], root, native)).toBe(4);
    expect(state().threadId).toBe(saved.threadId);
    expect(state().usage!.totalTokens).toBe(id === 'claude-code' ? 72 : 64);
    expect(state().usageAccounting!.reportedTurns).toBe(2);
  });

  it.each(['configuration', 'executable', 'backend'] as const)('rejects %s drift before resuming a native conversation', async change => {
    const h = harnessArguments('claude-code');
    expect(await runSolver([...args, ...h.flags], root, modules)).toBe(0);
    const runId = state().runId;
    if (change === 'configuration') fs.writeFileSync(path.join(h.profile, 'settings.json'), '{"model":"changed"}');
    if (change === 'executable') fs.appendFileSync(h.executable, '\n// changed binary\n');
    expect(await runSolver([...args, '--resume', ...change === 'backend' ? ['--harness', 'codex'] : []], root, modules)).toBe(1);
    rejected('math_resume_harness_identity_changed'); expect(state().runId).toBe(runId);
    expect(open).not.toHaveBeenCalled();
  });

  it('checks the native binding again between ordinary turns in the same host process', async () => {
    const h = harnessArguments('claude-code');
    vi.mocked(console.log).mockImplementation(line => {
      if (JSON.parse(String(line)).event === 'research_saved')
        fs.writeFileSync(path.join(h.profile, 'settings.json'), '{"model":"changed between dispatches"}');
    });
    const native = { ...modules, M1: { ...modules.M1, open: researchHarness('claude-code').open } };
    expect(await runSolver([...args.filter(arg => arg !== '--startup-only'), ...h.flags, '--max-turns', '2'], root, native)).toBe(1);
    expect(state()).toMatchObject({ turns: 1, error: 'math_harness_identity_changed' });
  });

  it('rejects unsupported harness capabilities and missing non-Codex model before creating a session', async () => {
    await expect(runSolver([...args, '--harness', 'claude-code'], root, modules)).rejects.toThrow('--model is required');
    const h = harnessArguments('claude-code');
    await expect(runSolver([...args, ...h.flags, '--skill-loading', 'native'], root, modules))
      .rejects.toThrow('math_harness_native_skill_loading_unsupported');
    await expect(runSolver([...args, ...h.flags, '--codex', 'codex'], root, modules)).rejects.toThrow('--codex requires');
    expect(open).not.toHaveBeenCalled();
  });

  it.each([{ flags: [], capacity: 4 }, { flags: ['--skill-max-agents', '8'], capacity: 8 }])(
    'pins an Agent-led team of $capacity including one Lead and restores it on resume', async ({ flags: capacityFlags, capacity }) => {
    const flags = [...args, '--research-mode', 'skill', '--skill-delegation', 'team', ...capacityFlags];
    const code = await runSolver(flags, root, modules);
    expect(code, vi.mocked(console.log).mock.calls.flat().join('\n')).toBe(0);
    const before = state();
    expect(before).toMatchObject({ researchMode: 'skill', researchSkillWorkflow: 'full',
      researchDelegation: { mode: 'team', maxAgents: capacity }, workerCount: 1, coordination: 'independent',
      researchSkill: { name: 'theoremos-research', loading: 'native' }, turns: 0 });
    expect(before.workers).toBeUndefined(); expect(before.cooperation).toBeUndefined();
    expect(before.researchDelegation).not.toHaveProperty('preferredProfiles');
    expect(before.nativeAgents).toBeUndefined(); expect(before.threadId).toBeUndefined();
    expect(await runSolver([...args, '--resume'], root, modules)).toBe(0);
    expect(state()).toMatchObject({ runId: before.runId, researchDelegation: before.researchDelegation,
      researchSkill: before.researchSkill, agentSessionPlan: before.agentSessionPlan, methodDigest: before.methodDigest,
      workerCount: 1, coordination: 'independent', turns: 0 });
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects a new direct Westlake Chat team before saving a run', async () => {
    const profile = path.join(example.directory, 'westlake-profile');
    prepareWestlakeProfile(profile, 'deepseek-flash', 'high');
    vi.stubEnv('THEOREMOS_CODEX_BACKEND_EXECUTABLE', path.join(example.directory, 'missing-native-backend'));
    expect(await runSolver([...args, '--agent-team', '3', '--harness-profile', profile], root, modules)).toBe(1);
    rejected('math_westlake_native_team_unsupported: select a native-compatible Codex profile such as the Responses gateway.');
    expect(fs.existsSync(output + '.runtime/state.json')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['host-tools', 'native-agent-control'] as const)('preserves a historical Westlake checkpoint with %s transport', async transport => {
    expect(await runSolver([...args, '--agent-team', '3', '--codex', process.execPath], root, modules)).toBe(0);
    const profile = path.join(example.directory, 'westlake-profile');
    prepareWestlakeProfile(profile, 'deepseek-flash', 'high');
    const saved = state();
    saved.agentHarness = bindResearchHarness('codex', process.execPath, profile, process.env, saved.model);
    saved.agentTeam!.transport = transport;
    const stateFile = output + '.runtime/state.json';
    writeSolverRunState(stateFile, saved);
    const original = fs.readFileSync(stateFile);
    if (transport === 'host-tools') {
      await expect(runSolver([...args, '--resume'], root, modules, undefined, 'cli'))
        .rejects.toThrow('math_legacy_collaboration_retired');
    } else {
      expect(await runSolver([...args, '--resume'], root, modules, undefined, 'cli')).toBe(1);
      rejected('math_westlake_native_team_unsupported: select a native-compatible Codex profile such as the Responses gateway.');
    }
    expect(fs.readFileSync(stateFile)).toEqual(original);
    expect(open).not.toHaveBeenCalled();
  });

  it('freezes optional profiles without filling seats and preserves them on resume', async () => {
    const team = [...args, '--research-mode', 'skill', '--skill-delegation', 'team', '--skill-max-agents', '8'];
    expect(await runSolver([...team, '--skill-preferred-profiles', ' engineer,elementary-number-theory,D011 '], root, modules)).toBe(0);
    const before = state();
    expect(before.researchDelegation).toEqual({ mode: 'team', maxAgents: 8, preferredProfiles: ['D011', 'engineer'] });
    expect(before.agentTeam!.workers).toEqual([]);
    expect(await runSolver([...args, '--resume'], root, modules)).toBe(0);
    expect(await runSolver([...args, '--resume', '--skill-preferred-profiles', 'D011,engineer'], root, modules)).toBe(0);
    expect(await runSolver([...args, '--resume', '--skill-preferred-profiles', 'reviewer'], root, modules)).toBe(1);
    rejected('math_resume_research_strategy_changed');
    expect(state()).toMatchObject({ runId: before.runId, researchDelegation: before.researchDelegation, turns: 0 });
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects a reserved profile before creating a team checkpoint', async () => {
    const flags = [...args, '--research-mode', 'skill', '--skill-delegation', 'team',
      '--skill-preferred-profiles', 'engineer,lead'];
    expect(await runSolver(flags, root, modules)).toBe(1);
    rejected('math_team_preferred_profile_invalid: "lead"');
    expect(fs.existsSync(output + '.runtime/state.json')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('reuses frozen personal knowledge without the CLI file and rejects a changed body on resume', async () => {
    const file = path.join(example.directory, 'personal-cards.json');
    const card = { assetId: 'specialist', name: 'User specialist', version: '1', digest: 'a'.repeat(64),
      summary: 'Introduces the relevant structures.', knowledge: 'Definition and assumptions from the selected release.' };
    fs.writeFileSync(file, JSON.stringify([card]));
    expect(await runSolver([...args, '--research-mode', 'skill', '--skill-delegation', 'team', '--skill-expert-cards-file', file], root, modules)).toBe(0);
    expect(state().researchDelegation).toMatchObject({ personalExperts: { cards: [card] } });
    fs.unlinkSync(file);
    expect(await runSolver([...args, '--resume'], root, modules)).toBe(0);
    fs.writeFileSync(file, JSON.stringify([{ ...card, knowledge: 'Changed without a new release.' }]));
    expect(await runSolver([...args, '--resume', '--skill-expert-cards-file', file], root, modules)).toBe(1);
    rejected('math_resume_research_strategy_changed');
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    { initial: 'team', changes: ['--skill-max-agents', '2'] },
  ])('rejects changing frozen $initial delegation through $changes on resume', async ({ initial, changes }) => {
    expect(await runSolver([...args, '--research-mode', 'skill', '--skill-delegation', initial, '--skill-max-agents', '3'], root, modules)).toBe(0);
    const before = state();
    expect(await runSolver([...args, '--resume', ...changes], root, modules)).toBe(1);
    rejected('math_resume_research_strategy_changed');
    expect(state()).toMatchObject({ runId: before.runId, researchDelegation: before.researchDelegation, turns: 0 });
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ['--coordination', 'cooperative'], ['--module-plan', 'unused-team-plan.json'],
  ].map(flags => ({ flags })))('rejects host-controlled team configuration $flags before opening any session', async ({ flags }) => {
    await expect(runSolver([...args, '--research-mode', 'skill', '--skill-delegation', 'team',
      '--skill-max-agents', '3', ...flags], root, modules)).rejects.toThrow('math_team_requires_single_lead');
    expect(open).not.toHaveBeenCalled();
    expect(fs.existsSync(output + '.runtime/state.json')).toBe(false);
  });

  it.each([['--workers', '2'], ['--coordination', 'cooperative'], ['--skill-delegation', 'read-only']])(
    'rejects retired execution flag %s before starting or writing a run', async (...flags) => {
      await expect(runSolver([...args, ...flags], root, modules)).rejects.toThrow('math_legacy_collaboration_retired');
      expect(fs.existsSync(output + '.runtime/state.json')).toBe(false);
      expect(open).not.toHaveBeenCalled();
    });

  it.each(['fixed workers', 'completed portfolio'] as const)('keeps history readable and rejects resuming %s', async mode => {
    expect(await runSolver(args, root, modules)).toBe(0);
    const historical = state();
    if (mode === 'fixed workers') {
      historical.workerCount = 2;
      historical.coordination = 'cooperative';
    } else historical.portfolioExploration = { phase: 'completed', durationMs: 1000, scouts: [] };
    const stateFile = output + '.runtime/state.json';
    writeSolverRunState(stateFile, historical);
    const original = fs.readFileSync(stateFile);
    expect(state()).toMatchObject({ runId: historical.runId, coordination: historical.coordination,
      workerCount: historical.workerCount, ...(historical.portfolioExploration ? { portfolioExploration: historical.portfolioExploration } : {}) });
    await expect(runSolver([...args, '--resume'], root, modules, undefined, 'cli'))
      .rejects.toThrow('math_legacy_collaboration_retired');
    expect(fs.readFileSync(stateFile)).toEqual(original);
    expect(open).not.toHaveBeenCalled();
  });

  it.each([false, true])('defaults public CLI runs to a native team, with optional approval %s', async required => {
    const flags = [...args, ...(required ? ['--plan-approval'] : [])];
    expect(await runSolver(flags, root, modules, undefined, 'cli')).toBe(0);
    const saved = state();
    expect(saved).toMatchObject({ agentTeam: { transport: 'native-agent-control' },
      researchDelegation: { mode: 'team', maxAgents: 4 }, workerCount: 1, turns: 0 });
    expect(Boolean(saved.planApproval)).toBe(required);
    expect(await runSolver([...args, '--resume'], root, modules, undefined, 'cli')).toBe(0);
    expect(state().runId).toBe(saved.runId);
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['claude-code', 'opencode', 'cli'] as const)('clearly rejects Agent-led team tools on the %s adapter', async id => {
    await expect(runSolver([...args, '--harness', id, '--model', 'offline-fixture', '--research-mode', 'skill',
      '--skill-delegation', 'team', '--skill-max-agents', '3'], root, modules))
      .rejects.toThrow('math_team_requires_codex_dynamic_tools');
    expect(open).not.toHaveBeenCalled();
    expect(fs.existsSync(output + '.runtime/state.json')).toBe(false);
  });

  it.each([['--skill-max-agents', '3'],
    ['--skill-preferred-profiles', 'engineer'],
    ['--research-mode', 'skill', '--skill-delegation', 'team', '--skill-max-agents', '9'],
    ['--research-mode', 'skill', '--skill-loading', 'file', '--common-research-skill', 'native']].map(flags => ({ flags })))
  ('rejects an incompatible optional research capability $flags', async ({ flags }) => {
    await expect(runSolver([...args, ...flags], root, modules)).rejects.toThrow(/invalid --/u);
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects changing strategy or loading mode on a saved run', async () => {
    expect(await runSolver([...args, '--research-mode', 'skill'], root, modules)).toBe(0);
    expect(await runSolver([...args, '--resume', '--skill-loading', 'file'], root, modules)).toBe(1);
    rejected('math_resume_research_strategy_changed');
    expect(await runSolver([...args, '--resume', '--research-mode', 'legacy', '--workers', '1', '--coordination', 'independent'], root, modules)).toBe(1);
    rejected('math_resume_research_strategy_changed');
  });

  it('keeps old Skill checkpoints on their frozen single-researcher workflow', async () => {
    expect(await runSolver([...args, '--research-mode', 'skill'], root, modules)).toBe(0);
    const historical = state(); delete historical.researchSkillWorkflow; delete historical.agentSessionPlan;
    writeSolverRunState(output + '.runtime/state.json', historical);
    expect(await runSolver([...args, '--resume'], root, modules)).toBe(0);
    expect(state().researchSkillWorkflow).toBeUndefined(); expect(state().agentSessionPlan).toBeUndefined();
    await expect(runSolver([...args, '--resume', '--workers', '2'], root, modules))
      .rejects.toThrow('math_legacy_collaboration_retired');
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects a changed frozen execution plan instead of silently selecting another fallback on resume', async () => {
    expect(await runSolver([...args, '--research-mode', 'skill'], root, modules)).toBe(0);
    const changed = state(); changed.agentSessionPlan!.continuation = 'source-context';
    writeSolverRunState(output + '.runtime/state.json', changed);
    expect(await runSolver([...args, '--resume'], root, modules)).toBe(1);
    rejected('math_resume_session_plan_changed'); expect(open).not.toHaveBeenCalled();
  });

  it('rejects approval on a solo run', async () => {
    await expect(runSolver([...args, '--research-mode', 'skill', '--plan-approval'], root, modules))
      .rejects.toThrow('--plan-approval requires a native team');
  });

  it('rejects modified references on resume rather than silently refreshing a live strategy', async () => {
    expect(await runSolver([...args, '--research-mode', 'skill'], root, modules)).toBe(0);
    fs.appendFileSync(path.join(root, 'skills/theoremos-research/references/lean.md'), '\nChanged instructions.\n');
    expect(await runSolver([...args, '--resume'], root, modules)).toBe(1);
    rejected('math_resume_research_strategy_changed');
    expect(open).not.toHaveBeenCalled();
  });

  it('does not overwrite a changed projected skill and does not permit unrelated agent configuration', async () => {
    const skill = readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md'));
    const projected = prepareResearchSkill(root, example.workspace, researchSkillIdentity(skill));
    fs.chmodSync(projected.path, 0o600); fs.appendFileSync(projected.path, '\nChanged.\n');
    expect(() => prepareResearchSkill(root, example.workspace, researchSkillIdentity(skill)))
      .toThrow('math_research_skill_changed');
    fs.writeFileSync(path.join(example.workspace, '.agents/config.toml'), 'untrusted = true\n');
    expect(() => assertSolverSources(example.problem, example.workspace)).toThrow();
  });

  it('retries an interrupted first projection without exposing a partial installed skill', () => {
    const skill = readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md'));
    vi.spyOn(fs, 'cpSync').mockImplementationOnce((source, destination) => {
      fs.mkdirSync(destination, { recursive: true });
      fs.copyFileSync(path.join(String(source), 'SKILL.md'), path.join(String(destination), 'SKILL.md'));
      throw new Error('fixture_copy_interrupted');
    });
    expect(() => prepareResearchSkill(root, example.workspace, researchSkillIdentity(skill), example.problem))
      .toThrow('fixture_copy_interrupted');
    expect(fs.existsSync(path.join(example.workspace, '.agents/skills/theoremos-research'))).toBe(false);
    const projected = prepareResearchSkill(root, example.workspace, researchSkillIdentity(skill), example.problem);
    expect(researchSkillIdentity(projected)).toEqual(researchSkillIdentity(skill));
    expect(() => assertSolverSources(example.problem, example.workspace)).not.toThrow();
  });

  it('projects and reuses the complete pinned skill in an actual Bun process', () => {
    const skill = readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md'));
    const child = spawnSync('bun', ['--eval', `
      import { prepareResearchSkill, researchSkillIdentity } from ${JSON.stringify(path.join(repository, 'src/solver/researchSkill.ts'))};
      const root=${JSON.stringify(root)}, worktree=${JSON.stringify(example.workspace)}, expected=${JSON.stringify(researchSkillIdentity(skill))};
      const first=prepareResearchSkill(root,worktree,expected);
      const second=prepareResearchSkill(root,worktree,expected);
      console.log(JSON.stringify({first:researchSkillIdentity(first),second:researchSkillIdentity(second)}));
    `], { encoding: 'utf8', timeout: 10_000 });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ first: researchSkillIdentity(skill), second: researchSkillIdentity(skill) });
    const projected = prepareResearchSkill(root, example.workspace, researchSkillIdentity(skill), example.problem);
    expect(fs.statSync(projected.path).mode & 0o777).toBe(0o400);
    expect(() => assertSolverSources(example.problem, example.workspace)).not.toThrow();
  });

  it.skipIf(process.platform !== 'linux')('resumes after SIGKILL during the first skill copy with no partial installed identity', () => {
    const skill = readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md'));
    const child = spawnSync('bun', ['--eval', `
      import fs from 'node:fs';
      import path from 'node:path';
      import { prepareResearchSkill } from ${JSON.stringify(path.join(repository, 'src/solver/researchSkill.ts'))};
      fs.cpSync = (source, destination) => {
        fs.mkdirSync(destination, { recursive: true });
        fs.copyFileSync(path.join(source, 'SKILL.md'), path.join(destination, 'SKILL.md'));
        process.kill(process.pid, 'SIGKILL');
      };
      prepareResearchSkill(${JSON.stringify(root)}, ${JSON.stringify(example.workspace)}, ${JSON.stringify(researchSkillIdentity(skill))});
    `], { encoding: 'utf8', timeout: 10_000 });
    expect(child.error).toBeUndefined(); expect(child.signal, child.stderr).toBe('SIGKILL');
    expect(fs.existsSync(path.join(example.workspace, '.agents/skills/theoremos-research'))).toBe(false);
    const projected = prepareResearchSkill(root, example.workspace, researchSkillIdentity(skill), example.problem);
    expect(researchSkillIdentity(projected)).toEqual(researchSkillIdentity(skill));
    expect(() => assertSolverSources(example.problem, example.workspace)).not.toThrow();
  });

  it('does not publish a copied skill whose references changed during projection', () => {
    const skill = readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md'));
    const copy = fs.cpSync;
    vi.spyOn(fs, 'cpSync').mockImplementationOnce((source, destination, options) => {
      copy(source, destination, options);
      fs.appendFileSync(path.join(String(destination), 'references/lean.md'), '\nChanged while copying.\n');
    });
    expect(() => prepareResearchSkill(root, example.workspace, researchSkillIdentity(skill), example.problem))
      .toThrow('math_research_skill_changed');
    expect(fs.existsSync(path.join(example.workspace, '.agents/skills/theoremos-research'))).toBe(false);
    expect(() => prepareResearchSkill(root, example.workspace, researchSkillIdentity(skill), example.problem)).not.toThrow();
  });

  it('keeps legacy source ownership strict for an unpinned skill directory', () => {
    const skill = readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md'));
    prepareResearchSkill(root, example.workspace, researchSkillIdentity(skill));
    expect(() => assertSolverSources(example.problem, example.workspace)).toThrow();
    prepareResearchSkill(root, example.workspace, researchSkillIdentity(skill), example.problem);
    expect(() => assertSolverSources(example.problem, example.workspace)).not.toThrow();
  });
});
