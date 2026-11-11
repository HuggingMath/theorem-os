import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_EXAMPLE_PROOF } from '../src/math/localExample';
import { SingleSolverProofHandoff } from '../src/solver/singleSolverProofHandoff';
import { captureLeanCompletion } from './helpers/leanCompletion';
import { localExample } from './helpers/solver';

describe('single solver advisory proof handoff', () => {
  let example: ReturnType<typeof localExample>;
  let project: string;
  beforeEach(() => {
    example = localExample('single-proof-handoff-');
    project = path.join(example.workspace, example.problem.projectRelative);
    fs.writeFileSync(path.join(project, 'Submission.lean'), LOCAL_EXAMPLE_PROOF);
  });
  afterEach(() => { fs.rmSync(example.directory, { recursive: true, force: true }); });

  it('uses the existing diagnostic output with no extra model-written protocol', () => {
    const ready = vi.fn();
    const handoff = new SingleSolverProofHandoff(example.problem, example.workspace, ready);
    expect(handoff.output.file).toBe(path.join(project, '.lake/lean-diagnostics-latest.json'));
    const diagnostic = captureLeanCompletion(project);
    handoff.output.validate(diagnostic);
    expect(ready).toHaveBeenCalledExactlyOnceWith({ sourceDigest: diagnostic.sourceDigest,
      environmentDigest: diagnostic.environmentDigest });
    expect(handoff.takeSubmission()).toEqual(ready.mock.calls[0][0]);
    expect(handoff.takeSubmission()).toBeUndefined();
  });

  it.each(['source', 'dependency', 'configuration'] as const)('keeps proving after stale %s diagnostics', change => {
    fs.writeFileSync(path.join(project, 'Helper.lean'), 'def helper : Nat := 0\n');
    fs.writeFileSync(path.join(project, 'Submission.lean'), 'import Helper\n' + LOCAL_EXAMPLE_PROOF);
    const diagnostic = captureLeanCompletion(project), ready = vi.fn();
    const file = change === 'source' ? 'Submission.lean' : change === 'dependency' ? 'Helper.lean' : 'lakefile.toml';
    fs.appendFileSync(path.join(project, file), '\n');
    const handoff = new SingleSolverProofHandoff(example.problem, example.workspace, ready);
    expect(() => handoff.output.validate(diagnostic)).toThrow('math_single_solver_diagnostics_stale');
    expect(ready).not.toHaveBeenCalled();
  });

  it('matches the compiler source bytes when a UTF-8 byte order mark is present', () => {
    fs.writeFileSync(path.join(project, 'Submission.lean'), '\ufeff' + LOCAL_EXAMPLE_PROOF);
    const handoff = new SingleSolverProofHandoff(example.problem, example.workspace, vi.fn());
    expect(() => handoff.output.validate(captureLeanCompletion(project))).not.toThrow();
  });

  it.each([{ exitCode: 1 }, { timedOut: true }, { aborted: true }])('keeps failed or unfinished diagnostics advisory: %j', change => {
    const handoff = new SingleSolverProofHandoff(example.problem, example.workspace, vi.fn());
    expect(() => handoff.output.validate({ ...captureLeanCompletion(project), ...change })).toThrow();
    expect(handoff.takeSubmission()).toBeUndefined();
  });

  it.each(['sorry', 'admit'])('does not interrupt an unfinished %s proof that Lean may compile', placeholder => {
    fs.writeFileSync(path.join(project, 'Submission.lean'), LOCAL_EXAMPLE_PROOF.replace('by rfl', 'by ' + placeholder));
    const handoff = new SingleSolverProofHandoff(example.problem, example.workspace, vi.fn());
    expect(() => handoff.output.validate(captureLeanCompletion(project))).toThrow('math_single_solver_proof_incomplete');
  });

  it('requires every original proof file in a single diagnostic check', () => {
    const problem = { ...example.problem, targets: [...example.problem.targets,
      { ...example.problem.targets[0], theoremName: 'Other.target', proofPath: 'Other.lean' }] };
    const handoff = new SingleSolverProofHandoff(problem, example.workspace, vi.fn());
    expect(() => handoff.output.validate(captureLeanCompletion(project))).toThrow('math_single_solver_diagnostics_incomplete');
  });

  it('does not resubmit rejected unchanged sources, and allows a repaired candidate', () => {
    const ready = vi.fn(), handoff = new SingleSolverProofHandoff(example.problem, example.workspace, ready);
    const diagnostic = captureLeanCompletion(project);
    handoff.output.validate(diagnostic); handoff.takeSubmission();
    expect(() => handoff.output.validate(diagnostic)).toThrow('math_single_solver_submission_already_checked');
    fs.appendFileSync(path.join(project, 'Submission.lean'), '\n-- repaired candidate\n');
    handoff.output.validate(captureLeanCompletion(project));
    expect(ready).toHaveBeenCalledTimes(2);
  });
});
