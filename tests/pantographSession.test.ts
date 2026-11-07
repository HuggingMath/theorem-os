import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { MATH_PROOF_ENVIRONMENT_SANDBOX_ENV } from '../src/math/mathProofEnvironment';
import { openPantographSession, PANTOGRAPH_DIGEST_ENV, PANTOGRAPH_MANIFEST_ENV, PANTOGRAPH_SOURCE_COMMIT,
  readPantographBackend, type ProofSearchSession } from '../src/math/pantographSession';

const lease = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn() }));
vi.mock('../src/math/mathProofEnvironment', () => ({
  MATH_PROOF_ENVIRONMENT_SANDBOX_ENV: 'DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT_SANDBOX',
  acquireMathProofEnvironmentLease: lease.acquire,
}));

// This is a disposable Node protocol child, never Lean or a downloaded backend.
const program = `import fs from 'node:fs';
import readline from 'node:readline';
fs.writeFileSync(process.env.FIXTURE_PID, String(process.pid));
const mode = process.env.FIXTURE_MODE;
if (mode !== 'no-ready') process.stdout.write('ready.\\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  if (mode === 'silent' || mode === 'no-ready') return;
  const request = JSON.parse(line);
  if (mode === 'invalid') { process.stdout.write('not-json\\n'); return; }
  if (mode === 'overflow') { process.stdout.write('x'.repeat(4000001)); return; }
  if (request.cmd === 'error') { process.stdout.write(JSON.stringify({error:'invalid',desc:'fixture tactic failed'})+'\\n'); return; }
  const bytes = Buffer.from(JSON.stringify({ echoed: request, text: '∀ α → α' }) + '\\n');
  if (mode === 'split') {
    const start = bytes.indexOf(Buffer.from('∀'));
    process.stdout.write(bytes.subarray(0, start + 1));
    setTimeout(() => process.stdout.write(bytes.subarray(start + 1)), 10);
  } else if (mode === 'slow') setTimeout(() => process.stdout.write(bytes), 50);
  else process.stdout.write(bytes);
});
`;

