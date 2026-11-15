import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { canonicalMathJson, mathDigest, readMathJson, writeMathJsonDurable } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { isSimpleLeanName } from '../math/leanSyntax';
import { isMathFoundationalLeanAxiom } from '../math/contracts';
import type { SolverRunState } from './archive';
import { createTaskSourceProjector, ownedSourceDigest } from './cooperativeProof';
import { checkProjectedDeclarations, type ProofCheck } from './modules/evidence';
import { assertSolverSources, commitSolverProjection, git, withSolverWorktree } from './problem';
import { captureProofReferences, type ProofReferences } from './proofReferences';
import { proofReuseEnvironment } from './proofReuse';
import { allowedKnowledgeFile, locateKnowledgeDeclaration } from './theoremKnowledge';
import type { CooperativeTask } from './tasks';

/** A research request is advisory. Only the host's stopped-writer check publishes evidence. */
export const DECLARATION_SUBMISSION_FILE = 'declaration-submission.json';
export const DECLARATION_ARTIFACTS_FILE = 'declarations.json';
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const commitHash = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const declarationSubmissionSchema = z.object({ declarations: z.array(z.object({
  file: z.string().refine(value => allowedKnowledgeFile(value) && value.endsWith('.lean')),
  name: z.string().min(1).max(1000).refine(isSimpleLeanName),
  type: z.string().trim().min(1).refine(value => Buffer.byteLength(value) <= 24000),
  description: z.string().max(8000).optional(), premises: z.array(z.string().max(8000)).max(128).optional(),
}).strict()).min(1).max(32) }).strict();
export type DeclarationSubmission = z.infer<typeof declarationSubmissionSchema>;
export type DeclarationArtifactIdentity = Pick<SolverRunState, 'runId' | 'problem' | 'environmentDigest'>;
export type DeclarationArtifact = Readonly<{
  schema: 'theorem-os.declaration-artifact.v1'; id: string; runId: string;
  problemReceiptDigest: string; environmentDigest: string;
  declaration: DeclarationSubmission['declarations'][number]; declarationHash: string; declarationDigest: string;
  proof: ProofCheck; references?: ProofReferences;
}>;
export class DeclarationArtifactCheckError extends Error {
  constructor(readonly declaration: DeclarationSubmission['declarations'][number],
    readonly verification: ProofCheck['verification']) {
    const detail = verification.results.map(result => [result.error, result.stdoutPreview, result.stderrPreview]
      .filter(Boolean).join('\n')).join('\n').slice(0, 24000);
    super(`math_declaration_artifact_check_failed:${declaration.name}:${detail || verification.status}`);
    this.name = 'DeclarationArtifactCheckError';
  }
}
type DeclarationArtifactManifest = { schema: 'theorem-os.declaration-artifacts.v1'; runId: string;
  problemReceiptDigest: string; environmentDigest: string; artifacts: DeclarationArtifact[] };

const fail = (reason: string): never => { throw new Error(`math_declaration_artifact_${reason}`); };
const artifactId = ({ id: _id, ...record }: DeclarationArtifact) => mathDigest(canonicalMathJson(record));
const fresh = new WeakMap<DeclarationArtifact, string>();
const identityOf = (state: DeclarationArtifactIdentity) => ({ runId: state.runId,
  problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest });

export function readDeclarationSubmission(worktree: string): DeclarationSubmission | undefined {
  const file = path.join(worktree, '.scratch', DECLARATION_SUBMISSION_FILE);
  if (!fs.existsSync(file)) return undefined;
  assertMathCanonicalPath(file);
  if (fs.statSync(file).size > 1024 * 1024) return fail('submission_too_large');
  return declarationSubmissionSchema.parse(readMathJson(file));
}

