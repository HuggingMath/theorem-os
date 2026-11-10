#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Build-time only: use the worker's installed Lean, never a prebuilt Pantograph binary.
const sourceCommit = '0ee70917fb93a5421157119362ecde806a4d881b';
const sourceArchiveSha256 = '86c5f61ac931346378eaf53b76b98c83c7f4d39d477a6be61e8304d209b8eb56';
const toolchain = process.env.THEOREMOS_PANTOGRAPH_TOOLCHAIN ?? 'leanprover/lean4:v4.33.0';
if (!['leanprover/lean4:v4.33.0', 'leanprover/lean4:v4.34.1'].includes(toolchain))
  throw new Error('Unsupported Pantograph build toolchain.');
const versionNumber = toolchain.split(':v')[1];
const sourceUrl = `https://codeload.github.com/stanford-centaur/Pantograph/tar.gz/${sourceCommit}`;
const output = path.resolve(process.argv[2] || '/opt/theoremos-pantograph');
if (fs.existsSync(output)) throw new Error('Use a new Pantograph installation directory.');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-pantograph-'));
const source = path.join(temporary, 'source');
fs.mkdirSync(source);
const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const json = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o444 });
const run = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean } = {}) => {
  const result = spawnSync(command, args, { cwd: options.cwd ?? source, env: options.env ?? process.env,
    encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit', maxBuffer: 16 * 1024, timeout: 30 * 60 * 1000 });
  if (result.error || result.status !== 0) throw new Error(`Pantograph build failed: ${command}${options.capture ? `\n${result.stderr ?? ''}` : ''}`);
  return result.stdout?.trim() ?? '';
};
const files: { path: string; sha256: string }[] = [];
const collect = (directory: string) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { collect(file); fs.chmodSync(file, 0o555); }
    else if (entry.isFile() && fs.statSync(file).nlink === 1) {
      const relative = path.relative(output, file).split(path.sep).join('/');
      fs.chmodSync(file, relative === 'bin/repl' ? 0o555 : 0o444);
      files.push({ path: relative, sha256: sha256(file) });
    } else throw new Error('Pantograph artifacts must be regular files without links.');
  }
};
let createdOutput = false;
try {
  const archive = path.join(temporary, 'source.tar.gz');
  const cachedArchive = process.env.THEOREMOS_PANTOGRAPH_ARCHIVE;
  if (cachedArchive) fs.copyFileSync(path.resolve(cachedArchive), archive);
  else run('curl', ['--fail', '--location', '--retry', '3', '--max-time', '180', '--output', archive, sourceUrl]);
  if (sha256(archive) !== sourceArchiveSha256) throw new Error('Pantograph source archive digest changed.');
  run('tar', ['-xzf', archive, '--strip-components=1', '-C', source]);
  const upstreamToolchain = fs.readFileSync(path.join(source, 'lean-toolchain'), 'utf8').trim();
  // The upstream commit specifies 4.33.1. Only this isolated build checkout selects the target;
  // problem toolchains and the worker's frozen Mathlib dependency manifest stay intact.
  fs.writeFileSync(path.join(source, 'lean-toolchain'), toolchain + '\n');
  const leanVersion = run('lean', ['--version'], { capture: true });
  if (!leanVersion.startsWith(`Lean (version ${versionNumber},`))
    throw new Error(`Pantograph requires the installed Lean ${versionNumber} toolchain.`);
  const sysroot = run('lean', ['--print-prefix'], { capture: true });
  const bin = path.join(sysroot, 'bin');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    LEAN_SYSROOT: sysroot, LEAN_NUM_THREADS: '2' };
  // Populate the fixed build dependency without asking Lake to resolve newer revisions.
  const manifest = fs.readFileSync(path.join(source, 'lake-manifest.json'), 'utf8');
  const packages = JSON.parse(manifest).packages as { name: string; url: string; rev: string }[];
  for (const item of packages) {
    const directory = path.join(source, '.lake/packages', item.name);
    fs.mkdirSync(directory, { recursive: true });
    run('git', ['init', '--quiet', directory]);
    run('git', ['remote', 'add', 'origin', item.url], { cwd: directory });
    const bundleRoot = process.env.THEOREMOS_PANTOGRAPH_DEPENDENCY_BUNDLES;
    if (bundleRoot) {
      if (!/^[A-Za-z0-9_-]+$/u.test(item.name)) throw new Error('Invalid dependency name.');
      run('git', ['fetch', path.resolve(bundleRoot, `${item.name}.bundle`), 'HEAD'], { cwd: directory });
    } else run('git', ['-c', 'protocol.file.allow=never', 'fetch', '--depth=1', 'origin', item.rev], { cwd: directory });
    run('git', ['checkout', '--detach', '--quiet', 'FETCH_HEAD'], { cwd: directory });
    if (run('git', ['rev-parse', 'HEAD'], { cwd: directory, capture: true }) !== item.rev)
      throw new Error('Pantograph build dependency revision changed.');
  }
  run(path.join(bin, 'lake'), ['--no-cache', 'build', 'repl'], { env });
  if (fs.readFileSync(path.join(source, 'lake-manifest.json'), 'utf8') !== manifest)
    throw new Error('Lake changed the pinned Pantograph dependency manifest.');
  const executable = path.join(source, '.lake/build/bin/repl');
  const version = run(executable, ['--version'], { env, capture: true });
  if (version !== '0.3.19') throw new Error('Pantograph version changed.');
  fs.mkdirSync(path.join(output, 'bin'), { recursive: true }); createdOutput = true;
  fs.copyFileSync(executable, path.join(output, 'bin/repl'));
  fs.cpSync(path.join(source, '.lake/build/lib/lean'), path.join(output, 'lib/lean'), { recursive: true });
  fs.copyFileSync(path.join(source, 'LICENSE'), path.join(output, 'LICENSE'));
  json(path.join(output, 'provenance.json'), { schema: 'theorem-os.pantograph-build.v1', sourceCommit, sourceUrl,
    sourceArchiveSha256, upstreamToolchain, toolchain, leanVersion, version,
    buildCommand: ['lake', '--no-cache', 'build', 'repl'], packages: packages.map(({ name, url, rev }) => ({ name, url, rev })) });
  collect(output);
  json(path.join(output, 'manifest.json'), { schema: 'theorem-os.pantograph-backend.v1', sourceCommit, toolchain,
    executable: 'bin/repl', libraryDirectories: ['lib/lean'], files });
  fs.chmodSync(output, 0o555);
  console.log(JSON.stringify({ manifest: path.join(output, 'manifest.json'), sourceCommit, toolchain, version, files: files.length }));
} catch (error) {
  if (createdOutput) fs.rmSync(output, { recursive: true, force: true });
  throw error;
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
