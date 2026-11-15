import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import { projectWebDeclarationArtifacts } from '../apps/web/declarationArtifacts';

// Receipt/sidecar validation has its own integration test. Isolate this projection's message-size obligation.
const host = vi.hoisted(() => ({ artifacts: [] as unknown[] }));
vi.mock('../src/solver/declarationArtifacts', async original => ({ ...await original<typeof import('../src/solver/declarationArtifacts')>(),
  readDeclarationArtifacts: () => host.artifacts }));

it('keeps large declaration collections inside the Web envelope and omits complete records explicitly', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'web-declaration-bounds-'));
  try {
    fs.writeFileSync(path.join(directory, 'declarations.json'), 'Frozen sidecar bytes for this reader fixture.');
    const premises = Array.from({ length: 128 }, () => 'p'.repeat(8000));
    host.artifacts = Array.from({ length: 20 }, (_, index) => ({ id: index.toString(16).padStart(64, '0'),
      declaration: { file: 'Submission.lean', name: `Retained.helper${index}`, type: 'True', premises },
      proof: { commit: 'a'.repeat(40), verification: { targetCommit: 'b'.repeat(40), results: [{ receiptId: `retained-${index}` }] } },
      environmentDigest: 'c'.repeat(64) }));
    const value = projectWebDeclarationArtifacts(path.join(directory, 'state.json'), {} as SolverRunState);
    expect(value.status).toBe('recorded');
    if (value.status !== 'recorded') throw new Error('Expected a recorded projection.');
    expect(value.declarations.length).toBeGreaterThan(0); expect(value.omitted).toBeGreaterThan(0);
    expect(value.omitted + value.declarations.length).toBe(20);
    expect(value.declarations.every(item => item.premises.length === 128 && item.premises.every(premise => premise.length === 8000))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(4 * 1024 * 1024);
    expect(value).toMatchObject({ acceptance: 'not-assessed', requiresFreshCheck: true });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
