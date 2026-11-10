import { describe, expect, it } from 'vitest';
import { assertFormalizationPlan, assertFormalizationPlanCandidate, assertFormalizationPlanReady,
  formalizationPlanSchema, type FormalizationPlan } from '../src/math/formalizationPlan';

const statement = 'Let D be the natural numbers. Define Even(n) to mean n % 2 = 0. For every n in D with Even(n), prove Even(n).';
const source = [
  'namespace Planned',
  'abbrev Domain := Nat',
  'def Even (n : Domain) : Prop := n % 2 = 0',
  'theorem result (n : Domain) (h : Even n) : Even n := by sorry',
  'end Planned',
].join('\n');
function span(original: string, id: string, text: string) {
  const start = original.indexOf(text);
  if (start < 0) throw new Error('Missing test excerpt');
  return { id, start, end: start + text.length, text };
}
function fixture(): FormalizationPlan {
  return {
    schema: 'theorem-os.formalization-plan.v1', taskKind: 'prove',
    spans: [span(statement, 's-domain', 'Let D be the natural numbers.'),
      span(statement, 's-even', 'Define Even(n) to mean n % 2 = 0.'),
      span(statement, 's-object', 'For every n in D'), span(statement, 's-assumption', 'with Even(n)'),
      span(statement, 's-conclusion', 'prove Even(n).')],
    objects: [{ id: 'o-n', spanIds: ['s-object'], description: 'Universally quantified n in the natural-number domain D.', leanType: 'Planned.Domain' }],
    assumptions: [{ id: 'a-even', spanIds: ['s-assumption'], mathematics: 'Even(n) is assumed for the arbitrary n.' }],
    conclusions: [{ id: 'c-even', spanIds: ['s-object', 's-assumption', 's-conclusion'],
      mathematics: 'For every n in D, assuming Even(n), conclude Even(n).', targetNames: ['Planned.result'], assumptionIds: ['a-even'] }],
    definitions: [{ id: 'd-domain', spanIds: ['s-domain'], mathematics: 'D is the domain of natural numbers.',
      implementation: 'new', leanNames: ['Planned.Domain'], dependsOn: ['d-nat'], justification: 'An abbreviation records the domain chosen in the original.' },
    { id: 'd-nat', spanIds: ['s-domain'], mathematics: 'Natural numbers.', implementation: 'existing',
      leanNames: ['Nat'], dependsOn: [], justification: 'Use the standard Lean natural-number type.' },
    { id: 'd-even', spanIds: ['s-even'], mathematics: 'Even(n) means n modulo two is zero.', implementation: 'new',
      leanNames: ['Planned.Even'], dependsOn: ['d-domain'], justification: 'The source introduces the named predicate.' }],
    unresolved: [],
  };
}
const coverage = [{ originalText: statement, targetNames: ['Planned.result'], explanation: 'The target preserves the domain, assumption and conclusion.' }];

