import fs from 'node:fs';
import { scheduleMathTimeout } from '../math/mathTimers';
import { getFormalizationRoleOutputSchema, getFormalizationRoleOutputValidator,
  getStructuredFormalizationReviewOutputSchema } from '../math/formalizationRoleContract';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import { parse as parseToml } from 'smol-toml';
import { createCodexMathSession, type MathAgentFailureDiagnostic, type MathAgentOptions, type MathAgentSession } from '../runtime/codexSession';
import { warmFormalizationPackages } from '../runtime/formalizationSandbox';
import { DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT } from '../math/mathProofEnvironmentCache';
import { readMathBuildManifest } from '../math/mathBuildManifest';
import { canonicalMathJson, mathDigest, readMathText, withMathRuntimeLease, writeMathJsonDurable } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin, repositoryRelativePath } from '../math/paths';
import { projectMathematicsRuntimeEnvironment, resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { getLeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { assertMathRetrievalCorpus } from '../math/mathRetrievalCorpus';
import { eraseFormalizationProofs } from '../math/formalizationSource';
import { assertFormalizationCandidate, bootstrapFormalizedProblem, formalizationCandidateSchema, formalizationDigest,
  assertFormalizationCompiledCandidate, formalizationCompiledCandidate, type FormalizationCompiledCandidate,
  formalizationInputDigest, formalizationReviewInput, formalizationReviewSchema, formalizationSnapshotSchema, formalizationTranslationSchema,
  directFormalizationEvidenceSchema, prepareFormalization, readFormalizationArtifact, readFormalizationRequest, writeFormalizationArtifact,
  type FormalizationCandidate, type FormalizationEvidence, type FormalizationRequest } from '../math/formalization';
import { elaborateFormalization, type FormalizationElaboration } from './formalizationElaboration';
import { formalizationPlanSchema, assertFormalizationPlan, assertFormalizationPlanReady, assertFormalizationPlanCandidate,
  type FormalizationPlan } from '../math/formalizationPlan';
import { claimShapeRejection } from '../math/formalizationClaimShape';
import { formalizationExemplarInput, formalizationExemplarInstructions, type FormalizationExemplar } from '../math/formalizationExemplars';
import { nameCompatibilityRejection, readFormalizationCompatibilityNames, unavailableFormalizationNames,
  type CompatibilityTarget } from '../math/formalizationNameCompatibility';
import { defaultFormalizationWorkflow, formalizationModelConfigurations, formalizationModelConfigurationDigest,
  distinctFormalizationModelConfigurations } from '../math/formalizationWorkflow';
import { compareFormalizationReference } from './formalizationReference';
import { assertFormalizationReferenceResult, type FormalizationReferenceResult } from '../math/formalizationReference';
import { checkFormalizationFidelity, shareFormalizationFidelityComparisons } from './formalizationFidelity';
import { selectFormalizationLibraryPack } from '../math/formalizationLibrary';
import { assertStructuredSemanticReview, resolveStructuredReviewPanel, structuredReviewAspects,
  formalizationReviewInstructions, STRUCTURED_REVIEW_PROTOCOL,
  type StructuredReviewInput } from '../math/formalizationSemanticReview';
import { parseLeanStatementContexts } from '../math/leanStatementContext';
import { allowsOmittedLibraryContext, hasStructureContext } from '../math/leanStatementSemantic';
import { assertFormalizationRetrieval, formalizationRetrievalSchema, retrieveFormalizationPlan } from '../math/formalizationRetrieval';
import type { lookupLeanLibrarySymbols } from '../math/leanLibrarySymbols';
import { allowanceReached, beginRequestUsage, buildTokenBudget, initializeRequestUsageAccounting, initializeUsageAccounting,
  modelDispatchAllowed, reportedTotalTokens, type RequestUsageAccounting, type UsageAccounting } from './usageBudget';
import { requestUsageAccountingSchema } from './archive';
import { acquireMathModelSlot, configuredMathModelSlots, type MathModelSlot } from '../math/mathModelSlot';
import { FORMALIZATION_FALSIFICATION_AUTHOR_INSTRUCTIONS, FORMALIZATION_FALSIFICATION_REVIEW_INSTRUCTIONS,
  FORMALIZATION_REFUTE_INSTRUCTIONS, formalizationRefutationInput, formalizationRefutationOutputSchema,
  refutationProofRejection, type FormalizationRefutationProbe } from '../math/formalizationRefutation';
import { checkFormalizationRefutations } from './formalizationRefutation';
import { focusFormalizationContext, FOCUSED_FORMALIZATION_CONTEXT_PROTOCOL,
  shareFormalizationContext, SHARED_FORMALIZATION_CONTEXT_PROTOCOL } from './formalizationContext';

const roleSchema = z.enum(['plan', 'generate', 'backtranslate', 'compare', 'refute']);
type Role = z.infer<typeof roleSchema>;
const sessionSchema = z.object({
  role: roleSchema, round: z.number().int().positive(), threadId: z.string().optional(), turnId: z.string().optional(),
  status: z.string(), inputDigest: z.string(), outputDigest: z.string().optional(), model: z.string(), effort: z.string(),
  reviewerId: z.string().optional(), configurationDigest: z.string().optional(),
  completionReason: z.literal('validated-output').optional(), isolationReceipt: z.record(z.unknown()).optional(),
  roleContract: z.object({ schema: z.literal('theorem-os.formalization-role-contract.v1'),
    roleInstructionsSha256: z.string().regex(/^[a-f0-9]{64}$/u), outputSchemaSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().optional(),
  failureDiagnostic: z.object({ code: z.string(), httpStatusCode: z.number().int().optional(),
    reason: z.enum(['account_concurrency_limit', 'upstream_request_failed', 'invalid_tool_call_arguments']).optional() }).strict().optional(),
  workspace: z.string().refine(value => repositoryRelativePath(value) !== undefined).optional(),
  candidateCounted: z.boolean().optional(),
  turns: z.number().int().nonnegative(), usage: z.record(z.unknown()),
  usageAccounting: z.object({ startedTurns: z.number().int().nonnegative(), reportedTurns: z.number().int().nonnegative(),
    pending: z.boolean(), incomplete: z.boolean() }).strict(),
  requestUsageAccounting: requestUsageAccountingSchema.optional(),
}).strict();
const stateSchema = z.object({
  schema: z.literal('theorem-os.formalization-state.v1'), requestDigest: z.string(),
  status: z.enum(['running', 'approved', 'exhausted', 'stopped']), rounds: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(), environmentDigest: z.string(), profileDigest: z.string(),
  sessions: z.array(sessionSchema), feedback: z.string().optional(), previousCandidate: formalizationCandidateSchema.optional(),
  error: z.string().optional(),
  activeSince: z.number().int().nonnegative().optional(), rejectedCandidates: z.array(z.string()).optional(),
  unknownRounds: z.number().int().positive().optional(),
  unsupportedTaskKind: z.enum(['decision', 'construction']).optional(),
  generatedCandidates: z.number().int().nonnegative().optional(),
  activeRound: z.object({ directory: z.string().regex(/^round-\d+-[a-f0-9-]{36}$/u),
    feedback: z.string().optional(), previousCandidate: formalizationCandidateSchema.optional(),
    planning: z.object({ round: z.number().int().positive(), feedback: z.string().optional() }).strict().optional(),
    retrievalDigest: z.string().optional(), elaborationDigest: z.string().optional(),
    referenceDigest: z.string().optional() }).strict().optional(),
}).strict();
type SessionRecord = Omit<z.infer<typeof sessionSchema>, 'turns' | 'usageAccounting' | 'requestUsageAccounting'> & {
  turns: number; usageAccounting: UsageAccounting; requestUsageAccounting?: RequestUsageAccounting };
type State = Omit<z.infer<typeof stateSchema>, 'sessions'> & { sessions: SessionRecord[] };
const summarizeRun = (directory: string, request: FormalizationRequest, state: State) => ({
  status: state.status as 'approved' | 'exhausted' | 'stopped', directory, rounds: state.rounds,
  modelInvoked: request.execution === 'model' && state.sessions.some(item => item.turns > 0),
  tokenBudget: buildTokenBudget(request.maxTotalTokens, state.sessions,
    state.sessions.length > 0 && state.sessions.every(item => item.requestUsageAccounting)
      ? 'provider-observed-upstream-request-limit' : 'provider-observed-dispatch-limit'),
  ...(request.workflow ? { candidateSelection: request.workflow.candidateSelection, candidatesTried: state.generatedCandidates ?? 0,
    firstCandidateApproved: state.status === 'approved' && state.generatedCandidates === 1,
    distinctModelConfigurations: distinctFormalizationModelConfigurations(request, request.workflow),
    roleTurns: Object.fromEntries(roleSchema.options.filter(role => role !== 'refute' || request.falsification).map(role => [role,
      state.sessions.filter(item => item.role === role).reduce((sum, item) => sum + item.turns, 0)])) } : {}),
  ...(request.reviewMode === 'direct' ? { candidateSelection: 'first-compiled', candidatesTried: state.generatedCandidates ?? 0,
    firstCandidateApproved: state.status === 'approved' && state.generatedCandidates === 1,
    roleTurns: { generate: state.sessions.filter(item => item.role === 'generate').reduce((sum, item) => sum + item.turns, 0) } } : {}),
  ...(state.error ? { error: state.error } : {}),
});
type Options = {
  openSession?: (options: MathAgentOptions) => Promise<MathAgentSession>;
  elaborate?: typeof elaborateFormalization;
  compareReference?: typeof compareFormalizationReference;
  lookupSymbols?: typeof lookupLeanLibrarySymbols;
  refute?: typeof checkFormalizationRefutations;
  preparePackages?: typeof warmFormalizationPackages;
  env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  waitForRetry?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: { event: string; round: number; role?: Role; error?: string }) => void;
  onCompiledCandidate?: (candidate: FormalizationCompiledCandidate) => void | Promise<void>;
};
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const infrastructureFailure = (message: string) =>
  /(?:formalization_(?:sandbox|relay|profile|build|library|retrieval|checkpoint|fidelity_comparison_interrupted)|math_library_catalog_(?:changed|source_changed|environment_changed)|math_model_api_key_missing|math_codex_(?:transport_closed|rpc_failed|session_binding_mismatch))/u.test(message);
class FormalizationRoleFailure extends Error {
  constructor(status: string, readonly diagnostic?: MathAgentFailureDiagnostic) {
    super('formalization_role_incomplete:' + status + (diagnostic ? ':' + diagnostic.code +
      (diagnostic.reason ? ':' + diagnostic.reason : '') : ''));
  }
}
const retryableRoleFailure = (cause: unknown) => {
  if (!(cause instanceof FormalizationRoleFailure) || !cause.diagnostic) return false;
  const { code, httpStatusCode, reason } = cause.diagnostic;
  if (httpStatusCode !== undefined && httpStatusCode < 500 && httpStatusCode !== 408 && httpStatusCode !== 429) return false;
  return code === 'other' && Boolean(reason) || ['rateLimitExceeded', 'flexUnavailable', 'serverOverloaded', 'httpConnectionFailed',
    'responseStreamConnectionFailed', 'internalServerError', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(code);
};
// An unknown semantic verdict is not a mismatch, so the source is never
// blacklisted and the next round may re-review it. Repeated consecutive unknown
// rounds with no intervening concrete judgment show that more rounds are not
// resolving the ambiguity, so the run ends exhausted instead of re-generating
// candidates forever under an unlimited round budget.
const MAX_UNKNOWN_ROUNDS = 3;
const INLINE_ROLE_CONTEXT_BYTES = 64 * 1024;
const INLINE_REVIEW_CONTEXT_BYTES = 512 * 1024;
const snapshotFieldInstructions = 'For each target, context.semantic is an object with schema, rawType (string), kernelType (tagged JSON expression) and localMeaningClosure (array). context.structures is an object with schema and entries; iterate context.structures.entries, an array of {name,class,fields}, where fields is an array of {name,type}. context.constants is an array of {name,module,type,definition?}. The omitted list and references belong to context. The reviewer translation is at INPUT.translation, outside the snapshot. Use these paths directly; do not spend requests discovering the field layout, print truncated slices as if they were complete observations, or reread observations already supplied.';
/** Navigation only: full raw observations stay in the frozen input, unchanged. */
function snapshotNavigation(role: Role, input: unknown): string | undefined {
  const review = role === 'compare' ? input as StructuredReviewInput : undefined;
  const snapshot = role === 'backtranslate' ? input as FormalizationEvidence['snapshot'] : review?.observation.snapshot;
  if (!snapshot?.targets || !['backtranslate', 'compare'].includes(role)) return;
  const root = role === 'backtranslate' ? '$' : '$.observation.snapshot';
  const index = {
    snapshotPath: root,
    snapshotDigest: review?.observation.snapshotDigest ?? (input as { snapshotDigest?: string }).snapshotDigest,
    source: snapshot.source,
    ...(review ? { original: review.original, header: review.header, candidate: review.candidate, translation: review.translation } : {}),
    targets: snapshot.targets.map((target, index) => ({ index, name: target.name,
      type: target.context.type, bindings: target.context.bindings, omitted: target.context.omitted,
      remainingFields: Object.entries(target.context).filter(([key, value]) => value !== undefined && !['type', 'bindings', 'omitted'].includes(key))
        .map(([key, value]) => ({ path: `${root}.targets[${index}].context.${key}`,
          bytes: Buffer.byteLength(canonicalMathJson(value)) })),
    })),
  };
  const text = canonicalMathJson(index);
  return Buffer.byteLength(text) <= INLINE_ROLE_CONTEXT_BYTES ? text : undefined;
}
const reviewOutputFeedback = (cause: unknown) => [
  'OUTPUT.json was not accepted. Repair the output contract in this same independent reviewer thread.',
  'Host validation error (data): ' + JSON.stringify(errorText(cause).slice(0, 16000)),
  'Copy originalFragment and candidateFragment directly from the decoded INPUT.json strings, preserving whitespace and newlines. Do not reconstruct an elaborated type, switch pretty-printer notation or add implicit arguments inside a quotation. A contiguous excerpt of the supplied candidate declaration is sufficient when it supports your explanation.',
  'Preserve your independent mathematical assessment; a valid unknown or changes_requested verdict is acceptable. This feedback supplies no semantic verdict. Do not change INPUT.json, ROLE.md or OUTPUT.schema.json.',
  'Write the complete corrected JSON atomically to OUTPUT.json, then stop.',
].join('\n');
const generationOutputFeedback = (cause: unknown) => [
  'OUTPUT.json failed source or coverage admission. Repair it in this same generator thread using the existing candidate and library observations.',
  'Host validation error (data): ' + JSON.stringify(errorText(cause).slice(0, 16000)),
  ...(errorText(cause).startsWith('formalization_placeholder_outside_proof') ? [
    'Definitions and statement types must contain no _, ?holes, sorry or admit, even when Lean could infer an underscore. Use ordinary implicit application, a named instance or inferInstance where appropriate. Establish local instances before quantifying objects that depend on them.',
  ] : []),
  ...(errorText(cause).startsWith('formalization_unsupported_declaration') ? [
    'Use only ordinary named def/abbrev/instance/theorem/lemma declarations and the allowed scope/import commands. Replace unsupported structure or inductive declarations with complete ordinary predicates or existential quantifiers.',
  ] : []),
  'Preserve every domain, hypothesis, conclusion and definition. Copy coverage.originalText from the decoded INPUT.statement exactly and map it to generated theorem names. Keep theorem bodies := by sorry. Do not change INPUT.json, ROLE.md or OUTPUT.schema.json.',
  'Rewrite the complete corrected JSON atomically to OUTPUT.json, then stop. Host Lean compilation still follows source admission; this feedback is not semantic or proof approval.',
].join('\n');
const roleInstructions: Record<Role, string> = {
  plan: [
    'Plan a faithful Lean formalization of the complete original mathematical task in INPUT.json before generating declarations.',
    'Write exactly one strict JSON object to OUTPUT.json with schema,taskKind,spans,objects,assumptions,conclusions,definitions,unresolved.',
    'Produce the smallest complete mathematical inventory, not a Lean implementation or a proof. A complete source clause can be one span reused by its objects and conclusions; do not split every word or symbol into a separate record.',
    'Empty assumptions, definitions and unresolved arrays are correct when the source has no separate hypotheses, specialized definitions or ambiguity. Ordinary quantifiers, equality and number notation do not require invented library identifiers, instance helpers or local abbreviations. Still record every mathematical domain, convention and specialized concept that affects the claim.',
    'schema is theorem-os.formalization-plan.v1; taskKind is prove, decision or construction. Classify yes/no questions as decision. Do not assume the answer is yes, and never replace a requested decision with excluded middle.',
    'Use prove for a specified proposition, including an existence theorem that asks to explicitly construct a witness and prove its stated properties. The word construct does not by itself make a theorem a construction task. Preserve the explicit witness definition and every required property proof; do not reduce an explicit construction requirement to a bare existential statement.',
    'Use decision when the source leaves the truth or existence of the answer open. Use construction for an object, formula or algorithm deliverable without a complete stated theorem-proof obligation. Classify from the source, never relabel an unsupported task merely to pass admission.',
    'spans is an array of {id,start,end,text}: exact nonempty original text at JavaScript UTF-16 slice(start,end), without splitting a surrogate pair. Use stable unique alphanumeric IDs.',
    'objects is [{id,spanIds,description,leanType}]; describe domains and quantifiers explicitly.',
    'assumptions is [{id,spanIds,mathematics}]; list every hypothesis or convention, never a desired conclusion.',
    'conclusions is [{id,spanIds,mathematics,targetNames,assumptionIds}]; cover every original subquestion and proposed target, with faithful domains and quantifiers.',
    'definitions is [{id,spanIds,mathematics,implementation,leanNames,dependsOn,justification}]; implementation is existing (pinned library) or new (local def/abbrev/named instance). dependsOn may contain only id values from this plan.definitions array, never object, assumption, conclusion, span or unresolved IDs or Lean names. Use [] when there are no definition dependencies; the definition dependency graph must be acyclic.',
    'Specify the actual meaning of specialized terms and map them to library constants or complete supported definitions. Every later local definition must be planned as new.',
    'Plan each conclusion at the type the source gives it, in the most unfolded form that still names the same mathematics. Independent carriers get independent universes (Type*), and an unrestricted carrier is not pinned to Type. An order or finiteness condition is a Fintype instance on the carrier with Fintype.card, not a Nat.card hypothesis. Name a library predicate at the type the source means, for example Nat.Prime for a natural number rather than the general Prime. A conclusion about how two given elements or objects relate is planned as the explicit equation with its own witness, not as a bundled library relation that hides the quantifier: for example plan an existential conjugating element with the equation itself, not an IsConj application. Keep the source order of the operands and the source association, and add no grouping parentheses the source does not have; the checker relates a candidate to a reference only by definitional unfolding and simple rewriting, so an equivalent claim written with another association, orientation or behind a library definition is not related and does not count. When the source says two structures are the same without placing them inside one named ambient object, plan Nonempty of the structure equivalence rather than an equality of subobjects, and never construct that equality through a derived operation the source does not name.',
    'unresolved is [{id,spanIds,description}]. Record ambiguity, missing definitions, unknown library support and unsupported source constructs honestly. An unresolved plan cannot generate a proof task.',
    'Every record must cite nonempty spanIds from spans. All IDs and references must be unique and valid. No custom structures, inductives, notation, metaprogramming, axioms, opaque placeholders or changed dependencies are supported.',
    'Use INPUT feedback to repair this plan. Definition property checks can expose errors; they do not replace source fidelity review.',
  ].join('\n'),
  generate: [
    'Formalize the complete mathematical problem in INPUT.json as Lean 4 statements, not solutions.',
    'Write exactly one strict JSON object to OUTPUT.json with keys source, coverage, assumptions, assumptionsExplanation, definitionsExplanation.',
    'source is one Lean file. Use only installed standard Lean or the pinned Mathlib environment requested in INPUT.',
    'Every requested conclusion or subproblem must appear in a theorem/lemma, with explicit binders, faithful quantifiers and a body := by sorry.',
    'When INPUT contains a plan, implement its named conclusions and new definitions exactly; preserve every source-to-target and dependency mapping. Coverage excerpts must include each planned conclusion source span.',
    'State each conclusion at the type the source gives it, not at a shorter abbreviation a checker cannot relate to it: an unrestricted carrier at its own universe (Type*), an order or finiteness condition as a Fintype instance with Fintype.card rather than a Nat.card hypothesis, a natural-number predicate at its nat-specific name such as Nat.Prime, a finite family of objects as a function from a Fintype index type rather than a Finset of those objects when the source only says finitely many, and a sameness of two structures as Nonempty of the structure equivalence when the source names no common ambient object to compare inside.',
    'Write a claim about how two given elements or objects relate as the explicit equation with its own witness rather than as a library relation that hides the quantifier, keeping the source operand order and association: an existential conjugating element with the equation it satisfies, not an IsConj application, and no grouping parentheses the source does not have. An equivalent statement in another association, orientation or behind a library definition is not related by definitional unfolding, so it does not represent the same conclusion.',
    'This file has only the imports and opens you write, so qualify names instead of relying on a namespace or notation being open by default.',
    'Use ordinary def/abbrev/named instance for needed definitions; preserve their full mathematical content.',
    'Supported commands outside declarations: import, namespace, section, end, variable(s), universe(s), open, include, omit, noncomputable section.',
    'No axioms, constants, unsafe/opaque/partial, structure/inductive, notation, custom syntax, attributes, deriving, # commands, run_cmd, set_option, placeholders in types/definitions, new dependencies or environment changes.',
    'Do not assume a conclusion, weaken the goal, replace an unavailable definition with True, or remove a difficult subproblem.',
    'coverage is an array of {originalText,targetNames,explanation}; quote exact excerpts of the input and cover every target and requested part.',
    'assumptions lists all mathematical hypotheses; explain all conventions and definitions, including implicit ones.',
    'Use prior compiler and semantic-review feedback to revise the entire candidate. If a concept cannot be represented, report that accurately in your notes; it must not be silently omitted.',
  ].join('\n'),
  backtranslate: [
    'Independently interpret the formal Lean snapshot in INPUT.json. You are not given the intended original problem.',
    'Write exactly one strict JSON object to OUTPUT.json with snapshotDigest, mathematics, assumptions, definitions, targets.',
    'Each target is {name,mathematics}. Translate every supplied elaborated type, its quantifiers, hypotheses and conclusions.',
    'Inspect the actual source definitions and imported constant context. Do not infer intent from declaration names.',
    'Expose vacuous hypotheses, empty domains, missing conditions and definitions that encode a conclusion.',
    'Do not read other workspaces, search for the original problem, or fill missing semantics from benchmark memory.',
  ].join('\n'),
  compare: [
    'Review a formalization for exact mathematical fidelity, independently of its author and backtranslator.',
    'INPUT.json contains the verbatim original problem, proposed notes, formal snapshot, independent backtranslation and binding digests.',
    'Write exactly one strict JSON object to OUTPUT.json with inputDigest,snapshotDigest,translationDigest,verdict,summary,checks,issues.',
    'verdict is approved, changes_requested or unknown; checks has booleans equivalent,complete,assumptions,definitions; issues is an array of concrete discrepancies.',
    'Approve only if every requested question is fully represented, all quantifiers and domains are faithful, assumptions are neither strengthened nor omitted, and every definition is mathematically faithful.',
    'Check the actual source and elaborated types as well as the backtranslation. Compilation alone does not establish equivalence.',
    'Reject vacuous reformulations, assumed conclusions, trivial/opaque replacements, missing cases or subproblems, undeclared conventions, incomplete imported context, or unresolved ambiguity.',
    'Check the definition/dependency plan against the original as well; a model-authored plan is not trusted evidence of completeness. Yes/no questions must not be assumed affirmative or encoded merely as excluded middle.',
    'Report a shape substitution as a concrete discrepancy, not as an equivalent restatement. When the source states a relation between two given objects with its own witness, a candidate that replaces it by a bundled library relation hides the witness the source quantifies over, and when the source says two structures are the same without naming one ambient object containing both, a candidate that states an equality of subobjects asserts more than the source. Both change what is being claimed even though each is provable from the other, so name the substituted claim and the source claim in the issue.',
    'If uncertain, use unknown and explain the missing evidence. A semantic judgment here is model review, not human review or proof verification. Do not consult other reviewers or workspaces.',
  ].join('\n'),
  refute: FORMALIZATION_REFUTE_INSTRUCTIONS,
};
const directGenerationInstructions = [
  'Translate the complete mathematical task in INPUT.json into Lean 4 declarations in the requested pinned environment.',
  'Submit one JSON object to OUTPUT.json using the supplied schema: source, coverage, assumptions, assumptionsExplanation, definitionsExplanation. No separate planning document, backtranslation or reviewer report is needed.',
  'source is a complete Lean file with imports, ordinary definitions and theorem targets. Every requested conclusion must be represented with its actual domains, quantifiers, hypotheses and definitions; each theorem body is := by sorry. Do not solve or prove the theorem during formalization.',
  'Allowed source syntax is imports, namespaces, sections, variable and universe declarations, and ordinary named def, abbrev, instance, theorem and lemma declarations. Structure and inductive declarations, custom notation and metaprogramming are unsupported; do not use them.',
  'Source admission rejects _, ?holes, sorry and admit in definitions and statement types, including inferable instance arguments. Use normal implicit application or explicit named instances/inferInstance; establish local instances before quantifying dependent objects. Only theorem proof bodies may contain sorry.',
  'Represent towers and nested families with ordinary predicates or existential quantifiers, not new structures. Preserve successive inclusions and construct each step over the preceding object. Ambient universes must accommodate the required embeddings.',
  'For a requested equivalence, necessity and sufficiency belong to one iff target; do not create duplicate forward and reverse targets. Proof-method, citation and auxiliary-lemma proof requirements remain in the original task for the subsequent proof stage; they do not require additional formalization targets. Add other theorem targets only for additional mathematical conclusions explicitly requested as independent statements.',
  'Use installed library declarations when they express the source faithfully. Inspect the pinned library only for a specific missing declaration or mathematical meaning. The host compiles the submitted file and returns diagnostics for repair.',
  'Keep exact original quotations in coverage.originalText and map them to every generated theorem name. Briefly state the actual assumptions and definitions. Do not weaken the task, assume its conclusion, replace missing definitions with True or add unsupported axioms or syntax.',
  'Prepare source and its coverage/definition notes together. Check that one complete encoding against the original, then submit it for host compilation; do not postpone coverage until after exploring more encodings. Compilation checks Lean types, not mathematical meaning.',
  'If a complete local candidate already compiled, reuse its exact file bytes in source and submit after checking source coverage. Revise it only for a concrete missing requirement or diagnostic; an erased-proof, unused-parameter or deprecated-alias warning alone does not require another encoding. Write OUTPUT.json atomically and stop.',
].join('\n');
// Omit legacy benchmark shape prescriptions from this inventory prompt so the
// planner can submit a small, source-bound result. Admission checks still apply.
const taskPreservingPlanInstructions = [
  'Plan the complete mathematical task in INPUT.json. Submit a concise inventory, not Lean declarations or proofs.',
  'Write one strict JSON object with schema="theorem-os.formalization-plan.v1", taskKind, spans, objects, assumptions, conclusions, definitions and unresolved, using OUTPUT.schema.json.',
  'taskKind is prove, decision or construction. A yes/no question is a decision; never assume an affirmative answer or replace it by excluded middle.',
  'Use prove for a specified proposition, including an existence theorem that asks to explicitly construct a witness and prove its stated properties. The word construct does not by itself make a theorem a construction task. Preserve the explicit witness definition and every required property proof; do not reduce an explicit construction requirement to a bare existential statement.',
  'Use decision when the source leaves the truth or existence of the answer open. Use construction for an object, formula or algorithm deliverable without a complete stated theorem-proof obligation. Classify from the source, never relabel an unsupported task merely to pass admission.',
  'objects records every mathematical domain and quantifier, with a short description and intended Lean type. Describe a structured object such as a finite tower in one record, including its quantified indices, generators and exponents; do not repeat its internal binders as separate objects unless the source uses them independently. assumptions records actual premises and conventions, never a conclusion.',
  'conclusions records every distinct requested mathematical conclusion, with its meaning, proposed qualified theorem names and applicable assumption IDs. A single iff target includes both directions; a request to prove necessity and sufficiency does not also need two duplicate implication targets unless separate theorems are explicitly requested. Preserve all quantifiers, hypotheses, directions of equivalence and boundary cases. Keep proof-method and citation restrictions with the relevant conclusion; do not invent auxiliary theorem targets to encode those instructions.',
  'definitions records only specialized meanings that need an existing library constant or a new supported def/abbrev/named instance, with its dependency IDs and justification. dependsOn may contain only id values from this plan.definitions array, never object, assumption, conclusion, span or unresolved IDs or Lean names; use [] when there are no definition dependencies. State each complete mathematical contract once. Leave exact Lean binder encodings, universe arithmetic, sequence indexing and typeclass plumbing to the generator. Do not invent definitions for ordinary arithmetic, equality, quantifiers or number notation.',
  'Use short unique IDs and reuse source spans. Empty assumptions, definitions and unresolved arrays are valid when nothing belongs there. A short sentence per record is enough; do not enumerate alternative inventories.',
  'Inspect the pinned library only for a specific unresolved mathematical meaning. Record genuine ambiguity, missing definitions or unsupported constructs in unresolved; never silently omit them or assume their answer.',
  'All references must resolve, definition dependencies must be acyclic, and targetNames names only the proposed conclusion theorems. Custom structures, inductives, syntax, metaprogramming, axioms and changed dependencies are unsupported.',
  'Use supplied feedback to repair an earlier plan, then write OUTPUT.json atomically and stop. Compilation and independent semantic reviewers will check later stages; this plan is not their approval.',
].join('\n');
const refutationRejection = (refuted: FormalizationRefutationProbe[]) => 'formalization_refuted: Lean proved the negation of ' +
  refuted.map(probe => probe.target).join(', ') + ' with every universe parameter at 0, using only the axioms propext, Classical.choice and Quot.sound. ' +
  'The source is a true exercise, so the candidate states something the source does not claim.\n' +
  refuted.map(probe => probe.target + ': ' + probe.explanation.slice(0, 2000) + '\nChecked proof of the negation:\n' + probe.proof.slice(0, 4000)).join('\n\n');

export function readFormalizationState(directory: string): State | undefined {
  const file = path.join(directory, 'state.json'); assertMathCanonicalPath(file);
  return fs.existsSync(file) ? stateSchema.parse(JSON.parse(readMathText(file, 8_000_000))) as State : undefined;
}

/** Frozen direct requests generate and compile; older reviewed requests retain their independent role pipeline. */
export async function runFormalization(directory: string, root: string, options: Options = {}) {
  directory = path.resolve(directory); root = path.resolve(root);
  assertMathCanonicalPath(directory);
  if (isMathPathWithin(root, directory) || isMathPathWithin(directory, root)) throw new Error('formalization_directory_must_be_external');
  const request = readFormalizationRequest(directory), requestDigest = formalizationDigest(request);
  const direct = request.reviewMode === 'direct';
  const structured = request.schema === 'theorem-os.formalization-request.v3';
  const semanticContext = request.contextProtocol !== undefined;
  const structureContext = hasStructureContext(request.contextProtocol);
  const boundedLibraryContext = allowsOmittedLibraryContext(request.contextProtocol);
  const reviewStructureContext = boundedLibraryContext ? 'bounded' as const : structureContext;
  if (request.execution === 'replay' && !options.openSession) throw new Error('formalization_replay_requires_preset_sessions');
  readMathBuildManifest(request.buildManifestRef, root, path.join(root, 'out/main'));
  if (mathDigest(readMathText(request.buildManifestRef, 8_000_000)) !== request.buildDigest) throw new Error('formalization_build_changed');
  const env = resolveMathematicsRuntimeEnvironment(options.env ?? process.env);
  const environmentDigest = formalizationDigest(projectMathematicsRuntimeEnvironment(env));
  const profileFiles = (profile: string) => {
    const files = ['config.toml', 'models.json'].map(name => {
      const file = path.join(profile, name);
      return { name, digest: fs.existsSync(file) ? mathDigest(readMathText(file, 2_000_000)) : null };
    });
    const configFile = path.join(profile, 'config.toml');
    const config = fs.existsSync(configFile) ? parseToml(readMathText(configFile, 2_000_000)) : {};
    if (typeof config.model_catalog_json === 'string') {
      if (!path.isAbsolute(config.model_catalog_json)) throw new Error('formalization_model_catalog_must_be_absolute');
      const file = path.resolve(config.model_catalog_json); assertMathCanonicalPath(file);
      files.push({ name: 'model_catalog_json:' + file, digest: fs.existsSync(file) ? mathDigest(readMathText(file, 2_000_000)) : null });
    }
    return files;
  };
  const currentProfileDigest = () => request.execution === 'replay' ? formalizationDigest('preset-replay') : request.workflow ?
    formalizationDigest(formalizationModelConfigurations(request, request.workflow).map(config => ({
      configurationDigest: formalizationModelConfigurationDigest(config), files: profileFiles(config.profile) }))) :
    formalizationDigest(profileFiles(request.profile));
  const profileDigest = currentProfileDigest();
  const controller = new AbortController(), externalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  process.once('SIGINT', externalAbort); process.once('SIGTERM', externalAbort);
  try {
    return await withMathRuntimeLease({ lockPath: path.join(directory, 'run.lock'), flockExecutable: '/usr/bin/flock', signal: controller.signal }, async lease => {
      const state: State = readFormalizationState(directory) ?? { schema: 'theorem-os.formalization-state.v1' as const,
        requestDigest, status: 'running' as const, rounds: 0, elapsedMs: 0, environmentDigest, profileDigest, sessions: [] };
      if (state.requestDigest !== requestDigest || state.environmentDigest !== environmentDigest || state.profileDigest !== profileDigest)
        throw new Error('formalization_resume_identity_changed');
      if (state.activeSince !== undefined) state.elapsedMs += Math.max(0, Date.now() - state.activeSince);
      delete state.activeSince;
      for (const session of state.sessions) initializeUsageAccounting(session);
      const startedAt = Date.now(), elapsedBefore = state.elapsedMs;
      const remaining = () => request.maxRunSeconds === 0 ? Infinity : request.maxRunSeconds * 1000 - elapsedBefore - (Date.now() - startedAt);
      const cancelTimer = request.maxRunSeconds === 0 ? undefined : scheduleMathTimeout(() => controller.abort(), Math.max(1, remaining()));
      const stageTimeout = (seconds: number) => Math.min(seconds === 0 ? Infinity : seconds * 1000, Math.max(1, remaining()));
      const save = (active = true) => {
        state.elapsedMs = elapsedBefore + Date.now() - startedAt;
        if (active) state.activeSince = Date.now(); else delete state.activeSince;
        writeMathJsonDurable(path.join(directory, 'state.json'), state);
      };
      const summary = () => summarizeRun(directory, request, state);
      const event = (name: string, role?: Role, error?: string) => options.onEvent?.({ event: name, round: state.rounds, role, error });
      const packageController = new AbortController();
      const abortPackages = () => packageController.abort(lease.signal.reason);
      lease.signal.addEventListener('abort', abortPackages, { once: true });
      if (lease.signal.aborted) abortPackages();
      let packagePreparation: Promise<{ ok: true } | { ok: false; cause: unknown }> | undefined;
      let packageFailure: { cause: unknown } | undefined;
      const awaitPackages = async () => {
        const result = await packagePreparation;
        if (result?.ok === false) throw new Error('formalization_sandbox_packages_failed: ' + errorText(result.cause));
      };
      // Roles in flight; reported usage reaching the allowance stops all of them, not only the next dispatch.
      const running = new Set<() => void>();
      const spent = () => allowanceReached(request.maxTotalTokens, state.sessions);
      const dispatchOnce = async (role: Role, roundDirectory: string, input: unknown, inputDigest: string,
        slot?: { reviewerId?: string; name?: string; requireCached?: boolean; retryWhen?: () => boolean }) => {
        lease.signal.throwIfAborted();
        if (remaining() <= 0) throw new Error('formalization_time_limit');
        if (currentProfileDigest() !== profileDigest) throw new Error('formalization_profile_changed_during_run');
        const reviewing = role === 'backtranslate' || role === 'compare';
        const config = role === 'plan' ? request.workflow!.planner : (role === 'backtranslate' || role === 'refute') && request.workflow ?
          request.workflow.backtranslator : role === 'compare' && request.workflow ?
            request.workflow.reviewers.find(item => item.id === slot?.reviewerId)! : request;
        if (!config) throw new Error('formalization_role_configuration_missing');
        const inputText = canonicalMathJson(input);
        const sharedInput = request.fidelityPolicy && reviewing ?
          shareFormalizationContext(inputText) : undefined;
        const focusedInput = request.fidelityPolicy && structureContext && reviewing ?
          focusFormalizationContext(inputText, role) : undefined;
        const focusedContext = focusedInput && Buffer.byteLength(focusedInput) + Buffer.byteLength(FOCUSED_FORMALIZATION_CONTEXT_PROTOCOL) <
          Buffer.byteLength(sharedInput ?? inputText) * 0.8 ? focusedInput : undefined;
        const structuredInput = structured && role === 'compare' ? input as StructuredReviewInput : undefined;
        const schemaText = canonicalMathJson(structuredInput ?
          getStructuredFormalizationReviewOutputSchema(structuredInput) : getFormalizationRoleOutputSchema(role));
        const inlineLimit = reviewing ? INLINE_REVIEW_CONTEXT_BYTES : INLINE_ROLE_CONTEXT_BYTES;
        const inlineInputText = focusedContext ?? sharedInput ?? inputText;
        const inlineContext = Boolean((request.fidelityPolicy || direct) && Buffer.byteLength(inlineInputText) + Buffer.byteLength(schemaText) <= inlineLimit);
        const focusedInline = Boolean(focusedContext && inlineContext);
        // The source inventory does not claim to have checked library names.
        // A repair plan keeps full library access for unresolved meanings.
        const sourceOnlyPlan = Boolean(request.fidelityPolicy && request.environment !== 'standard' && role === 'plan' &&
          (input as { planningRound?: number }).planningRound === 1 && !(input as { feedback?: string }).feedback);
        if (role === 'plan' && !sourceOnlyPlan) await awaitPackages();
        // Exact source coordinates are bookkeeping, not mathematical reasoning.
        // Keep large originals in INPUT.json; short tasks can reuse one host-bound
        // span without a tool round trip or model-authored Unicode arithmetic.
        // It must also fit a coverage quote when the generator reuses that span.
        const sourceSpan = role === 'plan' && Buffer.byteLength(request.statement) <= INLINE_ROLE_CONTEXT_BYTES &&
          formalizationCandidateSchema.shape.coverage.element.shape.originalText.safeParse(request.statement).success ?
          { id: 'source', start: 0, end: request.statement.length, text: request.statement } : undefined;
        const directGenerator = direct && role === 'generate';
        const validateOutput = (value: unknown) => {
          if (structuredInput) return assertStructuredSemanticReview(structuredInput, value);
          const output = getFormalizationRoleOutputValidator(role).parse(value);
          if (directGenerator) {
            const candidate = formalizationCandidateSchema.parse(output);
            assertFormalizationCandidate(request, { ...candidate, source: eraseFormalizationProofs(candidate.source) });
          }
          return output;
        };
        const outputFeedback = directGenerator ? (cause: unknown, output: { text: string }) => {
          writeMathJsonDurable(path.join(roundDirectory, 'generate-rejected-output-' + mathDigest(output.text) + '.json'),
            { error: errorText(cause), outputText: output.text });
          return generationOutputFeedback(cause);
        } : request.fidelityPolicy && structuredInput ? reviewOutputFeedback : undefined;
        const instructionsText = (direct && role === 'generate' ? directGenerationInstructions :
          request.fidelityPolicy && role === 'plan' ? taskPreservingPlanInstructions :
          structured && reviewing ? formalizationReviewInstructions(role === 'compare' ? 'review' : 'backtranslate',
            semanticContext, reviewStructureContext, role === 'compare' ? request.fidelityPolicy : undefined,
            focusedInline ? 'inline' : 'file') : roleInstructions[role]) +
          (sourceOnlyPlan ? '\nThis first planning pass reads the original mathematical task without Mathlib access. Record the complete source inventory and proposed library mappings; the generator, Lean compiler and independent reviewers check those mappings later. Do not claim a library observation you did not make. If a meaning or mapping genuinely requires library inspection, record it in unresolved; a repair planning pass will have the pinned library. Do not guess or clear an unresolved item to save time.' : '') +
          (request.fidelityPolicy && role === 'plan' ? '\n' + [
            ...(sourceSpan ? [
              'The host has already computed this exact full-source span. Copy it unchanged into spans and reuse its ID for objects, assumptions and conclusions; finer spans are not required. Still list every distinct requested conclusion and its actual assumptions separately. Do not spend a tool request calculating these coordinates.',
              'HOST_SOURCE_SPAN=' + canonicalMathJson(sourceSpan),
            ] : ['All source coordinates are UTF-16 code-unit offsets in the parsed INPUT.statement string, never INPUT.json file positions or JSON-escaped text. /usr/bin/python3 is available in this sandbox; Node.js is not provided. Parse INPUT.json with Python, set statement = input["statement"], find i = statement.index(text) (choose the intended occurrence if repeated), verify statement[i:i+len(text)] == text, then set start = len(statement[:i].encode("utf-16-le")) // 2 and end = start + len(text.encode("utf-16-le")) // 2. Python string indices alone are not UTF-16 offsets.']),
            'A direction not to add a hypothesis is a restriction on the domain, not another positive premise. Record it in the relevant object description; put only actual mathematical premises in assumptions. Do not invent specialized definitions for ordinary real arithmetic or fractional numerals.',
            'conclusions.targetNames contains only the theorem/lemma names you will generate, with namespace qualification; map imported library constants/classes/types in definitions.leanNames instead.',
            'Different existing-definition records may cite the same imported constant for distinct source meanings. A new local definition name must remain unique across every definition record, including existing mappings; names within one record may not repeat.',
          ].join('\n') : '') +
          (request.exemplars && (role === 'plan' || role === 'generate') ? '\n' + formalizationExemplarInstructions : '') +
          (request.falsification && (role === 'plan' || role === 'generate') ? '\n' + FORMALIZATION_FALSIFICATION_AUTHOR_INSTRUCTIONS : '') +
          (request.falsification && role === 'compare' ? '\n' + FORMALIZATION_FALSIFICATION_REVIEW_INSTRUCTIONS : '') +
          (request.compatibility && (role === 'plan' || role === 'generate') ? '\nThe file will also be type-checked in an older pinned library (' +
            request.compatibility.provenance + '). The host rejects any library declaration you write that does not exist there; ' +
            'prefer long-standing Mathlib names over recently introduced ones.' : '') +
          (request.fidelityPolicy && role === 'generate' ? '\nFor each plan conclusion, copy each referenced plan.spans text verbatim into a coverage item with that conclusion\'s targetNames. Use only generated theorem/lemma names in coverage.targetNames; never library constants such as Group, Ring, Nat.card or IsSimpleGroup. Do not add punctuation or change whitespace/TeX escaping. Record separate domain/definition notes in assumptions or definitionsExplanation; supplemental coverage excerpts must map to that target\'s conclusion span. Every full planned conclusion span is still required.' : '') +
          (role === 'generate' && request.retrieval ? '\nINPUT.retrieval contains host-observed lookup hints from the frozen Mathlib corpus, interleaved across plan queries and deduplicated by declaration location.\n'
            + 'Each hint includes its source hash, module, line, header, variable/open context and query/rank provenance. Source files are relative to .lake/packages; read them under /opt/lean-packages.\n'
            + 'Headers can be truncated and are not closed Lean types or proofs. Check actual constants in the pinned Lean environment. A hit does not establish fidelity; no hit does not establish absence.\n'
            + 'Use these hints to implement the plan; do not search for solutions or substitute a retrieved theorem for the original task.\n' : '') +
          (role === 'generate' && request.retrieval && request.retrieval.schema !== 'theorem-os.formalization-retrieval-config.v1' ?
            '\nINPUT.retrieval.librarySymbols contains exact, case-sensitive name observations from the pinned Lean environment. librarySymbolQueries binds each name to its plan origins.\n'
            + 'Existing constants include their actual closed type, defining module, kind and class/structure status. Structure fields list direct projection names and their types, including parent projections; inherited fields are not recursively expanded.\n'
            + 'These observations cover generated and Lean core names as well as Mathlib classes. exists:false means that exact name was absent from the imported environment; it does not resolve aliases or prove that a mathematical concept is unavailable.\n'
            + 'Use the types and fields to check the planned definitions and assumptions. Metadata and diagnostic digests are advisory lookup evidence, not semantic approval or proof acceptance.\n' : '') +
          (role === 'generate' && request.retrieval?.schema === 'theorem-os.formalization-retrieval-config.v3' ?
            '\nSource search retains every explicit existing-definition name from the plan and object-type names that resolve exactly in the pinned Lean environment.\n'
            + 'INPUT.retrieval.omittedObjectQueries records object-only names absent from that environment, with their plan origins; their exact-name observations remain in librarySymbols.\n'
            + 'An omitted object word may be a local variable, universe parameter, prose, or an unresolved alias. Omission does not certify the plan or the candidate; check the intended mathematical objects and their types.\n' : '') + [
          focusedInline ? '\nThe developer instructions contain the complete role protocol; the turn supplies the reading view and exact output schema. ROLE.md is a frozen copy for reference.' :
          request.fidelityPolicy || direct ? '\nThe developer instructions contain the complete role protocol. Read OUTPUT.schema.json and INPUT.json in this directory. ROLE.md is a frozen copy for reference; reading it again is unnecessary.' :
            '\nRead ROLE.md and OUTPUT.schema.json, then INPUT.json in this directory. These files contain the complete role protocol and task data.',
          ...(request.fidelityPolicy && role !== 'refute' ? ['Preserve the complete original task. Reordering independent parameters and supported equivalent representations are allowed; changing whole-structure assumptions into pair-local assumptions, weakening premises or strengthening conclusions is not approval. Establish the comparison of full obligations, not separate provability.'] : []),
          'OUTPUT.schema.json describes the exact output structure, field types and required fields. Do not search installed libraries, old sessions or runtime source for the output protocol.',
          ...((request.fidelityPolicy || direct) && !focusedInline ? ['When the turn message includes a complete frozen input or output schema, use those bytes directly; rereading that file adds no evidence. For inputs too large to inline, read the task data and every required snapshot field from INPUT.json using the role protocol.'] : []),
          ...(request.fidelityPolicy ? [
            'After a settled planning/review request or several backtranslation requests the host may remind you to finish your output. This is a submission reminder, not semantic approval or permission to omit required evidence.'] : []),
          ...(request.fidelityPolicy && reviewing ? focusedContext ? [FOCUSED_FORMALIZATION_CONTEXT_PROTOCOL] :
            [snapshotFieldInstructions, SHARED_FORMALIZATION_CONTEXT_PROTOCOL] : []),
          ...(request.fidelityPolicy && role === 'compare' ? [
            'Output construction: provide at least one correspondence for each of the six required aspects. This is not an aspect-by-target matrix: add more entries only where needed to cover distinct claims or evidence. Still examine every target and include every target separately in fidelity.targets; do not omit assumptions, definitions, ambiguity or any requested conclusion.',
            'When the mathematical correspondence is direct, explain that correspondence once and leave forwardArgument and reverseArgument empty. For an equivalent representation, both conversion arguments remain required. Reuse exact supplied strings for quotations and digests instead of reconstructing them. Use concise complete explanations; do not repeat the same justification across fields or invent alternative output layouts.',
          ] : []),
          direct ? 'The host checks exact source quotations, coverage, Lean source admission and compilation; no independent semantic review is performed.' :
            'The host still checks cross-references, exact source spans, mathematical fidelity and Lean source admission after checking JSON structure.',
          sourceOnlyPlan ? 'This source-inventory sandbox has the pinned Lean toolchain but no Mathlib packages; /opt/lean-packages is not mounted. Library inspection is available to a repair planning pass and to the generator.' :
          (request.fidelityPolicy || direct) && request.environment === 'standard' ?
            'This request uses only the Lean standard library. Installed Lean sources are in /opt/lean/src/lean; Mathlib is unavailable and /opt/lean-packages is not mounted.' :
            'Installed Lean sources are in /opt/lean/src/lean; pinned Mathlib and dependencies are in /opt/lean-packages (Mathlib: /opt/lean-packages/mathlib/Mathlib).',
          ...(request.library && !sourceOnlyPlan ? [
            'The same pinned TheoremOS library is available read-only at /opt/theoremos-library, with its compiled modules in LEAN_PATH. The library API also discovers TheoremOS declarations and reports their real types and defining modules. Import the returned Submission.Library.TheoremOS module explicitly when its symbols are needed; the host freezes and compiles that exact source dependency closure for the proof task. Do not redefine an installed mathematical object or change library files.',
          ] : []),
          direct && role === 'generate' ?
            'Use the library API below for declaration discovery and type inspection. Lean remains available for a specific unresolved type or syntax question: /opt/lean/bin/lean ./SyntaxCheck.lean. Preserve its exit code; do not pipe it through head. LEAN_PATH is configured and the read-only library cache needs no Lake setup. Preserve LEAN_PATH: source directories are not compiled library paths. Do not replace it or run Lake setup/build.' :
            'Use lean directly to inspect declarations when necessary; LEAN_PATH is already configured. The installed library cache is read-only and does not need Lake setup.',
          ...(direct && role === 'generate' ? [
            'For a specific unresolved library API, batch related lookups in one command: /usr/bin/python3 /opt/formalization/library-api.py --name Nat.add_zero --name Nat.succ --query Fin.cast --limit 4. Use at most 32 names, 8 queries and --limit 1..8. Names are exact and case-sensitive; queries match literal name fragments case-insensitively. Query matches contain only names, defining modules, kinds and class/structure status. Inspect only the selected declarations with --name to obtain actual closed types and direct field projection types; broad discovery does not expand those types. Each invocation uses one pinned Lean process. Missing exact names are explicit; query truncation is explicit. It returns no declaration bodies or proofs. Use the returned module as the import location; do not guess import paths. Treat results as library observations, not evidence of mathematical fidelity or proof acceptance.',
            'Use contiguous declaration-name fragments, such as IsSplittingField, rather than prose such as "splitting field". If a broad fragment returns unrelated areas, narrow its defining modules with --module-prefix Mathlib.FieldTheory (for field-theory APIs), or repeat --module-prefix for an OR of up to 8 areas. Module prefixes are case-sensitive whole module names or dot-separated subtrees. Only fragment results and their counts are filtered; explicit --name inspection is unchanged. The packet reports queryModulePrefixes when filtered. No scoped match does not establish absence outside those modules.',
            'A running exec_command session is not a timeout or failed lookup. If a library query yields a session ID, wait on that same session with write_stdin and empty chars until it returns. Do not restart or interrupt a healthy lookup merely because the yield interval elapsed; keep its eventual result for the candidate.',
          ] : []),
          'Use these exact library paths when needed. Other tasks, benchmark answers and prior sessions are unavailable.',
          ...(role === 'refute' ? [] : ['This is statement formalization. Do not search for or construct theorem proofs during planning, generation or semantic review.']),
          ...(request.fidelityPolicy && role === 'plan' ? [
            'Planning is complete when the requested objects, assumptions, conclusion types and definition dependencies are covered. Inspect declaration types only when necessary to resolve a concrete uncertainty, then submit the plan; constructing proof expressions is outside this role.',
          ] : []),
          ...((request.fidelityPolicy || direct) && role === 'generate' ? [
            direct ? 'Submit the complete statement with erased theorem proofs and concise coverage notes. The host compiles it and returns diagnostics for repair; do not compile scratch copies merely to repeat that check.' :
              'Implement the supplied plan as declarations with erased theorem proofs. The host compiles your submission and returns diagnostics for repair. Inspect declarations only for a specific unresolved library fact or mathematical meaning; do not compile extra scratch copies merely to duplicate that host check. Submit OUTPUT.json atomically once the statement and coverage are ready.',
            'Name universe parameters when introducing an existential ambient carrier for embeddings. Inside a definition, an existential E : Type* introduces an independent universe parameter; it does not mean some sufficiently large universe. For carriers A : Type u and B : Type v embedded into E, use E : Type (max u v), or another explicitly justified compatible universe. Do not leave the ambient universe unrelated to the embedded carriers or restrict the original carriers to Type 0. If the inferred parameters are uncertain, inspect the elaborated declaration once in a separate scratch file; compilation alone does not check this mathematical requirement.',
            ...(!direct ? ['For a tower or nested family, include the successive inclusions and define each relative construction over the preceding object, rather than repeatedly over the original base. Quantified ambient carriers must have universes compatible with the required embeddings; an independently quantified smaller universe can change an existence claim. Check these statement choices before submitting, without proving the theorem.'] : []),
            ...(request.environment === 'standard' ? [] : ['Use the narrowest known imports that supply the statement symbols. For ordinary real arithmetic, Mathlib.Data.Real.Basic supplies ℝ and its arithmetic/order operations. Avoid the full import Mathlib when a known narrower module suffices: every independent Lean check must load those imports.']),
          ] : []),
          ...(request.fidelityPolicy && role === 'backtranslate' ? [
            'Use the host-observed elaborated types, binder dependencies, actual instances and supplied definition context as the primary evidence. Inspect an installed definition only to resolve a specific semantic uncertainty left by that context; do not repeat observations already supplied or recompile the snapshot merely to confirm it elaborates.',
            'The candidate declarations are supplied in INPUT.json, not installed as a library module. A fresh file importing Init or Mathlib does not contain those target names; read their actual elaborated types from the snapshot.',
            'In definitions, explain the mathematical meanings needed to interpret the statement. Do not turn the output into an inventory of kernel constructors or typeclass dispatch helpers; still examine any instance or local definition that can change the mathematical meaning. Once every target, domain, quantifier, hypothesis, conclusion and relevant definition has been interpreted, write OUTPUT.json and stop. Record any remaining uncertainty explicitly rather than repeatedly rechecking settled facts.',
            'Refer to each target by its exact qualified theorem name throughout the translation, including assumptions and definitions; positional target numbers are ambiguous.',
          ] : []),
          'Write your complete final JSON atomically in this workspace: write ./OUTPUT.json.tmp, then rename ./OUTPUT.json.tmp to ./OUTPUT.json. Keep the temporary file beside OUTPUT.json; /tmp is a separate mount and renaming from there fails with a cross-device error.',
          ...(direct && role === 'generate' ? [
            'If source is already in ./Candidate.lean, write only coverage, assumptions, assumptionsExplanation and definitionsExplanation to ./Candidate.metadata.json, with exact original quotations and the required schema types. Package the existing source without copying or shell-escaping it again: /usr/bin/python3 -I - <<\'THEOREMOS_PACKAGE\'\nimport json\nfrom pathlib import Path\noutput = json.loads(Path("./Candidate.metadata.json").read_text(encoding="utf-8"))\noutput["source"] = Path("./Candidate.lean").read_bytes().decode("utf-8")\nPath("./OUTPUT.json.tmp").write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")\nPath("./OUTPUT.json.tmp").replace("./OUTPUT.json")\nTHEOREMOS_PACKAGE\nThis only serializes your chosen source and notes; host schema, exact coverage, source admission and Lean checks still decide acceptance.',
          ] : []),
          ...(request.fidelityPolicy ? [
            'When submitting JSON with exec_command, use a quoted shell heredoc: cat > ./OUTPUT.json.tmp <<\'THEOREMOS_OUTPUT_JSON\', followed on the next line by your complete JSON, then THEOREMOS_OUTPUT_JSON on its own line, then mv ./OUTPUT.json.tmp ./OUTPUT.json. Use a delimiter absent from the JSON. The quoted heredoc preserves apostrophes, backticks, dollar signs and backslashes literally. Do not place JSON prose inside a single-quoted printf or echo argument: an apostrophe in mathematical prose would break that shell quoting and require another model request.',
          ] : []),
          directGenerator ? 'The first complete source- and coverage-valid OUTPUT.json is your submission. Source or coverage failures receive precise feedback in this same thread; correct the existing candidate and resubmit. The host stops the writer before Lean compilation and validates the final bytes again. Stop after a valid submission.' :
            'The first complete schema-valid OUTPUT.json is your submission: the host ends this role and validates it. Stop after submitting.',
          'Do not change INPUT.json, ROLE.md or OUTPUT.schema.json. Read only this role input, protocol and installed libraries; do not search for benchmark answers.',
        ].join('\n');
        const roleContract = { schema: 'theorem-os.formalization-role-contract.v1' as const,
          roleInstructionsSha256: mathDigest(instructionsText), outputSchemaSha256: mathDigest(schemaText) };
        // Only closed, validated writers can be reused. Bind the actual input and
        // protocol bytes as well as their role-specific identity digests.
        const cached = state.sessions.findLast(item => item.round === state.rounds && item.role === role &&
          item.reviewerId === slot?.reviewerId && item.inputDigest === inputDigest && item.workspace && item.outputDigest &&
          item.model === config.model && item.effort === config.effort && item.threadId && item.turnId &&
          ['completed', 'submitted'].includes(item.status));
        if (cached) {
          try {
            const workspace = path.resolve(directory, cached.workspace!);
            if (!isMathPathWithin(roundDirectory, workspace) ||
                canonicalMathJson(cached.roleContract) !== canonicalMathJson(roleContract) ||
                request.workflow && cached.configurationDigest !== formalizationModelConfigurationDigest(config) ||
                readMathText(path.join(workspace, 'INPUT.json'), 8_000_000) !== inputText ||
                readMathText(path.join(workspace, 'ROLE.md'), 1_000_000) !== instructionsText ||
                readMathText(path.join(workspace, 'OUTPUT.schema.json'), 1_000_000) !== schemaText)
              throw new Error('identity');
            const output = JSON.parse(readMathText(path.join(workspace, 'OUTPUT.json'), 2_000_000)) as unknown;
            if (formalizationDigest(output) !== cached.outputDigest) throw new Error('output');
            validateOutput(output);
            event('formalization_role_restored', role);
            return { output, record: cached };
          } catch { throw new Error('formalization_checkpoint_changed:' + role); }
        }
        if (slot?.requireCached) throw new Error('formalization_checkpoint_changed:' + role);
        const budget = buildTokenBudget(request.maxTotalTokens, state.sessions);
        if (!modelDispatchAllowed(budget)) throw new Error(budget.reason ?? 'formalization_token_limit');
        const name = slot?.name ?? (slot?.reviewerId ? 'compare-' + slot.reviewerId : role);
        const baseWorkspace = path.join(roundDirectory, name);
        const workspace = fs.existsSync(baseWorkspace) ? path.join(roundDirectory, 'retry-' + crypto.randomUUID(), name) : baseWorkspace;
        assertMathCanonicalPath(workspace);
        fs.mkdirSync(workspace, { mode: 0o700, recursive: true });
        const inputFile = path.join(workspace, 'INPUT.json'), outputFile = path.join(workspace, 'OUTPUT.json');
        const instructionsFile = path.join(workspace, 'ROLE.md'), schemaFile = path.join(workspace, 'OUTPUT.schema.json');
        fs.writeFileSync(inputFile, inputText, { mode: 0o400, flag: 'wx' });
        fs.writeFileSync(instructionsFile, instructionsText, { mode: 0o400, flag: 'wx' });
        fs.writeFileSync(schemaFile, schemaText, { mode: 0o400, flag: 'wx' });
        const record: SessionRecord = { role, round: state.rounds, status: 'opening', inputDigest,
          model: config.model, effort: config.effort, turns: 0, usage: {},
          roleContract, workspace: path.relative(directory, workspace),
          ...(request.workflow ? { configurationDigest: formalizationModelConfigurationDigest(config),
            ...(slot?.reviewerId ? { reviewerId: slot.reviewerId } : {}) } : {}),
          usageAccounting: { startedTurns: 0, reportedTurns: 0, pending: false, incomplete: false } };
        state.sessions.push(record); save(); event('formalization_role_started', role);
        // The advisory refuter may have its own, shorter turn bound.
        const turnTimeout = Math.min(stageTimeout(request.maxTurnSeconds),
          role === 'refute' && request.falsification?.maxTurnSeconds ? request.falsification.maxTurnSeconds * 1000 : Infinity);
        let session: MathAgentSession | undefined, incomplete = false, modelSlot: MathModelSlot | undefined, stopped = false;
        let receivedTurnUsage = false;
        let completionNoticeSent = false;
        const sharedStages = direct ? 'generation, host Lean compilation and any required repairs' :
          'generation, Lean compilation, backtranslation and independent review';
        const remindSubmission = () => {
          const accounting = record.requestUsageAccounting;
          if (!(direct && role === 'generate' || request.fidelityPolicy && ['plan', 'backtranslate', 'compare'].includes(role)) ||
              completionNoticeSent || !session?.notify || stopped || lease.signal.aborted || remaining() <= 0 ||
              accounting?.incomplete || accounting?.pendingRequests ||
              (accounting?.reportedRequests ?? 0) < (role === 'backtranslate' ? 3 : 1) || fs.existsSync(outputFile)) return;
          completionNoticeSent = true;
          const message = role === 'generate' ?
            'Move to a complete candidate using the evidence already available. Preserve every required domain, quantifier, hypothesis, conclusion and definition. Let any running library query finish; this reminder does not cancel tools. Make further library queries only for a specific unresolved declaration or mathematical meaning; do not keep exploring alternative encodings or proving the theorem. Prepare coverage alongside source. If a complete candidate already compiled locally, reuse that file instead of rewriting it. As soon as the complete statement and coverage are ready, write the smallest faithful schema-valid OUTPUT.json atomically and stop. The host compiles your submission and returns diagnostics for repair. Do not guess missing semantics, truncate the statement or weaken it to meet a budget.' : role === 'plan' ?
            'Finish the statement plan from the evidence already available. Use the smallest inventory covering all source clauses; do not construct proofs or enumerate kernel/typeclass implementation details. Make further library queries only for a specific unresolved mathematical meaning. Record genuine remaining ambiguity in unresolved, and write the complete schema-valid OUTPUT.json atomically.' : role === 'compare' ?
            'Finish your independent semantic review using the supplied frozen snapshot and observations. Cover every required target, domain, quantifier, hypothesis, conclusion and definition affecting the mathematical meaning. Make further queries only for a specific missing meaning; avoid repeatedly checking settled observations or constructing theorem proofs. Preserve your own verdict: unknown or changes_requested is acceptable when evidence is insufficient. Once your assessment is complete, write the complete schema-valid OUTPUT.json atomically, including the required source contract for an approved review. The host will compile and check whole-statement correspondence separately; this reminder gives no semantic verdict.' :
            'Finish the independent backtranslation from the supplied checked snapshot and observations. Cover every target, domain, quantifier, hypothesis, conclusion and definition affecting the mathematical meaning. Do not recompile or rederive observations already supplied. Make further queries only for a specific missing meaning; describe genuine uncertainty in the existing translation fields. Write the complete schema-valid OUTPUT.json atomically.';
          const timeLeft = remaining();
          const budgetReminder = Number.isFinite(timeLeft) ?
            `\nThe shared pipeline has ${Math.max(0, Math.ceil(timeLeft / 1000))} seconds remaining for ${sharedStages} as well as this role.` : '';
          void session.notify(message + budgetReminder, { waitForRequest: true })
            .then(() => event('formalization_submission_reminded', role))
            .catch(() => event('formalization_submission_reminder_cancelled', role));
        };
        const interrupt = () => { void session?.interrupt().catch(() => {}); void session?.close().catch(() => {}); };
        const stop = () => { stopped = true; interrupt(); };
        lease.signal.addEventListener('abort', interrupt, { once: true });
        running.add(stop);
        try {
          // Host-side admission control across every process sharing the model
          // gateway. Preset sessions neither open a model nor consume a slot.
          const slotConfiguration = request.execution === 'model' && !options.openSession ? configuredMathModelSlots() : undefined;
          if (slotConfiguration) {
            event('formalization_model_slot_waiting', role);
            modelSlot = await acquireMathModelSlot(slotConfiguration, { signal: lease.signal });
            event('formalization_model_slot_acquired', role);
          }
          session = await (options.openSession ?? createCodexMathSession)({
            executable: config.executable, profile: config.profile, workspace, model: config.model, effort: config.effort,
            instructions: instructionsText,
            environment: env, signal: lease.signal,
            turnTimeoutMs: Number.isFinite(turnTimeout) ? turnTimeout : undefined,
            ...(request.execution === 'model' ? { readIsolation: { environment: request.environment,
              ...(request.library && !sourceOnlyPlan ? { library: { file: request.library.file, digest: request.library.digest } } : {}),
              ...(sourceOnlyPlan ? { packages: 'none' as const } : {}) } } : {}),
            completedOutput: { file: outputFile, validate: value => { validateOutput(value); },
              ...(outputFeedback ? { validationFeedback: outputFeedback } : {}) },
            onUsage: usage => {
              // Relayed roles settle each provider request; cumulative native notifications are observational.
              if (record.requestUsageAccounting) return;
              receivedTurnUsage = reportedTotalTokens(usage) !== null;
              record.usage = usage; save();
              if (spent()) for (const stopRole of running) stopRole();
            }, onUsageIncomplete: () => {
              incomplete = true;
              if (record.requestUsageAccounting) record.requestUsageAccounting.incomplete = true;
              save();
            },
            requestGate: identity => {
              if (lease.signal.aborted || stopped || remaining() <= 0) return { allowed: false, reason: 'math_model_request_stopped' };
              const budget = buildTokenBudget(request.maxTotalTokens, state.sessions);
              if (!modelDispatchAllowed(budget)) return { allowed: false, reason: budget.reason! };
              initializeRequestUsageAccounting(record);
              const settle = beginRequestUsage(record, identity);
              save();
              return { allowed: true, settle: receipt => {
                settle(receipt); save();
                if (spent()) for (const stopRole of running) stopRole();
                else remindSubmission();
              } };
            },
          });
          if (session.usageSource === 'upstream-requests') initializeRequestUsageAccounting(record);
          if (session.isolationReceipt) record.isolationReceipt = session.isolationReceipt;
          if (lease.signal.aborted) { await session.close(); lease.signal.throwIfAborted(); }
          if (stopped || spent()) throw new Error('math_total_token_limit');
          record.threadId = session.threadId;
          if (state.sessions.some(item => item !== record && item.threadId === record.threadId))
            throw new Error('formalization_role_thread_reused');
          let message = inlineContext ? [
            focusedContext ?
              'Complete your assigned role using the review reading view and exact output schema below. The complete target and local semantics are inline; inspect indexed imported details in INPUT.json when needed, following the developer protocol.' : sharedInput ?
              'Complete your assigned role using the complete lossless shared input and exact output schema below. Resolve dictionary references using the developer protocol; do not reread INPUT.json, OUTPUT.schema.json or ROLE.md.' :
              'Complete your assigned role using the frozen input and exact output schema below. These are the complete INPUT.json and OUTPUT.schema.json bytes; do not reread those files or ROLE.md.',
            'Follow the developer role protocol. Use tools only for a specific missing library fact or to write the final OUTPUT.json atomically, then stop.',
            focusedContext ? 'BEGIN REVIEW CONTEXT' : sharedInput ? 'BEGIN SHARED INPUT.json' : 'BEGIN INPUT.json', inlineInputText,
            focusedContext ? 'END REVIEW CONTEXT' : sharedInput ? 'END SHARED INPUT.json' : 'END INPUT.json',
            'BEGIN OUTPUT.schema.json', schemaText, 'END OUTPUT.schema.json',
          ].join('\n') : request.fidelityPolicy || direct ?
            'Follow the complete role protocol in the developer instructions. Read OUTPUT.schema.json and INPUT.json, write OUTPUT.json atomically using that contract, then stop. ROLE.md is the same protocol and need not be reread.' :
            'Read ROLE.md, OUTPUT.schema.json and INPUT.json in the current directory. Produce OUTPUT.json using that exact contract. The complete protocol is in these files; no runtime source search or theorem proof is required.';
          if ((request.fidelityPolicy || direct) && !inlineContext && Buffer.byteLength(schemaText) <= INLINE_ROLE_CONTEXT_BYTES) {
            message = 'Use the complete frozen output schema below. Read INPUT.json using the developer role protocol; ROLE.md and OUTPUT.schema.json need not be reread.\n'
              + 'BEGIN OUTPUT.schema.json\n' + schemaText + '\nEND OUTPUT.schema.json';
            const navigation = snapshotNavigation(role, input);
            if (navigation) message += '\nThe following host navigation index copies the snapshot digest, Lean source, complete target types, bindings and omitted-name lists. It is not the complete input or a semantic verdict. Read the required kernel, local-definition and actual-instance observations at the listed INPUT.json paths using the role protocol before judging. Use exact qualified target names in your descriptions rather than ambiguous target numbers.\n'
              + 'BEGIN SNAPSHOT INDEX\n' + navigation + '\nEND SNAPSHOT INDEX';
          }
          if ((request.fidelityPolicy || direct) && Number.isFinite(remaining())) message =
            `The complete formalization pipeline has ${Math.max(0, Math.ceil(remaining() / 1000))} seconds remaining, shared with ${sharedStages}. ` +
            (direct ? 'Submit the smallest complete faithful candidate early enough to leave time for host compilation and repairs. Do not drop definitions, quantifiers or conclusions to meet the budget.\n' :
              'Submit the smallest complete result for your role.\n') + message;
          while (true) {
            lease.signal.throwIfAborted();
            const budget = buildTokenBudget(request.maxTotalTokens, state.sessions);
            if (!modelDispatchAllowed(budget)) throw new Error(budget.reason ?? 'formalization_token_limit');
            receivedTurnUsage = false;
            record.usageAccounting.startedTurns++; record.usageAccounting.pending = true;
            record.status = 'running'; save();
            const ran = session.run(message, crypto.randomUUID(), workspace,
              turnId => { record.turnId = turnId; record.turns++; save(); });
            // A turn stopped at the allowance ends the run; one that still finished keeps its output.
            record.status = await ran.catch((cause: unknown) => { throw stopped ? new Error('math_total_token_limit') : cause; });
            record.usageAccounting.pending = false;
            if (record.requestUsageAccounting ? !record.requestUsageAccounting.incomplete && !record.requestUsageAccounting.pendingRequests :
              receivedTurnUsage && !incomplete) record.usageAccounting.reportedTurns++;
            record.usageAccounting.incomplete = incomplete || record.usageAccounting.startedTurns > record.usageAccounting.reportedTurns;
            save(); lease.signal.throwIfAborted();
            if (record.status === 'submitted') record.completionReason = 'validated-output';
            if (!['completed', 'submitted'].includes(record.status) || !record.turnId) {
              if (session.lastFailureDiagnostic) record.failureDiagnostic = { ...session.lastFailureDiagnostic };
              if (stopped) throw new Error('math_total_token_limit');
              throw new FormalizationRoleFailure(record.status, session.lastFailureDiagnostic);
            }
            // A normal turn may finish before the output watcher can send feedback.
            // Keep source/coverage repairs and malformed reviews in their own
            // threads. Compilation and independent judgments still follow.
            if (outputFeedback && record.status === 'completed') {
              if (currentProfileDigest() !== profileDigest || readMathText(inputFile, 8_000_000) !== inputText ||
                  readMathText(instructionsFile, 1_000_000) !== instructionsText || readMathText(schemaFile, 1_000_000) !== schemaText)
                throw new Error('formalization_role_contract_changed');
              let output: unknown, outputText = '';
              try { outputText = readMathText(outputFile, 2_000_000); output = JSON.parse(outputText); }
              catch (cause) {
                if (!(cause instanceof SyntaxError) && (cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
                message = outputFeedback(cause, { text: outputText });
                event(directGenerator ? 'formalization_generation_output_repairing' : 'formalization_review_output_repairing', role, errorText(cause)); continue;
              }
              try { validateOutput(output); }
              catch (cause) {
                message = outputFeedback(cause, { text: outputText });
                event(directGenerator ? 'formalization_generation_output_repairing' : 'formalization_review_output_repairing', role, errorText(cause)); continue;
              }
            }
            break;
          }
          // Stop the writer before parsing or binding a submitted output.
          await session.close();
          if (currentProfileDigest() !== profileDigest) throw new Error('formalization_profile_changed_during_run');
          if (readMathText(inputFile, 8_000_000) !== inputText) throw new Error('formalization_role_input_changed');
          if (readMathText(instructionsFile, 1_000_000) !== instructionsText || readMathText(schemaFile, 1_000_000) !== schemaText)
            throw new Error('formalization_role_contract_changed');
          assertMathCanonicalPath(outputFile);
          const output = JSON.parse(readMathText(outputFile, 2_000_000)) as unknown;
          validateOutput(output);
          record.outputDigest = formalizationDigest(output);
          return { output, record };
        } finally {
          await session?.close();
          await modelSlot?.release();
          if (['opening', 'running'].includes(record.status)) record.status = lease.signal.aborted || stopped ? 'interrupted' : 'failed';
          lease.signal.removeEventListener('abort', interrupt);
          running.delete(stop);
          record.usageAccounting.pending = false;
          record.usageAccounting.incomplete = incomplete || (record.usageAccounting.startedTurns > record.usageAccounting.reportedTurns);
          save(); event('formalization_role_finished', role);
        }
      };
      const dispatch = async (...args: Parameters<typeof dispatchOnce>) => {
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await dispatchOnce(...args);
            if (state.error?.startsWith('formalization_role_incomplete:')) { delete state.error; save(); }
            return result;
          }
          catch (cause) {
            if (!retryableRoleFailure(cause)) throw cause;
            lease.signal.throwIfAborted();
            if (remaining() <= 0) throw new Error('formalization_time_limit');
            const budget = buildTokenBudget(request.maxTotalTokens, state.sessions);
            if (!modelDispatchAllowed(budget)) throw new Error(budget.reason ?? 'formalization_token_limit');
            if (args[4]?.retryWhen?.() === false) throw cause;
            state.error = errorText(cause); save(); event('formalization_role_retrying', args[0], state.error);
            // This is a delay cap, not an attempt/time/token limit. Only this role
            // repeats, in a fresh isolated thread, with its input unchanged.
            // The wait is jittered so roles hit by the same gateway event do not
            // retry in lockstep; capacity is enforced by admission control.
            const cap = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5), remaining());
            const delay = Math.max(1, Math.round(cap * (0.5 + Math.random() * 0.5)));
            await (options.waitForRetry ?? ((ms, signal) => wait(ms, undefined, { signal })))(delay, lease.signal);
            // A peer can submit a valid change request during this backoff.
            if (args[4]?.retryWhen?.() === false) throw cause;
          }
        }
      };
      const readStageCheckpoint = (stage: 'retrieval' | 'elaboration' | 'reference'): unknown => {
        const digest = state.activeRound?.[`${stage}Digest`];
        if (!digest) return undefined;
        try {
          const file = path.join(directory, state.activeRound!.directory, stage + '-result.json');
          const output: unknown = JSON.parse(readMathText(file, 16_000_000));
          if (formalizationDigest(output) !== digest) throw new Error('digest');
          return output;
        } catch { throw new Error('formalization_checkpoint_changed:' + stage); }
      };
      const saveStageCheckpoint = (stage: 'retrieval' | 'elaboration' | 'reference', output: unknown) => {
        writeMathJsonDurable(path.join(directory, state.activeRound!.directory, stage + '-result.json'), output);
        state.activeRound![`${stage}Digest`] = formalizationDigest(output);
        save();
      };
      // Advisory falsification: only a Lean-checked refutation changes the round; a
      // failed refuter, harness or timeout never rejects or approves a candidate.
      const refuteCandidate = async (roundDirectory: string, source: string,
        snapshot: Parameters<typeof formalizationRefutationInput>[0], snapshotDigest: string) => {
        const resultFile = path.join(roundDirectory, 'refutation-result.json');
        try {
          const input = formalizationRefutationInput(snapshot, snapshotDigest, getLeanTaskEnvironment(request.environment).toolchain);
          const session = await dispatch('refute', roundDirectory, input, formalizationDigest(input));
          const output = formalizationRefutationOutputSchema.parse(session.output);
          if (output.snapshotDigest !== snapshotDigest) throw new Error('formalization_refutation_identity_mismatch');
          const targets = new Set(snapshot.targets.map(target => target.name)), seen = new Set<string>();
          const rejected: (FormalizationRefutationProbe & { reason: string })[] = [], probes: FormalizationRefutationProbe[] = [];
          for (const probe of output.refutations) {
            const reason = !targets.has(probe.target) ? 'unknown target' : seen.has(probe.target) ? 'duplicate target' :
              refutationProofRejection(probe);
            seen.add(probe.target);
            if (reason) rejected.push({ ...probe, reason }); else probes.push(probe);
          }
          if (!probes.length) {
            writeMathJsonDurable(resultFile, { status: 'no-probes', rejected });
            return [];
          }
          event('formalization_refutation_started', 'refute');
          const base = path.join(roundDirectory, 'refutation');
          const check = await (options.refute ?? checkFormalizationRefutations)(fs.existsSync(base) ? base + '-' + crypto.randomUUID() : base,
            source, request.environment, probes, { env, signal: lease.signal,
              ...(request.library ? { library: request.library } : {}),
              timeoutMs: Math.max(1, Math.min(request.falsification!.maxSeconds * 1000, remaining())) });
          writeMathJsonDurable(resultFile, { status: check.status, timedOut: check.timedOut, probes: check.probes, rejected });
          event('formalization_refutation_finished', 'refute');
          return check.probes.filter(probe => probe.status === 'refuted');
        } catch (cause) {
          // An interrupted or failed refuter turn refutes nothing; account and
          // policy failures, cancellation and infrastructure still end the run.
          if (lease.signal.aborted || infrastructureFailure(errorText(cause)) ||
              /formalization_role_incomplete:failed:(?:unauthorized|badRequest|misalignmentPolicyViolation|cyberPolicy)/u.test(errorText(cause)) ||
              !modelDispatchAllowed(buildTokenBudget(request.maxTotalTokens, state.sessions))) throw cause;
          writeMathJsonDurable(path.join(roundDirectory, 'refutation-failure-' + crypto.randomUUID() + '.json'), { error: errorText(cause).slice(0, 16_000) });
          event('formalization_refutation_unavailable', 'refute', errorText(cause).slice(0, 2000));
          return [];
        }
      };
      try {
        if (state.unsupportedTaskKind) {
          if (fs.existsSync(path.join(directory, 'artifact'))) throw new Error('formalization_unsupported_task_artifact_conflict');
          state.status = 'stopped'; state.error = 'formalization_plan_task_kind_unsupported'; save(); return summary();
        }
        if (fs.existsSync(path.join(directory, 'artifact'))) {
          const evidence = readFormalizationArtifact(path.join(directory, 'artifact'));
          if (evidence.requestDigest !== requestDigest) throw new Error('formalization_artifact_request_changed');
          const seed = bootstrapFormalizedProblem(directory);
          state.status = 'approved'; delete state.error; save();
          return { ...summary(), ...seed };
        }
        if (state.status === 'approved') throw new Error('formalization_approved_artifact_missing');
        state.status = 'running'; delete state.error; save();
        if (request.execution === 'model' && (direct || request.workflow && request.fidelityPolicy) && request.environment !== 'standard') {
          event('formalization_packages_preparing');
          // Attach the rejection handler immediately. Preparation shares the run
          // deadline, and its private mount is released before a role uses the cache.
          packagePreparation = (options.preparePackages ?? warmFormalizationPackages)(request.environment, {
            env, signal: packageController.signal,
            ...(Number.isFinite(remaining()) ? { deadlineAt: Date.now() + Math.max(1, remaining()) } : {}),
          }).then(() => { event('formalization_packages_ready'); return { ok: true as const }; }, cause => {
            if (!packageController.signal.aborted) { packageFailure = { cause }; controller.abort(); }
            return { ok: false as const, cause };
          });
        }
        while (state.activeRound || request.maxRounds === 0 || state.rounds < request.maxRounds) {
          lease.signal.throwIfAborted();
          if (remaining() <= 0) throw new Error('formalization_time_limit');
          if (!state.activeRound) {
            state.rounds++;
            state.activeRound = { directory: 'round-' + String(state.rounds).padStart(2, '0') + '-' + crypto.randomUUID(),
              feedback: state.feedback, previousCandidate: state.previousCandidate };
            fs.mkdirSync(path.join(directory, state.activeRound.directory), { mode: 0o700 }); save();
          }
          const roundDirectory = path.join(directory, state.activeRound.directory);
          assertMathCanonicalPath(roundDirectory);
          let currentCandidate: FormalizationCandidate | undefined;
          let semanticallyRejected = false;
          try {
            let planning: { input: { problemId: string; statement: string; environment: 'standard' | 'mathlib'; toolchain: string;
              round: number; planningRound: number; feedback?: string; exemplars?: FormalizationExemplar[] }; output: FormalizationPlan; digest: string;
              session: Awaited<ReturnType<typeof dispatch>> } | undefined;
            const exemplars = request.exemplars ? { exemplars: formalizationExemplarInput(request.exemplars) } : {};
            if (request.workflow) {
              const acceptedPlanning = state.activeRound.planning;
              let planningFeedback = acceptedPlanning ? acceptedPlanning.feedback : state.activeRound.feedback;
              for (let planningRound = acceptedPlanning?.round ?? 1;
                request.workflow.maxPlanningRounds === 0 || planningRound <= request.workflow.maxPlanningRounds; planningRound++) {
                lease.signal.throwIfAborted();
                const input = { problemId: request.problemId, statement: request.statement, environment: request.environment,
                  toolchain: getLeanTaskEnvironment(request.environment).toolchain, round: state.rounds, planningRound, feedback: planningFeedback, ...exemplars };
                try {
                  const session = await dispatch('plan', roundDirectory, input, formalizationDigest(input),
                    { name: 'plan-' + planningRound, requireCached: Boolean(acceptedPlanning) });
                  const output = formalizationPlanSchema.parse(session.output);
                  assertFormalizationPlan(request.statement, output);
                  if (output.taskKind !== 'prove') { state.unsupportedTaskKind = output.taskKind; save(); }
                  assertFormalizationPlanReady(output);
                  // Gate only a newly authored plan. An accepted plan restored from
                  // state is frozen evidence for a resumable run; rejecting it now
                  // would make runs started before this check unresumable.
                  const claimShape = acceptedPlanning && planningRound === acceptedPlanning.round ? undefined : claimShapeRejection(output);
                  if (claimShape !== undefined) throw new Error(claimShape);
                  planning = { input, output, digest: formalizationDigest(output), session };
                  state.activeRound.planning = { round: planningRound, feedback: planningFeedback }; save();
                  break;
                } catch (cause) {
                  planningFeedback = errorText(cause).slice(0, 16_000);
                  writeMathJsonDurable(path.join(roundDirectory, 'plan-failure-' + planningRound + '.json'), { error: planningFeedback });
                  if (lease.signal.aborted || !modelDispatchAllowed(buildTokenBudget(request.maxTotalTokens, state.sessions)) ||
                      cause instanceof FormalizationRoleFailure || planningFeedback.includes('formalization_plan_task_kind_unsupported') || infrastructureFailure(planningFeedback) ||
                      /formalization_role_incomplete:failed:(?:unauthorized|badRequest|misalignmentPolicyViolation|cyberPolicy)/u.test(planningFeedback)) throw cause;
                }
              }
              if (!planning) throw new Error('formalization_planning_exhausted: ' + planningFeedback);
            }
            // Retrieval can execute Lean too, so it must join the preparation
            // before either symbol lookup or the generation role starts.
            await awaitPackages();
            let retrieval;
            if (request.retrieval) {
              try {
                const cached = readStageCheckpoint('retrieval');
                if (cached !== undefined) {
                  const corpusText = readMathText(path.join(directory, 'retrieval-corpus.json'));
                  if (mathDigest(corpusText) !== request.retrieval.corpusSha256) throw new Error('formalization_retrieval_corpus_changed');
                  assertMathRetrievalCorpus(request.retrieval.workspace, JSON.parse(corpusText));
                  retrieval = formalizationRetrievalSchema.parse(cached);
                  assertFormalizationRetrieval(request.retrieval, planning!.output, retrieval);
                } else {
                  const base = path.join(roundDirectory, 'library-symbols');
                  retrieval = await retrieveFormalizationPlan(directory, request.retrieval, planning!.output, {
                    directory: fs.existsSync(base) ? base + '-' + crypto.randomUUID() : base, env, signal: lease.signal,
                    timeoutMs: Number.isFinite(stageTimeout(request.maxCompileSeconds)) ? stageTimeout(request.maxCompileSeconds) : 0,
                    proofEnvironmentCacheRoot: DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT,
                    lookupSymbols: options.lookupSymbols,
                  });
                  saveStageCheckpoint('retrieval', retrieval);
                }
              }
              catch (cause) { throw new Error('formalization_retrieval_failed: ' + errorText(cause)); }
            }
            const generationInput = { problemId: request.problemId, statement: request.statement, environment: request.environment,
              toolchain: getLeanTaskEnvironment(request.environment).toolchain, round: state.rounds,
              feedback: state.activeRound.feedback, previousCandidate: state.activeRound.previousCandidate,
              ...(planning ? { plan: planning.output, planDigest: planning.digest } : {}),
              ...(retrieval ? { retrieval } : {}), ...exemplars };
            const generated = await dispatch('generate', roundDirectory, generationInput, formalizationDigest(generationInput));
            const generatedCandidate = formalizationCandidateSchema.parse(generated.output);
            // Admission may reject before erasure; retain the original direct candidate for the next repair round.
            if (direct) state.previousCandidate = generatedCandidate;
            if (!generated.record.candidateCounted) {
              state.generatedCandidates = (state.generatedCandidates ?? 0) + 1;
              generated.record.candidateCounted = true; save();
            }
            let candidate = { ...generatedCandidate, source: eraseFormalizationProofs(generatedCandidate.source) };
            assertFormalizationCandidate(request, candidate);
            if (planning) assertFormalizationPlanCandidate(planning.output, candidate.source, candidate.coverage);
            if (state.rejectedCandidates?.includes(mathDigest(candidate.source)) || state.rejectedCandidates?.includes(formalizationDigest(candidate)))
              throw new Error('formalization_candidate_unchanged_after_rejection');
            currentCandidate = candidate;
            state.previousCandidate = candidate; save();
            let elaborated = readStageCheckpoint('elaboration') as FormalizationElaboration | undefined;
            if (!elaborated) {
              event('formalization_compilation_started');
              const base = path.join(roundDirectory, 'elaboration');
              elaborated = await (options.elaborate ?? elaborateFormalization)(fs.existsSync(base) ? base + '-' + crypto.randomUUID() : base,
                candidate.source, request.environment, { env, signal: lease.signal,
                  ...(request.library ? { library: request.library } : {}),
                  ...(structured ? { detailedContext: true } : {}),
                  ...(semanticContext ? { semanticContext: true } : {}),
                  ...(structureContext ? { structureContext: true } : {}),
                  ...(boundedLibraryContext ? { boundedLibraryContext: true } : {}),
                  timeoutMs: Number.isFinite(stageTimeout(request.maxCompileSeconds)) ? stageTimeout(request.maxCompileSeconds) : 0 });
              saveStageCheckpoint('elaboration', elaborated);
            } else if (elaborated.source !== candidate.source || elaborated.sourceSha256 !== mathDigest(candidate.source) ||
                elaborated.environmentDigest !== getLeanTaskEnvironment(request.environment).dependencyDigest) {
              throw new Error('formalization_checkpoint_changed:elaboration');
            }
            candidate = { ...candidate, source: elaborated.source };
            const snapshot = formalizationSnapshotSchema.parse(elaborated.snapshot), snapshotDigest = formalizationDigest(snapshot);
            if (snapshotDigest !== elaborated.snapshotDigest ||
                !boundedLibraryContext && snapshot.targets.some(item => item.context.omitted.length))
              throw new Error('formalization_context_incomplete');
            if (structured) {
              const contexts = parseLeanStatementContexts(JSON.stringify(snapshot.targets.map(target =>
                ({ id: target.name, context: target.context }))), snapshot.targets.map(target => target.name),
                { boundedLibraryContext });
              if ([...contexts.values()].some(context => !context.bindings)) throw new Error('formalization_context_missing_bindings');
              if (semanticContext && [...contexts.values()].some(context => !context.semantic))
                throw new Error('formalization_context_missing_semantic_context');
              if (structureContext && [...contexts.values()].some(context => !context.structures))
                throw new Error('formalization_context_missing_structures');
            }
            if (request.compatibility) {
              const missing = unavailableFormalizationNames(candidate.source, snapshot.targets as CompatibilityTarget[],
                readFormalizationCompatibilityNames(directory, request.compatibility));
              if (missing.length) throw new Error(nameCompatibilityRejection(missing, request.compatibility.provenance));
            }
            const inputDigest = formalizationInputDigest(request, candidate);
            if (direct) {
              const finalUsage = buildTokenBudget(request.maxTotalTokens, state.sessions);
              if (finalUsage.status === 'usage-unavailable') throw new Error(finalUsage.reason);
              const record = generated.record;
              const evidence = directFormalizationEvidenceSchema.parse({
                schema: 'theorem-os.formalization-evidence.v4', status: 'approved', authority: 'compiler',
                method: 'generation-and-compilation', semanticReview: 'not-performed', execution: request.execution,
                modelInvoked: request.execution === 'model', proofVerified: false,
                request, requestDigest, candidate, inputDigest, sourceSha256: elaborated.sourceSha256, targets: elaborated.targets,
                generation: { input: generationInput, output: generatedCandidate }, snapshot, snapshotDigest, compilation: elaborated.compilation,
                sessions: [{ role: 'generate', threadId: record.threadId!, turnId: record.turnId!, status: record.status as 'completed' | 'submitted',
                  ...(record.completionReason ? { completionReason: record.completionReason } : {}),
                  inputDigest: record.inputDigest, outputDigest: record.outputDigest!, model: record.model, effort: record.effort, usage: record.usage }],
                approvedAt: new Date().toISOString(), round: state.rounds,
              });
              writeFormalizationArtifact(directory, evidence);
              const seed = bootstrapFormalizedProblem(directory);
              state.status = 'approved'; delete state.error; delete state.feedback; delete state.activeRound; save();
              event('formalization_approved');
              return { ...summary(), ...seed };
            }
            if (options.onCompiledCandidate) {
              const compiled = formalizationCompiledCandidate({ request, requestDigest, candidate, inputDigest,
                sourceSha256: elaborated.sourceSha256, targets: elaborated.targets, snapshot, snapshotDigest,
                compilation: { ...elaborated.compilation, diagnostics: z.record(z.unknown()).parse(elaborated.compilation.diagnostics) },
                round: state.rounds });
              assertFormalizationCompiledCandidate(compiled);
              await options.onCompiledCandidate(compiled);
            }
            let translated: Awaited<ReturnType<typeof dispatch>>;
            if (request.falsification) {
              // The refuter runs beside the backtranslator; a terminal failure of either ends the other.
              let terminalFailure: { cause: unknown } | undefined;
              const guard = <T>(work: Promise<T>) => work.catch((cause: unknown) => {
                if (!lease.signal.aborted && (cause instanceof FormalizationRoleFailure || infrastructureFailure(errorText(cause)) ||
                    !modelDispatchAllowed(buildTokenBudget(request.maxTotalTokens, state.sessions)))) {
                  terminalFailure ??= { cause }; controller.abort();
                }
                throw cause;
              });
              const [translation, refutation] = await Promise.allSettled([
                guard(dispatch('backtranslate', roundDirectory, { ...snapshot, snapshotDigest }, snapshotDigest)),
                guard(refuteCandidate(roundDirectory, candidate.source, snapshot, snapshotDigest)),
              ]);
              if (terminalFailure) throw terminalFailure.cause;
              if (refutation.status === 'rejected') throw refutation.reason;
              if (refutation.value.length) { semanticallyRejected = true; throw new Error(refutationRejection(refutation.value)); }
              if (translation.status === 'rejected') throw translation.reason;
              translated = translation.value;
            } else translated = await dispatch('backtranslate', roundDirectory, { ...snapshot, snapshotDigest }, snapshotDigest);
            const translation = formalizationTranslationSchema.parse(translated.output);
            const translationDigest = formalizationDigest(translation);
            if (translation.snapshotDigest !== snapshotDigest ||
                canonicalMathJson(translation.targets.map(item => item.name).sort()) !== canonicalMathJson(elaborated.targets.map(item => item.name).sort()))
              throw new Error('formalization_translation_identity_mismatch');
            const reviewers = request.workflow?.reviewers ?? [{ id: undefined }];
            const compareFidelity = shareFormalizationFidelityComparisons({ env, signal: lease.signal }, options.compareReference);
            let revisionRequested = false;
            const deferredReviews: { reviewerId?: string; error: string }[] = [];
            const runReviewer = async (reviewer: typeof reviewers[number]) => {
              const binding = { inputDigest, snapshotDigest, translationDigest,
                ...(planning ? { planDigest: planning.digest, reviewerId: reviewer.id } : {}) };
              const compareInput = structured ? formalizationReviewInput(request, candidate, snapshot, translation,
                planning ? { planDigest: planning.digest, reviewerId: reviewer.id } : undefined) :
                { original: request.statement, notes: candidate, snapshot, translation, ...binding, ...(planning ? { plan: planning.output } : {}) };
              const compared = await dispatch('compare', roundDirectory, compareInput, structured ? formalizationDigest(compareInput) : formalizationDigest(binding),
              reviewer.id ? { reviewerId: reviewer.id, retryWhen: () => !revisionRequested } : undefined);
              const review = structured ? assertStructuredSemanticReview(compareInput as StructuredReviewInput, compared.output) :
                formalizationReviewSchema.parse(compared.output);
              if (!structured && ('snapshotDigest' in review && (review.inputDigest !== inputDigest ||
                  review.snapshotDigest !== snapshotDigest || review.translationDigest !== translationDigest)))
                throw new Error('formalization_review_identity_mismatch');
              const correspondence = structured ? await checkFormalizationFidelity(
                path.join(roundDirectory, 'fidelity-' + (reviewer.id ?? 'reviewer')), compareInput as StructuredReviewInput, review as
                  import('../math/formalizationSemanticReview').StructuredSemanticReview,
                { env, signal: lease.signal,
                  ...(request.library && review.verdict === 'approved' && 'fidelity' in review && review.fidelity?.sourceContract ? { libraryPack:
                    selectFormalizationLibraryPack(request.library, [candidate.source, review.fidelity.sourceContract.source]) } : {}),
                  timeoutMs: Number.isFinite(stageTimeout(request.maxCompileSeconds)) ?
                  stageTimeout(request.maxCompileSeconds) : 0, compareReference: compareFidelity }) : undefined;
              if (request.fidelityPolicy && request.workflow?.reviewScheduling === 'parallel' && review.verdict === 'changes_requested')
                revisionRequested = true;
              return { compared, review, reviewerId: reviewer.id, ...(correspondence ? { correspondence } : {}) };
            };
            const comparisons = [];
            if (request.workflow?.reviewScheduling === 'parallel') {
              // Join every role before revision/exit; preserve configured order, not finish order.
              // A permanent role/infrastructure failure must also end a sibling's
              // unlimited transient retries, while preserving the original error.
              let terminalFailure: { cause: unknown } | undefined;
              const settled = await Promise.allSettled(reviewers.map(async reviewer => {
                try { return await runReviewer(reviewer); }
                catch (cause) {
                  if (!lease.signal.aborted && revisionRequested && retryableRoleFailure(cause)) {
                    deferredReviews.push({ reviewerId: reviewer.id, error: errorText(cause) });
                    event('formalization_review_retry_deferred', 'compare', reviewer.id);
                    throw cause;
                  }
                  if (!lease.signal.aborted && (cause instanceof FormalizationRoleFailure || infrastructureFailure(errorText(cause)) ||
                      !modelDispatchAllowed(buildTokenBudget(request.maxTotalTokens, state.sessions)))) {
                    terminalFailure ??= { cause }; controller.abort();
                  }
                  throw cause;
                }
              }));
              if (terminalFailure) throw terminalFailure.cause;
              for (const result of settled) if (result.status === 'fulfilled') comparisons.push(result.value);
              const failure = settled.find((result, index) => result.status === 'rejected' &&
                !deferredReviews.some(item => item.reviewerId === reviewers[index]!.id));
              if (failure?.status === 'rejected') throw failure.reason;
            } else for (const reviewer of reviewers) comparisons.push(await runReviewer(reviewer));
            lease.signal.throwIfAborted();
            // Both reviewers run. Once a valid change request exists, a failed
            // sibling need not retry. An incomplete panel can only request revision.
            const rejected = comparisons.filter(item => item.review.verdict !== 'approved' || !structured && (item.review.issues.length ||
              Object.values(item.review.checks).some(value => !value)));
            const decision = structured && !deferredReviews.length ? resolveStructuredReviewPanel(comparisons.map(item => item.review)) : undefined;
            writeMathJsonDurable(path.join(roundDirectory, 'reviews.json'), {
              policy: 'all-approve', agreement: deferredReviews.length ? 'incomplete' : rejected.length === 0 ? 'unanimous-approval' :
                rejected.length === comparisons.length ? 'no-approval' : 'disagreement',
              ...(deferredReviews.length ? { deferredReviews } : {}),
              ...(decision ? { protocol: STRUCTURED_REVIEW_PROTOCOL, decision } : {}),
              reviews: comparisons.map(({ review, reviewerId, correspondence }) => ({ reviewerId, review,
                ...(correspondence ? { correspondence } : {}) })) });
            if (rejected.length) { semanticallyRejected = !structured || decision?.verdict === 'changes_requested';
              throw new Error((deferredReviews.length ? 'formalization_review_revision_requested: ' :
                decision?.verdict === 'unknown' ? 'formalization_semantic_unknown: ' : 'formalization_semantic_changes_requested: ') +
              rejected.map(item => (item.reviewerId ?? 'reviewer') + ': ' + item.review.verdict + ': ' + item.review.summary + '\n' +
                (structured ? item.review.correspondences.filter(evidence => evidence.relation === 'mismatch' || evidence.relation === 'unresolved')
                  .map(evidence => evidence.aspect + ': ' + evidence.explanation + (evidence.mismatchEvidence ?
                    '\n' + JSON.stringify(evidence.mismatchEvidence) : '')).join('\n') : item.review.issues.join('\n'))).join('\n')); }
            if (comparisons.some(item => item.correspondence && item.correspondence.status !== 'established'))
              throw new Error('formalization_fidelity_not_established: Whole-target correspondence was not established for ' +
                comparisons.filter(item => item.correspondence?.status !== 'established').map(item => item.reviewerId).join(', ') +
                '. This is unresolved correspondence, not proof of inequivalence. Revise the source reading or candidate without proving the original theorem.');
            const finalUsage = buildTokenBudget(request.maxTotalTokens, state.sessions);
            if (finalUsage.status === 'usage-unavailable') throw new Error(finalUsage.reason);
            let reference: FormalizationReferenceResult | undefined;
            if (request.workflow?.reference) {
              const configured = request.workflow.reference;
              if (canonicalMathJson(configured.pairs.map(item => item.candidateTarget).sort()) !==
                  canonicalMathJson(elaborated.targets.map(item => item.name).sort()))
                throw new Error('formalization_reference_target_mapping_invalid');
              const referenceInput = {
                candidateSource: candidate.source, referenceSource: configured.source, environment: request.environment, pairs: configured.pairs,
                ...(request.library ? { libraryPack: selectFormalizationLibraryPack(request.library, [candidate.source, configured.source]) } : {}),
              };
              const cachedReference = readStageCheckpoint('reference');
              if (cachedReference === undefined) {
                event('formalization_reference_started');
                const base = path.join(roundDirectory, 'reference');
                reference = await (options.compareReference ?? compareFormalizationReference)(
                  fs.existsSync(base) ? base + '-' + crypto.randomUUID() : base, referenceInput,
                  { env, signal: lease.signal, timeoutMs: Number.isFinite(stageTimeout(configured.maxSeconds)) ? stageTimeout(configured.maxSeconds) : 0 });
                lease.signal.throwIfAborted();
                if (reference.status === 'established') {
                  assertFormalizationReferenceResult(referenceInput, reference);
                  saveStageCheckpoint('reference', reference);
                }
              } else {
                assertFormalizationReferenceResult(referenceInput, cachedReference);
                reference = cachedReference;
              }
              if (reference.status !== 'established') throw new Error('formalization_reference_not_established');
            }
            const review = comparisons[0]!.review;
            const evidence = { schema: structured ? 'theorem-os.formalization-evidence.v3' :
              planning ? 'theorem-os.formalization-evidence.v2' : 'theorem-os.formalization-evidence.v1', status: 'approved', authority: 'model',
              method: 'independent-backtranslation-and-comparison', execution: request.execution,
              modelInvoked: request.execution === 'model', proofVerified: false,
              request, requestDigest, candidate, inputDigest, sourceSha256: elaborated.sourceSha256, targets: elaborated.targets,
              generation: { input: generationInput, output: generatedCandidate },
              snapshot, snapshotDigest, compilation: elaborated.compilation, translation, translationDigest, review,
              ...(planning ? { workflow: { schema: structured ? 'theorem-os.formalization-workflow-evidence.v3' : 'theorem-os.formalization-workflow-evidence.v2',
                plan: { input: planning.input, output: planning.output, digest: planning.digest },
                reviews: comparisons.map(({ review, reviewerId, correspondence }) => ({ reviewerId: reviewerId!, review,
                  ...(correspondence ? { correspondence } : {}) })),
                reviewAgreement: 'unanimous', distinctModelConfigurations: distinctFormalizationModelConfigurations(request, request.workflow!),
                profileDigest,
                selectionPolicy: 'first-unanimously-approved', ...(reference ? { reference } : {}) } } : {}),
              sessions: [...(planning ? [planning.session] : []), generated, translated, ...comparisons.map(item => item.compared)].map(({ record }) => ({
                role: record.role, threadId: record.threadId!, turnId: record.turnId!, status: record.status,
                ...(record.completionReason ? { completionReason: record.completionReason } : {}),
                inputDigest: record.inputDigest, outputDigest: record.outputDigest!, model: record.model, effort: record.effort, usage: record.usage,
                ...(request.workflow ? { configurationDigest: record.configurationDigest, ...(record.reviewerId ? { reviewerId: record.reviewerId } : {}) } : {}),
              })), approvedAt: new Date().toISOString(), round: state.rounds } as FormalizationEvidence;
            writeFormalizationArtifact(directory, evidence);
            const seed = bootstrapFormalizedProblem(directory);
            state.status = 'approved'; delete state.error; delete state.feedback; delete state.activeRound; delete state.unknownRounds; save();
            event('formalization_approved');
            return { ...summary(), ...seed };
          } catch (cause) {
            if (fs.existsSync(path.join(directory, 'artifact'))) throw cause;
            if (currentCandidate && semanticallyRejected)
              state.rejectedCandidates = [...new Set([...(state.rejectedCandidates ?? []), mathDigest(currentCandidate.source)])];
            // An unknown verdict is unresolved evidence, never a mismatch: it is
            // not blacklisted, but repeated consecutive unknown rounds are.
            if (!semanticallyRejected && errorText(cause).startsWith('formalization_semantic_unknown:'))
              state.unknownRounds = (state.unknownRounds ?? 0) + 1;
            else delete state.unknownRounds;
            state.error = errorText(cause).slice(0, 16_000);
            writeMathJsonDurable(path.join(roundDirectory, 'failure.json'), { error: state.error, round: state.rounds });
            save();
            // Coverage diagnostics quote candidate/source data, which may itself
            // contain reserved error strings. Only its actual code controls retry.
            const retryClassification = state.error.startsWith('formalization_coverage_invalid:') ? 'formalization_coverage_invalid' : state.error;
            if (lease.signal.aborted || !modelDispatchAllowed(buildTokenBudget(request.maxTotalTokens, state.sessions)) ||
                cause instanceof FormalizationRoleFailure || retryClassification.includes('formalization_plan_task_kind_unsupported') || infrastructureFailure(retryClassification) ||
                /formalization_role_incomplete:failed:(?:unauthorized|badRequest|misalignmentPolicyViolation|cyberPolicy)/u.test(retryClassification)) throw cause;
            state.feedback = state.error;
            if (direct && state.error.startsWith('formalization_unsupported_declaration'))
              state.feedback += '\nUse only imports, namespaces, sections, variable/universe declarations and ordinary named def/abbrev/instance/theorem/lemma declarations. Replace structure or inductive declarations with ordinary predicates or existential quantifiers; do not use custom notation or metaprogramming.';
            delete state.activeRound; save();
            // Another round is pointless once consecutive unknown verdicts prove
            // the ambiguity survives fresh candidates, and an unlimited round
            // budget would otherwise never end the run.
            if ((state.unknownRounds ?? 0) >= MAX_UNKNOWN_ROUNDS) break;
            event('formalization_revision_requested', undefined, state.feedback);
          }
        }
        state.status = 'exhausted'; save();
        return summary();
      } catch (cause) {
        state.status = 'stopped'; state.error = packageFailure ?
          'formalization_sandbox_packages_failed: ' + errorText(packageFailure.cause) : errorText(cause); save();
        return summary();
      } finally {
        cancelTimer?.(); packageController.abort(); await packagePreparation;
        lease.signal.removeEventListener('abort', abortPackages); save(false);
      }
    });
  } catch (cause) {
    // A requested cancellation releases the lease after its operation has saved
    // the stopped result. Preserve that result instead of losing it at assertHeld.
    if (controller.signal.aborted && errorText(cause) === 'math_runtime_lease_lost') {
      const stopped = readFormalizationState(directory);
      if (stopped?.status === 'stopped') return summarizeRun(directory, request, stopped);
    }
    throw cause;
  } finally {
    options.signal?.removeEventListener('abort', externalAbort);
    process.removeListener('SIGINT', externalAbort); process.removeListener('SIGTERM', externalAbort);
  }
}

/** Preset outputs exercise compilation failure, semantic rejection, repair and native seed creation. Never a benchmark result. */
export async function replayFormalization(directory: string, root: string, buildManifestRef: string) {
  prepareFormalization(directory, {
    problemId: 'formalization_replay_addition', statement: 'For every natural number n, prove both n + 0 = n and 0 + n = n.',
    environment: 'standard', execution: 'replay', model: 'preset-replay', effort: 'none', profile: '/preset-replay', executable: '/no-model',
    buildManifestRef, maxRounds: 3, maxRunSeconds: 300, maxTurnSeconds: 30, maxCompileSeconds: 120, maxTotalTokens: 0,
    workflow: defaultFormalizationWorkflow({ model: 'preset-replay', effort: 'none', profile: '/preset-replay', executable: '/no-model' }),
  });
  let generations = 0, sessions = 0;
  return runFormalization(directory, root, { openSession: async options => ({
    threadId: 'preset-role-' + ++sessions, interrupt: async () => {}, close: async () => {},
    run: async (_message, _id, workspace, onStarted) => {
      onStarted('preset-turn-' + sessions);
      options.onUsage({ totalTokens: 0, inputTokens: 0, outputTokens: 0 });
      const input = JSON.parse(readMathText(path.join(workspace, 'INPUT.json'), 8_000_000));
      const role = path.basename(workspace);
      let output: unknown;
      if (role.startsWith('plan-')) {
        output = { schema: 'theorem-os.formalization-plan.v1', taskKind: 'prove',
          spans: [{ id: 'original', start: 0, end: input.statement.length, text: input.statement }],
          objects: [{ id: 'natural-number', spanIds: ['original'], description: 'An arbitrary natural number n.', leanType: 'Nat' }],
          assumptions: [], definitions: [], unresolved: [],
          conclusions: ['left', 'right'].map(name => ({ id: 'conclusion-' + name, spanIds: ['original'],
            mathematics: name === 'left' ? 'For all n : Nat, n + 0 = n.' : 'For all n : Nat, 0 + n = n.',
            targetNames: [name], assumptionIds: [] })) };
      } else if (role === 'generate') {
        generations++;
        const source = (generations === 1 ? 'theorem left (n : MissingNat) : n + 0 = n := by sorry\n' :
          generations === 2 ? 'theorem left (n : Nat) : n + 0 = 0 := by sorry\n' : 'theorem left (n : Nat) : n + 0 = n := by sorry\n') +
          'theorem right (n : Nat) : 0 + n = n := by sorry\n';
        output = { source, coverage: [{ originalText: input.statement, targetNames: ['left', 'right'],
          explanation: 'Preset fixture only; translate both addition targets.' }], assumptions: ['n is a natural number'],
        assumptionsExplanation: 'Natural-number domain; no additional hypotheses.', definitionsExplanation: 'Uses standard natural-number addition.' };
      } else if (role === 'backtranslate') {
        output = { snapshotDigest: input.snapshotDigest, mathematics: generations === 2 ? 'The first target incorrectly states n + 0 = 0.' :
          'Both natural-number zero identities.', assumptions: [], definitions: ['Standard natural-number addition.'],
        targets: input.targets.map((item: { name: string; context: { type: string } }) => ({ name: item.name, mathematics: item.context.type })) };
      } else {
        output = { schema: 'theorem-os.formalization-semantic-review.v2', caseId: input.caseId, inputDigest: formalizationDigest(input),
          evidenceVersion: 'source-readings-v1',
          verdict: generations === 2 ? 'changes_requested' : 'approved',
          summary: generations === 2 ? 'The first target changed the conclusion.' : 'Both original zero identities are faithfully represented.',
          checks: Object.fromEntries(structuredReviewAspects.map(aspect => [aspect,
            generations === 2 && aspect === 'conclusions' ? 'mismatch' : 'faithful'])),
          correspondences: structuredReviewAspects.map(aspect => ({ aspect, originalFragment: input.original,
            candidateFragment: input.candidate, relation: generations === 2 && aspect === 'conclusions' ? 'mismatch' : 'direct',
            explanation: generations === 2 && aspect === 'conclusions' ? 'Restore n as the first target right hand side.' :
              'Preset fixture compares the natural-number zero identities.', forwardArgument: '', reverseArgument: '', sourceReadings: [],
            mismatchEvidence: generations === 2 && aspect === 'conclusions' ? {
              sourceClaim: 'For every natural n, n + 0 = n and 0 + n = n.',
              candidateClaim: 'For every natural n, n + 0 = 0 and 0 + n = n.',
              separationArgument: 'At n = 1, the first candidate equality fails while both source equalities hold.',
            } : null })) };
      }
      fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), canonicalMathJson(output), { flag: 'wx', mode: 0o600 });
      return 'completed';
    },
  }) });
}
