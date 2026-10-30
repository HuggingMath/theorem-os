import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formalizationAdjudicationsSchema, readFormalizationAdjudications,
  type FormalizationAdjudications } from '../src/math/formalizationAdjudication';
import { prepareFormalizationEvaluation, readFormalizationEvaluationBundle,
  scoreFormalizationEvaluation } from '../src/math/formalizationEvaluation';
import { mathDigest } from '../src/math/mathRuntimeIo';

// Disposable saved-record fixtures only. Even the "certificate" is deliberately
// not valid Lean, so accepting its hash must never become machine verification.
const forbidden = vi.hoisted(() => ({ model: vi.fn(), lean: vi.fn() }));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: forbidden.model }));
vi.mock('../src/solver/formalizationElaboration', () => ({ elaborateFormalization: forbidden.lean }));
const roots: string[] = [];
afterEach(() => {
  expect(forbidden.model).not.toHaveBeenCalled();
  expect(forbidden.lean).not.toHaveBeenCalled();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-adjudication-fixture-')));
  roots.push(base);
  const directory = path.join(base, 'bundle'), inputFile = path.join(base, 'source.jsonl');
  fs.writeFileSync(inputFile, ['one', 'two'].map(id => JSON.stringify({
    id, sourceFamily: id, split: 'test', original: 'Synthetic original for ' + id,
    header: 'import Std\n', candidate: 'theorem ' + id + ' : False := by sorry',
    label: 'correct', labelProvenance: 'Synthetic label, not gold.', kind: 'synthetic',
  })).join('\n') + '\n');
  prepareFormalizationEvaluation({ directory, inputFile, format: 'normalized', provenance: {
    name: 'Synthetic saved-record fixture', kind: 'synthetic-fixture', labelProvenance: 'Synthetic, not gold.',
    sourceToolchain: 'leanprover/lean4:v4.8.0',
  } });
  const prepared = readFormalizationEvaluationBundle(directory), item = prepared.bundle.cases[0]!;
  const adjudicationDirectory = path.join(base, 'adjudications'); fs.mkdirSync(adjudicationDirectory);
  const certificate = path.join(adjudicationDirectory, 'certificate.lean');
  const processRecord = path.join(adjudicationDirectory, 'process.json');
  const supporting = path.join(adjudicationDirectory, 'stdout.bin');
  fs.writeFileSync(certificate, 'Deliberately not valid Lean; this tests saved bytes, not proof verification.\n');
  fs.writeFileSync(processRecord, JSON.stringify({ fixture: 'Arbitrary saved process metadata, never executed.' }));
  fs.writeFileSync(supporting, Buffer.from([0, 255, 13, 10]));
  const reference = (file: string) => ({ file: path.basename(file), sha256: mathDigest(fs.readFileSync(file)) });
  const saved: FormalizationAdjudications = {
    schema: 'theorem-os.formalization-adjudications.v1', bundleDigest: prepared.bundleDigest,
    records: [{ caseId: item.caseId, inputDigest: item.inputDigest,
      scope: 'candidate-falsity-only', finding: 'candidate-refuted', fidelity: 'not-assessed',
      note: 'Synthetic claimed counterexample; no fidelity adjudication.',
      evidence: { certificate: reference(certificate), processRecord: reference(processRecord),
        files: [reference(supporting)], toolchain: 'leanprover/lean4:v4.8.0', mathlibRevision: 'a'.repeat(40) } }],
  };
  const adjudicationFile = path.join(adjudicationDirectory, 'records.json');
  const save = () => fs.writeFileSync(adjudicationFile, JSON.stringify(saved) + '\n');
  save();
  const decisionsFile = path.join(base, 'decisions.json');
  fs.writeFileSync(decisionsFile, JSON.stringify({ schema: 'theorem-os.formalization-review-decisions.v1',
    bundleDigest: prepared.bundleDigest, origin: { kind: 'preset', reviewer: 'Fixture', protocol: 'Saved fixture only.' },
    decisions: prepared.bundle.cases.map(row => ({ caseId: row.caseId, inputDigest: row.inputDigest,
      verdict: 'changes_requested', compileStatus: 'unknown' })),
  }));
  return { base, directory, inputFile, prepared, adjudicationFile, saved, save,
    certificate, processRecord, supporting, decisionsFile };
}

describe('separate saved candidate-falsity evidence', () => {
  it('keeps upstream labels, score denominators and reviewer inputs unchanged while attaching saved records', () => {
    const f = fixture();
    const files = [f.inputFile, path.join(f.directory, 'private/manifest.json'), f.decisionsFile,
      ...f.prepared.bundle.cases.map(item => path.join(f.directory, 'review', item.inputFile))];
    const originalBytes = files.map(file => fs.readFileSync(file));
    const score = scoreFormalizationEvaluation(f.directory, f.decisionsFile);
    const evidence = readFormalizationAdjudications(f.directory, f.adjudicationFile);
    expect(evidence).toMatchObject({ evidence: 'saved-host-records-not-replayed', modelInvoked: false,
      leanReplayed: false, certificateMeaningVerified: false, semanticTruthCertified: false,
      fidelity: 'not-assessed', upstreamLabelsChanged: false,
      counts: { totalCases: 2, recordedCases: 1, unrecordedCases: 1, candidateRefutationRecords: 1 },
      records: [{ scope: 'candidate-falsity-only', finding: 'candidate-refuted', fidelity: 'not-assessed',
        upstreamLabel: 'correct', evidence: { certificate: { file: f.certificate }, processRecord: { file: f.processRecord },
          files: [{ file: f.supporting }] } }] });
    expect(evidence.adjudicationsSha256).toBe(mathDigest(fs.readFileSync(f.adjudicationFile)));
    expect(evidence.interpretation).toContain('Candidate falsity alone does not establish mistranslation');
    expect(score.splits.test).toMatchObject({ cases: 2, positives: 2, falseRejections: 2,
      upstreamLabelAgreement: { numerator: 0, denominator: 2, rate: 0 } });
    const augmented = { ...score, candidateTruthEvidence: evidence };
    expect(augmented.splits).toEqual(score.splits);
    expect(scoreFormalizationEvaluation(f.directory, f.decisionsFile)).toEqual(score);
    expect(score).not.toHaveProperty('candidateTruthEvidence');
    expect(files.map(file => fs.readFileSync(file))).toEqual(originalBytes);
    expect(readFormalizationEvaluationBundle(f.directory).bundle.cases.map(item => item.label))
      .toEqual(['correct', 'correct']);
    for (const input of f.prepared.inputs.values()) {
      expect(input).not.toHaveProperty('label');
      expect(input).not.toHaveProperty('adjudications');
      expect(input).not.toHaveProperty('candidateTruthEvidence');
    }
  });

  it.each(['bundle', 'input', 'unknown-case', 'duplicate'] as const)('rejects %s identity errors without dropping a case', changed => {
    const f = fixture();
    if (changed === 'bundle') f.saved.bundleDigest = '0'.repeat(64);
    else if (changed === 'input') f.saved.records[0]!.inputDigest = '0'.repeat(64);
    else if (changed === 'unknown-case') f.saved.records[0]!.caseId = 'case_' + '0'.repeat(64);
    else f.saved.records.push(f.saved.records[0]!);
    f.save();
    expect(() => readFormalizationAdjudications(f.directory, f.adjudicationFile))
      .toThrow('formalization_adjudication_' + ({ bundle: 'bundle_mismatch', input: 'input_mismatch',
        'unknown-case': 'case_unknown', duplicate: 'duplicate' }[changed]));
  });

  it.each(['certificate', 'processRecord', 'supporting'] as const)('rejects changed %s file bytes', changed => {
    const f = fixture(); fs.appendFileSync(f[changed], 'changed');
    expect(() => readFormalizationAdjudications(f.directory, f.adjudicationFile))
      .toThrow('formalization_adjudication_evidence_changed');
  });

  it('leaves every unrecorded case unassessed and permits an empty saved evidence set', () => {
    const f = fixture(); f.saved.records = []; f.save();
    const evidence = readFormalizationAdjudications(f.directory, f.adjudicationFile);
    expect(evidence.counts).toEqual({ totalCases: 2, recordedCases: 0, unrecordedCases: 2, candidateRefutationRecords: 0 });
    expect(evidence.records).toEqual([]);
    expect(evidence.semanticTruthCertified).toBe(false);
  });

  it('rejects scope expansion and a self-declared machine verification field', () => {
    const f = fixture();
    for (const addition of [{ scope: 'semantic-correctness' }, { fidelity: 'faithful' }, { machineVerified: true }]) {
      const value = structuredClone(f.saved);
      Object.assign(value.records[0]!, addition);
      expect(formalizationAdjudicationsSchema.safeParse(value).success).toBe(false);
    }
  });
});
