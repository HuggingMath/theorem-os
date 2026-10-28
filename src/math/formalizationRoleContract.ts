import { z } from 'zod';
import { formalizationCandidateSchema, formalizationReviewSchema, formalizationTranslationSchema } from './formalization';
import { formalizationPlanSchema } from './formalizationPlan';
import { structuredReviewDigest, structuredSemanticReviewValidator, type StructuredReviewInput } from './formalizationSemanticReview';

const validators = Object.freeze({
  plan: formalizationPlanSchema,
  generate: formalizationCandidateSchema,
  backtranslate: formalizationTranslationSchema,
  compare: formalizationReviewSchema,
});

export type FormalizationOutputRole = keyof typeof validators;
export type FormalizationOutputJsonSchema = {
  $schema?: string; title?: string; description?: string; $comment?: string;
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, FormalizationOutputJsonSchema>; required?: string[]; additionalProperties?: boolean;
  items?: FormalizationOutputJsonSchema; minItems?: number; maxItems?: number;
  minLength?: number; maxLength?: number; pattern?: string; allOf?: FormalizationOutputJsonSchema[];
  anyOf?: FormalizationOutputJsonSchema[];
  minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number;
  enum?: string[]; const?: string | number | boolean | null;
};

const unsupported = (detail: string): never => { throw new Error('formalization_role_output_schema_unsupported:' + detail); };
const hostRefinements = 'The host still enforces the original Zod schema and every refinement, including nonempty text, valid Lean names, source spans, unique IDs and dependency references. This structural JSON Schema does not replace host acceptance. String length limits also remain subject to Zod UTF-16 checks.';

/**
 * Small, deliberately closed Zod 3 exporter for the types in the four role contracts.
 * It never runs refinements or duplicates the role field definitions. A newly introduced
 * unsupported type/check fails before a role is launched rather than weakening its guide.
 */
export function deriveFormalizationRoleOutputJsonSchema(schema: z.ZodTypeAny): FormalizationOutputJsonSchema {
  const kind = schema._def.typeName as z.ZodFirstPartyTypeKind;
  let result: FormalizationOutputJsonSchema;
  switch (kind) {
    case z.ZodFirstPartyTypeKind.ZodEffects: {
      const definition = (schema as z.ZodEffects<z.ZodTypeAny>)._def;
      if (definition.effect.type !== 'refinement') unsupported('effect_' + definition.effect.type);
      result = { ...deriveFormalizationRoleOutputJsonSchema(definition.schema),
        $comment: 'Structural inner schema only; the host still enforces the original Zod refinement.' };
      break;
    }
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const definition = (schema as z.ZodObject<z.ZodRawShape>)._def;
      if (definition.unknownKeys !== 'strict' || definition.catchall._def.typeName !== z.ZodFirstPartyTypeKind.ZodNever)
        unsupported('object_unknown_keys');
      const shape = definition.shape();
      // Optional/default/undefined fields are not among the supported types, so every
      // successfully exported property is required, exactly as in the current contracts.
      result = { type: 'object', additionalProperties: false, required: Object.keys(shape),
        properties: Object.fromEntries(Object.entries(shape).map(([name, child]) =>
          [name, deriveFormalizationRoleOutputJsonSchema(child)])) };
      break;
    }
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const definition = (schema as z.ZodArray<z.ZodTypeAny>)._def;
      result = { type: 'array', items: deriveFormalizationRoleOutputJsonSchema(definition.type) };
      if (definition.minLength) result.minItems = definition.minLength.value;
      if (definition.maxLength) result.maxItems = definition.maxLength.value;
      if (definition.exactLength) {
        result.minItems = Math.max(result.minItems ?? 0, definition.exactLength.value);
        result.maxItems = Math.min(result.maxItems ?? Infinity, definition.exactLength.value);
      }
      break;
    }
    case z.ZodFirstPartyTypeKind.ZodNullable:
      result = { anyOf: [deriveFormalizationRoleOutputJsonSchema((schema as z.ZodNullable<z.ZodTypeAny>)._def.innerType),
        { type: 'null', const: null }] };
      break;
    case z.ZodFirstPartyTypeKind.ZodString: {
      const definition = (schema as z.ZodString)._def;
      if (definition.coerce) unsupported('string_coerce');
      result = { type: 'string' };
      const patterns: string[] = [];
      for (const check of definition.checks) {
        if (check.kind === 'min') result.minLength = Math.max(result.minLength ?? 0, check.value);
        else if (check.kind === 'max') result.maxLength = Math.min(result.maxLength ?? Infinity, check.value);
        else if (check.kind === 'length') {
          result.minLength = Math.max(result.minLength ?? 0, check.value);
          result.maxLength = Math.min(result.maxLength ?? Infinity, check.value);
        } else if (check.kind === 'regex') {
          if (/[^u]/u.test(check.regex.flags)) unsupported('regex_flags');
          patterns.push(check.regex.source);
        } else unsupported('string_' + check.kind);
      }
      if (patterns.length === 1) result.pattern = patterns[0];
      else if (patterns.length) result.allOf = patterns.map(pattern => ({ pattern }));
      break;
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const definition = (schema as z.ZodNumber)._def;
      if (definition.coerce) unsupported('number_coerce');
      result = { type: 'number' };
      for (const check of definition.checks) {
        if (check.kind === 'int') result.type = 'integer';
        else if (check.kind === 'min') {
          const key = check.inclusive ? 'minimum' : 'exclusiveMinimum';
          result[key] = Math.max(result[key] ?? -Infinity, check.value);
        } else if (check.kind === 'max') {
          const key = check.inclusive ? 'maximum' : 'exclusiveMaximum';
          result[key] = Math.min(result[key] ?? Infinity, check.value);
        } else if (check.kind !== 'finite') unsupported('number_' + check.kind);
      }
      break;
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      if ((schema as z.ZodBoolean)._def.coerce) unsupported('boolean_coerce');
      result = { type: 'boolean' };
      break;
    case z.ZodFirstPartyTypeKind.ZodEnum:
      result = { type: 'string', enum: [...(schema as z.ZodEnum<[string, ...string[]]>)._def.values] };
      break;
    case z.ZodFirstPartyTypeKind.ZodLiteral: {
      const value: unknown = (schema as z.ZodLiteral<string | number | boolean | null>)._def.value;
      if (value === null) result = { type: 'null', const: null };
      else if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))
        result = { type: typeof value as 'string' | 'boolean' | 'number', const: value };
      else unsupported('literal');
      break;
    }
    default: return unsupported(String(kind));
  }
  if (schema.description !== undefined) result.description = schema.description;
  return result;
}

