import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertFormalizationCompiledCandidate, formalizationCompiledCandidate, formalizationCompiledCandidateDigest,
  formalizationCompiledCandidateSchema, formalizationDigest, formalizationEvidenceSchema, formalizationInputDigest,
  readFormalizationArtifact, writeFormalizationArtifact, type FormalizationCompiledCandidate,
  type FormalizationEvidence } from '../src/math/formalization';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { approvedFormalization } from './helpers/approvedFormalizationFixture';

// These contract receipts use preset sessions and synthetic elaboration; no model or Lean is run.
describe('compiled statement identity before semantic approval', () => {
  const roots: string[] = [];
  let evidence: FormalizationEvidence, compiled: FormalizationCompiledCandidate;
  beforeAll(async () => {
    const directory = await approvedFormalization(roots);
    evidence = readFormalizationArtifact(path.join(directory, 'artifact'));
    compiled = formalizationCompiledCandidate(evidence);
  });
  afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

  it('retains the complete compiled identity without claiming approval or proof acceptance', () => {
    expect(() => assertFormalizationCompiledCandidate(compiled)).not.toThrow();
    expect(formalizationCompiledCandidateSchema.parse(compiled)).toEqual(compiled);
    expect(compiled).toMatchObject({ request: evidence.request, requestDigest: evidence.requestDigest,
      candidate: evidence.candidate, inputDigest: evidence.inputDigest, sourceSha256: evidence.sourceSha256,
      targets: evidence.targets, snapshot: evidence.snapshot, snapshotDigest: evidence.snapshotDigest,
      compilation: evidence.compilation, round: evidence.round });
    for (const field of ['status', 'review', 'translation', 'approvedAt', 'proofVerified', 'sessions', 'workflow'])
      expect(compiled).not.toHaveProperty(field);
    expect(formalizationCompiledCandidateDigest(structuredClone(compiled))).toBe(formalizationCompiledCandidateDigest(compiled));
  });

  it('cannot be parsed or persisted as approved formalization evidence', () => {
    expect(formalizationEvidenceSchema.safeParse(compiled).success).toBe(false);
    expect(formalizationCompiledCandidateSchema.safeParse({ ...compiled, status: 'approved' }).success).toBe(false);
    const destination = path.join(roots[0], 'must-not-be-an-approved-artifact');
    expect(() => writeFormalizationArtifact(destination, compiled as unknown as FormalizationEvidence)).toThrow();
    expect(fs.existsSync(destination)).toBe(false);
  });

  it.each(['source', 'snapshot-source', 'snapshot-context', 'environment', 'targets', 'diagnostic', 'original'] as const)(
    'rejects changed %s evidence even when its public summary digest is refreshed', field => {
      const changed = structuredClone(compiled);
      if (field === 'source') {
        changed.candidate.source += '\n-- changed after compilation\n';
        changed.sourceSha256 = mathDigest(changed.candidate.source);
        changed.inputDigest = formalizationInputDigest(changed.request, changed.candidate);
      } else if (field === 'snapshot-source') {
        changed.snapshot.source += '\n-- changed observation\n';
        changed.snapshot.sourceSha256 = mathDigest(changed.snapshot.source);
        changed.snapshotDigest = formalizationDigest(changed.snapshot);
      } else if (field === 'snapshot-context') {
        changed.snapshot.targets[0].context.type = 'False';
        changed.snapshotDigest = formalizationDigest(changed.snapshot);
      } else if (field === 'environment') {
        changed.request.environment = 'mathlib';
        changed.requestDigest = formalizationDigest(changed.request);
        changed.inputDigest = formalizationInputDigest(changed.request, changed.candidate);
      } else if (field === 'targets') {
        changed.targets[0].declarationHash = 'a'.repeat(64);
        changed.snapshot.targets[0].declarationHash = changed.targets[0].declarationHash;
        changed.snapshotDigest = formalizationDigest(changed.snapshot);
      } else if (field === 'diagnostic') {
        const records = changed.compilation.diagnostics.artifactRecords as { text: string; digest: string }[];
        const artifact = JSON.parse(records[0].text);
        artifact.stdout = 'Changed compiler transcript';
        records[0].text = JSON.stringify(artifact);
        records[0].digest = mathDigest(records[0].text);
      } else {
        changed.request.statement = 'Prove False.';
        changed.request.statementSha256 = mathDigest(changed.request.statement);
        changed.requestDigest = formalizationDigest(changed.request);
        changed.inputDigest = formalizationInputDigest(changed.request, changed.candidate);
      }
      expect(() => assertFormalizationCompiledCandidate(changed)).toThrow();
    });
});
