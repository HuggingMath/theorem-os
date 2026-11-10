import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { assertMathCanonicalPath, isMathPathWithin } from './paths';
import { canonicalMathJson, mathDigest, readMathFile } from './mathRuntimeIo';
import { listLeanProbePackageInputs, readLeanProbeSnapshotFile } from './leanProbeSnapshot';
import { MATH_SEALED_ENVIRONMENT_HELPER } from './mathSealedEnvironmentHelper';

/** Host-selected build artifact, never an already trusted private cache entry. */
export const MATH_PROOF_ENVIRONMENT_SEED_ENV = 'DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT_SEED';
export const MATH_PROOF_ENVIRONMENT_SOURCE_SEED_ENV = 'DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT_SOURCE_SEED';
export const MATH_PROOF_ENVIRONMENT_METADATA = '.deepscientist-proof-environment.json';
const CONFIG_FILES = ['lean-toolchain', 'lakefile.toml', 'lakefile.lean', 'lake-manifest.json', '.lake/package-overrides.json'];
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const mathProofEnvironmentStatistics = z.object({
  files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), publications: z.literal(1),
}).strict();
export const mathProofEnvironmentMetadata = z.object({
  schema: z.literal('deepscientist.math.proof-environment-inputs.v1'),
  sourceCacheRoot: z.string(), config: z.record(z.string(), hash.nullable()),
  sourceIdentity: hash, stats: mathProofEnvironmentStatistics,
  contents: z.literal('sources').optional(),
}).strict();
const seedSchema = z.object({
  schema: z.literal('deepscientist.math.proof-environment-seed.v1'),
  helperSha256: hash,
  imageName: z.literal('dependencies.squashfs'), imageSha256: hash, imageBytes: z.number().int().positive(),
  metadata: mathProofEnvironmentMetadata,
}).strict();
export type MathProofEnvironmentSeed = z.infer<typeof seedSchema>;
type File = Readonly<{ path: string; digest: string; mode: number }>;

/** Same dependency configuration binding for cold builds, seeds, and consumers. */
export function mathProofEnvironmentConfiguration(root: string): Record<string, string | null> {
  assertMathCanonicalPath(root);
  return Object.fromEntries(CONFIG_FILES.map(relative => {
    const file = path.join(root, relative);
    try {
      if (relative === 'lakefile.toml' || relative === 'lake-manifest.json') {
        const text = readMathFile(file, 16 * 1024 * 1024).bytes.toString('utf8');
        // A root package label does not change dependencies; all other settings and pins remain bound.
        const { name: _name, ...configuration } = relative.endsWith('.toml') ? parseToml(text) : JSON.parse(text);
        return [relative, mathDigest(canonicalMathJson(configuration))];
      }
      return [relative, readLeanProbeSnapshotFile(file, () => {}).digest];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [relative, null];
      throw error;
    }
  }));
}

