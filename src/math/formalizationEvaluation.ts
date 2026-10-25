import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { canonicalMathJson, mathDigest, readMathText, writeMathFrozen } from './mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from './paths';
import { LOCAL_EXAMPLE_TOOLCHAIN } from './localExample';

export const MAX_FORMALIZATION_EVALUATION_BYTES = 64 * 1024 * 1024;
const maximumRows = 50_000;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const identifier = z.string().min(1).max(512).refine(value => value.trim().length > 0);
const note = z.string().min(1).max(16_000).refine(value => value.trim().length > 0);
const sourceText = z.string().max(256 * 1024).refine(value => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value));
const nonemptySource = sourceText.refine(value => value.trim().length > 0);
const splitSchema = z.enum(['validation', 'test']);
const labelSchema = z.enum(['correct', 'incorrect']);
const caseIdSchema = z.string().regex(/^case_[a-f0-9]{64}$/u);
const digest = (value: unknown) => mathDigest(canonicalMathJson(value));

export const formalizationEvaluationProvenanceSchema = z.object({
  name: note,
  kind: z.enum(['external-dataset', 'synthetic-fixture']),
  labelProvenance: note,
  sourceToolchain: identifier,
  sourceMathlibRevision: z.string().regex(/^[a-f0-9]{40}$/u).optional(),
  url: z.string().url().optional(),
  revision: identifier.optional(),
  license: identifier.optional(),
}).strict();
export type FormalizationEvaluationProvenance = z.infer<typeof formalizationEvaluationProvenanceSchema>;

/** Upstream labels are preserved as supplied. This adapter does not upgrade them to human gold. */
export const proofNetVerifRowSchema = z.object({
  id: z.union([identifier, z.number().int().safe()]),
  nl_statement: nonemptySource,
  lean4_src_header: sourceText,
  lean4_formalization: nonemptySource,
  lean4_prediction: nonemptySource,
  correct: z.union([z.boolean(), z.literal(0), z.literal(1)]),
}).strict();

/** Explicit source families keep a reference and all its mutations in the same split. */
export const formalizationEvaluationNormalizedCaseSchema = z.object({
  id: identifier,
  sourceFamily: identifier,
  split: splitSchema,
  original: nonemptySource,
  header: sourceText,
  candidate: nonemptySource,
  label: labelSchema,
  labelProvenance: note,
  kind: z.enum(['external', 'mutation', 'synthetic']),
  reference: nonemptySource.optional(),
  mutation: note.optional(),
}).strict();

/** This is the entire reviewer-facing payload: no source ID, split, label, reference or filename. */
export const formalizationEvaluationReviewerInputSchema = z.object({
  schema: z.literal('theorem-os.formalization-review-input.v1'),
  caseId: caseIdSchema,
  original: nonemptySource,
  header: sourceText,
  candidate: nonemptySource,
}).strict();
export type FormalizationEvaluationReviewerInput = z.infer<typeof formalizationEvaluationReviewerInputSchema>;

const caseMetadataSchema = z.object({
  caseId: caseIdSchema, inputDigest: hash, inputFile: z.string(), sourceId: identifier,
  sourceRow: z.number().int().positive(), sourceFamily: z.string().min(1).max(1024),
  originalFamilySha256: hash, splitGroupSha256: hash, split: splitSchema, label: labelSchema,
  labelProvenance: note, kind: z.enum(['external', 'mutation', 'synthetic']),
  reference: nonemptySource.optional(), referenceSha256: hash.optional(), mutation: note.optional(),
}).strict();
type CaseMetadata = z.infer<typeof caseMetadataSchema>;
const splitConfigurationSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('explicit-source-family'), }).strict(),
  z.object({ method: z.literal('supplied-upstream'), split: splitSchema }).strict(),
  z.object({ method: z.literal('sha256-source-family'), seed: identifier,
    validationPercent: z.number().int().min(1).max(99) }).strict(),
]);
type SplitConfiguration = z.infer<typeof splitConfigurationSchema>;
const indexSchema = z.object({
  schema: z.literal('theorem-os.formalization-review-index.v1'),
  cases: z.array(z.object({ caseId: caseIdSchema, inputDigest: hash, inputFile: z.string() }).strict()).min(1).max(maximumRows),
}).strict();
const bundleSchema = z.object({
  schema: z.literal('theorem-os.formalization-evaluation-bundle.v1'),
  createdAt: z.string().datetime(), modelInvoked: z.literal(false),
  format: z.enum(['proofnetverif', 'normalized']),
  provenance: formalizationEvaluationProvenanceSchema,
  sourceSha256: hash, sourceBytes: z.number().int().positive().max(MAX_FORMALIZATION_EVALUATION_BYTES),
  sourceRows: z.number().int().positive().max(maximumRows),
  splitConfiguration: splitConfigurationSchema, reviewIndexDigest: hash,
  cases: z.array(caseMetadataSchema).min(1).max(maximumRows),
}).strict();
export type FormalizationEvaluationBundle = z.infer<typeof bundleSchema>;

