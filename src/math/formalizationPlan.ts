import { z } from 'zod';
import { formalizationTargets } from './formalizationSource';
import { inspectScopedLeanDeclarations } from './leanSource';
import { isSimpleLeanName } from './leanSyntax';

const originalMaxBytes = 256 * 1024;
const recordLimit = 256;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const validText = (value: string) => value.trim().length > 0 &&
  Buffer.from(value, 'utf8').toString('utf8') === value &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value);
const text = z.string().min(1).max(32_000).refine(validText);
const original = z.string().min(1).max(originalMaxBytes).refine(value =>
  validText(value) && Buffer.byteLength(value, 'utf8') <= originalMaxBytes);
const leanName = z.string().min(1).max(512).refine(value => isSimpleLeanName(value) && !value.startsWith('_root_.'));
const spanIds = z.array(id).min(1).max(recordLimit);
const spanSchema = z.object({
  id, start: z.number().int().min(0).max(originalMaxBytes)
    .describe('Zero-based UTF-16 offset into the parsed INPUT.statement string, not the INPUT.json file, JSON escapes, UTF-8 bytes or Unicode code points. Compute with statement.indexOf(text), choosing the intended occurrence if repeated.'),
  end: z.number().int().min(1).max(originalMaxBytes)
    .describe('Exclusive UTF-16 offset in parsed INPUT.statement. Compute end = start + text.length and verify statement.slice(start, end) === text.'),
  text: original.describe('An exact nonempty substring of parsed INPUT.statement. Copy whitespace and punctuation unchanged; do not add a period or paraphrase.'),
}).strict();

const planSchema = z.object({
  schema: z.literal('theorem-os.formalization-plan.v1'),
  taskKind: z.enum(['prove', 'decision', 'construction']),
  spans: z.array(spanSchema).min(1).max(recordLimit),
  objects: z.array(z.object({ id, spanIds, description: text, leanType: text }).strict()).max(recordLimit),
  assumptions: z.array(z.object({ id, spanIds, mathematics: text }).strict()).max(recordLimit),
  conclusions: z.array(z.object({ id, spanIds, mathematics: text,
    targetNames: z.array(leanName).min(1).max(recordLimit)
      .describe('Names of theorem/lemma declarations to generate for this conclusion, qualified by their Lean namespace. Do not list imported library constants, classes, object types, definitions or dependencies here.'),
    assumptionIds: z.array(id).max(recordLimit),
  }).strict()).min(1).max(recordLimit),
  definitions: z.array(z.object({ id, spanIds, mathematics: text, implementation: z.enum(['existing', 'new']),
    leanNames: z.array(leanName).min(1).max(recordLimit)
      .describe('For existing, cite pinned library constants; separate records may reuse a constant for distinct source meanings. For new, name the local def/abbrev/named instance to generate. New names must be unique across all definition records. No definition name may name a conclusion theorem.'),
    dependsOn: z.array(id).max(recordLimit)
      .describe('Only id values of records in this plan.definitions array. Never reference object, assumption, conclusion, span or unresolved IDs, or Lean names. Use [] when this definition has no definition dependencies; the definition dependency graph must be acyclic.'),
    justification: text,
  }).strict()).max(recordLimit),
  unresolved: z.array(z.object({ id, spanIds, description: text }).strict()).max(recordLimit),
}).strict();

/**
 * A model-authored inventory, not a certificate of semantic completeness.
 * Source offsets are zero-based UTF-16 code-unit offsets with an exclusive end,
 * matching JavaScript statement.slice(start, end). Spans may overlap, but must
 * retain exact nonempty source text and never split a surrogate pair.
 */
