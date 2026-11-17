import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { checkLeanEnvironmentHealth } from '../src/math/leanEnvironmentHealth';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { MATH_PROOF_ENVIRONMENT_ENV, MATH_PROOF_ENVIRONMENT_SANDBOX_ENV } from '../src/math/mathProofEnvironment';
import { mathProofEnvironmentConfiguration, MATH_PROOF_ENVIRONMENT_METADATA } from '../src/math/mathProofEnvironmentSeed';
import { LeanEnvironmentHealthCheckError, runHarnessLeanHealthCheck } from '../src/runtime/leanHealthCheck';
import { tacticBatteryCacheTestDefines } from './helpers/tacticBatteryCache';
import { createCodexMathSession } from '../src/runtime/codexSession';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

describe.skipIf(process.platform !== 'linux')('Lean environment diagnostics in the writer namespace', () => {
  let root: string, workspace: string, profile: string, tools: string, dependencies: string, mount: string;
  let bundleRoot: string, cli: string;
  let server: net.Server, env: NodeJS.ProcessEnv, requests: number;
  beforeAll(async () => {
    bundleRoot = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || '/data/lzh/default-storage/tmp', 'lean-health-cli-')));
    cli = path.join(bundleRoot, 'check-lean.cjs');
    await build({ entryPoints: [path.resolve('scripts/mathematics/checkLean.ts')], outfile: cli, bundle: true,
      define: tacticBatteryCacheTestDefines(path.join(bundleRoot, 'tactic-cache')), platform: 'node', format: 'cjs',
      loader: { '.py': 'text', '.lean': 'text' }, logLevel: 'silent' });
  });
  afterAll(() => fs.rmSync(bundleRoot, { recursive: true, force: true }));
  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || '/data/lzh/default-storage/tmp', 'lean-health-')));
    workspace = path.join(root, 'work'); profile = path.join(root, 'profile'); tools = path.join(root, 'tools');
    dependencies = path.join(root, 'deps'); mount = path.join(dependencies, 'mount');
    for (const directory of [workspace, profile, tools, mount]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'lean-toolchain'), 'leanprover/lean4:v4.33.0\n');
    fs.writeFileSync(path.join(workspace, 'Submission.lean'), 'theorem unfinished : False := by trivial\n');
    const warning = JSON.stringify({ severity: 'warning', data: 'context '.repeat(1500), fileName: 'Submission.lean', pos: { line: 1, column: 0 } });
    const error = JSON.stringify({ severity: 'error', data: 'unsolved goals\n⊢ False', fileName: 'Submission.lean', pos: { line: 1, column: 42 } });
    fs.writeFileSync(path.join(tools, 'lean'), '#!/bin/sh\nif [ "$1" = "--version" ]; then\n' +
      "printf '%s\\n' 'Lean (version 4.33.0, fixture)'\nexit 0\nfi\n" +
      `printf '%s\\n' ${quote(warning)} ${quote(error)}\nexit 1\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(tools, 'lake'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const metadata = canonicalMathJson({ schema: 'deepscientist.math.proof-environment-inputs.v1',
      sourceCacheRoot: dependencies, config: mathProofEnvironmentConfiguration(workspace),
      sourceIdentity: 'a'.repeat(64), stats: { files: 0, bytes: 0, publications: 1 } });
    fs.writeFileSync(path.join(mount, MATH_PROOF_ENVIRONMENT_METADATA), metadata);
    const stat = fs.statSync(mount, { bigint: true }), metadataHash = mathDigest(metadata), imageSha256 = 'b'.repeat(64);
    const identity = mathDigest(canonicalMathJson({ metadataHash, imageSha256 }));
    const leaseSocket = path.join(root, 'lease.sock'), leaseToken = 'disposable-test-token';
    // An unreachable host PID exercises the sandbox mapping branch. This disposable fixture grants no proof acceptance.
    const descriptor = { schema: 'deepscientist.math.proof-environment.v1', pid: 2147483647, rootFd: 123,
      rootPath: '/proc/2147483647/fd/123', device: String(stat.dev), inode: String(stat.ino), startTime: '1',
      imageSha256, imageBytes: 1, seals: 15, metadataHash, identity,
      stats: { files: 0, bytes: 0, publications: 1 }, leaseSocket, leaseToken };
    env = { PATH: tools, DEEPSCIENTIST_MATH_ENV_FILE: path.join(root, 'absent.env'),
      [MATH_PROOF_ENVIRONMENT_ENV]: JSON.stringify(descriptor),
      [MATH_PROOF_ENVIRONMENT_SANDBOX_ENV]: JSON.stringify({
        schema: 'deepscientist.math.proof-environment-sandbox.v1', identity, rootPath: mount, leaseSocket }) };
    requests = 0;
    server = net.createServer(socket => socket.once('data', bytes => {
      requests++;
      socket.write(JSON.stringify({ ok: JSON.parse(String(bytes)).token === leaseToken }) + '\n');
    }));
    await new Promise<void>((resolve, reject) => server.listen(leaseSocket, resolve).once('error', reject));
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const options = () => ({ workspace, profile, proofProjectRoot: workspace, environment: env, isolateProcess: true,
    leanHealthCheck: { executable: process.execPath, arguments: [cli, '--workspace', workspace, '--health', '--timeout-seconds', '0'] } });
  function runCli(arguments_: string[]) {
    return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, '--workspace', workspace, ...arguments_], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += String(bytes); });
      child.stderr.on('data', bytes => { stderr += String(bytes); });
      child.once('error', reject);
      child.once('close', exitCode => resolve({ exitCode, stdout, stderr }));
    });
  }

  it('checks the mapped environment and real lease without compiling a source or publishing advisory metadata', async () => {
    expect(await checkLeanEnvironmentHealth({ projectRoot: workspace, env })).toMatchObject({
      status: 'ready', exitCode: 0, leanStarted: false, proofEnvironment: 'sealed', toolchain: 'leanprover/lean4:v4.33.0' });
    expect(requests).toBe(1);
    expect(fs.existsSync(path.join(workspace, '.lake'))).toBe(false);
  });

  it('runs the probe inside the actual worker namespace despite the invisible host PID', async () => {
    const result = await runHarnessLeanHealthCheck(options());
    expect(result).toMatchObject({ status: 'ready', exitCode: 0, proofEnvironment: 'sealed', leanStarted: false });
    expect(requests).toBe(1);
    expect(fs.existsSync(path.join(workspace, '.lake/lean-diagnostics-latest.json'))).toBe(false);
  });

  it('classifies a masked mount as infrastructure even while the same host binding and lease stay healthy', async () => {
    let failure: unknown;
    try { await runHarnessLeanHealthCheck({ ...options(), hiddenRoots: [dependencies] }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(LeanEnvironmentHealthCheckError);
    const health = (failure as LeanEnvironmentHealthCheckError).health;
    expect(health).toMatchObject({ status: 'infrastructure-error', classification: 'infrastructure', exitCode: 1,
      leanStarted: false, error: { stage: 'proof-environment', code: 'math_lean_proof_environment_unavailable',
        message: expect.stringContaining('ENOENT'), retry: 'after-environment-repair' } });
    expect(health.error?.recovery).toContain('do not infer host liveness');
    expect(health.error?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(requests).toBe(0);
    expect((await checkLeanEnvironmentHealth({ projectRoot: workspace, env })).status).toBe('ready');
    expect(requests).toBe(1);
  });

  it('reports an unavailable lease separately from compiler errors', async () => {
    const mapping = JSON.parse(env[MATH_PROOF_ENVIRONMENT_SANDBOX_ENV]!);
    const result = await checkLeanEnvironmentHealth({ projectRoot: workspace,
      env: { ...env, [MATH_PROOF_ENVIRONMENT_SANDBOX_ENV]: JSON.stringify({ ...mapping, leaseSocket: path.join(root, 'absent.sock') }) } });
    expect(result).toMatchObject({ status: 'infrastructure-error', leanStarted: false,
      error: { stage: 'lease', code: 'math_lean_lease_unavailable', retry: 'after-environment-repair' } });
  });

  it('keeps startup failures machine readable on stdout and fails before compiler output', async () => {
    fs.rmSync(mount, { recursive: true });
    const result = await runCli(['--file', 'Submission.lean']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'infrastructure-error', classification: 'infrastructure',
      leanStarted: false, error: { stage: 'proof-environment', message: expect.stringContaining('ENOENT') } });
    expect(result.stderr).not.toContain('lean_check_started');
    expect(fs.existsSync(path.join(workspace, '.lake/lean-diagnostics-latest.json'))).toBe(false);
  });

  it('preserves a failing compiler exit and complete Lean errors even when its preview is truncated', async () => {
    const result = await runCli(['--file', 'Submission.lean']);
    expect(result.exitCode).toBe(1);
    const diagnostics = JSON.parse(result.stdout);
    expect(diagnostics).toMatchObject({ classification: 'lean', exitCode: 1, timedOut: false, previewTruncated: true,
      firstBlocking: { severity: 'error', file: 'Submission.lean', goalText: '⊢ False' } });
    expect(result.stderr).toContain('lean_check_started');
    expect(diagnostics.diagnosticArtifacts).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(workspace, diagnostics.diagnosticArtifacts[0].path), 'utf8'))).toMatchObject({
      exitCode: 1, captureComplete: true, messages: [{ severity: 'warning' }, { severity: 'error' }] });
    expect(JSON.parse(fs.readFileSync(path.join(workspace, '.lake/lean-diagnostics-latest.json'), 'utf8')).exitCode).toBe(1);
    expect(fs.existsSync(path.join(workspace, '.lake/lean-diagnostics.json'))).toBe(false);
  });

  it('rejects successful exit with a malformed readiness report', async () => {
    await expect(runHarnessLeanHealthCheck({ ...options(), leanHealthCheck: { executable: '/bin/echo', arguments: ['{}'] } }))
      .rejects.toMatchObject({ diagnostic: { code: 'math_lean_environment_unavailable' } });
  });

  it('rejects an unhealthy namespace before starting the native RPC or a model request', async () => {
    const started = path.join(workspace, 'native-started'), executable = path.join(tools, 'native');
    fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s' started > ${quote(started)}\nexit 99\n`, { mode: 0o700 });
    await expect(createCodexMathSession({ ...options(), executable, proofProjectRoot: workspace,
      hiddenRoots: [dependencies], model: 'fixture', effort: 'high', instructions: 'fixture', onUsage: () => {} }))
      .rejects.toMatchObject({ diagnostic: { stage: 'proof-environment' } });
    expect(fs.existsSync(started)).toBe(false);
    expect(requests).toBe(0);
  });

  it('keeps an unavailable requested source distinct from a sealed environment fault', async () => {
    const result = await runCli(['--file', 'Missing.lean']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'source-error', classification: 'source', leanStarted: false });
    expect(requests).toBe(0);
  });

  it('rejects a missing descriptor when the supplied sandbox mapping requires a sealed environment', async () => {
    const missingDescriptor = { ...env };
    delete missingDescriptor[MATH_PROOF_ENVIRONMENT_ENV];
    await expect(runHarnessLeanHealthCheck({ ...options(), environment: missingDescriptor }))
      .rejects.toMatchObject({ diagnostic: { stage: 'proof-environment', message: expect.stringContaining('without a sealed proof environment descriptor') } });
  });

  it.each(['sealed', 'unbound'] as const)('records %s namespace health before native startup and retains it in the session receipt', async binding => {
    const started = path.join(workspace, 'native-started'), executable = path.join(tools, 'native');
    fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(started)}, 'started');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const call = JSON.parse(line), settings = call.params;
  if (call.id === undefined) return;
  const result = call.method === 'thread/start' ? { thread: { id: 'health-fixture' },
    model: settings.model, reasoningEffort: settings.config.model_reasoning_effort, approvalPolicy: settings.approvalPolicy,
    activePermissionProfile: { id: settings.config.default_permissions } } : {};
  process.stdout.write(JSON.stringify({ id: call.id, result }) + '\\n');
});\n`, { mode: 0o700 });
    const events: string[] = [], environment = { ...env };
    if (binding === 'unbound') {
      delete environment[MATH_PROOF_ENVIRONMENT_ENV]; delete environment[MATH_PROOF_ENVIRONMENT_SANDBOX_ENV];
    }
    const session = await createCodexMathSession({ ...options(), executable, environment,
      model: 'fixture', effort: 'high', instructions: 'fixture', onUsage: () => {},
      onActivity: activity => {
        events.push(activity.event);
        if (activity.event === 'lean_environment_ready') {
          expect(fs.existsSync(started)).toBe(false);
          expect(activity.health).toMatchObject({ status: 'ready', proofEnvironment: binding, leanStarted: false });
        }
      } });
    try {
      expect(events).toEqual(['lean_environment_ready']);
      expect(session.isolationReceipt?.leanEnvironmentHealth).toMatchObject({ status: 'ready', proofEnvironment: binding, projectRoot: workspace });
      expect(fs.existsSync(started)).toBe(true);
    } finally { await session.close(); }
  });

  it('requires the exact configured proof project for a legitimate unbound stdlib environment', async () => {
    const environment = { ...env };
    delete environment[MATH_PROOF_ENVIRONMENT_ENV]; delete environment[MATH_PROOF_ENVIRONMENT_SANDBOX_ENV];
    await expect(runHarnessLeanHealthCheck({ ...options(), environment, proofProjectRoot: root }))
      .rejects.toMatchObject({ diagnostic: { stage: 'proof-environment', message: 'Health probe did not verify the configured proof project' } });
  });
});
