import { isAcceptedRun } from './presentation';
import { summarizeReport } from './report';
import type { WebFormalizationReport, WebRun } from './shared';
import { shareReading, type WebShareReadingInput } from './shareReading';
import type { WebShareSnapshot } from './shareTypes';
export { webShareToken, type WebShareLink, type WebShareSnapshot } from './shareTypes';

// Solver run IDs and commits name internal state; toolchain and digests let a reader reproduce the check.
const publicIdentity = new Set(['验收源码摘要', 'Lean 工具链', '依赖摘要', 'Mathlib 版本']);

export function shareSnapshot(run: WebRun, sharedAt = new Date().toISOString(), review?: WebFormalizationReport, input: WebShareReadingInput = {}): WebShareSnapshot | undefined {
  if (!isAcceptedRun(run) || !run.result?.proof) return;
  const report = summarizeReport(run);
  return {
    schema: 'theorem-os.web-share.v1', title: run.title, task: run.task, source: run.source, proof: run.result.proof,
    environment: run.environment, model: run.model, effort: run.effort, workers: run.workers,
    createdAt: run.createdAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}), sharedAt,
    reading: shareReading(run, review?.evidenceSha256 === run.formalization?.evidenceSha256 ? review : undefined, input),
    ...(run.formalization ? { formalization: { original: run.formalization.original, confirmation: run.formalization.confirmation,
      ...(run.formalization.reviewMode ? { reviewMode: run.formalization.reviewMode } : {}),
      evidenceSha256: run.formalization.evidenceSha256,
      ...(review?.backtranslation && review.evidenceSha256 === run.formalization.evidenceSha256 ? { review: {
        backtranslation: review.backtranslation, correspondences: review.correspondences } } : {}) } } : {}),
    // Diagnostics and reasons can carry paths or provider text; a share shows outcomes only.
    checks: report.checks.map(check => ({ label: check.label, status: check.status, tone: check.tone,
      ...(check.method ? { method: check.method } : {}),
      targets: check.targets.map(target => ({ name: target.name, status: target.status, tone: target.tone,
        ...(target.sorryCount !== undefined ? { sorryCount: target.sorryCount } : {}),
        ...(target.admitCount !== undefined ? { admitCount: target.admitCount } : {}) })) })),
    metrics: report.metrics, identity: report.identity.filter(item => publicIdentity.has(item.label)),
  };
}
