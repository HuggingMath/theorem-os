import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareHarnessProcess } from '../src/runtime/harnessProcess';

describe('shared native harness process isolation', () => {
  let root: string, workspace: string, profile: string, outside: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || '/data/lzh/default-storage/tmp', 'harness-isolation-')));
    [workspace, profile, outside] = ['work', 'profile', 'outside'].map(name => path.join(root, name));
    for (const directory of [workspace, profile, outside]) fs.mkdirSync(directory);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
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
});
