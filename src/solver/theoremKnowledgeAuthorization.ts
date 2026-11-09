import fs from 'node:fs';
import path from 'node:path';
import { libraryHostConfigPath, resolveHostLibrary } from '../math/libraryHostConfig';
import { canonicalMathJson, mathDigest, readMathFile } from '../math/mathRuntimeIo';
import { MAX_LIBRARY_MODULE_BYTES } from '../math/libraryPacks';
import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from '../math/leanSource';
import { assertMathCanonicalPath } from '../math/paths';
import { readSolverProblem } from './problem';
import { buildTheoremKnowledge, theoremKnowledgeStats, type KnowledgeCandidate } from './theoremKnowledge';
import { readKnowledgeCatalog, writePackedKnowledge } from './theoremKnowledgeStore';

const configurationFiles = new Set(['lean-toolchain', 'lakefile.toml', 'lakefile.lean', 'lake-manifest.json']);
const same = (a: unknown, b: unknown) => canonicalMathJson(a) === canonicalMathJson(b);

/** Reconstruct an authorized catalogue from current host policy and the verified installation, never saved claims. */
export function buildAuthorizedLibraryKnowledge(workspace: string, receiptFile = path.join(workspace, 'active-problem.json')) {
  const problem = readSolverProblem(workspace, receiptFile);
  if (!libraryHostConfigPath() || !problem.libraryBinding?.hostConfiguration || !problem.libraryHostTask)
    throw new Error('library_knowledge_host_binding_required');
  const project = path.join(problem.workspace, problem.projectRelative);
  const read = (file: string) => {
    const absolute = path.join(project, file); assertMathCanonicalPath(absolute);
    return readMathFile(absolute, MAX_LIBRARY_MODULE_BYTES).bytes;
  };
  const effective = resolveHostLibrary(problem.libraryHostTask, {
    toolchain: read('lean-toolchain').toString('utf8').trim(), lakeManifest: read('lake-manifest.json').toString('utf8'),
    runtimeEnvironmentDigest: problem.libraryBinding.runtimeEnvironmentDigest,
  }, problem.workspace);
  if (!effective || !same(effective.binding, problem.libraryBinding)) throw new Error('library_host_binding_changed');
  const installed = Object.fromEntries(effective.modules.map(item => [item.file, item.sha256]));
  if (!same(installed, problem.frozenFiles ?? {})) throw new Error('library_knowledge_installation_changed');
  const files: Record<string, string> = {};
  for (const [file, digest] of Object.entries({ ...installed,
    ...Object.fromEntries(Object.entries(problem.trustedFiles).filter(([file]) => configurationFiles.has(file))) })) {
    const bytes = read(file);
    if (mathDigest(bytes) !== digest) throw new Error('library_knowledge_installation_changed');
    files[file] = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  const metadata = new Map(effective.declarations.map(item => [`${item.installed_file}:${item.name}`, item]));
  const candidates: KnowledgeCandidate[] = [];
  for (const file of Object.keys(installed).sort()) {
    const source = files[file]!, regions = new Map(inspectLeanDeclarationRegions(source).map(item => [item.startOffset, item]));
    const declarations = inspectScopedLeanDeclarations(source), counts = new Map<string, number>();
    for (const item of declarations) counts.set(item.qualifiedName, (counts.get(item.qualifiedName) ?? 0) + 1);
    for (const item of declarations) {
      if (!['theorem', 'definition'].includes(item.kind) || counts.get(item.qualifiedName) !== 1) continue;
      const region = regions.get(item.startOffset);
      if (!region) continue;
      const libraryMetadata = metadata.get(`${file}:${item.qualifiedName}`);
      candidates.push({ name: item.qualifiedName, file, type: region.declarationType, typeKind: 'source-header',
        kind: item.kind === 'definition' ? 'definition' : 'lemma',
        description: `Frozen library declaration from ${file.slice(0, -5).replaceAll('/', '.')}.`, premises: [],
        ...(libraryMetadata ? { libraryMetadata } : {}),
        dependencies: { statement: [], proof: [], tasks: [], coverage: 'unavailable' }, files,
        provenance: { kind: 'frozen-library-pack', problemId: problem.contract.problemId, source: problem.activeProblemPath,
          sourceDigest: problem.receiptDigest, problemReceiptDigest: problem.receiptDigest,
          environmentDigest: effective.binding.runtimeEnvironmentDigest, receiptIds: [] } });
    }
  }
  const base = buildTheoremKnowledge(candidates);
  base.libraryAuthorization = { schema: 'theorem-os.library-knowledge-authorization.v1', generator: 'installed-library-knowledge-v1',
    binding: effective.binding, problemReceiptDigest: problem.receiptDigest, installedFilesSha256: mathDigest(canonicalMathJson(installed)) };
  return { base, originSha256: mathDigest(canonicalMathJson(base.libraryAuthorization)),
    libraryModules: effective.modules.length, libraryPackDigest: effective.pack ? effective.binding.effectivePackDigest : null };
}

/** Checks all metadata and every object, including unused blobs; query counts/details cannot expose a raw archive. */
export function readAuthorizedKnowledgeCatalog(file: string, workspace: string, receiptFile?: string, expectedDigest?: string) {
  const loaded = readKnowledgeCatalog(file, expectedDigest);
  if (!libraryHostConfigPath() && !loaded.base.libraryAuthorization) {
    // A removed host setting must not make a previously bound task accept an unbound archive.
    readSolverProblem(workspace, receiptFile ?? path.join(workspace, 'active-problem.json'));
    return loaded;
  }
  const expected = buildAuthorizedLibraryKnowledge(workspace, receiptFile);
  if (loaded.format !== 'v2' || (fs.statSync(file).mode & 0o222) !== 0 ||
      !same(loaded.base, expected.base) || JSON.parse(loaded.text).originSha256 !== expected.originSha256)
    throw new Error('library_knowledge_authorization_mismatch');
  return loaded;
}

/** Historical states and build hints lack independently authenticated full-content visibility evidence.
 * Reject before reading them, including free text/findings; a matching filename or declaration is insufficient. */
export function prepareAuthorizedLibraryKnowledge(workspace: string, output: string,
  options: { stateFiles?: readonly string[]; autoLibraryBuilds?: readonly string[]; receiptFile?: string } = {}) {
  if (options.stateFiles?.length || options.autoLibraryBuilds?.length) throw new Error('library_knowledge_history_unauthorized');
  const expected = buildAuthorizedLibraryKnowledge(workspace, options.receiptFile), file = path.resolve(output);
  const details = { enabled: true as const, libraryModules: expected.libraryModules, libraryPackDigest: expected.libraryPackDigest,
    applicationHints: 0, inputs: { states: [], autoLibraryBuilds: [] }, skipped: [] };
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    const existing = readAuthorizedKnowledgeCatalog(file, workspace, options.receiptFile);
    return { ...details, file, sha256: existing.digest, format: existing.format, ...theoremKnowledgeStats(existing.base) };
  }
  return { ...details, ...writePackedKnowledge(file, expected.base, expected.originSha256) };
}
