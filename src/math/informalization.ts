import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { canonicalMathJson, mathDigest, readMathFile, readMathText, syncMathDirectory, writeMathFrozen,
  writeMathJsonDurable } from './mathRuntimeIo';
import { assertMathCanonicalPath } from './paths';
import { getLeanTaskEnvironment } from './leanTaskEnvironment';
import { isSimpleLeanName, maskLeanComments } from './leanSyntax';
import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from './leanSource';
import { formalizationDigest, readFormalizationArtifact, type FormalizationEvidence } from './formalization';
import { localModuleFile, mathLocalModuleGraph } from './mathConstructionSources';
import { isAllowedMathProofSource } from './mathProofSourcePolicy';
import { formalizationModelConfigurationSchema } from './formalizationWorkflow';
import { deriveFormalizationRoleOutputJsonSchema } from './formalizationRoleContract';
import { READABLE_MATH_NOTATION } from './readableMath';
import { incidentalLibraryName, informalizationLibraryContext, informalizationOutlineSchema,
  type InformalizationOutline, type InformalizationUnit } from './informalizationExtraction';
import { findWithin, lineEnds, placeExcerpts, sectionStepGoals, statementRegion, type StepGoalsOptions } from './informalizationAlignment';

/**
 * Proof-level informalization (lean-proof-informalization-v1): a Lean-checked proof
 * becomes a natural-language proof whose every step names the Lean declarations it
 * uses and quotes the Lean text it explains.
 *
 * The host extracts the declarations reachable from the target in dependency order
 * (informalizationExtraction). Writers explain them batch by batch; a later batch
 * cites the accepted statements of earlier ones. Host checks reject an explanation
 * that skips a declaration, cites a name its Lean terms do not use, leaves an owned
 * lemma its proof uses uncited, or quotes text that is not in its source. Fresh
 * auditors, who do not see the problem statement, then judge every statement and
 * step against the Lean source; a batch is accepted only when every auditor approves.
 * The Lean proof is the authority. The prose is model-written and model-reviewed.
 */
export const INFORMALIZATION_PROTOCOL = 'lean-proof-informalization-v1';
/** The request freezes its role instructions, including for resumed jobs. */
export const INFORMALIZATION_EXPLANATION_POLICIES = ['mathematical-steps-v1', 'mathematical-steps-v2'] as const;
export const INFORMALIZATION_EXPLANATION_POLICY = INFORMALIZATION_EXPLANATION_POLICIES[1];
/**
 * Opted into per request: the writer also gives each declaration a one-sentence summary and, in the final batch, a short
 * route that narrows the target to what the proof checks; auditors judge both against the Lean. Requests without it keep
 * their inputs, schemas, instructions and digests.
 */
export const INFORMALIZATION_OUTLINE_POLICY = 'proof-outline-v1';
/**
 * Phrase alignment, opted into per request: the writer also pairs phrases of its prose with the Lean text they translate
 * (links), the host checks each pair is verbatim on both sides and inside the Lean the statement or step explains, and
 * auditors judge the pairs and each step against the goals the page shows beside it. Requests without it keep their
 * inputs, schemas, instructions and digests. v2 differs from v1 only in those goals for a step that quotes just the head
 * of a block tactic (StepGoalsOptions); new requests use v2, and v1 evidence keeps the goals its auditors saw.
 */
export const INFORMALIZATION_ALIGNMENTS = ['lean-phrase-alignment-v1', 'lean-phrase-alignment-v2'] as const;
export const INFORMALIZATION_ALIGNMENT = INFORMALIZATION_ALIGNMENTS[1];
/** The step goals an alignment's auditors judged against; unaligned explanations get the current ones. */
export const informalizationStepGoalsOptions = (alignment: InformalizationRequest['alignment']): StepGoalsOptions =>
  ({ blockHeads: alignment !== INFORMALIZATION_ALIGNMENTS[0] });
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1).max(32_000).refine(value => value.trim().length > 0);
// Zero removes the corresponding execution limit.
const executionLimit = z.number().int().safe().nonnegative();
const leanName = z.string().min(1).max(4096).refine(value => isSimpleLeanName(value));
export const informalizationDigest = (value: unknown): string => mathDigest(canonicalMathJson(value));

const statement = z.string().min(1).max(256 * 1024).refine(value => value.trim().length > 0 &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value));
const auditorSchema = formalizationModelConfigurationSchema.extend({ id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u) }).strict();
export const informalizationRequestSchema = z.object({
  schema: z.literal('theorem-os.informalization-request.v1'), protocol: z.literal(INFORMALIZATION_PROTOCOL),
  proofId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u), target: leanName,
  environment: z.enum(['standard', 'mathlib', 'mathlib-4.8', 'openai-math',
    'openai-math-cartier-reviewed-v1', 'openai-math-character-reviewed-v1']),
  environmentDigest: hash, toolchain: text, mathlibRevision: text.nullable(),
  rootModule: leanName,
  /** Dependency first, root module last. file is the frozen harness path; origin is the path in the source project. */
  sources: z.array(z.object({ module: leanName, file: text, origin: text, sha256: hash,
    bytes: z.number().int().positive() }).strict()).min(1).max(256),
  /** Optional vocabulary context for the writer; never shown to the auditors. */
  statement: statement.nullable(), statementSha256: hash.nullable(),
  /**
   * The approved formalization the proof proves, copied to formalization/ (a formalization artifact); statement is then
   * its original problem. Absent for a proof without one.
   */
  formalization: z.object({ problemId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u), evidenceSha256: hash,
    statementSha256: hash, originalSha256: hash }).strict().optional(),
  alignment: z.enum(INFORMALIZATION_ALIGNMENTS).optional(),
  explanationPolicy: z.enum(INFORMALIZATION_EXPLANATION_POLICIES).optional(),
  outlinePolicy: z.literal(INFORMALIZATION_OUTLINE_POLICY).optional(),
  language: z.enum(['zh', 'en']),
  writer: formalizationModelConfigurationSchema,
  auditors: z.array(auditorSchema).min(1).max(5),
  batching: z.object({ maxUnits: z.number().int().min(1).max(64), maxSourceBytes: z.number().int().min(1).max(4_000_000) }).strict(),
  maxRoundsPerBatch: executionLimit, maxRunSeconds: executionLimit, maxTurnSeconds: executionLimit,
  maxCompileSeconds: executionLimit, maxTotalTokens: executionLimit,
  buildManifestRef: text, buildDigest: hash,
}).strict();
export type InformalizationRequest = z.infer<typeof informalizationRequestSchema>;
export type InformalizationSource = { module: string; file: string; text: string };

const MAX_SOURCE_BYTES = 16_000_000;
const MODULE_HEADER = /^\s*module(?=\s|$)/u;

export type InformalizationPreparation = Omit<InformalizationRequest, 'schema' | 'protocol' | 'environmentDigest' | 'toolchain' |
  'mathlibRevision' | 'rootModule' | 'sources' | 'statementSha256' | 'buildDigest' | 'formalization'> & { proofFile: string;
  projectRoot: string;
  /** A formalization artifact directory; its original problem becomes the statement, so `statement` must be null. */
  formalizationArtifact?: string };
const FORMALIZATION_FILES = ['Statement.lean', 'original.txt', 'evidence.json'] as const;

/**
 * The proof keeps every declaration of the approved statement: the same qualified name and kind, a theorem the same
 * header (the solver's acceptance check) and a definition or instance the same text. It may add declarations.
 */
export function assertInformalizationFormalizationBinding(formalization: FormalizationEvidence,
  binding: { target: string; environment: InformalizationRequest['environment']; environmentDigest: string; root: string }): void {
  if (formalization.request.environment !== binding.environment || formalization.request.environmentDigest !== binding.environmentDigest)
    throw new Error('informalization_formalization_environment_mismatch');
  if (!formalization.targets.some(item => item.name === binding.target)) throw new Error('informalization_formalization_target_missing');
  const declarations = (source: string) => {
    const masked = maskLeanComments(source), regions = inspectLeanDeclarationRegions(masked);
    return new Map(inspectScopedLeanDeclarations(masked).map((item, index) => [item.qualifiedName, { kind: item.kind,
      header: item.declarationType, text: masked.slice(item.startOffset, regions[index]!.endOffset).replace(/\s+/gu, ' ').trim() }]));
  };
  const proof = declarations(binding.root);
  for (const [name, expected] of declarations(formalization.candidate.source)) {
    const found = proof.get(name);
    if (!found || found.kind !== expected.kind || found.header !== expected.header ||
        expected.kind !== 'theorem' && found.text !== expected.text)
      throw new Error('informalization_formalization_declaration_changed: ' + name);
  }
}

