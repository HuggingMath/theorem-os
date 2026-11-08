import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { assertMathCanonicalPath } from './paths';
import { canonicalMathJson, mathDigest, readMathFile, withMathRuntimeLease } from './mathRuntimeIo';
import { LAKE_CONFIGURATION_FILES } from './mathConstructionSources';

export const DEFAULT_LEAN_LIBRARY_CACHE_ROOT = `/var/tmp/theoremos-lean-library-${process.getuid?.() ?? process.pid}`;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const suffixes = ['.olean', '.olean.private', '.olean.server', '.ir', '.ir.sig'] as const;
const resultSchema = z.object({ started: z.literal(true), exitCode: z.literal(0), timedOut: z.literal(false),
  aborted: z.literal(false), stdout: z.string(), stderr: z.string(),
  stdoutSha256: digest.optional(), stderrSha256: digest.optional() });
const entrySchema = z.object({ schema: z.literal('theoremos.lean-library-cache.v1'), key: digest,
  artifacts: z.array(z.object({ suffix: z.enum(suffixes), digest, bytes: z.number().int().nonnegative() })).min(1).max(5),
  result: resultSchema }).strict();
type Entry = z.infer<typeof entrySchema>;
export type LeanCompilationResult = { started: boolean; exitCode: number | null; timedOut: boolean; aborted?: boolean;
  durationMs: number; stdout: string; stderr: string; stdoutSha256?: string; stderrSha256?: string };

export const completeLeanCompilationOutput = (result: Pick<LeanCompilationResult,
  'stdout' | 'stderr' | 'stdoutSha256' | 'stderrSha256'>) =>
  result.stdoutSha256 === mathDigest(result.stdout) && result.stderrSha256 === mathDigest(result.stderr);

/** Generated overrides name the same pinned packages through different worktrees. */
export function leanLibraryConfiguration(project: string): string[] | undefined {
  try {
    return LAKE_CONFIGURATION_FILES.map(file => {
      const absolute = path.join(project, file); assertMathCanonicalPath(absolute);
      if (!fs.existsSync(absolute)) return '';
      const bytes = readMathFile(absolute, 16_000_000).bytes;
      if (file !== '.lake/package-overrides.json') return mathDigest(bytes);
      const value = JSON.parse(bytes.toString());
      if (!Array.isArray(value.packages)) throw new Error('Invalid package overrides');
      const packages = value.packages.map((entry: { name: string; dir: string }) => {
        const name = entry.name.replace(/^«(.+)»$/u, '$1');
        if (!name || /[/\\\0]/u.test(name) || name === '.' || name === '..' ||
            entry.dir !== path.join(project, '.lake', 'packages', name)) throw new Error('Non-generated package path');
        return { ...entry, dir: fs.realpathSync(entry.dir) };
      });
      return mathDigest(canonicalMathJson({ ...value, packages }));
    });
  } catch { return undefined; }
}

function privateFile(file: string, limit: number) {
  assertMathCanonicalPath(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || process.getuid && stat.uid !== process.getuid())
    throw new Error('math_lean_library_cache_file_invalid');
  return readMathFile(file, limit).bytes;
}

