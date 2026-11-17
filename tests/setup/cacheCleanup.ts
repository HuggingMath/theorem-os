import fs from 'node:fs';
import type { TestProject } from 'vitest/node';

export default function setup(project: TestProject) {
  const root = project.config.provide.theoremosTestCacheRoot as string;
  return () => { fs.rmSync(root, { recursive: true, force: true }); };
}
