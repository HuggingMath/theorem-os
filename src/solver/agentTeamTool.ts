import { z } from 'zod';
import type { MathAgentToolDefinition } from '../runtime/agentSession';
import { declarationSubmissionSchema } from './declarationArtifacts';
import { portfolioRouteIdSchema, routeRetirementSchema } from './routeControl';
import { nativePlanApprovalSchema } from './planApproval';

type Json = Record<string, any>;
const text = z.string().trim().min(1).max(16000);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const submission = z.object({
  operation: z.literal('submit'), summary: text, objectiveRevision: z.number().int().positive().optional(),
  declarations: declarationSubmissionSchema.shape.declarations, helpersOnly: z.boolean().optional(),
}).strict();
// Saved threads can still send the old operation. Keep its parsed form for the operation journal.
export const legacyHelperSubmissionSchema = submission.omit({ helpersOnly: true })
  .extend({ operation: z.literal('submit_helpers') });

export const agentTeamRequestSchema = z.discriminatedUnion('operation', [
  nativePlanApprovalSchema,
  z.object({ operation: z.literal('finish'), summary: text }).strict(),
  z.object({ operation: z.literal('yield'), reason: text }).strict(),
  z.object({ operation: z.literal('history'), agentId: id.optional(), offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(8).optional() }).strict(),
  z.object({ operation: z.literal('inspect'), deliveryId: z.string().regex(/^[a-f0-9]{64}$/u),
    changeIndex: z.number().int().nonnegative().optional(), offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(16000).optional() }).strict(),
  z.object({ operation: z.literal('inspect-research'), artifactId: z.string().regex(/^[a-f0-9]{64}$/u),
    offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(16000).optional() }).strict(),
  submission,
  z.object({ operation: z.literal('adopt'), deliveryId: z.string().regex(/^[a-f0-9]{64}$/u), targetId: id.optional() }).strict(),
  routeRetirementSchema.extend({ operation: z.literal('retire_route') }),
  z.object({ operation: z.literal('route_summary'), routeId: portfolioRouteIdSchema.optional(),
    includeRetired: z.boolean().optional() }).strict(),
]);

const deliveryOperations = new Set(['yield', 'submit']);
const leadOperations = new Set(['publish_plan', 'finish', 'adopt', 'retire_route']);

function operationsFor(actor: string, approval: boolean) {
  return agentTeamRequestSchema.options.filter(option => {
    const operation = option.shape.operation.value;
    if (operation === 'publish_plan' && !approval) return false;
    return actor === 'lead' ? !deliveryOperations.has(operation) : !leadOperations.has(operation);
  });
}

export function agentTeamOperationAllowed(actor: string, operation: string, approval = false) {
  return operationsFor(actor, approval).some(option => option.shape.operation.value === operation);
}

/** Only the concrete schema kinds used by this interface; refinements still run on the host. */
function fieldSchema(value: z.ZodTypeAny): Json {
  if (value instanceof z.ZodOptional) return fieldSchema(value.unwrap());
  if (value instanceof z.ZodEffects) return fieldSchema(value.innerType());
  if (value instanceof z.ZodString) {
    const schema: Json = { type: 'string' };
    for (const check of value._def.checks) {
      if (check.kind === 'min') schema.minLength = check.value;
      if (check.kind === 'max') schema.maxLength = check.value;
      if (check.kind === 'regex') schema.pattern = check.regex.source;
    }
    return schema;
  }
  if (value instanceof z.ZodNumber) {
    const schema: Json = { type: value.isInt ? 'integer' : 'number' };
    if (value.minValue !== null) schema.minimum = value.minValue;
    if (value.maxValue !== null) schema.maximum = value.maxValue;
    return schema;
  }
  if (value instanceof z.ZodBoolean) return { type: 'boolean' };
  if (value instanceof z.ZodLiteral) return { type: 'string', enum: [value.value] };
  if (value instanceof z.ZodEnum) return { type: 'string', enum: value.options };
  if (value instanceof z.ZodArray) return { type: 'array', items: fieldSchema(value.element),
    ...(value._def.minLength ? { minItems: value._def.minLength.value } : {}),
    ...(value._def.maxLength ? { maxItems: value._def.maxLength.value } : {}) };
  if (value instanceof z.ZodObject) {
    const shape = value.shape as z.ZodRawShape;
    return { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, fieldSchema(field)])),
      required: Object.keys(shape).filter(key => !shape[key]!.isOptional()), additionalProperties: false };
  }
  throw new Error('math_team_tool_schema_kind_unsupported');
}

