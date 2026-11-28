import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { canonicalMathJson, mathDigest, readMathJson, readMathText, writeMathJsonDurable,
  writeMathTextDurable } from '../math/mathRuntimeIo';
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
export const teamDeclarationListSchema = z.array(z.object({
  file: z.string().refine(value => allowedKnowledgeFile(value) && value.endsWith('.lean')),
  name: z.string().min(1).max(1000).refine(isSimpleLeanName),
  kind: z.literal('definition').optional(),
  type: z.string().trim().min(1).refine(value => Buffer.byteLength(value) <= 24000),
  description: z.string().max(8000).optional(), premises: z.array(z.string().max(8000)).max(128).optional(),
}).strict()).min(1);
export const declarationSubmissionSchema = z.object({ declarations: teamDeclarationListSchema.max(32) }).strict();
const teamDeclarationSubmissionSchema = z.object({ declarations: teamDeclarationListSchema }).strict();
export type DeclarationSubmission = z.infer<typeof declarationSubmissionSchema>;
export type DeclarationArtifactIdentity = Pick<SolverRunState, 'runId' | 'problem' | 'environmentDigest'>;
export type DeclarationArtifact = Readonly<{
  schema: 'theorem-os.declaration-artifact.v1'; id: string; runId: string;
  problemReceiptDigest: string; environmentDigest: string;
  declaration: DeclarationSubmission['declarations'][number]; declarationHash: string; declarationDigest: string;
  proof: ProofCheck; references?: ProofReferences;
}>;
/** An advisory request the researcher can correct; infrastructure failures retain their original error. */
export class DeclarationSubmissionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'DeclarationSubmissionError';
  }
}
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
const manifestBytes = 32 * 1024 * 1024, manifestRecords = 4096;
const segmentDirectory = 'declarations.d';
const manifestIdentity = { runId: z.string().min(1), problemReceiptDigest: hash, environmentDigest: hash };
const segmentedManifestSchema = z.object({ schema: z.literal('theorem-os.declaration-artifacts.v2'),
  ...manifestIdentity, head: hash, count: z.number().int().positive().safe() }).strict();
const segmentSchema = z.object({ schema: z.literal('theorem-os.declaration-artifacts.segment.v1'),
  ...manifestIdentity, previous: hash.nullable(), artifacts: z.array(z.unknown()).min(1).max(manifestRecords) }).strict();

const emptyDeclarationSubmission = z.object({ declarations: z.tuple([]) }).strict();
const fail = (reason: string): never => { throw new Error(`math_declaration_artifact_${reason}`); };
function declarationIdentity({ file, name, type, kind }: DeclarationSubmission['declarations'][number], declarationHash: string) {
  return mathDigest(canonicalMathJson({ file, name, type, ...(kind && { kind }), declarationHash }));
}
const artifactId = ({ id: _id, ...record }: DeclarationArtifact) => mathDigest(canonicalMathJson(record));
const fresh = new WeakMap<DeclarationArtifact, string>();
const identityOf = (state: DeclarationArtifactIdentity) => ({ runId: state.runId,
  problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest });
const sameIdentity = (value: Partial<Record<keyof ReturnType<typeof identityOf>, unknown>>,
  state: DeclarationArtifactIdentity) => Object.entries(identityOf(state)).every(([key, expected]) =>
    value[key as keyof ReturnType<typeof identityOf>] === expected);
const submissionFail = (reason: string): never => { throw new DeclarationSubmissionError(`math_declaration_artifact_${reason}`); };
function parseDeclarationSubmission(value: unknown, schema = declarationSubmissionSchema): DeclarationSubmission {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DeclarationSubmissionError(`math_declaration_artifact_submission_invalid:${parsed.error.message}`,
    { cause: parsed.error });
  return parsed.data;
}
function submissionContent<T>(operation: () => T, correctable: readonly string[]): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof Error && correctable.includes(error.message.split('\n')[0]!))
      throw new DeclarationSubmissionError(error.message, { cause: error });
    throw error;
  }
}

