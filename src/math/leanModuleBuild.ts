import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MathLocalModule } from './mathConstructionSources';
import { canonicalMathJson, mathDigest, readMathFile, readMathText } from './mathRuntimeIo';

/**
 * Module-level builds for project-local Lean imports.  Each module compiles in
 * its own disposable root holding only its source and the verified artifacts of
 * its imports, so its output is a function of its build key: identical modules
 * compile once per batch, independent modules compile concurrently, and an
 * HMAC-attested host cache lets later batches reuse them.  Official gates never
 * read this cache; they rebuild from the committed sources.
 */
const SCHEMA = 'theorem-os.lean-module-build.v1';
/** Outputs `lean -o <stem>.olean` may write; `.olean` is required, the rest exist for `module` files. */
export const LEAN_MODULE_ARTIFACT_SUFFIXES = ['.olean', '.olean.private', '.olean.server', '.ir', '.ir.sig'] as const;
const SUFFIXES: readonly string[] = LEAN_MODULE_ARTIFACT_SUFFIXES;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_CACHED_MODULE_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 1024;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const STALE_CACHE_TEMPORARY_MS = 60 * 60 * 1000;

export type LeanModuleArtifact = { suffix: string; sha256: string; bytes: number };
export type BuiltLeanModule = {
  key: string; module: MathLocalModule; artifacts: LeanModuleArtifact[];
  /** Transitive imports, dependency-first, excluding the module itself. */
  closure: BuiltLeanModule[];
  origin: 'compiled' | 'cache';
};
/** Persistent cache binding; `environmentDigest` covers everything other than local sources that can change an output. */
export type LeanModuleHostCache = { directory: string; secret: string; environmentDigest: string };
export type LeanModuleBuildResult<F> =
  | { ok: true; modules: BuiltLeanModule[] }
  | { ok: false; module: MathLocalModule; failure: F };

export type LeanModuleBuilderOptions<F> = {
  /** Disposable checkout whose project-local sources are compiled. */
  sourceProjectRoot: string;
  /** Host-private scratch directory for the artifact store and the per-module roots. */
  scratchRoot: string;
  /** Path of the Lake project inside each root, matching the checkout layout. */
  relativeProjectRoot: string;
  /** Seed configuration and package bindings into a fresh project directory. */
  prepareProject: (projectRoot: string) => void;
  /** Run Lean for one module in `root`; it writes `.lake/build/lib/lean/<stem>.olean`. */
  compile: (module: MathLocalModule, root: string) => Promise<{ ok: true } | { ok: false; failure: F }>;
  /** Failure for a module whose inputs changed or whose outputs cannot be trusted. */
  invalid: (message: string) => F;
  /** Resolved once on first use; undefined keeps reuse within this builder. */
  hostCache?: () => LeanModuleHostCache | undefined;
};
type Outcome<F> = { ok: true; built: BuiltLeanModule } | { ok: false; module: MathLocalModule; failure: F };

const stemOf = (module: MathLocalModule): string =>
  path.posix.join('.lake/build/lib/lean', path.posix.relative(module.sourceRoot, module.file).replace(/\.lean$/u, ''));
const storedPath = (store: string, key: string, suffix: string) => path.join(store, `${key}${suffix}`);
const removeStored = (store: string, key: string) => {
  for (const suffix of SUFFIXES) fs.rmSync(storedPath(store, key, suffix), { force: true });
};

/** The given modules after their transitive imports, without duplicates. */
export const leanModuleClosure = (modules: readonly BuiltLeanModule[]): BuiltLeanModule[] => {
  const seen = new Map<string, BuiltLeanModule>();
  for (const built of modules)
    for (const member of [...built.closure, built]) if (!seen.has(member.key)) seen.set(member.key, member);
  return [...seen.values()];
};

