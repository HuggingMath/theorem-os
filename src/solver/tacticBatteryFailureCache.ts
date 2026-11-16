import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { LAKE_CONFIGURATION_FILES } from '../math/mathConstructionSources';
import { parseLeanDiagnosticOutput } from '../math/leanDiagnosticMessages';
import { MATH_PROOF_ENVIRONMENT_SANDBOX_ENV } from '../math/mathProofEnvironment';
import { canonicalMathJson, mathArtifactCurrent, mathDigest, readMathFile, writeMathJsonDurable } from '../math/mathRuntimeIo';
import type { checkLeanType, prepareLeanTypeDiagnostic } from '../math/leanTypeDiagnostics';
import type { LeanDiagnosticMessage } from '../math/leanTypes';
import { assertMathCanonicalPath } from '../math/paths';

export const DEFAULT_TACTIC_BATTERY_FAILURE_CACHE_ROOT = `/var/tmp/theoremos-tactic-battery-${process.getuid?.() ?? process.pid}`;
const schema = 'theoremos.tactic-battery-failure.v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const entrySchema = z.object({ schema: z.literal(schema), key: digest, diagnosticDigest: digest,
  outcome: z.literal('ordinary-tactic-failure') }).strict();
type Entry = z.infer<typeof entrySchema>;
type Prepared = ReturnType<typeof prepareLeanTypeDiagnostic>;
type Checked = Awaited<ReturnType<typeof checkLeanType>>;

/** Only the host-generated override paths may vary between sealed environment mounts. */
function stableConfiguration(prepared: Prepared) {
  return LAKE_CONFIGURATION_FILES.map(file => {
    const source = prepared.snapshot.find(item => item.file === file);
    if (!source) return [file, null];
    if (file !== '.lake/package-overrides.json') return [file, source.digest];
    const manifest = JSON.parse(prepared.snapshot.find(item => item.file === 'lake-manifest.json')!.source);
    const packages = (manifest.packages as { name: string }[]).map(entry => {
      const name = entry.name.replace(/^«(.+)»$/u, '$1');
      if (!name || /[/\\\0]/u.test(name) || name === '.' || name === '..') throw new Error('invalid-package-name');
      const directory = path.join(prepared.project, '.lake', 'packages', name);
      if (fs.realpathSync(directory) !== fs.realpathSync(path.join(prepared.sealed!.packagesRoot, name)))
        throw new Error('unsealed-package-path');
      return { ...entry, type: 'path', dir: directory };
    });
    const generated = { schemaVersion: '1.2.0', packages };
    if (source.source !== JSON.stringify(generated) + '\n') throw new Error('non-generated-package-overrides');
    return [file, mathDigest(canonicalMathJson({ ...generated, packages: packages.map(entry => ({ ...entry,
      dir: ['sealed-package', prepared.sealed!.identity, entry.name] })) }))];
  });
}

/** Unlike the local diagnostic digest, this identity contains no worktree or lease paths. */
export function tacticBatteryFailureIdentity(prepared: Prepared, input: { theoremName: string; candidate: string; timeoutMs: number }) {
  if (!prepared.sealed || !prepared.environment.toolIdentity || prepared.env[MATH_PROOF_ENVIRONMENT_SANDBOX_ENV] ||
      prepared.env.LEAN_PATH?.trim() || prepared.env.LEAN_SYSROOT?.trim()) return undefined;
  try {
    prepared.sealed.verify();
    const configuration = stableConfiguration(prepared);
    const sources = prepared.snapshot.filter(file => !LAKE_CONFIGURATION_FILES.includes(file.file));
    const projected = prepared.projection.files.filter(file => !LAKE_CONFIGURATION_FILES.includes(file.file));
    const key = mathDigest(canonicalMathJson({ schema, theoremName: input.theoremName, candidate: mathDigest(input.candidate),
      timeoutMs: Number.isFinite(input.timeoutMs) ? input.timeoutMs : 'unlimited', configuration,
      environment: prepared.environment, sealed: prepared.sealed.identity,
      // Test/tool hooks can change a sandbox's result without changing its executable bytes.
      testAxioms: prepared.env.DEEPSCIENTIST_TEST_LEAN_AXIOMS ?? null,
      source: sources.map(({ file, digest }) => ({ file, digest })), modules: prepared.modules,
      projection: { files: projected.map(({ file, source }) => ({ file, digest: mathDigest(source) })),
        query: prepared.projection.query, output: prepared.projection.output, commands: prepared.projection.commands } }));
    return { key, current: () => {
      try { return prepared.current() && canonicalMathJson(stableConfiguration(prepared)) === canonicalMathJson(configuration); }
      catch { return false; }
    } };
  } catch { return undefined; }
}

const artifactSchema = z.object({ schema: z.literal('theoremos.lean-diagnostics.v1'),
  authority: z.literal('advisory-lean-process'), file: z.string(), sourceCurrent: z.literal(true),
  sourceDigest: digest, environmentDigest: digest, toolIdentity: z.string(), exitCode: z.union([z.literal(0), z.literal(1)]),
  timedOut: z.literal(false), aborted: z.literal(false), captureComplete: z.literal(true),
  stdout: z.string(), stderr: z.string(), stdoutSha256: digest, stderrSha256: digest });