describe('formalization plan structure and source binding', () => {
  it('admits a source-bound definition DAG without imposing record order', () => {
    const plan = fixture();
    expect(formalizationPlanSchema.parse(plan)).toEqual(plan);
    expect(() => assertFormalizationPlan(statement, plan)).not.toThrow();
    expect(() => assertFormalizationPlanReady(plan)).not.toThrow();
    expect(() => assertFormalizationPlanCandidate(plan, source, coverage)).not.toThrow();
  });

  it('uses exact UTF-16 slice offsets after astral Unicode characters', () => {
    const prefix = 'A mathematical note 🧮: ', original = prefix + statement, plan = fixture();
    for (const item of plan.spans) { item.start += prefix.length; item.end += prefix.length; }
    expect(() => assertFormalizationPlan(original, plan)).not.toThrow();
    const shifted = structuredClone(plan);
    shifted.spans[0].start--; shifted.spans[0].end--;
    expect(() => assertFormalizationPlan(original, shifted)).toThrow('formalization_plan_span_invalid');
  });

  it('rejects offsets splitting a surrogate pair and malformed original Unicode', () => {
    const plan = fixture();
    plan.spans[0] = { id: 's-domain', start: 0, end: 1, text: '\ud83e' };
    expect(() => assertFormalizationPlan('🧮' + statement, plan)).toThrow('formalization_plan_invalid');
    expect(() => assertFormalizationPlan('\ud800' + statement, fixture())).toThrow('formalization_plan_statement_invalid');
  });

  it('binds repeated source text to the specified occurrence', () => {
    const original = statement + '\n' + statement, plan = fixture();
    for (const item of plan.spans) { item.start += statement.length + 1; item.end += statement.length + 1; }
    expect(() => assertFormalizationPlan(original, plan)).not.toThrow();
    expect(() => assertFormalizationPlan(statement, plan)).toThrow('formalization_plan_span_invalid');
  });

  it('reads late spans from the complete original without truncation', () => {
    const prefix = 'Context line.\n'.repeat(6000), original = prefix + statement, plan = fixture();
    for (const item of plan.spans) { item.start += prefix.length; item.end += prefix.length; }
    expect(() => assertFormalizationPlan(original, plan)).not.toThrow();
    expect(() => assertFormalizationPlan(original.slice(0, 32_000), plan)).toThrow('formalization_plan_span_invalid');
  });

  it.each([
    ['changed text', (plan: FormalizationPlan) => { plan.spans[0].text = plan.spans[0].text.replace('D', 'E'); }],
    ['shifted range', (plan: FormalizationPlan) => { plan.spans[0].start++; plan.spans[0].end++; }],
    ['empty range', (plan: FormalizationPlan) => { plan.spans[0].end = plan.spans[0].start; }],
    ['negative range', (plan: FormalizationPlan) => { plan.spans[0].start = -1; }],
    ['fractional range', (plan: FormalizationPlan) => { plan.spans[0].start = 0.5; }],
    ['empty text', (plan: FormalizationPlan) => { plan.spans[0].text = ' '; plan.spans[0].end = 1; }],
  ] as const)('rejects a %s span', (_label, change) => {
    const plan = fixture(); change(plan);
    expect(() => assertFormalizationPlan(statement, plan)).toThrow(/formalization_plan_/u);
  });

  it.each([
    ['cross-category id', (plan: FormalizationPlan) => { plan.objects[0].id = plan.spans[0].id; }],
    ['span id reference', (plan: FormalizationPlan) => { plan.objects[0].spanIds.push(plan.objects[0].spanIds[0]); }],
    ['source range', (plan: FormalizationPlan) => { plan.spans.push({ ...plan.spans[0], id: 's-duplicate' }); }],
    ['target reference', (plan: FormalizationPlan) => { plan.conclusions[0].targetNames.push('Planned.result'); }],
    ['assumption reference', (plan: FormalizationPlan) => { plan.conclusions[0].assumptionIds.push('a-even'); }],
    ['dependency', (plan: FormalizationPlan) => { plan.definitions[0].dependsOn.push('d-nat'); }],
    ['definition name', (plan: FormalizationPlan) => { plan.definitions[0].leanNames.push('Nat'); }],
  ] as const)('rejects a duplicate %s', (_label, change) => {
    const plan = fixture(); change(plan);
    expect(() => assertFormalizationPlan(statement, plan)).toThrow('formalization_plan_duplicate');
  });

  it('preserves distinct source mappings to the same existing library constant', () => {
    const plan = fixture();
    plan.definitions.push({ id: 'd-natural-quantifier', spanIds: ['s-object'], mathematics: 'The quantified variable has natural-number type.',
      implementation: 'existing', leanNames: ['Nat'], dependsOn: [], justification: 'The domain and the variable both use the same installed type.' });
    expect(formalizationPlanSchema.parse(plan)).toEqual(plan);
    expect(() => assertFormalizationPlan(statement, plan)).not.toThrow();
    expect(() => assertFormalizationPlanCandidate(plan, source, coverage)).not.toThrow();
  });

  it.each(['existing-first', 'new-first'] as const)('rejects an imported/local definition name collision (%s)', order => {
    const plan = fixture();
    plan.definitions.push({ id: 'd-shadow-nat', spanIds: ['s-domain'], mathematics: 'An attempted local replacement for the natural-number type.',
      implementation: 'new', leanNames: ['Nat'], dependsOn: [], justification: 'This must not also claim the imported name.' });
    if (order === 'new-first') plan.definitions.reverse();
    expect(() => assertFormalizationPlan(statement, plan)).toThrow('formalization_plan_duplicate');
  });

  it('still rejects repeated names within one existing record and across new definitions', () => {
    const existing = fixture(); existing.definitions[1].leanNames.push('Nat');
    expect(() => assertFormalizationPlan(statement, existing)).toThrow('formalization_plan_duplicate');
    const local = fixture();
    local.definitions.push({ ...local.definitions[0], id: 'd-domain-again' });
    expect(() => assertFormalizationPlan(statement, local)).toThrow('formalization_plan_duplicate');
  });

  it.each([
    ['span', (plan: FormalizationPlan) => { plan.objects[0].spanIds = ['missing-span']; }],
    ['assumption', (plan: FormalizationPlan) => { plan.conclusions[0].assumptionIds = ['missing-assumption']; }],
    ['definition', (plan: FormalizationPlan) => { plan.definitions[0].dependsOn = ['missing-definition']; }],
  ] as const)('rejects a dangling %s reference even with unresolved work', (_label, change) => {
    const plan = fixture(); change(plan);
    plan.unresolved.push({ id: 'u-context', spanIds: ['s-domain'], description: 'The intended domain still needs review.' });
    expect(() => assertFormalizationPlan(statement, plan)).toThrow(/formalization_plan_.*reference_invalid/u);
  });

  it.each(['o-n', 'a-even', 'c-even', 's-domain', 'u-context', 'Planned.Domain', 'missing-definition'])
    ('rejects a non-definition dependency %s and reports the permitted definition IDs', dependency => {
      const plan = fixture();
      plan.unresolved.push({ id: 'u-context', spanIds: ['s-domain'], description: 'The intended domain still needs review.' });
      plan.definitions[0].dependsOn = ['d-nat', dependency];
      const result = formalizationPlanSchema.safeParse(plan);
      expect(result.success).toBe(false);
      if (result.success) return;
      const issue = result.error.issues.find(issue => issue.message.startsWith('formalization_plan_definition_reference_invalid'))!;
      expect(issue.path).toEqual(['definitions', 0, 'dependsOn']);
      expect(issue.message).toContain(`invalid dependsOn IDs ${JSON.stringify([dependency])}`);
      expect(issue.message).toContain('Allowed definition IDs: ["d-domain","d-nat","d-even"]');
      expect(issue.message).toContain('use [] when there are no definition dependencies');
      expect(plan.definitions[0].dependsOn).toEqual(['d-nat', dependency]);
      plan.definitions[0].dependsOn = [];
      expect(() => assertFormalizationPlan(statement, plan)).not.toThrow();
    });

  it.each([false, true])('rejects definition cycles (self-cycle: %s)', self => {
    const plan = fixture(); plan.definitions[0].dependsOn = [self ? 'd-domain' : 'd-even'];
    expect(() => assertFormalizationPlan(statement, plan)).toThrow('formalization_plan_definition_cycle');
  });

  it('rejects extra fields, unsafe ids, unsupported names and unbounded fields', () => {
    expect(formalizationPlanSchema.safeParse({ ...fixture(), extra: true }).success).toBe(false);
    const nested = fixture(); Object.assign(nested.spans[0], { extra: true });
    expect(formalizationPlanSchema.safeParse(nested).success).toBe(false);
    const unsafe = fixture(); unsafe.objects[0].id = '../object';
    expect(formalizationPlanSchema.safeParse(unsafe).success).toBe(false);
    const name = fixture(); name.conclusions[0].targetNames = ['Planned.«result»'];
    expect(formalizationPlanSchema.safeParse(name).success).toBe(false);
    const alias = fixture(); alias.definitions[0].leanNames = ['_root_.Planned.result'];
    expect(formalizationPlanSchema.safeParse(alias).success).toBe(false);
    const huge = fixture(); huge.objects[0].description = 'x'.repeat(32_001);
    expect(formalizationPlanSchema.safeParse(huge).success).toBe(false);
    const missing = fixture(); missing.objects[0].spanIds = [];
    expect(formalizationPlanSchema.safeParse(missing).success).toBe(false);
  });
});