/** Copy a regular, unlinked file without following links; returns the digest of the bytes written. */
function copyHashed(source: string, target: string, limit = MAX_ARTIFACT_BYTES): { sha256: string; bytes: number } | undefined {
  const input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(input);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) return undefined;
    const output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const digest = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
      let bytes = 0, read: number;
      while ((read = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
        if ((bytes += read) > limit) return undefined;
        digest.update(buffer.subarray(0, read));
        for (let offset = 0; offset < read;) offset += fs.writeSync(output, buffer, offset, read - offset);
      }
      return { sha256: digest.digest('hex'), bytes };
    } finally { fs.closeSync(output); }
  } finally { fs.closeSync(input); }
}

/** Whether `relative` is missing, a regular file under real directories of `root`, or something Lean does not write. */
function outputState(root: string, relative: string): 'missing' | 'file' | 'invalid' {
  const parts = relative.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return 'missing';
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) return 'invalid';
  }
  return 'file';
}
/** Place stored artifacts at their Lake paths below a fresh project directory. */
function install(store: string, project: string, modules: readonly BuiltLeanModule[]): void {
  for (const built of modules) {
    const stem = path.join(project, ...stemOf(built.module).split('/'));
    fs.mkdirSync(path.dirname(stem), { recursive: true });
    for (const artifact of built.artifacts)
      fs.copyFileSync(storedPath(store, built.key, artifact.suffix), stem + artifact.suffix, fs.constants.COPYFILE_FICLONE);
  }
}

/** Move Lean's outputs into the store; undefined when the sandbox left something Lean does not write. */
function harvest(store: string, key: string, root: string, relativeProjectRoot: string, module: MathLocalModule): LeanModuleArtifact[] | undefined {
  const artifacts: LeanModuleArtifact[] = [];
  for (const suffix of SUFFIXES) {
    const relative = path.posix.join(relativeProjectRoot, stemOf(module) + suffix);
    const state = outputState(root, relative);
    if (state === 'invalid') return undefined;
    if (state === 'missing') continue;
    const copied = copyHashed(path.join(root, ...relative.split('/')), storedPath(store, key, suffix));
    if (!copied) return undefined;
    artifacts.push({ suffix, ...copied });
  }
  // A launcher that exits without writing an olean (a test double) leaves nothing to reuse.
  return artifacts.some(artifact => artifact.suffix === '.olean') ? artifacts : [];
}

const entryName = (cache: LeanModuleHostCache, key: string) => mathDigest(`${mathDigest(cache.secret).slice(0, 16)}\0${key}`);
const attest = (cache: LeanModuleHostCache, key: string, files: readonly LeanModuleArtifact[]) =>
  crypto.createHmac('sha256', cache.secret).update(canonicalMathJson({ schema: SCHEMA, key, files })).digest('hex');