export function readDeclarationSubmission(worktree: string, options?: { allowEmpty?: boolean }): DeclarationSubmission | undefined {
  const file = path.join(worktree, '.scratch', DECLARATION_SUBMISSION_FILE);
  if (!fs.existsSync(file)) return undefined;
  assertMathCanonicalPath(file);
  if (fs.statSync(file).size > 1024 * 1024) return submissionFail('submission_too_large');
  let value: unknown;
  try { value = readMathJson(file); }
  catch (error) {
    if (error instanceof SyntaxError) throw new DeclarationSubmissionError('math_declaration_artifact_submission_invalid_json', { cause: error });
    throw error;
  }
  if (options?.allowEmpty && emptyDeclarationSubmission.safeParse(value).success) return undefined;
  return parseDeclarationSubmission(value);
}

/** Persisted records retain provenance; they are never fresh proof acceptance. */
export function validateDeclarationArtifact(value: unknown): DeclarationArtifact {
  const object = z.object({ schema: z.literal('theorem-os.declaration-artifact.v1'), id: hash,
    runId: z.string().min(1), problemReceiptDigest: hash, environmentDigest: hash,
    declaration: declarationSubmissionSchema.shape.declarations.element, declarationHash: hash, declarationDigest: hash,
    proof: z.object({ commit: commitHash, sourceDigest: hash, passed: z.literal(true), verification: z.unknown() }).strict(),
    references: z.unknown().optional(),
  }).strict().parse(value) as DeclarationArtifact;
  if (artifactId(object) !== object.id || object.declarationDigest !== declarationIdentity(object.declaration, object.declarationHash))
    return fail('identity_changed');
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

function readDeclarationArchive(directory: string, state: DeclarationArtifactIdentity, migrateLegacy = false): {
  artifacts: DeclarationArtifact[]; head?: string;
} {
  const file = path.join(directory, DECLARATION_ARTIFACTS_FILE);
  if (!fs.existsSync(file)) return { artifacts: [] };
  assertMathCanonicalPath(file);
  if (fs.statSync(file).size > manifestBytes) return fail('manifest_too_large');
  const manifest = JSON.parse(readMathText(file, manifestBytes)) as DeclarationArtifactManifest;
  const validate = (values: unknown[]) => values.map(value => {
    const artifact = validateDeclarationArtifact(value);
    if (!sameIdentity(artifact, state)) return fail('manifest_identity_changed');
    return artifact;
  });
  if (manifest?.schema === 'theorem-os.declaration-artifacts.v1') {
    // Older writers could publish a 4097th record. Only the writer may recover such an archive.
    if (!Array.isArray(manifest.artifacts) || !migrateLegacy && manifest.artifacts.length > manifestRecords ||
        !sameIdentity(manifest, state)) return fail('manifest_identity_changed');
    return { artifacts: validate(manifest.artifacts) };
  }
  const parsed = segmentedManifestSchema.safeParse(manifest);
  if (!parsed.success || !sameIdentity(parsed.data, state)) return fail('manifest_identity_changed');
  const root = parsed.data, batches: DeclarationArtifact[][] = [], seen = new Set<string>(), ids = new Set<string>();
  let current: string | null = root.head, count = 0;
  while (current) {
    if (seen.has(current)) return fail('segment_cycle');
    seen.add(current);
    const segmentFile = path.join(directory, segmentDirectory, `${current}.json`);
    assertMathCanonicalPath(segmentFile);
    if (fs.statSync(segmentFile).size > manifestBytes) return fail('segment_too_large');
    const text = readMathText(segmentFile, manifestBytes);
    if (mathDigest(text) !== current) return fail('segment_changed');
    const segment = segmentSchema.safeParse(JSON.parse(text));
    if (!segment.success || !sameIdentity(segment.data, state)) return fail('manifest_identity_changed');
    count += segment.data.artifacts.length;
    if (count > root.count) return fail('manifest_identity_changed');
    const batch = validate(segment.data.artifacts);
    for (const artifact of batch) {
      if (ids.has(artifact.id)) return fail('manifest_identity_changed');
      ids.add(artifact.id);
    }
    batches.push(batch);
    current = segment.data.previous;
  }
  if (count !== root.count) return fail('manifest_identity_changed');
  return { artifacts: batches.reverse().flat(), head: root.head };
}

/** Persisted v1 manifests and immutable v2 segments are history, never fresh proof acceptance. */
export function readDeclarationArtifacts(directory: string, state: DeclarationArtifactIdentity): readonly DeclarationArtifact[] {
  return readDeclarationArchive(directory, state).artifacts;
}

/** Segments become reachable only after the durable root replacement; interrupted writes can be retried. */
function appendDeclarationSegments(directory: string, state: DeclarationArtifactIdentity, previous: string | undefined,
  artifacts: readonly DeclarationArtifact[]): string {
  const segments = path.join(directory, segmentDirectory);
  assertMathCanonicalPath(segments);
  fs.mkdirSync(segments, { recursive: true, mode: 0o700 });
  assertMathCanonicalPath(segments);
  let head = previous ?? null, batch: DeclarationArtifact[] = [];
  const segment = () => ({ schema: 'theorem-os.declaration-artifacts.segment.v1' as const,
    ...identityOf(state), previous: head, artifacts: batch });
  let bytes = Buffer.byteLength(canonicalMathJson(segment()));
  const flush = () => {
    if (!batch.length) return;
    const text = canonicalMathJson(segment()), digest = mathDigest(text), file = path.join(segments, `${digest}.json`);
    assertMathCanonicalPath(file);
    if (fs.existsSync(file)) {
      if (readMathText(file, manifestBytes) !== text) return fail('segment_changed');
    } else writeMathTextDurable(file, text, 0o400);
    head = digest; batch = []; bytes = Buffer.byteLength(canonicalMathJson(segment()));
  };
  for (const artifact of artifacts) {
    const size = Buffer.byteLength(canonicalMathJson(artifact));
    if (batch.length >= manifestRecords || bytes + size + (batch.length ? 1 : 0) > manifestBytes) flush();
    if (bytes + size + (batch.length ? 1 : 0) > manifestBytes) return fail('record_too_large');
    bytes += size + (batch.length ? 1 : 0); batch.push(artifact);
  }
  flush();
  return head ?? fail('manifest_identity_changed');
}

/** Only this process's unchanged independent checks may add records to a host-owned manifest. */
export function writeDeclarationArtifacts(directory: string, state: DeclarationArtifactIdentity,
  artifacts: readonly DeclarationArtifact[]): void {
  assertMathCanonicalPath(directory);
  if (isMathPathWithin(state.problem.workspace, directory)) return fail('manifest_inside_source_workspace');
  const archive = readDeclarationArchive(directory, state, true);
  const records = new Map(archive.artifacts.map(artifact => [artifact.id, artifact])), added: DeclarationArtifact[] = [];
  for (const artifact of artifacts) {
    validateDeclarationArtifact(artifact);
    if (fresh.get(artifact) !== artifact.id || !sameIdentity(artifact, state)) return fail('fresh_check_required');
    if (!records.has(artifact.id)) added.push(artifact);
    records.set(artifact.id, artifact);
  }
  if (!archive.head) {
    const manifest = { schema: 'theorem-os.declaration-artifacts.v1', ...identityOf(state),
      artifacts: [...records.values()] } satisfies DeclarationArtifactManifest;
    if (records.size <= manifestRecords) {
      const text = canonicalMathJson(manifest);
      if (Buffer.byteLength(text) <= manifestBytes) {
        writeMathTextDurable(path.join(directory, DECLARATION_ARTIFACTS_FILE), text); return;
      }
    }
  } else if (!added.length) return;
  const head = appendDeclarationSegments(directory, state, archive.head, archive.head ? added : [...records.values()]);
  writeMathJsonDurable(path.join(directory, DECLARATION_ARTIFACTS_FILE), {
    schema: 'theorem-os.declaration-artifacts.v2', ...identityOf(state), head, count: records.size,
  } satisfies z.infer<typeof segmentedManifestSchema>);
}

type DeclarationCheckInput = {
  state: DeclarationArtifactIdentity; worktree: string; commit: string;
  declarations: DeclarationSubmission['declarations']; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs?: number;
};
type TeamDeclarationCheckInput = DeclarationCheckInput & {
  /** Checks writer shutdown, run identity and the exact commit of the input workspace. */
  assertFrozenSource: () => void;
  /** Only for host-selected declarations whose signature comes from independently checked source. */
  inferredExpectedTypes?: ReadonlySet<string>;
};
type StoppedDeclarationCheckInput = DeclarationCheckInput & { assertWriterStopped: () => void };
type DeclarationCheckSnapshot = { project?: ReturnType<typeof createTaskSourceProjector>; sourceDigest?: string };

export async function checkDeclarationArtifacts(input: StoppedDeclarationCheckInput): Promise<readonly DeclarationArtifact[]> {
  return createDeclarationArtifactChecker(input)(input.declarations);
}

/** Reuse source preparation for sequential checks of one stopped writer's fixed commit. */
export function createDeclarationArtifactChecker(input: Omit<StoppedDeclarationCheckInput, 'declarations'>) {
  const { state, worktree, commit, signal } = input, { problem } = state;
  const identity = canonicalMathJson(identityOf(state));
  const snapshot: DeclarationCheckSnapshot = {};
  const assertFrozenSource = () => {
    signal.throwIfAborted(); input.assertWriterStopped(); assertSolverSources(problem, worktree);
    if (canonicalMathJson(identityOf(state)) !== identity) return fail('run_identity_changed');
    if (git(worktree, ['rev-parse', 'HEAD']) !== commit || git(worktree, ['status', '--porcelain', '--',
      ...problem.ownedFiles.map(file => path.join(problem.projectRelative, file))])) return fail('source_changed');
  };
  return (declarations: DeclarationSubmission['declarations']) =>
    checkArtifacts({ ...input, declarations, assertFrozenSource }, declarationSubmissionSchema, false, snapshot);
}

/** Host deliveries can include checked peer declarations in addition to a bounded member submission. */
export async function checkTeamDeclarationArtifacts(input: TeamDeclarationCheckInput): Promise<readonly DeclarationArtifact[]> {
  return checkArtifacts(input, teamDeclarationSubmissionSchema, true);
}

async function checkArtifacts(input: TeamDeclarationCheckInput, schema: typeof declarationSubmissionSchema,
  allowAuxiliaryDefinitions: boolean, snapshot: DeclarationCheckSnapshot = {}) {
  const declarations = parseDeclarationSubmission({ declarations: input.declarations }, schema).declarations;
  const { state, worktree, commit, signal, assertFrozenSource } = input, { problem } = state;
  commitHash.parse(commit);
  assertFrozenSource();
  if (new Set(declarations.map(item => `${item.file}\0${item.name}`)).size !== declarations.length) return submissionFail('duplicate_declaration');
  const environment = proofReuseEnvironment(path.join(worktree, problem.projectRelative), input.env);
  const records: DeclarationArtifact[] = [];
  for (const declaration of declarations) {
    assertFrozenSource();
    if (!problem.ownedFiles.includes(declaration.file)) return submissionFail('outside_ownership');
    const checked = await withSolverWorktree(worktree, commit, async checkout => {
      const source = fs.readFileSync(path.join(checkout, problem.projectRelative, declaration.file), 'utf8');
      const location = submissionContent(() => locateKnowledgeDeclaration(source, declaration.name),
        ['math_knowledge_declaration_missing_or_ambiguous']);
      const definition = declaration.kind === 'definition';
      if (definition) {
        if (!allowAuxiliaryDefinitions) return submissionFail('requires_theorem');
        if (location.kind !== 'definition' || !/^(?:def|abbrev)\s/u.test(source.slice(location.startOffset, location.bodyOffset)))
          return submissionFail('requires_definition');
      } else if (location.kind !== 'theorem') return submissionFail('requires_theorem');
      const declarationHash = mathDigest(location.declarationType);
      const declarationDigest = declarationIdentity(declaration, declarationHash);
      const original = problem.targets.some(target => target.proofPath === declaration.file && target.theoremName === declaration.name);
      if (definition && original) return submissionFail('definition_must_be_auxiliary');
      // A transient projection request reuses source isolation, not cooperation state or scheduling.
      const checkHelperInDraft = input.inferredExpectedTypes?.has(declaration.file + '\0' + declaration.name) === true;
      const type = checkHelperInDraft ? undefined : declaration.type;
      const task: CooperativeTask = { id: `declaration-${declarationDigest}`, kind: original ? 'goal' : 'lemma',
        ...(definition && { declaration: 'definition' }), objective: declaration.description || `Check ${declaration.name}`, proofPath: declaration.file,
        theoremName: declaration.name, type, dependsOn: [], revision: 0 };
      let checkedCommit = commit;
      if (!checkHelperInDraft) {
        const projector = snapshot.project ??= createTaskSourceProjector(problem, worktree, commit, { compact: true });
        const sources = submissionContent(() => projector(task, []), ['math_task_type_invalid', 'math_task_missing_declaration',
          'math_task_ambiguous_declaration', 'math_task_requires_theorem', 'math_task_requires_definition', 'math_task_helper_is_original_declaration']);
        for (const [file, text] of sources) fs.writeFileSync(path.join(checkout, problem.projectRelative, file), text);
        checkedCommit = commitSolverProjection(problem, checkout, `Check declaration ${declaration.name}`);
      }
      const result = await checkProjectedDeclarations(problem, checkout, worktree, checkedCommit,
        [{ proofPath: declaration.file, theoremName: declaration.name, digest: declarationDigest,
          missingError: 'math_declaration_artifact_declaration_missing' }],
        { env: environment.env, signal, timeoutMs: input.timeoutMs ?? Infinity,
          expectedDeclarationType: type, prepareLocalDependencies: checkHelperInDraft || problem.kind === 'lean-eval',
          ...(checkHelperInDraft ? { checkDeclarationsInDraft: true } : {}),
          collectDeclarationReferences: true }).catch(error => {
        if (error instanceof Error && error.message === 'math_declaration_artifact_declaration_missing')
          throw new DeclarationSubmissionError(error.message, { cause: error });
        throw error;
      });
      if (!result.passed) throw new DeclarationArtifactCheckError(declaration, result.verification);
      const references = result.verification.results[0]?.declarationReferences;
      const record: DeclarationArtifact = { schema: 'theorem-os.declaration-artifact.v1', id: '', ...identityOf(state),
        declaration, declarationHash, declarationDigest,
        proof: { commit, sourceDigest: snapshot.sourceDigest ??= ownedSourceDigest(problem, worktree, commit),
          passed: true, verification: result.verification },
        ...(references ? { references: captureProofReferences(problem, checkout, commit,
          { file: declaration.file, name: declaration.name }, references, state.environmentDigest) } : {}) };
      return { ...record, id: artifactId(record) };
    });
    assertFrozenSource();
    const after = proofReuseEnvironment(path.join(worktree, problem.projectRelative), input.env);
    if (canonicalMathJson({ reusable: after.reusable, digest: after.digest, env: after.env }) !==
        canonicalMathJson({ reusable: environment.reusable, digest: environment.digest, env: environment.env })) return fail('environment_changed');
    validateDeclarationArtifact(checked);
    fresh.set(checked, checked.id); records.push(checked);
  }
  return records;
}