describe('formalization plan readiness', () => {
  it('retains a structurally valid unresolved plan for repair but blocks generation', () => {
    const plan = fixture();
    plan.unresolved.push({ id: 'u-domain', spanIds: ['s-domain'], description: 'Confirm whether zero belongs to D.' });
    expect(() => assertFormalizationPlan(statement, plan)).not.toThrow();
    expect(() => assertFormalizationPlanReady(plan)).toThrow('formalization_plan_unresolved');
    expect(() => assertFormalizationPlanCandidate(plan, source, coverage)).toThrow('formalization_plan_unresolved');
  });

  it.each(['decision', 'construction'] as const)('blocks %s tasks even if a tautological target is proposed', taskKind => {
    const original = 'Determine whether P holds, and give the requested answer.', plan = fixture();
    plan.taskKind = taskKind; plan.spans = [span(original, 's-question', original)];
    plan.objects = []; plan.assumptions = []; plan.definitions = [];
    plan.conclusions = [{ id: 'c-question', spanIds: ['s-question'], mathematics: 'Determine whether P holds.',
      targetNames: ['answer'], assumptionIds: [] }];
    expect(() => assertFormalizationPlan(original, plan)).not.toThrow();
    expect(() => assertFormalizationPlanReady(plan)).toThrow('formalization_plan_task_kind_unsupported');
    expect(() => assertFormalizationPlanCandidate(plan, 'theorem answer (P : Prop) : P ∨ ¬ P := by sorry',
      [{ originalText: original, targetNames: ['answer'], explanation: 'A proposed decision target.' }]))
      .toThrow('formalization_plan_task_kind_unsupported');
  });
});