function operationContracts(actor: string, approval: boolean) {
  return operationsFor(actor, approval).map(option => {
    const schema = fieldSchema(option);
    // Old native threads can still submit the previously accepted optional field.
    // The advertised interface binds the current task itself.
    delete schema.properties.objectiveRevision;
    return { operation: option.shape.operation.value, schema };
  });
}

function contractText(operation: string, schema: Json): string {
  const required = (schema.required as string[]).filter(key => key !== 'operation');
  const optional = Object.keys(schema.properties).filter(key => key !== 'operation' && !required.includes(key));
  return `${operation}: required ${required.length ? required.join(', ') : 'none'}; optional ${optional.length ? optional.join(', ') : 'none'}; other fields forbidden.` +
    (operation === 'inspect' ? ' For more source, pass a changeIndex from the overview and its nextOffset. offset and limit require changeIndex and count Unicode code points.' : '');
}

/** The same contracts drive advertised fields and corrective feedback. */
export function agentTeamArgumentFeedback(actor: string, args: unknown, error: z.ZodError, approval = false) {
  const operation = args && typeof args === 'object' && 'operation' in args ? (args as Json).operation : undefined;
  const contracts = operationContracts(actor, approval);
  const contract = contracts.find(item => item.operation === operation);
  return { ok: false, error: 'math_team_arguments_invalid', detail: error.message,
    ...(contract ? { contract: contract.schema, hint: contractText(contract.operation, contract.schema) } : {
      allowedOperations: contracts.map(item => item.operation), hint: 'Choose an advertised operation for this caller.' }),
  };
}

/** Advertise required/allowed fields per operation, retaining the native single-entry interface. */
export function agentTeamToolDefinition(actor: string, approval = false): MathAgentToolDefinition {
  const lead = actor === 'lead', contracts = operationContracts(actor, approval);
  const properties: Json = {};
  for (const { schema } of contracts) Object.assign(properties, schema.properties);
  properties.operation = { type: 'string', enum: contracts.map(item => item.operation) };
  const purpose = lead
    ? 'Mathematical host interface for the Lead. Native collaboration tools manage agent identities, spawning, followups, messages and interruption. Adopt rechecks a delivery in the saved consumer draft before merging. Inspect shows details on demand. Return with saved original proofs for independent checking. Finish requests early handoff. '
    : 'Mathematical host interface for a proof-writing member. Native collaboration tools deliver messages. Submit exact saved declarations, then return for stopped-writer checking. Yield preserves this task and draft for native followup after dependencies are integrated. ';
  return { name: 'theoremos_team', description: purpose +
    'History pages complete business task text; inspect and inspect-research read fixed evidence. agentId/targetId refer to the workspace member IDs shown in team observations; native collaboration targets use canonical paths or thread IDs. ' +
    'Configured limits apply to the shared run. ' +
    (lead && approval ? 'While approval is required, first call publish_plan with goals [{theoremName,objective}] for all original targets and optional investigations, then return. Follow the host approval status before starting proof work. ' : '') +
    'Only the host publishes checked proof evidence; original proof acceptance remains independent. Inspection and adoption retain peer-result provenance. ' +
    (lead ? 'Use retire_route to record a refutation and cancel all unfinished work tagged with that route. ' +
      'For native spawn_agent or followup_task, put an optional Route: ROUTE_ID line first, then an optional Profiles: line of comma-separated IDs or slugs, then the assignment. ' :
      'Set helpersOnly:true on submit to share standalone helpers and keep the assignment open. The host makes checked helpers available to peers before their next turn. ' +
      'Submit omits agentId because the caller and task are already bound; each declaration supplies file, name and complete closed type. For a new auxiliary def or abbrev, also set kind to "definition"; submit theorems about it as separate declarations. ') +
    'Use route_summary for a compact view of route assignments, checked helpers and recent deliveries. ' +
    'Supply only the fields for the selected operation:\n' + contracts.map(item => contractText(item.operation, item.schema)).join('\n'),
    inputSchema: { type: 'object', properties, required: ['operation'], additionalProperties: false, oneOf: contracts.map(item => item.schema) } };
}
