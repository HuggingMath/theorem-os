import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mathDigest, canonicalMathJson, mathFileIdentity } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import type { MathAgentHarnessId } from './agentSession';
import { createCodexMathSession } from './codexSession';
import { createClaudeCodeMathSession } from './claudeCodeSession';
import { createOpenCodeMathSession } from './openCodeSession';
import { createCliMathSession } from './cliSession';
import { readCliConfiguration, CLI_CONFIGURATION_FILE } from './cliConfiguration';
import { sealedRuntimeIdentity } from './sealedHarness';
export { planMathAgentSession } from './agentSessionPlan';

export type ResearchHarnessIdentity = {
  id: MathAgentHarnessId;
  executable: string;
  executableDigest: string;
  profile: string;
  configurationDigest: string;
};

const secretKey = /API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY/iu;

const executableDigests = new Map<string, { stamp: string; digest: string }>();

function executableDigest(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const start = fs.fstatSync(fd, { bigint: true });
    if (!start.isFile()) throw new Error('math_harness_identity_changed');
    // Match both the inode and change time so replacement and same-size rewrites invalidate the digest.
    const stamp = mathFileIdentity(start);
    const cached = executableDigests.get(file);
    if (cached?.stamp === stamp) return cached.digest;
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes: number;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    if (mathFileIdentity(fs.fstatSync(fd, { bigint: true })) !== stamp ||
        mathFileIdentity(fs.statSync(file, { bigint: true })) !== stamp) throw new Error('math_harness_identity_changed');
    const digest = hash.digest('hex');
    executableDigests.set(file, { stamp, digest });
    return digest;
  } finally { fs.closeSync(fd); }
}

/** Native OpenCode expands these references after reading OPENCODE_CONFIG_CONTENT. */
function openCodeEnvironmentReferences(profile: string, model?: string): string[] {
  const configured = JSON.parse(fs.readFileSync(path.join(profile, 'opencode.json'), 'utf8')) as { provider?: Record<string, unknown> };
  const provider = configured.provider ?? {};
  const text = JSON.stringify(model ? provider[model.split('/')[0]] ?? {} : provider);
  if (/\{file:[^}]*\}/u.test(text)) throw new Error('math_opencode_file_configuration_unsupported');
  const names = [...new Set([...text.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu)].map(match => match[1]))].sort();
  if (names.some(name => /^(?:TMPDIR|TMP|TEMP|XDG_.+|OPENCODE_.+|CLAUDE_.+)$/u.test(name)))
    throw new Error('math_harness_runtime_environment_reference_unsupported');
  return names;
}

/** Native adapters and an ordinary headless command share the solver's acceptance contract. */
export function researchHarness(id: string) {
  switch (id) {
    case 'codex': return { id, open: createCodexMathSession, nativeSkills: true } as const;
    case 'claude-code': return { id, open: createClaudeCodeMathSession, nativeSkills: false } as const;
    case 'opencode': return { id, open: createOpenCodeMathSession, nativeSkills: false } as const;
    case 'cli': return { id, open: createCliMathSession, nativeSkills: false } as const;
    default: throw new Error('invalid --harness');
  }
}

