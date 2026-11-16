import { createParser } from 'eventsource-parser';
import { z } from 'zod';
import { admitResponsesRequest, RelayError, responseUsageObserver, type NativeRelayProtocol } from './formalizationRelay';
import { normalizeModelRequestUsage, type ModelRequestMissingReason, type ModelRequestReceipt } from './modelRequest';

export const sealedRoleProviderSchema = z.object({
  wireApi: z.enum(['responses', 'anthropic-messages', 'chat-completions']),
  baseUrl: z.string().url().max(4096), apiKeyEnvironment: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
}).strict();
export type SealedRoleProvider = z.infer<typeof sealedRoleProviderSchema>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const cache = z.object({ type: z.literal('ephemeral'), ttl: z.enum(['5m', '1h']).optional() }).strict();
const text = z.object({ type: z.literal('text'), text: z.string(), cache_control: cache.optional() }).strict();
const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/u);
const anthropicBlock = z.union([text,
  z.object({ type: z.literal('tool_use'), id: z.string(), name: toolName, input: z.record(z.unknown()),
    cache_control: cache.optional(), caller: z.object({ type: z.literal('direct') }).strict().optional() }).strict(),
  z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), is_error: z.boolean().optional(),
    content: z.union([z.string(), z.array(text)]).optional(), cache_control: cache.optional() }).strict(),
  z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string(), cache_control: cache.optional() }).strict(),
  z.object({ type: z.literal('redacted_thinking'), data: z.string(), cache_control: cache.optional() }).strict(),
]);
const anthropicRequest = z.object({
  model: z.string(), messages: z.array(z.object({ role: z.enum(['user', 'assistant']),
    content: z.union([z.string(), z.array(anthropicBlock)]) }).strict()),
  system: z.union([z.string(), z.array(text)]).optional(),
  tools: z.array(z.object({ name: toolName, description: z.string().optional(), input_schema: z.record(z.unknown()),
    cache_control: cache.optional(), strict: z.boolean().optional(), defer_loading: z.literal(false).optional() }).strict()).optional(),
  tool_choice: z.union([z.object({ type: z.enum(['auto', 'any', 'none']), disable_parallel_tool_use: z.boolean().optional() }).strict(),
    z.object({ type: z.literal('tool'), name: toolName, disable_parallel_tool_use: z.boolean().optional() }).strict()]).optional(),
  max_tokens: z.number().int().positive(), stream: z.boolean().optional(),
  thinking: z.union([z.object({ type: z.enum(['adaptive', 'disabled']) }).strict(),
    z.object({ type: z.literal('enabled'), budget_tokens: z.number().int().positive() }).strict()]).optional(),
  output_config: z.object({ effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    format: z.object({ type: z.literal('json_schema'), schema: z.record(z.unknown()) }).strict().optional() }).strict().optional(),
  metadata: z.object({ user_id: z.string().optional() }).strict().optional(),
  temperature: z.number().min(0).max(1).optional(), top_p: z.number().min(0).max(1).optional(), top_k: z.number().int().optional(),
  stop_sequences: z.array(z.string()).optional(), cache_control: cache.optional(),
  context_management: z.object({ edits: z.array(z.union([
    z.object({ type: z.literal('clear_thinking_20251015'), keep: z.union([z.literal('all'), z.object({ type: z.literal('thinking_turns'), value: z.number().int().nonnegative() }).strict()]).optional() }).strict(),
    z.object({ type: z.literal('clear_tool_uses_20250919'), trigger: z.object({ type: z.enum(['input_tokens', 'tool_uses']), value: z.number().int().positive() }).strict().optional(),
      keep: z.object({ type: z.literal('tool_uses'), value: z.number().int().nonnegative() }).strict().optional(),
      clear_at_least: z.object({ type: z.literal('input_tokens'), value: z.number().int().positive() }).strict().optional(),
      clear_tool_inputs: z.boolean().optional(), exclude_tools: z.array(toolName).optional() }).strict(),
  ])) }).strict().optional(),
}).strict();
const chatFunction = z.object({ name: toolName, description: z.string().optional(), parameters: z.record(z.unknown()),
  strict: z.boolean().optional() }).strict();
