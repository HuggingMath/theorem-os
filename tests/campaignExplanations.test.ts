import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importCampaignExplanations } from '../scripts/campaign-explanations';
import { informalizationAuditInput, informalizationBatches, informalizationEvidence, informalizationWriterInput,
  writeInformalizationArtifact, type InformalizationEvidence, type InformalizationRequest, type InformalizationSection } from '../src/math/informalization';
import { informalizationOutline } from '../src/math/informalizationExtraction';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { sourceRange } from './helpers/informalizationFixture';
import { selectedGeneratedExplanations } from '../docs/web/generatedProofExplanation';
import { proofSolutionMode, renderProofSolution } from '../docs/web/proofSolution';
import { readingProcess } from '../docs/web/catalog';
import { proofWalkthroughs, withProofWalkthrough } from '../docs/web/proofWalkthroughCatalog';
import type { ArchiveProcess, ArchiveRecord } from '../docs/web/types';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

// Synthetic source/explanation/audits only. No Lean execution, runtime, model, or real campaign is involved.
function fixture(multipleFiles: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-explanation-')); roots.push(root);
  const sources = [{ module: 'Submission', file: 'Submission.lean', text: multipleFiles
    ? 'import Lib\ntheorem target : True := by exact lib_fact\n' : 'theorem target : True := by trivial\n' }];
  if (multipleFiles) sources.unshift({ module: 'Lib', file: 'Lib.lean', text: 'theorem lib_fact : True := by trivial\n' });
  const targetSource = sources.at(-1)!.text, nonce = '1'.repeat(32);
  const units = sources.map(source => {
    const name = source.module === 'Lib' ? 'lib_fact' : 'target', snippet = source.text.trim().split('\n').at(-1)!;
    return { name, displayName: name, kind: 'theorem', module: source.module, range: sourceRange(source.text, snippet),
      signature: `${name} : True`, statementDependencies: [], proofDependencies: multipleFiles && name === 'target' ? ['lib_fact'] : [],
      external: [], externalTruncated: false };
  });
  const outline = informalizationOutline({ nonce, target: 'target', axioms: [], units, library: [], libraryTruncated: false }, { nonce, target: 'target', sources });
  const author = { model: 'preset', effort: 'none', profile: '/home/fixture/private-profile', executable: '/no-model' };
  const request = { language: 'zh', toolchain: 'leanprover/lean4:v4.33.0', mathlibRevision: null, statementSha256: null,
    batching: { maxUnits: 12, maxSourceBytes: 60000 }, sources: sources.map(source => ({ module: source.module, file: source.file,
      origin: source.file, sha256: mathDigest(source.text), bytes: Buffer.byteLength(source.text) })),
    writer: author, auditors: [{ ...author, id: 'one' }, { ...author, id: 'two' }] } as unknown as InformalizationRequest;
  const accepted = new Map<string, InformalizationSection>(), batches: InformalizationEvidence['batches'] = [];
  for (const batch of informalizationBatches(outline, request.batching)) {
    const context = { outline, batch, accepted, sources, language: 'zh' as const };
    const input = informalizationWriterInput({ ...context, round: 1, problemStatement: null, feedback: null, previousOutput: null });
    const writer = { inputDigest: input.inputDigest, sections: input.units.map(unit => ({ declaration: unit.declaration,
      title: `Explanation ${unit.declaration}`, statement: `${unit.declaration} is true.`,
      proof: [{ text: `Explain ${unit.declaration}.`, uses: unit.mustCite, lean: [unit.source] }] })), overview: 'The target follows from the accepted Lean proof.' };
    const auditInput = informalizationAuditInput({ ...context, explanation: writer });
    const audits = request.auditors.map(auditor => ({ auditorId: auditor.id, output: { inputDigest: auditInput.inputDigest,
      sections: writer.sections.map(section => ({ declaration: section.declaration, statement: { verdict: 'faithful' as const, explanation: '' },
        steps: [{ verdict: 'justified' as const, explanation: '' }], omissions: [] })), overview: { verdict: 'consistent' as const, explanation: '' }, summary: 'Approved.' } }));
    batches.push({ index: batch.index, declarations: batch.declarations, rounds: 1, writerInputDigest: input.inputDigest, writer, audits });
    for (const section of writer.sections) accepted.set(section.declaration, section);
  }
  const evidence = informalizationEvidence({ request, outline, batches, sessions: [] });
  const artifact = writeInformalizationArtifact(root, evidence);
  const runId = '145b477c-2f3c-43e2-94d1-f0de28bc6015', proofCommit = 'a'.repeat(40), proofSha256 = mathDigest(targetSource);
  const binding = { runId, proofCommit, proofSha256, targets: [{ theoremName: 'target', proofPath: 'Submission.lean' }],
    sources: new Map(sources.map(source => [source.file, source.text])) };
  const result = { runId, solution_commit: proofCommit, status: 'evaluated_passed', explanations: { targets: [
    { target: 'target', proofPath: 'Submission.lean', status: 'approved', artifact }] } };
  return { root, sources, targetSource, binding, result, artifact };
}

