import { z } from 'zod';
import type { FormalizationReferenceInput } from './formalizationReference';
import { formalizationReferenceInputSchema } from './formalizationReference';
import { eraseFormalizationProofs, FORMALIZATION_SOURCE_MAX_BYTES, formalizationTargets, hasErasedFormalizationProofs } from './formalizationSource';
import type { LeanStatementBindings } from './leanStatementContext';
import type { LeanTaskEnvironment } from './leanTaskEnvironment';
import { isSimpleLeanName } from './leanSyntax';
import type { LibraryPack } from './libraryPacks';

const text = z.string().min(1).refine(value => value.trim().length > 0);
const targetName = text.refine(isSimpleLeanName);
const binderId = z.string().regex(/^b(?:0|[1-9][0-9]*)$/u);

export const fidelityPolicySchema = z.enum(['task-preserving-v1', 'task-preserving-v2']);
export const formalizationFidelitySchema = z.object({
  policy: fidelityPolicySchema,
  targets: z.array(z.object({
    targetName, originalFragment: text, sourceClaim: text, candidateClaim: text,
    hypothesisScope: text, quantifierOrder: text,
    binderIds: z.array(binderId), conclusionDependencies: z.array(binderId),
  }).strict()),
  sourceContract: z.object({
    source: z.string().min(1).max(FORMALIZATION_SOURCE_MAX_BYTES),
    pairs: z.array(z.object({ candidateTarget: targetName, referenceTarget: targetName }).strict()),
  }).strict().nullable(),
}).strict();
export type FormalizationFidelity = z.infer<typeof formalizationFidelitySchema>;

export type FormalizationFidelitySnapshot = {
  environment: LeanTaskEnvironment;
  source: string;
  targets: readonly { name: string; context: { bindings?: LeanStatementBindings } }[];
};
type FidelityInput = {
  original: string;
  observation: { snapshot: FormalizationFidelitySnapshot | null };
};

const same = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const sameNames = (left: readonly string[], right: readonly string[]) =>
  new Set(left).size === left.length && new Set(right).size === right.length &&
  same([...left].sort(), [...right].sort());

function assertTargetCoverage(snapshot: FormalizationFidelitySnapshot, fidelity: FormalizationFidelity): void {
  const names = snapshot.targets.map(target => target.name);
  if (!names.length || !sameNames(fidelity.targets.map(target => target.targetName), names) ||
      !sameNames(formalizationTargets(snapshot.source).map(target => target.name), names))
    throw new Error('formalization_fidelity_target_coverage_invalid');
  for (const target of fidelity.targets) {
    const bindings = snapshot.targets.find(item => item.name === target.targetName)!.context.bindings;
    if (!bindings || !same(target.binderIds, bindings.binders.map(binder => binder.id)) ||
        !same(target.conclusionDependencies, bindings.conclusionDependencies))
      throw new Error('formalization_fidelity_binding_evidence_invalid:' + target.targetName);
  }
  const contract = fidelity.sourceContract;
  if (!contract) return;
  if (!hasErasedFormalizationProofs(contract.source))
    throw new Error('formalization_fidelity_source_contract_not_erased');
  const sourceNames = formalizationTargets(contract.source).map(target => target.name);
  if (!sameNames(contract.pairs.map(pair => pair.candidateTarget), names) ||
      !sameNames(contract.pairs.map(pair => pair.referenceTarget), sourceNames))
    throw new Error('formalization_fidelity_source_contract_mapping_invalid');
}

/**
 * Bind a reviewer-authored scope account to the actual source and Lean telescope.
 * This validates coverage and linkage, not the mathematics of the prose or its
 * source contract. Approval additionally needs a host-run guarded reference check.
 */
export function assertFormalizationFidelity(input: FidelityInput,
  reviewVerdict: 'approved' | 'changes_requested' | 'unknown', value: unknown): FormalizationFidelity {
  const fidelity = formalizationFidelitySchema.parse(value), snapshot = input.observation.snapshot;
  if (reviewVerdict === 'approved' && !fidelity.sourceContract)
    throw new Error('formalization_fidelity_source_contract_required');
  if (!snapshot) {
    if (reviewVerdict === 'approved' || fidelity.targets.length || fidelity.sourceContract)
      throw new Error('formalization_fidelity_snapshot_unavailable');
    return fidelity;
  }
  assertTargetCoverage(snapshot, fidelity);
  for (const target of fidelity.targets) {
    if (!input.original.includes(target.originalFragment))
      throw new Error('formalization_fidelity_original_fragment_not_found:' + target.targetName);
  }
  return fidelity;
}

