import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { bootstrapLeanTask, LEAN_TASK_SOURCE_MAX_BYTES, type LeanTaskReceipt } from './leanTask';
import { getLeanTaskEnvironment } from './leanTaskEnvironment';
import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from './leanSource';
import { isSimpleLeanName, maskLeanCommentsAndStrings } from './leanSyntax';
import { canonicalMathJson, mathDigest, readMathFile, writeMathFrozen } from './mathRuntimeIo';
import { assertMathCanonicalPath } from './paths';
import { assertFormalizationEvidence, formalizationDigest, formalizationEvidenceSchema,
  readFormalizationArtifact, type FormalizationEvidence } from './formalization';

export const FIRST_PROOF_REPOSITORY_URL = 'https://github.com/1stproof/batch-3';
export const FIRST_PROOF_SOURCE_COMMIT = '5908aab1a1067d0e858294950537d0c471d7bb7f';
export const FIRST_PROOF_BATCH = 3;
export const FIRST_PROOF_AUTOMATIC_EVIDENCE_FILE = 'automatic-evidence.json';
export const FIRST_PROOF_GIT_BLOBS = Object.freeze([
  '5d5fcae894c590d61a1535a5aa09e712a405744e',
  '376f166475702c5289c7720891957714cd365556',
  '340cd005c560e295df4c00792415aa7c1cb32b7e',
  'ff88985dd0bc6ad2edfbbe6a7f6bb85b7d55eef5',
  '30d8cd8a5abdb234b21acde0c3cfe7172b0d8b7a',
  '189894d34ad105cf88d970a914a1f56bf72905ab',
  '5eae0361475c3abac81f001afe567e1cb893bd5e',
  'a1e75c5b6d6664614951b5382a56eadafecb3aa9',
  'ab398f192fdbd6ff2e86ab04b07ed2ec48781681',
  '0fd5a3b3265f9eadf8d6ecf2e22d90f77485e363',
]);
const numberText = (number: number) => String(number).padStart(2, '0');
export const FIRST_PROOF_PROBLEM_IDS = Object.freeze(FIRST_PROOF_GIT_BLOBS.map((_, index) =>
  `first_proof_batch3_${numberText(index + 1)}`));
const sourcePath = (number: number) => `batch-3-problems/problem-${numberText(number)}/problem.tex`;
const blobOid = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const maxOriginalBytes = 256 * 1024;

export type FirstProofProblem = Readonly<{
  id: string; number: number; sourceRelativePath: string; sourceSha256: string; gitBlobOid: string;
  sourceUrl: string; source: string;
}>;
export type FirstProofCatalog = Readonly<{
  schema: 'theorem-os.first-proof.catalog.v1'; batch: number; repositoryUrl: string; sourceCommit: string;
  digest: string; problems: FirstProofProblem[];
}>;

function readText(file: string, limit: number): { bytes: Buffer; text: string } {
  assertMathCanonicalPath(file);
  const bytes = readMathFile(file, limit).bytes;
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('first_proof_source_encoding_invalid');
  return { bytes, text };
}

function assertProblem(problem: FirstProofProblem): void {
  const index = FIRST_PROOF_PROBLEM_IDS.indexOf(problem.id);
  if (index < 0 || problem.number !== index + 1 || problem.sourceRelativePath !== sourcePath(index + 1) ||
      problem.gitBlobOid !== FIRST_PROOF_GIT_BLOBS[index] ||
      problem.sourceUrl !== `${FIRST_PROOF_REPOSITORY_URL}/blob/${FIRST_PROOF_SOURCE_COMMIT}/${sourcePath(index + 1)}`)
    throw new Error('first_proof_problem_identity_mismatch');
  const bytes = Buffer.from(problem.source, 'utf8');
  if (bytes.length > maxOriginalBytes || blobOid(bytes) !== problem.gitBlobOid || mathDigest(bytes) !== problem.sourceSha256)
    throw new Error('first_proof_problem_identity_mismatch');
}

