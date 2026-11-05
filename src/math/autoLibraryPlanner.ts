import { z } from 'zod';
import { AUTO_LIBRARY_DIRECTORY, AUTO_LIBRARY_NAME, AUTO_LIBRARY_NAMESPACE, MAX_AUTO_LIBRARY_SPEC_BYTES, autoLibraryNamespace,
  autoLibraryTheorems,
  inspectAutoLibrarySource } from './autoLibrary';
import { deriveFormalizationRoleOutputJsonSchema } from './formalizationRoleContract';
import type { LeanDiagnosticMessage } from './leanTypes';
import { inspectLeanDeclarations, inspectScopedLeanDeclarations } from './leanSource';
import { canonicalMathJson, mathDigest } from './mathRuntimeIo';

/** The library planner's contract: one strict object, so a single schema serves every decision. */
export const autoLibraryPlanSchema = z.object({
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  decision: z.enum(['module', 'none']),
  reason: z.string().min(1).max(4000),
  name: z.string().regex(AUTO_LIBRARY_NAME).nullable(),
  summary: z.string().min(1).max(2000).nullable(),
  sources: z.array(z.string().min(1).max(400)).max(12).nullable(),
  lean: z.string().min(1).max(MAX_AUTO_LIBRARY_SPEC_BYTES).nullable(),
  target: z.string().min(1).max(256).nullable(),
  application: z.string().min(1).max(2000).nullable(),
  remaining: z.array(z.string().min(1).max(1000)).max(8).nullable(),
}).strict();
export type AutoLibraryPlan = z.infer<typeof autoLibraryPlanSchema>;
export const autoLibraryPlanJsonSchema = () => deriveFormalizationRoleOutputJsonSchema(autoLibraryPlanSchema);

export type AutoLibraryCatalogueEntry = { module: string; file: string; auto: boolean; declarations: number;
  theorems: string[]; summary: string };

/** The first doc comment of a module, else the start of its declaration list. */
export function autoLibraryModuleSummary(source: string): string {
  const doc = /\/-[!-]([\s\S]*?)-\//u.exec(source)?.[1]?.replace(/\s+/gu, ' ').trim();
  if (doc) return doc.slice(0, 600);
  return inspectLeanDeclarations(source).slice(0, 12).map(item => item.name).join(', ').slice(0, 600);
}

export function autoLibraryPlannerInput(input: { challengeId: string; challenge: string; task: string; environment: string;
  library: readonly AutoLibraryCatalogueEntry[]; taken: readonly string[]; module: number; round: number; maxRounds: number;
  feedback?: string; previous?: Pick<AutoLibraryPlan, 'name' | 'summary' | 'lean' | 'target' | 'application' | 'remaining'> }) {
  const body = {
    protocol: 'theorem-os.auto-library-planner.v1', challenge: { id: input.challengeId, source: input.challenge, task: input.task },
    environment: input.environment, conventions: { directory: AUTO_LIBRARY_DIRECTORY, namespace: AUTO_LIBRARY_NAMESPACE,
      file: `${AUTO_LIBRARY_DIRECTORY}/<Name>.lean`, maxLeanBytes: MAX_AUTO_LIBRARY_SPEC_BYTES },
    library: input.library, takenNames: input.taken, module: input.module, round: input.round, maxRounds: input.maxRounds,
    feedback: input.feedback ?? null, previous: input.previous ?? null,
  };
  return { ...body, inputDigest: mathDigest(canonicalMathJson(body)) };
}
export type AutoLibraryPlannerInput = ReturnType<typeof autoLibraryPlannerInput>;

/** Host checks of a planner output beyond its schema; an empty list accepts it. */
export function autoLibraryPlanProblems(value: unknown, input: { inputDigest: string; taken: readonly string[]; challenge: string;
  libraryModules: ReadonlySet<string> }): string[] {
  const parsed = autoLibraryPlanSchema.safeParse(value);
  if (!parsed.success) return parsed.error.issues.slice(0, 12).map(issue => `${issue.path.join('.') || 'output'}: ${issue.message}`);
  const plan = parsed.data;
  if (plan.inputDigest !== input.inputDigest) return ['inputDigest must be copied from INPUT.json'];
  if (plan.decision === 'none')
    return plan.name === null && plan.summary === null && plan.sources === null && plan.lean === null &&
      plan.target === null && plan.application === null && plan.remaining === null ? [] :
      ['decision none requires name, summary, sources, lean, target, application and remaining to be null'];
  if (plan.name === null || plan.summary === null || plan.sources === null || plan.lean === null ||
      plan.target === null || plan.application === null || plan.remaining === null)
    return ['decision module requires name, summary, sources, lean, target, application and remaining'];
  const targets = inspectScopedLeanDeclarations(input.challenge).filter(item => item.kind === 'theorem')
    .map(item => item.qualifiedName);
  if (!targets.includes(plan.target)) return ['target must name a theorem in INPUT.challenge.source'];
  if (!autoLibraryTheorems(plan.lean).some(theorem => plan.application!.includes(theorem)))
    return ['application must name a theorem stated in the proposed module'];
  if (input.taken.some(name => name.toLowerCase() === plan.name!.toLowerCase())) return [`name ${plan.name} is taken; choose another`];
  return inspectAutoLibrarySource({ name: plan.name, source: plan.lean, libraryModules: input.libraryModules, allowSorry: true });
}