describe('formalization plan binding to generated source', () => {
  it('requires every target and every planned target to map to conclusions', () => {
    expect(() => assertFormalizationPlanCandidate(fixture(), source + '\ntheorem extra : True := by sorry', coverage))
      .toThrow('formalization_plan_targets_invalid');
    const plan = fixture(); plan.conclusions[0].targetNames.push('Planned.missing');
    expect(() => assertFormalizationPlanCandidate(plan, source, coverage)).toThrow('formalization_plan_targets_invalid');
  });

  it('resolves qualified names instead of accepting a similarly named local declaration', () => {
    const plan = fixture(); plan.definitions[0].leanNames = ['Other.Domain'];
    expect(() => assertFormalizationPlanCandidate(plan, source, coverage)).toThrow('formalization_plan_definition_missing');
  });

  it('requires every new definition to name an admitted declaration actually present in source', () => {
    const plan = fixture(); plan.definitions[0].leanNames = ['Planned.Missing'];
    expect(() => assertFormalizationPlanCandidate(plan, source, coverage)).toThrow('formalization_plan_definition_missing');
    expect(() => assertFormalizationPlanCandidate(fixture(), source.replace('abbrev Domain := Nat', '-- abbrev Domain := Nat'), coverage))
      .toThrow('formalization_plan_definition_missing');
  });

  it('requires added local definitions to be planned as new, including named instances', () => {
    expect(() => assertFormalizationPlanCandidate(fixture(), source.replace('theorem result', 'def extra : Nat := 0\ntheorem result'), coverage))
      .toThrow('formalization_plan_definition_unplanned');
    const plan = fixture(); plan.definitions[0].implementation = 'existing';
    expect(() => assertFormalizationPlanCandidate(plan, source, coverage)).toThrow('formalization_plan_definition_implementation_invalid');
    const withInstance = source.replace('theorem result', 'instance domainDefault : Inhabited Domain := ⟨0⟩\ntheorem result');
    expect(() => assertFormalizationPlanCandidate(fixture(), withInstance, coverage)).toThrow('formalization_plan_definition_unplanned');
    const planned = fixture();
    planned.definitions.push({ id: 'd-default', spanIds: ['s-domain'], mathematics: 'The natural-number domain has a default element zero.',
      implementation: 'new', leanNames: ['Planned.domainDefault'], dependsOn: ['d-domain'], justification: 'Provide the named default instance.' });
    expect(() => assertFormalizationPlanCandidate(planned, withInstance, coverage)).not.toThrow();
  });

  it('never uses a target theorem as a definition mapping', () => {
    for (const implementation of ['existing', 'new'] as const) {
      const plan = fixture(); plan.definitions[0].leanNames = ['Planned.result']; plan.definitions[0].implementation = implementation;
      expect(() => assertFormalizationPlanCandidate(plan, source, coverage)).toThrow('formalization_plan_definition_target_overlap');
    }
  });

  it('applies source admission before accepting declarations mentioned in the plan', () => {
    expect(() => assertFormalizationPlanCandidate(fixture(), 'axiom fake : False\n' + source, coverage))
      .toThrow('formalization_unsupported_declaration');
    expect(() => assertFormalizationPlanCandidate(fixture(), source.replace('abbrev Domain := Nat', 'def Domain := _'), coverage))
      .toThrow('formalization_placeholder_outside_proof');
  });

  it('allows separate conclusion fragments to map to the same target', () => {
    const plan = fixture();
    plan.conclusions.push({ id: 'c-assumed', spanIds: ['s-assumption'], mathematics: 'The same predicate is present as the hypothesis.',
      targetNames: ['Planned.result'], assumptionIds: ['a-even'] });
    expect(() => assertFormalizationPlanCandidate(plan, source, coverage)).not.toThrow();
  });

  it('requires coverage for all conclusion spans and exact target identities', () => {
    const short = [{ ...coverage[0], originalText: 'prove Even(n).' }];
    expect(() => assertFormalizationPlanCandidate(fixture(), source, short)).toThrow('formalization_plan_coverage_invalid');
    expect(() => assertFormalizationPlanCandidate(fixture(), source, [{ ...coverage[0], targetNames: ['result'] }]))
      .toThrow('formalization_plan_coverage_invalid');
    expect(() => assertFormalizationPlanCandidate(fixture(), source, [{ ...coverage[0], targetNames: ['Planned.result', 'Planned.result'] }]))
      .toThrow('formalization_plan_coverage_invalid');
    expect(() => assertFormalizationPlanCandidate(fixture(), source, [])).toThrow('formalization_plan_coverage_invalid');
    expect(() => assertFormalizationPlanCandidate(fixture(), source, [{ ...coverage[0], originalText: 'Let D be the natural numbers.' }]))
      .toThrow('formalization_plan_coverage_invalid');
  });

  it('accepts multiple exact excerpts when they jointly cover one conclusion', () => {
    const plan = fixture(), excerpts = plan.conclusions[0].spanIds.map(id => ({
      originalText: plan.spans.find(item => item.id === id)!.text, targetNames: ['Planned.result'], explanation: 'An exact source excerpt.',
    }));
    expect(() => assertFormalizationPlanCandidate(plan, source, excerpts)).not.toThrow();
  });

  it('accepts supplemental excerpts contained in fully covered conclusion spans', () => {
    const plan = fixture();
    const supplemental = { originalText: 'every n', targetNames: ['Planned.result'], explanation: 'The arbitrary object binder.' };
    expect(() => assertFormalizationPlanCandidate(plan, source, [...coverage, supplemental])).not.toThrow();
    expect(() => assertFormalizationPlanCandidate(plan, source, [supplemental])).toThrow('formalization_plan_coverage_invalid');
  });

  it('keeps rejecting supplemental excerpts unrelated to a target conclusion', () => {
    const unrelated = { originalText: 'natural numbers', targetNames: ['Planned.result'], explanation: 'The separate domain definition.' };
    expect(() => assertFormalizationPlanCandidate(fixture(), source, [...coverage, unrelated]))
      .toThrow('formalization_plan_coverage_invalid');
  });

  it('does not let a supplemental excerpt hide an uncovered subquestion', () => {
    const plan = fixture();
    plan.conclusions.push({ id: 'c-second', spanIds: ['s-even'], mathematics: 'An additional requested conclusion.',
      targetNames: ['Planned.extra'], assumptionIds: [] });
    const extraSource = source + '\ntheorem Planned.extra : True := by sorry';
    const excerpts = plan.conclusions[0].spanIds.map(id => ({ originalText: plan.spans.find(item => item.id === id)!.text,
      targetNames: ['Planned.result'], explanation: 'A complete first conclusion excerpt.' }));
    expect(() => assertFormalizationPlanCandidate(plan, extraSource, [...excerpts, { originalText: 'Even(n)',
      targetNames: ['Planned.extra'], explanation: 'Only part of the second conclusion.' }]))
      .toThrow('formalization_plan_coverage_invalid');
  });
});