const prepareOptionsSchema = z.object({
  directory: z.string().min(1), inputFile: z.string().min(1), format: z.enum(['proofnetverif', 'normalized']),
  provenance: formalizationEvaluationProvenanceSchema,
  validationPercent: z.number().int().min(1).max(99).optional(), splitSeed: identifier.optional(),
  sourceSplit: splitSchema.optional(),
}).strict();
export type PrepareFormalizationEvaluationOptions = z.infer<typeof prepareOptionsSchema>;

function externalDirectory(value: string): string {
  const directory = path.resolve(value); assertMathCanonicalPath(directory);
  if (isMathPathWithin(repositoryRoot, directory) || isMathPathWithin(directory, repositoryRoot))
    throw new Error('formalization_eval_directory_must_be_external');
  return directory;
}
function jsonLines(contents: string): { value: unknown; row: number }[] {
  const rows: { value: unknown; row: number }[] = [];
  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    if (rows.length >= maximumRows || Buffer.byteLength(line, 'utf8') > 512 * 1024)
      throw new Error('formalization_eval_input_limit');
    try { rows.push({ value: JSON.parse(line), row: index + 1 }); }
    catch { throw new Error('formalization_eval_jsonl_invalid:' + (index + 1)); }
  }
  if (!rows.length) throw new Error('formalization_eval_input_empty');
  return rows;
}
const originalFamily = (original: string) => mathDigest(original.normalize('NFKC').replace(/\s+/gu, ' ').trim());
export const formalizationEvaluationInputDigest = (input: FormalizationEvaluationReviewerInput): string => digest(input);
/** Source identity for a separately saved host compilation observation. */
export const formalizationEvaluationLeanSource = (input: FormalizationEvaluationReviewerInput): string =>
  input.header + (input.header && !input.header.endsWith('\n') ? '\n' : '') + input.candidate;

