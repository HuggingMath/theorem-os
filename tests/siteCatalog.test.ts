import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSiteCatalog } from '../docs/web/catalog';

const directories: string[] = [];
const revision = 'a'.repeat(40);
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-site-'));
  directories.push(root);
  const write = (file: string, value: string | object) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const proof = 'theorem example : True := by trivial\n';
  const challenge = 'theorem research : True := by sorry\n';
  const runId = '145b477c-2f3c-43e2-94d1-f0de28bc6015';
  const accepted = [{
    problem_id: 'example', directory: 'example', statement_revision: 1, model: 'Original project + original model',
    status: 'official_accepted', submission_url: 'https://example.com/submission',
    result_url: 'https://example.com/result', result_reported_at: '2026-10-14T00:00:00Z',
    result_body: 'pass', original_source_url: 'https://example.com/original', original_source_commit: 'b'.repeat(40),
    source_sha256: { 'Submission.lean': sha256(proof) },
  }];
  write('accepted/accepted.json', accepted);
  write('accepted/example/Submission.lean', proof);
  write('in-progress/snapshot.json', {
    schema: 'lean-eval.in-progress-snapshot.v1', status: 'in_progress_not_officially_accepted',
    captureFinishedAt: '2026-10-15T01:00:00Z',
    problems: [{ problemId: 'research', directory: 'research', runId, phase: 'checking', turns: 2, workers: 4 }],
  });
  write('in-progress/research/manifest.json', {
    problemId: 'research', runId, status: 'in_progress_not_officially_accepted', capturedAt: '2026-10-15T00:00:00Z',
    model: 'research model', projectRelative: 'generated/research', taskStatuses: { completed: 3, blocked: 1 },
    files: [{ file: 'workers/solver/generated/research/Challenge.lean', sha256: sha256(challenge) }],
    internalNote: 'synthetic-private-fixture-marker',
  });
  write('in-progress/research/workers/solver/generated/research/Challenge.lean', challenge);
  write('in-progress/research/state.json', { kernel_verified: true, internalNote: 'synthetic-private-fixture-marker' });
  return { root, write, accepted };
}

function submittedFixture() {
  const data = fixture();
  const ids = ['annals_improved_bounds_sunflower_lemma', 'annals_lorentzian_polynomials',
    'annals_optimal_moebius', 'annals_algebraic_integers'];
  const submissionUrl = 'https://example.com/submission/four-proofs';
  const submitted = ids.map(id => {
    const proof = `theorem ${id} : True := by trivial\n`;
    const files = { 'Submission.lean': { sha256: sha256(proof), bytes: Buffer.byteLength(proof) } };
    const local = JSON.stringify({
      schema: 'theoremos.lean-eval-submission-provenance.v1',
      problem: {
        problemId: id, solverCommit: 'c'.repeat(40), files,
        localOfficialReceipt: { problemId: id, proofHash: sha256(proof), receiptId: `official-${id}`,
          status: 'official_verified', verifier: 'official-comparator', exitCode: 0, timedOut: false },
      },
    });
    data.write(`submitted/${id}/Submission.lean`, proof);
    data.write(`submitted/${id}/verification.json`, local);
    return {
      problem_id: id, directory: id, statement_revision: 1, model: 'Original project + continuation model',
      status: 'local_verified_pending_official', submission_url: submissionUrl,
      original_source_url: `https://example.com/original/${id}`, original_source_commit: 'b'.repeat(40),
      source_sha256: { 'Submission.lean': sha256(proof), 'verification.json': sha256(local) },
    };
  });
  const manifest = JSON.stringify(submitted);
  data.write('submitted/submitted.json', manifest);
  const result = {
    schema: 'theoremos.lean-eval-official-results.v1', submission_manifest_sha256: sha256(manifest),
    submission_url: submissionUrl, result_url: `${submissionUrl}#official-result`,
    result_reported_at: '2026-10-16T19:07:41Z', result_author: 'github-actions[bot]',
    result_body: ids.map(id => `- ${id}: pass`).join('\n'),
    problems: ids.map(problem_id => ({ problem_id, statement_revision: 1, status: 'official_accepted' })),
  };
  data.write('submitted/official-results.json', result);
  return { ...data, submitted, result };
}