/** Freeze the proof's project-local import closure; the run never reads the source project again. */
export function prepareInformalization(directory: string, input: InformalizationPreparation): InformalizationRequest {
  directory = path.resolve(directory); assertMathCanonicalPath(directory);
  if (fs.existsSync(directory)) throw new Error('informalization_directory_exists');
  const projectRoot = fs.realpathSync(input.projectRoot), proofFile = fs.realpathSync(input.proofFile);
  const relative = path.relative(projectRoot, proofFile).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('informalization_proof_outside_project');
  const graph = mathLocalModuleGraph(projectRoot, relative);
  let total = 0;
  const sources = graph.map(item => {
    const file = localModuleFile(item.module);
    if (!isSimpleLeanName(item.module) || !isAllowedMathProofSource(item.file) || !isAllowedMathProofSource(file))
      throw new Error('informalization_source_excluded: ' + item.file);
    const { bytes } = readMathFile(path.join(projectRoot, item.file), MAX_SOURCE_BYTES);
    if (mathDigest(bytes) !== item.sourceDigest) throw new Error('informalization_source_changed: ' + item.file);
    const contents = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    // A module-system file exports no proof bodies to an importing command.
    if (MODULE_HEADER.test(maskLeanComments(contents))) throw new Error('informalization_module_system_unsupported: ' + item.file);
    if ((total += bytes.length) > MAX_SOURCE_BYTES) throw new Error('informalization_sources_too_large');
    return { module: item.module, file, origin: item.file, sha256: item.sourceDigest, bytes: bytes.length, contents };
  });
  if (sources.at(-1)?.origin !== relative || new Set(sources.map(item => item.file)).size !== sources.length)
    throw new Error('informalization_source_graph_invalid');
  const environment = getLeanTaskEnvironment(input.environment);
  const manifest = path.resolve(input.buildManifestRef);
  let formalization: FormalizationEvidence | undefined, statement = input.statement;
  if (input.formalizationArtifact !== undefined) {
    if (statement !== null) throw new Error('informalization_formalization_statement_conflict');
    formalization = readFormalizationArtifact(input.formalizationArtifact);
    statement = formalization.request.statement;
    assertInformalizationFormalizationBinding(formalization, { target: input.target, environment: input.environment,
      environmentDigest: environment.dependencyDigest, root: sources.at(-1)!.contents });
  }
  const request = informalizationRequestSchema.parse({
    schema: 'theorem-os.informalization-request.v1', protocol: INFORMALIZATION_PROTOCOL,
    proofId: input.proofId, target: input.target, environment: input.environment,
    environmentDigest: environment.dependencyDigest, toolchain: environment.toolchain,
    mathlibRevision: environment.mathlibRevision ?? null, rootModule: sources.at(-1)!.module,
    sources: sources.map(({ contents: _, ...item }) => item),
    statement, statementSha256: statement === null ? null : mathDigest(statement),
    ...formalization ? { formalization: { problemId: formalization.request.problemId, evidenceSha256: formalizationDigest(formalization),
      statementSha256: formalization.sourceSha256, originalSha256: formalization.request.statementSha256 } } : {},
    ...input.alignment ? { alignment: input.alignment } : {},
    ...input.explanationPolicy ? { explanationPolicy: input.explanationPolicy } : {},
    ...input.outlinePolicy ? { outlinePolicy: input.outlinePolicy } : {},
    language: input.language, writer: input.writer, auditors: input.auditors, batching: input.batching,
    maxRoundsPerBatch: input.maxRoundsPerBatch, maxRunSeconds: input.maxRunSeconds, maxTurnSeconds: input.maxTurnSeconds,
    maxCompileSeconds: input.maxCompileSeconds, maxTotalTokens: input.maxTotalTokens,
    buildManifestRef: manifest, buildDigest: mathDigest(readMathText(manifest, 8_000_000)),
  });
  if (new Set(request.auditors.map(item => item.id)).size !== request.auditors.length)
    throw new Error('informalization_auditor_id_duplicate');
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const source of sources) {
    const file = path.join(directory, 'sources', source.file);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeMathFrozen(file, source.contents);
  }
  if (input.formalizationArtifact !== undefined) {
    // Byte copies, so the copy is read and checked exactly as the formalization wrote it.
    fs.mkdirSync(path.join(directory, 'formalization'), { mode: 0o700 });
    for (const name of FORMALIZATION_FILES) {
      const { bytes } = readMathFile(path.join(path.resolve(input.formalizationArtifact), name), 16_000_000);
      writeMathFrozen(path.join(directory, 'formalization', name), new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    }
    readFormalizationArtifact(path.join(directory, 'formalization'));
  }
  writeMathJsonDurable(path.join(directory, 'request.json'), request, 0o400);
  syncMathDirectory(directory);
  return request;
}

/** The frozen request and its sources, each checked against its recorded digest, and the formalization when it has one. */
export function readInformalizationRequest(directory: string): { request: InformalizationRequest; sources: InformalizationSource[];
  formalization?: FormalizationEvidence } {
  const file = path.join(path.resolve(directory), 'request.json'); assertMathCanonicalPath(file);
  const request = informalizationRequestSchema.parse(JSON.parse(readMathText(file, 16_000_000)));
  const environment = getLeanTaskEnvironment(request.environment);
  if (request.environmentDigest !== environment.dependencyDigest || request.toolchain !== environment.toolchain ||
      request.mathlibRevision !== (environment.mathlibRevision ?? null))
    throw new Error('informalization_environment_changed');
  if (request.statement === null ? request.statementSha256 !== null : request.statementSha256 !== mathDigest(request.statement))
    throw new Error('informalization_request_invalid');
  if (request.sources.at(-1)!.module !== request.rootModule || new Set(request.sources.map(item => item.file)).size !== request.sources.length)
    throw new Error('informalization_request_invalid');
  const sources = request.sources.map(source => {
    if (source.file !== localModuleFile(source.module) || !isAllowedMathProofSource(source.file))
      throw new Error('informalization_request_invalid');
    const sourceFile = path.join(path.resolve(directory), 'sources', source.file); assertMathCanonicalPath(sourceFile);
    const { bytes } = readMathFile(sourceFile, MAX_SOURCE_BYTES);
    if (mathDigest(bytes) !== source.sha256 || bytes.length !== source.bytes) throw new Error('informalization_source_changed: ' + source.file);
    return { module: source.module, file: source.file, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  });
  if (!request.formalization) return { request, sources };
  const formalization = readFormalizationArtifact(path.join(path.resolve(directory), 'formalization'));
  assertInformalizationFormalizationRecord(request, formalization);
  assertInformalizationFormalizationBinding(formalization, { target: request.target, environment: request.environment,
    environmentDigest: request.environmentDigest, root: sources.at(-1)!.text });
  return { request, sources, formalization };
}
/** The request's formalization record names exactly this evidence, and its statement is that evidence's original. */
export function assertInformalizationFormalizationRecord(request: Pick<InformalizationRequest, 'formalization' | 'statement' |
  'statementSha256'>, formalization: FormalizationEvidence): void {
  const record = request.formalization;
  if (!record || record.evidenceSha256 !== formalizationDigest(formalization) || record.problemId !== formalization.request.problemId ||
      record.statementSha256 !== formalization.sourceSha256 || record.originalSha256 !== formalization.request.statementSha256 ||
      request.statement !== formalization.request.statement || request.statementSha256 !== record.originalSha256)
    throw new Error('informalization_formalization_mismatch');
}
const declaration = z.string().min(1).max(4096);
const prose = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0);
const informalizationStepSchema = z.object({
  text: prose(16_000),
  /** Declarations this step relies on; each must occur in the declaration's Lean terms. */
  uses: z.array(declaration).max(64),
  /** Verbatim excerpts of the declaration's Lean source that this step explains. */
  lean: z.array(z.string().min(1).max(4000)).min(1).max(8),
}).strict();
export const informalizationWriterOutputSchema = z.object({
  inputDigest: hash,
  sections: z.array(z.object({ declaration, title: prose(400), statement: prose(16_000),
    proof: z.array(informalizationStepSchema).max(200) }).strict()).min(1).max(64),
  /** How the batch's results prove the target; present exactly in the final batch. */
  overview: prose(16_000).nullable(),
}).strict();
export type InformalizationWriterOutput = z.infer<typeof informalizationWriterOutputSchema>;
export type InformalizationSection = InformalizationWriterOutput['sections'][number];

const explanation = z.string().max(8000);
export const informalizationAuditOutputSchema = z.object({
  inputDigest: hash,
  sections: z.array(z.object({ declaration,
    statement: z.object({ verdict: z.enum(['faithful', 'mismatch', 'unclear']), explanation }).strict(),
    steps: z.array(z.object({ verdict: z.enum(['justified', 'gap', 'invented', 'unclear']), explanation }).strict()).max(200),
    omissions: z.array(z.object({ lean: z.string().min(1).max(4000), explanation: prose(8000) }).strict()).max(64),
  }).strict()).min(1).max(64),
  overview: z.object({ verdict: z.enum(['consistent', 'inconsistent', 'absent']), explanation }).strict(),
  summary: prose(16_000),
}).strict();
export type InformalizationAuditOutput = z.infer<typeof informalizationAuditOutputSchema>;

/** A phrase of the prose (verbatim) and the Lean text it translates (verbatim, whitespace runs collapsed). */
const informalizationLinkSchema = z.object({ text: prose(400), lean: z.string().min(1).max(2000) }).strict();
export type InformalizationLink = z.infer<typeof informalizationLinkSchema>;
const links = z.array(informalizationLinkSchema).max(24);
export const informalizationAlignedWriterOutputSchema = informalizationWriterOutputSchema.extend({
  sections: z.array(z.object({ declaration, title: prose(400), statement: prose(16_000), statementLinks: links,
    proof: z.array(informalizationStepSchema.extend({ links }).strict()).max(200) }).strict()).min(1).max(64),
}).strict();
export type InformalizationAlignedWriterOutput = z.infer<typeof informalizationAlignedWriterOutputSchema>;
export type InformalizationAlignedSection = InformalizationAlignedWriterOutput['sections'][number];
const auditSectionShape = informalizationAuditOutputSchema.shape.sections.element.shape;
export const informalizationAlignedAuditOutputSchema = informalizationAuditOutputSchema.extend({
  sections: z.array(z.object({ ...auditSectionShape,
    /** Whether the step agrees with the goals INPUT.stepGoals records for it. */
    steps: z.array(auditSectionShape.steps.element.extend({ goals: z.enum(['consistent', 'inconsistent', 'unrecorded']) }).strict()).max(200),
  }).strict()).min(1).max(64),
}).strict();
export type InformalizationAlignedAuditOutput = z.infer<typeof informalizationAlignedAuditOutputSchema>;
type Alignment = InformalizationRequest['alignment'];
type ExplanationPolicy = InformalizationRequest['explanationPolicy'];
type OutlinePolicy = InformalizationRequest['outlinePolicy'];
/** The outline policy's additions: a sentence per declaration, and stages from the proof's first results to the target. */
const summary = prose(600);
const routeSchema = z.array(z.object({ claim: prose(2000), declarations: z.array(declaration).min(1).max(64) }).strict()).min(2).max(6);
export type InformalizationRoute = { claim: string; declarations: string[] }[];
const sections = <Shape extends z.ZodRawShape>(shape: Shape) => z.array(z.object(shape).strict()).min(1).max(64);
export const informalizationOutlinedWriterOutputSchema = informalizationWriterOutputSchema.extend({
  sections: sections({ ...informalizationWriterOutputSchema.shape.sections.element.shape, summary }), route: routeSchema.nullable() }).strict();
