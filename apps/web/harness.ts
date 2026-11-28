import fs from 'node:fs';
import path from 'node:path';
import { canonicalMathJson, mathDigest, readMathJson, writeMathJsonDurable } from '../../src/math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../../src/math/paths';
import type { MathAgentOptions, MathAgentSession } from '../../src/runtime/agentSession';
import { bindResearchHarness, assertResearchHarnessCurrent, type ResearchHarnessIdentity } from '../../src/runtime/researchHarness';
import { cliConfigurationSchema, readCliConfiguration } from '../../src/runtime/cliConfiguration';
import type { WebProvider, WebRunInput, WebWorkerProvider } from './shared';

const webCliConfiguration = (provider: WebWorkerProvider) => provider.execution?.cli
  ? cliConfigurationSchema.parse(provider.execution.cli) : undefined;

/** Only the operator's provider declaration chooses a command; browser input never supplies argv or local paths. */
export const webProviderHarness = (provider: WebProvider) => provider.harness ?? 'codex';
export function publicWebProvider(provider: WebProvider): WebProvider {
  return { id: provider.id, name: provider.name, baseUrl: provider.baseUrl,
    ...(provider.harness ? { harness: provider.harness } : {}),
    ...(provider.harness === 'cli' && 'execution' in provider ? { efforts: webCliConfiguration(provider as WebWorkerProvider)?.efforts
      .filter(effort => ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) as WebRunInput['effort'][] } : {}) };
}
export function webProviderExecutionDigest(provider: WebWorkerProvider): string {
  return mathDigest(canonicalMathJson({ harness: webProviderHarness(provider), execution: provider.execution ?? null,
    baseUrl: provider.baseUrl }));
}
export function webHarnessExecutable(provider: WebWorkerProvider): string {
  const id = webProviderHarness(provider);
  return provider.execution?.executable ?? (id === 'cli' ? webCliConfiguration(provider)?.executable ?? '' :
    id === 'claude-code' ? 'claude' : id);
}
/** Web model names belong to the selected provider; OpenCode additionally needs its local provider namespace. */
export const webHarnessModel = (provider: WebProvider, model: string) => webProviderHarness(provider) === 'opencode' ? `web/${model}` : model;

export function webHarnessEnvironment(provider: WebWorkerProvider, apiKey: string): NodeJS.ProcessEnv {
  switch (webProviderHarness(provider)) {
    case 'codex': return { THEOREMOS_PROVIDER_API_KEY: apiKey };
    case 'claude-code': return { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_BASE_URL: provider.baseUrl.replace(/\/v1\/?$/u, '') };
    case 'opencode': return { OPENAI_API_KEY: apiKey };
    case 'cli': return { [provider.execution?.apiKeyEnvironment ?? 'OPENAI_API_KEY']: apiKey,
      [provider.execution?.baseUrlEnvironment ?? 'OPENAI_BASE_URL']: provider.baseUrl };
  }
}

/** New dedicated profiles contain generated launch settings only, never a machine's authentication/session files. */
export function prepareWebNativeProfile(profile: string, provider: WebWorkerProvider,
  input: Pick<WebRunInput, 'model' | 'effort'>): void {
  fs.mkdirSync(profile, { mode: 0o700 });
  const write = (file: string, text: string) => fs.writeFileSync(path.join(profile, file), text, { mode: 0o600, flag: 'wx' });
  switch (webProviderHarness(provider)) {
    case 'codex': throw new Error('web_codex_profile_requires_provider_configuration');
    case 'claude-code': write('settings.json', '{}'); return;
    case 'opencode': write('opencode.json', JSON.stringify({ provider: { web: { name: provider.name,
      npm: '@ai-sdk/openai', options: { baseURL: provider.baseUrl, apiKey: '{env:OPENAI_API_KEY}' },
      models: { [input.model]: { name: input.model, variants: { [input.effort]: { reasoningEffort: input.effort } } } },
    } } })); return;
    case 'cli': {
      const configuration = webCliConfiguration(provider);
      if (!configuration) throw new Error('web_cli_configuration_missing');
      for (const [file, text] of Object.entries(provider.execution?.files ?? {})) {
        const target = path.resolve(profile, file);
        if (path.isAbsolute(file) || !target.startsWith(profile + path.sep) || file.split(/[\\/]/u).some(part => !part || part === '.' || part === '..') || file === 'cli.json')
          throw new Error('web_cli_configuration_path_invalid');
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); write(file, text);
      }
      write('cli.json', JSON.stringify(configuration));
      const actual = readCliConfiguration(profile);
      const key = provider.execution?.apiKeyEnvironment ?? 'OPENAI_API_KEY';
      const base = provider.execution?.baseUrlEnvironment ?? 'OPENAI_BASE_URL';
      if (!actual.inheritEnvironment.includes(key) || !actual.inheritEnvironment.includes(base) ||
          Object.hasOwn(actual.environment, key) || Object.hasOwn(actual.environment, base))
        throw new Error('web_cli_provider_environment_unbound');
      if (!actual.efforts.includes(input.effort)) throw new Error('math_cli_effort_unsupported');
      return;
    }
  }
}