type PreparedCase = { input: FormalizationEvaluationReviewerInput; metadata: CaseMetadata };
function prepareCases(contents: string, format: 'proofnetverif' | 'normalized',
  provenance: FormalizationEvaluationProvenance, configuration: SplitConfiguration): PreparedCase[] {
  if ((format === 'normalized') !== (configuration.method === 'explicit-source-family'))
    throw new Error('formalization_eval_split_configuration_mismatch');
  const explicitIds = new Set<string>();
  const rows = jsonLines(contents).map(({ value, row }) => {
    if (format === 'proofnetverif') {
      const parsed = proofNetVerifRowSchema.safeParse(value);
      if (!parsed.success) throw new Error('formalization_eval_row_invalid:' + row);
      const item = parsed.data;
      return { sourceId: String(item.id), sourceRow: row, sourceFamily: 'proofnetverif:' + item.id,
        original: item.nl_statement, header: item.lean4_src_header, candidate: item.lean4_prediction,
        label: item.correct === true || item.correct === 1 ? 'correct' as const : 'incorrect' as const,
        labelProvenance: provenance.labelProvenance, kind: 'external' as const, reference: item.lean4_formalization,
        mutation: undefined, split: undefined };
    }
    const parsed = formalizationEvaluationNormalizedCaseSchema.safeParse(value);
    if (!parsed.success) throw new Error('formalization_eval_row_invalid:' + row);
    const item = parsed.data;
    if (explicitIds.has(item.id)) throw new Error('formalization_eval_source_id_duplicate');
    explicitIds.add(item.id);
    return { sourceId: item.id, sourceRow: row, sourceFamily: item.sourceFamily,
      original: item.original, header: item.header, candidate: item.candidate, label: item.label,
      labelProvenance: item.labelProvenance, kind: item.kind, reference: item.reference,
      mutation: item.mutation, split: item.split };
  });
  // Connected components link both declared families and identical normalized originals. This also
  // catches a renamed mutation that tried to enter the other split under a different source ID.
  const parents = rows.map((_item, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) { const previous = index; index = parents[index]; parents[previous] = root; }
    return root;
  };
  const families = new Map<string, number>(), originals = new Map<string, number>();
  const originalDigests = rows.map(item => originalFamily(item.original));
  rows.forEach((item, index) => {
    for (const [table, key] of [[families, item.sourceFamily], [originals, originalDigests[index]]] as const) {
      const previous = table.get(key);
      if (previous !== undefined) parents[find(index)] = find(previous); else table.set(key, index);
    }
  });
  const groups = new Map<number, number[]>();
  rows.forEach((_item, index) => {
    const key = find(index), previous = groups.get(key);
    if (previous) previous.push(index); else groups.set(key, [index]);
  });
  const assignments = new Map<number, { split: 'validation' | 'test'; group: string }>();
  for (const indices of groups.values()) {
    const group = digest({ sourceFamilies: [...new Set(indices.map(index => rows[index].sourceFamily))].sort(),
      originals: [...new Set(indices.map(index => originalDigests[index]))].sort() });
    let split: 'validation' | 'test';
    if (configuration.method === 'explicit-source-family') {
      const splits = new Set(indices.map(index => rows[index].split));
      if (splits.size !== 1 || splits.has(undefined)) throw new Error('formalization_eval_split_family_leakage');
      split = rows[indices[0]].split!;
    } else if (configuration.method === 'supplied-upstream') {
      split = configuration.split;
    } else {
      const bucket = Number.parseInt(mathDigest(configuration.seed + '\n' + group).slice(0, 12), 16) % 10_000;
      split = bucket < configuration.validationPercent * 100 ? 'validation' : 'test';
    }
    for (const index of indices) assignments.set(index, { split, group });
  }
  const seen = new Set<string>();
  let metadataBytes = 0;
  return rows.map((item, index) => {
    const mathematics = { original: item.original, header: item.header, candidate: item.candidate };
    const caseId = 'case_' + digest(mathematics);
    if (seen.has(caseId)) throw new Error('formalization_eval_case_duplicate');
    seen.add(caseId);
    const input = formalizationEvaluationReviewerInputSchema.parse({ schema: 'theorem-os.formalization-review-input.v1', caseId, ...mathematics });
    const assigned = assignments.get(index)!;
    const metadata = caseMetadataSchema.parse({ caseId, inputDigest: formalizationEvaluationInputDigest(input),
      inputFile: 'inputs/' + caseId + '.json', sourceId: item.sourceId, sourceRow: item.sourceRow,
      sourceFamily: item.sourceFamily, originalFamilySha256: originalDigests[index], splitGroupSha256: assigned.group,
      split: assigned.split, label: item.label, labelProvenance: item.labelProvenance, kind: item.kind,
      reference: item.reference, referenceSha256: item.reference === undefined ? undefined : mathDigest(item.reference), mutation: item.mutation });
    metadataBytes += Buffer.byteLength(canonicalMathJson(metadata), 'utf8');
    if (metadataBytes > 120 * 1024 * 1024) throw new Error('formalization_eval_metadata_limit');
    return { input, metadata };
  });
}