let directory: string, project: string, packages: string, manifestPath: string, executable: string;
let sessions: ProofSearchSession[];
function manifest(overrides: Record<string, unknown> = {}) {
  const value = {
    schema: 'theorem-os.pantograph-backend.v1', sourceCommit: PANTOGRAPH_SOURCE_COMMIT,
    toolchain: 'leanprover/lean4:v4.33.1', executable: 'fixture.mjs', libraryDirectories: ['lib'],
    files: ['fixture.mjs', 'lib/Fake.olean'].map(file => ({ path: file, sha256: mathDigest(fs.readFileSync(path.join(directory, file))) })),
    ...overrides,
  };
  fs.writeFileSync(manifestPath, canonicalMathJson(value));
  return value;
}
function environment(mode = 'echo'): NodeJS.ProcessEnv {
  return { ...process.env, [PANTOGRAPH_MANIFEST_ENV]: manifestPath, [PANTOGRAPH_DIGEST_ENV]: undefined,
    [MATH_PROOF_ENVIRONMENT_SANDBOX_ENV]: 'fixture', DEEPSCIENTIST_MATH_LEAN_LOCK: undefined,
    FIXTURE_PID: path.join(directory, 'child.pid'), FIXTURE_MODE: mode };
}
async function open(mode = 'echo', timeoutMs = 5000, controller = new AbortController()) {
  const env = environment(mode), backend = readPantographBackend(env)!;
  const session = await openPantographSession({ project, backend, env, signal: controller.signal,
    deadlineAt: Date.now() + timeoutMs });
  sessions.push(session); return session;
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pantograph-session-'));
  project = path.join(directory, 'project'); packages = path.join(directory, 'packages');
  fs.mkdirSync(project); fs.mkdirSync(packages); fs.mkdirSync(path.join(directory, 'lib'));
  executable = path.join(directory, 'fixture.mjs'); manifestPath = path.join(directory, 'backend.json');
  fs.writeFileSync(executable, `#!${process.execPath}\n` + program, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'lib/Fake.olean'), 'fixture bytes, not a compiled module');
  manifest(); sessions = [];
  lease.release.mockReset().mockResolvedValue(undefined);
  lease.acquire.mockReset().mockResolvedValue({ packagesRoot: packages, release: lease.release });
});
afterEach(async () => {
  await Promise.all(sessions.map(session => session.close()));
  const pidFile = path.join(directory, 'child.pid');
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('pinned Pantograph artifact manifest', () => {
  it('accepts the two pinned build toolchains and rejects unbuilt versions', () => {
    const digests = new Set<string>();
    for (const version of ['4.33.0', '4.33.1']) {
      const toolchain = `leanprover/lean4:v${version}`;
      manifest({ toolchain });
      const backend = readPantographBackend(environment())!;
      expect(backend.toolchain).toBe(toolchain);
      digests.add(backend.digest);
    }
    expect(digests.size).toBe(2);
    manifest({ toolchain: 'leanprover/lean4:v4.33.2' });
    expect(() => readPantographBackend(environment())).toThrow();
  });

  it('requires explicit configuration and binds the manifest and every listed artifact', () => {
    expect(readPantographBackend({})).toBeUndefined();
    const env = environment(), backend = readPantographBackend(env)!;
    expect(backend.executable).toBe(executable);
    expect(readPantographBackend({ ...env, [PANTOGRAPH_DIGEST_ENV]: backend.digest })!.digest).toBe(backend.digest);
    expect(() => readPantographBackend({ ...env, [PANTOGRAPH_DIGEST_ENV]: '0'.repeat(64) })).toThrow('proof_search_backend_identity_changed');
    fs.appendFileSync(path.join(directory, 'lib/Fake.olean'), ' changed');
    expect(() => backend.verify()).toThrow('proof_search_backend_changed');
  });

  it('rejects a changed manifest, unlisted library files and path traversal', () => {
    const backend = readPantographBackend(environment())!;
    fs.appendFileSync(manifestPath, '\n');
    expect(() => backend.verify()).toThrow('proof_search_backend_changed');
    manifest(); fs.writeFileSync(path.join(directory, 'lib/Unlisted.olean'), 'unexpected');
    expect(() => readPantographBackend(environment())).toThrow('proof_search_backend_unlisted_artifact');
    manifest({ executable: '../fixture.mjs' });
    expect(() => readPantographBackend(environment())).toThrow();
  });

  it('rejects a different source version and linked artifacts', () => {
    manifest({ sourceCommit: 'f'.repeat(40) });
    expect(() => readPantographBackend(environment())).toThrow();
    manifest();
    const original = path.join(directory, 'original.mjs');
    fs.renameSync(executable, original); fs.symlinkSync(original, executable);
    expect(() => readPantographBackend(environment())).toThrow();
  });
});

describe('bounded Pantograph stdio session', () => {
  it('decodes split UTF-8 and continues after a normal backend command error', async () => {
    const session = await open('split');
    expect(await session.request('goal.print', { stateId: 0 })).toMatchObject({
      echoed: { cmd: 'goal.print', payload: { stateId: 0 } }, text: '∀ α → α',
    });
    await expect(session.request('error', {})).rejects.toThrow('fixture tactic failed');
    expect(await session.request('stat', {})).toMatchObject({ echoed: { cmd: 'stat' } });
  });

  it('rejects overlapping requests without corrupting the first response', async () => {
    const session = await open('slow');
    const first = session.request('first', {});
    await expect(session.request('second', {})).rejects.toThrow('proof_search_concurrent_request');
    expect(await first).toMatchObject({ echoed: { cmd: 'first' } });
    expect(await session.request('third', {})).toMatchObject({ echoed: { cmd: 'third' } });
  });

  it('does not leave a pending slot after a non-JSON request', async () => {
    const session = await open();
    await expect(session.request('bad', { value: BigInt(1) })).rejects.toThrow();
    expect(await session.request('stat', {})).toMatchObject({ echoed: { cmd: 'stat' } });
  });

  it('bounds missing readiness without requiring the caller to create an abort timer', async () => {
    await expect(open('no-ready', 100)).rejects.toThrow('proof_search_deadline');
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('bounds a pending response and shares cleanup among simultaneous close callers', async () => {
    const session = await open('silent', 500);
    await expect(session.request('goal.tactic', {})).rejects.toThrow('proof_search_deadline');
    const first = session.close(), second = session.close();
    expect(first).toBe(second);
    await first;
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('releases an acquired lease when project preparation fails before spawning', async () => {
    fs.rmSync(packages, { recursive: true });
    await expect(open()).rejects.toThrow();
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(directory, 'child.pid'))).toBe(false);
  });

  it.each(['invalid', 'overflow'])('closes the process after %s protocol output', async mode => {
    const session = await open(mode);
    await expect(session.request('stat', {})).rejects.toThrow();
    await session.close();
    expect(lease.release).toHaveBeenCalledTimes(1);
    await expect(session.request('stat', {})).rejects.toThrow();
  });

  it('cancels a pending request and releases the process lease', async () => {
    const controller = new AbortController(), session = await open('silent', 5000, controller);
    const pending = session.request('goal.tactic', {});
    const rejected = expect(pending).rejects.toThrow();
    controller.abort(); await rejected;
    await session.close(); expect(lease.release).toHaveBeenCalledTimes(1);
  });
});
