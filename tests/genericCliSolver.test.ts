import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSolverRunState } from '../src/solver/archive';
import { runSolver } from '../src/solver/run';
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

const peerSource = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
const profile = arg('--profile'), file = path.join(profile, 'invocations.json');
const invocations = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : [];
const resume = args.includes('--resume') ? arg('--resume') : undefined;
const id = resume || crypto.randomUUID();
invocations.push({ id, resume, prompt: fs.readFileSync(0,'utf8'), model: arg('--model'), effort: arg('--effort'),
  credential: process.env.RESEARCH_CREDENTIAL, endpoint: process.env.RESEARCH_ENDPOINT });
fs.writeFileSync(file, JSON.stringify(invocations));
console.log(JSON.stringify({ kind:'init', session:{id} }));
const multiplier = args.includes('--cumulative') ? invocations.length : 1;
console.log(JSON.stringify({kind:'final',text:'Saved research.',input:11*multiplier,output:5*multiplier}));
`;

describe('generic CLI through the shared Skill solver', () => {
  let example: ReturnType<typeof localExample>, root: string, output: string, profile: string, executable: string;
  let args: string[], config: Record<string, unknown>;
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const task = 'Frozen generic CLI task contract: prove all original tutorial targets.';
  beforeEach(() => {
    example = localExample('generic-cli-solver-');
    root = path.join(example.directory, 'runtime'); fs.mkdirSync(root);
    fs.cpSync(path.join(repository, 'skills'), path.join(root, 'skills'), { recursive: true });
    profile = path.join(example.directory, 'profile'); fs.mkdirSync(profile);
    executable = path.join(example.directory, 'native.cjs'); fs.writeFileSync(executable, peerSource, { mode: 0o700 });
    output = path.join(example.directory, 'run.json');
    const taskFile = path.join(example.directory, 'task.md'), build = path.join(example.directory, 'build.json');
    fs.writeFileSync(taskFile, task); fs.writeFileSync(build, '{}');
    config = { schema: 'theorem-os.cli-harness.v1', executable,
      args: ['--profile', '{profile}', '--model', '{model}', '--effort', '{effort}'],
      output: { format: 'jsonl', text: { field: '/text', when: { field: '/kind', value: 'final' } }, usage: {
        when: { field: '/kind', value: 'final' }, inputTokens: '/input', outputTokens: '/output', completeness: 'complete',
      } } };
    args = ['--workspace', example.workspace, '--task-file', taskFile, '--build-manifest', build,
      '--output', output, '--harness', 'cli', '--harness-profile', profile, '--model', 'fixture', '--effort', 'none'];
    vi.stubEnv('DEEPSCIENTIST_MATH_ENV_FILE', path.join(example.directory, 'empty.env'));
    vi.stubEnv('DEEPSCIENTIST_MATH_PANTOGRAPH_MANIFEST', undefined);
    vi.stubEnv('DEEPSCIENTIST_MATH_PANTOGRAPH_SHA256', undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(example.directory, { recursive: true, force: true }); });
  const write = () => fs.writeFileSync(path.join(profile, 'cli.json'), JSON.stringify(config));
  const state = () => readSolverRunState(output + '.runtime/state.json');
  const invocations = (): { id: string; resume?: string; prompt: string; credential?: string; endpoint?: string }[] =>
    JSON.parse(fs.readFileSync(path.join(profile, 'invocations.json'), 'utf8'));
  const outputConfig = () => config.output as { usage?: { completeness: string; scope?: string }; [name: string]: unknown };

  it('uses the configured executable, pins portable startup state and inherits it on resume', async () => {
    write();
    expect(await runSolver([...args, '--startup-only'], root)).toBe(0);
    const before = state();
    expect(before).toMatchObject({ researchMode: 'skill', effort: 'none', coordination: 'independent', workerCount: 1,
      researchSkill: { loading: 'file' }, agentHarness: { id: 'cli', executable, profile } });
    expect(fs.existsSync(path.join(profile, 'invocations.json'))).toBe(false);
    const resume = args.slice(0, args.indexOf('--harness'));
    expect(await runSolver([...resume, '--resume', '--startup-only'], root)).toBe(0);
    expect(state().agentHarness).toEqual(before.agentHarness); expect(state().effort).toBe('none');
  });

  it('honors an explicit executable override', async () => {
    config.executable = 'unavailable-configured-command'; write();
    expect(await runSolver([...args, '--harness-executable', executable, '--startup-only'], root)).toBe(0);
    expect(state().agentHarness!.executable).toBe(executable);
  });

  it('requires a supported explicit effort instead of pretending to control reasoning', async () => {
    write();
    expect(await runSolver([...args.slice(0, args.indexOf('--effort')), '--startup-only'], root)).toBe(1);
    const events = vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events).toContainEqual(expect.objectContaining({ event: 'rejected', reason: 'math_cli_effort_unsupported' }));
  });

  it('gives every one-shot process the full task on two turns and after a host resume', async () => {
    write();
    expect(await runSolver([...args, '--max-turns', '2'], root)).toBe(4);
    expect(invocations()).toHaveLength(2);
    expect(invocations().every(turn => turn.prompt.includes(task))).toBe(true);
    expect(new Set(invocations().map(turn => turn.id)).size).toBe(2);
    expect(state().usage!.totalTokens).toBe(32);
    expect(await runSolver([...args, '--resume', '--max-turns', '3'], root)).toBe(4);
    expect(invocations()).toHaveLength(3); expect(invocations()[2]!.prompt).toContain(task);
    expect(state().usage!.totalTokens).toBe(48);
  }, 60_000);

  it('persists a reported ID before turn_started and resumes exactly that ID with cumulative usage', async () => {
    config.session = { mode: 'reported', startArgs: [], resumeArgs: ['--resume', '{sessionId}'] };
    (config.args as string[]).push('--cumulative');
    outputConfig().sessionId = { field: '/session/id', when: { field: '/kind', value: 'init' } };
    outputConfig().usage!.scope = 'session'; write();
    const started: string[] = [];
    vi.mocked(console.log).mockImplementation(line => {
      const event = JSON.parse(String(line));
      if (event.event === 'turn_started') { expect(state().threadId).toBe(event.threadId); started.push(event.threadId); }
    });
    expect(await runSolver([...args, '--max-turns', '1'], root)).toBe(4);
    const id = state().threadId; expect(id).toBeTruthy(); expect(invocations()[0]!.resume).toBeUndefined();
    expect(await runSolver([...args, '--resume', '--max-turns', '2'], root)).toBe(4);
    expect(invocations()[1]!.resume).toBe(id); expect(state().threadId).toBe(id);
    expect(started).toEqual([id, id]); expect(state().usage!.totalTokens).toBe(32);
    expect(state().usageAccounting).toMatchObject({ reportedTurns: 2, pending: false, incomplete: false });
  }, 60_000);

  it.each(['missing', 'partial'] as const)('stops finite-budget dispatches after %s native accounting', async mode => {
    if (mode === 'missing') delete outputConfig().usage; else outputConfig().usage!.completeness = 'partial';
    write();
    expect(await runSolver([...args, '--max-turns', '2', '--max-total-tokens', '1000'], root)).toBe(4);
    expect(invocations()).toHaveLength(1); expect(state().turns).toBe(1);
    expect(state().tokenBudget!.usageComplete).toBe(false); expect(state().check?.passed).not.toBe(true);
  }, 60_000);

  it('passes explicit CLI credentials only to the native process and never saves them in host environments', async () => {
    vi.stubEnv('RESEARCH_CREDENTIAL', 'fixture-private-value'); vi.stubEnv('RESEARCH_ENDPOINT', 'http://127.0.0.1:1');
    config.inheritEnvironment = ['RESEARCH_CREDENTIAL', 'RESEARCH_ENDPOINT']; write();
    expect(await runSolver([...args, '--max-turns', '1'], root)).toBe(4);
    expect(invocations()[0]).toMatchObject({ credential: 'fixture-private-value', endpoint: 'http://127.0.0.1:1' });
    const saved = fs.readFileSync(output + '.runtime/environment-solver.json', 'utf8');
    expect(saved).not.toContain('RESEARCH_CREDENTIAL'); expect(saved).not.toContain('fixture-private-value');
    expect(saved).not.toContain('RESEARCH_ENDPOINT');
    expect(JSON.stringify(state())).not.toContain('fixture-private-value');
  }, 30_000);

  it.each(['configuration', 'endpoint', 'declared-file'] as const)('rejects %s drift on host resume', async kind => {
    config.configurationFiles = ['settings.json']; config.inheritEnvironment = ['RESEARCH_ENDPOINT'];
    vi.stubEnv('RESEARCH_ENDPOINT', 'http://127.0.0.1:1'); fs.writeFileSync(path.join(profile, 'settings.json'), '{}'); write();
    expect(await runSolver([...args, '--startup-only'], root)).toBe(0);
    if (kind === 'configuration') { (config.args as string[]).push('--changed'); write(); }
    else if (kind === 'endpoint') vi.stubEnv('RESEARCH_ENDPOINT', 'http://127.0.0.1:2');
    else fs.writeFileSync(path.join(profile, 'settings.json'), '{"changed":true}');
    expect(await runSolver([...args, '--resume', '--startup-only'], root)).toBe(1);
    const events = vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events).toContainEqual(expect.objectContaining({ event: 'rejected', reason: 'math_resume_harness_identity_changed' }));
    expect(fs.existsSync(path.join(profile, 'invocations.json'))).toBe(false);
  });
});
