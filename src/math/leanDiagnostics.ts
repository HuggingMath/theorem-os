import fs from 'node:fs';
import path from 'node:path';
import { limitMathOutput, runLeanProcess } from './mathProcess';
import { assertMathConstructionSources, LAKE_CONFIGURATION_FILES as configurationFiles, mathLocalModuleGraph } from './mathConstructionSources';
import { assertMathCanonicalPath } from './paths';
import { canonicalMathJson, mathDigest, writeMathJsonDurable } from './mathRuntimeIo';
import { runMathematicsSandboxedCommand } from './verifier';
import { resolveMathematicsRuntimeEnvironment } from './mathRuntimeEnvironment';
import { acquireMathProofEnvironmentLease, MathProofEnvironmentLeaseTimeoutError,
  MATH_PROOF_ENVIRONMENT_SANDBOX_ENV, resolveMathProofEnvironment } from './mathProofEnvironment';
import { checkResolvedLeanToolchainReadiness } from './leanToolchainReadiness';
import { parseLeanDiagnosticOutput, renderLeanDiagnosticOutput } from './leanDiagnosticMessages';
import type { LeanDiagnosticArtifactReference, LeanDiagnosticMessage } from './leanTypes';
import { leanDiagnosticEnvironmentIdentity } from './leanResidualGoals';
import { getLeanTaskEnvironment } from './leanTaskEnvironment';
import { completeLeanCompilationOutput, leanLibraryConfiguration, openLeanCompilationCache } from './leanCompilationCache';

const DIAGNOSTIC_CAPTURE_LIMIT = 4_000_000;
type DiagnosticCacheRecord = { source: string; output: string; stdout?: string; stderr?: string;
  diagnosticArtifact?: LeanDiagnosticArtifactReference; messages?: LeanDiagnosticMessage[] };

/** Advisory checks already inside the host's isolated worker must not nest a namespace sandbox. */
async function runWorkerLean(project: string, module: { file: string; sourceRoot: string }, output: string,
  libraryDirectory: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal | undefined, outputLimit: number) {
  const startedAt = Date.now(), deadlineAt = startedAt + timeoutMs;
  const stopped = () => ({ started: false, exitCode: null, timedOut: !signal?.aborted, aborted: Boolean(signal?.aborted),
    durationMs: Date.now() - startedAt, stdout: '', stderr: '' });
  let lease;
  try { lease = await acquireMathProofEnvironmentLease(project, env, signal, deadlineAt); }
  catch (error) {
    if (signal?.aborted || (error instanceof MathProofEnvironmentLeaseTimeoutError && error.kind === 'operation-deadline')) return stopped();
    throw error;
  }
  if (!lease) throw new Error('math_diagnostics_worker_environment_missing');
  try {
    if (signal?.aborted || Date.now() >= deadlineAt) return stopped();
    const readiness = checkResolvedLeanToolchainReadiness({ projectRoot: project, env, timeoutMs: Math.min(10_000, deadlineAt - Date.now()) });
    if (signal?.aborted || Date.now() >= deadlineAt) return stopped();
    if (readiness.status !== 'ready' || !readiness.leanPath) throw new Error('math_diagnostics_lean_unavailable');
    const libraries = [path.join(project, libraryDirectory),
      ...fs.readdirSync(lease.packagesRoot).map(name => path.join(lease.packagesRoot, name, libraryDirectory))]
      .filter(file => fs.existsSync(file));
    fs.mkdirSync(path.dirname(path.join(project, output)), { recursive: true });
    signal?.throwIfAborted();
    const result = await runLeanProcess(readiness.leanPath!, ['--json', '-j1', '-R', module.sourceRoot, '-o', output, module.file], {
      cwd: project, env: { ...env, LEAN_PATH: libraries.join(path.delimiter), LEAN_NUM_THREADS: '1' },
      timeoutMs: Math.max(0, deadlineAt - Date.now()), signal, outputCapture: 'head', outputLimit, stopGraceMs: 0,
    });
    const cap = (text: string) => limitMathOutput(text, outputLimit, 'head');
    return { ...result, started: result.started && !result.errorCode, durationMs: Date.now() - startedAt,
      stdout: cap(result.stdout), stderr: cap(result.stderr + (result.errorMessage ?? '')) };
  } finally { await lease.release(); }
}