export const AUTO_LIBRARY_PLANNER_INSTRUCTIONS = [
  'You make a bounded decision about one Lean library dependency. Read INPUT.json and OUTPUT.schema.json once, then write OUTPUT.json. Do not search Mathlib source, inspect the whole library, run Lean, or try to solve the original theorem. The host checks statements and a separate prover proves them. If no useful tractable dependency appears from the challenge, return decision none immediately.',
  'A solver will later work on INPUT.challenge. Identify a reusable dependency that removes a concrete step from its proof. It may be a substantial general lemma; it need not solve the whole challenge. When that dependency itself needs a missing fact, propose the smaller prerequisite first so later modules can import it.',
  'For decision module, target is the exact qualified name of a theorem in INPUT.challenge.source. In application, name a fully qualified theorem from your proposed Lean source, explain the substitution and why its premises can be supplied. In remaining, list the cases, premises and mathematical obligations still open after using it. Choose none for an unrelated lemma, an already available result, or a premise with no route from the target. A remaining hard step alone is not a reason to reject a useful dependency.',
  'The module is general mathematics: definitions and lemmas a textbook or paper would state, that the problem\'s proof can use. Do not restate the problem, a special case shaped to it, or its answer. You may follow the literature for standard definitions and lemmas (cite them in sources), but never copy a published solution of this problem or an existing formalization of it.',
  'INPUT.library lists modules already available (hand-written and earlier auto modules). It names theorems in earlier auto modules so you can build a new dependency on them. Their sources are in library/: read a specific listed auto module if you need its exact statement, but do not search the entire library. Do not duplicate an existing module. takenNames are names you may not use.',
  'Name the module with UpperCamelCase (3 to 48 letters or digits). It becomes the file Submission/Library/Auto/<Name>.lean. Put every declaration inside `namespace TheoremOS.Auto.<Name>` … `end TheoremOS.Auto.<Name>`; outside it only imports, comments, open, set_option, universe and variable lines are allowed.',
  'Import only modules of the pinned environment (for example Mathlib) and modules listed in INPUT.library. Definitions must be complete. Every theorem and lemma body is `by sorry` or `sorry`: a solver proves them next.',
  'Never use axiom, unsafe, native_decide, implemented_by, extern, #eval, run_cmd or other meta commands, elab or initialize. notation, macro, syntax and attribute commands must be local or scoped. Do not use _root_.',
  'State one small, reusable theorem, at most two. Final name components must be unique within the module. A later solver proves them; unproved theorems are dropped.',
  'Use INPUT.library summaries to avoid duplicate modules. No source search is needed: if an exact imported lemma name is uncertain, state a simpler Mathlib-only lemma or choose none. The host will check the statement after you submit.',
  'Answer decision none (name, summary, sources, lean, target, application and remaining all null) when no module would help. summary says in one paragraph what the module provides; sources lists literature references (may be empty); reason explains the choice.',
  'INPUT.feedback, when present, explains why the previous attempt (INPUT.previous) was rejected or what the solver could not prove. Fix exactly that, or choose a different module.',
  'OUTPUT.schema.json describes the exact output structure. Write one strict JSON object with inputDigest copied from INPUT atomically (write a temporary file, then rename it to OUTPUT.json). The first complete schema-valid OUTPUT.json is your submission; stop after submitting.',
  'Do not change INPUT.json, ROLE.md or OUTPUT.schema.json.',
].join('\n');

/** The solver's task for a spec run. */
export const autoLibraryProverTask = (name: string) => [
  `Prove the theorems of the TheoremOS library module ${name} (namespace ${autoLibraryNamespace(name)}). Replace each sorry with a proof.`,
  'Do not change any statement or definition. You may add helper lemmas inside the module namespace.',
  'Theorems left unproved are dropped from the library together with the declarations that mention them.',
].join('\n');

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text;

/** Feedback from a saved Lean diagnostics file: its errors (and sorry warnings), at most 12. */
export function autoLibraryLeanFeedback(heading: string, value: unknown): string {
  const input = (value && typeof value === 'object' ? value : {}) as { messages?: readonly LeanDiagnosticMessage[];
    stdout?: unknown; stderr?: unknown; timedOut?: unknown };
  if (input.timedOut === true) return `${heading}\nLean did not finish in time. Make the definitions and statements cheaper to elaborate.`;
  const errors = (Array.isArray(input.messages) ? input.messages : []).filter(message => message.severity === 'error' ||
    /declaration uses '?sorry'?/u.test(message.message)).slice(0, 12);
  const raw = [input.stderr, input.stdout].find(text => typeof text === 'string' && text.trim()) as string | undefined;
  const body = errors.length ? errors.map(message => `${message.line !== undefined ? `line ${message.line}:${message.column ?? 0}: ` : ''}` +
    clip(message.message.trim(), 1200)).join('\n') : clip(raw?.trim() ?? 'Lean reported no message.', 4000);
  return clip(`${heading}\n${body}`, 16_000);
}

export const autoLibraryRejectionFeedback = (problems: readonly string[], heading = 'The host rejected the module:') =>
  clip(`${heading}\n${problems.map(item => `- ${item}`).join('\n')}`, 16_000);