const exceptionalFailure = /\b(?:heartbeats?|deterministic\W+timeout|timeout|timed\s+out|deadline|recursion\s+depth|maxRecDepth|stack\s+overflow|out\s+of\s+memory|memory\s+limit|resource\s+(?:limit|exhausted)|internal\s+(?:error|exception)|uncaught\s+exception|panic|IO(?:[.\s]+error|[.\s]+exception)|system\s+error|permission\s+denied|no\s+space\s+left|input\/output|failed\s+to\s+(?:open|read|write|allocate))\b/iu;
function ordinaryFailure(message: LeanDiagnosticMessage, query: string) {
  return message.format === 'lean-json' && message.file && path.basename(message.file) === query &&
    !exceptionalFailure.test(message.message) &&
    (message.code === 'Tactic.unsolvedGoals' && /^unsolved goals\b/u.test(message.message) ||
      /^Tactic [`']aesop[`'] failed, made no progress\b/u.test(message.message));
}

/** Read complete captured output, rather than treating a preview or a generic exit 1 as exhaustion. */
export function tacticBatteryFailureDiagnostic(prepared: Prepared, checked: Checked): string | undefined {
  if (checked.status !== 'failed' || checked.exitCode !== 1 || checked.timedOut || 'aborted' in checked && checked.aborted ||
      checked.sourceSnapshotDigest !== prepared.sourceDigest || checked.projectionDigest !== prepared.projection.digest ||
      !mathArtifactCurrent(prepared.project, checked.artifact) || !checked.diagnosticArtifacts.length ||
      checked.phases.at(-1)?.file !== prepared.projection.query || checked.phases.at(-1)?.exitCode !== 1 ||
      checked.phases.slice(0, -1).some(phase => phase.exitCode !== 0)) return undefined;
  try {
    const errors: LeanDiagnosticMessage[] = [];
    let queryFailed = false;
    for (const reference of checked.diagnosticArtifacts) {
      if (reference.captureComplete !== true || path.isAbsolute(reference.path) || reference.path.split('/').includes('..')) return undefined;
      const file = path.join(prepared.project, reference.path); assertMathCanonicalPath(file);
      const bytes = readMathFile(file, 9_000_000).bytes;
      if (mathDigest(bytes) !== reference.digest) return undefined;
      const artifact = artifactSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (artifact.sourceDigest !== reference.sourceDigest || artifact.sourceDigest !== checked.sourceDigest ||
          artifact.environmentDigest !== reference.environmentDigest || artifact.environmentDigest !== checked.environmentDigest ||
          artifact.toolIdentity !== prepared.environment.toolIdentity || mathDigest(artifact.stdout) !== artifact.stdoutSha256 ||
          mathDigest(artifact.stderr) !== artifact.stderrSha256) return undefined;
      if (artifact.exitCode === 1) {
        if (artifact.file !== prepared.projection.query) return undefined;
        queryFailed = true;
      }
      for (const output of [artifact.stdout, artifact.stderr]) {
        const parsed = parseLeanDiagnosticOutput(output);
        if (parsed.raw.trim()) return undefined;
        errors.push(...parsed.messages.filter(message => message.severity === 'error'));
      }
    }
    // Lean recovers a failed tactic with a synthetic sorry; our fixed export guard then reports this second error.
    const recoveryGuard = (message: LeanDiagnosticMessage) => message.format === 'lean-json' && message.file &&
      path.basename(message.file) === prepared.projection.query && message.message === 'Application contains an admitted term';
    if (!queryFailed || !errors.some(message => ordinaryFailure(message, prepared.projection.query)) ||
        errors.some(message => !ordinaryFailure(message, prepared.projection.query) && !recoveryGuard(message))) return undefined;
    return mathDigest(canonicalMathJson(checked.diagnosticArtifacts.map(reference => reference.digest)));
  } catch { return undefined; }
}

function privateFile(file: string, limit: number) {
  assertMathCanonicalPath(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || process.getuid && stat.uid !== process.getuid())
    throw new Error('tactic_battery_cache_file_invalid');
  return readMathFile(file, limit).bytes;
}

/** Host records only; the model sandbox cannot supply a trusted cache directory or signing key. */
export function openTacticBatteryFailureCache(root = DEFAULT_TACTIC_BATTERY_FAILURE_CACHE_ROOT) {
  assertMathCanonicalPath(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || process.getuid && stat.uid !== process.getuid())
    throw new Error('tactic_battery_cache_directory_invalid');
  const keyFile = path.join(root, 'key');
  try { fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const signingKey = privateFile(keyFile, 32);
  if (signingKey.length !== 32) throw new Error('tactic_battery_cache_key_invalid');
  const sign = (entry: Entry) => crypto.createHmac('sha256', signingKey).update(schema + '\0').update(canonicalMathJson(entry)).digest('hex');
  return {
    read(key: string): Entry | undefined {
      try {
        const saved = JSON.parse(privateFile(path.join(root, digest.parse(key) + '.json'), 4096).toString());
        const entry = entrySchema.parse(saved.entry);
        return entry.key === key && crypto.timingSafeEqual(Buffer.from(digest.parse(saved.signature), 'hex'),
          Buffer.from(sign(entry), 'hex')) ? entry : undefined;
      } catch { return undefined; }
    },
    remember(key: string, diagnosticDigest: string) {
      const entry = entrySchema.parse({ schema, key, diagnosticDigest, outcome: 'ordinary-tactic-failure' });
      writeMathJsonDurable(path.join(root, entry.key + '.json'), { entry, signature: sign(entry) }, 0o400);
    },
  };
}
