import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMathProofEnvironmentSeed, mathProofEnvironmentConfiguration, MATH_PROOF_ENVIRONMENT_METADATA,
  MATH_PROOF_ENVIRONMENT_SEED_ENV, readMathProofEnvironmentSeed } from '../src/math/mathProofEnvironmentSeed';
import { MATH_PROOF_ENVIRONMENT_ENV, prepareMathProofEnvironment, resolveMathProofEnvironment } from '../src/math/mathProofEnvironment';
import { openMathProofEnvironmentCache } from '../src/math/mathProofEnvironmentCache';
import { mathDigest } from '../src/math/mathRuntimeIo';

// Real tiny squashfs images, but no FUSE or privileges: the custodian fixture extracts
// into an independent directory and publishes a live /proc FD. Runtime source,
// metadata, mounted path/content/mode, final fingerprint and HMAC checks remain real.
vi.mock('../src/math/mathSealedEnvironmentHelper', () => ({ MATH_SEALED_ENVIRONMENT_HELPER: `
import argparse, hashlib, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument('--check-tools')
p.add_argument('--image')
p.add_argument('--source')
p.add_argument('--expected-image-sha256')
p.add_argument('--export-image')
a = p.parse_args()
if a.check_tools:
 print(json.dumps({'state':'ready'}), flush=True)
 sys.exit(0)
root = Path(tempfile.mkdtemp(prefix='seed-custodian-fixture-', dir='/var/tmp'))
try:
 if a.source:
  raise RuntimeError('Fixture forbids runtime compression')
 image = root / 'private.squashfs'
 shutil.copyfile(a.image, image)
 digest = hashlib.sha256(image.read_bytes()).hexdigest()
 if digest != a.expected_image_sha256:
  raise RuntimeError('cached image digest changed')
 if a.export_image:
  shutil.copyfile(image, a.export_image)
  os.chmod(a.export_image, 0o400)
 mounted = root / 'mount'
 subprocess.run(['unsquashfs', '-no-progress', '-processors', '2', '-d', str(mounted), str(image)], check=True, stdout=subprocess.DEVNULL)
 mode = os.environ.get('SEED_FIXTURE_CHANGE', '')
 target = mounted / 'Public.lean'
 if mode == 'contents':
  target.chmod(0o600)
  target.write_text('changed after image verification')
  target.chmod(0o400)
 elif mode == 'mode':
  target.chmod(0o500)
 elif mode == 'extra':
  (mounted / 'Unexpected.lean').write_text('extra')
 elif mode == 'metadata':
  target = mounted / '.deepscientist-proof-environment.json'
  target.chmod(0o600)
  target.write_text('{}')
 image.chmod(0o400)
 fd = os.open(image, os.O_RDONLY)
 image.unlink()
 root_fd = os.open(mounted, os.O_RDONLY | os.O_DIRECTORY)
 stat = os.fstat(root_fd)
 if os.environ.get('SEED_FIXTURE_LOG'):
  with open(os.environ['SEED_FIXTURE_LOG'], 'a') as log:
   log.write(json.dumps({'root':str(root),'image':a.image,'export':a.export_image}) + '\\n')
 print(json.dumps({'state':'ready','pid':os.getpid(),'rootFd':root_fd,
  'rootPath':'/proc/'+str(os.getpid())+'/fd/'+str(root_fd),'device':stat.st_dev,'inode':stat.st_ino,
  'imageBytes':os.fstat(fd).st_size,'imageSha256':digest,'seals':0,
  'leaseSocket':str(root/'lease.sock'),'leaseToken':'fixture-token-123456789'}), flush=True)
 sys.stdin.buffer.read()
except Exception as error:
 print(json.dumps({'state':'blocked','error':str(error)}), flush=True)
 sys.exit(1)
finally:
 shutil.rmtree(root)
` }));