/** Local diagnostics are advisory; final acceptance still requires the independent verifier. */
export async function runLeanDiagnostics(input: {
  projectRoot: string; files: readonly string[]; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  timeoutMs: number; dependenciesOnly?: boolean; excludedFiles?: readonly string[];
  onProgress?: (file: string) => void;
  /** Host projections retain a larger diagnostic window than ordinary model prompts. */
  outputLimit?: number;
  /** Only the host's frozen library-pack preparation may share compiler outputs across projects. */
  sharedLibraryCache?: { root: string; files: Readonly<Record<string, string>> };
  onSharedCache?: (event: 'hit' | 'miss' | 'waiting' | 'unavailable', file?: string) => void;
}) {
  const outputLimit = input.outputLimit ?? 8000;
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 1 || outputLimit > 4_000_000)
    throw new Error('math_diagnostics_output_limit_invalid');
  const project = fs.realpathSync(input.projectRoot);
  const env = resolveMathematicsRuntimeEnvironment(input.env || process.env);
  assertMathConstructionSources(project, input.files);
  const toolchainFile = path.join(project, 'lean-toolchain'), legacy = getLeanTaskEnvironment('mathlib-4.8');
  const libraryDirectory = fs.existsSync(toolchainFile) && fs.readFileSync(toolchainFile, 'utf8').trim() === legacy.toolchain
    ? legacy.packageLibraryDirectory! : '.lake/build/lib/lean';
  const modules = mathLocalModuleGraph(project, input.files);
  const excluded = new Set(input.excludedFiles ?? []);
  const cacheFile = path.join(project, '.lake', 'lean-diagnostics.json');
  assertMathCanonicalPath(cacheFile);
  let cache: Record<string, DiagnosticCacheRecord> = {};
  try {
    const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) cache = saved;
  } catch { /* Missing or stale advisory cache. */ }
  const configuration = () => configurationFiles.map(file => {
    const absolute = path.join(project, file);
    return fs.existsSync(absolute) ? mathDigest(fs.readFileSync(absolute)) : '';
  });
  const config = configuration();
  const { environmentDigest: environmentIdentity, toolIdentity } = leanDiagnosticEnvironmentIdentity(project, env);
  let sharedCache: ReturnType<typeof openLeanCompilationCache> | undefined;
  const sharedConfiguration = input.sharedLibraryCache && !env[MATH_PROOF_ENVIRONMENT_SANDBOX_ENV] && toolIdentity &&
    resolveMathProofEnvironment(project, env)?.identity ? leanLibraryConfiguration(project) : undefined;
  if (sharedConfiguration) {
    try { sharedCache = openLeanCompilationCache(input.sharedLibraryCache!.root); }
    catch { input.onSharedCache?.('unavailable'); }
  }
  const sourceFiles = () => modules.map(module => [module.file, mathDigest(fs.readFileSync(path.join(project, module.file)))]);
  const initialSources = sourceFiles();
  const sourceIdentity = () => mathDigest(JSON.stringify([configuration(), sourceFiles()]));
  const sourceDigest = sourceIdentity();
  const builtModules = new Map<string, { digest: string; shareable: boolean }>();
  const deadline = Date.now() + input.timeoutMs;
  const phases: { file: string; cached: boolean; durationMs: number; exitCode: number | null; cacheSource?: 'shared' }[] = [];
  const cap = (text: string) => {
    if (Buffer.byteLength(text) <= outputLimit) return text;
    const notice = '\n[truncated; inspect diagnosticArtifacts for captured output and completeness]';
    return limitMathOutput(text, Math.max(0, outputLimit - Buffer.byteLength(notice)), 'head') +
      limitMathOutput(notice, outputLimit, 'head');
  };
  const appendOutput = (previous: string, next: string) =>
    cap(previous + (previous && !previous.endsWith('\n') && next ? '\n' : '') + next);
  const artifactDigest = (output: string) => mathDigest(JSON.stringify([
    output, output + '.private', output + '.server', output.replace(/\.olean$/u, '.ir'), output.replace(/\.olean$/u, '.ir.sig'),
  ].map(file => {
    assertMathCanonicalPath(file);
    return fs.existsSync(file) ? mathDigest(fs.readFileSync(file)) : null;
  })));
  let stdout = '', stderr = '';
  const messages: LeanDiagnosticMessage[] = [], diagnosticArtifacts: LeanDiagnosticArtifactReference[] = [];
  const finish = <T extends { exitCode: number | null; timedOut: boolean; aborted?: boolean }>(result: T): T => {
    const latest = path.join(project, '.lake', 'lean-diagnostics-latest.json');
    assertMathCanonicalPath(latest);
    fs.mkdirSync(path.dirname(latest), { recursive: true, mode: 0o700 });
    writeMathJsonDurable(latest, {
      schema: 'theoremos.lean-diagnostics-latest.v1', authority: 'advisory-lean-process',
      sourceDigest, environmentDigest: environmentIdentity, toolIdentity, requestedFiles: [...input.files],
      configuration: configurationFiles.map((file, index) => ({ file, digest: config[index] || null })),
      sourceFiles: initialSources.map(([file, digest]) => ({ file, digest })),
      exitCode: result.exitCode, timedOut: result.timedOut, aborted: result.aborted ?? false, diagnosticArtifacts,
    });
    return result;
  };
  const captured = (reference: LeanDiagnosticArtifactReference) => {
    try {
      if (!reference || typeof reference.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.digest) ||
          reference.path !== `.lake/diagnostic-artifacts/${reference.digest}.json` || reference.environmentDigest !== environmentIdentity) return false;
      const file = path.join(project, reference.path); assertMathCanonicalPath(file);
      const text = fs.readFileSync(file, 'utf8');
      return mathDigest(text) === reference.digest;
    } catch { return false; }
  };
  const messagePreview = (message: LeanDiagnosticMessage) => ({ ...message, message: cap(message.message),
    ...(message.goalText ? { goalText: cap(message.goalText) } : {}), truncated: Buffer.byteLength(message.message) > outputLimit });
  const summary = () => {
    const firstBlocking = messages.find(message => message.severity === 'error');
    const selected: ReturnType<typeof messagePreview>[] = [];
    let bytes = 0;
    for (const message of messages.slice(0, 64)) {
      const preview = messagePreview(message), size = Buffer.byteLength(JSON.stringify(preview));
      if (bytes + size > outputLimit) break;
      selected.push(preview); bytes += size;
    }
    return { sourceDigest, environmentDigest: environmentIdentity,
      firstBlocking: firstBlocking && messagePreview(firstBlocking), messages: selected,
      omittedMessages: messages.length - selected.length, diagnosticArtifacts,
      previewTruncated: selected.length < messages.length || Boolean(firstBlocking && Buffer.byteLength(firstBlocking.message) > outputLimit) ||
        diagnosticArtifacts.some(reference => reference.captureComplete === false) || /\[truncated;/u.test(stdout + stderr) };
  };
  const retain = (file: string, result: { stdout: string; stderr: string; stdoutSha256?: string; stderrSha256?: string;
    exitCode: number | null; timedOut: boolean; aborted?: boolean }) => {
    const capturedComplete = (text: string, hash?: string) => hash ? mathDigest(text) === hash : null;
    const complete = [capturedComplete(result.stdout, result.stdoutSha256), capturedComplete(result.stderr, result.stderrSha256)];
    const captureComplete = complete.includes(false) ? false : complete.includes(null) ? null : true;
    const observed = [...parseLeanDiagnosticOutput(result.stdout).messages, ...parseLeanDiagnosticOutput(result.stderr).messages];
    const artifact = { schema: 'theoremos.lean-diagnostics.v1', authority: 'advisory-lean-process', sourceDigest,
      environmentDigest: environmentIdentity, toolIdentity, file, sourceCurrent: sourceIdentity() === sourceDigest,
      sourceFiles: initialSources.map(([file, digest]) => ({ file, digest })),
      exitCode: result.exitCode, timedOut: result.timedOut, aborted: result.aborted ?? false,
      captureComplete, captureLimit: DIAGNOSTIC_CAPTURE_LIMIT,
      stdout: result.stdout, stderr: result.stderr, stdoutSha256: result.stdoutSha256 ?? null, stderrSha256: result.stderrSha256 ?? null,
      messages: observed };
    const text = canonicalMathJson(artifact), digest = mathDigest(text), relative = `.lake/diagnostic-artifacts/${digest}.json`;
    const artifactFile = path.join(project, relative); assertMathCanonicalPath(artifactFile);
    fs.mkdirSync(path.dirname(artifactFile), { recursive: true, mode: 0o700 });
    writeMathJsonDurable(artifactFile, artifact);
    const reference = { path: relative, digest, sourceDigest, environmentDigest: environmentIdentity, captureComplete };
    diagnosticArtifacts.push(reference); messages.push(...observed);
    return { reference, observed };
  };
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  try {
  for (const module of modules) {
    input.signal?.throwIfAborted();
    const moduleDigest = mathDigest(fs.readFileSync(path.join(project, module.file)));
    // Bind only the import closure, not unrelated modules visited earlier in this batch.
    // Each imported fingerprint includes its source, transitive inputs and actual compiler artifacts.
    const sources = [moduleDigest, module.imports.map(file => [file, builtModules.get(file)!.digest])];
    const sharedInputs = input.sharedLibraryCache?.files[module.file] === moduleDigest &&
      module.imports.every(file => builtModules.get(file)!.shareable);
    const output = `${libraryDirectory}/${path.posix.relative(module.sourceRoot, module.file).replace(/\.lean$/u, '.olean')}`;
    const absoluteOutput = path.join(project, output);
    assertMathCanonicalPath(absoluteOutput);
    const remember = (artifact: string | null, shareable: boolean) => builtModules.set(module.file, {
      digest: mathDigest(canonicalMathJson([module.file, module.sourceRoot, sources, artifact])), shareable,
    });
    if (input.dependenciesOnly && (input.files.includes(module.file) || excluded.has(module.file))) {
      remember(fs.existsSync(absoluteOutput) ? artifactDigest(absoluteOutput) : null, false);
      continue;
    }
    const digest = mathDigest(canonicalMathJson(['lean-diagnostics-module.v2', environmentIdentity, config,
      libraryDirectory, module.file, module.sourceRoot, sources]));
    const saved = cache[module.file];
    if (saved?.source === digest && fs.existsSync(absoluteOutput) && saved.output === artifactDigest(absoluteOutput) &&
        saved.diagnosticArtifact && captured(saved.diagnosticArtifact)) {
      phases.push({ file: module.file, cached: true, durationMs: 0, exitCode: 0 });
      stdout = appendOutput(stdout, cap(typeof saved.stdout === 'string' ? saved.stdout : ''));
      stderr = appendOutput(stderr, cap(typeof saved.stderr === 'string' ? saved.stderr : ''));
      diagnosticArtifacts.push(saved.diagnosticArtifact); messages.push(...(saved.messages ?? []));
      remember(saved.output, sharedInputs && saved.diagnosticArtifact.captureComplete === true &&
        !/declaration uses '?sorry'?/u.test((saved.stdout ?? '') + '\n' + (saved.stderr ?? '')));
      continue;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return finish({ exitCode: null, timedOut: true, stdout, stderr, phases, ...summary() });
    const compile = async () => {
      input.onProgress?.(module.file);
      return env[MATH_PROOF_ENVIRONMENT_SANDBOX_ENV]
      ? await runWorkerLean(project, module, output, libraryDirectory, env, remainingMs, input.signal, DIAGNOSTIC_CAPTURE_LIMIT)
      : await runMathematicsSandboxedCommand({ checkoutRoot: project, command: 'lake',
      args: ['env', '/bin/sh', '-ceu', `mkdir -p ${quote(path.posix.dirname(output))}\nexec lean --json -j1 -R ${quote(module.sourceRoot)} -o ${quote(output)} ${quote(module.file)}`],
      env, signal: input.signal, timeoutMs: Math.max(1, deadline - Date.now()), outputCapture: 'head', outputLimit: DIAGNOSTIC_CAPTURE_LIMIT });
    };
    const shared = sharedCache && sharedInputs ? await sharedCache.use({
      key: mathDigest(canonicalMathJson(['lean-library-module.v2', environmentIdentity, toolIdentity, sharedConfiguration,
        libraryDirectory, module.file, module.sourceRoot, sources])), output: absoluteOutput, deadline, signal: input.signal,
      // Sorry-bearing libraries are rejected by preparation and must not be published for another task.
      current: result => sourceIdentity() === sourceDigest && !/declaration uses '?sorry'?/u.test(result.stdout + '\n' + result.stderr),
      compile, onWait: () => input.onSharedCache?.('waiting', module.file),
      onPublishError: () => input.onSharedCache?.('unavailable', module.file),
    }) : { hit: false, result: await compile() };
    const result = shared.result;
    if (sharedCache && sharedInputs) input.onSharedCache?.(shared.hit ? 'hit' : 'miss', module.file);
    phases.push({ file: module.file, cached: shared.hit, durationMs: result.durationMs, exitCode: result.exitCode,
      ...(shared.hit ? { cacheSource: 'shared' as const } : {}) });
    const retained = retain(module.file, result);
    if (sourceIdentity() !== sourceDigest) return finish({ exitCode: 1, timedOut: false,
      stdout: cap(renderLeanDiagnosticOutput(result.stdout)), stderr: 'math_diagnostics_source_changed: saved sources changed during compilation',
      phases, ...summary() });
    const moduleStdout = cap(renderLeanDiagnosticOutput(result.stdout)), moduleStderr = cap(renderLeanDiagnosticOutput(result.stderr));
    stdout = appendOutput(stdout, moduleStdout); stderr = appendOutput(stderr, moduleStderr);
    if (result.exitCode !== 0 || result.timedOut || result.aborted || !result.started) return finish({
      ...result, stdout: moduleStdout, stderr: moduleStderr, phases, ...summary(),
    });
    if (fs.existsSync(absoluteOutput)) {
      const artifact = artifactDigest(absoluteOutput);
      cache[module.file] = { source: digest, output: artifact,
        stdout: renderLeanDiagnosticOutput(result.stdout), stderr: renderLeanDiagnosticOutput(result.stderr),
        diagnosticArtifact: retained.reference, messages: retained.observed };
      remember(artifact, sharedInputs && completeLeanCompilationOutput(result) &&
        !/declaration uses '?sorry'?/u.test(result.stdout + '\n' + result.stderr));
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache) + '\n', { mode: 0o600 });
    } else remember(null, false);
  }
  if (sourceIdentity() !== sourceDigest) return finish({ exitCode: 1, timedOut: false, stdout,
    stderr: 'math_diagnostics_source_changed: saved sources changed during diagnostics', phases, ...summary() });
  return finish({ exitCode: 0, timedOut: false, stdout, stderr, phases, ...summary() });
  } catch (error) {
    try {
      finish({ exitCode: null, timedOut: error instanceof MathProofEnvironmentLeaseTimeoutError
        ? error.kind === 'operation-deadline' : error instanceof Error && error.name === 'TimeoutError',
      aborted: input.signal?.aborted, stderr: error instanceof Error ? error.message : String(error) });
    } catch { /* Retaining advisory metadata must not replace the original compilation or filesystem error. */ }
    throw error;
  }
}