/** Persisted records retain provenance; they are never fresh proof acceptance. */
export function validateDeclarationArtifact(value: unknown): DeclarationArtifact {
  const object = z.object({ schema: z.literal('theorem-os.declaration-artifact.v1'), id: hash,
    runId: z.string().min(1), problemReceiptDigest: hash, environmentDigest: hash,
    declaration: declarationSubmissionSchema.shape.declarations.element, declarationHash: hash, declarationDigest: hash,
    proof: z.object({ commit: commitHash, sourceDigest: hash, passed: z.literal(true), verification: z.unknown() }).strict(),
    references: z.unknown().optional(),
  }).strict().parse(value) as DeclarationArtifact;
  if (artifactId(object) !== object.id || object.declarationDigest !== mathDigest(canonicalMathJson({
    file: object.declaration.file, name: object.declaration.name, type: object.declaration.type,
    declarationHash: object.declarationHash }))) return fail('identity_changed');
  const verification = object.proof.verification, results = verification?.results;
  if (verification?.schema !== 'deepscientist.mathematics.verification-batch/v1' || verification.status !== 'kernel_verified' ||
      !commitHash.safeParse(verification.targetCommit).success || !Array.isArray(results) || results.length !== 1)
    return fail('receipt_mismatch');
  const receipt = results[0]!;
  if (receipt.status !== 'kernel_verified' || !receipt.receiptId || receipt.targetCommit !== verification.targetCommit ||
      receipt.proofPath !== object.declaration.file || receipt.theoremName !== object.declaration.name ||
      receipt.statementHash !== object.declarationDigest || receipt.leanStatementHash !== object.declarationDigest ||
      receipt.claim !== 'statement' || receipt.sourceDeclarationHash !== object.declarationHash || receipt.cleanupError ||
      receipt.sorryCount !== 0 || receipt.admitCount !== 0 || !Array.isArray(receipt.axioms) ||
      receipt.axioms.some(axiom => !isMathFoundationalLeanAxiom(axiom))) return fail('receipt_mismatch');
  const references = object.references;
  if (references && (references.sourceCommit !== object.proof.commit || references.environmentDigest !== object.environmentDigest ||
      references.root?.file !== object.declaration.file || references.root?.name !== object.declaration.name ||
      !Array.isArray(references.statement) || !Array.isArray(references.proof) ||
      [...references.statement, ...references.proof].some(reference => !allowedKnowledgeFile(reference.file))))
    return fail('references_mismatch');
  return object;
}

export function readDeclarationArtifacts(directory: string, state: DeclarationArtifactIdentity): readonly DeclarationArtifact[] {
  const file = path.join(directory, DECLARATION_ARTIFACTS_FILE);
  if (!fs.existsSync(file)) return [];
  assertMathCanonicalPath(file);
  if (fs.statSync(file).size > 32 * 1024 * 1024) return fail('manifest_too_large');
  const manifest = readMathJson(file) as DeclarationArtifactManifest;
  if (manifest?.schema !== 'theorem-os.declaration-artifacts.v1' || !Array.isArray(manifest.artifacts) ||
      manifest.artifacts.length > 4096 || Object.entries(identityOf(state)).some(([key, expected]) =>
        manifest[key as keyof DeclarationArtifactManifest] !== expected)) return fail('manifest_identity_changed');
  return manifest.artifacts.map(value => {
    const artifact = validateDeclarationArtifact(value);
    if (Object.entries(identityOf(state)).some(([key, expected]) => artifact[key as keyof DeclarationArtifact] !== expected))
      return fail('manifest_identity_changed');
    return artifact;
  });
}

/** Only this process's unchanged independent checks may add records to a host-owned manifest. */
export function writeDeclarationArtifacts(directory: string, state: DeclarationArtifactIdentity,
  artifacts: readonly DeclarationArtifact[]): void {
  assertMathCanonicalPath(directory);
  if (isMathPathWithin(state.problem.workspace, directory)) return fail('manifest_inside_source_workspace');
  const records = new Map(readDeclarationArtifacts(directory, state).map(artifact => [artifact.id, artifact]));
  for (const artifact of artifacts) {
    validateDeclarationArtifact(artifact);
    if (fresh.get(artifact) !== artifact.id || Object.entries(identityOf(state)).some(([key, expected]) =>
      artifact[key as keyof DeclarationArtifact] !== expected)) return fail('fresh_check_required');
    records.set(artifact.id, artifact);
  }
  writeMathJsonDurable(path.join(directory, DECLARATION_ARTIFACTS_FILE), {
    schema: 'theorem-os.declaration-artifacts.v1', ...identityOf(state), artifacts: [...records.values()],
  } satisfies DeclarationArtifactManifest);
}

