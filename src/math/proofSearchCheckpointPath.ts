import path from 'node:path';

export function proofSearchDirectory(project: string, basis: string, history?: string) {
  const root = path.join(project, '.lake/proof-search', basis);
  return history ? path.join(root, history) : root;
}

export function projectedProofSearchPath(project: string, basis: string, generation: number, digest: string, history?: string) {
  return path.join(proofSearchDirectory(project, basis, history), `retained-${generation}-${digest}.json`);
}

export function localProofSearchPath(project: string, basis: string, generation: number, history?: string) {
  return path.join(proofSearchDirectory(project, basis, history), `${generation}.json`);
}
