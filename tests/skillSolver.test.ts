import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readMathAgentSkill } from '../src/runtime/codexSkills';
import { readSolverRunState } from '../src/solver/archive';
import { directSolverModules } from '../src/solver/modules';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { runSolver } from '../src/solver/run';
import { assertSolverSources, git } from '../src/solver/problem';
import { localExample } from './helpers/solver';

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
    expect(await runSolver(execution, root, modules)).toBe(4);
    const saved = state();
    expect(saved.threadId).toBeTruthy(); expect(saved.turns).toBe(1);
    expect(saved.usage!.totalTokens).toBe(id === 'claude-code' ? 36 : 32);
    expect(saved.usageAccounting).toMatchObject({ reportedTurns: 1, pending: false, incomplete: false });
    expect(saved.tokenBudget!.usageComplete).toBe(true);
    expect(saved.check?.passed).not.toBe(true); expect(saved.pendingProofCheck).toBeUndefined();
    expect(saved.workers).toBeUndefined(); expect(saved.cooperation).toBeUndefined();
    // Reopening the same native conversation charges the new invocation, rather than taking a maximum.
    expect(await runSolver([...execution, '--resume', '--max-turns', '2'], root, modules)).toBe(4);
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
    expect(await runSolver([...args.filter(arg => arg !== '--startup-only'), ...h.flags, '--max-turns', '2'], root, modules)).toBe(1);
    expect(state()).toMatchObject({ turns: 1, error: 'math_harness_identity_changed' });
  });

  it('rejects unsupported harness capabilities and missing non-Codex model before creating a session', async () => {
    await expect(runSolver([...args, '--harness', 'claude-code'], root, modules)).rejects.toThrow('--model is required');
    const h = harnessArguments('claude-code');
    await expect(runSolver([...args, ...h.flags, '--skill-loading', 'native'], root, modules))
      .rejects.toThrow('math_harness_native_skill_loading_unsupported');
    await expect(runSolver([...args, ...h.flags, '--research-mode', 'legacy'], root, modules))
      .rejects.toThrow('math_harness_requires_skill_mode');
    await expect(runSolver([...args, ...h.flags, '--codex', 'codex'], root, modules)).rejects.toThrow('--codex requires');
    expect(open).not.toHaveBeenCalled();
  });

  it('pins the same shared mathematical guidance for legacy workers without changing their mode', async () => {
    const common = [...args, '--common-research-skill', 'native', '--workers', '2'];
    expect(await runSolver(common, root, modules)).toBe(0);
    const saved = state();
    expect(saved.researchMode).toBeUndefined(); expect(saved.researchSkill).toBeUndefined();
    expect(saved.commonResearchSkill).toMatchObject({ name: 'theoremos-research', loading: 'native' });
    for (const worker of saved.workers!) {
      const skill = readMathAgentSkill(path.join(worker.worktree, '.agents/skills/theoremos-research/SKILL.md'));
      expect(researchSkillIdentity(skill)).toEqual(saved.commonResearchSkill);
    }
    expect(await runSolver([...common, '--resume', '--common-research-skill', 'file'], root, modules)).toBe(1);
    rejected('math_resume_research_strategy_changed'); expect(open).not.toHaveBeenCalled();
  });

  it('rejects native delegation before starting a run when children cannot enforce read-only permissions', async () => {
    await expect(runSolver([...args, '--research-mode', 'skill', '--skill-delegation', 'read-only',
      '--skill-max-agents', '2'], root, modules)).rejects.toThrow('math_native_read_only_delegation_unsupported');
    expect(fs.existsSync(output + '.runtime/state.json')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it.each([['--skill-delegation', 'read-only'], ['--skill-max-agents', '3'],
    ['--research-mode', 'skill', '--skill-delegation', 'read-only', '--skill-max-agents', '5'],
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

  it.each([['--workers', '4'], ['--coordination', 'cooperative'], ['--scheduler', 'continuation'], ['--plan-approval']])
    ('rejects conflicting host strategy arguments %j', async (...flags) => {
      await expect(runSolver([...args, '--research-mode', 'skill', ...flags], root, modules))
        .rejects.toThrow('math_skill_research_requires_single_independent_direct');
      expect(fs.existsSync(output + '.runtime/state.json')).toBe(false);
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