/** The caller must hold its writer-stop guarantee until this operation and persistence finish. */
export async function checkDeclarationArtifacts(input: {
  state: DeclarationArtifactIdentity; worktree: string; commit: string;
  declarations: DeclarationSubmission['declarations']; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs?: number;
  assertWriterStopped: () => void;
}): Promise<readonly DeclarationArtifact[]> {
  const declarations = declarationSubmissionSchema.parse({ declarations: input.declarations }).declarations;
  const { state, worktree, commit, signal } = input, { problem } = state;
  commitHash.parse(commit);
  const identity = canonicalMathJson(identityOf(state));
  const stable = () => {
    signal.throwIfAborted(); input.assertWriterStopped(); assertSolverSources(problem, worktree);
    if (canonicalMathJson(identityOf(state)) !== identity) return fail('run_identity_changed');
    if (git(worktree, ['rev-parse', 'HEAD']) !== commit || git(worktree, ['status', '--porcelain', '--',
      ...problem.ownedFiles.map(file => path.join(problem.projectRelative, file))])) return fail('source_changed');
  };
  stable();
  if (new Set(declarations.map(item => `${item.file}\0${item.name}`)).size !== declarations.length) return fail('duplicate_declaration');
  const environment = proofReuseEnvironment(path.join(worktree, problem.projectRelative), input.env);
  const records: DeclarationArtifact[] = [];
  for (const declaration of declarations) {
    stable();
    if (!problem.ownedFiles.includes(declaration.file)) return fail('outside_ownership');
    const checked = await withSolverWorktree(worktree, commit, async checkout => {
      const source = fs.readFileSync(path.join(checkout, problem.projectRelative, declaration.file), 'utf8');
      const location = locateKnowledgeDeclaration(source, declaration.name);
      if (location.kind !== 'theorem') return fail('requires_theorem');
      const declarationHash = mathDigest(location.declarationType);
      const declarationDigest = mathDigest(canonicalMathJson({ file: declaration.file, name: declaration.name,
        type: declaration.type, declarationHash }));
      const original = problem.targets.some(target => target.proofPath === declaration.file && target.theoremName === declaration.name);
      // A transient projection request reuses source isolation, not cooperation state or scheduling.
      const task: CooperativeTask = { id: `declaration-${declarationDigest}`, kind: original ? 'goal' : 'lemma',
        objective: declaration.description || `Check ${declaration.name}`, proofPath: declaration.file,
        theoremName: declaration.name, type: declaration.type, dependsOn: [], revision: 0 };
      const project = createTaskSourceProjector(problem, checkout, commit, { compact: true });
      const sources = project(task, []);
      for (const [file, text] of sources) fs.writeFileSync(path.join(checkout, problem.projectRelative, file), text);
      const checkedCommit = commitSolverProjection(problem, checkout, `Check declaration ${declaration.name}`);
      const result = await checkProjectedDeclarations(problem, checkout, worktree, checkedCommit,
        [{ proofPath: declaration.file, theoremName: declaration.name, digest: declarationDigest,
          missingError: 'math_declaration_artifact_declaration_missing' }],
        { env: environment.env, signal, timeoutMs: input.timeoutMs ?? Infinity,
          expectedDeclarationType: declaration.type, prepareLocalDependencies: problem.kind === 'lean-eval',
          collectDeclarationReferences: true });
      if (!result.passed) throw new DeclarationArtifactCheckError(declaration, result.verification);
      const references = result.verification.results[0]?.declarationReferences;
      const record: DeclarationArtifact = { schema: 'theorem-os.declaration-artifact.v1', id: '', ...identityOf(state),
        declaration, declarationHash, declarationDigest,
        proof: { commit, sourceDigest: ownedSourceDigest(problem, worktree, commit), passed: true, verification: result.verification },
        ...(references ? { references: captureProofReferences(problem, checkout, commit,
          { file: declaration.file, name: declaration.name }, references, state.environmentDigest) } : {}) };
      return { ...record, id: artifactId(record) };
    });
    stable();
    const after = proofReuseEnvironment(path.join(worktree, problem.projectRelative), input.env);
    if (canonicalMathJson({ reusable: after.reusable, digest: after.digest, env: after.env }) !==
        canonicalMathJson({ reusable: environment.reusable, digest: environment.digest, env: environment.env })) return fail('environment_changed');
    validateDeclarationArtifact(checked);
    fresh.set(checked, checked.id); records.push(checked);
  }
  return records;
}
