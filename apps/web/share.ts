import { isAcceptedRun } from './presentation';
import { summarizeReport, type ReportTone } from './report';
import type { WebEffort, WebEnvironment, WebFormalizationReport, WebRun } from './shared';

/** The only run data a share link exposes. Built once, when the owner creates the link. */
export type WebShareSnapshot = {
  schema: 'theorem-os.web-share.v1';
  title: string;
  task: string;
  source: string;
  proof: string;
  environment: WebEnvironment;
  model: string;
  effort: WebEffort;
  workers: number;
  createdAt: string;
  finishedAt?: string;
  sharedAt: string;
  formalization?: { original: string; confirmation?: 'automatic' | 'manual'; evidenceSha256: string;
    review?: Pick<WebFormalizationReport, 'backtranslation' | 'correspondences'> };
  checks: { label: string; status: string; tone: ReportTone; method?: string;
    targets: { name: string; status: string; tone: ReportTone; sorryCount?: number; admitCount?: number }[] }[];
  metrics: { label: string; value: string }[];
  identity: { label: string; value: string }[];
};
export type WebShareLink = { token: string; url: string; createdAt: string };

export const webShareToken = /^[A-Za-z0-9_-]{32}$/u;
// Solver run IDs and commits name internal state; toolchain and digests let a reader reproduce the check.
const publicIdentity = new Set(['验收源码摘要', 'Lean 工具链', '依赖摘要', 'Mathlib 版本']);

export function shareSnapshot(run: WebRun, sharedAt = new Date().toISOString(), review?: WebFormalizationReport): WebShareSnapshot | undefined {
  if (!isAcceptedRun(run) || !run.result?.proof) return;
  const report = summarizeReport(run);
  return {
    schema: 'theorem-os.web-share.v1', title: run.title, task: run.task, source: run.source, proof: run.result.proof,
    environment: run.environment, model: run.model, effort: run.effort, workers: run.workers,
    createdAt: run.createdAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}), sharedAt,
    ...(run.formalization ? { formalization: { original: run.formalization.original, confirmation: run.formalization.confirmation,
      evidenceSha256: run.formalization.evidenceSha256,
      ...(review?.evidenceSha256 === run.formalization.evidenceSha256 ? { review: {
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