const tools = ['mksquashfs', 'unsquashfs'].every(command => !spawnSync(command, ['-version'], { stdio: 'ignore' }).error);
describe.skipIf(process.platform !== 'linux' || !tools)('precompressed proof environment seeds with tiny real images', () => {
  let root: string, project: string, packages: string, output: string, manifest: string;
  const proofs: Awaited<ReturnType<typeof prepareMathProofEnvironment>>[] = [];
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'proof-seed-test-')));
    project = path.join(root, 'project'); packages = path.join(root, 'packages'); output = path.join(root, 'seed');
    manifest = path.join(output, 'manifest.json');
    fs.mkdirSync(project); fs.mkdirSync(packages);
    fs.writeFileSync(path.join(project, 'lean-toolchain'), 'leanprover/lean4:fixture\n');
    fs.writeFileSync(path.join(project, 'lakefile.toml'), 'name = "first_problem"\n');
    fs.writeFileSync(path.join(project, 'lake-manifest.json'), JSON.stringify({ name: 'first_problem', packages: [] }));
    fs.writeFileSync(path.join(packages, 'Public.lean'), 'theorem public : True := by trivial\n');
    fs.writeFileSync(path.join(packages, 'tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });
  afterEach(async () => {
    await Promise.all(proofs.splice(0).map(proof => proof.dispose()));
    vi.restoreAllMocks();
    if (fs.existsSync(output)) fs.chmodSync(output, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const build = (extra: Parameters<typeof buildMathProofEnvironmentSeed>[3] = {}) =>
    buildMathProofEnvironmentSeed(project, packages, output, extra);
  const prepare = async (extra: Parameters<typeof prepareMathProofEnvironment>[2] = {}, source = packages) => {
    const proof = await prepareMathProofEnvironment(project, source, { seedManifestPath: manifest, ...extra });
    proofs.push(proof); return proof;
  };
  const updateManifest = (change: (seed: Record<string, any>) => void) => {
    const seed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    change(seed); fs.chmodSync(manifest, 0o644); fs.writeFileSync(manifest, JSON.stringify(seed)); fs.chmodSync(manifest, 0o444);
  };

  it('builds a readonly portable artifact, excludes private references, and imports changed physical identities without runtime compression', async () => {
    fs.mkdirSync(path.join(packages, '.git'));
    fs.writeFileSync(path.join(packages, '.git', 'private'), 'git metadata');
    fs.writeFileSync(path.join(packages, 'Solution.lean'), 'excluded answer');
    fs.writeFileSync(path.join(packages, 'Solution.olean'), 'excluded compiled answer');
    const seed = await build();
    expect(seed.metadata.stats.files).toBe(2);
    expect(fs.statSync(output).mode & 0o777).toBe(0o555);
    for (const name of ['manifest.json', seed.imageName]) expect(fs.statSync(path.join(output, name)).mode & 0o777).toBe(0o444);
    const otherPackages = path.join(root, 'other-packages');
    fs.cpSync(packages, otherPackages, { recursive: true });
    expect(fs.statSync(path.join(packages, 'Public.lean')).ino).not.toBe(fs.statSync(path.join(otherPackages, 'Public.lean')).ino);
    const phases: string[] = [];
    const proof = await prepare({ onProgress: phase => phases.push(phase) }, otherPackages);
    const environment = resolveMathProofEnvironment(project, { [MATH_PROOF_ENVIRONMENT_ENV]: proof.environmentValue })!;
    expect(fs.readdirSync(environment.packagesRoot).sort()).toEqual([MATH_PROOF_ENVIRONMENT_METADATA, 'Public.lean', 'tool'].sort());
    expect(fs.readFileSync(path.join(environment.packagesRoot, 'Public.lean'), 'utf8')).toContain('by trivial');
    expect(fs.statSync(path.join(environment.packagesRoot, 'tool')).mode & 0o777).toBe(0o511);
    expect(phases).toEqual(expect.arrayContaining(['seed_selected', 'hashing_dependencies', 'verifying_source', 'mounting_seed_image', 'verifying_mounted_dependencies', 'ready']));
    expect(phases).not.toContain('building_image'); expect(phases).not.toContain('copying_dependencies');
    expect(phases.filter(phase => phase === 'verifying_source')).toHaveLength(2);
    expect(() => environment.verify()).not.toThrow();
  });

  it('seals queryable library sources and metadata without Lake build products, and requires an explicit sources consumer', async () => {
    const retained = {
      'mathlib/Mathlib/Library.lean': 'def libraryMeaning : Nat := 7\n',
      'mathlib/lake-manifest.json': '{"packages":[]}\n',
      'mathlib/.lake/package-overrides.json': '{"packages":[]}\n',
    };
    const generated = ['mathlib/.lake/build/lib/lean/Mathlib/Library.olean', 'mathlib/.lake/build/ir/Library.c'];
    for (const [relative, text] of [...Object.entries(retained), ...generated.map(relative => [relative, 'compiled artifact'] as const)]) {
      const file = path.join(packages, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    }
    const seed = await build({ contents: 'sources' });
    expect(seed.metadata.contents).toBe('sources');
    expect(seed.metadata.stats.files).toBe(5);
    const proof = await prepare({ contents: 'sources', cacheRoot: path.join(root, 'cache') });
    const env = { [MATH_PROOF_ENVIRONMENT_ENV]: proof.environmentValue };
    expect(JSON.parse(proof.environmentValue).contents).toBe('sources');
    expect(() => resolveMathProofEnvironment(project, env)).toThrow();
    expect(() => resolveMathProofEnvironment(project, env, 'complete')).toThrow();
    const environment = resolveMathProofEnvironment(project, env, 'sources')!;
    expect(environment.contents).toBe('sources');
    for (const [relative, text] of Object.entries(retained)) {
      const file = path.join(environment.packagesRoot, relative);
      expect(fs.readFileSync(file, 'utf8')).toBe(text);
      expect(fs.statSync(file).mode & 0o222).toBe(0);
      expect(() => fs.appendFileSync(file, 'changed')).toThrow();
    }
    expect(fs.existsSync(path.join(environment.packagesRoot, 'mathlib', '.lake', 'build'))).toBe(false);
    for (const relative of generated) expect(fs.readFileSync(path.join(packages, relative), 'utf8')).toBe('compiled artifact');
    const metadata = JSON.parse(fs.readFileSync(path.join(environment.packagesRoot, MATH_PROOF_ENVIRONMENT_METADATA), 'utf8'));
    expect(metadata.contents).toBe('sources');
    expect(() => environment.verify()).not.toThrow();
  });

  it('separates complete and sources seeds and caches even when their selected file inventories coincide', async () => {
    const complete = await build();
    const sourceOutput = path.join(root, 'source-seed'), sourceManifest = path.join(sourceOutput, 'manifest.json');
    const sources = await buildMathProofEnvironmentSeed(project, packages, sourceOutput, { contents: 'sources' });
    // Leave its readonly files intact while allowing cleanup if a later assertion fails.
    fs.chmodSync(sourceOutput, 0o700);
    const config = mathProofEnvironmentConfiguration(project);
    expect(complete.metadata).not.toHaveProperty('contents');
    expect(sources.metadata.contents).toBe('sources');
    expect(complete.metadata.stats).toEqual(sources.metadata.stats);
    expect(readMathProofEnvironmentSeed(manifest, config)).toBeDefined();
    expect(readMathProofEnvironmentSeed(manifest, config, 'complete')).toBeDefined();
    expect(readMathProofEnvironmentSeed(manifest, config, 'sources')).toBeUndefined();
    expect(readMathProofEnvironmentSeed(sourceManifest, config)).toBeUndefined();
    expect(readMathProofEnvironmentSeed(sourceManifest, config, 'complete')).toBeUndefined();
    expect(readMathProofEnvironmentSeed(sourceManifest, config, 'sources')).toBeDefined();
    const cacheRoot = path.join(root, 'cache');
    const full = await prepare({ cacheRoot });
    const source = await prepare({ cacheRoot, contents: 'sources', seedManifestPath: sourceManifest });
    const descriptors = [full, source].map(proof => JSON.parse(proof.environmentValue));
    expect(descriptors[0]).not.toHaveProperty('contents');
    expect(descriptors[0].identity).not.toBe(descriptors[1].identity);
    const completeEnvironment = resolveMathProofEnvironment(project, { [MATH_PROOF_ENVIRONMENT_ENV]: full.environmentValue }, 'sources')!;
    expect(completeEnvironment.contents).toBe('complete');
    const fingerprints = fs.readdirSync(cacheRoot).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
    expect(fingerprints).toHaveLength(2);
    const entries = fingerprints.map(fingerprint => openMathProofEnvironmentCache(cacheRoot).read(fingerprint)!);
    expect(entries.every(Boolean)).toBe(true);
    expect(entries.map(entry => entry.metadataHash).toSorted())
      .toEqual(descriptors.map(descriptor => descriptor.metadataHash).toSorted());
    for (const contents of ['complete', 'sources'] as const) {
      const phases: string[] = [];
      const proof = await prepare({ cacheRoot, ...(contents === 'sources' ? { contents, seedManifestPath: sourceManifest } : {}),
        onProgress: phase => phases.push(phase) });
      expect(phases).toContain('cache_hit'); expect(phases).not.toContain('seed_selected');
      const environment = resolveMathProofEnvironment(project, { [MATH_PROOF_ENVIRONMENT_ENV]: proof.environmentValue }, 'sources')!;
      expect(environment.contents).toBe(contents);
    }
  });

  it.each(['before import', 'after hashing'] as const)('rejects changed source-only contents %s without publishing a cache entry', async change => {
    await build({ contents: 'sources' });
    const file = path.join(packages, 'Public.lean'), cacheRoot = path.join(root, 'cache');
    if (change === 'before import') fs.appendFileSync(file, '-- changed\n');
    await expect(prepare({ contents: 'sources', cacheRoot, onProgress: phase => {
      if (change === 'after hashing' && phase === 'verifying_cache_identity') fs.appendFileSync(file, '-- changed\n');
    } })).rejects.toThrow(change === 'before import' ? 'seed does not match the authorized source' : 'dependency changed');
    expect(fs.readdirSync(cacheRoot).filter(name => /\.(?:json|squashfs)$/u.test(name))).toEqual([]);
  });

  it('publishes only a fresh private HMAC entry, then opens independent mounts from that cache', async () => {
    await build();
    const cacheRoot = path.join(root, 'cache'), log = path.join(root, 'helper.jsonl');
    const env = { ...process.env, [MATH_PROOF_ENVIRONMENT_SEED_ENV]: manifest, SEED_FIXTURE_LOG: log };
    const first = await prepare({ cacheRoot, env });
    const entries = fs.readdirSync(cacheRoot).filter(name => name.endsWith('.json'));
    expect(entries).toHaveLength(1);
    const fingerprint = entries[0].slice(0, -5), cache = openMathProofEnvironmentCache(cacheRoot);
    const entry = cache.read(fingerprint)!;
    expect(entry).toBeDefined(); expect(entry.stats).toEqual(first.stats);
    expect(fs.statSync(cache.imagePath(entry)).mode & 0o777).toBe(0o400);
    const phases: string[] = [];
    const second = await prepare({ cacheRoot, env, onProgress: phase => phases.push(phase) });
    expect(phases).toContain('cache_hit'); expect(phases).not.toContain('seed_selected');
    const roots = [first, second].map(proof => resolveMathProofEnvironment(project, { [MATH_PROOF_ENVIRONMENT_ENV]: proof.environmentValue })!.packagesRoot);
    expect(roots[0]).not.toBe(roots[1]);
    const launches = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(launches.map(item => item.image)).toEqual([path.join(output, 'dependencies.squashfs'), cache.imagePath(entry)]);
    expect(launches[0].export).toBe(cache.imagePath(entry));
    const saved = JSON.parse(fs.readFileSync(path.join(cacheRoot, entries[0]), 'utf8'));
    saved.signature = '0'.repeat(64); fs.writeFileSync(path.join(cacheRoot, entries[0]), JSON.stringify(saved));
    expect(cache.read(fingerprint)).toBeUndefined();
    await first.dispose(); await second.dispose();
    expect(launches.every(item => !fs.existsSync(item.root))).toBe(true);
  });

  it.each(['contents', 'mode', 'extra', 'metadata'])('rejects changed mounted %s before publishing a private cache entry', async change => {
    await build();
    const cacheRoot = path.join(root, 'cache');
    await expect(prepare({ cacheRoot, env: { ...process.env, SEED_FIXTURE_CHANGE: change } })).rejects.toThrow(
      change === 'metadata' ? 'metadata changed' : change === 'extra' ? 'input set differs' : change === 'mode' ? 'permissions differ' : 'bytes differ');
    expect(fs.readdirSync(cacheRoot).filter(name => /\.(?:json|squashfs)$/u.test(name))).toEqual([]);
  });

  it.each(['contents', 'mode'])('rejects authorized source %s that no longer matches the seed', async change => {
    await build();
    if (change === 'contents') fs.appendFileSync(path.join(packages, 'Public.lean'), '-- different\n');
    else fs.chmodSync(path.join(packages, 'tool'), 0o644);
    await expect(prepare()).rejects.toThrow('seed does not match the authorized source');
  });

  it('rejects a source replacement after initial hashing and a source edit after mounted verification', async () => {
    await build();
    const file = path.join(packages, 'Public.lean'), bytes = fs.readFileSync(file);
    await expect(prepare({ onProgress: phase => {
      if (phase === 'mounting_seed_image') { fs.unlinkSync(file); fs.writeFileSync(file, bytes); }
    } })).rejects.toThrow('dependency changed');
    await expect(prepare({ onProgress: phase => {
      if (phase === 'verifying_mounted_dependencies') fs.appendFileSync(file, '-- edited\n');
    } })).rejects.toThrow('dependency changed');
  });

  it.each((['mounting_seed_image', 'verifying_cache_identity'] as const).flatMap(phase =>
    (['same-length contents', 'same-bytes replacement', 'inventory addition', 'symlink retarget', 'project configuration'] as const)
      .map(change => ({ phase, change }))))(
    'rejects cold seed/cache $change at $phase without publishing', async ({ phase, change }) => {
      const file = path.join(packages, 'Public.lean'), bytes = fs.readFileSync(file);
      // Use an exactly representable timestamp so restoring mtime really preserves
      // mtimeNs; the final identity must still notice ctime or inode changes.
      const savedTime = 1_700_000_000;
      fs.utimesSync(file, savedTime, savedTime);
      const alias = path.join(packages, 'Alias.lean'), alternate = path.join(packages, 'Alternate.lean');
      fs.writeFileSync(alternate, bytes); fs.symlinkSync('Public.lean', alias);
      await build();
      const original = fs.statSync(file, { bigint: true }), cacheRoot = path.join(root, 'cache');
      const phases: string[] = [];
      let changed = false;
      await expect(prepare({ cacheRoot, onProgress: current => {
        phases.push(current);
        if (current !== phase || changed) return;
        changed = true;
        switch (change) {
          case 'same-length contents': {
            const edited = Buffer.from(bytes); edited[0] ^= 1;
            fs.writeFileSync(file, edited); fs.utimesSync(file, savedTime, savedTime);
            const after = fs.statSync(file, { bigint: true });
            expect(after.size).toBe(original.size); expect(after.ino).toBe(original.ino);
            expect(after.mtimeNs).toBe(original.mtimeNs); expect(after.ctimeNs).not.toBe(original.ctimeNs);
            expect(fs.readFileSync(file).equals(bytes)).toBe(false);
            break;
          }
          case 'same-bytes replacement': {
            const replacement = path.join(packages, 'Public.new');
            // Create while the original exists so inode reuse cannot weaken this case.
            fs.writeFileSync(replacement, bytes); fs.chmodSync(replacement, Number(original.mode & BigInt(0o777)));
            fs.utimesSync(replacement, savedTime, savedTime); fs.renameSync(replacement, file);
            const after = fs.statSync(file, { bigint: true });
            expect(after.ino).not.toBe(original.ino); expect(after.size).toBe(original.size);
            expect(after.mode).toBe(original.mode); expect(after.mtimeNs).toBe(original.mtimeNs);
            expect(fs.readFileSync(file)).toEqual(bytes);
            break;
          }
          case 'inventory addition':
            fs.writeFileSync(path.join(packages, 'Added.lean'), 'theorem added : True := by trivial\n');
            break;
          case 'symlink retarget':
            fs.unlinkSync(alias); fs.symlinkSync('Alternate.lean', alias);
            expect(fs.realpathSync(alias)).toBe(alternate); expect(fs.readFileSync(alias)).toEqual(bytes);
            break;
          case 'project configuration':
            fs.appendFileSync(path.join(project, 'lakefile.toml'), '[leanOptions]\nautoImplicit = false\n');
            break;
        }
      } })).rejects.toThrow(change === 'project configuration' && phase === 'mounting_seed_image'
        ? 'project configuration' : 'dependency changed');
      expect(changed).toBe(true);
      expect(phases).toEqual(expect.arrayContaining(['cache_miss', 'seed_selected', 'hashing_dependencies', 'mounting_seed_image']));
      if (phase === 'verifying_cache_identity') {
        expect(phases.indexOf('verifying_mounted_dependencies')).toBeGreaterThan(phases.indexOf('mounting_seed_image'));
        expect(phases.indexOf(phase)).toBeGreaterThan(phases.lastIndexOf('verifying_mounted_dependencies'));
      }
      expect(phases).not.toContain('verifying_source'); expect(phases).not.toContain('cache_hit');
      expect(phases).not.toContain('ready');
      expect(fs.readdirSync(cacheRoot).filter(name => /\.(?:json|squashfs)$/u.test(name))).toEqual([]);
    });

  it('does not trust a changed image, writable seed, symlink or an escaping image name', async () => {
    const seed = await build(), image = path.join(output, seed.imageName), config = mathProofEnvironmentConfiguration(project);
    fs.chmodSync(image, 0o644);
    expect(() => readMathProofEnvironmentSeed(manifest, config)).toThrow('read-only');
    const fd = fs.openSync(image, 'r+'); fs.writeSync(fd, Buffer.from('oops'), 0, 4, 0); fs.closeSync(fd); fs.chmodSync(image, 0o444);
    await expect(prepare()).rejects.toThrow('cached image digest changed');
    const alias = path.join(root, 'alias.json'); fs.symlinkSync(manifest, alias);
    expect(() => readMathProofEnvironmentSeed(alias, config)).toThrow();
    updateManifest(value => { value.imageName = '../escape.squashfs'; });
    expect(() => readMathProofEnvironmentSeed(manifest, config)).toThrow();
  });

  it('falls back only for absent or incompatible seed configuration or helper, preserving root-name normalization', async () => {
    await build();
    expect(readMathProofEnvironmentSeed(path.join(root, 'missing.json'), mathProofEnvironmentConfiguration(project))).toBeUndefined();
    fs.writeFileSync(path.join(project, 'lakefile.toml'), 'name = "another_problem"\n');
    expect(readMathProofEnvironmentSeed(manifest, mathProofEnvironmentConfiguration(project))).toBeDefined();
    fs.appendFileSync(path.join(project, 'lakefile.toml'), '[leanOptions]\nautoImplicit = false\n');
    expect(readMathProofEnvironmentSeed(manifest, mathProofEnvironmentConfiguration(project))).toBeUndefined();
    fs.writeFileSync(path.join(project, 'lakefile.toml'), 'name = "another_problem"\n');
    updateManifest(value => { value.helperSha256 = '0'.repeat(64); });
    expect(readMathProofEnvironmentSeed(manifest, mathProofEnvironmentConfiguration(project))).toBeUndefined();
    const phases: string[] = [];
    await expect(prepare({ onProgress: phase => phases.push(phase) })).rejects.toThrow(); // fixture forbids the cold compressor
    expect(phases).toContain('building_image'); expect(phases).not.toContain('mounting_seed_image');
  });

  it('cancels during seed import without publishing, and rejects an expired deadline', async () => {
    await build();
    const controller = new AbortController(), cacheRoot = path.join(root, 'cache');
    await expect(prepare({ cacheRoot, signal: controller.signal, onProgress: phase => {
      if (phase === 'verifying_mounted_dependencies') controller.abort();
    } })).rejects.toThrow();
    expect(fs.readdirSync(cacheRoot).filter(name => /\.(?:json|squashfs)$/u.test(name))).toEqual([]);
    await expect(prepare({ deadlineAt: Date.now() - 1 })).rejects.toThrow('deadline exceeded');
  });

  it('binds the built portable contents and rejects source changes during construction', async () => {
    const snapshot = fs.readFileSync(path.join(packages, 'Public.lean'));
    await expect(buildMathProofEnvironmentSeed(project, packages, output, { onProgress: phase => {
      if (phase === 'verifying_source') fs.appendFileSync(path.join(packages, 'Public.lean'), '-- changed\n');
    } })).rejects.toThrow('dependency changed');
    expect(fs.existsSync(output)).toBe(false);
    fs.writeFileSync(path.join(packages, 'Public.lean'), snapshot);
    const seed = await build();
    expect(seed.imageSha256).toBe(mathDigest(fs.readFileSync(path.join(output, seed.imageName))));
  });
});