export function getFormalizationRoleOutputValidator<Role extends FormalizationOutputRole>(role: Role): typeof validators[Role] {
  if (!Object.hasOwn(validators, role)) throw new Error('formalization_role_output_role_unsupported');
  return validators[role];
}

/** A fresh serializable guide for OUTPUT.schema.json; original host validators remain authoritative. */
export function getFormalizationRoleOutputSchema(role: FormalizationOutputRole): FormalizationOutputJsonSchema {
  const schema = deriveFormalizationRoleOutputJsonSchema(getFormalizationRoleOutputValidator(role));
  if (role === 'generate') {
    const coverage = schema.properties!.coverage;
    coverage.description = 'Bind original task excerpts to generated theorem/lemma targets. When INPUT.plan is present, create an item for every conclusion span using the corresponding plan.spans text and conclusion.targetNames; collectively preserve every full planned conclusion span for each target.';
    const item = coverage.items!.properties!;
    item.originalText.description = 'An exact substring of parsed INPUT.statement, including its original whitespace and punctuation. Copy plan.spans text verbatim when covering a planned conclusion span. Do not add punctuation, change TeX escaping or paraphrase. With a plan, supplemental excerpts must be contained in, or contain, a span of a conclusion mapped to that target.';
    item.targetNames.description = 'Only generated theorem/lemma names, including their Lean namespace, exactly as listed in INPUT.plan.conclusions when a plan is present. Never put imported constants, classes, definitions or dependency names here. Explain those in assumptions or definitionsExplanation.';
  }
  return { ...schema,
    $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'TheoremOS ' + role + ' OUTPUT.json',
    $comment: hostRefinements };
}

/** Shared by generated statements and benchmark review; identity is part of the actual role input. */
export function getStructuredFormalizationReviewOutputSchema(input: StructuredReviewInput): FormalizationOutputJsonSchema {
  const schema = deriveFormalizationRoleOutputJsonSchema(structuredSemanticReviewValidator(input));
  return { ...schema, $schema: 'https://json-schema.org/draft/2020-12/schema', properties: { ...schema.properties,
    caseId: { const: input.caseId }, inputDigest: { const: structuredReviewDigest(input) } } };
}
