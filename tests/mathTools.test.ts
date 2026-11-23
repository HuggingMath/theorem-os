import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapLocalExample } from '../src/math/localExample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { mathToolGuide, mathToolsInstruction, readMathTools, MATH_TOOLS_ROOT_ENV, type MathTools } from '../src/math/mathTools';
import { projectMathematicsRuntimeEnvironment, resolveMathematicsRuntimeEnvironment } from '../src/math/mathRuntimeEnvironment';
import type { SolverRunState } from '../src/solver/archive';
import { frozenSourceContext } from '../src/solver/contextCompiler';
import { buildResearchContext } from '../src/solver/modules/context';
import { readSolverProblem, type SolverProblem } from '../src/solver/problem';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const manifest = (tools: unknown[] = [
  { name: 'pari-gp', version: '2.17.3', purpose: 'Number theory; gp -q < FILE.gp.', commands: ['gp'] },
  { name: 'nauty', version: '2.9.3', purpose: 'Graph generation; geng N | countg.', commands: ['geng', 'countg'] },
]) => ({ schema: 'theorem-os.math-tools.v1', tools });
function toolsRoot(value: unknown = manifest(), commands = ['gp', 'geng', 'countg']) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'math-tools-'))); roots.push(root);
  fs.mkdirSync(path.join(root, 'bin'));
  for (const name of commands) fs.writeFileSync(path.join(root, 'bin', name), `#!/bin/sh\necho ${name}-ran "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'manifest.json'), typeof value === 'string' ? value : JSON.stringify(value));
  return root;
}

describe('math tools manifest', () => {
  it('binds the listed executables to the exact manifest bytes', () => {
    const root = toolsRoot();
    const tools = readMathTools(root);
    expect(tools.digest).toBe(mathDigest(fs.readFileSync(path.join(root, 'manifest.json'))));
    expect(tools.tools.map(tool => tool.commands)).toEqual([['gp'], ['geng', 'countg']]);
    const text = mathToolsInstruction(tools);
    expect(text).toContain('- pari-gp 2.17.3 [gp]: Number theory');
    expect(text).toContain('- nauty 2.9.3 [geng, countg]');
    expect(text).toContain('never proof acceptance');
    expect(text).toContain('$TMPDIR');
    expect(text).toContain('timeout SECONDS');
  });

  it('keeps an unfamiliar executable discoverable and runs the examples from the offered profile', () => {
    const entries = [
      { name: 'python-stack', version: '1', purpose: 'Includes SymPy.', commands: ['math-python'] },
      { name: 'smt', version: '2', purpose: 'Integer constraints.', commands: ['cvc5'] },
      { name: 'experimental', version: '3', purpose: 'Computes a specialized invariant.', commands: ['my-invariant'] },
    ];
    const root = toolsRoot(manifest(entries), entries.flatMap(entry => entry.commands));
    const { summary, detail } = mathToolGuide(readMathTools(root), root);
    expect(summary).toMatch(/math-python.*SymPy/u);
    expect(summary).not.toMatch(/my-invariant|\bz3\b|visual-python/u);
    expect(detail).toContain('experimental 3 [my-invariant]: Computes a specialized invariant.');
    const example = detail.match(/```sh\n([\s\S]*?)\n```/u)![1]!;
    const ran = spawnSync('sh', ['-ec', example], { cwd: root, encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', [MATH_TOOLS_ROOT_ENV]: root }, timeout: 5_000 });
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toContain('math-python-ran -c from sympy import');
    expect(ran.stdout).toContain('cvc5-ran --lang smt2');
  });

  it('does not assume that a custom math-python ships scientific packages', () => {
    const root = toolsRoot(manifest([{ name: 'math-python', version: '1', purpose: 'Standard library only.', commands: ['math-python'] }]), ['math-python']);
    const { summary, detail } = mathToolGuide(readMathTools(root), root);
    expect(summary).toContain('math-python');
    expect(summary + detail).not.toMatch(/sympy|numpy|sage|visual-python|cvc5/iu);
  });

  it.each([
    ['a relative root', () => 'relative/tools', 'math_tools_root_invalid'],
    ['a non-normal root', () => toolsRoot() + '/', 'math_tools_root_invalid'],
    ['a missing manifest', () => { const root = toolsRoot(); fs.rmSync(path.join(root, 'manifest.json')); return root; }, 'math_tools_manifest_missing'],
    ['malformed JSON', () => toolsRoot('{'), 'math_tools_manifest_invalid'],
    ['an unknown schema', () => toolsRoot({ ...manifest(), schema: 'other' }), 'math_tools_manifest_invalid'],
    ['an extra field', () => toolsRoot({ ...manifest(), extra: 1 }), 'math_tools_manifest_invalid'],
    ['a multi-line purpose', () => toolsRoot(manifest([{ name: 'x', version: '1', purpose: 'a\nb', commands: ['gp'] }]), ['gp']),
      'math_tools_manifest_invalid'],
    ['a reserved command', () => toolsRoot(manifest([{ name: 'x', version: '1', purpose: 'p', commands: ['lean'] }]), ['lean']),
      'math_tools_manifest_invalid'],
    ['a path-like command', () => toolsRoot(manifest([{ name: 'x', version: '1', purpose: 'p', commands: ['../gp'] }]), []),
      'math_tools_manifest_invalid'],
    ['a duplicate command', () => toolsRoot(manifest([{ name: 'x', version: '1', purpose: 'p', commands: ['gp'] },
      { name: 'y', version: '1', purpose: 'p', commands: ['gp'] }]), ['gp']), 'math_tools_manifest_invalid'],
    ['an oversized manifest', () => toolsRoot(JSON.stringify(manifest()).padEnd(64_001, ' ')), 'math_tools_manifest_invalid'],
    ['a missing bin directory', () => { const root = toolsRoot(); fs.rmSync(path.join(root, 'bin'), { recursive: true }); return root; },
      'math_tools_bin_missing'],
    ['a missing command', () => toolsRoot(manifest(), ['gp', 'geng']), 'math_tools_command_missing:countg'],
    ['a non-executable command', () => { const root = toolsRoot(); fs.chmodSync(path.join(root, 'bin', 'gp'), 0o644); return root; },
      'math_tools_command_missing:gp'],
    ['a directory command', () => { const root = toolsRoot(manifest(), ['geng', 'countg']); fs.mkdirSync(path.join(root, 'bin', 'gp')); return root; },
      'math_tools_command_missing:gp'],
    ['an unlisted command', () => toolsRoot(manifest(), ['gp', 'geng', 'countg', 'lake']), 'math_tools_command_unlisted:lake'],
  ])('rejects %s', (_label, root, message) => {
    expect(() => readMathTools(root())).toThrow(message);
  });
});

describe('math tools on the solver PATH', () => {
  it('appends the tools bin after pinned and system entries, once, and keeps it through a frozen projection', () => {
    const root = toolsRoot();
    const env = resolveMathematicsRuntimeEnvironment({ PATH: '/custom/bin:/usr/bin', ELAN_HOME: '/pinned/elan',
      DEEPSCIENTIST_MATH_TOOLS_ROOT: root }, path.join(root, 'absent.env'));
    const entries = env.PATH!.split(path.delimiter);
    expect(entries[0]).toBe('/pinned/elan/bin');
    expect(entries.at(-1)).toBe(path.join(root, 'bin'));
    expect(entries.filter(entry => entry === path.join(root, 'bin'))).toHaveLength(1);
    const file = path.join(root, 'environment-solver.json');
    fs.writeFileSync(file, JSON.stringify(projectMathematicsRuntimeEnvironment({ ...env, DEEPSCIENTIST_MATH_ENV_FILE: file,
      DEEPSCIENTIST_MATH_TOOLS_SHA256: 'pinned' })));
    const frozen = resolveMathematicsRuntimeEnvironment({ DEEPSCIENTIST_MATH_ENV_FILE: file, DEEPSCIENTIST_MATH_TOOLS_ROOT: '/other' });
    expect(frozen.DEEPSCIENTIST_MATH_TOOLS_ROOT).toBe(root);
    expect(frozen.DEEPSCIENTIST_MATH_TOOLS_SHA256).toBe('pinned');
    expect(frozen.PATH!.split(path.delimiter).filter(entry => entry === path.join(root, 'bin'))).toHaveLength(1);
    const result = spawnSync('countg', ['-q'], { env: frozen, encoding: 'utf8', timeout: 5000 });
    expect(result.stdout.trim()).toBe('countg-ran -q');
  });

  it('keeps an empty PATH limited to the configured tools and leaves legacy projections without them', () => {
    const root = toolsRoot();
    expect(resolveMathematicsRuntimeEnvironment({ PATH: '', DEEPSCIENTIST_MATH_TOOLS_ROOT: root }, path.join(root, 'absent.env')).PATH!
      .split(path.delimiter)).toEqual([...(process.platform === 'linux' ? ['/usr/sbin'] : []), path.join(root, 'bin')]);
    const file = path.join(root, 'legacy.json');
    fs.writeFileSync(file, JSON.stringify(projectMathematicsRuntimeEnvironment({ DEEPSCIENTIST_MATH_ENV_FILE: file, PATH: '/usr/bin' })));
    const legacy = resolveMathematicsRuntimeEnvironment({ DEEPSCIENTIST_MATH_ENV_FILE: file, DEEPSCIENTIST_MATH_TOOLS_ROOT: root });
    expect(legacy.DEEPSCIENTIST_MATH_TOOLS_ROOT).toBeUndefined();
    expect(legacy.PATH!.split(path.delimiter)).not.toContain(path.join(root, 'bin'));
  });

  it('reads the tools root from a local env file', () => {
    const root = toolsRoot();
    const file = path.join(root, 'math.env');
    fs.writeFileSync(file, `DEEPSCIENTIST_MATH_TOOLS_ROOT=${root}\n`);
    const env = resolveMathematicsRuntimeEnvironment({ PATH: '/usr/bin' }, file);
    expect(env.DEEPSCIENTIST_MATH_TOOLS_ROOT).toBe(root);
    expect(projectMathematicsRuntimeEnvironment(env).DEEPSCIENTIST_MATH_TOOLS_ROOT).toBe(root);
    expect(env.PATH!.split(path.delimiter).at(-1)).toBe(path.join(root, 'bin'));
  });
});

describe('math tools in research context', () => {
  let directory: string, workspace: string, problem: SolverProblem, state: SolverRunState;
  beforeEach(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'math-tools-context-'))); roots.push(directory);
    workspace = path.join(directory, 'workspace');
    problem = readSolverProblem(workspace, bootstrapLocalExample(workspace).activeProblemPath);
    state = { schema: 'deepscientist.math.solver.v1', runId: 'tools-fixture', problem, taskDigest: 'task',
      buildDigest: 'build', environmentDigest: 'environment', evaluatorDigest: 'evaluator', model: 'unused', effort: 'unused',
      worktree: workspace, phase: 'running', turns: 0,
      cooperation: { canonicalCommit: problem.baseCommit, tasks: problem.targets.map((target, index) => ({ task: {
        id: `goal_${index}`, kind: 'goal' as const, objective: 'Original goal', theoremName: target.theoremName,
        proofPath: target.proofPath, dependsOn: [], revision: 0 }, status: 'pending' as const, attempts: 0 })) } };
  });
  const build = (environment: NodeJS.ProcessEnv, mathTools?: MathTools) => buildResearchContext(problem, state, {
    root: '/runtime', worktree: workspace, environment, taskText: 'Prove it.\n', retrievalRoot: workspace,
    assignment: { kind: 'lead', seedCommit: problem.baseCommit }, ...(mathTools ? { mathTools } : {}),
    frozenContexts: Object.fromEntries(problem.ownedFiles.map(file => [file,
      frozenSourceContext(problem, file, fs.readFileSync(path.join(workspace, problem.projectRelative, file), 'utf8'))])) });

  it('lists the digest-bound tools in worker instructions only when the run offers them', () => {
    const tools = readMathTools(toolsRoot());
    const offered = build({ DEEPSCIENTIST_MATH_TOOLS_SHA256: tools.digest }, tools).instructions;
    expect(offered).toContain(mathToolsInstruction(tools));
    expect(offered.indexOf('Installed mathematics tools')).toBeLessThan(offered.indexOf('Do not install packages'));
    expect(build({}).instructions).not.toContain('Installed mathematics tools');
    expect(() => build({ DEEPSCIENTIST_MATH_TOOLS_SHA256: 'other' }, tools)).toThrow('math_tools_identity_changed');
    expect(() => build({}, tools)).toThrow('math_tools_identity_changed');
  });
});