/** Rebind an existing or broken package link without deleting a real package directory. */
export function bindLeanPackages(project: string, authorizedPackagesRoot: string): void {
  const root = fs.realpathSync(authorizedPackagesRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error('math_lean_packages_not_directory');
  const packages = path.join(project, '.lake', 'packages');
  assertMathCanonicalPath(path.dirname(packages));
  fs.mkdirSync(path.dirname(packages), { recursive: true });
  const existing = fs.lstatSync(packages, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    if (path.resolve(path.dirname(packages), fs.readlinkSync(packages)) === root) return;
    fs.unlinkSync(packages);
  } else if (existing) {
    if (!existing.isDirectory()) throw new Error('math_lean_packages_not_directory');
    return;
  }
  fs.symlinkSync(root, packages, 'dir');
}

/** Make ordinary model-side Lake commands consume the pinned packages without Git refreshes. */
export function prepareLeanDiagnosticOverrides(project: string): void {
  const manifestFile = path.join(project, 'lake-manifest.json');
  if (!fs.existsSync(manifestFile)) return;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const packages = manifest.packages.map((entry: { name: string }) => {
    const name = entry.name.replace(/^«(.+)»$/u, '$1');
    if (!name || /[/\\\0]/u.test(name) || name === '.' || name === '..') throw new Error('math_invalid_package_name');
    return { ...entry, type: 'path', dir: path.join(project, '.lake', 'packages', name) };
  });
  const file = path.join(project, '.lake', 'package-overrides.json');
  assertMathCanonicalPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: '1.2.0', packages }) + '\n', { mode: 0o600 });
}
