import { describe, expect, it } from 'vitest';
import { VerifierFailureError, safeVerifierFailureDiagnostic, verifierFailureDiagnostic } from '../src/solver/verifierFailure';
import { receiptBatch } from './helpers/verifier';
import { attributeProofEvidence } from '../src/solver/modules/evidence';

const request = { projectRoot: '/unused', targetCommit: 'fixed-commit', items: ['a', 'b'].map(name => ({
  theoremName: name, proofPath: 'Submission.lean', statementHash: 'task-' + name,
  leanStatementHash: 'task-' + name, expectedSourceDeclarationHash: 'source-' + name, claim: 'statement' as const,
})) };
const batch = () => receiptBatch(request, { sessionId: 'session', receiptId: index => 'receipt-' + index });

describe('fatal verifier diagnosis', () => {
  it('retains the failed receipt and identity through wrappers without accepting a mismatched batch', () => {
    const verification = batch(); verification.results[1]!.targetCommit = 'other-commit';
    let failure: unknown;
    try { attributeProofEvidence(verification, request.targetCommit, request.items); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(VerifierFailureError);
    expect((failure as Error).message).toBe('math_task_check_identity_changed');
    const wrapped = new Error('math_verifier_unavailable', { cause: failure });
    const diagnostic = verifierFailureDiagnostic(wrapped)!;
    expect(diagnostic).toMatchObject({ stage: 'batch-receipt-attribution', sourceCommit: 'fixed-commit',
      verification: { targetCommit: 'fixed-commit', sessionId: 'session',
        results: [{ receiptId: 'receipt-0' }, { receiptId: 'receipt-1' }] } });
    expect(safeVerifierFailureDiagnostic(JSON.parse(JSON.stringify(diagnostic)))).toEqual(diagnostic);
    expect('passed' in diagnostic).toBe(false);
  });

  it('bounds and redacts selected verifier output and error causes', () => {
    const verification = batch();
    verification.results[0]!.stderrPreview = 'Authorization: Bearer abc-secret\n' + 'x'.repeat(20_000);
    const secret = 'sk-' + 'private'.repeat(8);
    const error = new VerifierFailureError({ stage: 'task-proof-attribution', verification },
      new Error('api_key=' + secret));
    const diagnostic = verifierFailureDiagnostic(error)!;
    expect(diagnostic.verification!.results[0]!.stderrPreview!.length).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(JSON.stringify(diagnostic)).not.toContain('abc-secret');
    expect(diagnostic.causes[0]!.message).toContain('[redacted]');
    expect(safeVerifierFailureDiagnostic({ schema: 'theorem-os.verifier-failure.v1', passed: true })).toBeUndefined();
    expect(verifierFailureDiagnostic(new Error('unrelated source failure'))).toBeUndefined();
  });
});