/** Read exactly the ten pinned problem blobs; no solution or surrounding repository files are inputs. */
export function readFirstProofCatalog(sourceRoot: string): FirstProofCatalog {
  sourceRoot = path.resolve(sourceRoot);
  assertMathCanonicalPath(sourceRoot);
  const problems = FIRST_PROOF_GIT_BLOBS.map((oid, index): FirstProofProblem => {
    const number = index + 1, relative = sourcePath(number);
    const { bytes, text } = readText(path.join(sourceRoot, relative), maxOriginalBytes);
    if (blobOid(bytes) !== oid) throw new Error(`first_proof_blob_identity_mismatch:${FIRST_PROOF_PROBLEM_IDS[index]}`);
    return { id: FIRST_PROOF_PROBLEM_IDS[index], number, sourceRelativePath: relative, sourceSha256: mathDigest(bytes),
      gitBlobOid: oid, sourceUrl: `${FIRST_PROOF_REPOSITORY_URL}/blob/${FIRST_PROOF_SOURCE_COMMIT}/${relative}`, source: text };
  });
  const identity = { schema: 'theorem-os.first-proof.catalog.v1' as const, batch: FIRST_PROOF_BATCH,
    repositoryUrl: FIRST_PROOF_REPOSITORY_URL, sourceCommit: FIRST_PROOF_SOURCE_COMMIT,
    problems: problems.map(({ source: _source, ...problem }) => problem) };
  return { ...identity, digest: mathDigest(canonicalMathJson(identity)), problems };
}

export function readFirstProofProblem(sourceRoot: string, problemId: string): FirstProofProblem {
  if (!FIRST_PROOF_PROBLEM_IDS.includes(problemId)) throw new Error('first_proof_problem_id_invalid');
  return readFirstProofCatalog(sourceRoot).problems.find(problem => problem.id === problemId)!;
}

const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const text = z.string().min(1).max(32_000).refine(value => value.trim().length > 0);
const targetSchema = z.object({ name: z.string().refine(isSimpleLeanName), declarationHash: hash }).strict();
const reviewSchema = z.object({
  authority: z.enum(['human', 'model']), reviewer: text, reviewedAt: z.string().datetime({ offset: true }),
  verdict: z.enum(['approved', 'changes_requested']), inputDigest: hash, summary: text,
}).strict();
export const firstProofFormalizationManifestSchema = z.object({
  schema: z.literal('theorem-os.first-proof.formalization.v1'),
  problemId: z.string().refine(value => FIRST_PROOF_PROBLEM_IDS.includes(value)),
  problemSourceSha256: hash, sourceSha256: hash,
  environment: z.enum(['standard', 'mathlib']), environmentDigest: hash,
  targets: z.array(targetSchema).min(1).max(256),
  coverage: z.array(z.object({ originalText: text, targetNames: z.array(z.string().refine(isSimpleLeanName)).min(1),
    explanation: text }).strict()).min(1).max(256),
  assumptions: z.array(text).max(256), assumptionsExplanation: text, definitionsExplanation: text,
  automation: z.object({ schema: z.literal('theorem-os.first-proof.automation.v1'), evidenceDigest: hash }).strict().optional(),
  status: z.enum(['unreviewed', 'changes_requested', 'approved']),
  review: reviewSchema.optional(), reviewDigest: hash.optional(),
}).strict();
export type FirstProofFormalizationManifest = z.infer<typeof firstProofFormalizationManifestSchema>;
export type FirstProofFormalization = Readonly<{
  status: 'missing'; problemId: string; directory: string; missingFiles: string[];
}> | Readonly<{
  status: FirstProofFormalizationManifest['status']; problemId: string; directory: string;
  manifest: FirstProofFormalizationManifest; source: string; sourceSha256: string;
  inputDigest: string; digest: string; theoremNames: string[];
}>;

/** This digest describes review inputs. Computing it never supplies a review or approves a formalization. */
export function firstProofFormalizationInputDigest(manifest: FirstProofFormalizationManifest): string {
  const { status: _status, review: _review, reviewDigest: _reviewDigest, ...input } = manifest;
  return mathDigest(canonicalMathJson(input));
}

