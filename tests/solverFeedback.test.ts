import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ProofCheck } from '../src/solver/modules/evidence';
import { solverProofFeedback } from '../src/solver/feedback';

function failed(sourceDigest: string, line = 10, goal = '⊢ x > 0'): ProofCheck {
  return { passed: false, sourceDigest, verification: { status: 'failed', results: ['first', 'second'].map(theoremName => ({
    proofPath: 'Submission.lean', theoremName, status: 'failed', error: 'lean_compilation_failed',
    stdoutPreview: `Submission.lean:${line}:2: error: unsolved goals\nx : ℝ\nh : x ≥ 0\n${goal}\n`,
  })) } } as ProofCheck;
}

describe('proof progress feedback', () => {
  it('identifies candidate and checked projection before diagnostics, including in short feedback previews', () => {
    const current = { ...failed('source', 229), commit: 'a'.repeat(40) };
    current.verification.targetCommit = 'b'.repeat(40);
    const feedback = solverProofFeedback(current);
    const preview = Buffer.from(feedback).subarray(0, 2000).toString('utf8');
    expect(preview).toContain(`Candidate commit: ${current.commit}`);
    expect(preview).toContain(`Checked commit: ${current.verification.targetCommit}`);
    expect(preview).toContain('diagnostic locations refer to the checked source (including any projection)');
    expect(preview).toContain('may differ from the candidate/current working files');
    expect(preview).toContain(`From the Lean project directory, inspect the checked file with: git show '${current.verification.targetCommit}:./Submission.lean'`);
    expect(feedback.indexOf('Checked commit:')).toBeLessThan(feedback.indexOf('First blocking Lean message:'));
    expect(feedback).toContain('Submission.lean:229:2: error: unsolved goals');
  });

  it('identifies an unprojected frozen check without claiming its line numbers differ from the candidate', () => {
    const current = { ...failed('source'), commit: 'a'.repeat(40) };
    current.verification.targetCommit = current.commit;
    const feedback = solverProofFeedback(current);
    expect(feedback).toContain(`Candidate and checked commit: ${current.commit}`);
    expect(feedback).toContain('diagnostic locations refer to this frozen commit');
    expect(feedback).toContain(`git show '${current.commit}:./Submission.lean'`);
    expect(feedback).not.toContain('including any projection');
    expect(feedback).not.toContain('may differ from the candidate/');
  });

  it('reads the exact checked file from a nested project directory despite shell characters in its path', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'solver-feedback-'));
    try {
      const project = path.join(workspace, 'generated', 'problem');
      const proofPath = "User's proofs/$(probe).lean";
      const file = path.join(project, proofPath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'theorem checked : True := by trivial\n');
      const git = (args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
      git(['init', '--quiet']);
      git(['add', '.']);
      git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'checked source']);
      const checkedCommit = git(['rev-parse', 'HEAD']);
      fs.writeFileSync(file, 'theorem candidate : True := by trivial\n');
      git(['add', '.']);
      git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'candidate source']);
      const current = { ...failed('source'), commit: git(['rev-parse', 'HEAD']) };
      current.verification.targetCommit = checkedCommit;
      current.verification.results.forEach(result => { result.proofPath = proofPath; });
      const feedback = solverProofFeedback(current);
      const readCommand = feedback.split('\n').find(line => line.startsWith('From the Lean project directory,'))!.split('with: ')[1]!;
      expect(execSync(readCommand, { cwd: project, encoding: 'utf8' })).toBe('theorem checked : True := by trivial\n');
      expect(fs.readFileSync(file, 'utf8')).toBe('theorem candidate : True := by trivial\n');
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  it('reads Lean JSON messages, retains goal text and stable failure identity as locations move', () => {
    const previous = failed('old-source'), current = failed('new-source');
    for (const [check, line] of [[previous, 10], [current, 30]] as const) {
      check.verification.results.forEach(result => { result.stdoutPreview = JSON.stringify({ severity: 'error',
        data: 'unsolved goals\nx : Nat\nh : x > 0\n\u22a2 x > 1', fileName: 'Submission.lean', pos: { line, column: 3 }, kind: 'Tactic.unsolvedGoals' }); });
    }
    const feedback = solverProofFeedback(current, previous);
    expect(feedback).toContain('First blocking Lean message:');
    expect(feedback).toContain('Submission.lean:30:4: error(Tactic.unsolvedGoals)');
    expect(feedback).toContain('x : Nat\nh : x > 0\n\u22a2 x > 1');
    expect(feedback.split('unsolved goals\nx : Nat\nh : x > 0\n\u22a2 x > 1')).toHaveLength(2);
    expect(feedback).toContain('same Lean errors and goal contexts');
  });

  it('preserves coded Lean errors before their dependent unsolved goals', () => {
    const previous = failed('old-source');
    previous.verification.results.forEach(result => {
      result.stdoutPreview = 'Submission.lean:9:17: error(lean.unknownIdentifier): Unknown identifier `lower_bound`\n' + result.stdoutPreview;
    });
    const current = structuredClone(previous);
    current.sourceDigest = 'new-source';
    current.verification.results.forEach(result => { result.stdoutPreview = result.stdoutPreview!.replace(':9:17:', ':19:17:').replace(':10:2:', ':20:2:'); });
    const feedback = solverProofFeedback(current, previous);
    expect(feedback).toContain('Submission.lean:19:17: error(lean.unknownIdentifier)');
    expect(feedback.indexOf('Unknown identifier')).toBeLessThan(feedback.indexOf('unsolved goals'));
    expect(feedback).toContain('same Lean errors and goal contexts');
  });

  it('recognizes repeated errors after positions move, while preserving the current location', () => {
    const current = failed('new-source', 24);
    const feedback = solverProofFeedback(current, failed('old-source'));
    expect(feedback).toContain('same Lean errors and goal contexts');
    expect(feedback).toContain('Submission.lean:24:2: error: unsolved goals');
    expect(feedback).not.toContain('proof source is unchanged');
  });

  it('treats a changed goal or assumption as progress', () => {
    const previous = failed('old-source');
    const goal = failed('new-source', 24, '⊢ x ≥ 0');
    expect(solverProofFeedback(goal, previous)).not.toContain('same Lean errors and goal contexts');
    const assumption = failed('new-source', 24);
    assumption.verification.results.forEach(result => { result.stdoutPreview = result.stdoutPreview!.replace('h : x ≥ 0', 'h : x > 0'); });
    expect(solverProofFeedback(assumption, previous)).not.toContain('same Lean errors and goal contexts');
  });

  it('recognizes completed targets as progress despite unchanged diagnostics in another target', () => {
    const current = failed('new-source', 24);
    current.verification.results[1].status = 'kernel_verified';
    expect(solverProofFeedback(current, failed('old-source'))).not.toContain('same Lean errors and goal contexts');
  });

  it('keeps errors in different files distinct', () => {
    const current = failed('new-source');
    current.verification.results.forEach(result => { result.stdoutPreview = result.stdoutPreview!.replace('Submission.lean:', 'Helper.lean:'); });
    expect(solverProofFeedback(current, failed('old-source'))).not.toContain('same Lean errors and goal contexts');
  });

  it('does not infer repeated proof failures from missing diagnostics or infrastructure failures', () => {
    const previous = failed('old-source');
    for (const check of [previous, failed('new-source')]) {
      check.verification.results.forEach(result => { result.stdoutPreview = undefined; });
      expect(solverProofFeedback(check, previous)).not.toContain('same Lean errors and goal contexts');
    }
    const unavailable = failed('new-source');
    unavailable.verification.status = 'unavailable';
    expect(solverProofFeedback(unavailable, failed('old-source'))).not.toContain('same Lean errors and goal contexts');
  });
});
