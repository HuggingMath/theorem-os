import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { buildResearchToolGuide } from '../src/solver/researchToolGuide';

const access = { root: '/repo', worktree: "/work/a member's copy", tools: "/host/tool's cli.ts", retrievalRoot: '/corpus' };
const base = { receiptDigest: 'r', projectRelative: 'generated/problem',
  ownedFiles: ['notes.md', 'Library/Pinned.lean', 'Helpers.lean', "Proofs/A user's target.lean"],
  frozenFiles: { 'Library/Pinned.lean': 'f' } };

// Use the shell's own argument parser to test exactly what a pasted command would pass to Bun.
const argv = (line: string) => execFileSync('sh', ['-c', `bun() { printf '%s\\0' "$@"; }\n${line}`], { encoding: 'utf8' }).split('\0').slice(0, -1);

it('points a copied single-file check at the editable original target within a nested member project', () => {
  const file = base.ownedFiles[3]!;
  const targets = [base.ownedFiles[1]!, file].map(proofPath => ({ proofPath, theoremName: 'T', declarationHash: 'h' }));
  const { help, leanCheckCommand } = buildResearchToolGuide({ ...base, targets }, access, 'environment', 'native-agent-control');
  const example = help.build()!.text.split('\n').find(line => line.startsWith('bun ') && line.includes('check-lean'))!;
  expect(example).toBe(leanCheckCommand);
  expect(argv(example)).toEqual([access.tools, 'check-lean', '--worktree', access.worktree, '--file', file, '--timeout-seconds', '0']);
});

it('offers an owned Lean file when no target is available and omits the example for frozen-only workspaces', () => {
  const guide = (ownedFiles: string[]) => buildResearchToolGuide({ ...base, targets: [], ownedFiles }, access, 'environment');
  expect(argv(guide(base.ownedFiles).leanCheckCommand!)).toContain('Helpers.lean');
  const readOnly = guide(['notes.md', 'Library/Pinned.lean']);
  expect(readOnly.leanCheckCommand).toBeUndefined();
  expect(readOnly.help.build()!.text).not.toMatch(/^bun .* check-lean /mu);
});
