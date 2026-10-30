import path from 'node:path';
import { z } from 'zod';
import { MAX_FORMALIZATION_EVALUATION_BYTES, readFormalizationEvaluationBundle } from './formalizationEvaluation';
import { mathDigest, readMathFile, readMathText } from './mathRuntimeIo';
import { assertMathCanonicalPath } from './paths';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1).refine(value => value.trim().length > 0);
const fileEvidence = z.object({ file: text, sha256: hash }).strict();

/** These are saved claims with linked files, not a generic Lean certificate format. */
export const formalizationAdjudicationsSchema = z.object({
  schema: z.literal('theorem-os.formalization-adjudications.v1'),
  bundleDigest: hash,
  records: z.array(z.object({
    caseId: z.string().regex(/^case_[a-f0-9]{64}$/u),
    inputDigest: hash,
    scope: z.literal('candidate-falsity-only'),
    finding: z.literal('candidate-refuted'),
    fidelity: z.literal('not-assessed'),
    note: text,
    evidence: z.object({
      certificate: fileEvidence,
      processRecord: fileEvidence,
      files: z.array(fileEvidence).optional(),
      toolchain: text.optional(),
      mathlibRevision: z.string().regex(/^[a-f0-9]{40}$/u).optional(),
    }).strict(),
  }).strict()),
}).strict();
export type FormalizationAdjudications = z.infer<typeof formalizationAdjudicationsSchema>;

/**
 * Read optional evaluation annotations separately from unchanged labels and scores.
 * Only identities and saved file bytes are checked. No Lean, model or certificate
 * checker runs, and candidate falsity alone does not adjudicate source fidelity.
 */
export function readFormalizationAdjudications(bundleDirectory: string, adjudicationFile: string) {
  const prepared = readFormalizationEvaluationBundle(bundleDirectory);
  const file = path.resolve(adjudicationFile);
  assertMathCanonicalPath(file);
  const contents = readMathText(file, MAX_FORMALIZATION_EVALUATION_BYTES);
  const saved = formalizationAdjudicationsSchema.parse(JSON.parse(contents));
  if (saved.bundleDigest !== prepared.bundleDigest) throw new Error('formalization_adjudication_bundle_mismatch');
  const metadata = new Map(prepared.bundle.cases.map(item => [item.caseId, item]));
  const seen = new Set<string>();
  const checkedFile = (reference: z.infer<typeof fileEvidence>) => {
    const absolute = path.resolve(path.dirname(file), reference.file);
    assertMathCanonicalPath(absolute);
    const { bytes } = readMathFile(absolute, MAX_FORMALIZATION_EVALUATION_BYTES);
    if (mathDigest(bytes) !== reference.sha256) throw new Error('formalization_adjudication_evidence_changed');
    return { file: absolute, sha256: reference.sha256 };
  };
  const records = saved.records.map(record => {
    if (seen.has(record.caseId)) throw new Error('formalization_adjudication_duplicate');
    seen.add(record.caseId);
    const item = metadata.get(record.caseId);
    if (!item) throw new Error('formalization_adjudication_case_unknown');
    if (item.inputDigest !== record.inputDigest) throw new Error('formalization_adjudication_input_mismatch');
    return { ...record, upstreamLabel: item.label, evidence: {
      ...record.evidence,
      certificate: checkedFile(record.evidence.certificate),
      processRecord: checkedFile(record.evidence.processRecord),
      ...(record.evidence.files ? { files: record.evidence.files.map(checkedFile) } : {}),
    } };
  });
  return {
    schema: 'theorem-os.formalization-candidate-truth-evidence.v1' as const,
    bundleDigest: prepared.bundleDigest,
    adjudicationsSha256: mathDigest(contents),
    evidence: 'saved-host-records-not-replayed' as const,
    modelInvoked: false as const,
    leanReplayed: false as const,
    certificateMeaningVerified: false as const,
    semanticTruthCertified: false as const,
    fidelity: 'not-assessed' as const,
    upstreamLabelsChanged: false as const,
    interpretation: 'Linked file hashes and case identities were checked. Findings are saved candidate-falsity records; Lean was not replayed and certificate meaning was not verified. Candidate falsity alone does not establish mistranslation, adjudicate source fidelity, replace upstream labels or produce corrected accuracy.',
    counts: { totalCases: prepared.bundle.cases.length, recordedCases: records.length,
      unrecordedCases: prepared.bundle.cases.length - records.length, candidateRefutationRecords: records.length },
    records,
  };
}
export type FormalizationCandidateTruthEvidence = ReturnType<typeof readFormalizationAdjudications>;
