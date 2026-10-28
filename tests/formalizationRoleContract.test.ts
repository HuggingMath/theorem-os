import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formalizationCandidateSchema, formalizationReviewSchema, formalizationTranslationSchema } from '../src/math/formalization';
import { formalizationPlanSchema } from '../src/math/formalizationPlan';
import { deriveFormalizationRoleOutputJsonSchema, getFormalizationRoleOutputSchema, getFormalizationRoleOutputValidator,
  type FormalizationOutputJsonSchema, type FormalizationOutputRole } from '../src/math/formalizationRoleContract';

const statement = 'For every natural number n, prove n + 0 = n.';
const fixtures = {
  plan: { schema: 'theorem-os.formalization-plan.v1', taskKind: 'prove',
    spans: [{ id: 'whole', start: 0, end: statement.length, text: statement }],
    objects: [{ id: 'object-n', spanIds: ['whole'], description: 'An arbitrary natural number.', leanType: 'Nat' }],
    assumptions: [{ id: 'domain', spanIds: ['whole'], mathematics: 'n is a natural number.' }],
    conclusions: [{ id: 'goal', spanIds: ['whole'], mathematics: 'n + 0 = n.',
      targetNames: ['addition'], assumptionIds: ['domain'] }],
    definitions: [{ id: 'naturals', spanIds: ['whole'], mathematics: 'The natural numbers.', implementation: 'existing',
      leanNames: ['Nat'], dependsOn: [], justification: 'Use the standard natural-number domain.' }], unresolved: [] },
  generate: { source: 'theorem addition (n : Nat) : n + 0 = n := by sorry\n',
    coverage: [{ originalText: statement, targetNames: ['addition'], explanation: 'Preserve the complete source claim.' }],
    assumptions: ['n is a natural number.'], assumptionsExplanation: 'Use the source domain.', definitionsExplanation: 'Use standard addition.' },
  backtranslate: { snapshotDigest: 'a'.repeat(64), mathematics: statement, assumptions: ['n is a natural number.'],
    definitions: ['Standard natural-number addition.'], targets: [{ name: 'addition', mathematics: 'For every natural n, n + 0 = n.' }] },
  compare: { inputDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), translationDigest: 'c'.repeat(64),
    verdict: 'approved', summary: 'The complete natural-number statement is preserved.',
    checks: { equivalent: true, complete: true, assumptions: true, definitions: true }, issues: [] },
};
const originals = { plan: formalizationPlanSchema, generate: formalizationCandidateSchema,
  backtranslate: formalizationTranslationSchema, compare: formalizationReviewSchema };
const roles = Object.keys(fixtures) as FormalizationOutputRole[];

function strictObjects(schema: FormalizationOutputJsonSchema): void {
  if (schema.type === 'object') {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(schema.properties!));
    Object.values(schema.properties!).forEach(strictObjects);
  }
  if (schema.items) strictObjects(schema.items);
  schema.allOf?.forEach(strictObjects);
  schema.anyOf?.forEach(strictObjects);
}

