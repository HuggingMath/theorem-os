import fs from 'node:fs';
import { readInformalizationArtifact, informalizationOutputRoute, informalizationSectionSummary } from '../src/math/informalization';
import { leanSourceSlice } from '../src/math/informalizationExtraction';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { ArchiveProcess, ArchiveProofExplanation } from '../docs/web/types';

type Binding = { runId: string; proofCommit: string; proofSha256: string;
  targets: { theoremName: string; proofPath: string }[]; sources: ReadonlyMap<string, string> };
const publicText = (value: string) => value.replace(/\/(?:home|tmp|data|runtime)\/[^\s"'`<>\])}]+/gu, '[local file]')
  .replace(/\bsk-[A-Za-z0-9_-]{12,}/gu, '[redacted key]');

/** Read the solver's already-audited artifacts; never generate prose or change an accepted proof during import. */
export function importCampaignExplanations(result: { runId?: string; solution_commit?: string; status?: string;
  explanations?: { targets?: { target: string; proofPath: string; status: string; artifact?: string }[] } }, binding: Binding):
  { explanations: ArchiveProofExplanation[]; sources: NonNullable<ArchiveProcess['sources']> } {
  const explanations: ArchiveProofExplanation[] = [], sources: NonNullable<ArchiveProcess['sources']> = {};
  if (!result.explanations) return { explanations, sources };
  const fail = (): never => { throw new Error('Campaign explanation does not match the accepted proof'); };
  if (result.status !== 'evaluated_passed' || result.runId !== binding.runId || result.solution_commit !== binding.proofCommit
    || mathDigest(binding.sources.get('Submission.lean') ?? '') !== binding.proofSha256) fail();
  for (const item of result.explanations.targets ?? []) {
    if (item.status !== 'approved') continue;
    if (!binding.targets.some(target => target.theoremName === item.target && target.proofPath === item.proofPath)) fail();
    if (!item.artifact || !fs.existsSync(item.artifact)) {
      console.warn(`Approved explanation artifact unavailable for ${item.target}; keeping its accepted Lean proof.`);
      continue;
    }
    const evidence = readInformalizationArtifact(item.artifact);
    if (evidence.target !== item.target || evidence.sources.at(-1)?.origin !== item.proofPath) fail();
    const byFile = new Map(evidence.sources.map(source => {
      const code = binding.sources.get(source.origin);
      if (code === undefined || mathDigest(code) !== source.sha256 || Buffer.byteLength(code) !== source.bytes) fail();
      sources[source.sha256] = { path: source.origin, code: code!, sha256: source.sha256 };
      return [source.file, source] as const;
    }));
    const written = new Map(evidence.batches.flatMap(batch => batch.writer.sections.map(section => [section.declaration, section] as const)));
    const sections = evidence.outline.units.map(unit => {
      const source = byFile.get(unit.file), section = written.get(unit.name);
      if (!source || !section || leanSourceSlice(binding.sources.get(source.origin)!, unit.range) !== unit.source) fail();
      const summary = informalizationSectionSummary(section!);
      return { name: unit.name, title: publicText(section!.title), statement: publicText(section!.statement),
        ...(summary ? { summary: publicText(summary) } : {}), file: source!.origin, sha256: source!.sha256,
        line: unit.range.line, endLine: unit.range.endLine > unit.range.line && unit.range.endColumn === 0 ? unit.range.endLine - 1 : unit.range.endLine,
        steps: section!.proof.map(step => ({ text: publicText(step.text), uses: [...step.uses], lean: [...step.lean] })) };
    });
    explanations.push({ runId: binding.runId, proofCommit: binding.proofCommit, proofSha256: binding.proofSha256,
      target: item.target, language: evidence.language, overview: publicText(evidence.batches.at(-1)!.writer.overview!),
      auditors: evidence.auditors.length, sources: evidence.sources.map(source => ({ name: source.origin, sha256: source.sha256 })),
      route: (informalizationOutputRoute(evidence.batches.at(-1)!.writer) ?? []).map(stage => ({
        claim: publicText(stage.claim), declarations: [...stage.declarations] })), sections });
  }
  return { explanations, sources };
}