const keywords = (words: string) => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_'])(?:${words})(?![\\p{L}\\p{M}\\p{N}_'])`, 'gu');

/** Conservative seed admission, not Lean elaboration or a mathematical fidelity assessment. */
export function firstProofFormalizationTargets(source: string): { name: string; declarationHash: string }[] {
  if (!source || Buffer.byteLength(source, 'utf8') > LEAN_TASK_SOURCE_MAX_BYTES ||
      Buffer.from(source, 'utf8').toString('utf8') !== source || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(source))
    throw new Error('first_proof_formalization_source_invalid');
  const cleaned = maskLeanCommentsAndStrings(source);
  if (keywords('axiom|constant|sorryAx|unsafe|initialize|builtin_initialize|macro|elab|syntax|example|opaque|set_option').test(cleaned) || cleaned.includes('#'))
    throw new Error('first_proof_formalization_unsupported_declaration');
  const declarations = inspectScopedLeanDeclarations(source), targets = declarations.filter(item => item.kind === 'theorem');
  if (!targets.length || declarations.length > 256) throw new Error('first_proof_formalization_targets_missing');
  const names = declarations.map(item => item.name.split('.').at(-1));
  if (new Set(names).size !== names.length || declarations.some(item => !isSimpleLeanName(item.qualifiedName)))
    throw new Error('first_proof_formalization_declarations_ambiguous');
  const offsets = new Set(targets.map(item => item.startOffset));
  const targetKeywords = [...cleaned.matchAll(keywords('theorem|lemma'))];
  if (targetKeywords.length !== targets.length || targetKeywords.some(item => !offsets.has(item.index)))
    throw new Error('first_proof_formalization_unsupported_declaration');
  const regions = inspectLeanDeclarationRegions(source).filter(item => offsets.has(item.startOffset));
  for (const hole of [...cleaned.matchAll(keywords('sorry|admit')),
    ...cleaned.matchAll(/(?<![\p{L}\p{M}\p{N}_'.])_(?![\p{L}\p{M}\p{N}_'.])|\?/gu)]) {
    const owner = regions.find(region => hole.index >= region.bodyOffset && hole.index < region.endOffset &&
      /^\s*by\b/u.test(cleaned.slice(region.bodyOffset, region.endOffset)));
    if (!owner) throw new Error('first_proof_formalization_placeholder_outside_proof');
  }
  return targets.map(item => ({ name: item.qualifiedName, declarationHash: mathDigest(item.declarationType) }));
}

function automaticReviewers(evidence: FormalizationEvidence): string {
  return evidence.request.workflow ? evidence.request.workflow.reviewers.map(item => item.id + ' (' + item.model + ')').join(', ') : evidence.request.model;
}

function assertFirstProofAutomaticEvidence(evidence: FormalizationEvidence, problem: FirstProofProblem,
  manifest: FirstProofFormalizationManifest, source: string): void {
  assertFormalizationEvidence(evidence);
  if (evidence.execution !== 'model' || evidence.modelInvoked !== true)
    throw new Error('first_proof_formalization_model_execution_required');
  if (evidence.request.problemId !== problem.id || evidence.request.statement !== problem.source ||
      evidence.request.statementSha256 !== problem.sourceSha256)
    throw new Error('first_proof_formalization_automation_problem_mismatch');
  const candidate = evidence.candidate;
  if (candidate.source !== source || evidence.sourceSha256 !== manifest.sourceSha256 ||
      evidence.request.environment !== manifest.environment || evidence.request.environmentDigest !== manifest.environmentDigest ||
      canonicalMathJson(evidence.targets) !== canonicalMathJson(manifest.targets) ||
      canonicalMathJson(candidate.coverage) !== canonicalMathJson(manifest.coverage) ||
      canonicalMathJson(candidate.assumptions) !== canonicalMathJson(manifest.assumptions) ||
      candidate.assumptionsExplanation !== manifest.assumptionsExplanation || candidate.definitionsExplanation !== manifest.definitionsExplanation)
    throw new Error('first_proof_formalization_automation_input_mismatch');
  if (manifest.review?.authority !== 'model' || manifest.review.verdict !== 'approved' ||
      manifest.review.reviewer !== automaticReviewers(evidence) || manifest.review.reviewedAt !== evidence.approvedAt ||
      manifest.review.summary !== evidence.review.summary)
    throw new Error('first_proof_formalization_automation_review_mismatch');
}

/** Import already observed model formalization evidence; this never opens a model session or accepts a proof. */
export function importFirstProofFormalization(artifact: string, formalizationsRoot: string,
  problem: FirstProofProblem): FirstProofFormalization {
  assertProblem(problem);
  const evidence = readFormalizationArtifact(artifact);
  const { source, coverage, assumptions, assumptionsExplanation, definitionsExplanation } = evidence.candidate;
  const manifest = firstProofFormalizationManifestSchema.parse({
    schema: 'theorem-os.first-proof.formalization.v1', problemId: problem.id,
    problemSourceSha256: problem.sourceSha256, sourceSha256: mathDigest(source),
    environment: evidence.request.environment, environmentDigest: evidence.request.environmentDigest,
    targets: firstProofFormalizationTargets(source), coverage, assumptions, assumptionsExplanation, definitionsExplanation,
    automation: { schema: 'theorem-os.first-proof.automation.v1', evidenceDigest: formalizationDigest(evidence) },
    status: 'approved',
  });
  manifest.review = { authority: 'model', reviewer: automaticReviewers(evidence), reviewedAt: evidence.approvedAt,
    verdict: 'approved', inputDigest: firstProofFormalizationInputDigest(manifest), summary: evidence.review.summary };
  manifest.reviewDigest = mathDigest(canonicalMathJson(manifest.review));
  assertFirstProofAutomaticEvidence(evidence, problem, manifest, source);
  const manifestText = canonicalMathJson(manifest), evidenceText = canonicalMathJson(evidence);
  if (Buffer.byteLength(manifestText) > 1024 * 1024 || Buffer.byteLength(evidenceText) > 16_000_000)
    throw new Error('first_proof_formalization_import_too_large');
  const directory = path.resolve(formalizationsRoot, problem.id);
  assertMathCanonicalPath(directory);
  if (fs.existsSync(directory)) throw new Error('Formalization directory already exists; preserve its review history or choose a new root.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeMathFrozen(path.join(directory, 'Statement.lean'), source);
  writeMathFrozen(path.join(directory, FIRST_PROOF_AUTOMATIC_EVIDENCE_FILE), evidenceText);
  writeMathFrozen(path.join(directory, 'formalization.json'), manifestText);
  return readFirstProofFormalization(formalizationsRoot, problem);
}

/** Validate explicit human attestations or complete model evidence, without authenticating their mathematical judgment. */
export function readFirstProofFormalization(formalizationsRoot: string, problem: FirstProofProblem): FirstProofFormalization {
  assertProblem(problem);
  const directory = path.resolve(formalizationsRoot, problem.id);
  const files = ['Statement.lean', 'formalization.json'];
  for (const file of files) assertMathCanonicalPath(path.join(directory, file));
  const missingFiles = files.filter(file => !fs.existsSync(path.join(directory, file)));
  if (missingFiles.length) return { status: 'missing', problemId: problem.id, directory, missingFiles };
  const { bytes: sourceBytes, text: source } = readText(path.join(directory, 'Statement.lean'), LEAN_TASK_SOURCE_MAX_BYTES);
  const { bytes: manifestBytes, text: manifestText } = readText(path.join(directory, 'formalization.json'), 1024 * 1024);
  let manifest: FirstProofFormalizationManifest;
  try { manifest = firstProofFormalizationManifestSchema.parse(JSON.parse(manifestText)); }
  catch { throw new Error('first_proof_formalization_manifest_invalid'); }
  if (manifest.problemId !== problem.id || manifest.problemSourceSha256 !== problem.sourceSha256)
    throw new Error('first_proof_formalization_problem_mismatch');
  const sourceSha256 = mathDigest(sourceBytes);
  if (manifest.sourceSha256 !== sourceSha256) throw new Error('first_proof_formalization_source_mismatch');
  if (manifest.environmentDigest !== getLeanTaskEnvironment(manifest.environment).dependencyDigest)
    throw new Error('first_proof_formalization_environment_mismatch');
  const targets = firstProofFormalizationTargets(source);
  if (canonicalMathJson(targets) !== canonicalMathJson(manifest.targets)) throw new Error('first_proof_formalization_targets_mismatch');
  const covered = new Set<string>(), targetNames = new Set(targets.map(target => target.name));
  for (const item of manifest.coverage) {
    if (!problem.source.includes(item.originalText) || item.targetNames.some(name => !targetNames.has(name)))
      throw new Error('first_proof_formalization_coverage_invalid');
    item.targetNames.forEach(name => covered.add(name));
  }
  if (covered.size !== targetNames.size) throw new Error('first_proof_formalization_coverage_invalid');
  const inputDigest = firstProofFormalizationInputDigest(manifest);
  if (manifest.review) {
    if (manifest.review.inputDigest !== inputDigest) throw new Error('first_proof_formalization_review_input_mismatch');
    if (manifest.reviewDigest !== mathDigest(canonicalMathJson(manifest.review)))
      throw new Error('first_proof_formalization_review_digest_mismatch');
  } else if (manifest.reviewDigest) throw new Error('first_proof_formalization_review_digest_mismatch');
  if (manifest.automation) {
    const { bytes, text: evidenceText } = readText(path.join(directory, FIRST_PROOF_AUTOMATIC_EVIDENCE_FILE), 16_000_000);
    if (mathDigest(bytes) !== manifest.automation.evidenceDigest) throw new Error('first_proof_formalization_automation_digest_mismatch');
    const evidence = formalizationEvidenceSchema.parse(JSON.parse(evidenceText));
    if (canonicalMathJson(evidence) !== evidenceText) throw new Error('first_proof_formalization_automation_digest_mismatch');
    assertFirstProofAutomaticEvidence(evidence, problem, manifest, source);
  }
  if (manifest.status === 'approved' && (!manifest.review || manifest.review.verdict !== 'approved' ||
      (manifest.review.authority !== 'human' && !manifest.automation)))
    throw new Error('first_proof_formalization_human_review_required');
  return { status: manifest.status, problemId: problem.id, directory, manifest, source, sourceSha256,
    inputDigest, digest: mathDigest(manifestBytes), theoremNames: targets.map(target => target.name) };
}

/** A First Proof run starts only from an explicitly reviewed, exactly bound Lean seed. No model is called here. */
export function bootstrapFirstProofProblem(input: {
  sourceRoot: string; formalizationsRoot: string; problemId: string; workspaceRoot: string;
}): LeanTaskReceipt {
  const problem = readFirstProofProblem(input.sourceRoot, input.problemId);
  const formalization = readFirstProofFormalization(input.formalizationsRoot, problem);
  if (formalization.status === 'missing') throw new Error('first_proof_formalization_missing');
  if (formalization.status !== 'approved') throw new Error('first_proof_formalization_not_approved');
  const authority = formalization.manifest.review!.authority;
  const reviewLabel = authority === 'human' ? 'Human' : 'Model';
  return bootstrapLeanTask(input.workspaceRoot, { source: formalization.source, environment: formalization.manifest.environment,
    task: `Prove the ${authority}-reviewed Lean formalization of First Proof batch ${FIRST_PROOF_BATCH}, problem ${problem.number}.\n` +
      `Original source: ${problem.sourceUrl}\nOriginal SHA256: ${problem.sourceSha256}\n` +
      `Formalization source SHA256: ${formalization.sourceSha256}\nFormalization manifest SHA256: ${formalization.digest}\n` +
      `Formalization input SHA256: ${formalization.inputDigest}\n${reviewLabel} review SHA256: ${formalization.manifest.reviewDigest}\n` +
      'Preserve all original declarations, assumptions and definitions. Complete every original proof. ' +
      'Lean verification certifies the reviewed formalization; it is not First Proof official acceptance.' });
}
