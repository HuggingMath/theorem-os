import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import type { MathAgentOptions } from './agentSession';
import { readCliConfiguration } from './cliConfiguration';
import { prepareFormalizationSandbox, type SealedRuntimeProjection } from './formalizationSandbox';
import { sealedRoleProtocol, type SealedRoleProvider } from './sealedRoleProtocol';
import type { ModelRequestGate, ModelRequestUsage } from './modelRequest';
import { mathDigest } from '../math/mathRuntimeIo';

const CAPABILITY = '__ROLE_MODEL_CAPABILITY__';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
type Runtime = NonNullable<ReturnType<typeof readCliConfiguration>['sealedRole']>['runtime'];

function resolveExecutable(value: string, env: NodeJS.ProcessEnv): string {
  const candidate = path.isAbsolute(value) ? value : (env.PATH ?? process.env.PATH ?? '').split(path.delimiter)
    .filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, value)).find(file => fs.existsSync(file));
  if (!candidate) throw new Error('math_sealed_executable_unavailable');
  const canonical = fs.realpathSync(candidate); assertMathCanonicalPath(canonical);
  if (!fs.statSync(canonical).isFile()) throw new Error('math_sealed_executable_invalid');
  return canonical;
}

/** Explicit resources are individual code/data files under /opt/harness/resources.
 * No host directory, profile, source tree or global credential store is mounted. */
function runtimeProjection(executable: string, env: NodeJS.ProcessEnv, runtime?: Runtime): Pick<SealedRuntimeProjection,
  'executable' | 'command' | 'prefixArgs' | 'mounts'> {
  const original = resolveExecutable(executable, env), command = '/opt/harness/bin/agent';
  const mounts = (runtime?.resources ?? []).map(resource => {
    assertMathCanonicalPath(resource.source);
    const source = fs.realpathSync(resource.source), target = path.posix.normalize(resource.target);
    if (!fs.statSync(source).isFile() || !path.posix.isAbsolute(resource.target) || resource.target !== target ||
        !target.startsWith('/opt/harness/resources/') || target.includes('\0'))
      throw new Error('math_sealed_runtime_resource_invalid');
    return { source, target };
  });
  if (new Set(mounts.map(mount => mount.target)).size !== mounts.length) throw new Error('math_sealed_runtime_resource_invalid');
  if (!runtime?.interpreter) return { executable: original, command, mounts };
  const interpreter = resolveExecutable(runtime.interpreter, env), script = '/opt/harness/resources/entrypoint';
  if (mounts.some(mount => mount.target === script)) throw new Error('math_sealed_runtime_resource_invalid');
  return { executable: interpreter, command, prefixArgs: [script], mounts: [{ source: original, target: script }, ...mounts] };
}

/** Added only for explicitly configured sealed runtimes; historical launch digests stay unchanged. */
export function sealedRuntimeIdentity(executable: string, environment: NodeJS.ProcessEnv, runtime: Runtime) {
  const projection = runtimeProjection(executable, environment, runtime);
  return { executable: projection.executable, executableSha256: mathDigest(fs.readFileSync(projection.executable)),
    resources: (projection.mounts ?? []).map(mount => ({ source: mount.source, target: mount.target, sha256: mathDigest(fs.readFileSync(mount.source)) })) };
}

function valueFromEnvironment(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof value !== 'string') return;
  const reference = value.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/u);
  if (reference) return env[reference[1]];
  if (value.includes('{env:') || value.includes('{file:')) throw new Error('math_sealed_provider_reference_invalid');
  return value;
}

