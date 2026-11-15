import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { readMathText } from '../math/mathRuntimeIo';

const pointer = z.string().max(512).refine(value => value === '' || value.startsWith('/') && !/~[^01]|~$/u.test(value));
const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const argument = z.string().max(32_768).refine(value => !value.includes('\0'));
const arguments_ = z.array(argument).max(128);
const equality = z.object({ field: pointer, value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict();
const when = z.union([equality, z.array(equality).min(1).max(8)]);
const field = z.object({ field: pointer, when: when.optional() }).strict();
const failure = z.object({ when, reason: z.enum(['authentication', 'context', 'rate-limit', 'request', 'invalid-request']) }).strict();
const structuredOutput = {
  text: field.extend({ mode: z.enum(['append', 'replace']).default('replace') }).optional(),
  sessionId: field.optional(),
  usage: z.object({ when: when.optional(), inputTokens: pointer, outputTokens: pointer,
    cachedInputTokens: pointer.optional(), reasoningOutputTokens: pointer.optional(), lastInputTokens: pointer.optional(),
    scope: z.enum(['turn', 'session']).default('turn'),
    completeness: z.enum(['complete', 'partial']).default('partial') }).strict().optional(),
  failures: z.array(failure).max(16).optional(),
};
const session = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fresh') }).strict(),
  z.object({ mode: z.literal('generated'), startArgs: arguments_, resumeArgs: arguments_ }).strict(),
  z.object({ mode: z.literal('reported'), startArgs: arguments_, resumeArgs: arguments_ }).strict(),
]);

export const cliConfigurationSchema = z.object({
  schema: z.literal('theorem-os.cli-harness.v1'), executable: z.string().min(1).max(4096),
  args: arguments_.default([]), prompt: z.enum(['stdin', 'file', 'argument']).default('stdin'),
  session: session.default({ mode: 'fresh' }),
  output: z.discriminatedUnion('format', [z.object({ format: z.literal('text') }).strict(),
    z.object({ format: z.literal('json'), ...structuredOutput }).strict(),
    z.object({ format: z.literal('jsonl'), ...structuredOutput }).strict()]).default({ format: 'text' }),
  efforts: z.array(z.string().min(1).max(32)).min(1).max(16).default(['none']),
  environment: z.record(environmentName, argument).default({}),
  inheritEnvironment: z.array(environmentName).max(64).default([]),
  configurationFiles: z.array(z.string().min(1).max(4096)).max(64).default([]),
}).strict();

export type CliConfiguration = z.infer<typeof cliConfigurationSchema>;
export type CliField = z.infer<typeof field>;
export type CliFailureReason = z.infer<typeof failure>['reason'];
export const CLI_CONFIGURATION_FILE = 'cli.json';
export const CLI_PLACEHOLDERS = ['model', 'effort', 'profile', 'workspace', 'prompt', 'promptFile', 'sessionId', 'turnId'] as const;
export type CliTemplateValues = Record<typeof CLI_PLACEHOLDERS[number], string>;

/** Declarative argv/field mapping only. No shell interpolation, code loading or workflow language. */
export function readCliConfiguration(profile: string): CliConfiguration {
  const file = path.join(profile, CLI_CONFIGURATION_FILE);
  assertMathCanonicalPath(file);
  let value: unknown;
  try { value = JSON.parse(readMathText(file)); } catch { throw new Error('math_cli_configuration_invalid'); }
  const parsed = cliConfigurationSchema.safeParse(value);
  if (!parsed.success) throw new Error('math_cli_configuration_invalid');
  const config = parsed.data;
  const common = [...config.args, ...Object.values(config.environment)];
  const commands = config.session.mode === 'fresh' ? [common] :
    [[...common, ...config.session.startArgs], [...common, ...config.session.resumeArgs]];
  const launch = commands.flat();
  for (const template of launch) for (const match of template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu))
    if (!CLI_PLACEHOLDERS.includes(match[1] as typeof CLI_PLACEHOLDERS[number])) throw new Error('math_cli_placeholder_unsupported');
  if (commands.some(command => !command.some(value => value.includes('{model}')))) throw new Error('math_cli_model_binding_missing');
  if (config.efforts.some(value => value !== 'none') && commands.some(command => !command.some(value => value.includes('{effort}'))))
    throw new Error('math_cli_effort_binding_missing');
  if (config.prompt === 'argument' && commands.some(command => !command.some(value => value.includes('{prompt}'))) ||
      config.prompt === 'file' && commands.some(command => !command.some(value => value.includes('{promptFile}'))) ||
      config.prompt !== 'argument' && launch.some(value => value.includes('{prompt}')) ||
      config.prompt !== 'file' && launch.some(value => value.includes('{promptFile}')))
    throw new Error('math_cli_prompt_binding_invalid');
  if (config.session.mode !== 'fresh') {
    if (!config.session.resumeArgs.some(value => value.includes('{sessionId}')) ||
        config.session.mode === 'generated' && !config.session.startArgs.some(value => value.includes('{sessionId}')) ||
        config.session.mode === 'reported' && (config.output.format === 'text' || !config.output.sessionId))
      throw new Error('math_cli_resume_binding_invalid');
  }
  if (config.session.mode === 'fresh' && launch.some(value => value.includes('{sessionId}')))
    throw new Error('math_cli_resume_binding_invalid');
  if (config.session.mode === 'fresh' && config.output.format !== 'text' && config.output.usage?.scope === 'session')
    throw new Error('math_cli_usage_scope_invalid');
  for (const name of [...Object.keys(config.environment), ...config.inheritEnvironment])
    if (/^(?:TMPDIR|TMP|TEMP|XDG_.+|DEEPSCIENTIST_.+|THEOREMOS_.+)$/u.test(name))
      throw new Error('math_cli_runtime_environment_reserved');
  if (config.inheritEnvironment.some(name => /^(?:HOME|PATH|ELAN_HOME|LAKE_HOME|LEAN_.+)$/u.test(name)))
    throw new Error('math_cli_runtime_environment_reserved');
  for (const name of config.configurationFiles) {
    const selected = path.resolve(profile, name);
    if (path.isAbsolute(name) || !isMathPathWithin(profile, selected) || selected === profile ||
        name.split(/[\\/]/u).includes('..')) throw new Error('math_cli_configuration_path_invalid');
    assertMathCanonicalPath(selected);
    if (!fs.statSync(selected).isFile()) throw new Error('math_cli_configuration_path_invalid');
  }
  return config;
}

export function expandCliTemplate(template: string, values: CliTemplateValues): string {
  return template.replace(/\{(model|effort|profile|workspace|prompt|promptFile|sessionId|turnId)\}/gu,
    (_match, name: keyof CliTemplateValues) => values[name]);
}

/** RFC 6901 JSON Pointer; never evaluates expressions or follows inherited properties. */
export function cliFieldValue(value: unknown, field: string): unknown {
  if (field === '') return value;
  let current = value;
  for (const part of field.slice(1).split('/').map(item => item.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function cliFieldMatches(value: unknown, rule: { when?: z.infer<typeof when> }): boolean {
  if (!rule.when) return true;
  const conditions = Array.isArray(rule.when) ? rule.when : [rule.when];
  return conditions.every(condition => cliFieldValue(value, condition.field) === condition.value);
}