type BoundProfile = { profile: string; identity: ResearchHarnessIdentity; assertCurrent(): void };
/** Each writer gets separate native mutable state; its immutable settings and executable remain frozen. */
export function bindWebWorkerProfile(options: MathAgentOptions, provider: WebWorkerProvider): BoundProfile {
  const id = webProviderHarness(provider), parent = fs.realpathSync(options.profile);
  const environment = { ...options.environment, ...webHarnessEnvironment(provider, '') };
  // Binding ignores credential values, but includes endpoint environment identity.
  const rootIdentity = bindResearchHarness(id, options.executable, parent, environment, options.model);
  const name = mathDigest(options.workspace).slice(0, 32), directory = path.join(path.dirname(parent), 'native-sessions');
  assertMathCanonicalPath(directory); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const profile = path.join(directory, name), bindingFile = path.join(directory, name + '.binding.json');
  assertMathCanonicalPath(profile); assertMathCanonicalPath(bindingFile);
  if (!fs.existsSync(bindingFile)) {
    // No binding means no session ever used this profile; discard a copy left by an interrupted initialization.
    fs.rmSync(profile, { recursive: true, force: true });
    fs.mkdirSync(profile, { mode: 0o700 });
    const names = id === 'claude-code' ? ['settings.json'] : id === 'opencode' ? ['opencode.json'] :
      ['cli.json', ...readCliConfiguration(parent).configurationFiles];
    for (const file of names) {
      fs.mkdirSync(path.dirname(path.join(profile, file)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(profile, file), fs.readFileSync(path.join(parent, file)), { mode: 0o600, flag: 'wx' });
    }
    const identity = bindResearchHarness(id, options.executable, profile, environment, options.model);
    writeMathJsonDurable(bindingFile, { rootIdentity, identity });
  }
  const saved = readMathJson(bindingFile) as { rootIdentity: ResearchHarnessIdentity; identity: ResearchHarnessIdentity };
  if (canonicalMathJson(saved.rootIdentity) !== canonicalMathJson(rootIdentity) || saved.identity.profile !== profile)
    throw new Error('math_harness_identity_changed');
  const snapshot = canonicalMathJson(saved);
  const assertCurrent = () => {
    if (canonicalMathJson(readMathJson(bindingFile)) !== snapshot) throw new Error('math_harness_identity_changed');
    assertResearchHarnessCurrent(rootIdentity, environment, options.model);
    assertResearchHarnessCurrent(saved.identity, environment, options.model);
  };
  assertCurrent();
  return { profile, identity: saved.identity, assertCurrent };
}

/** Keep configuration changes from being accepted after native execution or writer shutdown. */
export function pinWebWorkerSession(session: MathAgentSession, binding: BoundProfile): MathAgentSession {
  const run = session.run, close = session.close, stop = session.stopForFreeze;
  session.run = async (...args) => { binding.assertCurrent(); const result = await run(...args); binding.assertCurrent(); return result; };
  session.close = async () => { await close(); binding.assertCurrent(); };
  if (stop) session.stopForFreeze = async () => { const result = await stop(); binding.assertCurrent(); return result; };
  const receipt = Object.getOwnPropertyDescriptor(session, 'isolationReceipt');
  Object.defineProperty(session, 'isolationReceipt', { enumerable: true, configurable: true, get: () => ({
    ...(receipt?.get ? receipt.get.call(session) : receipt?.value), harnessIdentity: binding.identity,
  }) });
  return session;
}

export function webHarnessResearchError(provider: WebWorkerProvider, input: Pick<WebRunInput, 'effort' | 'researchMode' | 'skillLoading'>): string | undefined {
  const id = webProviderHarness(provider);
  if (id !== 'codex' && (input.researchMode !== 'skill' || input.skillLoading === 'native'))
    return '当前执行器需要读取固定文件的 Skill 研究方式。';
  if (id === 'cli' ? !webCliConfiguration(provider)?.efforts.includes(input.effort) : input.effort === 'none')
    return '当前执行器不支持所选推理强度。';
}
