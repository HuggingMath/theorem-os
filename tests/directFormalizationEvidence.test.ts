import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFormalizationEvidence, bootstrapFormalizedProblem, formalizationDigest,
  formalizationInputDigest, prepareFormalization, readFormalizationArtifact, writeFormalizationArtifact,
  type DirectFormalizationEvidence } from '../src/math/formalization';
import { defaultFormalizationWorkflow } from '../src/math/formalizationWorkflow';
import { importFirstProofFormalization, readFirstProofCatalog } from '../src/math/firstProof';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { readMathText } from '../src/math/mathRuntimeIo';
import { buildFixture, candidateFixture, fixtureStatement, syntheticElaboration } from './helpers/formalizationFixture';

// Disposable synthetic compiler/session receipts check evidence binding, not mathematics or proof acceptance.
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'direct-formalization-evidence-')));
  temporary.push(parent);
  const { manifest } = buildFixture(parent), directory = path.join(parent, 'run');
  const author = { model: 'synthetic-direct', effort: 'none', profile: '/no-provider', executable: '/no-model' };
  const input = { problemId: 'synthetic_direct', statement: fixtureStatement, environment: 'standard' as const,
    execution: 'replay' as const, ...author, reviewMode: 'direct' as const, buildManifestRef: manifest,
    maxRounds: 0, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0 };
  const request = prepareFormalization(directory, input), candidate = candidateFixture();
  const compiled = syntheticElaboration(candidate.source, request.environment,
    { detailedContext: true, semanticContext: true, structureContext: true, boundedLibraryContext: true });
  const generation = { input: { problemId: request.problemId, statement: request.statement,
    environment: request.environment, toolchain: getLeanTaskEnvironment(request.environment).toolchain, round: 1 },
  output: candidate };
  const evidence: DirectFormalizationEvidence = { schema: 'theorem-os.formalization-evidence.v4',
    status: 'approved', authority: 'compiler', method: 'generation-and-compilation', semanticReview: 'not-performed',
    execution: 'replay', modelInvoked: false, proofVerified: false,
    request, requestDigest: formalizationDigest(request), candidate, inputDigest: formalizationInputDigest(request, candidate), generation,
    sourceSha256: compiled.sourceSha256, targets: compiled.targets, snapshot: compiled.snapshot,
    snapshotDigest: compiled.snapshotDigest, compilation: compiled.compilation,
    sessions: [{ role: 'generate', threadId: 'synthetic-direct-generator', turnId: 'synthetic-turn', status: 'completed',
      inputDigest: formalizationDigest(generation.input), outputDigest: formalizationDigest(generation.output),
      model: request.model, effort: request.effort, usage: { totalTokens: 0 } }],
    approvedAt: '2026-11-09T00:00:00Z', round: 1 };
  return { parent, directory, input, author, evidence };
}

describe('direct generation and compilation evidence', () => {
  it('round-trips a compiler-checked artifact and preserves the original in its proof task without claiming review', () => {
    const f = fixture();
    expect(() => assertFormalizationEvidence(f.evidence)).not.toThrow();
    const artifact = writeFormalizationArtifact(f.directory, f.evidence), restored = readFormalizationArtifact(artifact);
    expect(restored).toEqual(f.evidence);
    for (const key of ['translation', 'translationDigest', 'review', 'workflow']) expect(restored).not.toHaveProperty(key);
    expect(restored).toMatchObject({ authority: 'compiler', semanticReview: 'not-performed', proofVerified: false });
    const seed = bootstrapFormalizedProblem(f.directory), task = readMathText(seed.taskFile);
    expect(task).toContain('No independent semantic review was performed.');
    expect(task).toContain('Original problem (verbatim):\n\n' + fixtureStatement);
    expect(task).not.toContain('Statement review authority: model.');
    expect(bootstrapFormalizedProblem(f.directory)).toEqual(seed);
  });

  it.each(['workflow', 'fidelityPolicy'] as const)('rejects direct requests with %s instead of silently adding review stages', field => {
    const f = fixture(), configuration = field === 'workflow' ? { workflow: defaultFormalizationWorkflow(f.author) }
      : { fidelityPolicy: 'task-preserving-v2' as const };
    expect(() => prepareFormalization(path.join(f.parent, 'invalid'), { ...f.input, ...configuration }))
      .toThrow('formalization_direct_review_configuration_invalid');
  });

  it.each(['session', 'generation', 'compilation', 'snapshot', 'request-mode'] as const)(
    'rejects changed %s evidence even when the outer JSON remains valid', field => {
      const e = structuredClone(fixture().evidence);
      if (field === 'session') e.sessions[0].outputDigest = '0'.repeat(64);
      if (field === 'generation') {
        e.generation.input.statement = 'A different complete task.';
        e.sessions[0].inputDigest = formalizationDigest(e.generation.input);
      }
      if (field === 'compilation') {
        const records = e.compilation.diagnostics.artifactRecords as { digest: string; text: string }[];
        records[0].text += ' ';
      }
      if (field === 'snapshot') {
        e.snapshot.targets[0].context.type = 'False'; e.snapshotDigest = formalizationDigest(e.snapshot);
      }
      if (field === 'request-mode') {
        delete e.request.reviewMode; e.requestDigest = formalizationDigest(e.request);
        e.inputDigest = formalizationInputDigest(e.request, e.candidate);
      }
      expect(() => assertFormalizationEvidence(e)).toThrow();
    });

  it('does not admit reviewer records or invented model approval into direct compiler evidence', () => {
    const { evidence } = fixture();
    expect(() => assertFormalizationEvidence({ ...evidence, review: { verdict: 'approved' } } as never)).toThrow();
    expect(() => assertFormalizationEvidence({ ...evidence, authority: 'model' } as never)).toThrow();
    expect(() => assertFormalizationEvidence({ ...evidence,
      sessions: [{ ...evidence.sessions[0], role: 'compare' }] } as never)).toThrow('formalization_evidence_session_mismatch');
  });

  it('keeps independently reviewed First Proof admission distinct from compiler-only artifacts', () => {
    const f = fixture(), artifact = writeFormalizationArtifact(f.directory, f.evidence);
    const sourceRoot = path.resolve(import.meta.dirname, '../examples/first-proof/batch3');
    const problem = readFirstProofCatalog(sourceRoot).problems[0]!;
    expect(() => importFirstProofFormalization(artifact, path.join(f.parent, 'first-proof'), problem))
      .toThrow('first_proof_formalization_independent_review_required');
    expect(fs.existsSync(path.join(f.parent, 'first-proof'))).toBe(false);
  });
});
