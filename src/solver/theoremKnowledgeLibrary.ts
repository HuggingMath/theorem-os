import fs from 'node:fs';
import path from 'node:path';
import { readLeanTaskReceipt, LEAN_TASK_SOURCE_MAX_BYTES } from '../math/leanTask';
import { getLeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { isLibraryPackFile, MAX_LIBRARY_MODULE_BYTES } from '../math/libraryPacks';
import { mathGitBytes } from '../math/mathGit';
import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from '../math/leanSource';
import { canonicalMathJson, mathDigest, parseMathJson, readMathFile } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import { buildTheoremKnowledge, theoremKnowledgeStats, type KnowledgeCandidate } from './theoremKnowledge';
import { readKnowledgeCatalog, writePackedKnowledge } from './theoremKnowledgeStore';

const configurationFiles = new Set(['lean-toolchain', 'lakefile.toml', 'lakefile.lean', 'lake-manifest.json']);

/** Index only the already selected frozen library, never the triggering problem or a live proof. */
export function prepareLibraryKnowledge(workspaceInput: string, outputInput: string) {
  const workspace = fs.realpathSync(workspaceInput), receiptFile = path.join(workspace, 'active-problem.json');
  const receipt = readLeanTaskReceipt(receiptFile), pack = receipt.libraryPack;
  if (!pack) return { enabled: false as const };

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
  const libraryFiles = Object.keys(pack.files).sort();
  for (const file of libraryFiles) {
    if (!isLibraryPackFile(file)) throw new Error(`math_library_knowledge_module_invalid:${file}`);
    files[file] = frozenSource(file, pack.files[file]);
  }
  for (const file of receipt.trustedFiles.filter(file => configurationFiles.has(file)).sort()) files[file] = frozenSource(file);

  const provenance: KnowledgeCandidate['provenance'] = {
    kind: 'frozen-library-pack', problemId: receipt.contract.problemId, source: receiptFile,
    sourceDigest: mathDigest(receiptBytes), sourceCommit: receipt.baseCommit,
    environmentDigest: receipt.environmentDigest ?? getLeanTaskEnvironment(receipt.environment ?? 'standard').dependencyDigest,
    problemReceiptDigest: mathDigest(canonicalMathJson(receipt)), receiptIds: [],
  };
  const candidates: KnowledgeCandidate[] = [], skipped: { source: string; name: string; reason: string }[] = [];
  for (const file of libraryFiles) {
    const source = files[file], regions = new Map(inspectLeanDeclarationRegions(source).map(item => [item.startOffset, item]));
    const declarations = inspectScopedLeanDeclarations(source), counts = new Map<string, number>();
    for (const item of declarations) counts.set(item.qualifiedName, (counts.get(item.qualifiedName) ?? 0) + 1);
    for (const item of declarations) {
      if (item.kind !== 'theorem' && item.kind !== 'definition') continue;
      const region = regions.get(item.startOffset);
      if (!region || counts.get(item.qualifiedName) !== 1) {
        skipped.push({ source: file, name: item.qualifiedName, reason: 'declaration-missing-or-ambiguous' });
        continue;
      }
      candidates.push({ name: item.qualifiedName, file, type: region.declarationType, typeKind: 'source-header',
        kind: item.kind === 'definition' ? 'definition' : 'lemma',
        description: `Frozen library declaration from ${file.slice(0, -5).replaceAll('/', '.')}.`, premises: [],
        dependencies: { statement: [], proof: [], tasks: [], coverage: 'unavailable' }, files, provenance });
    }
  }
  const base = buildTheoremKnowledge(candidates), output = path.resolve(outputInput);
  assertMathCanonicalPath(output);
  const originSha256 = provenance.sourceDigest;
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
      ...theoremKnowledgeStats(existing.base), libraryModules: libraryFiles.length, libraryPackDigest: pack.digest, skipped };
  }
  return { enabled: true as const, ...writePackedKnowledge(output, base, originSha256),
    libraryModules: libraryFiles.length, libraryPackDigest: pack.digest, skipped };
}