/** Return a native OpenCode provider whose only network authority is this role relay. */
export function sealedOpenCodeProvider(options: MathAgentOptions): {
  provider: Record<string, unknown>; relayProvider: SealedRoleProvider; wireModel: string; environment: NodeJS.ProcessEnv;
} {
  const [providerID, ...parts] = options.model.split('/'), modelID = parts.join('/');
  const configured = object(JSON.parse(fs.readFileSync(path.join(options.profile, 'opencode.json'), 'utf8')));
  const original = object(object(configured.provider)[providerID]), nativeOptions = object(original.options);
  const env = options.environment ?? process.env, selected = object(object(original.models)[modelID]);
  const npm = original.npm;
  const wireApi = npm === '@ai-sdk/anthropic' ? 'anthropic-messages' : npm === '@ai-sdk/openai' ? 'responses'
    : npm === '@ai-sdk/openai-compatible' ? 'chat-completions' : undefined;
  if (!wireApi || !modelID) throw new Error('math_sealed_opencode_provider_unsupported');
  const defaultBase = wireApi === 'anthropic-messages' ? env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'
    : env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const baseUrl = valueFromEnvironment(nativeOptions.baseURL, env) ?? defaultBase;
  const key = valueFromEnvironment(nativeOptions.apiKey, env) ?? env[wireApi === 'anthropic-messages' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'];
  if (!key) throw new Error('math_sealed_provider_credential_unavailable');
  const wireModel = typeof selected.id === 'string' ? selected.id : modelID;
  const variant = wireApi === 'anthropic-messages' ? { effort: options.effort, thinking: { type: 'adaptive' } }
    : { reasoningEffort: options.effort };
  const model = { id: wireModel, name: typeof selected.name === 'string' ? selected.name : modelID,
    reasoning: true, tool_call: true, attachment: false,
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 200_000, output: 16_000 }, variants: { [options.effort]: variant }, options: variant };
  return { wireModel, relayProvider: { wireApi, baseUrl, apiKeyEnvironment: 'THEOREMOS_SEALED_HOST_KEY' },
    environment: { ...env, THEOREMOS_SEALED_HOST_KEY: key },
    provider: { npm, name: 'Isolated role model relay', options: { baseURL: 'http://127.0.0.1:18888/v1',
      apiKey: '{env:FORMALIZATION_RELAY_CAPABILITY}' }, models: { [modelID]: model } } };
}

