import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { prepareFormalizationSandbox, type FormalizationSandbox } from '../src/runtime/formalizationSandbox';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { MATH_PROOF_ENVIRONMENT_ENV } from '../src/math/mathProofEnvironment';
import { mathDigest } from '../src/math/mathRuntimeIo';

const mocks = vi.hoisted(() => ({ relay: vi.fn(), cache: vi.fn(), resolve: vi.fn(), prepare: vi.fn(), lease: vi.fn() }));
vi.mock('../src/runtime/formalizationRelay', () => ({ startFormalizationRelay: mocks.relay }));
vi.mock('../src/math/verifier', () => ({ resolveMathematicsLakePackagesCache: mocks.cache }));
vi.mock('../src/math/mathProofEnvironment', () => ({
  MATH_PROOF_ENVIRONMENT_ENV: 'DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT',
  resolveMathProofEnvironment: mocks.resolve, prepareMathProofEnvironment: mocks.prepare,
  acquireMathProofEnvironmentLease: mocks.lease,
}));

// Real Linux namespaces and shell processes; all model traffic ends at a synthetic local
// Unix socket server. No provider credentials, model invocation or benchmark result is used.
const roots: string[] = [], sandboxes: FormalizationSandbox[] = [], relayClosers: (() => Promise<void>)[] = [];
const observed: { host: string | undefined; route: string | undefined; authorized: boolean }[] = [];
const nativePython = fs.existsSync('/usr/bin/python3') ? fs.realpathSync('/usr/bin/python3') : '';
const legacyElanRoot = process.env.THEOREMOS_TEST_LEGACY_ELAN_ROOT;
const legacyPackages = process.env.THEOREMOS_TEST_LEGACY_PACKAGES;
const installedCodex = (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, 'codex'))
  .find(file => fs.existsSync(file));
const protocolFiles = [
  { name: 'INPUT.json', text: '{"synthetic":"role input only"}', maxBytes: 8_000_000 },
  { name: 'ROLE.md', text: '# Synthetic role\nRead INPUT.json and write OUTPUT.json matching OUTPUT.schema.json.\n', maxBytes: 256_000 },
  { name: 'OUTPUT.schema.json', text: '{"type":"object","properties":{"synthetic":{"type":"string"}},"required":["synthetic"],"additionalProperties":false}',
    maxBytes: 1_000_000 },
] as const;
function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-sandbox-test-')));
  roots.push(directory);
  const workspace = path.join(directory, 'role'), profile = path.join(directory, 'host-profile');
  fs.mkdirSync(workspace); fs.mkdirSync(profile);
  for (const { name, text } of protocolFiles) fs.writeFileSync(path.join(workspace, name), text);
  fs.writeFileSync(path.join(profile, 'history.jsonl'), 'HOST_HISTORY_CANARY');
  fs.writeFileSync(path.join(profile, 'auth.json'), 'HOST_CREDENTIAL_CANARY');
  fs.writeFileSync(path.join(directory, 'gold.lean'), 'HOST_GOLD_CANARY');
  const sibling = path.join(directory, 'other-role'); fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'OUTPUT.json'), 'SIBLING_REVIEW_CANARY');
  return { directory, workspace, profile, sibling };
}
async function prepare(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const sandbox = await prepareFormalizationSandbox({ workspace: f.workspace, executable: nativePython, profile: f.profile,
    model: 'deepseek-flash', effort: 'max', environment: 'standard',
    env: { PATH: '/usr/bin:/bin', HOST_PRIVATE_CANARY: 'HOST_ENVIRONMENT_CANARY' }, ...overrides });
  sandboxes.push(sandbox); roots.push(path.dirname(sandbox.receipt.auditDirectory)); return sandbox;
}
function runCommand(sandbox: FormalizationSandbox, command: string[], input = '', timeoutMs = 8000) {
  const helper = sandbox.args.lastIndexOf('/opt/formalization/launch.py');
  const args = [...sandbox.args.slice(0, helper + 1), ...command];
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(sandbox.command, args, { env: sandbox.env, detached: true,
      stdio: ['pipe', 'pipe', 'pipe', ...(sandbox.inheritedFds ?? [])] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; }); child.stderr!.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin!.end(input);
  });
}
const run = (sandbox: FormalizationSandbox, script: string) => runCommand(sandbox, ['/usr/bin/python3', '-I', '-c', script]);