describe('GitHub Pages archive catalog', () => {
  it('preserves provenance and keeps completed research tasks separate from official acceptance', () => {
    const { root } = fixture();
    const catalog = buildSiteCatalog(root, revision);
    const accepted = catalog.records.find(record => record.id === 'example')!;
    const research = catalog.records.find(record => record.id === 'research')!;
    expect(accepted.model).toBe('Original project + original model');
    expect(accepted.official?.resultUrl).toBe('https://example.com/result');
    expect(accepted.local).toBeUndefined();
    expect(accepted.sources[0].url).toBe('https://github.com/HuggingMath/TheoremOS/blob/main/accepted/example/Submission.lean');
    expect(research).toMatchObject({
      status: 'in_progress_not_officially_accepted', snapshot: { taskStatuses: { completed: 3 } },
    });
    expect(research.official).toBeUndefined();
    expect(research.local).toBeUndefined();
    expect(JSON.stringify(catalog)).not.toContain('synthetic-private-fixture-marker');
  });

  it('rejects altered accepted sources instead of presenting stale verification evidence', () => {
    const { root, write } = fixture();
    write('accepted/example/Submission.lean', 'theorem example : False := by sorry\n');
    expect(() => buildSiteCatalog(root, revision)).toThrow('Archive checksum mismatch: accepted/example/Submission.lean');
  });

  it('labels a local check of a different projection without changing the official result', () => {
    const { root, write, accepted } = fixture();
    const local = JSON.stringify({
      problem_id: 'example', source_proof_commit: 'c'.repeat(40),
      source_sha256: { 'Submission.lean': 'd'.repeat(64) },
      local_evaluation: { status: 'evaluated_passed', kernel_verified: true, official_comparator: 'official_verified' },
    });
    write('accepted/example/verification.json', local);
    write('accepted/accepted.json', [{ ...accepted[0], source_sha256: {
      ...accepted[0].source_sha256, 'verification.json': sha256(local),
    } }]);
    const record = buildSiteCatalog(root, revision).records.find(item => item.id === 'example')!;
    expect(record.status).toBe('official_accepted');
    expect(record.local).toMatchObject({ sourceBinding: 'differs', sourceProofCommit: 'c'.repeat(40) });
    expect(record.sources[0].sha256).toBe(accepted[0].source_sha256['Submission.lean']);
  });

  it.each(['published_evidence', 'submission_provenance'])('reads %s without changing its proof binding', format => {
    const { root, write, accepted } = fixture();
    const files = { 'Submission.lean': { sha256: accepted[0].source_sha256['Submission.lean'], bytes: 35 } };
    const receipt = {
      problemId: 'example', proofHash: files['Submission.lean'].sha256, receiptId: 'official-example',
      status: 'official_verified', verifier: 'official-comparator', exitCode: 0, timedOut: false,
    };
    const evidence = format === 'published_evidence' ? {
      schema: 'theorem-os.leaneval.submission-evidence.v1', problem_id: 'example',
      candidate_commit: 'c'.repeat(40), files, kernel_acceptance: ['nanoda', 'Lean default kernel'],
      local_official_comparator: receipt,
    } : {
      schema: 'theoremos.lean-eval-submission-provenance.v1',
      problem: { problemId: 'example', solverCommit: 'c'.repeat(40), files, localOfficialReceipt: receipt },
    };
    const save = () => {
      const json = JSON.stringify(evidence);
      write('accepted/example/verification.json', json);
      write('accepted/accepted.json', [{ ...accepted[0], source_sha256: {
        ...accepted[0].source_sha256, 'verification.json': sha256(json),
      } }]);
    };
    save();
    const local = () => buildSiteCatalog(root, revision).records.find(item => item.id === 'example')!.local;
    expect(local()).toMatchObject({
      status: 'official_verified', kernelVerified: true, comparator: 'official_verified',
      sourceProofCommit: 'c'.repeat(40), sourceBinding: 'matches',
    });
    expect(fs.readFileSync(path.join(root, 'accepted/example/verification.json'), 'utf8')).toBe(JSON.stringify(evidence));
    receipt.exitCode = 1;
    save();
    expect(local()?.kernelVerified).toBe(false);
    if (format === 'submission_provenance') {
      receipt.proofHash = 'd'.repeat(64);
      save();
      expect(() => local()).toThrow('Local receipt does not match the published problem and proof');
    }
  });

  it('shows the accepted proof while retaining its earlier research snapshot', () => {
    const { root, write, accepted } = fixture();
    const proof = 'theorem research : True := by trivial\n';
    write('accepted/research/Submission.lean', proof);
    write('accepted/accepted.json', [...accepted, {
      ...accepted[0], problem_id: 'research', directory: 'research', source_sha256: { 'Submission.lean': sha256(proof) },
    }]);
    const records = buildSiteCatalog(root, revision).records;
    expect(records.filter(record => record.id === 'research')).toHaveLength(1);
    expect(records.find(record => record.id === 'research')).toMatchObject({ status: 'official_accepted' });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'in-progress/snapshot.json'), 'utf8')).problems).toHaveLength(1);
  });

  it('rejects a changed research source against its snapshot manifest', () => {
    const { root, write } = fixture();
    write('in-progress/research/workers/solver/generated/research/Challenge.lean', 'changed');
    expect(() => buildSiteCatalog(root, revision)).toThrow('Archive checksum mismatch: in-progress/research/');
  });

  it('rejects unsupported acceptance status and mismatched problem identity', () => {
    const { root, write, accepted } = fixture();
    write('accepted/accepted.json', [{ ...accepted[0], status: 'kernel_verified' }]);
    expect(() => buildSiteCatalog(root, revision)).toThrow();
    write('accepted/accepted.json', [{ ...accepted[0], directory: 'different_problem' }]);
    expect(() => buildSiteCatalog(root, revision)).toThrow('Archive identity mismatch');
  });

  it('includes four independently accepted submitted packages with their original paths and evidence', () => {
    const { root, submitted, result } = submittedFixture();
    const files = ['submitted/submitted.json', ...submitted.flatMap(entry =>
      Object.keys(entry.source_sha256).map(file => `submitted/${entry.directory}/${file}`))];
    const before = files.map(file => fs.readFileSync(path.join(root, file)));
    const records = buildSiteCatalog(root, revision).records;
    expect(records.filter(record => record.status === 'official_accepted')).toHaveLength(5);
    for (const entry of submitted) {
      const record = records.find(record => record.id === entry.problem_id)!;
      expect(record).toMatchObject({
        status: 'official_accepted', model: entry.model, updatedAt: result.result_reported_at,
        archiveUrl: `https://github.com/HuggingMath/TheoremOS/tree/main/submitted/${entry.directory}`,
        official: { statementRevision: 1, resultUrl: result.result_url, resultBody: result.result_body,
          sourceCommit: entry.original_source_commit, checksums: entry.source_sha256 },
        local: { kernelVerified: true, sourceBinding: 'matches', receipt: `official-${entry.problem_id}` },
      });
      expect(record.sources[0].path).toBe(`submitted/${entry.directory}/Submission.lean`);
      expect(record.en?.summary).not.toBe('A Lean-Eval proof archive.');
    }
    files.forEach((file, index) => expect(fs.readFileSync(path.join(root, file))).toEqual(before[index]));
  });

  it('does not treat local official-comparator receipts as hosted acceptance', () => {
    const { root, submitted } = submittedFixture();
    fs.rmSync(path.join(root, 'submitted/official-results.json'));
    const records = buildSiteCatalog(root, revision).records;
    expect(records.filter(record => record.status === 'official_accepted')).toHaveLength(1);
    expect(records.some(record => submitted.some(entry => entry.problem_id === record.id))).toBe(false);
  });

  it('accepts only problems explicitly named in the hosted result', () => {
    const { root, write, submitted, result } = submittedFixture();
    write('submitted/official-results.json', { ...result, problems: [result.problems[0]] });
    const records = buildSiteCatalog(root, revision).records;
    expect(records.find(record => record.id === submitted[0].problem_id)?.status).toBe('official_accepted');
    expect(records.filter(record => record.status === 'official_accepted')).toHaveLength(2);
  });

  it.each(['problem_id', 'statement_revision', 'submission_url'] as const)(
    'rejects a hosted result with a different %s', field => {
      const { root, write, result } = submittedFixture();
      if (field === 'submission_url') result.submission_url = 'https://example.com/another-submission';
      else if (field === 'problem_id') result.problems[0].problem_id = 'another_problem';
      else result.problems[0].statement_revision = 2;
      write('submitted/official-results.json', result);
      expect(() => buildSiteCatalog(root, revision)).toThrow('Official result identity mismatch');
    });

  it('rejects a changed submission manifest even when the proof files are unchanged', () => {
    const { root, write, submitted } = submittedFixture();
    write('submitted/submitted.json', submitted.map(entry => ({ ...entry, statement_revision: 2 })));
    expect(() => buildSiteCatalog(root, revision)).toThrow('Archive checksum mismatch: submitted/submitted.json');
  });

  it('rejects submitted proof bytes that differ from the officially bound package', () => {
    const { root, write, submitted } = submittedFixture();
    const proofPath = `submitted/${submitted[0].directory}/Submission.lean`;
    write(proofPath, 'theorem altered : False := by sorry\n');
    expect(() => buildSiteCatalog(root, revision)).toThrow(`Archive checksum mismatch: ${proofPath}`);
  });
});