export const informalizationOutlinedAlignedWriterOutputSchema = informalizationAlignedWriterOutputSchema.extend({
  sections: sections({ ...informalizationAlignedWriterOutputSchema.shape.sections.element.shape, summary }), route: routeSchema.nullable() }).strict();
const summaryVerdict = z.object({ verdict: z.enum(['faithful', 'mismatch']), explanation }).strict();
const routeVerdict = z.object({ verdict: z.enum(['consistent', 'inconsistent', 'absent']), explanation }).strict();
export const informalizationOutlinedAuditOutputSchema = informalizationAuditOutputSchema.extend({
  sections: sections({ ...auditSectionShape, summary: summaryVerdict }), route: routeVerdict }).strict();
export const informalizationOutlinedAlignedAuditOutputSchema = informalizationAlignedAuditOutputSchema.extend({
  sections: sections({ ...informalizationAlignedAuditOutputSchema.shape.sections.element.shape, summary: summaryVerdict }), route: routeVerdict }).strict();
const writerOutputSchema = (alignment: Alignment, outline?: OutlinePolicy) => outline
  ? alignment ? informalizationOutlinedAlignedWriterOutputSchema : informalizationOutlinedWriterOutputSchema
  : alignment ? informalizationAlignedWriterOutputSchema : informalizationWriterOutputSchema;
const auditOutputSchema = (alignment: Alignment, outline?: OutlinePolicy) => outline
  ? alignment ? informalizationOutlinedAlignedAuditOutputSchema : informalizationOutlinedAuditOutputSchema
  : alignment ? informalizationAlignedAuditOutputSchema : informalizationAuditOutputSchema;
const routeOf = (value: object): InformalizationRoute | null => 'route' in value ? value.route as InformalizationRoute | null : null;
const summaryOf = (value: object): string | undefined => 'summary' in value && typeof value.summary === 'string' ? value.summary : undefined;
/** The one-sentence summary and the route of an accepted writer output, when its request asked for them. */
export const informalizationSectionSummary = summaryOf, informalizationOutputRoute = routeOf;
/** The writer output a request's alignment requires. */
export const informalizationWriterOutputSchemaFor = writerOutputSchema;

export type InformalizationRole = 'write' | 'audit';
/** A fresh serializable guide for OUTPUT.schema.json; the host validators and checks remain authoritative. */
export function informalizationRoleOutputSchema(role: InformalizationRole, alignment?: Alignment, outline?: OutlinePolicy) {
  const schema = deriveFormalizationRoleOutputJsonSchema(role === 'write' ? writerOutputSchema(alignment, outline) : auditOutputSchema(alignment, outline));
  return { ...schema, $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'TheoremOS informalization ' + role + ' OUTPUT.json',
    $comment: 'The host also checks the input digest, the declaration order, citations and verbatim Lean excerpts' +
      (alignment ? ', and that both sides of each link are verbatim.' : '.') };
}

export type InformalizationBatch = { index: number; count: number; final: boolean; declarations: string[] };
/** Greedy batches in dependency order; the target is in the final batch. */
export function informalizationBatches(outline: InformalizationOutline, limits: InformalizationRequest['batching']): InformalizationBatch[] {
  const groups: string[][] = [];
  let current: string[] = [], bytes = 0;
  for (const unit of outline.units) {
    const size = Buffer.byteLength(unit.source, 'utf8');
    if (current.length && (current.length >= limits.maxUnits || bytes + size > limits.maxSourceBytes)) {
      groups.push(current); current = []; bytes = 0;
    }
    current.push(unit.name); bytes += size;
  }
  groups.push(current);
  return groups.map((declarations, index) => ({ index, count: groups.length, final: index === groups.length - 1, declarations }));
}

/** Owned theorems a unit's terms use; a substantive use must be explained, so each is cited by some step. */
export const informalizationRequiredCitations = (outline: InformalizationOutline, unit: InformalizationUnit) => {
  const kinds = new Map(outline.units.map(item => [item.name, item.kind]));
  return unit.proofDependencies.filter(name => name !== unit.name && kinds.get(name) === 'theorem');
};
type BatchContextInput = { outline: InformalizationOutline; batch: InformalizationBatch;
  accepted: ReadonlyMap<string, InformalizationSection>; sources: readonly InformalizationSource[] };
function batchContext({ outline, batch, accepted, sources }: BatchContextInput) {
  const byName = new Map(outline.units.map(unit => [unit.name, unit]));
  const members = batch.declarations.map(name => byName.get(name)!);
  const inside = new Set(batch.declarations);
  const outside = [...new Set(members.flatMap(unit => [...unit.statementDependencies, ...unit.proofDependencies]))]
    .filter(name => !inside.has(name)).toSorted();
  return {
    target: outline.target,
    units: members.map(unit => ({ declaration: unit.name, kind: unit.kind, file: unit.file, signature: unit.signature,
      source: unit.source, statementDependencies: unit.statementDependencies, proofDependencies: unit.proofDependencies,
      mustCite: informalizationRequiredCitations(outline, unit),
      citableLibrary: unit.external.filter(name => !incidentalLibraryName(name)), externalTruncated: unit.externalTruncated,
      // Absent in outlines without goal states, so their inputs and digests are unchanged.
      ...unit.goals ? { goals: unit.goals } : {} })),
    // A dependency in a mutually recursive group may not have an accepted section yet.
    dependencies: outside.map(name => {
      const unit = byName.get(name)!, section = accepted.get(name);
      return { declaration: name, kind: unit.kind, signature: unit.signature,
        title: section?.title ?? null, statement: section?.statement ?? null };
    }),
    library: informalizationLibraryContext(outline, members),
    files: sources.map(source => ({ module: source.module, path: 'proof/' + source.file })),
  };
}
export type InformalizationWriterInput = ReturnType<typeof informalizationWriterInput>;
export type InformalizationAuditInput = ReturnType<typeof informalizationAuditInput>;

/** With the outline policy a role also gets every declaration name, which a route may list. */
const outlineContext = (context: BatchContextInput & { outlinePolicy?: OutlinePolicy }) => context.outlinePolicy
  ? { outlinePolicy: context.outlinePolicy, declarations: context.outline.units.map(unit => unit.name) } : {};
export function informalizationWriterInput(context: BatchContextInput & { language: InformalizationRequest['language'];
  alignment?: Alignment; explanationPolicy?: ExplanationPolicy; outlinePolicy?: OutlinePolicy; round: number; problemStatement: string | null; feedback: string | null;
  previousOutput: InformalizationWriterOutput | null }) {
  const body = { schema: 'theorem-os.informalization-write-input.v1' as const, protocol: INFORMALIZATION_PROTOCOL,
    ...context.alignment ? { alignment: context.alignment } : {}, language: context.language, round: context.round,
    ...context.explanationPolicy ? { explanationPolicy: context.explanationPolicy } : {}, ...outlineContext(context),
    batch: { index: context.batch.index, count: context.batch.count, final: context.batch.final },
    problemStatement: context.problemStatement, ...batchContext(context),
    feedback: context.feedback, previousOutput: context.previousOutput };
  return { ...body, inputDigest: informalizationDigest(body) };
}

/**
 * Auditors see the Lean proof and the explanation, never the problem statement or the writer's feedback. With alignment
 * they also get, per step, the goals the explanation page shows beside it (null when none are recorded).
 */
export function informalizationAuditInput(context: BatchContextInput & { language: InformalizationRequest['language'];
  alignment?: Alignment; explanationPolicy?: ExplanationPolicy; outlinePolicy?: OutlinePolicy; explanation: InformalizationWriterOutput }) {
  const byName = new Map(context.outline.units.map(unit => [unit.name, unit]));
  const stepGoals = context.alignment ? { stepGoals: context.explanation.sections.map(section => {
    const unit = byName.get(section.declaration);
    return { declaration: section.declaration,
      steps: unit ? sectionStepGoals(unit, section.proof.map(step => step.lean), informalizationStepGoalsOptions(context.alignment))
        : section.proof.map(() => null) };
  }) } : {};
  const body = { schema: 'theorem-os.informalization-audit-input.v1' as const, protocol: INFORMALIZATION_PROTOCOL,
    ...context.alignment ? { alignment: context.alignment } : {}, language: context.language,
    ...context.explanationPolicy ? { explanationPolicy: context.explanationPolicy } : {}, ...outlineContext(context),
    batch: { index: context.batch.index, count: context.batch.count, final: context.batch.final }, ...batchContext(context),
    explanation: { sections: context.explanation.sections, overview: context.explanation.overview,
      ...context.outlinePolicy ? { route: routeOf(context.explanation) } : {} }, ...stepGoals };
  return { ...body, inputDigest: informalizationDigest(body) };
}

