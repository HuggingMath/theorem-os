#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import environment from '../resources/mathlib/environment.json';
import { webLibraryCatalog } from '../apps/web/frozenLibrary';
import { mathLocalModuleBuildOrder } from '../src/math/mathConstructionSources';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';

// Build-time only: compile frozen sources directly; never let Lake fetch or rebuild packages.
const { values } = parseArgs({ options: { root: { type: 'string', default: '/opt/theoremos-library' },
  packages: { type: 'string', default: '/opt/theoremos-mathlib/.lake/packages' }, lean: { type: 'string', default: 'lean' } } });
const root = path.resolve(values.root!), packages = path.resolve(values.packages!), lean = values.lean!;
const catalog = webLibraryCatalog(), { catalogDigest, environmentDigest } = catalog.identity;
const catalogFile = process.env.THEOREMOS_LIBRARY_CATALOG
  ? path.resolve(process.env.THEOREMOS_LIBRARY_CATALOG)
  : fileURLToPath(new URL('../resources/theorem-os-library/release/catalog.json', import.meta.url));
const catalogBytes = fs.readFileSync(catalogFile);
if (mathDigest(catalogBytes) !== catalogDigest) throw new Error('math_library_catalog_changed');
if (fs.existsSync(root)) throw new Error('Use a new Web library installation directory.');
const version = spawnSync(lean, ['--version'], { encoding: 'utf8', timeout: 30_000 });
const expectedVersion = environment.toolchain.split(':v')[1]!;
if (version.status !== 0 || !version.stdout.startsWith(`Lean (version ${expectedVersion},`))
  throw new Error('web_library_toolchain_changed');
const libraries = environment.manifest.packages.map(item => {
  const directory = path.join(packages, item.name);
  const revision = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30_000 });
  if (revision.status !== 0 || revision.stdout.trim() !== item.rev) throw new Error(`web_library_package_changed: ${item.name}`);
  const library = path.join(directory, '.lake/build/lib/lean');
  return fs.existsSync(library) ? library : undefined;
}).filter((library): library is string => library !== undefined);
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'lean-toolchain'), environment.toolchain + '\n');
fs.writeFileSync(path.join(root, 'lakefile.toml'), environment.lakefile);
fs.writeFileSync(path.join(root, 'lake-manifest.json'), JSON.stringify(environment.manifest, null, 2) + '\n');
const build = path.join(root, '.lake/build/lib/lean');
fs.mkdirSync(build, { recursive: true });
// Agents can inspect the whole pinned release without reading the hidden application tree.
const release = path.join(root, 'release'), objects = path.join(release, 'objects');
fs.mkdirSync(objects, { recursive: true, mode: 0o755 });
fs.writeFileSync(path.join(release, 'catalog.json'), catalogBytes, { flag: 'wx', mode: 0o444 });
const published = new Set<string>();
for (const moduleFile of catalog.moduleFiles) {
  const module = catalog.readModule(moduleFile);
  const file = path.join(root, module.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, module.source, { flag: 'wx' });
  const digest = mathDigest(module.source);
  if (!published.has(digest)) {
    fs.writeFileSync(path.join(objects, digest + '.lean'), module.source, { flag: 'wx', mode: 0o444 });
    published.add(digest);
  }
}
const compiled: { file: string; sourceDigest: string; oleanDigest: string }[] = [];
for (const module of mathLocalModuleBuildOrder(root, catalog.moduleFiles)) {
  const output = path.join(build, module.module.replaceAll('.', '/') + '.olean');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync(lean, ['-j', '2', '-R', root, '-o', output, '-i', output.replace(/\.olean$/u, '.ilean'),
    path.join(root, module.file)], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LEAN_PATH: [build, ...libraries].join(path.delimiter), LEAN_NUM_THREADS: '2' } });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    throw new Error(`web_library_compile_failed: ${module.file}: ${result.error?.message ?? result.status}`);
  }
  compiled.push({ file: module.file, sourceDigest: mathDigest(fs.readFileSync(path.join(root, module.file))),
    oleanDigest: mathDigest(fs.readFileSync(output)) });
  console.log(`Compiled ${module.module}`);
}
const receipt = { schema: 'theorem-os.web-library-build.v1', toolchain: environment.toolchain,
  mathlibRevision: environment.mathlibRevision, environmentDigest, catalogDigest, library: catalog.identity,
  catalog: { file: 'release/catalog.json', sha256: catalogDigest }, modules: compiled };
fs.writeFileSync(path.join(root, 'build-receipt.json'), canonicalMathJson(receipt) + '\n');
console.log(`Installed ${compiled.length} Web library modules in ${root}.`);
