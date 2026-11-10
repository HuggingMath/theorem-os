import type { DirectFormalizationEvidence } from '../../src/math/formalization';
import { formalizationDigest } from '../../src/math/formalization';
import { formalizationAuditBindings, formalizationAuditInput, type FormalizationAuditResult } from '../../src/math/formalizationAudit';

/** Synthetic independent opinion; it verifies transport/lifecycle contracts, never model accuracy. */
export function formalizationAuditFixture(evidence: DirectFormalizationEvidence,
  verdict: FormalizationAuditResult['review']['verdict'] = 'approved'): FormalizationAuditResult {
  const review: FormalizationAuditResult['review'] = { verdict, summary: 'Synthetic background review.',
    checks: { domains: true, assumptions: true, conclusions: true, definitions: true, quantifierScope: true, instanceCoherence: true },
    issues: verdict === 'changes_requested' ? [{ aspect: 'conclusions', originalFragment: evidence.request.statement,
      leanFragment: evidence.candidate.source, explanation: 'Synthetic discrepancy for lifecycle testing.' }] : [] };
  if (verdict !== 'approved') review.checks.conclusions = false;
  return { schema: 'theorem-os.formalization-audit.v1', ...formalizationAuditBindings(evidence),
    model: evidence.request.model, effort: evidence.request.effort, review,
    startedAt: '2026-11-09T01:00:00Z', finishedAt: '2026-11-09T01:01:00Z',
    session: { threadId: 'independent-background-review-' + evidence.request.problemId, turnId: 'audit-turn', status: 'completed',
      inputDigest: formalizationDigest(formalizationAuditInput(evidence)), outputDigest: formalizationDigest(review), usage: { totalTokens: 10 } } };
}
