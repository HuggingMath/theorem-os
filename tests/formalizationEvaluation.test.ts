import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formalizationEvaluationDecisionFileSchema, formalizationEvaluationInputDigest,
  formalizationEvaluationLeanSource, prepareFormalizationEvaluation, readFormalizationEvaluationBundle,
  scoreFormalizationEvaluation, type FormalizationEvaluationDecisionFile,
  type FormalizationEvaluationProvenance } from '../src/math/formalizationEvaluation';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { evaluateFormalization } from '../scripts/mathematics/evaluateFormalization';

// Every example and verdict is synthetic, local and disposable. The suite never runs a model,
// a compiler or an external dataset, and its error rates are fixture arithmetic only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function temporary() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-evaluation-synthetic-')));
  roots.push(directory); return directory;
}
const provenance: FormalizationEvaluationProvenance = { name: 'Synthetic mutation fixture, never a benchmark result',
  kind: 'synthetic-fixture', labelProvenance: 'Handwritten labels for test arithmetic only; no actual semantic review.',
  sourceToolchain: 'leanprover/lean4:v4.8.0', revision: 'synthetic-fixture-v1' };
function row(id: string, split: 'validation' | 'test', label: 'correct' | 'incorrect', family = id) {
  return { id, sourceFamily: family, split, label, kind: 'mutation',
    original: 'Synthetic natural number statement for family ' + family + '.', header: 'import Std\n',
    candidate: 'theorem fixture_' + id + ' (n : Nat) : n = n := by sorry\n',
    reference: 'REFERENCE_ONLY_SECRET_' + id, labelProvenance: 'LABEL_ONLY_SECRET_' + label + '_' + id,
    mutation: 'MUTATION_ONLY_SECRET_' + id };
}
function prepare(rows: unknown[], format: 'normalized' | 'proofnetverif' = 'normalized', options = {}) {
  const base = temporary(), inputFile = path.join(base, 'filename_incorrect_gold_secret.jsonl'), directory = path.join(base, 'bundle');
  fs.writeFileSync(inputFile, rows.map(item => JSON.stringify(item)).join('\n') + '\n');
  const result = prepareFormalizationEvaluation({ directory, inputFile, format, provenance, ...options });
  return { base, inputFile, directory, result, prepared: readFormalizationEvaluationBundle(directory) };
}
function decisionFile(fixture: ReturnType<typeof prepare>, decisions: FormalizationEvaluationDecisionFile['decisions'],
  kind: 'preset' | 'model' | 'human' = 'preset') {
  const file = path.join(fixture.base, 'decisions-' + Math.random().toString(16).slice(2) + '.json');
  const value: FormalizationEvaluationDecisionFile = { schema: 'theorem-os.formalization-review-decisions.v1',
    bundleDigest: fixture.prepared.bundleDigest,
    origin: { kind, reviewer: 'synthetic-test-only', protocol: 'Preset arithmetic fixture, no model review.',
      ...(kind === 'model' ? { model: 'synthetic-saved-model-label' } : {}) }, decisions };
  const save = () => fs.writeFileSync(file, JSON.stringify(value));
  save(); return { file, value, save };
}
function decision(fixture: ReturnType<typeof prepare>, sourceId: string,
  verdict: 'approved' | 'changes_requested' | 'unknown', compileStatus: 'pass' | 'fail' | 'unknown' = 'unknown') {
  const metadata = fixture.prepared.bundle.cases.find(item => item.sourceId === sourceId)!;
  return { caseId: metadata.caseId, inputDigest: metadata.inputDigest, verdict, compileStatus,
    ...(compileStatus === 'unknown' ? {} : { compilation: { method: 'host-lean' as const,
      sourceSha256: mathDigest(formalizationEvaluationLeanSource(fixture.prepared.inputs.get(metadata.caseId)!)),
      toolchain: 'leanprover/lean4:v4.33.0', exitCode: compileStatus === 'pass' ? 0 : 1,
      timedOut: false, logSha256: mathDigest('Synthetic saved observation; no Lean executed.') } }) };
}
async function invoke(args: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = await evaluateFormalization(args), output = String(log.mock.calls.at(-1)?.[0]);
    return { code, output, report: args.includes('--help') ? undefined : JSON.parse(output) };
  } finally { log.mockRestore(); }
}