/** Purely local preparation. Only the review/ subtree is intended to be shared with a reviewer. */
export function prepareFormalizationEvaluation(options: PrepareFormalizationEvaluationOptions) {
  const input = prepareOptionsSchema.parse(options), directory = externalDirectory(input.directory);
  if (fs.existsSync(directory)) throw new Error('formalization_eval_directory_exists');
  const inputFile = path.resolve(input.inputFile); assertMathCanonicalPath(inputFile);
  if (isMathPathWithin(directory, inputFile)) throw new Error('formalization_eval_source_inside_output');
  if (input.format === 'normalized' && (input.validationPercent !== undefined || input.splitSeed !== undefined || input.sourceSplit !== undefined))
    throw new Error('formalization_eval_normalized_split_is_explicit');
  if (input.sourceSplit !== undefined && (input.validationPercent !== undefined || input.splitSeed !== undefined))
    throw new Error('formalization_eval_upstream_split_conflicts');
  const contents = readMathText(inputFile, MAX_FORMALIZATION_EVALUATION_BYTES);
  const splitConfiguration: SplitConfiguration = input.format === 'normalized' ? { method: 'explicit-source-family' } :
    input.sourceSplit !== undefined ? { method: 'supplied-upstream', split: input.sourceSplit } :
      { method: 'sha256-source-family', seed: input.splitSeed ?? 'theorem-os-formalization-eval-v1', validationPercent: input.validationPercent ?? 20 };
  const cases = prepareCases(contents, input.format, input.provenance, splitConfiguration);
  const reviewIndex = indexSchema.parse({ schema: 'theorem-os.formalization-review-index.v1',
    cases: cases.map(item => ({ caseId: item.metadata.caseId, inputDigest: item.metadata.inputDigest, inputFile: item.metadata.inputFile })) });
  const bundle = bundleSchema.parse({ schema: 'theorem-os.formalization-evaluation-bundle.v1',
    createdAt: new Date().toISOString(), modelInvoked: false, format: input.format, provenance: input.provenance,
    sourceSha256: mathDigest(contents), sourceBytes: Buffer.byteLength(contents, 'utf8'), sourceRows: cases.length,
    splitConfiguration, reviewIndexDigest: digest(reviewIndex), cases: cases.map(item => item.metadata) });
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); assertMathCanonicalPath(directory);
  fs.mkdirSync(path.join(directory, 'private'), { mode: 0o700 });
  fs.mkdirSync(path.join(directory, 'review'), { mode: 0o700 });
  fs.mkdirSync(path.join(directory, 'review/inputs'), { mode: 0o700 });
  writeMathFrozen(path.join(directory, 'private/source.jsonl'), contents);
  writeMathFrozen(path.join(directory, 'private/manifest.json'), canonicalMathJson(bundle) + '\n');
  writeMathFrozen(path.join(directory, 'review/index.json'), canonicalMathJson(reviewIndex) + '\n');
  for (const item of cases) writeMathFrozen(path.join(directory, 'review', item.metadata.inputFile), canonicalMathJson(item.input) + '\n');
  return { schema: 'theorem-os.formalization-evaluation-prepared.v1', directory, modelInvoked: false,
    bundleDigest: digest(bundle), reviewerIndex: path.join(directory, 'review/index.json'),
    sourceSha256: bundle.sourceSha256, totalCases: cases.length,
    splitConfiguration,
    splits: { validation: cases.filter(item => item.metadata.split === 'validation').length,
      test: cases.filter(item => item.metadata.split === 'test').length },
    sourceFamilies: new Set(cases.map(item => item.metadata.splitGroupSha256)).size };
}

export function readFormalizationEvaluationBundle(directoryValue: string) {
  const directory = externalDirectory(directoryValue);
  const read = (relative: string, limit: number) => {
    const file = path.join(directory, relative); assertMathCanonicalPath(file);
    if ((fs.lstatSync(file).mode & 0o222) !== 0) throw new Error('formalization_eval_bundle_not_frozen');
    return readMathText(file, limit);
  };
  const bundle = bundleSchema.parse(JSON.parse(read('private/manifest.json', 128 * 1024 * 1024)));
  const source = read('private/source.jsonl', MAX_FORMALIZATION_EVALUATION_BYTES);
  if (mathDigest(source) !== bundle.sourceSha256 || Buffer.byteLength(source, 'utf8') !== bundle.sourceBytes)
    throw new Error('formalization_eval_source_changed');
  const expected = prepareCases(source, bundle.format, bundle.provenance, bundle.splitConfiguration);
  if (bundle.sourceRows !== expected.length || canonicalMathJson(bundle.cases) !== canonicalMathJson(expected.map(item => item.metadata)))
    throw new Error('formalization_eval_metadata_changed');
  const index = indexSchema.parse(JSON.parse(read('review/index.json', 16 * 1024 * 1024)));
  if (digest(index) !== bundle.reviewIndexDigest || canonicalMathJson(index.cases) !== canonicalMathJson(expected.map(item => ({
    caseId: item.metadata.caseId, inputDigest: item.metadata.inputDigest, inputFile: item.metadata.inputFile }))))
    throw new Error('formalization_eval_index_changed');
  const inputs = new Map<string, FormalizationEvaluationReviewerInput>();
  for (const item of expected) {
    const saved = formalizationEvaluationReviewerInputSchema.parse(JSON.parse(read('review/' + item.metadata.inputFile, 1024 * 1024)));
    if (canonicalMathJson(saved) !== canonicalMathJson(item.input) || formalizationEvaluationInputDigest(saved) !== item.metadata.inputDigest)
      throw new Error('formalization_eval_reviewer_input_changed');
    inputs.set(saved.caseId, saved);
  }
  return { directory, bundle, bundleDigest: digest(bundle), inputs };
}

