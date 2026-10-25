import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mathDigest, canonicalMathJson } from '../../src/math/mathRuntimeIo';
import { hashMathFormalSourceDeclaration } from '../../src/math/leanSource';
import { writeSolverRunState, type SolverRunState } from '../../src/solver/archive';
import type { TaskProof } from '../../src/solver/cooperativeProof';
import { taskVersion, type CooperativeTask } from '../../src/solver/tasks';
import { writeWebActiveRun } from '../../apps/web/workerBridge';

/** Disposable Git/state fixture. Every receipt is synthetic; no Lean process or model is invoked. */
export function webWorkerFixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-worker-bridge-')));
  const output = path.join(directory, 'result.json'), stateFile = `${output}.runtime/state.json`;
  const worktree = path.join(path.dirname(stateFile), 'worktree'), relative = 'generated/problem';
  const project = path.join(worktree, relative); fs.mkdirSync(project, { recursive: true });
  const original = 'namespace Original\ntheorem goal : True := by sorry\n';
  const sourceFor = (body: string) => original + body + '\nend Original\n';
  const oldSource = sourceFor('lemma helper : True := by trivial');
  const source = sourceFor('lemma helper : True ∧ True := by constructor <;> trivial');
  fs.writeFileSync(path.join(project, 'Submission.lean'), oldSource);
  const git = (...args: string[]) => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  const commit = () => { git('add', '--', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
    'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture'); return git('rev-parse', 'HEAD'); };
  const baseCommit = commit();
  fs.writeFileSync(path.join(project, 'Submission.lean'), source); const currentCommit = commit();
  const oldTask: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Prove the helper', dependsOn: [], revision: 0,
    theoremName: 'Original.helper', proofPath: 'Submission.lean', type: 'True' };
  const task: CooperativeTask = { ...oldTask, revision: 1, type: 'True ∧ True' };
  const goal: CooperativeTask = { id: 'goal', kind: 'goal', objective: 'Prove the frozen original goal', dependsOn: ['helper'], revision: 0,
    theoremName: 'Original.goal', proofPath: 'Submission.lean' };
  const proofFor = (target: CooperativeTask, targetCommit: string, text: string): TaskProof => {
    const version = taskVersion(target);
    return { commit: targetCommit, sourceDigest: mathDigest(canonicalMathJson([['Submission.lean', mathDigest(text)]])),
      passed: true, taskDigest: version, seedCommit: baseCommit, changes: [], conditions: [],
      verification: { schema: 'deepscientist.mathematics.verification-batch/v1', status: 'kernel_verified', targetCommit,
        sessionId: 'synthetic-fixture', events: [], startedAt: 1, checkedAt: 2, durationMs: 1,
        results: [{ status: 'kernel_verified', receiptId: `fixture-${targetCommit}-${version}`, targetCommit,
          proofPath: target.proofPath, theoremName: target.theoremName, statementHash: version, leanStatementHash: version,
          claim: 'statement', sourceDeclarationHash: hashMathFormalSourceDeclaration(text, target.theoremName!),
        } as TaskProof['verification']['results'][number]] } };
  };
  const proof = proofFor(task, currentCommit, source), oldProof = proofFor(oldTask, baseCommit, oldSource);
  const state: SolverRunState = { schema: 'deepscientist.math.solver.v1', runId: 'solver-fixture', worktree,
    taskDigest: mathDigest('fixture task'), buildDigest: mathDigest('fixture build'), environmentDigest: mathDigest('fixture environment'),
    evaluatorDigest: mathDigest('fixture evaluator'), model: 'forbidden-real-model', effort: 'none', phase: 'running', turns: 2,
    workerCount: 2, coordination: 'cooperative', workers: [
      { id: 'solver', role: 'lead', worktree, phase: 'running', turns: 1 },
      { id: 'engineer', role: 'engineer', worktree, phase: 'running', turns: 1 },
    ],
    problem: { kind: 'example', workspace: worktree, projectRelative: relative, baseCommit,
      receiptDigest: mathDigest('fixture problem'), activeProblemPath: path.join(worktree, 'active-problem.json'),
      ownedFiles: ['Submission.lean'], trustedFiles: {}, declarations: {}, sourceStructure: {},
      targets: [{ proofPath: 'Submission.lean', theoremName: 'Original.goal', declarationHash: hashMathFormalSourceDeclaration(source, 'Original.goal')! }],
      contract: { problemId: 'fixture', informalStatement: 'Prove the original goal.', formalStatement: original,
        assumptions: [], knownTraps: [], acceptanceCriteria: [], officialVerificationCommand: 'fixture-never-run',
        statementHash: mathDigest('informal'), leanStatementHash: mathDigest('formal') } },
    cooperation: { planVersion: 'plan-v1', canonicalCommit: currentCommit,
      groups: [{ group: { id: 'main', objective: 'Original proof', status: 'active', revision: 0, engineerId: 'engineer' }, turns: 1 }],
      tasks: [{ task, status: 'integrated', attempts: 1, integratedCheck: proof }, { task: goal, status: 'pending', attempts: 0 }],
      history: [{ task: oldTask, integratedCheck: oldProof }],
      deliveries: [{ id: 'research-publication', producer: 'solver', kind: 'progress', status: 'advisory',
        taskId: 'goal', taskDigest: taskVersion(goal), statement: 'The original goal is still open.', premises: [],
        dependencies: [], remainingObligations: ['goal'], summary: 'Still open', finding: 'Complete retained research finding.',
        findingDigest: mathDigest('Complete retained research finding.'), evidenceRefs: [], createdAt: 123, commit: currentCommit }] } };
  const save = () => writeSolverRunState(stateFile, state); save();
  const activeRunFile = path.join(directory, 'active-run.json');
  writeWebActiveRun({ webRunId: 'web-fixture', directory, output }, activeRunFile);
  return { directory, output, stateFile, activeRunFile, worktree, project, source, oldSource, state, task, oldTask, goal,
    proof, oldProof, currentCommit, baseCommit, save, proofFor, git, commit };
}
