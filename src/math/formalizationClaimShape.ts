/**
 * Claim-shape lint for formalization plans.
 *
 * TypeScript port of the offline prototype measured in REPORT-v4 section 14: the
 * four remaining official beq_plus False cases were each decided in the plan, not
 * in the artifact, and each replaces a phrase the source gives with an
 * equivalent-but-differently-shaped Lean term. The official check links candidate
 * to reference only by definitional unfolding and simple rewriting, so those
 * shapes score False even though they are mathematically the same claim.
 *
 * This is a port, not a rewrite: the rules, the operator character class and the
 * 60-character window must match the measured prototype exactly, or the recorded
 * numbers (4/4 recall, 0/5 false positives, 0/371 corpus hits) would describe a
 * different function than the one that ships.
 *
 * A hit means "reject the plan and ask for a differently shaped one", never "the
 * claim is wrong". The rules are deliberately narrow: a false rejection changes
 * an answer that would have passed, so a missed shape is the cheaper error.
 */

/** Characters that make a parenthesised group something other than a product. */
const NOT_A_PRODUCT = new Set(
  '+-/=≤≥≠<>∑∏⋃⋂∧∨→↔¬λ^×≃·⊓⊔↦:{},()[]|&!?%$@#"`~');

const SUBOBJECT_WORDS = ['Subspace', 'Submodule', 'Ideal', 'Subgroup', 'Submonoid'];

/** An existential whose bound variable lives in the ambient type, then a membership. */
const AMBIENT_EXISTENTIAL = /∃[^,]*:\s*(?:ℤ|Int|GaussianInt)\s*,.*∈/u;

export interface ShapeHit {
  /** Stable id of the rule that fired; safe for logs and for test fixtures. */
  readonly rule: string;
  /** The offending source fragment, for the re-planning feedback message. */
  readonly fragment: string;
}

/** What to write instead, phrased for a replanning message rather than a log. */
export const claimShapeAdvice: Readonly<Record<string, string>> = {
  R1_grouping_in_product_chain: 'Do not group a subproduct with parentheses inside a product chain; '
    + 'write the chain flat, or name the conjugating or commuting element the source itself names.',
  R2_finset_of_subobjects: 'Do not encode a finite family of subspaces, submodules, ideals or subgroups '
    + 'as a Finset of subobjects; use an index type with a map into the subobjects, as the source does.',
  R3_derived_operation: 'Do not state an equality of a derived operation on a subobject (center, prod) when '
    + 'the source asks for an isomorphism or a membership; write the statement the source makes.',
  R4_ambient_existential: 'Do not existentially quantify over the ambient ring or group and then coerce into the '
    + 'subobject; quantify over the subobject, as the source does.',
  R5_bundled_relation: 'Do not use a bundled relation such as IsConj in place of the witness the source gives; '
    + 'spell out the conjugating element.',
};

/**
 * A pure-product parenthesis with a product operator on both sides.
 *
 * Every reference statement that trips a bare "parenthesised product" rule uses
 * the parenthesis for one of three other reasons: as a function or type argument,
 * under a tighter operator, or as the associativity law itself, where the grouped
 * term is at the start or the end of the chain. Requiring `*` on both sides and
 * no other operator inside excludes all three.
 */
function groupingInProductChain(text: string): string | undefined {
  const open: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '(') open.push(index);
    else if (text[index] === ')' && open.length) {
      const start = open.pop()!;
      const inner = text.slice(start + 1, index);
      if (!inner.includes('*')) continue;
      if ([...inner].some(character => NOT_A_PRODUCT.has(character))) continue;
      const before = text.slice(0, start).trimEnd();
      const after = text.slice(index + 1).trimStart();
      if (before.endsWith('*') && after.startsWith('*')) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/**
 * A Finset whose element type is a family of subobjects: a finite family of
 * subspaces/ideals encoded as a set of members, rather than members used as data.
 */
function finsetOfSubobjects(text: string): string | undefined {
  for (let at = text.indexOf('Finset'); at >= 0; at = text.indexOf('Finset', at + 1)) {
    const window = text.slice(at, at + 60);
    if (SUBOBJECT_WORDS.some(word => window.includes(word))) return `${window.split(')')[0]})`;
  }
  return undefined;
}

/** A derived operation on a subobject, where the source writes the subobject itself. */
function derivedOperation(text: string): string | undefined {
  if (text.includes('.prod') &&
    (text.includes('center') || SUBOBJECT_WORDS.some(word => text.includes(word)))) return '.prod';
  return undefined;
}

function ambientExistential(text: string): string | undefined {
  return AMBIENT_EXISTENTIAL.exec(text)?.[0];
}

/**
 * A packed library relation standing in for the witness the source spells out.
 *
 * The source says "b a is conjugate to a b" by giving the conjugating element;
 * `IsConj (a * b) (b * a)` states the same thing through a bundled relation that
 * beq_plus will not unfold to the witness form.
 */
function bundledRelation(text: string): string | undefined {
  return text.includes('IsConj') ? 'IsConj' : undefined;
}

const RULES: readonly { rule: string; find: (text: string) => string | undefined }[] = [
  { rule: 'R1_grouping_in_product_chain', find: groupingInProductChain },
  { rule: 'R2_finset_of_subobjects', find: finsetOfSubobjects },
  { rule: 'R3_derived_operation', find: derivedOperation },
  { rule: 'R4_ambient_existential', find: ambientExistential },
  { rule: 'R5_bundled_relation', find: bundledRelation },
];

/** Every rule that fires on `text`, in rule order, at most one hit per rule. */
export function claimShapeHits(text: string): ShapeHit[] {
  const hits: ShapeHit[] = [];
  for (const { rule, find } of RULES) {
    const fragment = find(text);
    if (fragment !== undefined) hits.push({ rule, fragment });
  }
  return hits;
}

/**
 * What the lint reads from a plan.
 *
 * `conclusions` and `mathematics` stay optional because the planner's plan is
 * zod-parsed under this repo's non-strict tsconfig, so an optional schema field
 * still infers as possibly-undefined at the call site even after
 * `assertFormalizationPlanReady`. A missing field reads as no conclusion text,
 * which lints clean.
 */
export type ClaimShapePlan = {
  conclusions?: readonly { mathematics?: string | undefined }[] | undefined;
};

/** Its conclusions in order, whitespace-normalized and joined the way the
 * prototype measured them; objects, assumptions and spans are excluded because
 * the prototype never measured them. */
export function formalizationClaimText(plan: ClaimShapePlan): string {
  return (plan.conclusions ?? []).map(item => (item.mathematics ?? '').split(/\s+/u).filter(Boolean).join(' ')).join(' | ');
}

/**
 * The plan-stage rejection message, or undefined when the plan's conclusions use
 * only shapes the official checker can link.
 *
 * The caller feeds this string back to the planner, so it must say what to write
 * instead and must not read as a verdict on the mathematics. Keeping the phrase
 * "claim is not judged wrong" beside the rule id is deliberate: the lint predicts
 * a linking failure, not a false statement.
 */
export function claimShapeRejection(plan: ClaimShapePlan): string | undefined {
  const hits = claimShapeHits(formalizationClaimText(plan));
  if (!hits.length) return undefined;
  return 'formalization_plan_claim_shape: planned conclusions use Lean shapes the official '
    + 'definitional-equality check cannot link to the source, so rewrite the plan in the shape the source '
    + 'states (this is a linking prediction, not a claim that the mathematics is wrong):\n'
    + hits.map(hit => '- ' + hit.rule + ' near "' + hit.fragment + '": ' + claimShapeAdvice[hit.rule]).join('\n');
}
