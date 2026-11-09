import fs from 'node:fs';
import path from 'node:path';
import { readLeanTaskReceipt, LEAN_TASK_SOURCE_MAX_BYTES } from '../math/leanTask';
import { getLeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { isLibraryPackFile, MAX_LIBRARY_MODULE_BYTES } from '../math/libraryPacks';
import { mathGitBytes } from '../math/mathGit';
import { canonicalMathJson, mathDigest, parseMathJson, readMathFile } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import { buildTheoremKnowledge, theoremKnowledgeStats, type KnowledgeCandidate } from './theoremKnowledge';
import { readKnowledgeCatalog, writePackedKnowledge } from './theoremKnowledgeStore';
import { importKnowledgeRuns } from './theoremKnowledgeRuns';
import { readLibraryApplicationHints } from './libraryKnowledgeApplications';
import { libraryKnowledgeCandidates } from './libraryKnowledgeCandidates';
export { libraryKnowledgeCandidates } from './libraryKnowledgeCandidates';

const configurationFiles = new Set(['lean-toolchain', 'lakefile.toml', 'lakefile.lean', 'lake-manifest.json']);

export type PrepareLibraryKnowledgeOptions = {
  /** Explicit stable checkpoints selected by the caller; refreshes require a new output path. */
  stateFiles?: readonly string[];
  /** Settled build directories, or snapshots containing request/state/base-pack and published round records. */
  autoLibraryBuilds?: readonly string[];
};

/** Index the selected frozen library and explicit historical evidence; never scan unrelated runs or solutions. */
export function prepareLibraryKnowledge(workspaceInput: string, outputInput: string, options: PrepareLibraryKnowledgeOptions = {}) {
  const workspace = fs.realpathSync(workspaceInput), receiptFile = path.join(workspace, 'active-problem.json');
  const receipt = readLeanTaskReceipt(receiptFile), pack = receipt.libraryPack;

  const receiptBytes = readMathFile(receiptFile, 4 * LEAN_TASK_SOURCE_MAX_BYTES).bytes;
  if (canonicalMathJson(parseMathJson(receiptBytes.toString('utf8'), 'math_library_knowledge_receipt_changed')) !== canonicalMathJson(receipt))
    throw new Error('math_library_knowledge_receipt_changed');
  const projectRelative = path.relative(workspace, receipt.projectRoot).split(path.sep).join('/');
  const frozenSource = (file: string, expectedDigest?: string) => {
    const bytes = mathGitBytes(workspace, ['--no-replace-objects', 'cat-file', 'blob', `${receipt.baseCommit}:${projectRelative}/${file}`],
      { maxBuffer: MAX_LIBRARY_MODULE_BYTES + 1, errorMessage: 'math_library_knowledge_seed_unavailable' });
    if (expectedDigest && mathDigest(bytes) !== expectedDigest) throw new Error(`math_library_knowledge_module_changed:${file}`);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  };
  const files: Record<string, string> = {};
  const libraryFiles = Object.keys(pack?.files ?? {}).sort();
  for (const file of libraryFiles) {
    if (!isLibraryPackFile(file)) throw new Error(`math_library_knowledge_module_invalid:${file}`);
    files[file] = frozenSource(file, pack!.files[file]);
  }
  for (const file of receipt.trustedFiles.filter(file => configurationFiles.has(file)).sort()) files[file] = frozenSource(file);

  const provenance: KnowledgeCandidate['provenance'] = {
    kind: 'frozen-library-pack', problemId: receipt.contract.problemId, source: receiptFile,
    sourceDigest: mathDigest(receiptBytes), sourceCommit: receipt.baseCommit,
    environmentDigest: receipt.environmentDigest ?? getLeanTaskEnvironment(receipt.environment ?? 'standard').dependencyDigest,
    problemReceiptDigest: mathDigest(canonicalMathJson(receipt)), receiptIds: [],
  };
  const { candidates, skipped } = libraryKnowledgeCandidates(files, provenance);
  const applications = readLibraryApplicationHints(options.autoLibraryBuilds ?? [], receipt, files, provenance.environmentDigest!);
  skipped.push(...applications.skipped);
  for (const candidate of candidates) {
    const hints = applications.hints.filter(hint => hint.declaration.file === candidate.file && hint.declaration.name === candidate.name);
    if (hints.length > 64) skipped.push({ source: candidate.file, name: candidate.name, reason: 'math_library_application_hint_limit' });
    if (hints.length) candidate.applicationHints = hints.slice(0, 64);
  }
  const stateDigest = (source: string) => {
    try { assertMathCanonicalPath(source); return mathDigest(readMathFile(source, 32 * 1024 * 1024).bytes); }
    catch { return null; }
  };
  const states = [...new Set((options.stateFiles ?? []).map(value => path.resolve(value)))].sort()
    .map(source => ({ source, sha256: stateDigest(source) }));
  const imported = importKnowledgeRuns(states.map(input => input.source), { includeFindings: true });
  skipped.push(...imported.skipped);
  const changed = new Set(states.filter(input => input.sha256 !== stateDigest(input.source)).map(input => input.source));
  for (const source of changed) skipped.push({ source, reason: 'math_library_knowledge_state_changed' });
  candidates.push(...imported.candidates.filter(item => !changed.has(item.provenance.source)));
  const findings = imported.findings?.filter(item => !changed.has(item.provenance.source)) ?? [];
  // Keep the no-input legacy catalog byte-for-byte compatible, including its absent routeFindings field.
  const base = buildTheoremKnowledge(candidates, undefined, findings), output = path.resolve(outputInput);
  const inputs = { states, autoLibraryBuilds: applications.inputs };
  assertMathCanonicalPath(output);
  if (!pack && !base.entries.length && !base.routeFindings?.length) {
    if (fs.lstatSync(output, { throwIfNoEntry: false })) throw new Error('math_library_knowledge_snapshot_changed');
    return { enabled: false as const, inputs, skipped };
  }
  const originSha256 = states.length || applications.inputs.length
    ? mathDigest(canonicalMathJson({ receiptSha256: provenance.sourceDigest, ...inputs })) : provenance.sourceDigest;
  const details = { libraryModules: libraryFiles.length, libraryPackDigest: pack?.digest ?? null,
    applicationHints: base.entries.reduce((sum, item) => sum + (item.applicationHints?.length ?? 0), 0), inputs, skipped };
  const expectedManifest = { ...base, schema: 'theorem-os.theorem-knowledge.v2',
    sources: Object.fromEntries(Object.entries(base.sources).map(([digest, source]) => [digest, { bytes: Buffer.byteLength(source) }])),
    objectsDirectory: path.basename(output) + '.objects', originSha256 };
  const expectedSha256 = mathDigest(canonicalMathJson(expectedManifest) + '\n');
  if (fs.lstatSync(output, { throwIfNoEntry: false })) {
    const existing = readKnowledgeCatalog(output, expectedSha256);
    if (existing.format !== 'v2' || (fs.statSync(output).mode & 0o222) !== 0 ||
        (parseMathJson(existing.text, 'math_library_knowledge_snapshot_changed') as { originSha256?: string }).originSha256 !== originSha256)
      throw new Error('math_library_knowledge_snapshot_changed');
    // Loading a packed catalog checks metadata; replay also verifies every immutable source object.
    for (const [digest, source] of Object.entries(existing.base.sources))
      if (source !== base.sources[digest]) throw new Error('math_library_knowledge_snapshot_changed');
    return { enabled: true as const, file: output, sha256: existing.digest, format: existing.format,
      ...theoremKnowledgeStats(existing.base), ...details };
  }
  return { enabled: true as const, ...writePackedKnowledge(output, base, originSha256),
    ...details };
}
