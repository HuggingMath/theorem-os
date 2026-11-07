import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertMathConstructionSources, LAKE_CONFIGURATION_FILES, mathLocalModuleBuildOrder } from './mathConstructionSources';
import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from './leanSource';
import { maskLeanComments, maskLeanCommentsAndStrings } from './leanSyntax';
import { bindLeanPackages, prepareLeanDiagnosticOverrides, runLeanDiagnostics } from './leanDiagnostics';
import { resolveMathProofEnvironment } from './mathProofEnvironment';
import { leanDiagnosticEnvironmentIdentity } from './leanResidualGoals';
import { canonicalMathJson, mathDigest, readMathFile } from './mathRuntimeIo';
import { isAllowedMathProofSource } from './mathProofSourcePolicy';
import { assertMathCanonicalPath, repositoryRelativePath } from './paths';
import { limitMathOutput } from './mathProcess';

export type LeanSearchReplaySource = Readonly<{ file: string; source: string }>;
type LeanSearchProjectionInput = {
  projectRoot: string; file: string; theoremName: string; type: string; env: NodeJS.ProcessEnv;
};

/** Only an explicit, closed helper type is supported. No target or downstream declaration enters its environment. */
export function leanSearchPrefix(source: string, theoremName: string, type: string): string {
  const targets = inspectScopedLeanDeclarations(source).filter(item => item.qualifiedName === theoremName);
  if (targets.length !== 1 || targets[0].kind !== 'theorem') throw new Error('proof_search_unsupported_target');
  const target = targets[0], region = inspectLeanDeclarationRegions(source).find(item => item.startOffset === target.startOffset)!;
  const rawHeader = source.slice(region.startOffset, region.bodyOffset), header = maskLeanComments(rawHeader);
  const match = /^((?:theorem|lemma)\s+[^\s:({[.]+(?:\.[^\s:({[.]+)*\s*:\s*)([\s\S]*):=\s*$/u.exec(header);
  // Textual binding is deliberately exact inside the type. Whitespace in literals, quoted names
  // and layout-sensitive terms cannot be normalized without changing the assigned proposition.
  const sourceType = match && rawHeader.slice(match[1].length, match[1].length + match[2].length).trim();
  if (!match || sourceType !== type.trim()) throw new Error('proof_search_unsupported_nonclosed_header');
  const prefix = source.slice(0, region.startOffset);
  // The source scanner is conservative; a trailing attribute/modifier or command-local scope is not a declaration boundary.
  const clean = maskLeanCommentsAndStrings(prefix).trimEnd();
  if (/(?:\b(?:in|private|protected|noncomputable|unsafe|partial)|@\[[^\]]*\])$/u.test(clean) ||
      /^[ \t]*(?:variable|include|omit|mutual)\b/mu.test(clean)) throw new Error('proof_search_unsupported_local_context');
  // Only trailing trivia belongs to the removed target. Earlier doc comments and literal bytes stay intact.
  const codeEnd = maskLeanComments(prefix).trimEnd().length;
  return prefix.slice(0, codeEnd) + '\nset_option autoImplicit false\n';
}

function assertRealContext(source: string) {
  if (/\b(?:sorry|admit|axiom|constant|native_decide|unsafe)\b/u.test(maskLeanCommentsAndStrings(source)))
    throw new Error('proof_search_unsupported_unproved_context');
}

/** Snapshot exact sources and package identity before starting the backend. Proof bodies are never erased. */
export function prepareLeanSearchProjection(input: LeanSearchProjectionInput) {
  const project = fs.realpathSync(input.projectRoot);
  assertMathConstructionSources(project, [input.file]);
  const modules = mathLocalModuleBuildOrder(project, input.file);
  const files = [...modules.map(item => item.file), ...LAKE_CONFIGURATION_FILES.filter(file => fs.existsSync(path.join(project, file)))];
  const snapshot = files.map(file => {
    const absolute = path.join(project, file); assertMathCanonicalPath(absolute);
    const read = readMathFile(absolute, 4_000_000);
    return { file, source: read.bytes.toString('utf8'), digest: mathDigest(read.bytes), identity: read.identity };
  });
  const prefix = leanSearchPrefix(snapshot.find(item => item.file === input.file)!.source, input.theoremName, input.type);
  assertRealContext(prefix);
  for (const item of snapshot) if (item.file !== input.file && item.file.endsWith('.lean') && item.file !== 'lakefile.lean') assertRealContext(item.source);
  const environment = leanDiagnosticEnvironmentIdentity(project, input.env), sealed = resolveMathProofEnvironment(project, input.env);
  const sourceFiles = snapshot.map(({ file, digest }) => ({ file, digest }));
  const sourceDigest = mathDigest(canonicalMathJson(sourceFiles));
  const projectionDigest = mathDigest(canonicalMathJson({ schema: 'theorem-os.lean-search-projection.v1',
    prefix, type: input.type, file: input.file, theoremName: input.theoremName, modules, sourceFiles }));
  const verify = () => {
    for (const item of snapshot) {
      const current = readMathFile(path.join(project, item.file), 4_000_000);
      if (current.identity !== item.identity || mathDigest(current.bytes) !== item.digest) throw new Error('proof_search_stale_source');
    }
    sealed?.verify();
    if (canonicalMathJson(leanDiagnosticEnvironmentIdentity(project, input.env)) !== canonicalMathJson(environment))
      throw new Error('proof_search_stale_environment');
  };
  const directory = path.join(project, '.lake/proof-search-snapshots', crypto.randomUUID()), clone = path.join(directory, 'project');
  assertMathCanonicalPath(clone); fs.mkdirSync(clone, { recursive: true, mode: 0o700 });
  const dispose = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    for (const item of snapshot) {
      const destination = path.join(clone, item.file); fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      // Only the original import closure is needed for dependency compilation. The full target is never compiled or imported.
      fs.writeFileSync(destination, item.file === input.file ? prefix : item.source, { mode: 0o600 });
    }
    const packages = sealed?.packagesRoot ?? path.join(project, '.lake/packages');
    if (fs.existsSync(packages)) bindLeanPackages(clone, packages);
    prepareLeanDiagnosticOverrides(clone); verify();
    if (sealed && resolveMathProofEnvironment(clone, input.env)?.identity !== sealed.identity) throw new Error('proof_search_stale_environment');
    return { project: clone, prefix, sourceDigest, projectionDigest, sourceFiles, environment,
      replaySources: snapshot.map(({ file, source }) => ({ file, source })), verify, dispose,
      async compile(signal: AbortSignal, deadlineAt: number) {
        const result = await runLeanDiagnostics({ projectRoot: clone, files: [input.file], dependenciesOnly: true,
          env: input.env, signal, timeoutMs: Math.max(0, deadlineAt - Date.now()) });
        if (result.exitCode !== 0 || result.timedOut || 'aborted' in result && result.aborted)
          throw new Error('proof_search_dependency_compilation_failed: ' +
            limitMathOutput(JSON.stringify({ firstBlocking: result.firstBlocking, stderr: result.stderr }), 1600, 'head'));
        verify();
      } };
  } catch (error) { dispose(); throw error; }
}

/** Only a host-authorized continuation may replay retained inputs. The caller binds their digests and task scope. */
export function prepareRetainedLeanSearchProjection(input: LeanSearchProjectionInput & {
  sources: readonly LeanSearchReplaySource[];
}) {
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 4096)
    throw new Error('proof_search_retained_sources_limit');
  const files = new Set<string>();
  let bytes = 0;
  for (const item of input.sources) {
    if (!item || typeof item.file !== 'string' || typeof item.source !== 'string' ||
        !repositoryRelativePath(item.file) || files.has(item.file) ||
        !LAKE_CONFIGURATION_FILES.includes(item.file) && !isAllowedMathProofSource(item.file))
      throw new Error('proof_search_retained_sources_invalid');
    files.add(item.file); bytes += Buffer.byteLength(item.file) + Buffer.byteLength(item.source);
    if (bytes > 2_000_000) throw new Error('proof_search_retained_sources_limit');
  }
  const project = fs.realpathSync(input.projectRoot), sealed = resolveMathProofEnvironment(project, input.env);
  if (!sealed) throw new Error('proof_search_retained_environment_unsealed');
  const environment = leanDiagnosticEnvironmentIdentity(project, input.env);
  const directory = path.join(project, '.lake/proof-search-replay', crypto.randomUUID()), clone = path.join(directory, 'project');
  assertMathCanonicalPath(directory); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let projection: ReturnType<typeof prepareLeanSearchProjection> | undefined;
  const dispose = () => {
    try { projection?.dispose(); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  };
  try {
    assertMathCanonicalPath(directory); fs.mkdirSync(clone, { mode: 0o700 });
    for (const item of input.sources) {
      const destination = path.join(clone, item.file); assertMathCanonicalPath(destination);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      assertMathCanonicalPath(destination);
      fs.writeFileSync(destination, item.source, { flag: 'wx', mode: 0o600 });
    }
    // Keep retained configuration bytes, including owner-local overrides, until the inner projection hashes them.
    // Only its disposable compilation clone rewrites overrides to the current sealed package paths.
    bindLeanPackages(clone, sealed.packagesRoot);
    projection = prepareLeanSearchProjection({ ...input, projectRoot: clone });
    const retained = projection;
    if (retained.sourceFiles.length !== files.size || retained.sourceFiles.some(item => !files.has(item.file)))
      throw new Error('proof_search_retained_sources_not_closed');
    if (canonicalMathJson(retained.environment) !== canonicalMathJson(environment))
      throw new Error('proof_search_stale_environment');
    const verify = () => { sealed.verify(); retained.verify(); };
    verify();
    return { ...retained, verify, dispose,
      async compile(signal: AbortSignal, deadlineAt: number) {
        verify(); await retained.compile(signal, deadlineAt); verify();
      } };
  } catch (error) { dispose(); throw error; }
}
