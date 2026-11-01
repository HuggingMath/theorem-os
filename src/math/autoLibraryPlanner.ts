import { z } from 'zod';
import { AUTO_LIBRARY_DIRECTORY, AUTO_LIBRARY_NAME, AUTO_LIBRARY_NAMESPACE, MAX_AUTO_LIBRARY_SPEC_BYTES, autoLibraryNamespace,
  inspectAutoLibrarySource } from './autoLibrary';
import { deriveFormalizationRoleOutputJsonSchema } from './formalizationRoleContract';
import type { LeanDiagnosticMessage } from './leanTypes';
import { inspectLeanDeclarations } from './leanSource';
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
}).strict();
export type AutoLibraryPlan = z.infer<typeof autoLibraryPlanSchema>;
export const autoLibraryPlanJsonSchema = () => deriveFormalizationRoleOutputJsonSchema(autoLibraryPlanSchema);

export type AutoLibraryCatalogueEntry = { module: string; file: string; auto: boolean; declarations: number; summary: string };

/** The first doc comment of a module, else the start of its declaration list. */
export function autoLibraryModuleSummary(source: string): string {
  const doc = /\/-[!-]([\s\S]*?)-\//u.exec(source)?.[1]?.replace(/\s+/gu, ' ').trim();
  if (doc) return doc.slice(0, 600);
  return inspectLeanDeclarations(source).slice(0, 12).map(item => item.name).join(', ').slice(0, 600);
}

export function autoLibraryPlannerInput(input: { challengeId: string; challenge: string; task: string; environment: string;
  library: readonly AutoLibraryCatalogueEntry[]; taken: readonly string[]; module: number; round: number; maxRounds: number;
  feedback?: string; previous?: Pick<AutoLibraryPlan, 'name' | 'summary' | 'lean'> }) {
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
export function autoLibraryPlanProblems(value: unknown, input: { inputDigest: string; taken: readonly string[];
  libraryModules: ReadonlySet<string> }): string[] {
  const parsed = autoLibraryPlanSchema.safeParse(value);
  if (!parsed.success) return parsed.error.issues.slice(0, 12).map(issue => `${issue.path.join('.') || 'output'}: ${issue.message}`);
  const plan = parsed.data;
  if (plan.inputDigest !== input.inputDigest) return ['inputDigest must be copied from INPUT.json'];
  if (plan.decision === 'none')
    return plan.name === null && plan.summary === null && plan.sources === null && plan.lean === null ? [] :
      ['decision none requires name, summary, sources and lean to be null'];
  if (plan.name === null || plan.summary === null || plan.sources === null || plan.lean === null)
    return ['decision module requires name, summary, sources and lean'];
  if (input.taken.some(name => name.toLowerCase() === plan.name!.toLowerCase())) return [`name ${plan.name} is taken; choose another`];
  return inspectAutoLibrarySource({ name: plan.name, source: plan.lean, libraryModules: input.libraryModules, allowSorry: true });
}

export const AUTO_LIBRARY_PLANNER_INSTRUCTIONS = [
  'You plan a Lean library module for TheoremOS. A solver will later work on the problem in INPUT.challenge; before that, decide whether one small library module would help it, and if so write the module statement.',
  'The module is general mathematics: definitions and lemmas a textbook or paper would state, that the problem\'s proof can use. Do not restate the problem, a special case shaped to it, or its answer. You may follow the literature for standard definitions and lemmas (cite them in sources), but never copy a published solution of this problem or an existing formalization of it.',
  'INPUT.library lists the modules already available (hand-written and earlier auto modules); their sources are in library/. Do not duplicate them; import them when the new module builds on them. takenNames are names you may not use.',
  'Name the module with UpperCamelCase (3 to 48 letters or digits). It becomes the file Submission/Library/Auto/<Name>.lean. Put every declaration inside `namespace TheoremOS.Auto.<Name>` … `end TheoremOS.Auto.<Name>`; outside it only imports, comments, open, set_option, universe and variable lines are allowed.',
  'Import only modules of the pinned environment (for example Mathlib) and modules listed in INPUT.library. Definitions must be complete. Every theorem and lemma body is `by sorry` or `sorry`: a solver proves them next.',
  'Never use axiom, unsafe, native_decide, implemented_by, extern, #eval, run_cmd or other meta commands, elab or initialize. notation, macro, syntax and attribute commands must be local or scoped. Do not use _root_.',
  'State at least one theorem. Final name components must be unique within the module. Prefer several small lemmas that build on each other to one large one: unproved theorems are dropped, together with every declaration that mentions them.',
  'Statements must elaborate in the pinned environment. Check them by writing the file to a scratch directory and running lean on it (LEAN_PATH is configured; a module that imports library/ modules needs them compiled first: lean -o build/<Module/Path>.olean <file>, with build added to LEAN_PATH).',
  'Answer decision none (name, summary, sources and lean null) when no module would help. summary says in one paragraph what the module provides; sources lists literature references (may be empty); reason explains the choice.',
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