const normalized = (value: string) => value.replace(/\s+/gu, ' ').trim();
const issues = (error: z.ZodError) => error.issues.slice(0, 8).map(issue => (issue.path.join('.') || 'output') + ': ' + issue.message);
/** Host checks of a writer output; an empty list accepts it for audit. */
export function informalizationWriterRejections(input: InformalizationWriterInput, value: unknown): string[] {
  const parsed = writerOutputSchema(input.alignment, input.outlinePolicy).safeParse(value);
  if (!parsed.success) return issues(parsed.error);
  const output: InformalizationWriterOutput = parsed.data, problems: string[] = [];
  if (output.inputDigest !== input.inputDigest) problems.push('inputDigest must equal INPUT.inputDigest');
  const expected = input.units.map(unit => unit.declaration);
  if (canonicalMathJson(output.sections.map(section => section.declaration)) !== canonicalMathJson(expected))
    return [...problems, 'sections must explain exactly these declarations, in this order: ' + expected.join(', ')];
  output.sections.forEach((section, index) => {
    const unit = input.units[index]!, source = normalized(unit.source);
    const owned = new Set([...unit.statementDependencies, ...unit.proofDependencies]);
    const citable = new Set([...owned, ...unit.citableLibrary]);
    const where = `${section.declaration}`;
    if (unit.kind === 'theorem' && !section.proof.length) problems.push(`${where}: a theorem needs at least one proof step`);
    const cited = new Set<string>();
    section.proof.forEach((step, stepIndex) => {
      for (const name of step.uses) {
        // Beyond a truncated external list only the name's shape is checked.
        if (citable.has(name) || unit.externalTruncated && isSimpleLeanName(name) && !owned.has(name)) cited.add(name);
        else problems.push(`${where} step ${stepIndex + 1}: ${name} is not used by this declaration's Lean terms`);
      }
      for (const excerpt of step.lean)
        if (!normalized(excerpt) || !source.includes(normalized(excerpt)))
          problems.push(`${where} step ${stepIndex + 1}: lean excerpt is not verbatim text of this declaration: ${excerpt.slice(0, 200)}`);
    });
    const missing = unit.mustCite.filter(name => !cited.has(name));
    if (missing.length) problems.push(`${where}: the Lean proof uses ${missing.join(', ')}; cite each in the step that uses it`);
    if (input.alignment) problems.push(...linkRejections(unit, section as InformalizationAlignedSection));
  });
  if (input.batch.final !== (output.overview !== null))
    problems.push(input.batch.final ? 'overview is required in the final batch' : 'overview must be null before the final batch');
  if (input.outlinePolicy) {
    const route = routeOf(output), known = new Set(input.declarations);
    if (input.batch.final !== (route !== null))
      problems.push(input.batch.final ? 'route is required in the final batch' : 'route must be null before the final batch');
    const unknown = [...new Set((route ?? []).flatMap(step => step.declarations))].filter(name => !known.has(name));
    if (unknown.length) problems.push(`route: ${unknown.join(', ')} is not a declaration of this proof (see INPUT.declarations)`);
    if (route && !route.at(-1)!.declarations.includes(input.target)) problems.push(`route: the last step must list the target ${input.target}`);
  }
  return problems;
}

/**
 * Each link's phrase is in its own statement or step text, exactly as written, and its Lean is inside what that
 * statement or step explains: a theorem's signature (any other declaration's whole source) or the step's quoted excerpts,
 * at the place the page shows them. A theorem's statement needs at least one link.
 */
function linkRejections(unit: InformalizationWriterInput['units'][number], section: InformalizationAlignedSection): string[] {
  const problems: string[] = [], source = lineEnds(unit.source), where = section.declaration;
  const check = (place: string, link: InformalizationLink, prose: string, regions: readonly { start: number; end: number }[]) => {
    if (!prose.includes(link.text)) problems.push(`${where} ${place}: link text is not verbatim text of it: ${link.text.slice(0, 200)}`);
    if (!findWithin(source, link.lean, regions))
      problems.push(`${where} ${place}: link lean is not verbatim text of the Lean it explains: ${link.lean.slice(0, 200)}`);
  };
  if (unit.kind === 'theorem' && !section.statementLinks.length)
    problems.push(`${where} statement: link at least one phrase to the Lean signature`);
  const signature = [statementRegion(unit)];
  for (const link of section.statementLinks) check('statement', link, section.statement, signature);
  const { places } = placeExcerpts(source, section.proof.map(step => step.lean));
  section.proof.forEach((step, index) => {
    for (const link of step.links) check(`step ${index + 1}`, link, step.text, places[index]!);
  });
  return problems;
}

/**
 * The formulas of prose as the explanation page reads them: `$…$`, `$$…$$`, `\(…\)` and `\[…\]` outside inline code, with
 * `\$` an escaped dollar sign and `**…**` read on its own (apps/web/client/explainText.ts).
 */
function proseFormulas(text: string): string[] {
  const formulas: string[] = [], fence = /`+/y;
  for (let index = 0; index < text.length;) {
    if (text.startsWith('\\$', index)) { index += 2; continue; }
    fence.lastIndex = index;
    const ticks = fence.exec(text)?.[0];
    if (ticks) { const end = text.indexOf(ticks, index + ticks.length); index = end > 0 ? end + ticks.length : index + ticks.length; continue; }
    const bold = text.startsWith('**', index) ? text.indexOf('**', index + 2) : -1;
    if (bold > index + 2) { formulas.push(...proseFormulas(text.slice(index + 2, bold))); index = bold + 2; continue; }
    const delimiter = ([['$$', '$$'], ['\\[', '\\]'], ['\\(', '\\)'], ['$', '$']] as const).find(([open]) => text.startsWith(open, index));
    let end = -1;
    if (delimiter) for (let at = index + delimiter[0].length; at < text.length; at++) {
      if (text.startsWith(delimiter[1], at)) { end = at; break; }
      if (text[at] === '\\') at++;
    }
    if (delimiter && end > index + delimiter[0].length) { formulas.push(text.slice(index + delimiter[0].length, end)); index = end + delimiter[1].length; }
    else index++;
  }
  return formulas;
}
/**
 * Lean names written inside a formula, where TeX reads `_` as a subscript and drops spaces (`$Nat.two_mul n$` draws
 * "Nat.two" with a subscript m). Only exact names this batch can cite, with a `.` or `_`, count, so `$a_n$` is mathematics.
 */
function formulaNameRejections(input: InformalizationWriterInput, output: InformalizationWriterOutput): string[] {
  const lean = (list: readonly string[]) => list.flatMap(name => [name, name.split('.').at(-1)!]).filter(name => /[._]/u.test(name));
  const names = (unit: InformalizationWriterInput['units'][number]) =>
    lean([unit.declaration, ...unit.statementDependencies, ...unit.proofDependencies, ...unit.citableLibrary]);
  const problems: string[] = [];
  const check = (where: string, text: string, known: ReadonlySet<string>) => {
    for (const formula of proseFormulas(text)) {
      const found = [...formula.matchAll(/[\p{L}_][\p{L}\p{N}_'.]*/gu)].map(match => match[0].replace(/\.+$/u, '')).filter(name => known.has(name));
      if (found.length) problems.push(`${where}: write the Lean name ${[...new Set(found)].join(', ')} as \`code\`, not inside $...$: ${formula.slice(0, 200)}`);
    }
  };
  output.sections.forEach((section, index) => {
    const known = new Set(names(input.units[index]!)), where = section.declaration;
    check(`${where} title`, section.title, known);
    check(`${where} statement`, section.statement, known);
    section.proof.forEach((step, stepIndex) => check(`${where} step ${stepIndex + 1}`, step.text, new Set([...known, ...lean(step.uses)])));
    const sentence = summaryOf(section);
    if (sentence) check(`${where} summary`, sentence, known);
  });
  if (output.overview !== null) check('overview', output.overview, new Set(input.units.flatMap(names)));
  (routeOf(output) ?? []).forEach((step, index) => check(`route step ${index + 1}`, step.claim, new Set([...input.units.flatMap(names), ...lean(step.declarations)])));
  return problems;
}
/**
 * What the runner asks of a writer before audit: the host checks, then no Lean names inside formulas. The formula rule
 * is not part of the evidence check, so explanations approved before it stay valid.
 */
export function informalizationWriterSubmissionRejections(input: InformalizationWriterInput, value: unknown): string[] {
  const problems = informalizationWriterRejections(input, value);
  return problems.length ? problems : formulaNameRejections(input, value as InformalizationWriterOutput);
}

