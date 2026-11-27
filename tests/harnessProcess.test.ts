import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmHarnessProcessStopped, prepareHarnessProcess, type HarnessProcessIdentity } from '../src/runtime/harnessProcess';

function processIdentity(pid: number): HarnessProcessIdentity {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return { schema: 'theorem-os.harness-process-identity.v1', pid,
    startTime: stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19]!,
    bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    pidNamespace: fs.readlinkSync(`/proc/${pid}/ns/pid`) };
}

describe('shared native harness process isolation', () => {
  let root: string, workspace: string, profile: string, outside: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || '/data/lzh/default-storage/tmp', 'harness-isolation-')));
    [workspace, profile, outside] = ['work', 'profile', 'outside'].map(name => path.join(root, name));
    for (const directory of [workspace, profile, outside]) fs.mkdirSync(directory);
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
  function run(code: string, hiddenRoots: string[] = [], environment: NodeJS.ProcessEnv = process.env) {
    const launch = prepareHarnessProcess({ workspace, profile, hiddenRoots, environment }, process.execPath, ['-e', code]);
    return { ...spawnSync(launch.command, launch.args, { env: launch.env, encoding: 'utf8', timeout: 10_000 }), launch };
  }

  it('permits work, profile and temp writes while denying unrelated host writes', () => {
    const result = run(`const fs=require('fs');
      fs.writeFileSync(${JSON.stringify(path.join(workspace, 'proof.lean'))}, 'draft');
      fs.writeFileSync(${JSON.stringify(path.join(profile, 'session'))}, 'saved');
      fs.writeFileSync(process.env.TMPDIR+'/temporary', 'ok');
      try { fs.writeFileSync(${JSON.stringify(path.join(outside, 'escape'))}, 'bad'); process.exit(9); }
      catch (e) { if (e.code !== 'EROFS' && e.code !== 'EACCES') throw e; }`);
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(workspace, 'proof.lean'), 'utf8')).toBe('draft');
    expect(fs.existsSync(path.join(outside, 'escape'))).toBe(false);
    expect(result.launch.isolationReceipt).toMatchObject({ backend: 'bwrap', pidNamespace: true });
  });

  it('masks directory and file contents from arbitrary shell children', () => {
    const secret = path.join(outside, 'secret'), directory = path.join(outside, 'private');
    fs.mkdirSync(directory); fs.writeFileSync(secret, 'hidden file'); fs.writeFileSync(path.join(directory, 'canary'), 'hidden directory');
    const result = run(`const fs=require('fs'), cp=require('child_process');
      try { if(fs.readFileSync(${JSON.stringify(secret)},'utf8')!=='') process.exit(7); }
      catch(e) { if(e.code!=='EACCES' && e.code!=='EPERM') throw e; }
      if(fs.readdirSync(${JSON.stringify(directory)}).length!==0) process.exit(8);
      const child=cp.spawnSync('/bin/cat',[${JSON.stringify(path.join(directory, 'canary'))}]);
      if(child.status===0) process.exit(9);`, [secret, directory]);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(secret, 'utf8')).toBe('hidden file');
  });

  it('allows planning notes while the proof workspace and repository metadata are read-only', () => {
    const proof = path.join(workspace, 'proof.lean');
    const gitDirectory = path.join(workspace, '.git');
    fs.writeFileSync(proof, 'theorem proposed : True := by sorry');
    fs.mkdirSync(gitDirectory);
    const launch = prepareHarnessProcess({ workspace, profile, readOnlyWorkspace: true },
      process.execPath, ['-e', `
        const fs = require('fs'), path = require('path');
        for (const file of ['proof.lean', 'new.lean', '.git/HEAD']) {
          try { fs.writeFileSync(file, 'bad'); process.exit(9); }
          catch (error) { if (error.code !== 'EROFS' && error.code !== 'EACCES') throw error; }
        }
        fs.writeFileSync(path.join(path.dirname(process.env.TMPDIR), 'plan.md'), 'route notes');
      `]);
    const result = spawnSync(launch.command, launch.args, { env: launch.env, encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(proof, 'utf8')).toContain('sorry');
    expect(fs.readFileSync(path.join(workspace, '.scratch', 'plan.md'), 'utf8')).toBe('route notes');
  });

  it('lets a Mathlib writer start a nested sandbox without exposing its hidden roots', () => {
    const canary = path.join(outside, 'canary');
    fs.writeFileSync(canary, 'private');
    const moduleFile = fileURLToPath(new URL('../src/runtime/harnessProcess.ts', import.meta.url));
    const result = spawnSync('/usr/bin/bwrap', ['--die-with-parent', '--unshare-user', '--uid', '0', '--gid', '0',
      '--cap-add', 'CAP_SYS_ADMIN', '--cap-add', 'CAP_SETFCAP', '--bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc',
      '--', 'bun', '-e', `
        import { spawnSync } from 'node:child_process';
        import { prepareHarnessProcess } from ${JSON.stringify(moduleFile)};
        const workspace = ${JSON.stringify(workspace)};
        const launch = prepareHarnessProcess({ workspace, profile: ${JSON.stringify(profile)}, hiddenRoots: [${JSON.stringify(outside)}] },
          '/usr/bin/bwrap', ['--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-net',
            '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--cap-drop', 'ALL', '--bind', workspace, workspace,
            '--', '/bin/sh', '-ec', 'test ! -r "$1"; printf draft > proof.lean', 'nested', ${JSON.stringify(canary)}]);
        process.exit(spawnSync(launch.command, launch.args, { env: launch.env, stdio: 'inherit' }).status ?? 1);
      `], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(workspace, 'proof.lean'), 'utf8')).toBe('draft');
  });

  it('masks a missing hidden path at its existing parent and rejects workspace overlap', () => {
    const missing = path.join(outside, 'future', 'cache');
    const result = run(`if(require('fs').readdirSync(${JSON.stringify(outside)}).length)process.exit(9);`, [missing]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.launch.isolationReceipt.hiddenRoots).toEqual(expect.arrayContaining([outside]));
    expect(() => run('', [path.join(root, 'future')])).toThrow('math_harness_hidden_root_conflict');
    expect(() => prepareHarnessProcess({ workspace, profile: path.join(workspace, 'profile') }, '/bin/true', []))
      .toThrow();
  });

  it('exposes only the explicitly pinned Lean lock as writable outside the worktree', () => {
    const lock = path.join(outside, 'lean.lock'); fs.writeFileSync(lock, '');
    const result = run(`require('fs').appendFileSync(${JSON.stringify(lock)}, 'locked');`, [],
      { ...process.env, DEEPSCIENTIST_MATH_LEAN_LOCK: lock });
    expect(result.status, result.stderr).toBe(0); expect(fs.readFileSync(lock, 'utf8')).toBe('locked');
    expect(() => run('', [outside], { ...process.env, DEEPSCIENTIST_MATH_LEAN_LOCK: lock }))
      .toThrow('math_harness_lean_lock_invalid');
  });

  it('hides existing and future peers while rebinding only the member workspace', async () => {
    const members = path.join(outside, 'members'), sibling = path.join(members, 'peer'), future = path.join(members, 'later');
    workspace = path.join(members, 'own');
    fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'proof.lean'), 'unpublished peer proof');
    fs.writeFileSync(path.join(workspace, 'proof.lean'), 'own draft');
    const ready = path.join(profile, 'ready'), go = path.join(profile, 'go');
    const launch = prepareHarnessProcess({ workspace, profile, isolatedWorkspaceParent: members }, process.execPath, ['-e', `
      const fs=require('fs');
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      const timer=setInterval(() => {
        if(!fs.existsSync(${JSON.stringify(go)}))return;
        clearInterval(timer);
        if(fs.readdirSync(${JSON.stringify(members)}).join()!=='own')process.exit(7);
        for(const peer of ${JSON.stringify([sibling, future])}) {
          try { fs.readFileSync(peer+'/proof.lean'); process.exit(8); }
          catch(e) { if(e.code!=='ENOENT' && e.code!=='EACCES')throw e; }
        }
        fs.appendFileSync(${JSON.stringify(path.join(workspace, 'proof.lean'))}, ' continued');
      }, 10);`]);
    const child = spawn(launch.command, launch.args, { env: launch.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
    const exited = new Promise<number | null>(resolve => child.once('close', resolve));
    try {
      await vi.waitFor(() => expect(fs.existsSync(ready), stderr).toBe(true));
      fs.mkdirSync(future); fs.writeFileSync(path.join(future, 'proof.lean'), 'new peer proof');
      fs.writeFileSync(go, 'go');
      expect(await exited, stderr).toBe(0);
      expect(fs.readFileSync(path.join(workspace, 'proof.lean'), 'utf8')).toBe('own draft continued');
      expect(launch.isolationReceipt.hiddenRoots).toContain(members);
      expect(() => prepareHarnessProcess({ workspace, profile, isolatedWorkspaceParent: outside }, '/bin/true', []))
        .toThrow('math_harness_workspace_parent_invalid');
    } finally { child.kill('SIGKILL'); await exited; }
  });

  it('confirms an actual writer that exits between reading its status and namespace', async () => {
    // This supervisor reaps the writer independently of the observing host.
    const supervisor = spawn('/bin/sh', ['-c', 'sleep 30 & task_writer=$!; printf "%s\\n" "$task_writer"; wait "$task_writer"'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = new Promise<void>(resolve => supervisor.once('close', () => resolve()));
    const writerPid = Number(await new Promise<string>(resolve => supervisor.stdout.once('data', bytes => resolve(String(bytes).trim()))));
    const identity = processIdentity(writerPid);
    const readlink = fs.readlinkSync.bind(fs);
    let stoppedInWindow = false;
    let killed: ReturnType<typeof spawnSync> | undefined;
    const spy = vi.spyOn(fs, 'readlinkSync').mockImplementation((...args) => {
      if (args[0] === `/proc/${writerPid}/ns/pid` && !stoppedInWindow) {
        stoppedInWindow = true;
        killed = spawnSync(process.execPath, ['-e', `
          const fs = require('node:fs'), pid = Number(process.argv[1]);
          process.kill(pid, 'SIGKILL');
          const deadline = Date.now() + 1000;
          for (;;) {
            try { fs.readlinkSync('/proc/' + pid + '/ns/pid'); }
            catch (error) {
              if (error.code === 'ENOENT' || error.code === 'ESRCH') break;
              // A dying process can briefly deny namespace access before its
              // supervisor reaps it. Keep waiting for disappearance.
              if (error.code !== 'EACCES') throw error;
            }
            if (Date.now() >= deadline) process.exit(1);
          }
        `, String(writerPid)], { encoding: 'utf8', timeout: 3000 });
      }
      return readlink(...args);
    });
    try {
      const result = confirmHarnessProcessStopped(identity);
      expect(killed?.status, String(killed?.stderr)).toBe(0);
      expect(result).toEqual({ status: 'stopped' });
      expect(stoppedInWindow).toBe(true);
    } finally {
      spy.mockRestore();
      try { process.kill(writerPid, 'SIGKILL'); } catch { /* The disposable writer was already reaped. */ }
      supervisor.kill('SIGKILL'); await exited;
    }
  });

  it.each(['ENOENT', 'ESRCH'])('keeps a live process unconfirmed when its namespace returns %s', code => {
    const identity = processIdentity(process.pid);
    const readlink = fs.readlinkSync.bind(fs);
    vi.spyOn(fs, 'readlinkSync').mockImplementation((...args) => {
      if (args[0] === `/proc/${process.pid}/ns/pid`)
        throw Object.assign(new Error('temporarily unavailable namespace'), { code });
      return readlink(...args);
    });
    expect(confirmHarnessProcessStopped(identity)).toMatchObject({ status: 'unconfirmed' });
  });
});