function archive(fix: ReturnType<typeof fixture>) {
  const generated = importCampaignExplanations(fix.result, fix.binding), { runId, proofCommit, proofSha256 } = fix.binding;
  const process: ArchiveProcess = { ...generated, runs: [{ runId, phase: 'finished', resultStatus: 'evaluated_passed',
    turns: 1, workers: 1, tasks: [], events: [], checks: [{ id: 'kernel', at: '2026-11-15T00:00:00Z', scope: 'original',
      status: 'kernel_verified', sourceDigest: proofSha256, commit: proofCommit, receiptIds: ['fixture'] }] }] };
  const record: ArchiveRecord = { id: 'openai_generated_fixture', title: 'Fixture', subtitle: 'Fixture', area: 'Math', summary: 'Fixture',
    status: 'locally_verified', model: 'preset', updatedAt: '2026-11-15T00:00:00Z', archiveUrl: '', process,
    campaign: { target: 'GeneratedFixture', runId, targets: ['target'], proofCommit, proofSha256,
      kernelReceiptIds: ['fixture'], comparatorExitCode: 0, attribution: 'Synthetic fixture', evidenceUrl: '' },
    sources: fix.sources.map(source => ({ name: source.file, path: source.file, url: source.file, code: source.text,
      sha256: mathDigest(source.text), lines: source.text.split('\n').length })) };
  return { record, process, generated };
}

describe('automatic CLI explanation delivery to the classic proof reader', () => {
  it.each([false, true])('imports and displays audited %s-multifile explanations without a curated walkthrough', multipleFiles => {
    const fix = fixture(multipleFiles), { record, process, generated } = archive(fix);
    expect(process.walkthrough).toBeUndefined();
    expect(generated.explanations).toHaveLength(1);
    expect(generated.explanations[0].sections.map(section => section.file)).toEqual(multipleFiles ? ['Lib.lean', 'Submission.lean'] : ['Submission.lean']);
    expect(JSON.stringify(generated)).not.toContain('/home/fixture'); expect(JSON.stringify(generated)).not.toContain('private-profile');
    const reading = readingProcess(record)!;
    expect(reading.explanations).toEqual(generated.explanations);
    expect(proofSolutionMode(record, reading)).toBe('derivation');
    const page = renderProofSolution(record, reading, 'zh');
    expect(page).toContain('data-proof-generated="target"'); expect(page).toContain('Explain target.');
    expect(page).toContain('Submission.lean:');
    if (multipleFiles) { expect(page).toContain('Lib.lean:'); expect(page).toContain('Explain lib_fact.'); }
    // Switching UI language reads the existing audited language rather than hiding it.
    expect(selectedGeneratedExplanations(record, reading, 'en')).toHaveLength(1);
  });

  it('rejects a different accepted run, commit, target or imported source', () => {
    const fix = fixture(true);
    expect(() => importCampaignExplanations({ ...fix.result, runId: 'other' }, fix.binding)).toThrow('accepted proof');
    expect(() => importCampaignExplanations({ ...fix.result, solution_commit: 'b'.repeat(40) }, fix.binding)).toThrow('accepted proof');
    expect(() => importCampaignExplanations(fix.result, { ...fix.binding, targets: [] })).toThrow('accepted proof');
    expect(() => importCampaignExplanations(fix.result, { ...fix.binding,
      sources: new Map(fix.binding.sources).set('Lib.lean', 'theorem lib_fact : False := by sorry\n') })).toThrow('accepted proof');
  });

  it('rejects altered audited artifacts and omits incomplete targets', () => {
    const fix = fixture(false);
    expect(importCampaignExplanations({ ...fix.result, explanations: { targets: [{ ...fix.result.explanations.targets[0], status: 'error' }] } }, fix.binding).explanations).toEqual([]);
    fs.chmodSync(path.join(fix.artifact, 'proof.md'), 0o600);
    fs.appendFileSync(path.join(fix.artifact, 'proof.md'), '\nAltered');
    expect(() => importCampaignExplanations(fix.result, fix.binding)).toThrow('informalization_artifact_changed');
  });

  it('does not display generated prose after its source binding changes', () => {
    const { record, process } = archive(fixture(true));
    process.explanations![0].sources[0].sha256 = 'f'.repeat(64);
    expect(selectedGeneratedExplanations(record, process, 'zh')).toEqual([]);
    expect(proofSolutionMode(record, process)).toBe('source');
  });

  it('keeps a new generated reading when an older curated reading names another accepted proof', () => {
    const { record, process } = archive(fixture(false));
    const known = proofWalkthroughs[0];
    expect(withProofWalkthrough({ id: known.recordId, campaign: record.campaign }, process)).toBe(process);
    expect(process.walkthrough).toBeUndefined();
  });
});
