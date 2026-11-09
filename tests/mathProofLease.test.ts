import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acquireMathProofEnvironmentLease, MATH_PROOF_ENVIRONMENT_ENV,
  MATH_PROOF_ENVIRONMENT_SANDBOX_ENV } from '../src/math/mathProofEnvironment';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';

let directory: string, project: string, env: NodeJS.ProcessEnv, server: net.Server;
const sockets: net.Socket[] = [];

beforeEach(async () => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proof-lease-deadline-')));
  project = path.join(directory, 'project');
  const packages = path.join(directory, 'packages'), leaseSocket = path.join(directory, 'lease.sock');
  fs.mkdirSync(project); fs.mkdirSync(packages);
  const stats = { files: 0, bytes: 0, publications: 1 };
  const metadata = canonicalMathJson({ schema: 'deepscientist.math.proof-environment-inputs.v1',
    sourceCacheRoot: packages, sourceIdentity: 'a'.repeat(64), stats,
    config: Object.fromEntries(['lean-toolchain', 'lakefile.toml', 'lakefile.lean', 'lake-manifest.json',
      '.lake/package-overrides.json'].map(file => [file, null])) });
  fs.writeFileSync(path.join(packages, '.deepscientist-proof-environment.json'), metadata);
  const metadataHash = mathDigest(metadata), imageSha256 = 'b'.repeat(64);
  const identity = mathDigest(canonicalMathJson({ metadataHash, imageSha256 }));
  const stat = fs.statSync(packages, { bigint: true });
  env = {
    [MATH_PROOF_ENVIRONMENT_ENV]: JSON.stringify({ schema: 'deepscientist.math.proof-environment.v1',
      pid: process.pid, rootFd: 0, rootPath: `/proc/${process.pid}/fd/0`, startTime: 'fixture',
      device: String(stat.dev), inode: String(stat.ino), imageSha256, imageBytes: 1, seals: 15,
      metadataHash, identity, stats, leaseSocket, leaseToken: 'disposable-fixture-token' }),
    [MATH_PROOF_ENVIRONMENT_SANDBOX_ENV]: JSON.stringify({ schema: 'deepscientist.math.proof-environment-sandbox.v1',
      identity, rootPath: packages, leaseSocket }),
  };
  server = net.createServer(socket => { sockets.push(socket); socket.on('data', () => {}); });
  await new Promise<void>(resolve => server.listen(leaseSocket, resolve));
});

afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(directory, { recursive: true, force: true });
});

it.each([
  { remaining: 1_800_000, timer: 5000, kind: 'handshake' },
  { remaining: 1000, timer: 1000, kind: 'operation-deadline' },
  { remaining: 0, timer: 0, kind: 'operation-deadline' },
])('attributes a lease timeout to its governing deadline: $kind ($remaining ms)', async ({ remaining, timer, kind }) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const pending = acquireMathProofEnvironmentLease(project, env, undefined, 1000 + remaining);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'MathProofEnvironmentLeaseTimeoutError', kind });
  // A delayed event loop must not turn the original handshake deadline into an operation timeout.
  clock.mockReturnValue(2_000_000);
  await vi.advanceTimersByTimeAsync(timer);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves cancellation while waiting for the lease acknowledgement', async () => {
  const controller = new AbortController();
  const pending = acquireMathProofEnvironmentLease(project, env, controller.signal, Date.now() + 1_800_000);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
});