export async function prepareSealedHarness(harness: 'claude-code' | 'opencode' | 'cli', options: MathAgentOptions,
  settings: { environment?: Record<string, string>; controlPort?: number;
    openCode?: ReturnType<typeof sealedOpenCodeProvider> } = {}) {
  if (!options.readIsolation) throw new Error('math_sealed_role_configuration_required');
  if (options.skills?.length) throw new Error(`math_${harness === 'claude-code' ? 'claude' : harness}_skill_read_isolation_unsupported`);
  let env = options.environment ?? process.env;
  let provider: SealedRoleProvider, wireModel = options.model, runtime: Runtime = undefined;
  let projected: Record<string, string>, profileFiles: Record<string, string>;
  if (harness === 'claude-code') {
    const envKey = env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : env.ANTHROPIC_AUTH_TOKEN ? 'ANTHROPIC_AUTH_TOKEN' : undefined;
    if (!envKey) throw new Error('math_sealed_provider_credential_unavailable');
    provider = { wireApi: 'anthropic-messages', baseUrl: env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com', apiKeyEnvironment: envKey };
    projected = { CLAUDE_CONFIG_DIR: '/profile', ANTHROPIC_BASE_URL: 'http://127.0.0.1:18888', ANTHROPIC_API_KEY: CAPABILITY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_SAFE_MODE: '1', CLAUDE_CODE_MAX_RETRIES: '0' };
    profileFiles = { 'settings.json': '{"disableAllHooks":true,"enabledPlugins":{},"autoMemoryEnabled":false}' };
  } else if (harness === 'opencode') {
    const selected = settings.openCode ?? sealedOpenCodeProvider(options);
    provider = selected.relayProvider; env = selected.environment; wireModel = selected.wireModel;
    projected = { ...settings.environment }; profileFiles = { 'opencode.json': projected.OPENCODE_CONFIG_CONTENT ?? '{}' };
  } else {
    const config = readCliConfiguration(options.profile), selected = config.sealedRole;
    if (!selected) throw new Error('math_cli_sealed_role_configuration_required');
    provider = selected.provider; runtime = selected.runtime;
    if (selected.client.baseUrlEnvironment === selected.client.apiKeyEnvironment ||
        [selected.client.baseUrlEnvironment, selected.client.apiKeyEnvironment].some(name =>
          /^(?:HOME|PATH|TMPDIR|TMP|TEMP|XDG_.+|LEAN_.+|LAKE_.+|ELAN_.+|FORMALIZATION_.+)$/u.test(name)))
      throw new Error('math_cli_sealed_client_environment_invalid');
    // Constants/templates chosen for the role can enter; ambient inherited variables cannot.
    projected = { ...settings.environment,
      [selected.client.baseUrlEnvironment]: 'http://127.0.0.1:18888/v1', [selected.client.apiKeyEnvironment]: CAPABILITY };
    if (Object.keys(projected).some(name => /^(?:HOME|PATH|TMPDIR|TMP|TEMP|XDG_.+|LEAN_.+|LAKE_.+|ELAN_.+|FORMALIZATION_.+)$/u.test(name)))
      throw new Error('math_cli_sealed_client_environment_invalid');
    // Sealed profiles use role-specific templates, never copies of native host settings/auth.
    profileFiles = Object.fromEntries(Object.entries(selected.profileFiles).map(([name, contents]) => [name,
      contents.replaceAll('{profile}', '/profile').replaceAll('{workspace}', '/workspace')
        .replaceAll('{relayBaseUrl}', 'http://127.0.0.1:18888/v1').replaceAll('{relayCapability}', CAPABILITY)]));
  }
  const hostCredential = env[provider.apiKeyEnvironment];
  if (!hostCredential || [...Object.values(projected), ...Object.values(profileFiles)].some(value => value.includes(hostCredential)))
    throw new Error('math_sealed_credential_projection_forbidden');
  const relay = sealedRoleProtocol(provider, wireModel, options.effort);
  const protocol = harness === 'claude-code' && provider.apiKeyEnvironment === 'ANTHROPIC_AUTH_TOKEN'
    ? { ...relay, upstreamAuthHeader: 'authorization' as const } : relay;
  const projection = runtimeProjection(options.executable, env, runtime);
  const totals: ModelRequestUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const receiptGate: ModelRequestGate = () => ({ allowed: true, settle(receipt) {
    if (!receipt.usage) return;
    for (const name of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningOutputTokens'] as const) {
      const value = receipt.usage[name];
      if (value !== undefined) totals[name] = (totals[name] ?? 0) + value;
    }
    options.onUsage({ ...totals });
  } });
  return prepareFormalizationSandbox({ workspace: options.workspace, profile: options.profile, executable: options.executable,
    model: wireModel, effort: options.effort, environment: options.readIsolation.environment, env,
    packages: options.readIsolation.packages, library: options.readIsolation.library, signal: options.signal,
    outputSchema: options.outputSchema, requestGate: options.requestGate ?? receiptGate, onUsageIncomplete: options.onUsageIncomplete,
    runtime: { harness, ...projection, environment: projected, profileFiles, relay: protocol, controlPort: settings.controlPort } });
}

/** Paths embedded in host prompts refer only to their role projection. */
export function sealedRoleText(text: string, options: Pick<MathAgentOptions, 'workspace' | 'profile'>): string {
  return text.replaceAll(path.resolve(options.workspace), '/workspace').replaceAll(path.resolve(options.profile), '/profile');
}
export function sealedRolePath(file: string, workspace: string): string {
  if (!isMathPathWithin(workspace, file)) throw new Error('math_sealed_output_outside_role');
  return '/workspace/' + path.relative(workspace, file).split(path.sep).join('/');
}

/** Host control reaches only the private native server, through one role-owned socket. */
export async function sealedControlFetch(socketPath: string, url: string, init: RequestInit = {}): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const selected = new URL(url);
    const requestHeaders: Record<string, string> = { host: selected.host };
    new Headers(init.headers).forEach((value, name) => { requestHeaders[name] = value; });
    const request = http.request({ socketPath, path: selected.pathname + selected.search, method: init.method ?? 'GET',
      headers: requestHeaders, signal: init.signal ?? undefined }, incoming => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const status = incoming.statusCode ?? 502;
      const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status, headers }));
    });
    request.once('error', reject);
    request.end(init.body ?? undefined);
  });
}