/** Construct the exact existing comparison request; never accept model bridge proofs. */
export function fidelityReferenceInput(snapshot: FormalizationFidelitySnapshot,
  value: FormalizationFidelity, libraryPack?: LibraryPack): FormalizationReferenceInput {
  const fidelity = formalizationFidelitySchema.parse(value);
  if (!fidelity.sourceContract) throw new Error('formalization_fidelity_source_contract_required');
  assertTargetCoverage(snapshot, fidelity);
  return formalizationReferenceInputSchema.parse({
    candidateSource: eraseFormalizationProofs(snapshot.source),
    referenceSource: fidelity.sourceContract.source, environment: snapshot.environment,
    pairs: fidelity.sourceContract.pairs,
    ...(libraryPack ? { libraryPack } : {}),
    purpose: fidelity.policy === 'task-preserving-v2' ? 'task-fidelity-v2' : 'task-fidelity-v1',
  });
}

export const FIDELITY_REVIEW_INSTRUCTIONS = [
  'This request uses the task-preserving-v2 fidelity policy. Preserve the complete task: its objects, assumptions, hypothesis scope, quantifier dependencies and conclusions. A stronger local theorem, separately provable claims or one implication alone do not establish fidelity.',
  'Include fidelity with policy, targets and sourceContract in OUTPUT.json. For every observed target exactly once, targets records targetName, originalFragment, sourceClaim, candidateClaim, hypothesisScope, quantifierOrder, binderIds and conclusionDependencies. originalFragment is one contiguous verbatim quotation of the complete compared source claim, including its surrounding assumptions. When those assumptions occur elsewhere, quote the larger contiguous source passage containing them.',
  'State the complete sourceClaim and candidateClaim under all surrounding assumptions. In hypothesisScope explain whether each hypothesis ranges over the whole structure or only the current parameters, including nested quantified hypotheses. In quantifierOrder explain universal/existential order and actual dependency, distinguishing independent parameter reordering from changing a hypothesis.',
  'Copy every top-level binder ID from that target.context.bindings.binders into binderIds in telescope order, including implicit and instance binders. Copy conclusionDependencies exactly from target.context.bindings.conclusionDependencies. These fields link the review to host observations; they do not certify the mathematical claims in the other fields.',
  'For approval, sourceContract must contain source and pairs. Write a complete Lean representation of your reading of the original source claim, retaining all assumptions and scope, with every theorem body containing only := by sorry and no comments. Whitespace and blank lines around the placeholder may vary; the host preserves your submitted source bytes. Supply all necessary complete definitions and ordinary imports. Map every observed candidate target and every source-contract theorem exactly once through pairs entries with candidateTarget and referenceTarget.',
  'A reading the pinned environment cannot express is not a supported reading. When a class or structure strength is the open question, keep every structure the source words already give and check the actual declarations: if an operation the source itself performs has no instance at that strength, the environment forces the additional structure, and the combined class is the reading to report instead of the bare weaker one. Report the declaration or failed instance synthesis, the reading it selects and the alternative it excludes, so the decision is auditable, and reserve unknown for questions that inspection of the pinned environment cannot decide. Outside this case the prohibition above still applies: do not adopt a strength because it makes the source claim true.',
  'The source contract is reviewer-authored: you have seen the candidate, so do not describe it as a blind independent formalization or machine-certified natural-language meaning. Do not copy a locally stronger candidate into the source contract and call it an equivalent reading of a whole-structure source assumption.',
  'A host-owned guarded Lean comparison of the complete candidate and source-contract targets is an additional necessary condition for approval. It checks only supported structural and fixed representation conversions, using erased theorem bodies. Do not supply bridge proofs, prove both full claims separately, or describe not-established as proof of inequivalence. Unsupported correspondence remains unresolved. A non-approved review may set sourceContract to null; it must still describe every available observed target and its binders.',
].join('\n');

export function fidelityReviewInstructions(policy: 'task-preserving-v1' | 'task-preserving-v2'): string {
  return policy === 'task-preserving-v2' ? FIDELITY_REVIEW_INSTRUCTIONS :
    FIDELITY_REVIEW_INSTRUCTIONS.replace('task-preserving-v2', 'task-preserving-v1');
}
