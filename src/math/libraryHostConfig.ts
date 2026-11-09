import path from 'node:path';
import { z } from 'zod';
import { assertMathCanonicalPath } from './paths';
import { mathDigest, readMathFile } from './mathRuntimeIo';
import { canonicalLibraryJson, libraryUnicodeCompare, parseLibraryJson, validateLibraryRelease,
  type LibraryReleaseArtifacts } from './libraryRelease';
import { libraryTaskPolicySchema, resolveEffectiveLibraryPack, type EffectiveLibraryBinding,
  type EffectiveLibraryPack } from './libraryEffectivePack';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const identitySchema = z.object({ taskId: z.string().min(1).max(512),
  benchmarkCommit: z.string().regex(/^[a-f0-9]{40}$/u).optional() }).strict();
const configSchema = z.object({ schema: z.literal('theorem-os.library-host-config.v1'),
  releaseDirectory: z.string().min(1), manifestSha256: hash, sourceLakeManifest: z.string().min(1),
  tasks: z.array(identitySchema.extend({ selection: libraryTaskPolicySchema.shape.selection }).strict()).min(1).max(10000),
}).strict();
export type LibraryHostConfig = z.infer<typeof configSchema>;
export type LibraryHostTaskIdentity = z.infer<typeof identitySchema>;
export type LibraryHostTarget = Readonly<{ toolchain: string; lakeManifest: string; runtimeEnvironmentDigest: string }>;

/** This setting belongs to the host process, never task JSON, receipts, or math.env. */
export function libraryHostConfigPath(): string | undefined {
  const value = process.env.THEOREMOS_LIBRARY_HOST_CONFIG;
  if (value !== undefined && (!value.trim() || !path.isAbsolute(value))) throw new Error('library_host_config_path_invalid');
  return value;
}

const packageSchema = z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), type: z.literal('git'),
  url: z.string().url().startsWith('https://github.com/'), rev: z.string().regex(/^[a-f0-9]{40}$/u),
  subDir: z.null(), configFile: z.enum(['lakefile.lean', 'lakefile.toml']), manifestFile: z.literal('lake-manifest.json'),
  scope: z.string(), inputRev: z.string().min(1), inherited: z.boolean(),
}).strict();
const lockSchema = z.object({ version: z.literal('1.2.0'), packagesDir: z.literal('.lake/packages'),
  lakeDir: z.literal('.lake'), name: z.string().min(1), fixedToolchain: z.boolean().optional(),
  packages: z.array(packageSchema).min(1).max(256),
}).strict();

/** Compare every pinned package. Root names, ordering, input refs and dependency provenance do not affect code identity. */
export function libraryDependencyLockDigest(bytes: Uint8Array): string {
  const lock = lockSchema.parse(parseLibraryJson(bytes));
  if (new Set(lock.packages.map(item => item.name)).size !== lock.packages.length) throw new Error('library_dependency_duplicate');
  const packages = lock.packages.map(({ scope: _scope, inputRev: _inputRev, inherited: _inherited, ...identity }) => identity)
    .sort((a, b) => libraryUnicodeCompare(a.name, b.name));
  return mathDigest(canonicalLibraryJson(packages));
}

function hostFile(file: string, workspace: string, limit: number): Buffer {
  if (!path.isAbsolute(file)) throw new Error('library_host_config_path_invalid');
  assertMathCanonicalPath(file);
  const relative = path.relative(path.resolve(workspace), file);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
    throw new Error('library_host_file_in_workspace');
  return readMathFile(file, limit).bytes;
}

/** All configuration paths are absolute and must stay outside the solver workspace. No unmapped fallback. */
export function resolveHostLibrary(task: LibraryHostTaskIdentity, target: LibraryHostTarget, workspace: string,
  configPath = libraryHostConfigPath()): EffectiveLibraryPack | undefined {
  if (configPath === undefined) return undefined;
  identitySchema.parse(task);
  const bytes = hostFile(configPath, workspace, 2 * 1024 * 1024);
  const config = configSchema.parse(parseLibraryJson(bytes));
  const keys = config.tasks.map(({ selection: _selection, ...identity }) => canonicalLibraryJson(identity));
  if (new Set(keys).size !== keys.length) throw new Error('library_host_task_duplicate');
  const index = keys.indexOf(canonicalLibraryJson(task));
  if (index < 0) throw new Error('library_host_task_unmapped');
  const limits = { 'pack.json': 40 * 1024 * 1024, 'library.json': 8 * 1024 * 1024,
    'verification.json': 32 * 1024 * 1024, 'declaration-metadata.jsonl': 32 * 1024 * 1024,
    'search-index-manifest.json': 64 * 1024 };
  if (!path.isAbsolute(config.releaseDirectory)) throw new Error('library_host_config_path_invalid');
  const artifacts = Object.fromEntries(Object.entries(limits).map(([name, limit]) =>
    [name, hostFile(path.join(config.releaseDirectory, name), workspace, limit)])) as unknown as LibraryReleaseArtifacts;
  const release = validateLibraryRelease(artifacts, config.manifestSha256);
  const sourceLock = hostFile(config.sourceLakeManifest, workspace, 2 * 1024 * 1024);
  const dependencyLockSha256 = libraryDependencyLockDigest(sourceLock);
  if (mathDigest(sourceLock) !== release.environment.lake_manifest_sha256 ||
      lockSchema.parse(parseLibraryJson(sourceLock)).packages.find(item => item.name === 'mathlib')?.rev !== release.environment.mathlib ||
      target.toolchain !== release.environment.toolchain ||
      dependencyLockSha256 !== libraryDependencyLockDigest(Buffer.from(target.lakeManifest)))
    throw new Error('library_host_dependency_mismatch');
  const effective = resolveEffectiveLibraryPack(artifacts, { schema: 'theorem-os.library-task-policy.v1', taskId: task.taskId,
    manifestSha256: config.manifestSha256, environment: release.environment,
    runtimeEnvironmentDigest: target.runtimeEnvironmentDigest, selection: config.tasks[index]!.selection });
  return { ...effective, binding: { ...effective.binding, hostConfiguration: { sha256: mathDigest(bytes), dependencyLockSha256 } } };
}

/** Re-resolve from the current host setting; a receipt cannot select its own configuration file. */
export function assertHostLibraryCurrent(binding: EffectiveLibraryBinding | undefined, task: LibraryHostTaskIdentity,
  target: LibraryHostTarget, workspace: string): void {
  const effective = resolveHostLibrary(task, target, workspace);
  if ((binding?.hostConfiguration || effective) &&
      canonicalLibraryJson(binding ?? null) !== canonicalLibraryJson(effective?.binding ?? null))
    throw new Error('library_host_binding_changed');
}