/** Restore an attested entry into the store, re-hashing every byte; any mismatch is a miss. */
function restoreCached(cache: LeanModuleHostCache, store: string, key: string): LeanModuleArtifact[] | undefined {
  const entry = path.join(cache.directory, entryName(cache, key));
  let manifest: { schema?: unknown; key?: unknown; files?: unknown; attestation?: unknown };
  try { manifest = JSON.parse(readMathText(path.join(entry, 'manifest.json'), 64 * 1024)); }
  catch { return undefined; }
  try {
    const files = Array.isArray(manifest.files) ? manifest.files as LeanModuleArtifact[] : [];
    const valid = manifest.schema === SCHEMA && manifest.key === key && typeof manifest.attestation === 'string' &&
      files.length <= SUFFIXES.length && files.some(file => file?.suffix === '.olean') &&
      files.every((file, index) => SUFFIXES.includes(file?.suffix) && files.findIndex(other => other?.suffix === file.suffix) === index &&
        /^[0-9a-f]{64}$/u.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= MAX_CACHED_MODULE_BYTES);
    const expected = Buffer.from(valid ? attest(cache, key, files.map(({ suffix, sha256, bytes }) => ({ suffix, sha256, bytes }))) : '', 'hex');
    const actual = Buffer.from(valid ? manifest.attestation as string : '', 'hex');
    if (!valid || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error('invalid');
    const artifacts = files.map(({ suffix, sha256, bytes }) => ({ suffix, sha256, bytes }));
    for (const artifact of artifacts) {
      const copied = copyHashed(path.join(entry, `artifact${artifact.suffix}`), storedPath(store, key, artifact.suffix), artifact.bytes);
      if (copied?.sha256 !== artifact.sha256 || copied.bytes !== artifact.bytes) throw new Error('invalid');
    }
    const now = new Date();
    fs.utimesSync(entry, now, now);
    return artifacts;
  } catch {
    // Entry names bind this secret, so a complete entry that fails here is damaged: replace it.
    removeStored(store, key);
    fs.rmSync(entry, { recursive: true, force: true });
    return undefined;
  }
}
/** Publish a compiled module atomically; failures only cost a later recompilation. */
function persistCached(cache: LeanModuleHostCache, store: string, built: BuiltLeanModule): void {
  if (built.artifacts.reduce((total, artifact) => total + artifact.bytes, 0) > MAX_CACHED_MODULE_BYTES) return;
  let temporary: string | undefined;
  try {
    fs.mkdirSync(cache.directory, { recursive: true, mode: 0o700 });
    const entry = path.join(cache.directory, entryName(cache, built.key));
    if (fs.existsSync(entry)) return;
    temporary = fs.mkdtempSync(`${entry}.tmp-`);
    for (const artifact of built.artifacts)
      fs.copyFileSync(storedPath(store, built.key, artifact.suffix), path.join(temporary, `artifact${artifact.suffix}`),
        fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    fs.writeFileSync(path.join(temporary, 'manifest.json'), `${JSON.stringify({ schema: SCHEMA, key: built.key,
      files: built.artifacts, attestation: attest(cache, built.key, built.artifacts), createdAt: Date.now() })}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, entry);
    temporary = undefined;
    evictCached(cache.directory);
  } catch { /* A concurrent writer won, or the cache is unwritable. */ } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/** Keep the most recently used entries within the count and byte bounds; drop abandoned temporaries. */
function evictCached(directory: string): void {
  const entries: { entry: string; used: number; bytes: number }[] = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const entry = path.join(directory, item.name);
    try {
      const stat = fs.lstatSync(entry);
      if (/\.tmp-/u.test(item.name)) {
        if (Date.now() - stat.mtimeMs > STALE_CACHE_TEMPORARY_MS) fs.rmSync(entry, { recursive: true, force: true });
        continue;
      }
      if (!stat.isDirectory() || !/^[0-9a-f]{64}$/u.test(item.name)) continue;
      const bytes = fs.readdirSync(entry).reduce((total, file) => total + fs.lstatSync(path.join(entry, file)).size, 0);
      entries.push({ entry, used: stat.mtimeMs, bytes });
    } catch { /* Removed concurrently. */ }
  }
  entries.sort((left, right) => right.used - left.used);
  let kept = 0, bytes = 0;
  for (const item of entries) {
    if (kept < MAX_CACHE_ENTRIES && bytes + item.bytes <= MAX_CACHE_BYTES) { kept++; bytes += item.bytes; continue; }
    fs.rmSync(item.entry, { recursive: true, force: true });
  }
}
export function createLeanModuleBuilder<F>(options: LeanModuleBuilderOptions<F>) {
  const store = path.join(options.scratchRoot, 'artifacts'), roots = path.join(options.scratchRoot, 'roots');
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  fs.mkdirSync(roots, { recursive: true, mode: 0o700 });
  const tasks = new Map<string, Promise<Outcome<F>>>();
  let resolvedCache: LeanModuleHostCache | undefined | null = null;
  const hostCache = (): LeanModuleHostCache | undefined => {
    if (resolvedCache === null) {
      try { resolvedCache = options.hostCache?.(); } catch { resolvedCache = undefined; }
    }
    return resolvedCache;
  };

  /** Run `work` in a fresh root holding `files` and the artifacts of `modules` and their imports. */
  const withRoot = async <T>(modules: readonly BuiltLeanModule[], files: ReadonlyMap<string, Uint8Array>,
    work: (root: string) => Promise<T>): Promise<T> => {
    const root = fs.mkdtempSync(path.join(roots, 'root-'));
    try {
      const project = path.join(root, ...options.relativeProjectRoot.split('/').filter(Boolean));
      fs.mkdirSync(project, { recursive: true });
      options.prepareProject(project);
      install(store, project, leanModuleClosure(modules));
      for (const [file, bytes] of files) {
        const target = path.join(project, ...file.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes, { mode: 0o600 });
      }
      return await work(root);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  };

  const buildModule = (module: MathLocalModule, imports: readonly BuiltLeanModule[]): Promise<Outcome<F>> => {
    const key = mathDigest(canonicalMathJson({ schema: SCHEMA, environment: hostCache()?.environmentDigest ?? null,
      file: module.file, sourceRoot: module.sourceRoot, module: module.module, sourceDigest: module.sourceDigest,
      imports: imports.map(built => built.key) }));
    let task = tasks.get(key);
    if (task) return task;
    task = (async (): Promise<Outcome<F>> => {
      const closure = leanModuleClosure(imports), cache = hostCache();
      const restored = cache && restoreCached(cache, store, key);
      if (restored) return { ok: true, built: { key, module, artifacts: restored, closure, origin: 'cache' } };
      let source: Uint8Array;
      try { source = readMathFile(path.join(options.sourceProjectRoot, ...module.file.split('/'))).bytes; }
      catch { source = new Uint8Array(); }
      if (mathDigest(source) !== module.sourceDigest)
        return { ok: false, module, failure: options.invalid(`Local module ${module.file} changed during verification.`) };
      return withRoot(closure, new Map([[module.file, source]]), async root => {
        const compiled = await options.compile(module, root);
        if ('failure' in compiled) return { ok: false, module, failure: compiled.failure };
        const artifacts = harvest(store, key, root, options.relativeProjectRoot, module);
        if (!artifacts?.length) removeStored(store, key);
        if (!artifacts)
          return { ok: false, module, failure: options.invalid(`Lean outputs for ${module.file} are not regular files.`) };
        const built: BuiltLeanModule = { key, module, artifacts, closure, origin: 'compiled' };
        if (cache && artifacts.length) persistCached(cache, store, built);
        return { ok: true, built };
      });
    })();
    tasks.set(key, task);
    return task;
  };
  /** Build `modules` (a closed, dependency-first graph); the first failing module in that order is reported. */
  const build = async (modules: readonly MathLocalModule[]): Promise<LeanModuleBuildResult<F>> => {
    const byFile = new Map(modules.map(module => [module.file, module]));
    const visits = new Map<string, Promise<Outcome<F>>>();
    const visit = (module: MathLocalModule): Promise<Outcome<F>> => {
      let visited = visits.get(module.file);
      if (!visited) {
        visited = (async () => {
          const imports = await Promise.all(module.imports.map(file => {
            const imported = byFile.get(file);
            if (!imported) throw new Error('math_local_module_graph_incomplete');
            return visit(imported);
          }));
          const failed = imports.find(outcome => !outcome.ok);
          if (failed) return failed;
          return buildModule(module, imports.map(outcome => (outcome as Extract<Outcome<F>, { ok: true }>).built));
        })();
        visits.set(module.file, visited);
      }
      return visited;
    };
    const settled = await Promise.allSettled(modules.map(visit));
    const rejected = settled.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    const outcomes = settled.map(result => (result as PromiseFulfilledResult<Outcome<F>>).value);
    const failed = outcomes.find(outcome => 'failure' in outcome);
    if (failed && 'failure' in failed) return { ok: false, module: failed.module, failure: failed.failure };
    return { ok: true, modules: outcomes.map(outcome => (outcome as Extract<Outcome<F>, { ok: true }>).built) };
  };

  return {
    build,
    /** Run `work` in a fresh project root seeded with `files` and the artifacts of `modules` and their imports. */
    withProject: withRoot,
  };
}
