import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MathAgentOptions } from '../runtime/codexSession';
import { LAKE_CONFIGURATION_FILES, mathLocalModuleBuildOrder } from '../math/mathConstructionSources';
import { inspectLeanSource } from '../math/leanSource';
import { mathDigest, readMathFile, readMathText } from '../math/mathRuntimeIo';
import type { SolverProblem } from './problem';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const completionSchema = z.object({
  schema: z.literal('theoremos.lean-diagnostics-latest.v1'), authority: z.literal('advisory-lean-process'),
  exitCode: z.literal(0), timedOut: z.literal(false), aborted: z.literal(false),
  sourceDigest: digest, environmentDigest: digest,
  requestedFiles: z.array(z.string()).min(1),
  sourceFiles: z.array(z.object({ file: z.string(), digest })).min(1),
  configuration: z.array(z.object({ file: z.string(), digest: digest.nullable() })),
});

export type SingleSolverProofSubmission = { sourceDigest: string; environmentDigest: string };

/** Successful local diagnostics yield writing; only the host's later check can accept a proof. */
export class SingleSolverProofHandoff {
  readonly output: NonNullable<MathAgentOptions['completedOutput']>;
  private pending?: SingleSolverProofSubmission;
  private submitted = new Set<string>();

  constructor(problem: SolverProblem, worktree: string, onReady: (submission: SingleSolverProofSubmission) => void) {
    const project = path.join(worktree, problem.projectRelative);
    this.output = { file: path.join(project, '.lake/lean-diagnostics-latest.json'), validate: value => {
      const diagnostic = completionSchema.parse(value);
      const identity = diagnostic.sourceDigest + ':' + diagnostic.environmentDigest;
      // A rejected candidate must be repaired before the same advisory result can yield another turn.
      if (this.submitted.has(identity)) throw new Error('math_single_solver_submission_already_checked');
      if (problem.targets.some(target => !diagnostic.requestedFiles.includes(target.proofPath)))
        throw new Error('math_single_solver_diagnostics_incomplete');
      const configuration = LAKE_CONFIGURATION_FILES.map(file => ({ file,
        digest: fs.existsSync(path.join(project, file)) ? mathDigest(readMathFile(path.join(project, file)).bytes) : null }));
      const sourceFiles = mathLocalModuleBuildOrder(project, diagnostic.requestedFiles).map(({ file }) =>
        ({ file, digest: mathDigest(readMathFile(path.join(project, file)).bytes) }));
      const sourceDigest = mathDigest(JSON.stringify([
        configuration.map(item => item.digest ?? ''), sourceFiles.map(item => [item.file, item.digest]),
      ]));
      if (diagnostic.sourceDigest !== sourceDigest || JSON.stringify(diagnostic.configuration) !== JSON.stringify(configuration) ||
          JSON.stringify(diagnostic.sourceFiles) !== JSON.stringify(sourceFiles))
        throw new Error('math_single_solver_diagnostics_stale');
      for (const file of problem.ownedFiles) {
        const inspected = inspectLeanSource(readMathText(path.join(project, file)));
        if (inspected.sorryCount || inspected.admitCount) throw new Error('math_single_solver_proof_incomplete');
      }
      this.submitted.add(identity);
      this.pending = { sourceDigest, environmentDigest: diagnostic.environmentDigest };
      onReady(this.pending);
    } };
  }

  takeSubmission(): SingleSolverProofSubmission | undefined {
    const submission = this.pending;
    this.pending = undefined;
    return submission;
  }
}