/** Structural checks of an audit; a malformed audit is not a verdict. */
export function informalizationAuditRejections(input: InformalizationAuditInput, value: unknown): string[] {
  const parsed = auditOutputSchema(input.alignment, input.outlinePolicy).safeParse(value);
  if (!parsed.success) return issues(parsed.error);
  const output: InformalizationAuditOutput = parsed.data, problems: string[] = [];
  if (output.inputDigest !== input.inputDigest) problems.push('inputDigest must equal INPUT.inputDigest');
  const sections = input.explanation.sections;
  if (canonicalMathJson(output.sections.map(section => section.declaration)) !== canonicalMathJson(sections.map(section => section.declaration)))
    return [...problems, 'sections must review exactly the explained declarations, in order'];
  output.sections.forEach((section, index) => {
    const explained = sections[index]!, source = normalized(input.units[index]!.source), where = section.declaration;
    if (section.steps.length !== explained.proof.length)
      problems.push(`${where}: steps must have one verdict per explained step (${explained.proof.length})`);
    if (section.statement.verdict !== 'faithful' && !section.statement.explanation.trim())
      problems.push(`${where}: a ${section.statement.verdict} statement verdict needs an explanation`);
    const sentence = summaryVerdictOf(section);
    if (sentence?.verdict === 'mismatch' && !sentence.explanation.trim()) problems.push(`${where}: a mismatch summary verdict needs an explanation`);
    section.steps.forEach((step, stepIndex) => {
      if (step.verdict !== 'justified' && !step.explanation.trim())
        problems.push(`${where} step ${stepIndex + 1}: a ${step.verdict} verdict needs an explanation`);
      if (!input.stepGoals || !('goals' in step)) return;
      const recorded = input.stepGoals[index]?.steps[stepIndex] ?? null;
      if ((step.goals === 'unrecorded') !== (recorded === null))
        problems.push(`${where} step ${stepIndex + 1}: goals must be ${recorded === null ? 'unrecorded' : 'consistent or inconsistent'}`);
      if (step.goals === 'inconsistent' && !step.explanation.trim())
        problems.push(`${where} step ${stepIndex + 1}: inconsistent goals need an explanation`);
    });
    for (const omission of section.omissions)
      if (!normalized(omission.lean) || !source.includes(normalized(omission.lean)))
        problems.push(`${where}: omission lean is not verbatim text of this declaration: ${omission.lean.slice(0, 200)}`);
  });
  if ((output.overview.verdict === 'absent') !== (input.explanation.overview === null))
    problems.push(input.explanation.overview === null ? 'overview verdict must be absent' : 'overview verdict must be consistent or inconsistent');
  if (output.overview.verdict === 'inconsistent' && !output.overview.explanation.trim())
    problems.push('an inconsistent overview verdict needs an explanation');
  const route = routeVerdictOf(output);
  if (route) {
    const written = 'route' in input.explanation ? input.explanation.route ?? null : null;
    if ((route.verdict === 'absent') !== (written === null))
      problems.push(written === null ? 'route verdict must be absent' : 'route verdict must be consistent or inconsistent');
    if (route.verdict === 'inconsistent' && !route.explanation.trim()) problems.push('an inconsistent route verdict needs an explanation');
  }
  return problems;
}

type Verdict<V extends string> = { verdict: V; explanation: string };
const summaryVerdictOf = (section: object) => 'summary' in section ? section.summary as Verdict<'faithful' | 'mismatch'> : undefined;
const routeVerdictOf = (audit: object) => 'route' in audit ? audit.route as Verdict<'consistent' | 'inconsistent' | 'absent'> : undefined;
const goalsInconsistent = (step: InformalizationAuditOutput['sections'][number]['steps'][number]) =>
  'goals' in step && step.goals === 'inconsistent';
export const informalizationAuditApproved = (audit: InformalizationAuditOutput) => audit.overview.verdict !== 'inconsistent' &&
  routeVerdictOf(audit)?.verdict !== 'inconsistent' &&
  audit.sections.every(section => section.statement.verdict === 'faithful' && summaryVerdictOf(section)?.verdict !== 'mismatch' && !section.omissions.length &&
    section.steps.every(step => step.verdict === 'justified' && !goalsInconsistent(step)));
const clip = (value: string, max: number) => value.length > max ? value.slice(0, max) + '…' : value;
/** Writer feedback from every non-approving finding, attributed to its auditor. */
export function informalizationAuditFeedback(audits: readonly { auditorId: string; output: InformalizationAuditOutput }[]): string {
  const lines: string[] = [];
  for (const { auditorId, output } of audits) {
    for (const section of output.sections) {
      if (section.statement.verdict !== 'faithful')
        lines.push(`${auditorId}, ${section.declaration}, statement ${section.statement.verdict}: ${section.statement.explanation}`);
      const sentence = summaryVerdictOf(section);
      if (sentence?.verdict === 'mismatch') lines.push(`${auditorId}, ${section.declaration}, summary mismatch: ${sentence.explanation}`);
      section.steps.forEach((step, index) => {
        const goals = goalsInconsistent(step) ? step.verdict === 'justified' ? 'goals inconsistent' : `${step.verdict}, goals inconsistent` : '';
        if (step.verdict !== 'justified' || goals)
          lines.push(`${auditorId}, ${section.declaration}, step ${index + 1} ${goals || step.verdict}: ${step.explanation}`);
      });
      for (const omission of section.omissions)
        lines.push(`${auditorId}, ${section.declaration}, unexplained Lean ${JSON.stringify(omission.lean.slice(0, 400))}: ${omission.explanation}`);
    }
    if (output.overview.verdict === 'inconsistent') lines.push(`${auditorId}, overview inconsistent: ${output.overview.explanation}`);
    const route = routeVerdictOf(output);
    if (route?.verdict === 'inconsistent') lines.push(`${auditorId}, route inconsistent: ${route.explanation}`);
  }
  return clip('Independent auditors did not approve this explanation. Check each finding against the Lean source and revise:\n' +
    lines.join('\n'), 16_000);
}
export const informalizationRejectionFeedback = (problems: readonly string[]) =>
  clip('The host rejected OUTPUT.json. Fix every item and write the complete output again:\n' + problems.join('\n'), 16_000);

/** Share of the declarations' non-blank source characters inside at least one quoted excerpt (first occurrence). */
export function informalizationExcerptCoverage(units: readonly Pick<InformalizationUnit, 'name' | 'source'>[],
  sections: readonly InformalizationSection[]): number {
  let covered = 0, total = 0;
  for (const unit of units) {
    const source = normalized(unit.source), marks = new Uint8Array(source.length);
    for (const excerpt of sections.find(item => item.declaration === unit.name)?.proof.flatMap(step => step.lean) ?? []) {
      const value = normalized(excerpt), start = source.indexOf(value);
      if (value && start >= 0) marks.fill(1, start, start + value.length);
    }
    for (let index = 0; index < source.length; index++) if (source[index] !== ' ') { total++; covered += marks[index]!; }
  }
  return total ? Math.round(covered / total * 1000) / 1000 : 0;
}