describe('formalization role output contracts derived from host Zod schemas', () => {
  it.each(roles)('exposes the actual %s validator and a complete strict JSON guide for a valid output', role => {
    expect(getFormalizationRoleOutputValidator(role)).toBe(originals[role]);
    expect(getFormalizationRoleOutputValidator(role).parse(fixtures[role])).toEqual(fixtures[role]);
    const schema = getFormalizationRoleOutputSchema(role);
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.title).toContain(role);
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties!).sort()).toEqual(Object.keys(fixtures[role]).sort());
    strictObjects(schema);
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    expect(JSON.stringify(schema)).not.toContain('_def');
    expect(getFormalizationRoleOutputValidator(role).safeParse({ ...fixtures[role], unexpected: true }).success).toBe(false);
    const missing = { ...fixtures[role] } as Record<string, unknown>;
    delete missing[Object.keys(missing)[0]];
    expect(getFormalizationRoleOutputValidator(role).safeParse(missing).success).toBe(false);
  });

  it('preserves the actual planning field names, literal, task/definition enums and source offset bounds', () => {
    const properties = getFormalizationRoleOutputSchema('plan').properties!;
    expect(properties.schema).toMatchObject({ type: 'string', const: 'theorem-os.formalization-plan.v1' });
    expect(properties.taskKind).toEqual({ type: 'string', enum: ['prove', 'decision', 'construction'] });
    expect(properties.spans).toMatchObject({ type: 'array', minItems: 1, maxItems: 256 });
    const span = properties.spans.items!.properties!;
    expect(span.start).toMatchObject({ type: 'integer', minimum: 0, maximum: 256 * 1024 });
    expect(span.end).toMatchObject({ type: 'integer', minimum: 1, maximum: 256 * 1024 });
    expect(span.id.pattern).toBe('^[A-Za-z0-9_-]{1,128}$');
    expect(new RegExp(span.id.pattern!).test('span-1')).toBe(true);
    expect(new RegExp(span.id.pattern!).test('invalid span')).toBe(false);
    expect(properties.objects).toMatchObject({ maxItems: 256 });
    expect(properties.definitions.items!.properties!.implementation.enum).toEqual(['existing', 'new']);
    expect(properties.definitions.items!.required).toEqual([
      'id', 'spanIds', 'mathematics', 'implementation', 'leanNames', 'dependsOn', 'justification',
    ]);
    expect(properties.conclusions.items!.properties!.assumptionIds).toMatchObject({ type: 'array', maxItems: 256 });
    expect(properties.conclusions.items!.properties!.targetNames).toMatchObject({ minItems: 1, maxItems: 256 });
  });

  it('explains source coordinates and theorem-only coverage at the fields models write', () => {
    const plan = getFormalizationRoleOutputSchema('plan').properties!, span = plan.spans.items!.properties!;
    expect(span.start.description).toContain('parsed INPUT.statement');
    expect(span.start.description).toContain('statement.indexOf(text)');
    expect(span.end.description).toContain('statement.slice(start, end) === text');
    expect(span.text.description).toContain('whitespace and punctuation unchanged');
    expect(plan.conclusions.items!.properties!.targetNames.description).toContain('Do not list imported library constants');
    expect(plan.definitions.items!.properties!.leanNames.description).toContain('separate records may reuse a constant');
    const coverage = getFormalizationRoleOutputSchema('generate').properties!.coverage;
    expect(coverage.description).toContain('every full planned conclusion span for each target');
    expect(coverage.items!.properties!.originalText.description).toContain('Copy plan.spans text verbatim');
    expect(coverage.items!.properties!.targetNames.description).toContain('Only generated theorem/lemma names');
  });

  it('retains generation and backtranslation text/array limits instead of replacing refined text with an unconstrained type', () => {
    const generation = getFormalizationRoleOutputSchema('generate').properties!;
    expect(generation.source).toEqual({ type: 'string', minLength: 1, maxLength: 128 * 1024 });
    expect(generation.coverage).toMatchObject({ type: 'array', minItems: 1, maxItems: 256 });
    expect(generation.coverage.items!.properties!.originalText).toMatchObject({ type: 'string', minLength: 1, maxLength: 32000 });
    expect(generation.assumptions).toMatchObject({ type: 'array', maxItems: 256 });
    const translation = getFormalizationRoleOutputSchema('backtranslate').properties!;
    expect(translation.snapshotDigest).toEqual({ type: 'string', pattern: '^[a-f0-9]{64}$' });
    expect(translation.targets).toMatchObject({ type: 'array', minItems: 1, maxItems: 256 });
    expect(translation.targets.items!.required).toEqual(['name', 'mathematics']);
  });

  it('preserves review booleans, verdicts and digest patterns, including strict nested checks', () => {
    const properties = getFormalizationRoleOutputSchema('compare').properties!;
    expect(properties.verdict.enum).toEqual(['approved', 'changes_requested', 'unknown']);
    for (const name of ['inputDigest', 'snapshotDigest', 'translationDigest'])
      expect(properties[name].pattern).toBe('^[a-f0-9]{64}$');
    expect(properties.checks.required).toEqual(['equivalent', 'complete', 'assumptions', 'definitions']);
    expect(Object.values(properties.checks.properties!).every(field => field.type === 'boolean')).toBe(true);
    expect(getFormalizationRoleOutputValidator('compare').safeParse({ ...fixtures.compare,
      checks: { ...fixtures.compare.checks, guessed: true } }).success).toBe(false);
    expect(getFormalizationRoleOutputValidator('compare').safeParse({ ...fixtures.compare,
      checks: { ...fixtures.compare.checks, equivalent: 'true' } }).success).toBe(false);
  });

  it('does not claim that exported structural constraints replace host refinements', () => {
    expect(getFormalizationRoleOutputSchema('plan').$comment).toContain('host still enforces');
    expect(getFormalizationRoleOutputSchema('generate').properties!.assumptionsExplanation.$comment).toContain('host still enforces');
    const dangling = structuredClone(fixtures.plan);
    dangling.objects[0].spanIds = ['unknown-span'];
    expect(getFormalizationRoleOutputValidator('plan').safeParse(dangling).success).toBe(false);
    expect(getFormalizationRoleOutputValidator('generate').safeParse({ ...fixtures.generate,
      assumptionsExplanation: ' ' }).success).toBe(false);
    const fractional = structuredClone(fixtures.plan);
    fractional.spans[0].start = 0.5;
    expect(getFormalizationRoleOutputValidator('plan').safeParse(fractional).success).toBe(false);
  });

  it('never executes a refinement while deriving its structural guide', () => {
    let called = 0;
    const host = z.string().min(2).max(5).refine(() => { called++; return false; });
    expect(deriveFormalizationRoleOutputJsonSchema(host)).toMatchObject({ type: 'string', minLength: 2, maxLength: 5 });
    expect(called).toBe(0); expect(host.safeParse('abc').success).toBe(false); expect(called).toBe(1);
  });

  it('combines repeated and exact bounds and multiple regex checks without dropping constraints', () => {
    const schema = deriveFormalizationRoleOutputJsonSchema(z.object({
      name: z.string().min(2).min(1).max(7).max(9).regex(/^a/u).regex(/z$/u),
      list: z.array(z.boolean()).min(2).length(3).max(4),
      exact: z.string().length(4), score: z.number().int().min(1).min(0).gt(0).max(10).lt(11),
    }).strict());
    expect(schema.properties!.name).toEqual({ type: 'string', minLength: 2, maxLength: 7,
      allOf: [{ pattern: '^a' }, { pattern: 'z$' }] });
    expect(schema.properties!.list).toEqual({ type: 'array', minItems: 3, maxItems: 3, items: { type: 'boolean' } });
    expect(schema.properties!.exact).toEqual({ type: 'string', minLength: 4, maxLength: 4 });
    expect(schema.properties!.score).toEqual({ type: 'integer', minimum: 1, exclusiveMinimum: 0,
      maximum: 10, exclusiveMaximum: 11 });
  });

  it('keeps a nullable evidence object required and preserves its strict inner contract', () => {
    const host = z.object({ evidence: z.object({ argument: z.string().min(1) }).strict().nullable() }).strict();
    const schema = deriveFormalizationRoleOutputJsonSchema(host);
    expect(schema.required).toEqual(['evidence']);
    expect(schema.properties!.evidence.anyOf).toEqual([
      { type: 'object', additionalProperties: false, required: ['argument'],
        properties: { argument: { type: 'string', minLength: 1 } } },
      { type: 'null', const: null },
    ]);
    strictObjects(schema);
    expect(host.safeParse({ evidence: null }).success).toBe(true);
    expect(host.safeParse({ evidence: { argument: 'A complete separation argument.' } }).success).toBe(true);
    expect(host.safeParse({}).success).toBe(false);
    expect(host.safeParse({ evidence: { argument: 'x', extra: true } }).success).toBe(false);
    expect(() => deriveFormalizationRoleOutputJsonSchema(z.unknown().nullable()))
      .toThrow('formalization_role_output_schema_unsupported');
  });

  it.each([
    ['unknown', z.unknown()], ['any', z.any()], ['record', z.record(z.string())], ['date', z.date()],
    ['union', z.union([z.string(), z.boolean()])], ['optional', z.string().optional()],
    ['passthrough', z.object({ value: z.string() }).passthrough()], ['strip', z.object({ value: z.string() })],
    ['transform', z.string().transform(value => value.length)], ['preprocess', z.preprocess(value => value, z.string())],
    ['unmapped string check', z.string().email()], ['regex flags', z.string().regex(/example/i)],
    ['unmapped number check', z.number().multipleOf(3)], ['coerced string', z.coerce.string()],
    ['coerced number', z.coerce.number()], ['coerced boolean', z.coerce.boolean()],
  ] as const)('fails closed for an unsupported schema feature: %s', (_name, schema) => {
    expect(() => deriveFormalizationRoleOutputJsonSchema(schema)).toThrow('formalization_role_output_schema_unsupported');
  });

  it.each(['other', 'toString', 'constructor'])('fails closed for an unknown role: %s', role => {
    expect(() => getFormalizationRoleOutputSchema(role as FormalizationOutputRole)).toThrow('formalization_role_output_role_unsupported');
    expect(() => getFormalizationRoleOutputValidator(role as FormalizationOutputRole)).toThrow('formalization_role_output_role_unsupported');
  });

  it('returns fresh guides that cannot mutate the host schemas or another role invocation', () => {
    const first = getFormalizationRoleOutputSchema('plan');
    first.properties!.schema.const = 'changed'; first.required!.push('injected');
    const second = getFormalizationRoleOutputSchema('plan');
    expect(second.properties!.schema.const).toBe(fixtures.plan.schema);
    expect(second.required).not.toContain('injected');
    expect(getFormalizationRoleOutputValidator('plan').safeParse(fixtures.plan).success).toBe(true);
  });
});