/** Portable bytes, paths and sealed executable modes; physical identities are still checked at runtime. */
export function mathProofEnvironmentSeedContentDigest(files: readonly File[]): string {
  return mathDigest(canonicalMathJson(files.map(file => ({
    path: file.path, digest: file.digest, mode: 0o400 | (file.mode & 0o111),
  })).toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

/** A matching seed is only an input to the full first-publication checks, never a cache hit. */
export function readMathProofEnvironmentSeed(manifestPath: string | undefined, config: Record<string, string | null>,
  contents: 'complete' | 'sources' = 'complete') {
  if (!manifestPath) return undefined;
  assertMathCanonicalPath(manifestPath);
  let encoded: Buffer;
  try { encoded = readMathFile(manifestPath, 64 * 1024).bytes; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const seed = seedSchema.parse(JSON.parse(encoded.toString('utf8')));
  if (seed.helperSha256 !== mathDigest(MATH_SEALED_ENVIRONMENT_HELPER) ||
      (seed.metadata.contents ?? 'complete') !== contents ||
      canonicalMathJson(seed.metadata.config) !== canonicalMathJson(config)) return undefined;
  const imagePath = path.join(path.dirname(manifestPath), seed.imageName);
  assertMathCanonicalPath(imagePath);
  const image = fs.lstatSync(imagePath);
  if (!image.isFile() || image.size !== seed.imageBytes || (image.mode & 0o222) !== 0 ||
      (fs.lstatSync(manifestPath).mode & 0o222) !== 0)
    throw new Error('Invalid read-only proof environment seed.');
  // The helper checks the complete image digest after making its independent, unlinked copy.
  return Object.freeze({ ...seed, imagePath });
}

/** Build-time only. Compression and extraction require no FUSE mount or elevated permissions. */
export async function buildMathProofEnvironmentSeed(projectRoot: string, authorizedPackagesRoot: string, outputRoot: string,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; deadlineAt?: number; contents?: 'sources';
    onProgress?: (phase: string) => void } = {}
): Promise<MathProofEnvironmentSeed> {
  for (const root of [projectRoot, authorizedPackagesRoot, outputRoot]) assertMathCanonicalPath(root);
  if (isMathPathWithin(authorizedPackagesRoot, outputRoot)) throw new Error('Proof environment seed output overlaps dependencies.');
  if (fs.existsSync(outputRoot)) throw new Error('Use a new proof environment seed directory.');
  const checkpoint = () => {
    options.signal?.throwIfAborted();
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)
      throw new Error('Proof environment seed build deadline exceeded.');
  };
  const phase = (name: string) => { checkpoint(); options.onProgress?.(name); checkpoint(); };
  phase('enumerating_dependencies');
  const config = mathProofEnvironmentConfiguration(projectRoot);
  const inputs = listLeanProbePackageInputs(authorizedPackagesRoot, checkpoint, options.contents);
  if (inputs.some(input => input.relative === MATH_PROOF_ENVIRONMENT_METADATA))
    throw new Error('Reserved proof environment metadata path.');
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proof-environment-seed-')));
  const source = path.join(temporary, 'packages'), extracted = path.join(temporary, 'extracted');
  const image = path.join(temporary, 'dependencies.squashfs');
  let createdOutput = false;
  const run = async (command: string, args: string[]) => {
    checkpoint();
    await promisify(execFile)(command, args, { env: options.env ?? process.env, signal: options.signal,
      ...(options.deadlineAt === undefined ? {} : { timeout: Math.max(1, options.deadlineAt - Date.now()) }), maxBuffer: 64 * 1024 });
    checkpoint();
  };
  try {
    fs.mkdirSync(source, { mode: 0o700 });
    const buffer = Buffer.alloc(1024 * 1024);
    const files: (File & { identity: string; bytes: number })[] = [];
    phase('copying_dependencies');
    for (const [index, input] of inputs.entries()) {
      const copied = readLeanProbeSnapshotFile(input.source, checkpoint, path.join(source, input.relative), buffer);
      files.push({ path: input.relative, ...copied });
      if (index % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    const metadata = {
      schema: 'deepscientist.math.proof-environment-inputs.v1' as const, sourceCacheRoot: authorizedPackagesRoot, config,
      sourceIdentity: mathProofEnvironmentSeedContentDigest(files),
      stats: { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), publications: 1 as const },
      ...(options.contents ? { contents: options.contents } : {}),
    };
    const metadataBytes = canonicalMathJson(metadata);
    fs.writeFileSync(path.join(source, MATH_PROOF_ENVIRONMENT_METADATA), metadataBytes, { flag: 'wx', mode: 0o400 });
    phase('building_image');
    await run('mksquashfs', [source, image, '-noappend', '-quiet', '-no-progress', '-processors', '2',
      '-mem', '128M', '-comp', 'lz4']);
    // The image is now the snapshot. Release its uncompressed input before making
    // the independent extraction; the authorized source is checked again below.
    fs.rmSync(source, { recursive: true });
    phase('verifying_image');
    await run('unsquashfs', ['-no-progress', '-processors', '2', '-d', extracted, image]);
    const paths: string[] = [];
    const visit = (relative: string) => {
      checkpoint();
      for (const entry of fs.readdirSync(path.join(extracted, relative), { withFileTypes: true })) {
        const name = path.join(relative, entry.name);
        if (entry.isDirectory()) visit(name);
        else if (entry.isFile()) paths.push(name);
        else throw new Error('Proof environment seed contains an unexpected path kind.');
      }
    };
    visit('');
    if (canonicalMathJson(paths.toSorted()) !== canonicalMathJson([...files.map(file => file.path), MATH_PROOF_ENVIRONMENT_METADATA].toSorted()))
      throw new Error('Proof environment seed input set differs from the authorized source.');
    for (const [index, file] of files.entries()) {
      const actual = readLeanProbeSnapshotFile(path.join(extracted, file.path), checkpoint, undefined, buffer);
      if (actual.digest !== file.digest || actual.mode !== (0o400 | (file.mode & 0o111)))
        throw new Error('Proof environment seed bytes or permissions differ from the authorized source.');
      if (index % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    const mountedMetadata = readLeanProbeSnapshotFile(path.join(extracted, MATH_PROOF_ENVIRONMENT_METADATA), checkpoint);
    if (mountedMetadata.digest !== mathDigest(metadataBytes) || mountedMetadata.mode !== 0o400)
      throw new Error('Proof environment seed metadata changed.');
    fs.rmSync(extracted, { recursive: true });
    phase('verifying_source');
    if (canonicalMathJson(listLeanProbePackageInputs(authorizedPackagesRoot, checkpoint, options.contents)) !== canonicalMathJson(inputs))
      throw new Error('Proof environment dependency set changed during seed creation.');
    for (const [index, input] of inputs.entries()) {
      const current = readLeanProbeSnapshotFile(input.source, checkpoint, undefined, buffer);
      if (current.digest !== files[index].digest || current.identity !== files[index].identity)
        throw new Error('Proof environment dependency changed during seed creation.');
      if (index % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (canonicalMathJson(mathProofEnvironmentConfiguration(projectRoot)) !== canonicalMathJson(config))
      throw new Error('Proof environment configuration changed during seed creation.');
    const imageSnapshot = readLeanProbeSnapshotFile(image, checkpoint, undefined, buffer);
    const seed = seedSchema.parse({ schema: 'deepscientist.math.proof-environment-seed.v1',
      helperSha256: mathDigest(MATH_SEALED_ENVIRONMENT_HELPER), imageName: 'dependencies.squashfs',
      imageSha256: imageSnapshot.digest, imageBytes: imageSnapshot.bytes, metadata });
    checkpoint();
    fs.mkdirSync(path.dirname(outputRoot), { recursive: true, mode: 0o700 });
    fs.mkdirSync(outputRoot, { mode: 0o700 }); createdOutput = true;
    const publishedImage = path.join(outputRoot, seed.imageName);
    try {
      // Link without replacing an existing file, then relinquish the temporary
      // name. Same-filesystem publication needs no second compressed image.
      fs.linkSync(image, publishedImage);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      fs.copyFileSync(image, publishedImage, fs.constants.COPYFILE_EXCL);
    }
    fs.unlinkSync(image);
    fs.chmodSync(publishedImage, 0o444);
    fs.writeFileSync(path.join(outputRoot, 'manifest.json'), `${canonicalMathJson(seed)}\n`, { flag: 'wx', mode: 0o444 });
    fs.chmodSync(outputRoot, 0o555);
    return seed;
  } catch (error) {
    if (createdOutput) { fs.chmodSync(outputRoot, 0o700); fs.rmSync(outputRoot, { recursive: true, force: true }); }
    throw error;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
