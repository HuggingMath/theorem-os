import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stringify as stringifyToml } from 'smol-toml';
import { assertMathCanonicalPath } from '../math/paths';
import { canonicalMathJson, mathDigest, readMathFile } from '../math/mathRuntimeIo';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { leanLibraryApiProgram } from '../math/leanLibrarySymbolsProgram';
import libraryApiScript from './formalizationLibraryApi.py?raw';
import { acquireMathProofEnvironmentLease, MATH_PROOF_ENVIRONMENT_ENV, prepareMathProofEnvironment,
  resolveMathProofEnvironment } from '../math/mathProofEnvironment';
import { DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT } from '../math/mathProofEnvironmentCache';
import { projectMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { resolveMathematicsLakePackagesCache } from '../math/verifier';
import { startFormalizationRelay, type NativeRelayProtocol } from './formalizationRelay';
import type { ModelRequestGate } from './modelRequest';
import { sub2apiModelCatalog } from './sub2api';
import { FORMALIZATION_LIBRARY_ROOT, readFormalizationLibraryRelease, snapshotFormalizationLibrary,
  type FormalizationLibraryAccess } from './formalizationLibrary';

const CAPABILITY_ENV = 'FORMALIZATION_RELAY_CAPABILITY';
const BASE_URL = 'http://127.0.0.1:18888/v1';
const SOCKET = '/run/model.sock';
const HELPER = '/opt/formalization/launch.py';
const COMMAND = '/opt/codex/bin/codex';
const SPAWN_ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
const PROTOCOL_FILES = [
  { name: 'INPUT.json', maxBytes: 8_000_000 },
  { name: 'ROLE.md', maxBytes: 256_000 },
  { name: 'OUTPUT.schema.json', maxBytes: 1_000_000 },
] as const;

// This helper owns the private loopback transport and forwards only the model route over
// the one socket mounted into this role. It never receives a real provider credential.
const LAUNCHER = String.raw`import json, os, select, signal, socket, socketserver, subprocess, sys, threading
allowed = json.loads(os.environ.get('FORMALIZATION_MODEL_ROUTES', '["/v1/responses"]'))
class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        upstream = None
        try:
            self.request.settimeout(10)
            data = b''
            while b'\r\n\r\n' not in data:
                chunk = self.request.recv(4096)
                if not chunk or len(data) + len(chunk) > 65536: return
                data += chunk
            head, body = data.split(b'\r\n\r\n', 1)
            lines = head.split(b'\r\n')
            if lines[0] not in [b'POST ' + route.encode() + b' HTTP/1.1' for route in allowed]:
                self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                return
            headers = [line for line in lines[1:] if line.split(b':', 1)[0].lower() not in (b'host', b'connection', b'proxy-connection')]
            upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            upstream.connect('/run/model.sock')
            upstream.sendall(b'\r\n'.join([lines[0], *headers, b'Host: formalization-relay.local', b'Connection: close']) + b'\r\n\r\n' + body)
            self.request.settimeout(None)
            readers = [self.request, upstream]
            while upstream in readers:
                ready, _, _ = select.select(readers, [], [])
                for source in ready:
                    chunk = source.recv(65536)
                    destination = upstream if source is self.request else self.request
                    if not chunk:
                        readers.remove(source)
                        if source is self.request:
                            try: upstream.shutdown(socket.SHUT_WR)
                            except OSError: pass
                        continue
                    destination.sendall(chunk)
        except (OSError, ValueError): pass
        finally:
            if upstream is not None: upstream.close()
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    def handle_error(self, request, address): pass
server = Server(('127.0.0.1', 18888), Relay)
threading.Thread(target=server.serve_forever, daemon=True).start()
control = None
if os.environ.get('FORMALIZATION_CONTROL_PORT'):
    class Control(socketserver.BaseRequestHandler):
        def handle(self):
            upstream = None
            try:
                upstream = socket.create_connection(('127.0.0.1', int(os.environ['FORMALIZATION_CONTROL_PORT'])), timeout=10)
                upstream.settimeout(None)
                readers = [self.request, upstream]
                while upstream in readers:
                    ready, _, _ = select.select(readers, [], [])
                    for source in ready:
                        chunk = source.recv(65536)
                        if not chunk:
                            readers.remove(source)
                            if source is self.request:
                                try: upstream.shutdown(socket.SHUT_WR)
                                except OSError: pass
                        else: (upstream if source is self.request else self.request).sendall(chunk)
            except OSError: pass
            finally:
                if upstream is not None: upstream.close()
    class ControlServer(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True
        def handle_error(self, request, address): pass
    control = ControlServer('/control/native.sock', Control)
    os.chmod('/control/native.sock', 0o600)
    threading.Thread(target=control.serve_forever, daemon=True).start()
child = subprocess.Popen(sys.argv[1:], close_fds=True)
def interrupt(signum, frame):
    try: child.send_signal(signum)
    except ProcessLookupError: pass
signal.signal(signal.SIGTERM, interrupt)
signal.signal(signal.SIGINT, interrupt)
try: status = child.wait()
finally:
    server.shutdown()
    server.server_close()
    if control is not None:
        control.shutdown()
        control.server_close()
sys.exit(status if status >= 0 else 128 - status)
`;

export type FormalizationSandboxReceipt = Readonly<{
  schema: 'theorem-os.formalization-sandbox.v2'; backend: 'bwrap';
  workspace: '/workspace'; profile: '/profile'; providerId: 'sub2api' | 'web_provider';
  namespaces: readonly ['user', 'mount', 'pid', 'ipc', 'uts', 'net'];
  network: 'role-model-relay-only'; credentials: 'host-only'; input: 'read-only';
  toolchain: string; environmentDigest: string; executableSha256: string; profileDigest: string; inputSha256: string;
  roleInstructionsSha256: string; outputSchemaSha256: string;
  packages: Readonly<{ kind: 'none' | 'sealed'; root?: '/opt/lean-packages'; identity?: string; contents?: 'sources' }>;
  libraryApi?: Readonly<{ scriptSha256: string; programSha256: string }>;
  library?: Readonly<{ root: typeof FORMALIZATION_LIBRARY_ROOT; catalogDigest: string; buildReceiptSha256: string }>;
  auditDirectory: string; canary: 'passed';
  harness?: string; runtimeResources?: readonly Readonly<{ target: string; sha256: string }>[];
  wireApi?: NativeRelayProtocol['wireApi']; control?: 'private-native-unix-socket';
}>;
export type FormalizationSandbox = Readonly<{
  command: string; args: string[]; env: NodeJS.ProcessEnv; inheritedFds?: readonly number[];
  workspace: '/workspace'; profile: '/profile'; providerId: 'sub2api' | 'web_provider'; providerBaseUrl: string; modelCatalog?: string;
  receipt: FormalizationSandboxReceipt; close: () => Promise<void>;
  controlSocket?: string;
  launch: (arguments_: readonly string[]) => { command: string; args: string[]; env: NodeJS.ProcessEnv; inheritedFds?: readonly number[] };
}>;
export type SealedRuntimeProjection = Readonly<{
  harness: 'claude-code' | 'opencode' | 'cli';
  executable: string; command: string; prefixArgs?: readonly string[];
  mounts?: readonly Readonly<{ source: string; target: string }>[];
  profileFiles: Readonly<Record<string, string>>;
  environment: Readonly<Record<string, string>>;
  relay: NativeRelayProtocol;
  controlPort?: number;
}>;
type Input = Readonly<{
  workspace: string; executable: string; profile: string; model: string; effort: string;
  environment: LeanTaskEnvironment; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  packages?: 'none' | 'sources';
  library?: FormalizationLibraryAccess;
  outputSchema?: Record<string, unknown>;
  requestGate?: ModelRequestGate; onUsageIncomplete?: () => void;
  runtime?: SealedRuntimeProjection;
}>;

function nativeFile(file: string): string {
  const canonical = fs.realpathSync(file), stat = fs.statSync(canonical);
  const fd = fs.openSync(canonical, 'r'), magic = Buffer.alloc(4);
  try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
  if (!stat.isFile() || !(stat.mode & 0o111) || !magic.equals(Buffer.from([127, 69, 76, 70])))
    throw new Error('formalization_sandbox_native_executable_required');
  return canonical;
}

function codexExecutable(executable: string, env: NodeJS.ProcessEnv): { file: string; vendor?: string } {
  const file = path.isAbsolute(executable) ? executable : (env.PATH ?? process.env.PATH ?? '').split(path.delimiter)
    .filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, executable))
    .find(candidate => fs.existsSync(candidate));
  if (!file) throw new Error('formalization_sandbox_codex_unavailable');
  const canonical = fs.realpathSync(file);
  let native: string;
  if (canonical.endsWith('.js')) {
    const root = path.dirname(path.dirname(canonical));
    if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name !== '@openai/codex')
      throw new Error('formalization_sandbox_codex_launcher_unsupported');
    const platform = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : '';
    if (!platform) throw new Error('formalization_sandbox_architecture_unsupported');
    const triple = platform === 'x64' ? 'x86_64-unknown-linux-musl' : 'aarch64-unknown-linux-musl';
    const roots = [path.join(root, 'vendor', triple),
      path.join(root, 'node_modules', '@openai', 'codex-linux-' + platform, 'vendor', triple),
      path.join(path.dirname(root), 'codex-linux-' + platform, 'vendor', triple)];
    const found = roots.flatMap(vendor => [path.join(vendor, 'bin', 'codex'), path.join(vendor, 'codex', 'codex')])
      .find(candidate => fs.existsSync(candidate));
    if (!found) throw new Error('formalization_sandbox_codex_native_unavailable');
    native = nativeFile(found);
  } else native = nativeFile(canonical);
  const vendor = path.dirname(path.dirname(native));
  return { file: native, ...(fs.existsSync(path.join(vendor, 'codex-package.json')) ? { vendor: fs.realpathSync(vendor) } : {}) };
}

