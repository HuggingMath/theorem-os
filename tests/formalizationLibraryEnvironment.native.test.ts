import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { assertFormalizationEvidence, formalizationDigest, prepareFormalization, readFormalizationArtifact } from '../src/math/formalization';
import { LEAN_STATEMENT_CONTEXT_PROTOCOL } from '../src/math/leanStatementSemantic';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { resolveMathematicsRuntimeEnvironment } from '../src/math/mathRuntimeEnvironment';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { runFormalization } from '../src/solver/formalization';
import { checkSolverProof } from '../src/solver/modules/evidence';
import { readSolverProblem } from '../src/solver/problem';
import { prepareWebProblem } from '../apps/web/formalizationSeed';
import { webDefaults } from '../apps/web/config';
import { buildFixture } from './helpers/formalizationFixture';

// Opt in inside the pinned worker image. This runs actual Lean; the session supplies only a fixed candidate.
describe.skipIf(process.env.THEOREMOS_TEST_FORMALIZATION_LIBRARY_LEAN !== '1')('native unified TheoremOS environment', () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
  it('compiles a bundled library type, preserves its exact source in the proof seed, and checks the proof in Lean', async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unified-environment-native-'))); roots.push(parent);
    const { root, manifest } = buildFixture(parent), directory = path.join(parent, 'formalization');
    const catalogFile = fileURLToPath(new URL('../resources/theorem-os-library/release/catalog.json', import.meta.url));
    const statement = 'Prove that the square of every Boolean cube sign is one.';
    const source = 'import Submission.Library.TheoremOS.BooleanCube.Fourier\n' +
      'theorem library_environment (b : Bool) : TheoremOS.BooleanCube.sign b ^ 2 = 1 := by sorry\n';
    const candidate = { source, assumptions: [], assumptionsExplanation: 'Every Boolean input.',
      definitionsExplanation: 'Use the fixed TheoremOS Boolean cube sign.',
      coverage: [{ originalText: statement, targetNames: ['library_environment'], explanation: 'The complete sign identity.' }] };
    const request = prepareFormalization(directory, { problemId: 'unified_environment_native', statement, environment: 'mathlib',
      execution: 'replay', model: 'preset-no-model', effort: 'high', profile: '/no-model', executable: '/no-model',
      reviewMode: 'direct', contextProtocol: LEAN_STATEMENT_CONTEXT_PROTOCOL, buildManifestRef: manifest,
      libraryCatalog: { file: catalogFile, digest: mathDigest(fs.readFileSync(catalogFile)) }, maxRounds: 1,
      maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0 });
    let calls = 0;
    const openSession = async (options: MathAgentOptions): Promise<MathAgentSession> => ({ threadId: 'preset-library-session',
      close: async () => {}, interrupt: async () => {}, run: async (_message, _id, workspace, started) => {
        calls++; started('preset-library-turn'); options.onUsage({ totalTokens: 0 });
        fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), JSON.stringify(candidate)); return 'completed';
      } });
    const result = await runFormalization(directory, root, { openSession, env: process.env });
    expect(result.status, JSON.stringify(result)).toBe('approved'); expect(calls).toBe(1);
    const evidence = readFormalizationArtifact(path.join(directory, 'artifact'));
    expect(() => assertFormalizationEvidence(evidence)).not.toThrow();
    expect(evidence.request.library).toEqual(request.library);
    const pack = evidence.compilation.diagnostics.libraryPack as { modules: { file: string; source: string }[] };
    expect(pack.modules).toHaveLength(1);
    expect(pack.modules[0].file).toBe('Submission/Library/TheoremOS/BooleanCube/Fourier.lean');
    const changed = structuredClone(evidence);
    (changed.compilation.diagnostics.libraryPack as typeof pack).modules[0].source += '\n-- changed\n';
    expect(() => assertFormalizationEvidence(changed)).toThrow('formalization_library_source_changed');
    const input = { ...webDefaults, apiKey: 'sk-no-provider-used', providerId: 'sub2api', source, task: statement,
      environment: 'mathlib' as const, formalizationId: request.problemId };
    const webProof = path.join(parent, 'web-proof'); fs.mkdirSync(webProof);
    const seed = prepareWebProblem(webProof, { input, formalization: evidence });
    const problem = readSolverProblem(seed.workspaceRoot, seed.activeProblemPath), library = pack.modules[0];
    const project = path.join(problem.workspace, problem.projectRelative);
    expect(fs.readFileSync(path.join(project, library.file), 'utf8')).toBe(library.source);
    expect(problem.frozenFiles?.[library.file]).toBe(mathDigest(library.source));
    expect(evidence.requestDigest).toBe(formalizationDigest(request));
    fs.writeFileSync(path.join(project, 'Submission.lean'), source.replace('by sorry', 'by exact TheoremOS.BooleanCube.sign_sq b'));
    const proof = await checkSolverProof(problem, problem.workspace, resolveMathematicsRuntimeEnvironment(process.env),
      undefined, undefined, Infinity);
    expect(proof.passed, JSON.stringify(proof.verification)).toBe(true);
    expect(proof.verification.results[0]).toMatchObject({ status: 'kernel_verified', sorryCount: 0, admitCount: 0, goalsRemaining: 0 });
    const artifacts = process.env.THEOREMOS_TEST_NATIVE_EVIDENCE;
    if (artifacts) {
      fs.mkdirSync(artifacts, { recursive: true });
      fs.writeFileSync(path.join(artifacts, 'compilation-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
      fs.writeFileSync(path.join(artifacts, 'kernel-proof.json'), JSON.stringify(proof, null, 2) + '\n');
      fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ status: 'passed', environment: request.environment,
        environmentDigest: request.environmentDigest, libraryDigest: request.library.digest, modules: pack.modules.map(module => module.file),
        sourceSha256: evidence.sourceSha256, compiledRequestDigest: evidence.requestDigest,
        proofStatus: proof.verification.results[0].status, modelInvoked: false, maxRunSeconds: 0, maxTotalTokens: 0 }, null, 2) + '\n');
    }
  }, 0);
});
