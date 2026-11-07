import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { assertSolverProjectSources, readSolverProblem, solverSourceConstraints } from '../src/solver/problem';
import { temporaryDirectory } from './helpers/files';

const roots: string[] = [];
const source = '/-! Original module notes. -/\nnamespace Safe\nsection Original\n' +
  'set_option autoImplicit false\n#eval IO.println "literal -- /- data -/"\n' +
  'theorem target : True := by sorry\nend Original\nend Safe\n';
function fixture() {
  const directory = temporaryDirectory('source-comment-guard-'); roots.push(directory);
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), { source, task: 'Prove True.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  return { receipt, problem, file: path.join(receipt.projectRoot, 'Submission.lean') };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('comment-compatible frozen source context', () => {
  it.each([
    ['module heading', source.replace('namespace Safe', '/-! New heading with fake namespace Bad -/\nnamespace Safe')],
    ['nested block', source.replace('section Original', '/- outer /- inner -/ still outer -/\nsection Original')],
    ['line comment', source.replace('end Original', '-- namespace Bad; set_option autoImplicit true\nend Original')],
    ['inline block', source.replace('namespace Safe', 'namespace /- heading -/ Safe')],
    ['changed existing note', source.replace('Original module notes.', 'Updated explanatory note.')],
    ['doc on helper', source.replace('theorem target', '/-- Explains a helper; not an attribute. -/\nlemma helper : True := by trivial\n\ntheorem target')],
  ])('accepts inert %s while preserving the frozen legacy digest', (_label, candidate) => {
    const { receipt, problem, file } = fixture();
    const hashes = { ...problem.sourceStructure };
    expect(mathDigest(problem.sourceContexts!['Submission.lean']!)).toBe(hashes['Submission.lean']);
    fs.writeFileSync(file, candidate);
    const constraints = JSON.parse(JSON.stringify(solverSourceConstraints(problem)));
    expect(() => assertSolverProjectSources(constraints, receipt.projectRoot)).not.toThrow();
    expect(readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath).sourceStructure).toEqual(hashes);
  });

  it.each([
    ['namespace', source.replace('namespace Safe', 'namespace Other')],
    ['section', source.replace('section Original', 'section Other')],
    ['option', source.replace('autoImplicit false', 'autoImplicit true')],
    ['attribute following doc', source.replace('theorem target', '/-- harmless prose -/\n@[simp]\ntheorem target')],
    ['scope following module doc', source.replace('theorem target', '/-! harmless prose -/\nopen Nat\ntheorem target')],
    ['literal with comment markers', source.replace('literal -- /- data -/', 'changed -- /- data -/')],
    ['literal whitespace', source.replace('literal -- /- data -/', 'literal  -- /- data -/')],
  ])('rejects effective %s changes even when comments also change', (_label, candidate) => {
    const { receipt, problem, file } = fixture();
    fs.writeFileSync(file, '/-! Added inert note. -/\n' + candidate);
    expect(() => assertSolverProjectSources(problem, receipt.projectRoot)).toThrow('math_original_context_changed');
  });

  it('rejects a forged context preimage instead of trusting a replacement normalized context', () => {
    const { receipt, problem, file } = fixture();
    fs.writeFileSync(file, source.replace('autoImplicit false', 'autoImplicit true'));
    const forged = { ...problem, sourceContexts: { 'Submission.lean': problem.sourceContexts!['Submission.lean']!
      .replace('autoImplicit false', 'autoImplicit true') } };
    expect(() => assertSolverProjectSources(forged, receipt.projectRoot)).toThrow('math_original_context_changed');
  });

  it('keeps old constraints strict and lets an unchanged seed generate bound contexts for continuation', () => {
    const { receipt, problem, file } = fixture();
    const { sourceContexts: _contexts, ...legacy } = problem;
    expect(() => assertSolverProjectSources(legacy, receipt.projectRoot)).not.toThrow();
    fs.writeFileSync(file, '/-! New notes. -/\n' + source);
    expect(() => assertSolverProjectSources(legacy, receipt.projectRoot)).toThrow('math_original_context_changed');
    const continued = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
    expect(continued.sourceStructure).toEqual(legacy.sourceStructure);
    expect(() => assertSolverProjectSources(continued, receipt.projectRoot)).not.toThrow();
  });
});
