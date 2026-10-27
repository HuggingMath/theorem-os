import fs from 'node:fs';
import { scheduleMathTimeout } from '../math/mathTimers';
import { getFormalizationRoleOutputSchema, getFormalizationRoleOutputValidator,
  getStructuredFormalizationReviewOutputSchema } from '../math/formalizationRoleContract';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { parse as parseToml } from 'smol-toml';
import { createCodexMathSession, type MathAgentOptions, type MathAgentSession } from '../runtime/codexSession';
import { readMathBuildManifest } from '../math/mathBuildManifest';
import { canonicalMathJson, mathDigest, readMathText, withMathRuntimeLease, writeMathJsonDurable } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { projectMathematicsRuntimeEnvironment, resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { getLeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { eraseFormalizationProofs } from '../math/formalizationSource';
import { assertFormalizationCandidate, bootstrapFormalizedProblem, formalizationCandidateSchema, formalizationDigest,
  formalizationInputDigest, formalizationReviewInput, formalizationReviewSchema, formalizationSnapshotSchema, formalizationTranslationSchema,
  prepareFormalization, readFormalizationArtifact, readFormalizationRequest, writeFormalizationArtifact,
  type FormalizationCandidate, type FormalizationEvidence, type FormalizationRequest } from '../math/formalization';
import { elaborateFormalization } from './formalizationElaboration';
import { formalizationPlanSchema, assertFormalizationPlan, assertFormalizationPlanReady, assertFormalizationPlanCandidate,
  type FormalizationPlan } from '../math/formalizationPlan';
import { defaultFormalizationWorkflow, formalizationModelConfigurations, formalizationModelConfigurationDigest,
  distinctFormalizationModelConfigurations } from '../math/formalizationWorkflow';
import { compareFormalizationReference } from './formalizationReference';
import { checkFormalizationFidelity } from './formalizationFidelity';
import { assertStructuredSemanticReview, resolveStructuredReviewPanel, structuredReviewAspects,
  formalizationReviewInstructions, STRUCTURED_REVIEW_PROTOCOL,
  type StructuredReviewInput } from '../math/formalizationSemanticReview';
import { parseLeanStatementContexts } from '../math/leanStatementContext';
import { retrieveFormalizationPlan } from '../math/formalizationRetrieval';
import type { lookupLeanLibrarySymbols } from '../math/leanLibrarySymbols';
import { buildTokenBudget, initializeUsageAccounting, modelDispatchAllowed, reportedTotalTokens, type UsageAccounting } from './usageBudget';

const roleSchema = z.enum(['plan', 'generate', 'backtranslate', 'compare']);
type Role = z.infer<typeof roleSchema>;
const sessionSchema = z.object({
  role: roleSchema, round: z.number().int().positive(), threadId: z.string().optional(), turnId: z.string().optional(),
  status: z.string(), inputDigest: z.string(), outputDigest: z.string().optional(), model: z.string(), effort: z.string(),
  reviewerId: z.string().optional(), configurationDigest: z.string().optional(),
  completionReason: z.literal('validated-output').optional(), isolationReceipt: z.record(z.unknown()).optional(),
  roleContract: z.object({ schema: z.literal('theorem-os.formalization-role-contract.v1'),
    roleInstructionsSha256: z.string().regex(/^[a-f0-9]{64}$/u), outputSchemaSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().optional(),
  failureDiagnostic: z.object({ code: z.string(), httpStatusCode: z.number().int().optional() }).strict().optional(),
  turns: z.number().int().nonnegative(), usage: z.record(z.unknown()),
  usageAccounting: z.object({ startedTurns: z.number().int().nonnegative(), reportedTurns: z.number().int().nonnegative(),
    pending: z.boolean(), incomplete: z.boolean() }).strict(),
}).strict();
const stateSchema = z.object({
  schema: z.literal('theorem-os.formalization-state.v1'), requestDigest: z.string(),
  status: z.enum(['running', 'approved', 'exhausted', 'stopped']), rounds: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(), environmentDigest: z.string(), profileDigest: z.string(),
  sessions: z.array(sessionSchema), feedback: z.string().optional(), previousCandidate: formalizationCandidateSchema.optional(),
  error: z.string().optional(),
  activeSince: z.number().int().nonnegative().optional(), rejectedCandidates: z.array(z.string()).optional(),
  unsupportedTaskKind: z.enum(['decision', 'construction']).optional(),
  generatedCandidates: z.number().int().nonnegative().optional(),
}).strict();
type SessionRecord = Omit<z.infer<typeof sessionSchema>, 'turns' | 'usageAccounting'> & { turns: number; usageAccounting: UsageAccounting };
type State = Omit<z.infer<typeof stateSchema>, 'sessions'> & { sessions: SessionRecord[] };
const summarizeRun = (directory: string, request: FormalizationRequest, state: State) => ({
  status: state.status as 'approved' | 'exhausted' | 'stopped', directory, rounds: state.rounds,
  modelInvoked: request.execution === 'model' && state.sessions.some(item => item.turns > 0),
  tokenBudget: buildTokenBudget(request.maxTotalTokens, state.sessions),
  ...(request.workflow ? { candidateSelection: request.workflow.candidateSelection, candidatesTried: state.generatedCandidates ?? 0,
    firstCandidateApproved: state.status === 'approved' && state.generatedCandidates === 1,
    distinctModelConfigurations: distinctFormalizationModelConfigurations(request, request.workflow),
    roleTurns: Object.fromEntries(roleSchema.options.map(role => [role,
      state.sessions.filter(item => item.role === role).reduce((sum, item) => sum + item.turns, 0)])) } : {}),
  ...(state.error ? { error: state.error } : {}),
});
type Options = {
  openSession?: (options: MathAgentOptions) => Promise<MathAgentSession>;
  elaborate?: typeof elaborateFormalization;
  compareReference?: typeof compareFormalizationReference;
  lookupSymbols?: typeof lookupLeanLibrarySymbols;
  env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  onEvent?: (event: { event: string; round: number; role?: Role; error?: string }) => void;
};
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const infrastructureFailure = (message: string) =>
  /(?:formalization_(?:sandbox|relay|profile|build|retrieval)|math_model_api_key_missing|math_codex_(?:transport_closed|rpc_failed|session_binding_mismatch))/u.test(message);
const roleInstructions: Record<Role, string> = {
  plan: [
    'Plan a faithful Lean formalization of the complete original mathematical task in INPUT.json before generating declarations.',
    'Write exactly one strict JSON object to OUTPUT.json with schema,taskKind,spans,objects,assumptions,conclusions,definitions,unresolved.',
    'schema is theorem-os.formalization-plan.v1; taskKind is prove, decision or construction. Classify yes/no questions as decision. Do not assume the answer is yes, and never replace a requested decision with excluded middle.',
    'spans is an array of {id,start,end,text}: exact nonempty original text at JavaScript UTF-16 slice(start,end), without splitting a surrogate pair. Use stable unique alphanumeric IDs.',
    'objects is [{id,spanIds,description,leanType}]; describe domains and quantifiers explicitly.',
    'assumptions is [{id,spanIds,mathematics}]; list every hypothesis or convention, never a desired conclusion.',
    'conclusions is [{id,spanIds,mathematics,targetNames,assumptionIds}]; cover every original subquestion and proposed target, with faithful domains and quantifiers.',
    'definitions is [{id,spanIds,mathematics,implementation,leanNames,dependsOn,justification}]; implementation is existing (pinned library) or new (local def/abbrev/named instance). dependsOn contains definition IDs and must be acyclic.',
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
};

export function readFormalizationState(directory: string): State | undefined {
  const file = path.join(directory, 'state.json'); assertMathCanonicalPath(file);
  return fs.existsSync(file) ? stateSchema.parse(JSON.parse(readMathText(file, 8_000_000))) as State : undefined;
}

/** Each role gets a new thread and only the inputs of that role. No solver target exists before review succeeds. */
export async function runFormalization(directory: string, root: string, options: Options = {}) {
  directory = path.resolve(directory); root = path.resolve(root);
  assertMathCanonicalPath(directory);
  if (isMathPathWithin(root, directory) || isMathPathWithin(directory, root)) throw new Error('formalization_directory_must_be_external');
  const request = readFormalizationRequest(directory), requestDigest = formalizationDigest(request);
  const structured = request.schema === 'theorem-os.formalization-request.v3';
  const semanticContext = request.contextProtocol === 'kernel-v1' || request.contextProtocol === 'kernel-v2';
  const structureContext = request.contextProtocol === 'kernel-v2';
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
      const dispatch = async (role: Role, roundDirectory: string, input: unknown, inputDigest: string,
        slot?: { reviewerId?: string; name?: string }) => {
        lease.signal.throwIfAborted();
        if (remaining() <= 0) throw new Error('formalization_time_limit');
        const budget = buildTokenBudget(request.maxTotalTokens, state.sessions);
        if (!modelDispatchAllowed(budget)) throw new Error(budget.reason ?? 'formalization_token_limit');
        if (currentProfileDigest() !== profileDigest) throw new Error('formalization_profile_changed_during_run');
        const config = role === 'plan' ? request.workflow!.planner : role === 'backtranslate' && request.workflow ?
          request.workflow.backtranslator : role === 'compare' && request.workflow ?
            request.workflow.reviewers.find(item => item.id === slot?.reviewerId)! : request;
        if (!config) throw new Error('formalization_role_configuration_missing');
        const workspace = path.join(roundDirectory, slot?.name ?? (slot?.reviewerId ? 'compare-' + slot.reviewerId : role));
        fs.mkdirSync(workspace, { mode: 0o700 });
        const inputFile = path.join(workspace, 'INPUT.json'), outputFile = path.join(workspace, 'OUTPUT.json');
        const inputText = canonicalMathJson(input);
        fs.writeFileSync(inputFile, inputText, { mode: 0o400, flag: 'wx' });
        const instructionsFile = path.join(workspace, 'ROLE.md'), schemaFile = path.join(workspace, 'OUTPUT.schema.json');
        const structuredInput = structured && role === 'compare' ? input as StructuredReviewInput : undefined;
        const validateOutput = (value: unknown) => structuredInput ? assertStructuredSemanticReview(structuredInput, value) :
          getFormalizationRoleOutputValidator(role).parse(value);
        const instructionsText = (structured && role === 'compare' ? formalizationReviewInstructions('review', semanticContext, structureContext, request.fidelityPolicy) :
          structured && role === 'backtranslate' ? formalizationReviewInstructions('backtranslate', semanticContext, structureContext) : roleInstructions[role]) +
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
          request.fidelityPolicy ? '\nThe developer instructions contain the complete role protocol. Read OUTPUT.schema.json and INPUT.json in this directory. ROLE.md is a frozen copy for reference; reading it again is unnecessary.' :
            '\nRead ROLE.md and OUTPUT.schema.json, then INPUT.json in this directory. These files contain the complete role protocol and task data.',
          ...(request.fidelityPolicy ? ['Preserve the complete original task. Reordering independent parameters and supported equivalent representations are allowed; changing whole-structure assumptions into pair-local assumptions, weakening premises or strengthening conclusions is not approval. Establish the comparison of full obligations, not separate provability.'] : []),
          'OUTPUT.schema.json describes the exact output structure, field types and required fields. Do not search installed libraries, old sessions or runtime source for the output protocol.',
          'The host still checks cross-references, exact source spans, mathematical fidelity and Lean source admission after checking JSON structure.',
          request.fidelityPolicy && request.environment === 'standard' ?
            'This request uses only the Lean standard library. Installed Lean sources are in /opt/lean/src/lean; Mathlib is unavailable and /opt/lean-packages is not mounted.' :
            'Installed Lean sources are in /opt/lean/src/lean; pinned Mathlib and dependencies are in /opt/lean-packages (Mathlib: /opt/lean-packages/mathlib/Mathlib).',
          'Use lean directly to inspect declarations when necessary; LEAN_PATH is already configured. The installed library cache is read-only and does not need Lake setup.',
          'Use these exact library paths when needed. Other tasks, benchmark answers and prior sessions are unavailable.',
          'This is statement formalization. Do not search for or construct theorem proofs during planning, generation or semantic review.',
          ...(request.fidelityPolicy && role === 'plan' ? [
            'Planning is complete when the requested objects, assumptions, conclusion types and definition dependencies are covered. Inspect declaration types only when necessary to resolve a concrete uncertainty, then submit the plan; constructing proof expressions is outside this role.',
          ] : []),
          ...(request.fidelityPolicy && role === 'generate' ? [
            'Implement the supplied plan as declarations with erased theorem proofs. Once the final candidate type-checks, submit it. Repeat a successful Lean check only after changing a mathematical declaration or to resolve a new diagnostic; changing comments or notes does not require another check.',
          ] : []),
          'Write your complete final JSON atomically (write a temporary file, then rename it to OUTPUT.json).',
          'The first complete schema-valid OUTPUT.json is your submission: the host ends this role and validates it. Stop after submitting.',
          'Do not change INPUT.json, ROLE.md or OUTPUT.schema.json. Read only this role input, protocol and installed libraries; do not search for benchmark answers.',
        ].join('\n');
        const schemaText = canonicalMathJson(structuredInput ?
          getStructuredFormalizationReviewOutputSchema(structuredInput) : getFormalizationRoleOutputSchema(role));
        fs.writeFileSync(instructionsFile, instructionsText, { mode: 0o400, flag: 'wx' });
        fs.writeFileSync(schemaFile, schemaText, { mode: 0o400, flag: 'wx' });
        const record: SessionRecord = { role, round: state.rounds, status: 'opening', inputDigest,
          model: config.model, effort: config.effort, turns: 0, usage: {},
          roleContract: { schema: 'theorem-os.formalization-role-contract.v1',
            roleInstructionsSha256: mathDigest(instructionsText), outputSchemaSha256: mathDigest(schemaText) },
          ...(request.workflow ? { configurationDigest: formalizationModelConfigurationDigest(config),
            ...(slot?.reviewerId ? { reviewerId: slot.reviewerId } : {}) } : {}),
          usageAccounting: { startedTurns: 0, reportedTurns: 0, pending: false, incomplete: false } };
        state.sessions.push(record); save(); event('formalization_role_started', role);
        let session: MathAgentSession | undefined, incomplete = false;
        const interrupt = () => { void session?.interrupt().catch(() => {}); void session?.close().catch(() => {}); };
        lease.signal.addEventListener('abort', interrupt, { once: true });
        try {
          session = await (options.openSession ?? createCodexMathSession)({
            executable: config.executable, profile: config.profile, workspace, model: config.model, effort: config.effort,
            instructions: instructionsText,
            environment: env, signal: lease.signal,
            turnTimeoutMs: Number.isFinite(stageTimeout(request.maxTurnSeconds)) ? stageTimeout(request.maxTurnSeconds) : undefined,
            ...(request.execution === 'model' ? { readIsolation: { environment: request.environment } } : {}),
            completedOutput: { file: outputFile, validate: value => { validateOutput(value); } },
            onUsage: usage => { record.usage = usage; save(); }, onUsageIncomplete: () => { incomplete = true; },
          });
          if (session.isolationReceipt) record.isolationReceipt = session.isolationReceipt;
          if (lease.signal.aborted) { await session.close(); lease.signal.throwIfAborted(); }
          record.threadId = session.threadId;
          if (state.sessions.some(item => item !== record && item.threadId === record.threadId))
            throw new Error('formalization_role_thread_reused');
          record.usageAccounting.startedTurns = 1; record.usageAccounting.pending = true;
          record.status = 'running'; save();
          record.status = await session.run(request.fidelityPolicy ?
            'Follow the complete role protocol in the developer instructions. Read OUTPUT.schema.json and INPUT.json, write OUTPUT.json atomically using that contract, then stop. ROLE.md is the same protocol and need not be reread.' :
            'Read ROLE.md, OUTPUT.schema.json and INPUT.json in the current directory. Produce OUTPUT.json using that exact contract. The complete protocol is in these files; no runtime source search or theorem proof is required.',
            crypto.randomUUID(), workspace, turnId => { record.turnId = turnId; record.turns = 1; save(); });
          lease.signal.throwIfAborted();
          if (record.status === 'submitted') record.completionReason = 'validated-output';
          if (!['completed', 'submitted'].includes(record.status) || !record.turnId) {
            if (session.lastFailureDiagnostic) record.failureDiagnostic = { ...session.lastFailureDiagnostic };
            throw new Error('formalization_role_incomplete:' + record.status +
              (session.lastFailureDiagnostic ? ':' + session.lastFailureDiagnostic.code : ''));
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
          if (['opening', 'running'].includes(record.status)) record.status = lease.signal.aborted ? 'interrupted' : 'failed';
          lease.signal.removeEventListener('abort', interrupt);
          record.usageAccounting.pending = false;
          record.usageAccounting.reportedTurns = reportedTotalTokens(record.usage) !== null && !incomplete ? 1 : 0;
          record.usageAccounting.incomplete = incomplete || (record.usageAccounting.startedTurns > record.usageAccounting.reportedTurns);
          save(); event('formalization_role_finished', role);
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
        while (request.maxRounds === 0 || state.rounds < request.maxRounds) {
          lease.signal.throwIfAborted();
          if (remaining() <= 0) throw new Error('formalization_time_limit');
          state.rounds++; save();
          const roundDirectory = path.join(directory, 'round-' + String(state.rounds).padStart(2, '0') + '-' + crypto.randomUUID());
          fs.mkdirSync(roundDirectory, { mode: 0o700 });
          let currentCandidate: FormalizationCandidate | undefined;
          let semanticallyRejected = false;
          try {
            let planning: { input: { problemId: string; statement: string; environment: 'standard' | 'mathlib'; toolchain: string;
              round: number; planningRound: number; feedback?: string }; output: FormalizationPlan; digest: string;
              session: Awaited<ReturnType<typeof dispatch>> } | undefined;
            if (request.workflow) {
              let planningFeedback = state.feedback;
              for (let planningRound = 1; request.workflow.maxPlanningRounds === 0 || planningRound <= request.workflow.maxPlanningRounds; planningRound++) {
                lease.signal.throwIfAborted();
                const input = { problemId: request.problemId, statement: request.statement, environment: request.environment,
                  toolchain: getLeanTaskEnvironment(request.environment).toolchain, round: state.rounds, planningRound, feedback: planningFeedback };
                try {
                  const session = await dispatch('plan', roundDirectory, input, formalizationDigest(input), { name: 'plan-' + planningRound });
                  const output = formalizationPlanSchema.parse(session.output);
                  assertFormalizationPlan(request.statement, output);
                  if (output.taskKind !== 'prove') { state.unsupportedTaskKind = output.taskKind; save(); }
                  assertFormalizationPlanReady(output);
                  planning = { input, output, digest: formalizationDigest(output), session };
                  break;
                } catch (cause) {
                  planningFeedback = errorText(cause).slice(0, 16_000);
                  writeMathJsonDurable(path.join(roundDirectory, 'plan-failure-' + planningRound + '.json'), { error: planningFeedback });
                  if (lease.signal.aborted || !modelDispatchAllowed(buildTokenBudget(request.maxTotalTokens, state.sessions)) ||
                      planningFeedback.includes('formalization_plan_task_kind_unsupported') || infrastructureFailure(planningFeedback) ||
                      /formalization_role_incomplete:failed:(?:unauthorized|badRequest|misalignmentPolicyViolation|cyberPolicy)/u.test(planningFeedback)) throw cause;
                }
              }
              if (!planning) throw new Error('formalization_planning_exhausted: ' + planningFeedback);
            }
            let retrieval;
            if (request.retrieval) {
              try { retrieval = await retrieveFormalizationPlan(directory, request.retrieval, planning!.output, {
                directory: path.join(roundDirectory, 'library-symbols'), env, signal: lease.signal,
                timeoutMs: Number.isFinite(stageTimeout(request.maxCompileSeconds)) ? stageTimeout(request.maxCompileSeconds) : 0,
                lookupSymbols: options.lookupSymbols,
              }); }
              catch (cause) { throw new Error('formalization_retrieval_failed: ' + errorText(cause)); }
            }
            const generationInput = { problemId: request.problemId, statement: request.statement, environment: request.environment,
              toolchain: getLeanTaskEnvironment(request.environment).toolchain, round: state.rounds,
              feedback: state.feedback, previousCandidate: state.previousCandidate,
              ...(planning ? { plan: planning.output, planDigest: planning.digest } : {}),
              ...(retrieval ? { retrieval } : {}) };
            const generated = await dispatch('generate', roundDirectory, generationInput, formalizationDigest(generationInput));
            const generatedCandidate = formalizationCandidateSchema.parse(generated.output);
            state.generatedCandidates = (state.generatedCandidates ?? 0) + 1; save();
            let candidate = { ...generatedCandidate, source: eraseFormalizationProofs(generatedCandidate.source) };
            assertFormalizationCandidate(request, candidate);
            if (planning) assertFormalizationPlanCandidate(planning.output, candidate.source, candidate.coverage);
            if (state.rejectedCandidates?.includes(mathDigest(candidate.source)) || state.rejectedCandidates?.includes(formalizationDigest(candidate)))
              throw new Error('formalization_candidate_unchanged_after_rejection');
            currentCandidate = candidate;
            state.previousCandidate = candidate; save();
            event('formalization_compilation_started');
            const elaborated = await (options.elaborate ?? elaborateFormalization)(path.join(roundDirectory, 'elaboration'),
              candidate.source, request.environment, { env, signal: lease.signal,
                ...(structured ? { detailedContext: true } : {}),
                ...(semanticContext ? { semanticContext: true } : {}),
                ...(structureContext ? { structureContext: true } : {}),
                timeoutMs: Number.isFinite(stageTimeout(request.maxCompileSeconds)) ? stageTimeout(request.maxCompileSeconds) : 0 });
            candidate = { ...candidate, source: elaborated.source };
            const snapshot = formalizationSnapshotSchema.parse(elaborated.snapshot), snapshotDigest = formalizationDigest(snapshot);
            if (snapshotDigest !== elaborated.snapshotDigest || snapshot.targets.some(item => item.context.omitted.length))
              throw new Error('formalization_context_incomplete');
            if (structured) {
              const contexts = parseLeanStatementContexts(JSON.stringify(snapshot.targets.map(target =>
                ({ id: target.name, context: target.context }))), snapshot.targets.map(target => target.name));
              if ([...contexts.values()].some(context => !context.bindings)) throw new Error('formalization_context_missing_bindings');
              if (semanticContext && [...contexts.values()].some(context => !context.semantic))
                throw new Error('formalization_context_missing_semantic_context');
              if (structureContext && [...contexts.values()].some(context => !context.structures))
                throw new Error('formalization_context_missing_structures');
            }
            const inputDigest = formalizationInputDigest(request, candidate);
            const translated = await dispatch('backtranslate', roundDirectory, { ...snapshot, snapshotDigest }, snapshotDigest);
            const translation = formalizationTranslationSchema.parse(translated.output);
            const translationDigest = formalizationDigest(translation);
            if (translation.snapshotDigest !== snapshotDigest ||
                canonicalMathJson(translation.targets.map(item => item.name).sort()) !== canonicalMathJson(elaborated.targets.map(item => item.name).sort()))
              throw new Error('formalization_translation_identity_mismatch');
            const reviewers = request.workflow?.reviewers ?? [{ id: undefined }];
            const runReviewer = async (reviewer: typeof reviewers[number]) => {
              const binding = { inputDigest, snapshotDigest, translationDigest,
                ...(planning ? { planDigest: planning.digest, reviewerId: reviewer.id } : {}) };
              const compareInput = structured ? formalizationReviewInput(request, candidate, snapshot, translation,
                planning ? { planDigest: planning.digest, reviewerId: reviewer.id } : undefined) :
                { original: request.statement, notes: candidate, snapshot, translation, ...binding, ...(planning ? { plan: planning.output } : {}) };
              const compared = await dispatch('compare', roundDirectory, compareInput, structured ? formalizationDigest(compareInput) : formalizationDigest(binding),
              reviewer.id ? { reviewerId: reviewer.id } : undefined);
              const review = structured ? assertStructuredSemanticReview(compareInput as StructuredReviewInput, compared.output) :
                formalizationReviewSchema.parse(compared.output);
              if (!structured && ('snapshotDigest' in review && (review.inputDigest !== inputDigest ||
                  review.snapshotDigest !== snapshotDigest || review.translationDigest !== translationDigest)))
                throw new Error('formalization_review_identity_mismatch');
              const correspondence = structured ? await checkFormalizationFidelity(
                path.join(roundDirectory, 'fidelity-' + (reviewer.id ?? 'reviewer')), compareInput as StructuredReviewInput, review as
                  import('../math/formalizationSemanticReview').StructuredSemanticReview,
                { env, signal: lease.signal, timeoutMs: Number.isFinite(stageTimeout(request.maxCompileSeconds)) ?
                  stageTimeout(request.maxCompileSeconds) : 0, compareReference: options.compareReference }) : undefined;
              return { compared, review, reviewerId: reviewer.id, ...(correspondence ? { correspondence } : {}) };
            };
            const comparisons = [];
            if (request.workflow?.reviewScheduling === 'parallel') {
              // Join every role before revision/exit; preserve configured order, not finish order.
              const settled = await Promise.allSettled(reviewers.map(runReviewer));
              for (const result of settled) if (result.status === 'fulfilled') comparisons.push(result.value);
              const failure = settled.find(result => result.status === 'rejected');
              if (failure?.status === 'rejected') throw failure.reason;
            } else for (const reviewer of reviewers) comparisons.push(await runReviewer(reviewer));
            // Ask every frozen reviewer before deciding, so disagreements remain observable.
            const rejected = comparisons.filter(item => item.review.verdict !== 'approved' || !structured && (item.review.issues.length ||
              Object.values(item.review.checks).some(value => !value)));
            const decision = structured ? resolveStructuredReviewPanel(comparisons.map(item => item.review)) : undefined;
            writeMathJsonDurable(path.join(roundDirectory, 'reviews.json'), {
              policy: 'all-approve', agreement: rejected.length === 0 ? 'unanimous-approval' :
                rejected.length === comparisons.length ? 'no-approval' : 'disagreement',
              ...(decision ? { protocol: STRUCTURED_REVIEW_PROTOCOL, decision } : {}),
              reviews: comparisons.map(({ review, reviewerId, correspondence }) => ({ reviewerId, review,
                ...(correspondence ? { correspondence } : {}) })) });
            if (rejected.length) { semanticallyRejected = !structured || decision.verdict === 'changes_requested';
              throw new Error((decision?.verdict === 'unknown' ? 'formalization_semantic_unknown: ' : 'formalization_semantic_changes_requested: ') +
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
            let reference;
            if (request.workflow?.reference) {
              const configured = request.workflow.reference;
              if (canonicalMathJson(configured.pairs.map(item => item.candidateTarget).sort()) !==
                  canonicalMathJson(elaborated.targets.map(item => item.name).sort()))
                throw new Error('formalization_reference_target_mapping_invalid');
              event('formalization_reference_started');
              reference = await (options.compareReference ?? compareFormalizationReference)(path.join(roundDirectory, 'reference'), {
                candidateSource: candidate.source, referenceSource: configured.source, environment: request.environment, pairs: configured.pairs,
              }, { env, signal: lease.signal, timeoutMs: Number.isFinite(stageTimeout(configured.maxSeconds)) ? stageTimeout(configured.maxSeconds) : 0 });
              writeMathJsonDurable(path.join(roundDirectory, 'reference-result.json'), reference);
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
            state.status = 'approved'; delete state.error; delete state.feedback; save();
            event('formalization_approved');
            return { ...summary(), ...seed };
          } catch (cause) {
            if (fs.existsSync(path.join(directory, 'artifact'))) throw cause;
            if (currentCandidate && semanticallyRejected)
              state.rejectedCandidates = [...new Set([...(state.rejectedCandidates ?? []), mathDigest(currentCandidate.source)])];
            state.feedback = errorText(cause).slice(0, 16_000); state.error = state.feedback;
            writeMathJsonDurable(path.join(roundDirectory, 'failure.json'), { error: state.feedback, round: state.rounds });
            save(); event('formalization_revision_requested', undefined, state.feedback);
            if (lease.signal.aborted || !modelDispatchAllowed(buildTokenBudget(request.maxTotalTokens, state.sessions)) ||
                state.feedback.includes('formalization_plan_task_kind_unsupported') || infrastructureFailure(state.feedback) ||
                /formalization_role_incomplete:failed:(?:unauthorized|badRequest|misalignmentPolicyViolation|cyberPolicy)/u.test(state.feedback)) throw cause;
          }
        }
        state.status = 'exhausted'; save();
        return summary();
      } catch (cause) {
        state.status = 'stopped'; state.error = errorText(cause); save();
        return summary();
      } finally { cancelTimer?.(); save(false); }
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