describe('frozen formalization semantic-review inputs', () => {
  it('separates labels, references, mutation notes, splits, source IDs and filenames from the whole reviewer subtree', () => {
    const rows = [row('negative_source_id', 'validation', 'incorrect'), row('positive_source_id', 'test', 'correct')];
    const f = prepare(rows);
    const indexText = fs.readFileSync(f.result.reviewerIndex, 'utf8'), index = JSON.parse(indexText);
    expect(Object.keys(index)).toEqual(['cases', 'schema']);
    expect(f.result).toMatchObject({ modelInvoked: false, totalCases: 2, splits: { validation: 1, test: 1 } });
    const reviewTexts = [indexText];
    for (const item of index.cases) {
      expect(Object.keys(item).sort()).toEqual(['caseId', 'inputDigest', 'inputFile']);
      expect(item.inputFile).toMatch(/^inputs\/case_[a-f0-9]{64}\.json$/u);
      const file = path.join(f.directory, 'review', item.inputFile), contents = fs.readFileSync(file, 'utf8');
      const input = JSON.parse(contents);
      expect(Object.keys(input).sort()).toEqual(['candidate', 'caseId', 'header', 'original', 'schema']);
      expect(formalizationEvaluationInputDigest(input)).toBe(item.inputDigest);
      expect(fs.statSync(file).mode & 0o222).toBe(0);
      reviewTexts.push(contents);
    }
    // Source IDs may occur naturally inside theorem names. Here we verify fields added by the
    // adapter by comparing the exact input, and separately exclude private-only markers.
    for (const input of f.prepared.inputs.values()) {
      const source = rows.find(item => item.candidate === input.candidate)!;
      expect(input).toEqual({ schema: 'theorem-os.formalization-review-input.v1', caseId: input.caseId,
        original: source.original, header: source.header, candidate: source.candidate });
    }
    const publicText = reviewTexts.join('\n');
    for (const secret of ['REFERENCE_ONLY_SECRET', 'LABEL_ONLY_SECRET', 'MUTATION_ONLY_SECRET',
      'filename_incorrect_gold_secret', '"validation"', '"test"', '"label"', '"sourceId"', '"sourceFamily"', '"reference"'])
      expect(publicText).not.toContain(secret);
    expect(f.prepared.bundle.cases[0]).toMatchObject({ reference: rows[0].reference,
      labelProvenance: rows[0].labelProvenance, mutation: rows[0].mutation });
    expect(f.prepared.bundle.sourceSha256).toBe(mathDigest(fs.readFileSync(f.inputFile)));
  });

  it('normalizes supplied ProofNetVerif labels and prevents candidates of one source family entering different splits', () => {
    const rows = [0, 1, 2].map(index => ({ id: 'upstream_theorem', nl_statement: 'For every n, n + 0 = n.',
      lean4_src_header: 'import Mathlib\n', lean4_formalization: 'PRIVATE_UPSTREAM_REFERENCE',
      lean4_prediction: 'theorem candidate_' + index + ' : True := by sorry', correct: index === 0 ? true : index === 1 ? 0 : 1 }));
    const f = prepare(rows, 'proofnetverif', { splitSeed: 'test-seed', validationPercent: 40 });
    expect(new Set(f.prepared.bundle.cases.map(item => item.split)).size).toBe(1);
    expect(new Set(f.prepared.bundle.cases.map(item => item.splitGroupSha256)).size).toBe(1);
    expect(f.prepared.bundle.cases.map(item => item.label)).toEqual(['correct', 'incorrect', 'correct']);
    expect(f.prepared.bundle.cases.every(item => item.labelProvenance === provenance.labelProvenance)).toBe(true);
    expect(f.prepared.bundle.splitConfiguration).toEqual({ method: 'sha256-source-family', seed: 'test-seed', validationPercent: 40 });
    const referenceHash = mathDigest('PRIVATE_UPSTREAM_REFERENCE');
    expect(f.prepared.bundle.cases.every(item => item.referenceSha256 === referenceHash)).toBe(true);
    const second = prepare(rows, 'proofnetverif', { splitSeed: 'test-seed', validationPercent: 40 });
    expect(second.prepared.bundle.cases).toEqual(f.prepared.bundle.cases);
  });

  it('links changed source IDs through identical original text, including whitespace variants', () => {
    const rows = [0, 1].map(index => ({ id: 'different_' + index,
      nl_statement: index ? 'For\n every n, n + 0 = n.' : 'For every n, n + 0 = n.',
      lean4_src_header: '', lean4_formalization: 'REFERENCE', lean4_prediction: 'theorem c' + index + ' : True := by sorry', correct: false }));
    const f = prepare(rows, 'proofnetverif');
    expect(new Set(f.prepared.bundle.cases.map(item => item.splitGroupSha256)).size).toBe(1);
  });

  it.each(['validation', 'test'] as const)('preserves the supplied upstream %s split without random reassignment', sourceSplit => {
    const rows = [0, 1, 2, 3].map(index => ({ id: 'theorem_' + index,
      nl_statement: 'Distinct original theorem ' + index, lean4_src_header: '', lean4_formalization: 'REFERENCE',
      lean4_prediction: 'theorem c' + index + ' : True := by sorry', correct: index % 2 === 0 }));
    const f = prepare(rows, 'proofnetverif', { sourceSplit });
    expect(f.result.splitConfiguration).toEqual({ method: 'supplied-upstream', split: sourceSplit });
    expect(f.prepared.bundle.splitConfiguration).toEqual({ method: 'supplied-upstream', split: sourceSplit });
    expect(f.prepared.bundle.cases.every(item => item.split === sourceSplit)).toBe(true);
    expect(f.result.splits).toEqual(sourceSplit === 'test' ? { validation: 0, test: 4 } : { validation: 4, test: 0 });
    const saved = decisionFile(f, []), report = scoreFormalizationEvaluation(f.directory, saved.file);
    expect(report.splitConfiguration).toEqual({ method: 'supplied-upstream', split: sourceSplit });
    expect(report.splits[sourceSplit]).toMatchObject({ cases: 4, unknown: 4, missingDecisions: 4 });
    expect(report.modelInvoked).toBe(false);
  });

  it('rejects random splitting options when an upstream split is supplied, and rejects sourceSplit for explicit normalized rows', () => {
    const raw = { id: 'theorem', nl_statement: 'An original theorem.', lean4_src_header: '',
      lean4_formalization: 'REFERENCE', lean4_prediction: 'theorem c : True := by sorry', correct: true };
    expect(() => prepare([raw], 'proofnetverif', { sourceSplit: 'test', validationPercent: 20 }))
      .toThrow('formalization_eval_upstream_split_conflicts');
    expect(() => prepare([raw], 'proofnetverif', { sourceSplit: 'test', splitSeed: 'new-partition' }))
      .toThrow('formalization_eval_upstream_split_conflicts');
    expect(() => prepare([row('one', 'test', 'correct')], 'normalized', { sourceSplit: 'test' }))
      .toThrow('formalization_eval_normalized_split_is_explicit');
  });

  it.each(['family', 'renamed-original'] as const)('rejects %s leakage across validation and test before writing a bundle', kind => {
    const first = row('first', 'validation', 'correct', 'family-a'), second = row('second', 'test', 'incorrect', 'family-b');
    if (kind === 'family') second.sourceFamily = first.sourceFamily;
    else second.original = '  ' + first.original.replaceAll(' ', '\n') + '  ';
    const base = temporary(), source = path.join(base, 'source.jsonl'), directory = path.join(base, 'bundle');
    fs.writeFileSync(source, [first, second].map(item => JSON.stringify(item)).join('\n'));
    expect(() => prepareFormalizationEvaluation({ directory, inputFile: source, format: 'normalized', provenance }))
      .toThrow('formalization_eval_split_family_leakage');
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('rejects duplicate cases, duplicate normalized IDs, invalid rows and meaningless automatic-split flags for normalized input', () => {
    const first = row('first', 'test', 'incorrect');
    expect(() => prepare([first, { ...first, id: 'renamed' }])).toThrow('formalization_eval_case_duplicate');
    expect(() => prepare([first, { ...first, candidate: 'theorem different : True := by sorry' }]))
      .toThrow('formalization_eval_source_id_duplicate');
    expect(() => prepare([{ ...first, unrecognizedField: 'should not be silently accepted' }])).toThrow('formalization_eval_row_invalid');
    expect(() => prepare([{ ...first, label: 'probably' }])).toThrow('formalization_eval_row_invalid');
    expect(() => prepare([first], 'normalized', { validationPercent: 20 })).toThrow('normalized_split_is_explicit');
  });

  it.each(['source', 'input', 'manifest', 'index'] as const)('detects a changed frozen %s on read', changed => {
    const f = prepare([row('one', 'test', 'correct')]);
    const files = { source: path.join(f.directory, 'private/source.jsonl'), input: path.join(f.directory, 'review', f.prepared.bundle.cases[0].inputFile),
      manifest: path.join(f.directory, 'private/manifest.json'), index: f.result.reviewerIndex };
    const file = files[changed]; fs.chmodSync(file, 0o600);
    if (changed === 'source') fs.appendFileSync(file, '\n');
    else {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (changed === 'input') value.original = 'changed';
      else if (changed === 'manifest') value.cases[0].label = 'incorrect';
      else value.cases[0].inputDigest = '0'.repeat(64);
      fs.writeFileSync(file, JSON.stringify(value));
    }
    fs.chmodSync(file, 0o400);
    expect(() => readFormalizationEvaluationBundle(f.directory)).toThrow();
  });

  it('requires fresh external directories and canonical input/output paths', () => {
    const f = prepare([row('one', 'test', 'correct')]);
    expect(() => prepareFormalizationEvaluation({ directory: f.directory, inputFile: f.inputFile, format: 'normalized', provenance }))
      .toThrow('formalization_eval_directory_exists');
    expect(() => prepareFormalizationEvaluation({ directory: path.join(root, 'uncreated-eval-test'), inputFile: f.inputFile, format: 'normalized', provenance }))
      .toThrow('formalization_eval_directory_must_be_external');
    const alias = path.join(f.base, 'alias'); fs.symlinkSync(f.directory, alias);
    expect(() => readFormalizationEvaluationBundle(alias)).toThrow('math_path_invalid');
    fs.chmodSync(path.join(f.directory, 'review/index.json'), 0o600);
    expect(() => readFormalizationEvaluationBundle(f.directory)).toThrow('formalization_eval_bundle_not_frozen');
  });

  it('rejects bounded-input violations and malformed JSON before preparing any outputs', () => {
    const base = temporary(), source = path.join(base, 'source.jsonl'), directory = path.join(base, 'bundle');
    const attempt = () => prepareFormalizationEvaluation({ directory, inputFile: source, format: 'normalized', provenance });
    fs.writeFileSync(source, '{not json}\n');
    expect(attempt).toThrow('formalization_eval_jsonl_invalid:1');
    fs.writeFileSync(source, ' \n\t\n');
    expect(attempt).toThrow('formalization_eval_input_empty');
    fs.writeFileSync(source, JSON.stringify({ ...row('one', 'test', 'correct'), original: 'x'.repeat(512 * 1024) }));
    expect(attempt).toThrow('formalization_eval_input_limit');
    // A sparse oversized file exercises the host file limit without reading a 64 MiB buffer.
    fs.truncateSync(source, 64 * 1024 * 1024 + 1);
    expect(attempt).toThrow('math_runtime_file_too_large');
    expect(fs.existsSync(directory)).toBe(false);
  });
});

describe('saved semantic verdict and compiler observation scoring', () => {
  function scoreFixture() {
    return prepare([row('vp', 'validation', 'correct'), row('vn', 'validation', 'incorrect'),
      row('tp', 'test', 'correct'), row('tf', 'test', 'correct'), row('tn', 'test', 'incorrect'),
      row('tr', 'test', 'incorrect'), row('tu', 'test', 'incorrect')]);
  }
  it('uses explicit error denominators, preserves missing decisions as unknown and keeps compiler results independent', () => {
    const f = scoreFixture();
    const decisions = decisionFile(f, [decision(f, 'vp', 'changes_requested'), decision(f, 'vn', 'approved'),
      decision(f, 'tp', 'approved', 'fail'), decision(f, 'tf', 'changes_requested', 'pass'),
      decision(f, 'tn', 'approved'), decision(f, 'tr', 'changes_requested')]);
    const report = scoreFormalizationEvaluation(f.directory, decisions.file);
    expect(report).toMatchObject({ modelInvoked: false, sourceIsSynthetic: true,
      interpretation: 'preset-verdict-fixture-not-model-accuracy', modelAccuracyMeasuredByThisCommand: false,
      measurement: { target: 'upstream-label-agreement' }, semanticTruthCertified: false,
      generationAccuracyMeasured: false, originalTheoremProofAcceptanceMeasured: false,
      measurementType: 'preset', decisionInvocationVerified: false,
      heldOut: { split: 'test', validationIncluded: false } });
    const test = report.splits.test;
    expect(test).toMatchObject({ cases: 5, positives: 2, negatives: 3, recordedDecisions: 4, missingDecisions: 1,
      approvals: 2, rejections: 2, unknown: 1, trueAcceptances: 1, falseAcceptances: 1, trueRejections: 1, falseRejections: 1,
      compilePass: 1, compileFail: 1, compileUnknown: 3 });
    expect(test.falseAcceptanceAmongNegatives).toEqual({ numerator: 1, denominator: 3, rate: 1 / 3 });
    expect(test.falseAcceptanceAmongDecidedNegatives).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(test.contaminationAmongApprovals).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(test.falseRejectionAmongPositives).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(test.unknownRate).toEqual({ numerator: 1, denominator: 5, rate: 0.2 });
    expect(test.coverage).toEqual({ numerator: 4, denominator: 5, rate: 0.8 });
    expect(test.upstreamLabelAgreement).toEqual({ numerator: 2, denominator: 5, rate: 0.4 });
    expect(test.upstreamLabelAgreementAmongDecided).toEqual({ numerator: 2, denominator: 4, rate: 0.5 });
    expect(test.compileRate).toEqual({ numerator: 1, denominator: 5, rate: 0.2 });
    expect(test.compileCoverage).toEqual({ numerator: 2, denominator: 5, rate: 0.4 });
    expect(test.compilePassAmongObserved).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(report.heldOut.metrics).toEqual(test);
    expect(report.splits.validation.cases).toBe(2);
    expect(report.splits.validation.falseAcceptances).toBe(1);
    expect(report.overall.cases).toBe(7);
    expect(report.overall.upstreamLabelAgreement).toEqual({ numerator: 2, denominator: 7, rate: 2 / 7 });
    expect(report.overall.use).toContain('not-a-held-out-result');
    expect(report.toolchain).toMatchObject({ source: 'leanprover/lean4:v4.8.0', runtimeDefault: 'leanprover/lean4:v4.33.0' });
    expect(test.compileToolchains).toEqual({ 'leanprover/lean4:v4.33.0': 2 });
    expect(report.decisionsSha256).toBe(mathDigest(fs.readFileSync(decisions.file)));
  });

  it('uses null for empty denominators, distinguishes explicit unknown from missing and never drops either', () => {
    const f = prepare([row('one', 'test', 'correct'), row('two', 'test', 'correct')]);
    const saved = decisionFile(f, [decision(f, 'one', 'unknown')]);
    const report = scoreFormalizationEvaluation(f.directory, saved.file);
    expect(report.splits.test).toMatchObject({ cases: 2, positives: 2, negatives: 0, unknown: 2,
      recordedDecisions: 1, missingDecisions: 1, compileUnknown: 2 });
    expect(report.splits.test.falseAcceptanceAmongNegatives.rate).toBeNull();
    expect(report.splits.test.contaminationAmongApprovals.rate).toBeNull();
    expect(report.splits.test.coverage.rate).toBe(0);
    expect(report.splits.test.unknownRate.rate).toBe(1);
    expect(report.splits.test.upstreamLabelAgreement).toEqual({ numerator: 0, denominator: 2, rate: 0 });
    expect(report.splits.test.upstreamLabelAgreementAmongDecided).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(report.splits.validation.cases).toBe(0);
    expect(report.splits.validation.upstreamLabelAgreement.rate).toBeNull();
    expect(report.splits.validation.coverage.rate).toBeNull();
    expect(report.splits.test.compilePassAmongObserved.rate).toBeNull();
  });

  it.each(['preset', 'model', 'human'] as const)('reports %s decisions against supplied labels without certifying truth or using a matching private reference to relabel', kind => {
    const item = row('one', 'test', 'incorrect');
    item.reference = item.candidate;
    const f = prepare([item]), saved = decisionFile(f, [decision(f, 'one', 'approved', 'pass')], kind);
    const files = [f.inputFile, path.join(f.directory, 'private/manifest.json'),
      path.join(f.directory, 'review', f.prepared.bundle.cases[0].inputFile), saved.file];
    const before = files.map(file => fs.readFileSync(file, 'utf8'));
    const report = scoreFormalizationEvaluation(f.directory, saved.file);
    expect(report).toMatchObject({ schema: 'theorem-os.formalization-evaluation-score.v1',
      measurement: { target: 'upstream-label-agreement' }, semanticTruthCertified: false,
      generationAccuracyMeasured: false, originalTheoremProofAcceptanceMeasured: false,
      decisionOrigin: { kind }, splits: { test: { falseAcceptances: 1, compilePass: 1,
        upstreamLabelAgreement: { numerator: 0, denominator: 1, rate: 0 } } } });
    expect(report.measurement.interpretation).toContain('unchanged supplied labels');
    expect(report.measurement.interpretation).toContain('does not certify semantic truth');
    expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
    expect(readFormalizationEvaluationBundle(f.directory).bundle.cases[0].label).toBe('incorrect');
    expect(f.prepared.inputs.values().next().value).not.toHaveProperty('reference');
  });

  it.each(['bundle', 'input', 'duplicate', 'unknown-case', 'compiler-source'] as const)('rejects invalid %s records rather than silently reducing denominators', changed => {
    const f = prepare([row('one', 'test', 'incorrect')]);
    const saved = decisionFile(f, [decision(f, 'one', 'approved', 'pass')]);
    if (changed === 'bundle') saved.value.bundleDigest = '0'.repeat(64);
    else if (changed === 'input') saved.value.decisions[0].inputDigest = '0'.repeat(64);
    else if (changed === 'duplicate') saved.value.decisions.push(saved.value.decisions[0]);
    else if (changed === 'unknown-case') saved.value.decisions[0].caseId = 'case_' + '0'.repeat(64);
    else saved.value.decisions[0].compilation!.sourceSha256 = '0'.repeat(64);
    saved.save();
    expect(() => scoreFormalizationEvaluation(f.directory, saved.file)).toThrow('formalization_eval_');
  });

  it('requires a consistent saved host observation before counting compilation and distinguishes saved origins', () => {
    const f = prepare([row('one', 'test', 'incorrect')]);
    const saved = decisionFile(f, [decision(f, 'one', 'approved', 'pass')], 'model');
    expect(scoreFormalizationEvaluation(f.directory, saved.file)).toMatchObject({ interpretation: 'saved-model-review-decisions',
      modelInvoked: false, modelAccuracyMeasuredByThisCommand: false,
      measurementType: 'recorded-model', decisionInvocationVerified: false,
      decisionOrigin: { kind: 'model', model: 'synthetic-saved-model-label' } });
    const malformed = JSON.parse(canonicalMathJson(saved.value)); delete malformed.decisions[0].compilation;
    expect(formalizationEvaluationDecisionFileSchema.safeParse(malformed).success).toBe(false);
    malformed.decisions[0] = { ...saved.value.decisions[0], compileStatus: 'fail' };
    expect(formalizationEvaluationDecisionFileSchema.safeParse(malformed).success).toBe(false);
    malformed.decisions[0] = { ...saved.value.decisions[0], compileStatus: 'unknown' };
    expect(formalizationEvaluationDecisionFileSchema.safeParse(malformed).success).toBe(false);
    malformed.decisions[0] = saved.value.decisions[0]; malformed.origin.kind = 'preset';
    expect(formalizationEvaluationDecisionFileSchema.safeParse(malformed).success).toBe(false);
  });
});

describe('offline formalization evaluation CLI', () => {
  it('supports upstream split preservation and rejects conflicting or invalid split flags', async () => {
    const base = temporary(), input = path.join(base, 'source.jsonl'), provenanceFile = path.join(base, 'provenance.json');
    fs.writeFileSync(input, JSON.stringify({ id: 'theorem', nl_statement: 'An original theorem.', lean4_src_header: '',
      lean4_formalization: 'REFERENCE', lean4_prediction: 'theorem c : True := by sorry', correct: true }) + '\n');
    fs.writeFileSync(provenanceFile, JSON.stringify(provenance));
    const args = ['--phase', 'prepare', '--directory', path.join(base, 'bundle'), '--input', input,
      '--format', 'proofnetverif', '--provenance', provenanceFile, '--source-split', 'test'];
    await expect(invoke([...args, '--split-seed', 'local-seed'])).rejects.toThrow('formalization_eval_upstream_split_conflicts');
    await expect(invoke([...args, '--validation-percent', '20'])).rejects.toThrow('formalization_eval_upstream_split_conflicts');
    await expect(invoke([...args.slice(0, -1), 'other'])).rejects.toThrow('--source-split must be validation or test');
    const prepared = await invoke(args);
    expect(prepared.report).toMatchObject({ splitConfiguration: { method: 'supplied-upstream', split: 'test' },
      splits: { validation: 0, test: 1 }, modelInvoked: false });
  });

  it('prepares and scores local normalized input without changing its immutable bundle', async () => {
    const base = temporary(), input = path.join(base, 'source.jsonl'), provenanceFile = path.join(base, 'provenance.json');
    fs.writeFileSync(input, JSON.stringify(row('one', 'test', 'incorrect')) + '\n');
    fs.writeFileSync(provenanceFile, JSON.stringify(provenance));
    const directory = path.join(base, 'bundle');
    const prepared = await invoke(['--phase', 'prepare', '--directory', directory, '--input', input,
      '--format', 'normalized', '--provenance', provenanceFile]);
    expect(prepared.report).toMatchObject({ modelInvoked: false, totalCases: 1 });
    const saved = path.join(base, 'decisions.json');
    fs.writeFileSync(saved, JSON.stringify({ schema: 'theorem-os.formalization-review-decisions.v1',
      bundleDigest: prepared.report.bundleDigest, origin: { kind: 'preset', reviewer: 'fixture', protocol: 'No decisions.' }, decisions: [] }));
    const before = fs.readFileSync(path.join(directory, 'private/manifest.json'), 'utf8'), output = path.join(base, 'score.json');
    const scored = await invoke(['--phase', 'score', '--directory', directory, '--decisions', saved, '--output', output]);
    expect(scored.report).toMatchObject({ measurement: { target: 'upstream-label-agreement' },
      semanticTruthCertified: false, generationAccuracyMeasured: false, originalTheoremProofAcceptanceMeasured: false });
    expect(scored.report.splits.test).toMatchObject({ cases: 1, unknown: 1, missingDecisions: 1 });
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual(scored.report);
    expect(fs.readFileSync(path.join(directory, 'private/manifest.json'), 'utf8')).toBe(before);
    await expect(invoke(['--phase', 'score', '--directory', directory, '--decisions', saved, '--output', output])).rejects.toThrow();
  });

  it('rejects inappropriate or duplicate flags and documents the offline boundary', async () => {
    const f = prepare([row('one', 'test', 'incorrect')]);
    await expect(invoke(['--phase', 'score', '--directory', f.directory, '--input', f.inputFile])).rejects.toThrow('not valid');
    await expect(invoke(['--phase', 'score', '--phase', 'prepare', '--directory', f.directory])).rejects.toThrow('Duplicate argument');
    await expect(invoke(['--phase', 'other', '--directory', f.directory])).rejects.toThrow('Unknown formalization evaluation phase');
    await expect(invoke(['--phase', 'score', '--directory', f.directory, '--output', path.join(f.directory, 'score.json')]))
      .rejects.toThrow('formalization_eval_report_must_be_external');
    const help = await invoke(['--help']);
    expect(help.code).toBe(0); expect(help.output).toContain('no model, Lean compiler, provider or credentials');
    expect(help.output).toContain('heldOut always excludes validation');
    expect(help.output).toContain('Measures upstream-label agreement');
  });
});
