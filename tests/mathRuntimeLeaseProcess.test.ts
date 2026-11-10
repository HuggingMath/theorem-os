import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { withMathRuntimeLease } from '../src/math/mathRuntimeIo';

const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* This owned process group already exited. */ }
    child.stdout?.destroy(); child.stderr?.destroy();
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function competingLock(lockPath: string) {
  const result = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', lockPath, '/usr/bin/true'],
    { timeout: 5000 });
  if (result.error) throw result.error;
  return result.status;
}

async function start(inherit: boolean) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-lease-process-')));
  roots.push(root);
  const executable = path.join(root, 'owner.cjs'), lockPath = path.join(root, 'run.lock');
  // Bundle the actual lease implementation, then kill its separate process without running finally.
  buildSync({ stdin: { contents: `
    import { withMathRuntimeLease } from './src/math/mathRuntimeIo';
    import { spawn } from 'node:child_process';
    withMathRuntimeLease({ lockPath: process.argv[2], flockExecutable: '/usr/bin/flock' }, async lease => {
      if (process.argv[3] === 'inherit') spawn(process.execPath,
        ['-e', 'process.stdout.write("supervisor-ready\\\\n"); setInterval(() => {}, 1000)'],
        { stdio: ['ignore', 1, 2, lease.inheritedDescriptor] });
      else process.stdout.write('owner-ready\\n');
      await new Promise(() => setInterval(() => {}, 1000));
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `, resolveDir: process.cwd(), loader: 'ts' }, outfile: executable, bundle: true, platform: 'node', format: 'cjs' });
  const child = spawn(process.execPath, [executable, lockPath, inherit ? 'inherit' : 'owner'],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => finish(new Error(`Lease owner did not become ready: ${stderr}`)), 5000);
    const data = () => finish();
    const exited = () => finish(new Error(`Lease owner exited before readiness: ${stderr}`));
    const failed = (error: Error) => finish(error);
    const finish = (error?: Error) => {
      clearTimeout(deadline); child.stdout!.off('data', data); child.off('exit', exited); child.off('error', failed);
      error ? reject(error) : resolve();
    };
    child.stdout!.once('data', data); child.once('exit', exited); child.once('error', failed);
  });
  expect(competingLock(lockPath)).toBe(73);
  return { child, lockPath };
}

describe.skipIf(process.platform !== 'linux')('runtime lease across actual process death', () => {
  it('releases a crashed owner lock and permits a fresh operation without deleting the lock file', async () => {
    const { child, lockPath } = await start(false), inode = fs.statSync(lockPath).ino;
    const exited = once(child, 'exit');
    child.kill('SIGKILL'); await exited;
    expect(competingLock(lockPath)).toBe(0);
    await expect(withMathRuntimeLease({ lockPath, flockExecutable: '/usr/bin/flock' }, async lease => {
      lease.assertHeld(); expect(competingLock(lockPath)).toBe(73); return 'recovered';
    })).resolves.toBe('recovered');
    expect(fs.statSync(lockPath).ino).toBe(inode);
  });

  it('retains the explicitly inherited supervisor lock until the last owning process exits', async () => {
    const { child, lockPath } = await start(true);
    const exited = once(child, 'exit');
    child.kill('SIGKILL'); await exited;
    expect(competingLock(lockPath)).toBe(73);
    process.kill(-child.pid!, 'SIGKILL');
    const deadline = Date.now() + 5000;
    while (competingLock(lockPath) === 73 && Date.now() < deadline) await delay(10);
    expect(competingLock(lockPath)).toBe(0);
  });
});
