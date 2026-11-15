import { createHash } from 'node:crypto';
import type { ArchiveProcess, ArchiveRecord } from './types';
import { coreProofWalkthroughs } from './proofWalkthroughCore';
import { analysisProofWalkthroughs } from './proofWalkthroughAnalysis';
import { geometryProofWalkthroughs } from './proofWalkthroughGeometry';
import { foundationProofWalkthroughs } from './proofWalkthroughFoundations';
import { additionalProofWalkthroughs } from './proofWalkthroughAdditional';
import { renderProofFigure } from './proofFigureRender';

export const proofWalkthroughs = [...coreProofWalkthroughs, ...analysisProofWalkthroughs, ...geometryProofWalkthroughs, ...foundationProofWalkthroughs, ...additionalProofWalkthroughs];

/** Attach mathematical explanations only to the exact accepted source they describe. */
export function withProofWalkthrough(record: Pick<ArchiveRecord, 'id' | 'campaign'>, process: ArchiveProcess): ArchiveProcess {
  const walkthrough = proofWalkthroughs.find(item => item.recordId === record.id);
  if (!walkthrough) return process;
  // A later accepted proof can carry its own audited explanation. An older curated reading belongs only to its
  // original proof and must not prevent importing the newly generated one.
  if (process.explanations?.some(item => item.runId === record.campaign?.runId
    && item.proofCommit === record.campaign.proofCommit && item.proofSha256 === record.campaign.proofSha256)
    && (walkthrough.runId !== record.campaign?.runId || walkthrough.proofSha256 !== record.campaign.proofSha256)) return process;
  const fail = (detail: string): never => { throw new Error(`Proof walkthrough mismatch: ${record.id}/${detail}`); };
  if (walkthrough.runId !== record.campaign?.runId || walkthrough.proofSha256 !== record.campaign.proofSha256) fail('accepted identity');
  const run = process.runs.find(item => item.runId === walkthrough.runId);
  const source = process.sources?.[walkthrough.proofSha256];
  if (!run || !source || source.sha256 !== walkthrough.proofSha256
    || createHash('sha256').update(source.code).digest('hex') !== walkthrough.proofSha256
    || !run.checks?.some(check => check.scope === 'original' && check.status === 'kernel_verified' && check.sourceDigest === walkthrough.proofSha256)) return fail('checked source');
  const lines = source.code.split('\n');
  const stagedIds = walkthrough.stages.flatMap(stage => stage.stepIds);
  if (!walkthrough.stages.length || walkthrough.stages.some(stage => !stage.stepIds.length)
    || stagedIds.length !== walkthrough.steps.length || stagedIds.some((id, index) => id !== walkthrough.steps[index].id)) fail('reading stages');
  const ids = new Set<string>();
  for (const step of walkthrough.steps) {
    if (ids.has(step.id) || !/^[a-z0-9-]+$/u.test(step.id)) fail(`step ${step.id}`);
    for (const dependency of step.dependsOn) if (!ids.has(dependency)) fail(`${step.id}/dependency ${dependency}`);
    if (!step.derivation.length) fail(`${step.id}/derivation`);
    ids.add(step.id);
    const excerpt = step.evidence.source;
    if (excerpt.name !== 'Submission.lean' || !Number.isInteger(excerpt.line) || !Number.isInteger(excerpt.endLine)
      || excerpt.line < 1 || excerpt.endLine < excerpt.line || excerpt.endLine > lines.length) fail(`${step.id}/source lines`);
    for (const theorem of step.evidence.theorems) if (!source.code.includes(theorem.split('.').at(-1)!)) fail(`${step.id}/declaration ${theorem}`);
    for (const id of step.evidence.taskIds ?? []) if (!run.tasks.some(task => task.id === id)) fail(`${step.id}/task ${id}`);
    for (const id of step.evidence.deliveryIds ?? []) if (!run.deliveries?.some(delivery => delivery.id === id)) fail(`${step.id}/delivery ${id}`);
    for (const id of step.evidence.checkIds ?? []) if (!run.checks?.some(check => check.id === id)) fail(`${step.id}/check ${id}`);
  }
  return { ...process, walkthrough: { ...walkthrough, steps: walkthrough.steps.map(step => step.figure ? { ...step,
    figureHtml: { zh: renderProofFigure(step.figure, 'zh'), en: renderProofFigure(step.figure, 'en') },
  } : step) } };
}