function leanToolchain(toolchain: string, env: NodeJS.ProcessEnv): string {
  const name = toolchain.replace(/[/:]/gu, value => value === '/' ? '--' : '---');
  const roots = [env.ELAN_HOME, ...(env.DEEPSCIENTIST_MATH_TRUSTED_ELAN_ROOTS ?? '').split(path.delimiter), path.join(os.homedir(), '.elan')]
    .filter((value): value is string => Boolean(value));
  for (const root of roots) {
    for (const candidate of [path.join(root, 'toolchains', name), root]) {
      try {
        const canonical = fs.realpathSync(candidate);
        nativeFile(path.join(canonical, 'bin', 'lean')); nativeFile(path.join(canonical, 'bin', 'lake'));
        if (fs.statSync(path.join(canonical, 'lib', 'lean')).isDirectory()) return canonical;
      } catch { /* Only an installed native pinned toolchain may enter the sandbox. */ }
    }
  }
  throw new Error('formalization_sandbox_lean_toolchain_unavailable');
}

/** Warm only the private disk cache; consumers still create independent sealed mounts. */
export async function warmFormalizationPackages(environment: LeanTaskEnvironment, options: {
  env?: NodeJS.ProcessEnv; signal?: AbortSignal; deadlineAt?: number;
} = {}): Promise<void> {
  const checkpoint = () => {
    options.signal?.throwIfAborted();
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)
      throw new Error('Sealed proof environment preparation deadline exceeded.');
  };
  checkpoint();
  const config = getLeanTaskEnvironment(environment);
  if (!config.mathlibRevision) return;
  // Only the pinned mathematics tool settings enter preparation, never model credentials.
  const env = projectMathematicsRuntimeEnvironment(options.env ?? process.env);
  const probe = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theorem-os-formalization-packages-')));
  let prepared: Awaited<ReturnType<typeof prepareMathProofEnvironment>> | undefined;
  try {
    for (const [name, text] of Object.entries(config.files)) {
      fs.mkdirSync(path.dirname(path.join(probe, name)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(probe, name), text, { flag: 'wx', mode: 0o400 });
    }
    if (resolveMathProofEnvironment(probe, env)) return;
    const root = resolveMathematicsLakePackagesCache(probe, env);
    if (!root) throw new Error('formalization_sandbox_pinned_mathlib_unavailable');
    prepared = await prepareMathProofEnvironment(probe, root, { env, signal: options.signal,
      deadlineAt: options.deadlineAt, cacheRoot: DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT });
    checkpoint();
  } finally {
    try { await prepared?.dispose(); }
    finally { fs.rmSync(probe, { recursive: true, force: true }); }
  }
}