const compilationEvidenceSchema = z.object({
  method: z.literal('host-lean'), sourceSha256: hash, toolchain: identifier,
  exitCode: z.number().int().min(-255).max(255).nullable(), timedOut: z.boolean(), logSha256: hash,
}).strict();
export const formalizationEvaluationDecisionSchema = z.object({
  caseId: caseIdSchema, inputDigest: hash,
  verdict: z.enum(['approved', 'changes_requested', 'unknown']),
  compileStatus: z.enum(['pass', 'fail', 'unknown']),
  compilation: compilationEvidenceSchema.optional(),
}).strict().superRefine((item, context) => {
  if (item.compileStatus === 'unknown') {
    if (item.compilation) context.addIssue({ code: 'custom', message: 'Unknown compilation must not carry a pass/fail observation.' });
  } else if (!item.compilation ||
      (item.compilation.exitCode === 0 && !item.compilation.timedOut ? 'pass' : 'fail') !== item.compileStatus ||
      item.compilation.exitCode === null && !item.compilation.timedOut) {
    context.addIssue({ code: 'custom', message: 'Compilation status requires a consistent host Lean observation.' });
  }
});
export type FormalizationEvaluationDecision = z.infer<typeof formalizationEvaluationDecisionSchema>;
export const formalizationEvaluationDecisionFileSchema = z.object({
  schema: z.literal('theorem-os.formalization-review-decisions.v1'), bundleDigest: hash,
  origin: z.object({ kind: z.enum(['model', 'human', 'preset']), reviewer: note, protocol: note,
    model: identifier.optional() }).strict(),
  decisions: z.array(formalizationEvaluationDecisionSchema).max(maximumRows),
}).strict().superRefine((item, context) => {
  if ((item.origin.kind === 'model') !== (item.origin.model !== undefined))
    context.addIssue({ code: 'custom', message: 'Only saved model decisions specify a model name.' });
});
export type FormalizationEvaluationDecisionFile = z.infer<typeof formalizationEvaluationDecisionFileSchema>;

const rate = (numerator: number, denominator: number) => ({ numerator, denominator,
  rate: denominator ? numerator / denominator : null });
function metrics(cases: CaseMetadata[], decisions: Map<string, FormalizationEvaluationDecision>) {
  let positives = 0, negatives = 0, approvals = 0, rejections = 0, unknown = 0, missing = 0;
  let trueAcceptances = 0, falseAcceptances = 0, trueRejections = 0, falseRejections = 0;
  let compilePass = 0, compileFail = 0, compileUnknown = 0;
  const toolchains: Record<string, number> = Object.create(null);
  for (const item of cases) {
    const decision = decisions.get(item.caseId), verdict = decision?.verdict ?? 'unknown';
    if (!decision) missing++;
    if (item.label === 'correct') positives++; else negatives++;
    if (verdict === 'approved') {
      approvals++; if (item.label === 'correct') trueAcceptances++; else falseAcceptances++;
    } else if (verdict === 'changes_requested') {
      rejections++; if (item.label === 'correct') falseRejections++; else trueRejections++;
    } else unknown++;
    if (decision?.compileStatus === 'pass') compilePass++;
    else if (decision?.compileStatus === 'fail') compileFail++;
    else compileUnknown++;
    if (decision?.compilation) toolchains[decision.compilation.toolchain] = (toolchains[decision.compilation.toolchain] ?? 0) + 1;
  }
  return { cases: cases.length, sourceFamilies: new Set(cases.map(item => item.splitGroupSha256)).size,
    positives, negatives, recordedDecisions: cases.length - missing, missingDecisions: missing,
    approvals, rejections, unknown, trueAcceptances, falseAcceptances, trueRejections, falseRejections,
    compilePass, compileFail, compileUnknown, compileToolchains: toolchains,
    upstreamLabelAgreement: rate(trueAcceptances + trueRejections, cases.length),
    upstreamLabelAgreementAmongDecided: rate(trueAcceptances + trueRejections, approvals + rejections),
    falseAcceptanceAmongNegatives: rate(falseAcceptances, negatives),
    falseAcceptanceAmongDecidedNegatives: rate(falseAcceptances, falseAcceptances + trueRejections),
    contaminationAmongApprovals: rate(falseAcceptances, approvals),
    falseRejectionAmongPositives: rate(falseRejections, positives),
    falseRejectionAmongDecidedPositives: rate(falseRejections, falseRejections + trueAcceptances),
    unknownRate: rate(unknown, cases.length), coverage: rate(approvals + rejections, cases.length),
    compileRate: rate(compilePass, cases.length), compileCoverage: rate(compilePass + compileFail, cases.length),
    compilePassAmongObserved: rate(compilePass, compilePass + compileFail) };
}