/** Host-only successful compiler artifacts. These are never proof-acceptance receipts. */
export function openLeanCompilationCache(root: string) {
  assertMathCanonicalPath(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || process.getuid && stat.uid !== process.getuid())
    throw new Error('math_lean_library_cache_directory_invalid');
  const keyFile = path.join(root, 'key');
  try { fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const signingKey = privateFile(keyFile, 32);
  if (signingKey.length !== 32) throw new Error('math_lean_library_cache_key_invalid');
  const signature = (entry: Entry) => crypto.createHmac('sha256', signingKey)
    .update('theoremos.lean-library-cache.v1\0').update(canonicalMathJson(entry)).digest('hex');
  const artifactPath = (output: string, suffix: typeof suffixes[number]) => output.replace(/\.olean$/u, suffix);

  const restore = (key: string, output: string): LeanCompilationResult | undefined => {
    const directory = path.join(root, key);
    let entry: Entry, artifacts: { suffix: typeof suffixes[number]; bytes: Buffer }[];
    try {
      const saved = JSON.parse(privateFile(path.join(directory, 'entry.json'), 9_000_000).toString());
      entry = entrySchema.parse(saved.entry);
      if (entry.key !== key || !crypto.timingSafeEqual(Buffer.from(digest.parse(saved.signature), 'hex'),
        Buffer.from(signature(entry), 'hex')) || !entry.artifacts.some(item => item.suffix === '.olean') ||
        new Set(entry.artifacts.map(item => item.suffix)).size !== entry.artifacts.length ||
        !completeLeanCompilationOutput({ stdout: entry.result.stdout, stderr: entry.result.stderr,
          stdoutSha256: entry.result.stdoutSha256, stderrSha256: entry.result.stderrSha256 })) return undefined;
      // Check all bytes before installing any file; a partial/corrupt entry is a miss.
      artifacts = entry.artifacts.map(item => {
        const bytes = privateFile(path.join(directory, `artifact${item.suffix}`), 256_000_000);
        if (bytes.length !== item.bytes || mathDigest(bytes) !== item.digest) throw new Error('cache_artifact_changed');
        return { suffix: item.suffix, bytes };
      });
    } catch { return undefined; }
    for (const suffix of suffixes) {
      const target = artifactPath(output, suffix); assertMathCanonicalPath(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const item = artifacts.find(item => item.suffix === suffix);
      if (item) {
        const temporary = target + '.' + crypto.randomUUID() + '.tmp';
        try {
          fs.writeFileSync(temporary, item.bytes, { flag: 'wx', mode: 0o600 });
          fs.renameSync(temporary, target);
        } finally { fs.rmSync(temporary, { force: true }); }
      }
      else fs.rmSync(target, { force: true });
    }
    return { ...entry.result, started: true, exitCode: 0, timedOut: false, aborted: false,
      stdout: entry.result.stdout, stderr: entry.result.stderr, durationMs: 0 };
  };

  const publish = (key: string, output: string, result: LeanCompilationResult) => {
    if (!fs.existsSync(output)) return;
    const directory = path.join(root, key), temporary = path.join(root, crypto.randomUUID() + '.tmp');
    fs.mkdirSync(temporary, { mode: 0o700 });
    try {
      const artifacts: Entry['artifacts'] = [];
      for (const suffix of suffixes) {
        const source = artifactPath(output, suffix); assertMathCanonicalPath(source);
        if (!fs.existsSync(source)) continue;
        const bytes = readMathFile(source, 256_000_000).bytes;
        fs.writeFileSync(path.join(temporary, `artifact${suffix}`), bytes, { mode: 0o400, flag: 'wx' });
        artifacts.push({ suffix, digest: mathDigest(bytes), bytes: bytes.length });
      }
      const entry = entrySchema.parse({ schema: 'theoremos.lean-library-cache.v1', key, artifacts,
        result: { ...result, aborted: Boolean(result.aborted) } });
      fs.writeFileSync(path.join(temporary, 'entry.json'), canonicalMathJson({ entry, signature: signature(entry) }),
        { flag: 'wx', mode: 0o400 });
      fs.rmSync(directory, { force: true, recursive: true });
      fs.renameSync(temporary, directory);
    } finally { fs.rmSync(temporary, { force: true, recursive: true }); }
  };

  return {
    async use(input: { key: string; output: string; deadline: number; signal?: AbortSignal;
      current: (result: LeanCompilationResult) => boolean; compile: () => Promise<LeanCompilationResult>; onWait?: () => void;
      onPublishError?: () => void }) {
      digest.parse(input.key);
      let waiting = false;
      for (;;) {
        input.signal?.throwIfAborted();
        if (Date.now() >= input.deadline) return { hit: false, result: { started: false, exitCode: null,
          timedOut: true, aborted: false, durationMs: 0, stdout: '', stderr: '' } as LeanCompilationResult };
        try {
          return await withMathRuntimeLease({ lockPath: path.join(root, input.key + '.lock'),
            flockExecutable: '/usr/bin/flock', signal: input.signal }, async () => {
            input.signal?.throwIfAborted();
            if (Date.now() >= input.deadline) return { hit: false, result: { started: false, exitCode: null,
              timedOut: true, aborted: false, durationMs: 0, stdout: '', stderr: '' } as LeanCompilationResult };
            const cached = restore(input.key, input.output);
            if (cached) return { hit: true, result: cached };
            const result = await input.compile();
            if (result.started && result.exitCode === 0 && !result.timedOut && !result.aborted &&
                completeLeanCompilationOutput(result) && input.current(result)) {
              try { publish(input.key, input.output, result); }
              catch { input.onPublishError?.(); }
            }
            return { hit: false, result };
          });
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'math_runtime_lease_busy') throw error;
          if (!waiting) { waiting = true; input.onWait?.(); }
          await delay(Math.min(200, Math.max(1, input.deadline - Date.now())), undefined, { signal: input.signal });
        }
      }
    },
  };
}
