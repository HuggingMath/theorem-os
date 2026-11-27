import { z } from 'zod';
import type { MathAgentToolDefinition } from '../runtime/agentSession';
import { agentTeamAllowanceSchema, agentTeamReserveSchema, agentTeamWorkKindSchema, agentTeamKnowledgeUseSchema } from './agentTeamState';
import { declarationSubmissionSchema } from './declarationArtifacts';
import { portfolioRouteIdSchema, routeRetirementSchema } from './routeControl';

type Json = Record<string, any>;
export type AgentTeamTransport = 'host-tools' | 'native-agent-control';
// Codex 0.171 drops the entire parameters object above this branch count.
const MAX_CODEX_ONEOF_BRANCHES = 16;
const nativeOperations = new Set(['finish', 'history', 'inspect', 'inspect-research', 'adopt', 'yield', 'submit', 'retire_route', 'route_summary']);

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
  z.object({ operation: z.literal('spawn'), agentId: id, message: text, routeId: portfolioRouteIdSchema.optional(), workKind: agentTeamWorkKindSchema.optional(), budget: agentTeamAllowanceSchema.optional() }).strict(),
  z.object({ operation: z.literal('assign'), agentId: id, message: text, routeId: portfolioRouteIdSchema.optional(), workKind: agentTeamWorkKindSchema.optional(), budget: agentTeamAllowanceSchema.optional() }).strict(),
  z.object({ operation: z.literal('amend'), agentId: id, taskId: z.string().min(1), message: text, reason: text,
    workKind: agentTeamWorkKindSchema.optional() }).strict(),
  z.object({ operation: z.literal('finish'), summary: text }).strict(),
  z.object({ operation: z.literal('progress'), objectiveRevision: z.number().int().positive(), kind: z.enum(['finding', 'probe', 'blocker', 'route']), summary: text,
    nextStep: text.optional(), evidenceRefs: z.array(z.string().min(1).max(2000)).max(16).optional(),
    knowledgeUses: z.array(agentTeamKnowledgeUseSchema).max(16).optional() }).strict(),
  z.object({ operation: z.literal('coordinate'), decision: z.enum(['defer', 'continue']), reason: text, nextStep: text }).strict(),
  z.object({ operation: z.literal('budget'), leadReserve: agentTeamReserveSchema.optional(), agentId: id.optional(),
    taskId: z.string().min(1).optional(), budget: agentTeamAllowanceSchema.optional() }).strict(),
  z.object({ operation: z.literal('yield'), reason: text }).strict(),
  z.object({ operation: z.literal('resume'), agentId: id, taskId: z.string().min(1) }).strict(),
  z.object({ operation: z.literal('history'), agentId: id.optional(), offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(8).optional() }).strict(),
  z.object({ operation: z.literal('publish'), summary: text }).strict(),
  z.object({ operation: z.literal('cancel'), agentId: id, taskId: z.string().min(1), reason: text.optional(), replacement: text.optional() }).strict(),
  z.object({ operation: z.literal('message'), agentId: id, message: text,
    relatedTaskId: z.string().min(1).optional(), researchRevision: z.number().int().positive().optional() }).strict(),
  z.object({ operation: z.literal('poll'), after: z.number().int().nonnegative().optional() }).strict(),
  z.object({ operation: z.literal('wait'), after: z.number().int().nonnegative(),
    timeoutMs: z.number().int().min(1).max(30000).optional() }).strict(),
  z.object({ operation: z.literal('inspect'), deliveryId: z.string().regex(/^[a-f0-9]{64}$/u),
    changeIndex: z.number().int().nonnegative().optional(), offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(16000).optional() }).strict(),
  z.object({ operation: z.literal('inspect-research'), artifactId: z.string().regex(/^[a-f0-9]{64}$/u),
    offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(16000).optional() }).strict(),
  submission,
  z.object({ operation: z.literal('adopt'), deliveryId: z.string().regex(/^[a-f0-9]{64}$/u), targetId: id.optional() }).strict(),
  z.object({ operation: z.literal('stop'), agentId: id }).strict(),
  routeRetirementSchema.extend({ operation: z.literal('retire_route') }),
  z.object({ operation: z.literal('route_summary'), routeId: portfolioRouteIdSchema.optional(),
    includeRetired: z.boolean().optional() }).strict(),
]);