/** Scores saved records only. It does not run a reviewer, Lean, a provider, or the proof solver. */
export function scoreFormalizationEvaluation(directory: string, decisionsFile: string) {
  const prepared = readFormalizationEvaluationBundle(directory);
  decisionsFile = path.resolve(decisionsFile); assertMathCanonicalPath(decisionsFile);
  const decisionText = readMathText(decisionsFile, MAX_FORMALIZATION_EVALUATION_BYTES);
  const saved = formalizationEvaluationDecisionFileSchema.parse(JSON.parse(decisionText));
  if (saved.bundleDigest !== prepared.bundleDigest) throw new Error('formalization_eval_decision_bundle_mismatch');
  const byCase = new Map(prepared.bundle.cases.map(item => [item.caseId, item]));
  const decisions = new Map<string, FormalizationEvaluationDecision>();
  for (const item of saved.decisions) {
    if (decisions.has(item.caseId)) throw new Error('formalization_eval_decision_duplicate');
    const metadata = byCase.get(item.caseId);
    if (!metadata) throw new Error('formalization_eval_decision_case_unknown');
    if (metadata.inputDigest !== item.inputDigest) throw new Error('formalization_eval_decision_input_mismatch');
    if (item.compilation && item.compilation.sourceSha256 !== mathDigest(formalizationEvaluationLeanSource(prepared.inputs.get(item.caseId)!)))
      throw new Error('formalization_eval_compilation_source_mismatch');
    decisions.set(item.caseId, item);
  }
  const validation = metrics(prepared.bundle.cases.filter(item => item.split === 'validation'), decisions);
  const test = metrics(prepared.bundle.cases.filter(item => item.split === 'test'), decisions);
  return { schema: 'theorem-os.formalization-evaluation-score.v1', modelInvoked: false,
    bundleDigest: prepared.bundleDigest, sourceSha256: prepared.bundle.sourceSha256,
    decisionsSha256: mathDigest(decisionText), provenance: prepared.bundle.provenance,
    splitConfiguration: prepared.bundle.splitConfiguration,
    decisionOrigin: saved.origin, decisionEvidence: 'saved-records-not-replayed', compilationEvidence: 'saved-host-observations-not-replayed',
    measurementType: saved.origin.kind === 'model' ? 'recorded-model' : saved.origin.kind === 'human' ? 'recorded-human' : 'preset',
    measurement: { target: 'upstream-label-agreement',
      interpretation: 'Scores compare saved review verdicts with unchanged supplied labels. Unknown and missing decisions remain in the full-case denominator. Label agreement does not certify semantic truth, measure candidate-generation accuracy, or accept a proof of the original theorem.' },
    semanticTruthCertified: false, generationAccuracyMeasured: false, originalTheoremProofAcceptanceMeasured: false,
    decisionInvocationVerified: false,
    interpretation: saved.origin.kind === 'preset' ? 'preset-verdict-fixture-not-model-accuracy' :
      saved.origin.kind === 'human' ? 'saved-human-review-decisions' : 'saved-model-review-decisions',
    modelAccuracyMeasuredByThisCommand: false,
    sourceIsSynthetic: prepared.bundle.provenance.kind === 'synthetic-fixture',
    toolchain: { source: prepared.bundle.provenance.sourceToolchain, runtimeDefault: LOCAL_EXAMPLE_TOOLCHAIN,
      note: 'Compilation observations keep their recorded toolchain. A version change does not rewrite the semantic labels.' },
    splits: { validation, test },
    heldOut: { split: 'test', validationIncluded: false, metrics: test },
    overall: { use: 'descriptive-only-includes-validation-not-a-held-out-result', ...metrics(prepared.bundle.cases, decisions) } };
}
