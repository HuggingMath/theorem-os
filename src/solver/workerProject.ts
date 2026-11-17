import fs from 'node:fs';
import path from 'node:path';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { readMathText, writeMathJsonDurable } from '../math/mathRuntimeIo';

const WORKER_PROJECT_FILE = '.scratch/worker-project.json';

function resolveWorkerProject(worktree: string, relative: unknown): string {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('math_worker_project_missing');
  const project = path.resolve(worktree, relative);
  if (!isMathPathWithin(worktree, project)) throw new Error('math_worker_project_outside_worktree');
  assertMathCanonicalPath(project);
  if (!fs.statSync(project).isDirectory()) throw new Error('math_worker_project_missing');
  return project;
}

/** Advisory project location shared by skill/team and cooperative tool entry points. */
export function writeWorkerProject(worktreeRoot: string, projectRelative: string): void {
  const worktree = fs.realpathSync(worktreeRoot);
  resolveWorkerProject(worktree, projectRelative);
  const file = path.join(worktree, WORKER_PROJECT_FILE);
  assertMathCanonicalPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeMathJsonDurable(file, { schema: 'theorem-os.worker-project.v1', projectRelative }, 0o400);
}

/** Worker sessions start at the worktree root; Lean projects may be nested. */
export function currentWorkerProject(worktreeRoot: string): string {
  const worktree = fs.realpathSync(worktreeRoot), metadata = path.join(worktree, WORKER_PROJECT_FILE);
  assertMathCanonicalPath(metadata);
  if (fs.existsSync(metadata)) {
    const context = JSON.parse(readMathText(metadata, 16_000));
    if (context.schema !== 'theorem-os.worker-project.v1') throw new Error('math_worker_project_invalid');
    return resolveWorkerProject(worktree, context.projectRelative);
  }
  // Older cooperative runs predate the common project locator.
  const file = path.join(worktree, 'COOPERATION.json');
  assertMathCanonicalPath(file);
  const context = JSON.parse(readMathText(file, 32_000_000));
  return resolveWorkerProject(worktree, context.researchDelivery?.projectRelative);
}
