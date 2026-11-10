import type { ArchiveIndexRecord, ArchiveProcess } from './types';
import type { Localized, ProofDerivationLine } from './proofWalkthroughTypes';
import { selectedProofWalkthrough } from './proofWalkthrough';

export type ProofReadingContext = {
  title: Localized; claim: Localized; given?: Localized; derivation?: ProofDerivationLine[]; uses: string[]; definition?: string;
};
export type ProofReadingContexts = {
  recordId: string; proofSha256: string; runId: string; positions: Record<string, ProofReadingContext>;
};
type ProofRecord = Pick<ArchiveIndexRecord, 'id' | 'campaign' | 'sources'>;

/** Shared by the reader and its handoff: historical runs never supply accepted reading context. */
export function acceptedReadingProof(record: ProofRecord, process: ArchiveProcess) {
  const campaign = record.campaign;
  const run = campaign && process.runs.find(candidate => candidate.runId === campaign.runId && candidate.resultStatus === 'evaluated_passed');
  const source = campaign && process.sources?.[campaign.proofSha256];
  const checked = run?.checks?.some(check => check.scope === 'original' && check.status === 'kernel_verified' && check.sourceDigest === campaign?.proofSha256);
  if (!campaign || !run || !source || source.sha256 !== campaign.proofSha256 || !checked
    || !record.sources.some(file => file.name === 'Submission.lean' && file.sha256 === campaign.proofSha256)) return undefined;
  return { campaign, run, source };
}

/** Publication-only projection of the selected step. No URL-supplied mathematics enters a question. */
export function proofReadingContexts(record: ProofRecord, process: ArchiveProcess): ProofReadingContexts | undefined {
  const proof = acceptedReadingProof(record, process);
  if (!proof) return undefined;
  const { campaign, run, source } = proof, positions: ProofReadingContexts['positions'] = {};
  const file = process.sourceRoute?.files.find(file => file.sha256 === campaign.proofSha256);
  const walkthrough = selectedProofWalkthrough(record, process, run);
  if (walkthrough) for (const step of walkthrough.steps) positions[`proof-derivation-${step.id}`] = {
    title: step.title, given: step.given, claim: step.claim, derivation: step.derivation,
    uses: [...new Set([...step.dependsOn.flatMap(id => walkthrough.steps.find(step => step.id === id)!.evidence.theorems),
      ...file?.declarations.filter(item => step.evidence.theorems.includes(item.name)).flatMap(item => item.references)
        .flatMap(id => file.declarations.find(item => item.id === id)?.name ?? []) ?? []])],
  };
  else {
    if (file) for (const [group, items] of [
      ['target', file.declarations.filter(item => campaign.targets.includes(item.name))],
      ['helper', file.declarations.filter(item => !campaign.targets.includes(item.name))],
    ] as const) items.forEach((item, index) => {
      positions[`proof-source-${group}-${index + 1}`] = {
        title: { zh: item.name, en: item.name }, claim: { zh: item.type, en: item.type },
        uses: item.references.flatMap(id => file.declarations.find(item => item.id === id)?.name ?? []),
        ...(item.kind === 'definition' ? { definition: source.code.split('\n').slice(item.line - 1, item.endLine).join('\n') } : {}),
      };
    });
  }
  return { recordId: record.id, proofSha256: campaign.proofSha256, runId: run.runId, positions };
}