/** Full-process isolation. No host profile, campaign directory or credential enters the mount namespace. */
export async function prepareFormalizationSandbox(input: Input): Promise<FormalizationSandbox> {
  if (process.platform !== 'linux') throw new Error('formalization_sandbox_requires_linux');
  input.signal?.throwIfAborted();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(input.model) ||
      !(input.runtime ? ['none', 'low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'high', 'max']).includes(input.effort))
    throw new Error('formalization_sandbox_model_invalid');
  const workspace = path.resolve(input.workspace); assertMathCanonicalPath(workspace);
  if (!fs.statSync(workspace).isDirectory()) throw new Error('formalization_sandbox_input_unavailable');
  // Read each host-owned contract once before any asynchronous preparation. Reject links,
  // oversized files and identity changes, then mount independent role-only snapshots.
  const protocol = PROTOCOL_FILES.map(({ name, maxBytes }) => {
    const file = path.join(workspace, name); assertMathCanonicalPath(file);
    return { name, bytes: readMathFile(file, maxBytes).bytes };
  });
  const environment = input.env ?? process.env, config = getLeanTaskEnvironment(input.environment);
  if (input.outputSchema && canonicalMathJson(input.outputSchema) !== canonicalMathJson(JSON.parse(protocol[2].bytes.toString('utf8'))))
    throw new Error('formalization_sandbox_output_schema_mismatch');
  const executable = input.runtime ? { file: nativeFile(input.runtime.executable), vendor: undefined }
    : codexExecutable(input.executable, environment), toolchain = leanToolchain(config.toolchain, environment);
  const command = nativeFile('/usr/bin/bwrap');
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theorem-os-formalization-role-')));
  fs.chmodSync(temporary, 0o700);
  let relay: Awaited<ReturnType<typeof startFormalizationRelay>> | undefined;
  let prepared: Awaited<ReturnType<typeof prepareMathProofEnvironment>> | undefined;
  let lease: Awaited<ReturnType<typeof acquireMathProofEnvironmentLease>>;
  let packagesFd: number | undefined, closing: Promise<void> | undefined;
  let audit = false;
  const close = () => closing ??= (async () => {
    input.signal?.removeEventListener('abort', aborted);
    try { await relay?.close(); }
    finally {
      if (packagesFd !== undefined) { fs.closeSync(packagesFd); packagesFd = undefined; }
      try { await lease?.release(); } finally { await prepared?.dispose(); }
      if (!audit) fs.rmSync(temporary, { recursive: true, force: true });
      else for (const entry of fs.readdirSync(temporary)) if (entry !== 'profile' && entry !== 'receipt.json')
        fs.rmSync(path.join(temporary, entry), { recursive: true, force: true });
    }
  })();
  const aborted = () => { void close().catch(() => {}); };
  try {
    const profile = path.join(temporary, 'profile'), probe = path.join(temporary, 'probe');
    fs.mkdirSync(profile, { mode: 0o700 }); fs.mkdirSync(probe, { mode: 0o700 });
    const librarySnapshot = path.join(temporary, 'library');
    let library: ReturnType<typeof readFormalizationLibraryRelease> | undefined;
    if (input.library) {
      try {
        library = readFormalizationLibraryRelease(input.library, input.environment);
        snapshotFormalizationLibrary(librarySnapshot, library);
      } catch (cause) { throw new Error('formalization_sandbox_library_unavailable', { cause }); }
    }
    const apiProgram = leanLibraryApiProgram(input.environment, library?.modules.map(module => module.import));
    fs.writeFileSync(path.join(temporary, 'library-api.py'), libraryApiScript, { mode: 0o400, flag: 'wx' });
    fs.writeFileSync(path.join(temporary, 'library-api.lean'), apiProgram, { mode: 0o400, flag: 'wx' });
    for (const [name, text] of Object.entries(config.files)) {
      fs.mkdirSync(path.dirname(path.join(probe, name)), { recursive: true }); fs.writeFileSync(path.join(probe, name), text);
    }
    let packages: FormalizationSandboxReceipt['packages'] = { kind: 'none' }, packageNames: string[] = [];
    if (config.mathlibRevision && input.packages !== 'none') {
      const contents = input.packages === 'sources' ? 'sources' : undefined;
      let packageEnvironment = environment;
      if (!resolveMathProofEnvironment(probe, environment, contents)) {
        const root = resolveMathematicsLakePackagesCache(probe, environment);
        if (!root) throw new Error('formalization_sandbox_pinned_mathlib_unavailable');
        prepared = await prepareMathProofEnvironment(probe, root, { env: environment, signal: input.signal,
          cacheRoot: DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT, ...(contents ? { contents } : {}) });
        packageEnvironment = { ...environment, [MATH_PROOF_ENVIRONMENT_ENV]: prepared.environmentValue };
      }
      const sealed = resolveMathProofEnvironment(probe, packageEnvironment, contents)!;
      lease = await acquireMathProofEnvironmentLease(probe, packageEnvironment, input.signal, undefined, contents);
      if (!lease) throw new Error('formalization_sandbox_sealed_mathlib_unavailable');
      packagesFd = fs.openSync(lease.packagesRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      const opened = fs.fstatSync(packagesFd, { bigint: true }), expected = fs.statSync(lease.packagesRoot, { bigint: true });
      sealed.verify();
      if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino)
        throw new Error('formalization_sandbox_mathlib_identity_changed');
      packageNames = JSON.parse(config.files['lake-manifest.json']).packages.map((item: { name: string }) => item.name);
      if (packageNames.some(name => !/^[A-Za-z0-9_-]+$/u.test(name))) throw new Error('formalization_sandbox_package_name_invalid');
      packages = { kind: 'sealed', root: '/opt/lean-packages', identity: sealed.identity,
        ...(sealed.contents === 'sources' ? { contents: 'sources' } : {}) };
    }
    input.signal?.throwIfAborted();
    relay = await startFormalizationRelay({ socketPath: path.join(temporary, 'model.sock'), profile: input.profile,
      model: input.model, effort: input.effort, env: environment, signal: input.signal,
      outputSchema: input.outputSchema,
      requestGate: input.requestGate, onUsageIncomplete: input.onUsageIncomplete, ...(input.runtime ? { native: input.runtime.relay } : {}) });
    const providerId = relay.receipt.providerId, modelCatalog = !input.runtime && providerId === 'sub2api' ? '/profile/models.json' : undefined;
    const profileConfig = stringifyToml({ model: input.model, model_provider: providerId,
      model_reasoning_effort: input.effort, ...(modelCatalog ? { model_catalog_json: modelCatalog } : {}), web_search: 'disabled',
      approval_policy: 'never', sandbox_mode: 'danger-full-access',
      model_providers: { [providerId]: { name: 'Isolated role model relay', base_url: BASE_URL, wire_api: 'responses',
        env_key: CAPABILITY_ENV, requires_openai_auth: false, request_max_retries: 0, stream_max_retries: 0 } },
      features: { apps: false, plugins: false, multi_agent: false, multi_agent_v2: false, goals: false,
        shell_snapshot: false, view_image: false },
      shell_environment_policy: { inherit: 'all', exclude: [CAPABILITY_ENV] },
      history: { persistence: 'none' }, analytics: { enabled: false }, allow_login_shell: false });
    const catalog = canonicalMathJson(providerId === 'sub2api' ? sub2apiModelCatalog() : { models: [] });
    const profileFiles = input.runtime?.profileFiles ?? { 'config.toml': profileConfig, 'models.json': catalog };
    for (const [name, contents] of Object.entries(profileFiles)) {
      if (path.isAbsolute(name) || name.split(/[\\/]/u).includes('..') || !name || name.includes('\0'))
        throw new Error('formalization_sandbox_profile_projection_invalid');
      const selected = path.join(profile, name); fs.mkdirSync(path.dirname(selected), { recursive: true, mode: 0o700 });
      fs.writeFileSync(selected, contents.replaceAll('__ROLE_MODEL_CAPABILITY__', relay.apiKey), { flag: 'wx', mode: 0o400 });
    }
    for (const { name, bytes } of protocol)
      fs.writeFileSync(path.join(temporary, name), bytes, { flag: 'wx', mode: 0o400 });
    fs.writeFileSync(path.join(temporary, 'launch.py'), LAUNCHER, { flag: 'wx', mode: 0o400 });
    const args = ['--unshare-user', '--uid', '0', '--gid', '0', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
      '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr',
      '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home/role', '--dir', '/run', '--dir', '/opt/formalization',
      '--bind', workspace, '/workspace',
      ...protocol.flatMap(({ name }) => ['--ro-bind', path.join(temporary, name), '/workspace/' + name]),
      '--bind', profile, '/profile', ...Object.keys(profileFiles).flatMap(name => ['--ro-bind', path.join(profile, name), '/profile/' + name]),
      '--ro-bind', relay.socketPath!, SOCKET, '--ro-bind', path.join(temporary, 'launch.py'), HELPER,
      '--ro-bind', path.join(temporary, 'library-api.py'), '/opt/formalization/library-api.py',
      '--ro-bind', path.join(temporary, 'library-api.lean'), '/opt/formalization/library-api.lean',
      '--ro-bind', toolchain, '/opt/lean'];
    if (executable.vendor) args.push('--ro-bind', executable.vendor, '/opt/codex');
    // Also support a directly supplied native executable without exposing its host parent.
    args.push('--ro-bind', executable.file, input.runtime?.command ?? COMMAND);
    for (const mount of input.runtime?.mounts ?? []) args.push('--ro-bind', mount.source, mount.target);
    const controlDirectory = input.runtime?.controlPort ? path.join(temporary, 'control') : undefined;
    if (controlDirectory) { fs.mkdirSync(controlDirectory, { mode: 0o700 }); args.push('--bind', controlDirectory, '/control'); }
    if (packagesFd !== undefined) args.push('--ro-bind-fd', '3', '/opt/lean-packages');
    if (library) args.push('--ro-bind', librarySnapshot, FORMALIZATION_LIBRARY_ROOT);
    const variables: Record<string, string> = { PATH: '/opt/codex/codex-path:/opt/codex/path:/opt/lean/bin:/usr/bin:/bin', HOME: '/home/role',
      CODEX_HOME: '/profile', TMPDIR: '/tmp', LANG: 'C.UTF-8', LAKE_HOME: '/tmp/lake', ELAN_HOME: '/tmp/elan',
      LEAN_NUM_THREADS: '1', LEAN_PATH: ['/opt/lean/lib/lean', ...(library ? [`${FORMALIZATION_LIBRARY_ROOT}/${library.buildDirectory}`] : []), ...packageNames.map(name =>
        `/opt/lean-packages/${name}/${config.packageLibraryDirectory ?? '.lake/build/lib/lean'}`)].join(':'),
      ...(packageNames.includes('mathlib') ? { MATHLIB_ROOT: '/opt/lean-packages/mathlib' } : {}),
      ...input.runtime?.environment, [CAPABILITY_ENV]: relay.apiKey,
      ...(input.runtime ? { FORMALIZATION_MODEL_ROUTES: JSON.stringify(input.runtime.relay.routes ?? [input.runtime.relay.route]) } : {}),
      ...(input.runtime?.controlPort ? { FORMALIZATION_CONTROL_PORT: String(input.runtime.controlPort) } : {}) };
    // The only credential projected to a native process is this disposable role capability.
    for (const name of Object.keys(variables)) if (variables[name] === '__ROLE_MODEL_CAPABILITY__') variables[name] = relay.apiKey;
    args.push('--chdir', '/workspace', ...Object.entries(variables).flatMap(([name, value]) => ['--setenv', name, value]));
    const expectedVersion = config.toolchain.replace(/^leanprover\/lean4:v/u, '');
    const canary = spawnSync(command, [...args, '--', '/usr/bin/python3', '-I', '-c', String.raw`import hashlib, os, subprocess
assert os.readlink('/proc/self/ns/net') != ${JSON.stringify(fs.readlinkSync('/proc/self/ns/net'))}
assert os.readlink('/proc/self/ns/pid') != ${JSON.stringify(fs.readlinkSync('/proc/self/ns/pid'))}
assert not os.path.exists(${JSON.stringify(workspace)})
for name, digest in ${JSON.stringify(protocol.map(({ name, bytes }) => [name, mathDigest(bytes)]))}:
    file = '/workspace/' + name
    assert hashlib.sha256(open(file, 'rb').read()).hexdigest() == digest
    try:
        open(file, 'ab').close()
        raise AssertionError('writable protocol file: ' + name)
    except OSError: pass
result = subprocess.run(['/opt/lean/bin/lean', '--version'], capture_output=True, text=True, check=True)
assert 'Lean (version ${expectedVersion},' in result.stdout
`], { env: SPAWN_ENV, encoding: 'utf8', timeout: 15_000, maxBuffer: 4096,
      ...(packagesFd === undefined ? {} : { stdio: ['pipe', 'pipe', 'pipe', packagesFd] }) });
    if (canary.status !== 0 || canary.error) throw new Error('formalization_sandbox_canary_failed');
    input.signal?.throwIfAborted();
    const receipt: FormalizationSandboxReceipt = { schema: 'theorem-os.formalization-sandbox.v2', backend: 'bwrap',
      workspace: '/workspace', profile: '/profile', providerId, namespaces: ['user', 'mount', 'pid', 'ipc', 'uts', 'net'],
      network: 'role-model-relay-only', credentials: 'host-only', input: 'read-only', toolchain: config.toolchain,
      environmentDigest: config.dependencyDigest, executableSha256: mathDigest(fs.readFileSync(executable.file)),
      profileDigest: mathDigest(canonicalMathJson(input.runtime ? { files: profileFiles, environment: input.runtime.environment,
        endpoint: input.runtime.relay.endpoint } : { config: profileConfig, catalog })),
      inputSha256: mathDigest(protocol[0].bytes), roleInstructionsSha256: mathDigest(protocol[1].bytes),
      outputSchemaSha256: mathDigest(protocol[2].bytes),
      libraryApi: { scriptSha256: mathDigest(libraryApiScript), programSha256: mathDigest(apiProgram) },
      ...(library ? { library: { root: FORMALIZATION_LIBRARY_ROOT, catalogDigest: input.library!.digest,
        buildReceiptSha256: library.buildReceiptSha256 } } : {}),
      packages, auditDirectory: profile, canary: 'passed',
      ...(input.runtime ? { harness: input.runtime.harness, wireApi: input.runtime.relay.wireApi,
        runtimeResources: (input.runtime.mounts ?? []).map(mount => ({ target: mount.target, sha256: mathDigest(fs.readFileSync(mount.source)) })),
        ...(controlDirectory ? { control: 'private-native-unix-socket' as const } : {}) } : {}) };
    fs.writeFileSync(path.join(temporary, 'receipt.json'), canonicalMathJson(receipt), { mode: 0o400, flag: 'wx' });
    audit = true;
    input.signal?.addEventListener('abort', aborted, { once: true });
    const launch = (arguments_: readonly string[]) => ({ command,
      args: [...args, '--', '/usr/bin/python3', '-I', HELPER, input.runtime?.command ?? COMMAND,
        ...(input.runtime?.prefixArgs ?? []), ...arguments_], env: { ...SPAWN_ENV },
      ...(packagesFd === undefined ? {} : { inheritedFds: [packagesFd] }) });
    return { ...launch(input.runtime ? [] : ['app-server', '--listen', 'stdio://']),
      env: { ...SPAWN_ENV }, ...(packagesFd === undefined ? {} : { inheritedFds: [packagesFd] }),
      workspace: '/workspace', profile: '/profile', providerId, providerBaseUrl: BASE_URL, ...(modelCatalog ? { modelCatalog } : {}), receipt, close, launch,
      ...(controlDirectory ? { controlSocket: path.join(controlDirectory, 'native.sock') } : {}) };
  } catch (cause) { await close(); throw cause; }
}