const chatRequest = z.object({
  model: z.string(), messages: z.array(z.object({ role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.null(), z.array(z.object({ type: z.literal('text'), text: z.string() }).strict())]),
    name: toolName.optional(), tool_call_id: z.string().optional(),
    tool_calls: z.array(z.object({ id: z.string(), type: z.literal('function'), function: z.object({ name: toolName, arguments: z.string() }).strict() }).strict()).optional(),
    reasoning_content: z.string().nullable().optional(),
  }).strict()),
  tools: z.array(z.object({ type: z.literal('function'), function: chatFunction }).strict()).optional(),
  tool_choice: z.union([z.enum(['auto', 'none', 'required']),
    z.object({ type: z.literal('function'), function: z.object({ name: toolName }).strict() }).strict()]).optional(),
  stream: z.boolean().optional(), stream_options: z.object({ include_usage: z.boolean() }).strict().optional(),
  reasoning_effort: z.string().optional(), store: z.literal(false).optional(),
  max_tokens: z.number().int().positive().optional(), max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().optional(), presence_penalty: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(), parallel_tool_calls: z.boolean().optional(),
  response_format: z.union([z.object({ type: z.literal('text') }).strict(), z.object({ type: z.literal('json_object') }).strict(),
    z.object({ type: z.literal('json_schema'), json_schema: z.object({ name: z.string(), strict: z.boolean().optional(), schema: z.record(z.unknown()) }).strict() }).strict()]).optional(),
  user: z.string().optional(), metadata: z.record(z.string()).optional(), seed: z.number().int().optional(),
}).strict();