export const formalizationPlanSchema = planSchema.superRefine((plan, context) => {
  const issue = (message: string, path: (string | number)[] = []) =>
    context.addIssue({ code: z.ZodIssueCode.custom, message, path });
  const unique = (values: readonly string[], path: (string | number)[]) => {
    if (new Set(values).size !== values.length) issue('formalization_plan_duplicate', path);
  };
  const groups = ['spans', 'objects', 'assumptions', 'conclusions', 'definitions', 'unresolved'] as const;
  unique(groups.flatMap(group => plan[group].map(item => item.id)), []);
  const spans = new Set(plan.spans.map(item => item.id));
  const ranges = new Set<string>();
  plan.spans.forEach((span, index) => {
    if (span.end <= span.start || span.end - span.start !== span.text.length)
      issue('formalization_plan_span_invalid', ['spans', index]);
    const range = `${span.start}:${span.end}`;
    if (ranges.has(range)) issue('formalization_plan_duplicate', ['spans', index]);
    ranges.add(range);
  });
  for (const group of groups.filter(group => group !== 'spans')) {
    plan[group].forEach((item, index) => {
      unique(item.spanIds, [group, index, 'spanIds']);
      if (item.spanIds.some(spanId => !spans.has(spanId)))
        issue('formalization_plan_span_reference_invalid', [group, index, 'spanIds']);
    });
  }
  const assumptions = new Set(plan.assumptions.map(item => item.id));
  plan.conclusions.forEach((conclusion, index) => {
    unique(conclusion.targetNames, ['conclusions', index, 'targetNames']);
    unique(conclusion.assumptionIds, ['conclusions', index, 'assumptionIds']);
    if (conclusion.assumptionIds.some(assumptionId => !assumptions.has(assumptionId)))
      issue('formalization_plan_assumption_reference_invalid', ['conclusions', index, 'assumptionIds']);
  });
  const targets = new Set(plan.conclusions.flatMap(item => item.targetNames));
  const definitions = new Map(plan.definitions.map(item => [item.id, item]));
  const definitionNames = new Map<string, 'existing' | 'new'>();
  plan.definitions.forEach((definition, index) => {
    unique(definition.leanNames, ['definitions', index, 'leanNames']);
    unique(definition.dependsOn, ['definitions', index, 'dependsOn']);
    const invalidDependencies = definition.dependsOn.filter(dependency => !definitions.has(dependency));
    if (invalidDependencies.length)
      issue(`formalization_plan_definition_reference_invalid: definition ${JSON.stringify(definition.id)} has invalid dependsOn IDs ${JSON.stringify(invalidDependencies)}. ` +
        `Allowed definition IDs: ${JSON.stringify([...definitions.keys()])}. Reference only plan.definitions IDs, not objects, assumptions, conclusions, spans or unresolved IDs or Lean names; use [] when there are no definition dependencies.`,
      ['definitions', index, 'dependsOn']);
    for (const name of definition.leanNames) {
      const previous = definitionNames.get(name);
      // Multiple source meanings may use the same imported constant. A local
      // declaration still has exactly one planned implementation and cannot
      // simultaneously claim an existing library name.
      if (previous !== undefined && (previous === 'new' || definition.implementation === 'new'))
        issue('formalization_plan_duplicate', ['definitions', index, 'leanNames']);
      if (targets.has(name)) issue('formalization_plan_definition_target_overlap', ['definitions', index, 'leanNames']);
      if (previous !== 'new') definitionNames.set(name, definition.implementation);
    }
  });
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (definitionId: string): boolean => {
    if (visiting.has(definitionId)) return false;
    if (visited.has(definitionId)) return true;
    visiting.add(definitionId);
    for (const dependency of definitions.get(definitionId)?.dependsOn ?? []) {
      if (definitions.has(dependency) && !visit(dependency)) return false;
    }
    visiting.delete(definitionId); visited.add(definitionId);
    return true;
  };
  if (plan.definitions.some(definition => !visit(definition.id))) issue('formalization_plan_definition_cycle');
});

export type FormalizationPlan = z.infer<typeof formalizationPlanSchema>;
export type FormalizationPlanCoverage = readonly z.infer<typeof coverageSchema>[number][];

function assertPlanIntegrity(plan: FormalizationPlan): void {
  const parsed = formalizationPlanSchema.safeParse(plan);
  if (!parsed.success) throw new Error(`formalization_plan_invalid: ${parsed.error.issues[0]?.message ?? 'invalid schema'}`);
}

