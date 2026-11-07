import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask, readLeanTaskReceipt, LEAN_TASK_SOURCE_MAX_BYTES } from '../src/math/leanTask';
import { autoLibraryPlannerInput } from '../src/math/autoLibraryPlanner';
import { mathBuildFile, mathBuildSource, MATH_RUNTIME_BUNDLES } from '../src/math/mathBuildManifest';
import { canonicalMathJson, mathDigest, readMathText, writeMathJsonDurable } from '../src/math/mathRuntimeIo';
import { prepareAutoLibraryBuild, readAutoLibraryRequest } from '../src/solver/autoLibrary';
import { assertSolverSources, readSolverProblem } from '../src/solver/problem';
import { buildResearchContext } from '../src/solver/modules/context';
import { solverState } from './helpers/solver';
import { temporaryDirectory } from './helpers/files';

let directory: string;
beforeEach(() => { directory = temporaryDirectory('large-challenge-'); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

/** Frozen local metadata only: no compiler, model, provider or active campaign. */
function buildFixture() {
  const root = path.join(directory, 'source'), bundleRoot = path.join(root, 'out/main');
  fs.mkdirSync(bundleRoot, { recursive: true });
  for (const [name, text] of Object.entries({ 'bun.lock': '', 'package.json': '{}', 'tsconfig.json': '{}',
    'extraction.json': JSON.stringify({ schema: 'deepscientist.math.extraction.v1', sourceCommit: '1'.repeat(40) }),
    'scripts/build.ts': '', 'bin/math.ts': '', 'scripts/mathematics/searchLean.ts': '' })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  for (const name of MATH_RUNTIME_BUNDLES) fs.writeFileSync(path.join(bundleRoot, name), '// offline fixture\n');
  const manifest = path.join(directory, 'build.json');
  writeMathJsonDurable(manifest, { schema: 'deepscientist.math.build-manifest.v1', buildId: crypto.randomUUID(),
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), source: mathBuildSource(root), bundleRoot,
    bundles: MATH_RUNTIME_BUNDLES.map(name => mathBuildFile(path.join(bundleRoot, name))) }, 0o400);
  return { root, manifest };
}

function prepare(source: string, name = 'build') {
  const { root, manifest } = buildFixture();
  const build = path.join(directory, name);
  const request = prepareAutoLibraryBuild(build, root, { challengeId: 'large-fixture', challengeSource: source,
    task: 'Prove the frozen target.', environment: 'standard', pool: path.join(directory, 'pool'), buildManifestRef: manifest,
    planner: { model: 'fixture', effort: 'low', executable: '/fixture/codex', profile: '/fixture/profile' },
    prover: { model: 'fixture', effort: 'max', executable: '/fixture/codex', workers: 1, coordination: 'independent',
      maxRunSeconds: 1, maxTurns: 1, maxTurnSeconds: 1, maxTotalTokens: 0, prepareTimeoutSeconds: 1 },
    maxModules: 1, maxRounds: 1, maxRunSeconds: 1, maxTotalTokens: 0, plannerTurnSeconds: 1 });
  return { build, request };
}

describe('large frozen Lean challenge', () => {
  it('keeps a 1,426,542-byte, 1136-declaration challenge intact through request, planner input, bootstrap and solver guards', () => {
    const head = Array.from({ length: 1135 }, (_, index) => `def helper${index} : Nat := ${index}\n`).join('') +
      'theorem target : True := by sorry\n/-', tail = '-/\n';
    const source = head + 'x'.repeat(1_426_542 - Buffer.byteLength(head + tail)) + tail;
    expect(Buffer.byteLength(source)).toBe(1_426_542);
    const { build, request } = prepare(source);
    expect(readAutoLibraryRequest(build).request).toEqual(request);
    expect(request.challengeSource).toBe(source);
    const planner = autoLibraryPlannerInput({ challengeId: request.challengeId, challenge: source, task: request.task,
      environment: request.environment, library: [], taken: [], module: 0, round: 1, maxRounds: 1 });
    const input = path.join(directory, 'INPUT.json');
    writeMathJsonDurable(input, planner, 0o400);
    // The isolated role's existing 8 MB protocol bound already admits this challenge.
    expect(JSON.parse(readMathText(input, 8_000_000)).challenge.source).toBe(source);
    const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), { source, task: request.task });
    expect(receipt.declarations).toHaveLength(1136);
    expect(readLeanTaskReceipt(receipt.activeProblemPath)).toEqual(receipt);
    const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
    expect(problem.contract.formalStatement).toBe(source);
    expect(problem.targets.map(target => target.theoremName)).toEqual(['target']);
    expect(() => assertSolverSources(problem, receipt.workspaceRoot)).not.toThrow();
  });

  it('rejects oversized requests and bootstrap inputs before creating their workspaces', () => {
    const source = ' '.repeat(LEAN_TASK_SOURCE_MAX_BYTES + 1);
    expect(() => prepare(source)).toThrow();
    expect(fs.existsSync(path.join(directory, 'build'))).toBe(false);
    const workspace = path.join(directory, 'workspace');
    expect(() => bootstrapLeanTask(workspace, { source, task: 'Prove the target.' })).toThrow();
    expect(fs.existsSync(workspace)).toBe(false);
    const multibyte = `theorem target : True := by sorry\n/-${'界'.repeat(Math.ceil(LEAN_TASK_SOURCE_MAX_BYTES / 3))}-/\n`;
    expect(() => bootstrapLeanTask(workspace, { source: multibyte, task: 'Prove the target.' })).toThrow('lean_task_input_invalid');
    expect(fs.existsSync(workspace)).toBe(false);
  });

  it('dispatches a large declaration inventory within the default budget while retaining its exact interfaces and source', () => {
    const source = 'namespace Large\n' + Array.from({ length: 1135 }, (_, index) =>
      `def helper${index} (first second : Nat) (equal : first = second) : ` +
      '{ value : Nat // value = first ∧ value = second ∧ value + first = first + value ∧ value + second = second + value } ' +
      ':= ⟨first, by omega⟩\n').join('') + 'theorem target (n : Nat) : n = n := by sorry\nend Large\n';
    const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), { source, task: 'Prove the frozen target.' });
    const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
    const sourceFile = path.join(receipt.projectRoot, 'Submission.lean'), before = fs.readFileSync(sourceFile);
    const state = solverState(problem, receipt.workspaceRoot, { runId: 'large-context', phase: 'prepared',
      cooperation: { tasks: [], canonicalCommit: problem.baseCommit } });
    const context = buildResearchContext(problem, state, { root: directory, worktree: receipt.workspaceRoot,
      environment: {}, taskText: 'Prove the frozen target.', retrievalRoot: directory,
      assignment: { kind: 'lead', seedCommit: problem.baseCommit } });
    expect(context.manifest!.usedBytes).toBeLessThanOrEqual(512 * 1024);
    expect(context.manifest!.maxBytes).toBe(512 * 1024);
    const frozen = JSON.parse(context.message.split('Frozen source context and immutable retrieval references:\n')[1]!.split('\n\n')[0]!);
    const file = frozen.files[0];
    expect(file.commit).toBe(problem.baseCommit);
    expect(file.path).toBe('generated/problem/Submission.lean');
    expect(file.declarationCount).toBe(1136);
    expect(file.declarationsFrom).toBe('context');
    expect(file.declarations).toBeUndefined();
    expect(file.targetDeclarations).toEqual(problem.declarations['Submission.lean']!.filter(item => item.name === 'target'));
    for (const declaration of problem.declarations['Submission.lean']!) expect(file.context).toContain(declaration.header);
    expect(file.context).toContain('namespace Large');
    expect(file.context).toContain('end Large');
    expect(fs.readFileSync(sourceFile)).toEqual(before);
    expect(() => assertSolverSources(problem, receipt.workspaceRoot)).not.toThrow();
    expect(() => buildResearchContext(problem, state, { root: directory, worktree: receipt.workspaceRoot,
      environment: {}, taskText: 'Prove the frozen target.', retrievalRoot: directory,
      assignment: { kind: 'lead', seedCommit: problem.baseCommit }, maxContextBytes: 1024 }))
      .toThrow('math_context_mandatory_overflow');
  });

  it('reads the existing v1 request without changing its bytes, fields or digest', () => {
    const { build, request } = prepare('theorem target : True := by sorry\n');
    expect(request.schema).toBe('theorem-os.auto-library-build.v1');
    expect(request).not.toHaveProperty('definitionTargets');
    const file = path.join(build, 'request.json'), before = fs.readFileSync(file);
    const reread = readAutoLibraryRequest(build).request;
    expect(reread).toEqual(request);
    expect(mathDigest(canonicalMathJson(reread))).toBe(mathDigest(before));
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