/** Observe native inline Messages/Chat streams. Missing provider fields stay missing. */
function nativeUsageObserver(wire: 'anthropic-messages' | 'chat-completions', streaming: boolean): ReturnType<typeof responseUsageObserver> {
  let terminal = false, invalid = false, limited = false, size = 0;
  let fields: Record<string, unknown> = {}, providerRequestId: string | undefined;
  const chunks: Buffer[] = [], decoder = new TextDecoder('utf-8', { fatal: true });
  const inspect = (value: unknown) => {
    const event = object(value);
    if (wire === 'anthropic-messages') {
      const message = streaming && event.type === 'message_start' ? object(event.message) : event;
      if (typeof message.id === 'string') providerRequestId = message.id;
      if (streaming && event.type === 'message_start' || !streaming) fields = { ...fields, ...object(message.usage) };
      if (streaming && event.type === 'message_delta') fields = { ...fields, ...object(event.usage) };
      if (event.type === 'message_stop' || !streaming && message.type === 'message' && message.stop_reason) terminal = true;
      if (event.type === 'error') invalid = true;
    } else {
      if (typeof event.id === 'string') providerRequestId = event.id;
      if (event.usage) fields = object(event.usage);
      if (Array.isArray(event.choices) && event.choices.some(choice => object(choice).finish_reason)) terminal = true;
    }
  };
  const parser = createParser({ onEvent: event => {
    size = 0;
    if (event.data === '[DONE]') return;
    try { inspect(JSON.parse(event.data)); } catch { invalid = true; }
  }, onError: () => { invalid = true; } });
  return {
    accept(chunk) {
      if (limited) return;
      try {
        for (let offset = 0; offset < chunk.byteLength; offset += 32 * 1024) {
          const part = chunk.subarray(offset, offset + 32 * 1024); size += part.byteLength;
          if (size > 2 * 1024 * 1024) { limited = true; chunks.length = 0; return; }
          if (streaming) parser.feed(decoder.decode(part, { stream: true })); else chunks.push(Buffer.from(part));
        }
      } catch { invalid = true; }
    },
    finish(failure?: ModelRequestMissingReason): ModelRequestReceipt {
      try { if (!limited) { if (streaming) parser.feed(decoder.decode()); else inspect(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } }
      catch { invalid = true; }
      let usage: ModelRequestReceipt['usage'];
      if (wire === 'anthropic-messages') {
        if (count(fields.input_tokens) && count(fields.output_tokens) && count(fields.cache_creation_input_tokens) && count(fields.cache_read_input_tokens)) {
          const inputTokens = fields.input_tokens + fields.cache_creation_input_tokens + fields.cache_read_input_tokens;
          usage = normalizeModelRequestUsage({ inputTokens, outputTokens: fields.output_tokens,
            totalTokens: inputTokens + fields.output_tokens, cachedInputTokens: fields.cache_read_input_tokens });
        }
      } else usage = normalizeModelRequestUsage({ inputTokens: fields.prompt_tokens, outputTokens: fields.completion_tokens,
        totalTokens: fields.total_tokens, ...(object(fields.prompt_tokens_details).cached_tokens === undefined ? {} : { cachedInputTokens: object(fields.prompt_tokens_details).cached_tokens }),
        ...(object(fields.completion_tokens_details).reasoning_tokens === undefined ? {} : { reasoningOutputTokens: object(fields.completion_tokens_details).reasoning_tokens }) });
      const complete = terminal && !!usage && !invalid && !limited;
      return { usage, complete, providerRequestId, outcome: terminal ? 'completed' : failure === 'request-cancelled' ? 'cancelled' : 'failed',
        ...(!complete ? { missingReason: invalid ? 'provider-usage-invalid' : failure ?? (terminal ? 'provider-usage-missing' : 'response-not-terminal') } : {}) };
    },
    // Chat usage normally follows finish_reason, so wait for its final usage frame.
    get terminal() { return wire === 'anthropic-messages' ? terminal : terminal && !!fields.total_tokens; },
  };
}

export function sealedRoleProtocol(provider: SealedRoleProvider, model: string, effort: string): NativeRelayProtocol {
  const selected = sealedRoleProviderSchema.parse(provider), base = new URL(selected.baseUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
      base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
    throw new Error('math_sealed_provider_endpoint_invalid');
  const route = selected.wireApi === 'responses' ? '/v1/responses' : selected.wireApi === 'anthropic-messages' ? '/v1/messages' : '/v1/chat/completions';
  const suffix = route.slice('/v1'.length);
  const root = base.href.replace(/\/$/u, '').replace(/\/v1$/u, '');
  return { endpoint: root + '/v1' + suffix, envKey: selected.apiKeyEnvironment, wireApi: selected.wireApi,
    route, routes: selected.wireApi === 'anthropic-messages' ? [route, route + '?beta=true'] : [route],
    ...(selected.wireApi === 'anthropic-messages' ? { authHeader: 'x-api-key' as const,
      headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'interleaved-thinking-2025-05-14,effort-2025-11-24' } } : {}),
    admit(body) {
      if (body.model !== model) throw new RelayError(400, 'relay_model_mismatch');
      if (selected.wireApi === 'responses') {
        const normalized = { ...body, store: body.store ?? false };
        admitResponsesRequest(normalized, model, effort);
        return normalized;
      }
      const parsed = (selected.wireApi === 'anthropic-messages' ? anthropicRequest : chatRequest).safeParse(body);
      if (!parsed.success) throw new RelayError(400, 'unsupported_native_model_request');
      const reported = selected.wireApi === 'anthropic-messages' ? object(body.output_config).effort : body.reasoning_effort;
      if (reported !== effort && !(effort === 'none' && reported === undefined)) throw new RelayError(400, 'relay_effort_mismatch');
      const tools = new Set((Array.isArray(body.tools) ? body.tools : []).map(tool => selected.wireApi === 'anthropic-messages'
        ? object(tool).name : object(object(tool).function).name));
      if (tools.size !== (Array.isArray(body.tools) ? body.tools.length : 0)) throw new RelayError(400, 'duplicate_tool_name');
      const choice = object(body.tool_choice);
      if (choice.type === 'tool' && !tools.has(choice.name) || choice.type === 'function' && !tools.has(object(choice.function).name))
        throw new RelayError(400, 'unknown_tool_choice');
      return selected.wireApi === 'chat-completions' ? { ...body, store: false } : body;
    },
    observe: streaming => selected.wireApi === 'responses' ? responseUsageObserver(streaming) : nativeUsageObserver(selected.wireApi, streaming),
  };
}