/** Pin executable and explicit provider/settings files, excluding mutable sessions and authentication. */
export function bindResearchHarness(id: ResearchHarnessIdentity['id'], command: string, profile: string,
  environment: NodeJS.ProcessEnv = process.env, model?: string): ResearchHarnessIdentity {
  const candidates = path.isAbsolute(command) ? [command] : command.includes(path.sep) ? [path.resolve(command)] :
    (environment.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, command));
  const executable = candidates.find(file => {
    try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); } catch { return false; }
  });
  if (!executable) throw new Error(`math_harness_executable_unavailable:${id}`);
  const binary = fs.realpathSync(executable);
  assertMathCanonicalPath(profile);
  if (!fs.statSync(profile).isDirectory()) throw new Error('math_harness_profile_invalid');
  const cli = id === 'cli' ? readCliConfiguration(profile) : undefined;
  const names = id === 'codex' ? ['config.toml'] : id === 'claude-code' ? ['settings.json'] :
    cli ? [CLI_CONFIGURATION_FILE, ...cli.configurationFiles] : ['opencode.json'];
  const configuration = names.map(name => {
    const file = path.join(profile, name);
    assertMathCanonicalPath(file);
    return { name, sha256: fs.existsSync(file) ? mathDigest(fs.readFileSync(file)) : null };
  });
  const endpoints = cli ? cli.inheritEnvironment.filter(key => key !== cli.sealedRole?.provider.apiKeyEnvironment && !secretKey.test(key)) : id === 'codex' ? [] : id === 'claude-code' ? ['ANTHROPIC_BASE_URL'] :
    [...new Set(['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', ...openCodeEnvironmentReferences(profile, model).filter(key => !secretKey.test(key))])];
  return { id, executable: binary, executableDigest: executableDigest(binary), profile,
    configurationDigest: mathDigest(canonicalMathJson({ configuration,
      endpoints: Object.fromEntries(endpoints.map(key => [key, environment[key] ?? null])),
      ...(cli?.sealedRole?.runtime ? { sealedRuntime: sealedRuntimeIdentity(binary, environment, cli.sealedRole.runtime) } : {}) })) };
}

/** Native state is writable, so validate immutable launch inputs on every dispatch and freeze. */
export function assertResearchHarnessCurrent(identity: ResearchHarnessIdentity, environment: NodeJS.ProcessEnv, model?: string): void {
  const current = bindResearchHarness(identity.id, identity.executable, identity.profile, environment, model);
  if (canonicalMathJson(identity) !== canonicalMathJson(current)) throw new Error('math_harness_identity_changed');
}

/** Fresh comparison attempts copy only explicitly frozen configuration, never sessions or credential stores. */
export function projectResearchHarnessProfile(identity: ResearchHarnessIdentity, target: string,
  environment: NodeJS.ProcessEnv = process.env, model?: string): ResearchHarnessIdentity {
  assertResearchHarnessCurrent(identity, environment, model);
  assertMathCanonicalPath(target);
  const files = [...new Set(identity.id === 'codex' ? ['config.toml'] : identity.id === 'claude-code' ? ['settings.json'] :
    identity.id === 'opencode' ? ['opencode.json'] : [CLI_CONFIGURATION_FILE, ...readCliConfiguration(identity.profile).configurationFiles])];
  fs.mkdirSync(target, { mode: 0o700 });
  for (const name of files) {
    const source = path.join(identity.profile, name), destination = path.join(target, name);
    if (!fs.existsSync(source)) continue;
    assertMathCanonicalPath(source); assertMathCanonicalPath(destination);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, fs.readFileSync(source), { mode: 0o400, flag: 'wx' });
  }
  assertResearchHarnessCurrent(identity, environment, model);
  const projected = bindResearchHarness(identity.id, identity.executable, target, environment, model);
  if (projected.configurationDigest !== identity.configurationDigest) throw new Error('math_harness_identity_changed');
  return projected;
}

/** Selected credentials stay out of host Lean environments and persisted environment snapshots. */
export function researchHarnessEnvironment(id: ResearchHarnessIdentity['id'], source: NodeJS.ProcessEnv = process.env,
  configuration?: { profile: string; model: string }): NodeJS.ProcessEnv {
  const cli = id === 'cli' && configuration ? readCliConfiguration(configuration.profile) : undefined;
  const keys = id === 'cli' ? cli ? [...cli.inheritEnvironment, ...(cli.sealedRole ? [cli.sealedRole.provider.apiKeyEnvironment] : [])] : [] : id === 'codex' ? [] : id === 'claude-code'
    ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']
    : ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCODE_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL',
      ...(configuration ? openCodeEnvironmentReferences(configuration.profile, configuration.model) : [])];
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]!]) );
}
