import fs from 'node:fs';
import path from 'node:path';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { readMathText } from '../math/mathRuntimeIo';

/** Worker sessions start at the worktree root; Lean projects may be nested. */
export function currentWorkerProject(worktreeRoot: string): string {
  const worktree = fs.realpathSync(worktreeRoot), file = path.join(worktree, 'COOPERATION.json');
  assertMathCanonicalPath(file);
  const context = JSON.parse(readMathText(file, 32_000_000));
  const relative = context.researchDelivery?.projectRelative;
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('math_worker_project_missing');
  const project = path.resolve(worktree, relative);
  if (!isMathPathWithin(worktree, project)) throw new Error('math_worker_project_outside_worktree');
  assertMathCanonicalPath(project);
  if (!fs.statSync(project).isDirectory()) throw new Error('math_worker_project_missing');
  return project;
}