/** Check structure and bind every recorded source span to the frozen original. */
export function assertFormalizationPlan(statement: string, plan: FormalizationPlan): void {
  if (!original.safeParse(statement).success) throw new Error('formalization_plan_statement_invalid');
  assertPlanIntegrity(plan);
  for (const span of plan.spans) {
    if (span.end > statement.length || statement.slice(span.start, span.end) !== span.text)
      throw new Error('formalization_plan_span_invalid');
  }
}

/** Decision/construction tasks need an explicit answer contract before admission. */
export function assertFormalizationPlanReady(plan: FormalizationPlan): void {
  assertPlanIntegrity(plan);
  if (plan.taskKind !== 'prove') throw new Error('formalization_plan_task_kind_unsupported');
  if (plan.unresolved.length) throw new Error('formalization_plan_unresolved');
}

const coverageSchema = z.array(z.object({ originalText: text,
  targetNames: z.array(leanName).min(1).max(recordLimit), explanation: text,
}).strict()).min(1).max(recordLimit);

/**
 * Bind a ready plan to admitted source declarations and the candidate's coverage.
 * Imported names remain claims for elaboration and independent semantic review.
 * This does not infer missing definitions, verify dependency discovery, or prove
 * that a model recorded every domain, quantifier, assumption and conclusion.
 * Call assertFormalizationPlan with the frozen statement before this function.
 */
export function assertFormalizationPlanCandidate(plan: FormalizationPlan, source: string,
  coverage: FormalizationPlanCoverage): void {
  assertFormalizationPlanReady(plan);
  const parsedCoverage = coverageSchema.safeParse(coverage);
  if (!parsedCoverage.success) throw new Error('formalization_plan_coverage_invalid');
  const targetNames = new Set(formalizationTargets(source).map(target => target.name));
  const plannedTargets = new Set(plan.conclusions.flatMap(conclusion => conclusion.targetNames));
  if (targetNames.size !== plannedTargets.size || [...plannedTargets].some(name => !targetNames.has(name)))
    throw new Error('formalization_plan_targets_invalid');

  const declarations = new Map(inspectScopedLeanDeclarations(source).map(declaration => [declaration.qualifiedName, declaration]));
  const newNames = new Set<string>();
  for (const definition of plan.definitions) {
    for (const name of definition.leanNames) {
      if (targetNames.has(name)) throw new Error('formalization_plan_definition_target_overlap');
      const declaration = declarations.get(name);
      if (definition.implementation === 'new') {
        if (!declaration || declaration.kind === 'theorem') throw new Error('formalization_plan_definition_missing');
        newNames.add(name);
      } else if (declaration) throw new Error('formalization_plan_definition_implementation_invalid');
    }
  }
  if ([...declarations.values()].some(declaration => declaration.kind !== 'theorem' && !newNames.has(declaration.qualifiedName)))
    throw new Error('formalization_plan_definition_unplanned');

  const spans = new Map(plan.spans.map(span => [span.id, span]));
  const covered = new Set<string>();
  for (const item of parsedCoverage.data) {
    if (new Set(item.targetNames).size !== item.targetNames.length) throw new Error('formalization_plan_coverage_invalid');
    for (const name of item.targetNames) {
      const conclusions = plan.conclusions.filter(conclusion => conclusion.targetNames.includes(name));
      // Supplemental exact excerpts may be narrower than a cited conclusion span.
      // Every complete planned span is still required by the aggregate check below.
      if (!conclusions.length || !conclusions.some(conclusion => conclusion.spanIds.some(spanId => {
        const spanText = spans.get(spanId)!.text;
        return item.originalText.includes(spanText) || spanText.includes(item.originalText);
      }))) throw new Error('formalization_plan_coverage_invalid');
      covered.add(name);
    }
  }
  if (covered.size !== targetNames.size) throw new Error('formalization_plan_coverage_invalid');
  for (const conclusion of plan.conclusions) {
    for (const name of conclusion.targetNames) {
      if (conclusion.spanIds.some(spanId => !parsedCoverage.data.some(item =>
        item.targetNames.includes(name) && item.originalText.includes(spans.get(spanId)!.text))))
        throw new Error('formalization_plan_coverage_invalid');
    }
  }
}