const labels = {
  zh: { title: (name: string) => `证明：${name}`, colon: '：', separator: '，',
    notice: '本文由模型根据 Lean 证明自动撰写，并由独立的模型审核逐步核对它与 Lean 源码的对应关系。Lean 已检查证明本身；这里的自然语言表述没有经过人工审阅。',
    main: '主定理', statement: '陈述', summary: '概要', route: '证明主线', overview: '证明思路', definitions: '定义与引理', proof: '证明', notes: '说明',
    mainProof: '主定理的证明', basis: '依据', source: '来源', axioms: '使用的公理', leanName: 'Lean 名称', stop: '。',
    kinds: { theorem: '引理', definition: '定义', instance: '实例', opaque: '定义', axiom: '公理', inductive: '归纳类型',
      structure: '结构', class: '类' } },
  en: { title: (name: string) => `Proof of ${name}`, colon: ': ', separator: ', ',
    notice: 'This text was written by a model from the Lean proof, and independent model auditors checked each step against the Lean source. Lean checked the proof itself; the natural-language text has not been reviewed by a person.',
    main: 'Main theorem', statement: 'Statement', summary: 'In short', route: 'Main line', overview: 'Proof outline', definitions: 'Definitions and lemmas', proof: 'Proof',
    notes: 'Notes', mainProof: 'Proof of the main theorem', basis: 'Uses', source: 'Source', axioms: 'Axioms used',
    leanName: 'Lean name', stop: '.',
    kinds: { theorem: 'Lemma', definition: 'Definition', instance: 'Instance', opaque: 'Definition', axiom: 'Axiom',
      inductive: 'Inductive type', structure: 'Structure', class: 'Class' } },
} as const;
const backtickRun = (value: string) => Math.max(0, ...[...value.matchAll(/`+/gu)].map(match => match[0].length));
const code = (value: string) => {
  const fence = '`'.repeat(backtickRun(value) + 1);
  return fence.length > 1 ? `${fence} ${value} ${fence}` : fence + value + fence;
};
const leanBlock = (value: string, indent: string) => {
  const fence = '`'.repeat(Math.max(3, backtickRun(value) + 1));
  return [indent + fence + 'lean', ...value.split('\n').map(line => line ? indent + line : ''), indent + fence].join('\n');
};
const indented = (value: string, indent: string) => value.trim().split('\n').map(line => line.trim() ? indent + line : '').join('\n');
export type InformalizationRenderInput = { language: InformalizationRequest['language']; outline: InformalizationOutline;
  sections: readonly InformalizationSection[]; overview: string;
  /** The audited route of an outlined explanation; absent otherwise, and the Markdown is then as before. */ route?: InformalizationRoute | null;
  provenance: { sources: readonly Pick<InformalizationRequest['sources'][number], 'origin' | 'sha256'>[]; toolchain: string;
    mathlibRevision: string | null } };

/** Deterministic Markdown; definitions first, then lemmas in dependency order, the main theorem's proof last. */
export function renderInformalization(input: InformalizationRenderInput): string {
  const label = labels[input.language], { outline } = input;
  const sections = new Map(input.sections.map(section => [section.declaration, section]));
  if (sections.size !== input.sections.length || outline.units.some(unit => !sections.has(unit.name)) || sections.size !== outline.units.length)
    throw new Error('informalization_render_sections_invalid');
  const target = outline.units.at(-1)!, others = outline.units.slice(0, -1);
  const ordered = [...others.filter(unit => unit.kind !== 'theorem'), ...others.filter(unit => unit.kind === 'theorem')];
  const numbers = new Map(ordered.map((unit, index) => [unit.name, index + 1]));
  const line = (value: string) => value.replace(/\s+/gu, ' ').trim();
  const reference = (name: string) => {
    const unit = outline.units.find(item => item.name === name);
    if (!unit) return code(name);
    return unit === target ? `${label.main} ${code(name)}` : `${label.kinds[unit.kind]} ${numbers.get(name)} ${code(name)}`;
  };
  const steps = (section: InformalizationSection) => section.proof.map((step, index) => {
    const prefix = `${index + 1}. `, indent = ' '.repeat(prefix.length);
    const body = [prefix + indented(step.text, indent).trimStart()];
    if (step.uses.length) body.push(indent + `*${label.basis}*${label.colon}` + step.uses.map(reference).join(label.separator));
    const inline = step.lean.filter(item => !item.includes('\n') && item.length <= 120);
    if (inline.length) body.push(indent + 'Lean' + label.colon + inline.map(item => code(item.trim())).join(label.separator));
    for (const item of step.lean.filter(value => !inline.includes(value))) body.push(leanBlock(item.replace(/\s+$/u, ''), indent));
    return body.join('\n\n');
  }).join('\n\n');
  const block = (unit: InformalizationUnit) => {
    const section = sections.get(unit.name)!;
    const parts = [`### ${label.kinds[unit.kind]} ${numbers.get(unit.name)}${label.colon}${line(section.title)}`,
      `${label.leanName}${label.colon}${code(unit.name)}`,
      ...summaryOf(section) ? [`**${label.summary}**${label.colon}${line(summaryOf(section)!)}`] : [],
      `**${label.statement}**${label.colon}${section.statement.trim()}`];
    if (section.proof.length) parts.push(`**${unit.kind === 'theorem' ? label.proof : label.notes}**`, steps(section));
    return parts.join('\n\n');
  };
  const main = sections.get(target.name)!;
  const footer = `${label.source}${label.colon}` + input.provenance.sources.map(item => `${code(item.origin)} (sha256 ${item.sha256})`).join(label.separator) +
    `${label.separator}Lean ${input.provenance.toolchain}` +
    (input.provenance.mathlibRevision ? `${label.separator}Mathlib ${input.provenance.mathlibRevision}` : '') + label.stop + '\n' +
    `${label.axioms}${label.colon}` + (outline.axioms.length ? outline.axioms.map(code).join(label.separator) : '—') + label.stop;
  return [`# ${label.title(target.name)}`, `> ${label.notice}`,
    `## ${label.main}${label.colon}${line(main.title)}`, `${label.leanName}${label.colon}${code(target.name)}`, main.statement.trim(),
    `## ${label.overview}`, input.overview.trim(),
    ...(input.route?.length ? [`## ${label.route}`, input.route.map((step, index) =>
      `${index + 1}. ${line(step.claim)} (${step.declarations.map(code).join(label.separator)})`).join('\n')] : []),
    ...(ordered.length ? [`## ${label.definitions}`, ...ordered.map(block)] : []),
    `## ${label.mainProof}`, steps(main), '---', footer].join('\n\n') + '\n';
}
const sessionEvidenceSchema = z.object({
  role: z.enum(['write', 'audit']), batch: z.number().int().nonnegative(), round: z.number().int().positive(),
  attempt: z.number().int().positive(), auditorId: z.string().optional(), threadId: z.string().optional(), turnId: z.string().optional(), status: z.string(),
  model: z.string(), effort: z.string(), inputDigest: hash, outputDigest: hash.optional(), usage: z.record(z.unknown()),
}).strict();
const metricsSchema = z.object({ declarations: z.number().int().positive(), steps: z.number().int().nonnegative(),
  citations: z.number().int().nonnegative(), excerptCoverage: z.number().min(0).max(1) }).strict();
export const informalizationEvidenceSchema = z.object({
  schema: z.literal('theorem-os.informalization-evidence.v1'), protocol: z.literal(INFORMALIZATION_PROTOCOL),
  status: z.literal('approved'), authority: z.literal('model'),
  /** The host compiled the proof modules in the pinned environment; the target uses no sorryAx. */
  proofCompiledByHost: z.literal(true), humanReviewed: z.literal(false),
  requestDigest: hash, target: leanName, language: z.enum(['zh', 'en']),
  toolchain: text, mathlibRevision: text.nullable(), statementSha256: hash.nullable(),
  /** The request's records: the approved formalization, phrase alignment and opted-in explanation rules. */
  formalization: informalizationRequestSchema.shape.formalization, alignment: informalizationRequestSchema.shape.alignment,
  explanationPolicy: informalizationRequestSchema.shape.explanationPolicy, outlinePolicy: informalizationRequestSchema.shape.outlinePolicy,
  sources: informalizationRequestSchema.shape.sources, batching: informalizationRequestSchema.shape.batching,
  writer: formalizationModelConfigurationSchema, auditors: informalizationRequestSchema.shape.auditors,
  outlineDigest: hash, outline: informalizationOutlineSchema,
  batches: z.array(z.object({ index: z.number().int().nonnegative(), declarations: z.array(declaration).min(1),
    rounds: z.number().int().positive(), writerInputDigest: hash,
    writer: z.union([informalizationOutlinedAlignedWriterOutputSchema, informalizationOutlinedWriterOutputSchema,
      informalizationAlignedWriterOutputSchema, informalizationWriterOutputSchema]),
    audits: z.array(z.object({ auditorId: z.string(),
      output: z.union([informalizationOutlinedAlignedAuditOutputSchema, informalizationOutlinedAuditOutputSchema,
        informalizationAlignedAuditOutputSchema, informalizationAuditOutputSchema]) }).strict()).min(1) }).strict()).min(1),
  sessions: z.array(sessionEvidenceSchema), metrics: metricsSchema, proofMarkdownSha256: hash,
}).strict();
export type InformalizationEvidence = z.infer<typeof informalizationEvidenceSchema>;

const evidenceMetrics = (outline: InformalizationOutline, sections: readonly InformalizationSection[]) => ({
  declarations: sections.length, steps: sections.reduce((sum, section) => sum + section.proof.length, 0),
  citations: sections.reduce((sum, section) => sum + section.proof.reduce((count, step) => count + step.uses.length, 0), 0),
  excerptCoverage: informalizationExcerptCoverage(outline.units, sections) });

/** Re-derive every host check from the evidence alone; returns the Markdown it binds. */
export function assertInformalizationEvidence(value: unknown): { evidence: InformalizationEvidence; markdown: string } {
  const evidence = informalizationEvidenceSchema.parse(value), { outline } = evidence;
  if (informalizationDigest(outline) !== evidence.outlineDigest || outline.target !== evidence.target ||
      new Set(evidence.auditors.map(item => item.id)).size !== evidence.auditors.length ||
      evidence.formalization && evidence.statementSha256 !== evidence.formalization.originalSha256)
    throw new Error('informalization_evidence_invalid');
  const batches = informalizationBatches(outline, evidence.batching), accepted = new Map<string, InformalizationSection>();
  const files = evidence.sources.map(source => ({ module: source.module, file: source.file, text: '' }));
  if (batches.length !== evidence.batches.length) throw new Error('informalization_evidence_invalid');
  evidence.batches.forEach((record, index) => {
    const batch = batches[index]!;
    if (record.index !== index || canonicalMathJson(record.declarations) !== canonicalMathJson(batch.declarations))
      throw new Error('informalization_evidence_invalid');
    const audit = informalizationAuditInput({ outline, batch, accepted, sources: files, language: evidence.language,
      alignment: evidence.alignment, explanationPolicy: evidence.explanationPolicy, outlinePolicy: evidence.outlinePolicy, explanation: record.writer });
    const writerCheck = { units: audit.units, batch: audit.batch, alignment: evidence.alignment, target: audit.target,
      ...audit.outlinePolicy ? { outlinePolicy: audit.outlinePolicy, declarations: audit.declarations } : {},
      inputDigest: record.writerInputDigest } as InformalizationWriterInput;
    if (informalizationWriterRejections(writerCheck, record.writer).length ||
        canonicalMathJson(record.audits.map(item => item.auditorId)) !== canonicalMathJson(evidence.auditors.map(item => item.id)) ||
        record.audits.some(item => informalizationAuditRejections(audit, item.output).length || !informalizationAuditApproved(item.output)))
      throw new Error('informalization_evidence_invalid');
    for (const section of record.writer.sections) accepted.set(section.declaration, section);
  });
  const sections = evidence.batches.flatMap(batch => batch.writer.sections);
  if (canonicalMathJson(evidenceMetrics(outline, sections)) !== canonicalMathJson(evidence.metrics))
    throw new Error('informalization_evidence_invalid');
  const markdown = renderInformalization({ language: evidence.language, outline, sections,
    overview: evidence.batches.at(-1)!.writer.overview!, route: routeOf(evidence.batches.at(-1)!.writer), provenance: { sources: evidence.sources,
      toolchain: evidence.toolchain, mathlibRevision: evidence.mathlibRevision } });
  if (mathDigest(markdown) !== evidence.proofMarkdownSha256) throw new Error('informalization_evidence_invalid');
  return { evidence, markdown };
}
export function informalizationEvidence(input: { request: InformalizationRequest; outline: InformalizationOutline;
  batches: InformalizationEvidence['batches']; sessions: InformalizationEvidence['sessions'] }): InformalizationEvidence {
  const { request, outline } = input, overview = input.batches.at(-1)?.writer.overview;
  if (!overview) throw new Error('informalization_evidence_invalid');
  const sections = input.batches.flatMap(batch => batch.writer.sections);
  const markdown = renderInformalization({ language: request.language, outline, sections, overview, route: routeOf(input.batches.at(-1)!.writer),
    provenance: { sources: request.sources, toolchain: request.toolchain, mathlibRevision: request.mathlibRevision } });
  const evidence: InformalizationEvidence = { schema: 'theorem-os.informalization-evidence.v1', protocol: INFORMALIZATION_PROTOCOL,
    status: 'approved', authority: 'model', proofCompiledByHost: true, humanReviewed: false,
    requestDigest: informalizationDigest(request), target: outline.target, language: request.language,
    toolchain: request.toolchain, mathlibRevision: request.mathlibRevision, statementSha256: request.statementSha256,
    ...request.formalization ? { formalization: request.formalization } : {}, ...request.alignment ? { alignment: request.alignment } : {},
    ...request.explanationPolicy ? { explanationPolicy: request.explanationPolicy } : {},
    ...request.outlinePolicy ? { outlinePolicy: request.outlinePolicy } : {},
    sources: request.sources, batching: request.batching, writer: request.writer, auditors: request.auditors,
    outlineDigest: informalizationDigest(outline), outline, batches: input.batches, sessions: input.sessions,
    metrics: evidenceMetrics(outline, sections), proofMarkdownSha256: mathDigest(markdown) };
  assertInformalizationEvidence(evidence);
  return evidence;
}

export function writeInformalizationArtifact(directory: string, evidence: InformalizationEvidence): string {
  const { markdown } = assertInformalizationEvidence(evidence);
  const artifact = path.resolve(directory, 'artifact'); assertMathCanonicalPath(artifact);
  if (fs.existsSync(artifact)) throw new Error('informalization_artifact_exists');
  const staging = path.join(path.resolve(directory), '.artifact-' + crypto.randomUUID());
  fs.mkdirSync(staging, { mode: 0o700 });
  writeMathFrozen(path.join(staging, 'proof.md'), markdown);
  writeMathJsonDurable(path.join(staging, 'informalization.json'), evidence, 0o400);
  readInformalizationArtifact(staging);
  fs.renameSync(staging, artifact);
  syncMathDirectory(path.resolve(directory));
  return artifact;
}

export function readInformalizationArtifact(artifact: string): InformalizationEvidence {
  artifact = path.resolve(artifact);
  for (const name of ['proof.md', 'informalization.json']) assertMathCanonicalPath(path.join(artifact, name));
  const { evidence, markdown } = assertInformalizationEvidence(JSON.parse(readMathText(path.join(artifact, 'informalization.json'), 64_000_000)));
  if (readMathText(path.join(artifact, 'proof.md'), 32_000_000) !== markdown) throw new Error('informalization_artifact_changed');
  return evidence;
}
const SHARED_INSTRUCTIONS = [
  'The Lean files of the proof are in proof/ (INPUT.files lists them, dependencies first). Lean has checked them. Never edit proof/.',
  'When a unit has goals, goals.tactics lists each tactic as written, in source order: its range in the proof file, its first line (tactic), and the goals before and after it as Lean printed them (hypotheses, then ⊢ and the target). At most 4 goals are printed per state; beforeCount and afterCount give the number. An empty after means the tactic closed its goal. goals.truncated means some entries were dropped for size, nested tactics first.',
  'To inspect a goal that goals does not show, copy the files to a scratch directory, add trace_state or a temporary have, and run lean there. A file that imports a local module needs that module compiled first: lean -o build/<Module/Path>.olean <file>, with build added to LEAN_PATH.',
  'Installed Lean sources are in /opt/lean/src/lean; pinned Mathlib and dependencies are in /opt/lean-packages (Mathlib: /opt/lean-packages/mathlib/Mathlib). LEAN_PATH is already configured.',
  'OUTPUT.schema.json describes the exact output structure. Write your complete JSON atomically (write a temporary file, then rename it to OUTPUT.json).',
  'The first complete schema-valid OUTPUT.json is your submission: the host ends this role and checks it. Stop after submitting.',
  'Do not change INPUT.json, ROLE.md or OUTPUT.schema.json. Read only this role input, the proof files and installed libraries; other tasks and prior sessions are unavailable.',
];
const WRITER_LINES = [
  'Write a natural-language proof that explains the given Lean proof. INPUT.json holds one batch of its declarations in dependency order, with their Lean source, elaborated signatures and, when recorded, the goals around each tactic (goals), the accepted statements of earlier declarations they use (dependencies), and the library theorems their terms use (library).',
  'Write exactly one strict JSON object to OUTPUT.json with inputDigest (copied from INPUT), sections and overview.',
  'sections has one item per INPUT.units entry, in the same order, with declaration equal to its name. title is a short descriptive name. statement translates the Lean signature exactly: every hypothesis, quantifier, domain, type and coercion, nothing added and nothing dropped.',
  'The Lean source is the only authority. proof follows the structure of the Lean proof: its case splits, inductions, intermediate claims and lemma applications, in Lean order. Do not substitute a different or shorter argument, and do not claim a step the Lean proof does not take.',
  'Each step has text, uses and lean. lean quotes 1 to 8 verbatim excerpts of that declaration\'s Lean source that the step explains. uses names each declaration the step relies on: owned declarations (statementDependencies, proofDependencies) and library theorems from citableLibrary, by exact name.',
  'Cite every name in mustCite in the step that applies it. Name a library theorem when the step depends on its content; routine rewriting and arithmetic closed by automation need no citation, but the step must still say what was shown.',
  'When automation such as simp, ring, linarith, omega, norm_num, decide or positivity closes a goal, state the goal it closes and the reason it holds. "By simp" alone is not an explanation.',
  'Where goals are recorded, state intermediate claims and the goals automation closes as Lean has them; do not claim a goal that differs from the recorded one.',
  'A definition, instance or structure needs proof steps only for content that needs explaining, such as a recursion, a proof field or a termination argument; its statement describes what it defines. A theorem needs at least one step.',
  'Use the dependency statements as proved results; do not prove them again. Write mathematics in LaTeX ($...$). Write Lean names, tactics and Lean expressions as inline code (`Nat.two_mul`), never inside $...$, where TeX reads _ as a subscript and drops spaces. Write prose in INPUT.language (zh: Chinese, en: English); keep Lean names unchanged.',
  'overview is null unless INPUT.batch.final is true. In the final batch it explains how the declarations combine to prove the target.',
  'problemStatement, when present, is the informal problem the proof was written for; use it only for vocabulary. If it differs from the Lean statement, follow Lean.',
  'When INPUT.feedback is present it lists host check failures or auditor findings about previousOutput. Check each against the Lean source, fix the explanation and keep the parts that were not challenged.',
];
const writerAlignmentLines = (alignment: NonNullable<Alignment>) => [
  `INPUT.alignment is ${alignment}: also link phrases of your prose to the Lean text they translate. Each section has statementLinks and each step links, lists of {text, lean}. text is a phrase copied exactly from that statement or step text (the first occurrence is the one linked); lean is the Lean text it translates, copied verbatim (whitespace runs may differ).`,
  'A statementLinks lean must lie in the declaration\'s signature (for a theorem the source before its :=; for any other declaration anywhere in its source). A step link\'s lean must lie inside that step\'s own lean excerpts. Every theorem needs at least one statement link.',
  'Link what a reader would look up: each hypothesis, quantified variable, domain and the conclusion of a statement; in a step, the formula or claim and the Lean expression or tactic that establishes it. Prefer whole formulas ($...$) or whole clauses as text, and the smallest Lean term that carries the same meaning as lean. Keep each pair to the same mathematical content; do not link a phrase to Lean that means something else.',
];
const AUDITOR_LINES = [
  'Audit a natural-language explanation of a Lean proof. Judge it only against the Lean declarations in INPUT.units. You are not given the informal problem; the explanation is model-written and may be wrong.',
  'The explanation is written in batches (INPUT.batch). Declarations in proof/ that are not in INPUT.units belong to other batches and are audited there; their absence is not an omission.',
  'Write exactly one strict JSON object to OUTPUT.json with inputDigest (copied from INPUT), sections, overview and summary.',
  'sections has one item per INPUT.explanation.sections entry, in the same order and with the same declaration.',
  'statement.verdict is faithful if the prose states exactly the Lean signature: hypotheses, quantifiers, domains, types and coercions. It is mismatch if anything is added, dropped, weakened or strengthened, and unclear if you cannot tell.',
  'steps has one verdict per explanation step, in order. justified: the claim is true and the quoted Lean supports it as stated. gap: a needed reason or case is missing. invented: the step claims something the Lean proof does not do, or cites a declaration for something it does not provide. unclear: you cannot tell. Explain every verdict other than justified.',
  'Where goals are recorded, check each claim about an intermediate goal, or about what remains to be shown, against them. A claim that disagrees mathematically with the recorded goal is invented; a different notation is not.',
  'omissions lists substantive parts of the Lean proof that no step explains, such as a case, an induction step, an applied lemma or a nontrivial side condition. Quote the Lean text verbatim in lean. Bookkeeping such as intro, rfl or a cast-only rewrite is not an omission.',
  'overview.verdict is absent when INPUT.explanation.overview is null; otherwise consistent if it describes how these declarations prove the target, and inconsistent if not.',
  'Judge mathematical correctness and fidelity to the Lean proof, not style or language. summary states the main problems, or that there are none.',
];
// Separate guides keep the exact legacy ROLE.md bytes available to existing requests and resumable sessions.
const MATHEMATICAL_WRITER_LINES = [
  'Write a natural-language proof that explains the given Lean proof under INPUT.explanationPolicy = mathematical-steps-v1. INPUT.json holds a batch of declarations in dependency order, their Lean source and signatures, recorded tactic goals when available, proved dependency statements and the library theorems their terms use.',
  'Write exactly one strict JSON object to OUTPUT.json with inputDigest (copied from INPUT), sections and overview. Keep the output structure in OUTPUT.schema.json.',
  'sections has one item per INPUT.units entry, in the same order, with declaration equal to its name. title names its mathematical purpose. statement preserves the Lean signature: every mathematical hypothesis, quantifier, domain, type constraint and conclusion. Explain a coercion when it changes the mathematical object or domain; implementation-only elaboration needs no separate prose.',
  'The Lean source is the only authority. Follow its substantive argument: cases, induction hypotheses, intermediate results and lemma applications, retaining their dependency order. Combine adjacent routine introductions, unfolding, rewrites, casts and automation into a meaningful mathematical step. A step need not correspond to one tactic or line. Do not replace the proof with a different argument or claim a step the Lean proof does not take.',
  'Each step has text, uses and lean. lean quotes 1 to 8 verbatim excerpts of that declaration\'s Lean source that the mathematical step explains; a multi-line excerpt may cover the routine commands combined in the step. uses names the owned declarations and citableLibrary theorems relied on, by exact name.',
  'Cite every name in mustCite in the step that applies it. For a lemma application, explain which variables or objects are substituted, where its hypotheses have been established, and which conclusion follows. Use dependency statements as already proved results; explain their use here without proving them again. Routine arithmetic needs no citation but still needs its mathematical reason.',
  'Write each step as connected reasoning: identify the current goal and relevant available conditions, show the operation and key equalities or inequalities, state the result, and make clear how that result is used by the following step or closes the target. A formula may make a connection clear without an extra sentence. Do not skip a necessary transformation, side condition or case. Do not pad the proof with repeated statements of the problem, tactic logs, generic progress reports or fixed labels for these parts.',
  'When automation such as simp, ring, linarith, omega, norm_num, decide or positivity closes a goal, give the actual relation it proves and the identities, inequalities, hypotheses or finite cases that justify it. Naming the tactic, repeating the desired conclusion, or saying it is obvious is not that reason. If the needed reasoning cannot be established from the source, recorded goals or inspected library theorem, describe the limitation rather than inventing it.',
  'Where goals are recorded, keep intermediate claims, active cases and the goals automation closes mathematically consistent with them. Use mathematical notation for the same objects; do not translate the goal display line by line.',
  'A definition, instance or structure needs proof steps only for mathematical content that needs explaining, such as a recursion, proof field or termination argument; its statement describes what it defines. A theorem needs at least one step. Explain a definition unfolding or change of domain within the argument when understanding it is necessary; routine bookkeeping needs no standalone step.',
  'Write mathematics in LaTeX ($...$). Write Lean names, tactics and Lean expressions as inline code, never inside $...$, where TeX reads _ as a subscript and drops spaces. Write prose in INPUT.language (zh: Chinese, en: English); keep Lean names unchanged.',
  'overview is null unless INPUT.batch.final is true. In the final batch, explain the chain of mathematical results that proves the target and why they fit together; do not merely list declaration names.',
  'problemStatement, when present, is the informal problem the proof was written for; use it only for vocabulary. If it differs from the Lean statement, follow Lean.',
  'When INPUT.feedback is present it lists host check failures or auditor findings about previousOutput. Check each against the Lean source, fix missing reasons and connections, and keep the parts that were not challenged.',
];
const MATHEMATICAL_AUDITOR_LINES = [
  'Audit a natural-language explanation of a Lean proof under INPUT.explanationPolicy = mathematical-steps-v1. Judge it only against the Lean declarations in INPUT.units. You are not given the informal problem; the explanation is model-written and may be wrong.',
  'The explanation is written in batches (INPUT.batch). Declarations in proof/ that are not in INPUT.units belong to other batches and are audited there; their absence is not an omission.',
  'Write exactly one strict JSON object to OUTPUT.json with inputDigest (copied from INPUT), sections, overview and summary. Keep the existing verdicts and exact structure in OUTPUT.schema.json.',
  'sections has one item per INPUT.explanation.sections entry, in the same order and with the same declaration.',
  'statement.verdict is faithful if it states the mathematical content of the Lean signature: hypotheses, quantifiers, domains, type constraints and conclusion, including any coercion that changes the mathematical object or domain. Implementation-only elaboration needs no separate prose. It is mismatch if mathematical content is added, dropped, weakened or strengthened, and unclear if you cannot tell.',
  'steps has one verdict per explanation step, in order. justified means the quoted Lean supports the claim and the explanation supplies the mathematical reasoning needed to reach it. gap means a necessary reason, lemma instantiation, hypothesis check, transformation, case or connection to the adjacent steps is missing. A tactic name, a progress report or a repetition of the desired conclusion alone does not justify it. invented means the explanation claims something the Lean proof does not do, or cites a declaration for content it does not provide. unclear means you cannot tell. Explain every verdict other than justified, identifying the missing condition or inference the writer must supply.',
  'Read successive steps together. Check which earlier result each step uses, how a cited lemma is instantiated, how its hypotheses are met, what a key equality or inequality follows from, and how its result enables the next step or closes the target. Do not assume an unstated side condition or case. An already proved dependency need not be proved again.',
  'Where goals are recorded, check intermediate claims, active cases and claims about what remains to be shown against them. A mathematical disagreement is invented; equivalent notation and combining adjacent routine tactics are allowed.',
  'omissions lists substantive parts of the Lean proof with no explanation, including missing cases, induction reasoning, applied lemma content, necessary definition unfoldings or nontrivial side conditions. Quote the Lean text verbatim in lean. Routine introductions, rfl, rewrites and casts need no standalone step; if their mathematical effect is necessary to understand the argument, that effect must be explained within a relevant step. Judge their role, not the tactic name.',
  'overview.verdict is absent when INPUT.explanation.overview is null; otherwise consistent if it explains how these declarations combine to prove the target, and inconsistent if not.',
  'Judge correctness, fidelity and completeness of the mathematical argument. Concise steps may combine multiple routine commands; do not require a tactic-by-tactic narration or decorative labels. Missing reasoning is a gap even when the conclusion is true. summary states the concrete problems, or that there are none.',
];
const readableRoleLines = (role: InformalizationRole, lines: readonly string[]) => [
  lines[0]!.replace(INFORMALIZATION_EXPLANATION_POLICIES[0], INFORMALIZATION_EXPLANATION_POLICY),
  ...lines.slice(1),
  READABLE_MATH_NOTATION,
  role === 'write'
    ? 'Use the same reading standard for all prose, including the overview, summaries and the proof route. Phrase links still quote the exact Lean text opposite the mathematical explanation.'
    : 'Check that the statement and steps make sense without knowing Lean. If a hypothesis or an intermediate result is used by its implementation name alone, the justification is a gap. Say what mathematical condition or inference the writer must spell out.',
];
const auditorAlignmentLines = (alignment: NonNullable<Alignment>) => [
  `INPUT.alignment is ${alignment}: statements and steps carry links pairing a phrase of the prose with the Lean text it translates. A statement link whose phrase means something other than its Lean makes the statement a mismatch; such a step link makes the step invented. Explain which link is wrong.`,
  'INPUT.stepGoals gives, for each explanation step, the goals before the first and after the last tactic it quotes, as the explanation page shows them beside the step (null when none are recorded). '
    + (alignment === INFORMALIZATION_ALIGNMENTS[0] ? '' : 'When a step quotes only the head of a block tactic, such as `induction n with` or `have h : P := by`, and none of the tactics inside it, the goals after are those the head leaves to the tactics inside, in order, then the goals after the whole block. ')
    + 'Each step verdict also has goals: consistent if what the step says it starts from and shows agrees mathematically with those goals, inconsistent if it does not (explain how), unrecorded exactly when its stepGoals entry is null.',
];
const WRITER_OUTLINE_LINES = [
  'INPUT.outlinePolicy is proof-outline-v1: each section also has summary, one sentence (two at most) for a reader skimming the proof. It says in plain mathematical words what this declaration establishes and what it is used for later. It must be true of the Lean statement and claim nothing beyond it; it does not replace statement.',
  'In the final batch also write route, 2 to 6 stages that narrow the target to what the proof checks, in the order a reader should follow them. Each stage has claim (what this stage establishes, and why that is enough for the stage after it) and declarations (the exact names from INPUT.declarations that carry it out). The last stage lists the target. route is null before the final batch. Do not add a stage the Lean proof does not have, and do not describe a relation to an informal problem: only what the Lean declarations state.',
];
const AUDITOR_OUTLINE_LINES = [
  'INPUT.outlinePolicy is proof-outline-v1: each section verdict also has summary. It is faithful if the section\'s summary sentence is true of the Lean declaration and claims nothing the declaration does not establish, and mismatch otherwise (explain what is wrong).',
  'route.verdict is absent when INPUT.explanation.route is null. Otherwise it is consistent if every stage\'s claim is established by the declarations it lists, as Lean states them, and the stages in order lead to the target; it is inconsistent if a claim is unsupported, a listed declaration plays no such part, or the order misdescribes how the declarations depend on each other (explain). INPUT.declarations lists every declaration of the proof; those outside INPUT.units are in proof/.',
];
const instructions = (lines: readonly string[], alignment: Alignment, extra: (alignment: NonNullable<Alignment>) => readonly string[],
  outline: readonly string[] = []) => [...lines, ...alignment ? extra(alignment) : [], ...outline, ...SHARED_INSTRUCTIONS].join('\n');
export const INFORMALIZATION_WRITER_INSTRUCTIONS = instructions(WRITER_LINES, undefined, writerAlignmentLines);
export const INFORMALIZATION_AUDITOR_INSTRUCTIONS = instructions(AUDITOR_LINES, undefined, auditorAlignmentLines);
/** ROLE.md for a role; absent policy preserves legacy bytes, and alignment adds its independent rules. */
export const informalizationRoleInstructions = (role: InformalizationRole, alignment?: Alignment, explanationPolicy?: ExplanationPolicy,
  outlinePolicy?: OutlinePolicy) => {
  const writing = role === 'write';
  const lines = explanationPolicy ? (writing ? MATHEMATICAL_WRITER_LINES : MATHEMATICAL_AUDITOR_LINES) : (writing ? WRITER_LINES : AUDITOR_LINES);
  return instructions(explanationPolicy === INFORMALIZATION_EXPLANATION_POLICY ? readableRoleLines(role, lines) : lines,
    alignment, writing ? writerAlignmentLines : auditorAlignmentLines, outlinePolicy ? (writing ? WRITER_OUTLINE_LINES : AUDITOR_OUTLINE_LINES) : []);
};