beforeEach(() => {
  observed.length = 0;
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.relay.mockImplementation(async ({ socketPath }: { socketPath: string }) => {
    const apiKey = randomBytes(24).toString('hex');
    const server = createServer((request, response) => {
      observed.push({ host: request.headers.host, route: request.url, authorized: request.headers.authorization === 'Bearer ' + apiKey });
      request.resume(); response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      response.end('{"synthetic":"no-model"}');
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    });
    relayClosers.push(close);
    return { socketPath, apiKey, httpHost: 'formalization-relay.local', route: '/v1/responses', close };
  });
});
afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await sandbox.close();
  for (const close of relayClosers.splice(0)) await close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux' || !nativePython || !fs.existsSync('/usr/bin/bwrap'))('formalization full-process sandbox', () => {
  it('denies host gold, sibling reviews, history, host proc roots, networking and all three protocol writes', async () => {
    const f = fixture(), sandbox = await prepare(f);
    fs.symlinkSync(path.join(f.directory, 'gold.lean'), path.join(f.workspace, 'escape'));
    const result = await run(sandbox, `import json, os, socket, subprocess
blocked = {}
for name, file in ${JSON.stringify({ gold: path.join(f.directory, 'gold.lean'), sibling: path.join(f.sibling, 'OUTPUT.json'),
      history: path.join(f.profile, 'history.jsonl'), credential: path.join(f.profile, 'auth.json'),
      proc: '/proc/1/root' + path.join(f.directory, 'gold.lean'), link: '/workspace/escape' })}.items():
    try:
        open(file).read()
        blocked[name] = False
    except OSError: blocked[name] = True
for name, file in [('input', '/workspace/INPUT.json'), ('role', '/workspace/ROLE.md'), ('schema', '/workspace/OUTPUT.schema.json'), ('configuration', '/profile/config.toml')]:
    try:
        open(file, 'a').write('changed')
        blocked[name] = False
    except OSError: blocked[name] = True
try:
    socket.create_connection(('1.1.1.1', 443), timeout=0.2).close()
    blocked['network'] = False
except OSError: blocked['network'] = True
blocked['environment'] = 'HOST_PRIVATE_CANARY' not in os.environ
blocked['descriptor'] = 'DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT' not in os.environ
assert subprocess.run(['/bin/bash', '--noprofile', '--norc', '-c', 'printf shell-works'], capture_output=True, text=True).stdout == 'shell-works'
open('/workspace/OUTPUT.json', 'w').write('{"synthetic":"shell output"}')
open('/profile/session-audit.json', 'w').write('{"synthetic":"role-owned audit"}')
print(json.dumps(blocked))`);
    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({ gold: true, sibling: true, history: true, credential: true,
      proc: true, link: true, input: true, role: true, schema: true, configuration: true, network: true, environment: true, descriptor: true });
    for (const { name, text } of protocolFiles) expect(fs.readFileSync(path.join(f.workspace, name), 'utf8')).toBe(text);
    expect(sandbox.receipt).toMatchObject({ schema: 'theorem-os.formalization-sandbox.v2',
      inputSha256: mathDigest(protocolFiles[0].text), roleInstructionsSha256: mathDigest(protocolFiles[1].text),
      outputSchemaSha256: mathDigest(protocolFiles[2].text) });
    expect(fs.existsSync(path.join(f.workspace, 'OUTPUT.json'))).toBe(true);
    await sandbox.close(); await sandbox.close();
    expect(fs.existsSync(path.join(sandbox.receipt.auditDirectory, 'session-audit.json'))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(sandbox.receipt.auditDirectory), 'model.sock'))).toBe(false);
    expect(JSON.stringify(sandbox.receipt)).not.toMatch(/HOST_(?:CREDENTIAL|HISTORY|ENVIRONMENT)_CANARY/u);
  });

  it('mounts independent immutable protocol snapshots after the host originals change', async () => {
    const f = fixture(), sandbox = await prepare(f);
    for (const { name } of protocolFiles) fs.writeFileSync(path.join(f.workspace, name), 'SYNTHETIC_HOST_REPLACEMENT');
    const result = await run(sandbox, `import json
expected = ${JSON.stringify(Object.fromEntries(protocolFiles.map(({ name, text }) => [name, text])))}
for name, text in expected.items():
    assert open('/workspace/' + name).read() == text
    try:
        import os
        os.unlink('/workspace/' + name)
        raise AssertionError('replaceable protocol snapshot: ' + name)
    except OSError: pass
print('independent snapshots passed')`);
    expect(result).toMatchObject({ status: 0, stdout: 'independent snapshots passed\n', stderr: '' });
  });

  it('forwards only the role model route through Unix transport with a fixed Host and disposable capability', async () => {
    const f = fixture(), sandbox = await prepare(f);
    const result = await run(sandbox, `import http.client, json, os
connection = http.client.HTTPConnection('127.0.0.1', 18888)
connection.request('POST', '/v1/responses', '{}', {'Authorization': 'Bearer ' + os.environ['FORMALIZATION_RELAY_CAPABILITY'], 'Content-Type': 'application/json'})
response = connection.getresponse()
assert response.status == 200
assert json.loads(response.read()) == {'synthetic': 'no-model'}
connection.close()
connection = http.client.HTTPConnection('127.0.0.1', 18888)
connection.request('CONNECT', 'example.com:443')
assert connection.getresponse().status == 403
print('synthetic relay passed')`);
    expect(result).toMatchObject({ status: 0, stdout: 'synthetic relay passed\n', stderr: '' });
    expect(observed).toEqual([{ host: 'formalization-relay.local', route: '/v1/responses', authorized: true }]);
    const config = parseToml(fs.readFileSync(path.join(sandbox.receipt.auditDirectory, 'config.toml'), 'utf8'));
    expect(config.model_catalog_json).toBe('/profile/models.json');
    expect(config.model_providers.sub2api).toMatchObject({ base_url: 'http://127.0.0.1:18888/v1', env_key: 'FORMALIZATION_RELAY_CAPABILITY' });
    expect(config.model_providers.sub2api.auth).toBeUndefined();
    expect(Object.keys(sandbox.env).sort()).toEqual(['LANG', 'PATH']);
  });

  it('cannot reach a host loopback listener while the role relay remains available', async () => {
    const host = createServer((_request, response) => response.end('HOST_SERVICE_CANARY'));
    await new Promise<void>((resolve, reject) => { host.once('error', reject); host.listen(0, '127.0.0.1', resolve); });
    try {
      const port = (host.address() as { port: number }).port, sandbox = await prepare(fixture());
      const result = await run(sandbox, `import socket
try:
    socket.create_connection(('127.0.0.1', ${port}), timeout=0.2).close()
    raise AssertionError('host loopback reachable')
except OSError: pass
print('host loopback blocked')`);
      expect(result).toMatchObject({ status: 0, stdout: 'host loopback blocked\n', stderr: '' });
    } finally {
      await new Promise<void>((resolve, reject) => { host.close(error => error ? reject(error) : resolve()); host.closeAllConnections(); });
    }
  });

  it('keeps concurrent role ports, profiles and audits separate', async () => {
    const first = await prepare(fixture()), second = await prepare(fixture());
    expect(first.receipt.auditDirectory).not.toBe(second.receipt.auditDirectory);
    const responses = await Promise.all([first, second].map((sandbox, index) => run(sandbox, `import http.client, json, os
assert not os.path.exists(${JSON.stringify(first.receipt.auditDirectory)})
assert not os.path.exists(${JSON.stringify(second.receipt.auditDirectory)})
connection = http.client.HTTPConnection('127.0.0.1', 18888)
connection.request('POST', '/v1/responses', '{}', {'Authorization': 'Bearer ' + os.environ['FORMALIZATION_RELAY_CAPABILITY']})
assert connection.getresponse().status == 200
open('/profile/role.json', 'w').write('${index}')
print('separate')`)));
    expect(responses.map(result => result.status)).toEqual([0, 0]);
    expect(observed).toHaveLength(2); expect(observed.every(request => request.authorized)).toBe(true);
    expect(fs.readFileSync(path.join(first.receipt.auditDirectory, 'role.json'), 'utf8')).toBe('0');
    expect(fs.readFileSync(path.join(second.receipt.auditDirectory, 'role.json'), 'utf8')).toBe('1');
  });

  for (const environment of ['mathlib', 'mathlib-4.8'] as const) {
  it.skipIf(environment === 'mathlib-4.8' && !legacyElanRoot)(`attaches only sealed ${environment} dependencies and holds their lease until close`, async () => {
    const f = fixture(), sealed = path.join(f.directory, 'synthetic-sealed-packages'), raw = path.join(f.directory, 'unfiltered-cache');
    fs.mkdirSync(sealed); fs.mkdirSync(raw); fs.writeFileSync(path.join(raw, 'gold.lean'), 'UNFILTERED_GOLD_CANARY');
    const config = getLeanTaskEnvironment(environment), libraryDirectory = config.packageLibraryDirectory ?? '.lake/build/lib/lean';
    const names = JSON.parse(config.files['lake-manifest.json']).packages.map((item: { name: string }) => item.name);
    for (const name of names) fs.mkdirSync(path.join(sealed, name, libraryDirectory), { recursive: true });
    fs.writeFileSync(path.join(sealed, 'mathlib', 'Synthetic.lean'), '-- synthetic dependency mapping fixture only');
    const release = vi.fn(async () => {}), dispose = vi.fn(async () => {}), verify = vi.fn();
    mocks.cache.mockReturnValue(raw);
    mocks.prepare.mockResolvedValue({ environmentValue: 'synthetic-sealed-descriptor', dispose });
    mocks.resolve.mockImplementation((_project, env) => env[MATH_PROOF_ENVIRONMENT_ENV] === 'synthetic-sealed-descriptor'
      ? { packagesRoot: sealed, identity: 'a'.repeat(64), verify } : undefined);
    mocks.lease.mockResolvedValue({ packagesRoot: sealed, release });
    const sandbox = await prepare(f, { environment,
      ...(environment === 'mathlib-4.8' ? { env: { PATH: '/usr/bin:/bin', ELAN_HOME: legacyElanRoot } } : {}) });
    expect(mocks.prepare.mock.calls[0]![2]).not.toHaveProperty('deadlineAt');
    expect(sandbox.receipt.toolchain).toBe(config.toolchain);
    expect(sandbox.receipt.environmentDigest).toBe(config.dependencyDigest);
    expect(sandbox.receipt.packages).toEqual({ kind: 'sealed', root: '/opt/lean-packages', identity: 'a'.repeat(64) });
    expect(sandbox.inheritedFds).toHaveLength(1); expect(sandbox.args).toContain('--ro-bind-fd');
    expect(sandbox.args).not.toContain(raw); expect(release).not.toHaveBeenCalled();
    const result = await run(sandbox, `import os
assert '/opt/lean-packages/mathlib/${libraryDirectory}' in os.environ['LEAN_PATH'].split(':')
assert open('/opt/lean-packages/mathlib/Synthetic.lean').read().startswith('-- synthetic')
assert not os.path.exists('/opt/lean-packages/gold.lean')
try:
    open('/opt/lean-packages/mathlib/Synthetic.lean', 'a').write('changed')
    raise AssertionError('writable packages')
except OSError: pass
print('sealed fixture passed')`);
    expect(result).toMatchObject({ status: 0, stdout: 'sealed fixture passed\n', stderr: '' });
    await sandbox.close(); expect(release).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
  });
  }

  it.skipIf(!legacyElanRoot || !legacyPackages)('elaborates source-era names and notation in a real sealed Mathlib 4.8 mount offline', async () => {
    const f = fixture();
    const proofEnvironment = await vi.importActual<typeof import('../src/math/mathProofEnvironment')>('../src/math/mathProofEnvironment');
    const verifier = await vi.importActual<typeof import('../src/math/verifier')>('../src/math/verifier');
    mocks.resolve.mockImplementation(proofEnvironment.resolveMathProofEnvironment);
    mocks.lease.mockImplementation(proofEnvironment.acquireMathProofEnvironmentLease);
    mocks.cache.mockImplementation(verifier.resolveMathematicsLakePackagesCache);
    mocks.prepare.mockImplementation((project, packages, options) => proofEnvironment.prepareMathProofEnvironment(project, packages, {
      ...options, cacheRoot: path.join(f.directory, 'sealed-cache'),
    }));
    const sandbox = await prepare(f, { environment: 'mathlib-4.8', env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', ELAN_HOME: legacyElanRoot,
      DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS: legacyPackages,
    } });
    const source = 'import Mathlib\nopen scoped BigOperators\n#check @QuotientMap\n' +
      '#check isConnected_iff_connectedSpace\n#check fun (s : Finset ℕ) => ∏ x in s, x\n';
    const result = await runCommand(sandbox, ['/usr/bin/python3', '-I', '-c', `import os, subprocess
assert '/opt/lean-packages/mathlib/.lake/build/lib' in os.environ['LEAN_PATH'].split(':')
assert os.path.isfile('/opt/lean-packages/mathlib/.lake/build/lib/Mathlib.olean')
assert not os.path.exists(${JSON.stringify(legacyPackages)})
open('/tmp/Legacy.lean', 'w').write(${JSON.stringify(source)})
result = subprocess.run(['/opt/lean/bin/lean', '/tmp/Legacy.lean'], text=True, capture_output=True)
print(result.stdout, end='')
print(result.stderr, end='')
raise SystemExit(result.returncode)`], '', 30_000);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('QuotientMap');
    expect(result.stdout).toContain('isConnected_iff_connectedSpace');
    expect(sandbox.receipt).toMatchObject({ toolchain: 'leanprover/lean4:v4.8.0',
      environmentDigest: getLeanTaskEnvironment('mathlib-4.8').dependencyDigest,
      packages: { kind: 'sealed', root: '/opt/lean-packages' }, canary: 'passed' });
    expect(observed).toEqual([]);
  }, 180_000);

  it.each(protocolFiles.flatMap(file => ['missing', 'symlink', 'hardlink', 'oversized'].map(kind => ({ ...file, kind }))))(
    'fails closed before opening a relay for $kind $name', async ({ name, maxBytes, kind }) => {
      const f = fixture(), file = path.join(f.workspace, name);
      fs.unlinkSync(file);
      if (kind === 'symlink') fs.symlinkSync(path.join(f.directory, 'gold.lean'), file);
      if (kind === 'hardlink') fs.linkSync(path.join(f.directory, 'gold.lean'), file);
      if (kind === 'oversized') fs.writeFileSync(file, Buffer.alloc(maxBytes + 1));
      await expect(prepare(f)).rejects.toThrow();
      expect(mocks.relay).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
    });

  it('fails closed before opening a relay for unsupported executable launchers', async () => {
    const valid = fixture(), shell = path.join(valid.directory, 'codex');
    fs.writeFileSync(shell, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await expect(prepare(valid, { executable: shell })).rejects.toThrow('formalization_sandbox_native_executable_required');
    expect(mocks.relay).not.toHaveBeenCalled();
  });

  it('honors a pre-aborted owner and never starts an unisolated fallback', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepare(fixture(), { signal: controller.signal })).rejects.toThrow();
    expect(mocks.relay).not.toHaveBeenCalled();
  });

  it('closes the relay and removes preparation state when the isolated compiler canary fails', async () => {
    const f = fixture(), wrongToolchain = path.join(f.directory, 'wrong-native-toolchain');
    fs.mkdirSync(path.join(wrongToolchain, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(wrongToolchain, 'lib', 'lean'), { recursive: true });
    for (const name of ['lean', 'lake']) fs.copyFileSync(nativePython, path.join(wrongToolchain, 'bin', name));
    await expect(prepare(f, { env: { PATH: '/usr/bin:/bin', ELAN_HOME: wrongToolchain } }))
      .rejects.toThrow('formalization_sandbox_canary_failed');
    expect(mocks.relay).toHaveBeenCalledOnce();
    const temporary = path.dirname(mocks.relay.mock.calls[0]![0].socketPath);
    expect(fs.existsSync(temporary)).toBe(false);
    expect(observed).toEqual([]);
  });

  it.skipIf(!installedCodex)('resolves the installed Node launcher and starts only native Codex --version offline', async () => {
    const sandbox = await prepare(fixture(), { executable: installedCodex });
    const result = await runCommand(sandbox, ['/opt/codex/bin/codex', '--version']);
    expect(result.status).toBe(0); expect(result.stdout).toMatch(/^codex-cli /u);
    expect(observed).toEqual([]);
  });
});