export const agentTeamMemberOperations = new Set(['message', 'poll', 'wait', 'inspect', 'inspect-research', 'history', 'yield', 'submit', 'progress', 'route_summary']);

export function agentTeamMessageRouteFeedback(actor: string, recipient: string) {
  if (recipient !== actor) return;
  return { ok: false, error: 'math_team_message_self_addressed', from: actor, to: recipient,
    hint: `The host fixes the sender as "${actor}". agentId names the recipient, not the sender. ` +
      (actor === 'lead' ? 'Use the intended team member ID.' :
        'Use agentId: "lead" to report to Lead, or another team member ID for peer discussion.') };
}

function optionsFor(actor: string, budgetControlsEnabled: boolean, transport: AgentTeamTransport = 'host-tools') {
  return agentTeamRequestSchema.options.filter(option => (transport !== 'native-agent-control' || nativeOperations.has(option.shape.operation.value)) && (actor === 'lead'
    ? !['submit', 'yield', 'progress'].includes(option.shape.operation.value) && (budgetControlsEnabled || option.shape.operation.value !== 'budget')
    : agentTeamMemberOperations.has(option.shape.operation.value)));
}

export function agentTeamOperationAllowed(actor: string, budgetControlsEnabled: boolean, transport: AgentTeamTransport, operation: string) {
  return optionsFor(actor, budgetControlsEnabled, transport).some(option => option.shape.operation.value === operation);
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

function operationContracts(actor: string, budgetControlsEnabled: boolean, transport: AgentTeamTransport = 'host-tools') {
  // Historical host callers can still send coordinate explicitly.
  const advertised = optionsFor(actor, budgetControlsEnabled, transport).filter(option => option.shape.operation.value !== 'coordinate');
  return advertised.map(option => {
    const schema = fieldSchema(option);
    if (!budgetControlsEnabled) {
      delete schema.properties.budget;
      delete schema.properties.leadReserve;
    }
    if (transport === 'native-agent-control') {
      delete schema.properties.objectiveRevision;
      schema.required = schema.required.filter((key: string) => key !== 'objectiveRevision');
    }
    return { operation: option.shape.operation.value, schema };
  });
}

function contractText(operation: string, schema: Json): string {
  const required = (schema.required as string[]).filter(key => key !== 'operation');
  const optional = Object.keys(schema.properties).filter(key => key !== 'operation' && !required.includes(key));
  return `${operation}: required ${required.length ? required.join(', ') : 'none'}; optional ${optional.length ? optional.join(', ') : 'none'}; other fields forbidden.` +
    (operation === 'message' ? ' agentId is the recipient; sender is host-bound. Self-addressed messages are rejected.' :
      operation === 'inspect' ? ' For more source, pass a changeIndex from the overview and its nextOffset. offset and limit require changeIndex and count Unicode code points.' : '');
}

/** The same contracts drive advertised fields and corrective feedback. */
export function agentTeamArgumentFeedback(actor: string, budgetControlsEnabled: boolean, args: unknown, error: z.ZodError,
  transport: AgentTeamTransport = 'host-tools') {
  const operation = args && typeof args === 'object' && 'operation' in args ? (args as Json).operation : undefined;
  const contracts = operationContracts(actor, budgetControlsEnabled, transport);
  const contract = contracts.find(item => item.operation === operation);
  return { ok: false, error: 'math_team_arguments_invalid', detail: error.message,
    ...(contract ? { contract: contract.schema, hint: contractText(contract.operation, contract.schema) } : {
      allowedOperations: contracts.map(item => item.operation), hint: 'Choose an advertised operation for this caller.' }),
  };
}

/** Advertise required/allowed fields per operation, retaining the native single-entry interface. */
export function agentTeamToolDefinition(actor: string, budgetControlsEnabled: boolean,
  transport: AgentTeamTransport = 'host-tools'): MathAgentToolDefinition {
  const lead = actor === 'lead', native = transport === 'native-agent-control', contracts = operationContracts(actor, budgetControlsEnabled, transport);
  // Finite host Lead allowances also require a flat wire schema. All operations
  // retain their separate advertised contracts and strict host validation.
  const flat = (lead && budgetControlsEnabled && !native) || contracts.length > MAX_CODEX_ONEOF_BRANCHES;
  const properties: Json = {};
  for (const { schema } of contracts) Object.assign(properties, schema.properties);
  properties.operation = { type: 'string', enum: contracts.map(item => item.operation) };
  const purpose = native ? lead
    ? 'Mathematical host interface for the Lead. Native collaboration tools manage agent identities, spawning, followups, messages and interruption. Adopt rechecks a delivery in the saved consumer draft before merging. Inspect shows details on demand. Return with saved original proofs for independent checking. Finish requests early handoff. '
    : 'Mathematical host interface for a proof-writing member. Native collaboration tools deliver messages. Submit exact saved declarations, then return for stopped-writer checking. Yield preserves this task and draft for native followup after dependencies are integrated. '
    : lead
    ? 'Lead collaboration interface. Spawn and assign queue proof writers and return immediately. Amend changes the effective objective or workKind of a queued, running or paused task, retaining its identity, draft and revision history. Publish updates the shared advisory research summary. Inspect shows delivery details on demand. Return after requesting adoption into your workspace. Save original proofs and return for independent checking. Finish requests early handoff. Stop interrupts a member. '
    : 'Proof-writing member interface. Progress records a useful finding, local probe, blocker or route change against the supplied current objectiveRevision and notifies Lead. Optional knowledgeUses names a supplied source anchor (file#heading) actually used and its concrete application; a report remains advisory. Message Lead or peers to discuss results. Submit exact declarations once they answer the assignment; include objectiveRevision after an amendment, then return for host checking. The host also checkpoints before the next model request after submit/yield. Other original goals may remain open. Yield preserves the task and draft for later resume. ';
  return { name: 'theoremos_team', description: purpose +
    (native ? 'History pages complete business task text; inspect and inspect-research read fixed evidence. agentId/targetId refer to the workspace member IDs shown in team observations; native collaboration targets use canonical paths or thread IDs. ' :
      'Poll/wait receives the durable inbox, saved research and delivery references. History pages complete task text; inspect and inspect-research read fixed evidence. ' +
      `For message, the host fixes the sender as "${actor}"; agentId names the recipient. Self-addressed messages are rejected. `) +
    (native ? 'Configured limits apply to the shared run; this interface does not allocate task budgets. ' :
      lead && budgetControlsEnabled ? 'Budget controls allocate the configured finite run allowance. ' :
      lead ? 'This run has no token or turn budget; do not set task allowances or a Lead reserve. ' : '') +
    'Only the host publishes checked proof evidence; original proof acceptance remains independent. ' +
    (native ? 'Inspection and adoption retain peer-result provenance. ' :
      'WorkKind describes the deliverable: research, proof, independent-reconstruction, review or assembly. Inspection/adoption exposure is recorded and carried with later deliveries; this records reuse, not a guarantee of mathematical independence. ') +
    (lead ? 'Use retire_route to record a refutation and cancel all unfinished work tagged with that route. ' +
      (native ? 'For native spawn_agent or followup_task, put an optional Route: ROUTE_ID line first, then an optional Profiles: line of comma-separated IDs or slugs, then the assignment. ' :
        'For spawn/assign, use routeId to tag the route and select assignment profiles from the pinned Skill for the gap. ') :
      'Set helpersOnly:true on submit to share standalone helpers and keep the assignment open. The host makes checked helpers available to peers before their next turn. ' +
      (native ? '' : 'To report to Lead use agentId: "lead"; for peer discussion use the peer ID. ') + 'Submit omits agentId because the caller and task are already bound; each declaration supplies file, name and complete closed type. For a new auxiliary def or abbrev, also set kind to "definition"; submit theorems about it as separate declarations. ') +
    'Use route_summary for a compact view of route assignments, checked helpers and recent deliveries. ' +
    'Supply only the fields for the selected operation:\n' + contracts.map(item => contractText(item.operation, item.schema)).join('\n'),
    inputSchema: { type: 'object', properties, required: ['operation'], additionalProperties: false,
      ...(flat ? {} : { oneOf: contracts.map(item => item.schema) }) } };
}
