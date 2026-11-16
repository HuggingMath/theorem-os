import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import { readSolverRunState, type SolverRunState } from '../solver/archive';
import { readDeclarationArtifacts } from '../solver/declarationArtifacts';
import { proofReceiptsMatch, type ProofCheck } from '../solver/modules/evidence';
import { isMathFoundationalLeanAxiom } from './contracts';
import { mathConstructionImports, LAKE_CONFIGURATION_FILES } from './mathConstructionSources';
import { mathGitBytes } from './mathGit';
import { hashMathFormalSourceDeclaration } from './leanSource';
import { canonicalLibraryJson, parseLibraryJson } from './libraryRelease';
import { canonicalMathJson, mathDigest, readMathFile } from './mathRuntimeIo';
import { assertMathCanonicalPath } from './paths';

const limits = { files: 512, file: 4 << 20, manifest: 1 << 20, total: 32 << 20, zip: 40 << 20,
  lean: 256 << 10, text: 64 << 10, objects: 8 };
const bundlePath = /^[A-Za-z0-9_][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._+-]*)*$/u;
const sha = /^[a-f0-9]{64}$/u;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const roles = ['statement', 'formalization', 'proof', 'support', 'environment', 'explanation',
  'external_verification', 'provenance', 'license'] as const;
type Role = typeof roles[number];
export type HuggingMathBundleFile = { path: string; sha256: string; bytes: number; role: Role };
type Rights = { status: 'declared' | 'restricted' | 'unknown'; license: string; notice: string };
export type HuggingMathBundleManifest = {
  schema: 'hm-problem-bundle/0'; provider: string; external_id: string; export: Record<string, unknown>;
  historical: boolean; problem: { title: string; statement: string; language: string; statement_review: 'unreviewed_draft'; sources: string };
  formalizations: { key: string; entry: string; targets: string[]; context: string[]; note: string }[];
  proofs: { key: string; formalization: string; entry: string; support: string[]; summary: string; attribution: string }[];
  environment: { files: string[]; complete: boolean };
  external_verification: { file: string; proof: string; reported_status: string;
    binds: { proof_sha256: string; targets: string[] }; note: string }[];
  rights: (Rights & { files: string[] })[]; files: HuggingMathBundleFile[];
};
export type ExportHuggingMathRunOptions = { stateFile: string; resultFile: string; metadataFile: string;
  outputDirectory: string; declarationIds?: string[] };
const rightsSchema = z.object({ status: z.enum(['declared', 'restricted', 'unknown']), license: z.string(), notice: z.string() })
  .strict().refine(value => value.status !== 'declared' || Boolean(value.license.trim()), 'Declared rights need a license or permission.');
const metadataSchema = z.object({ attribution: z.string().trim().min(1), title: z.string().trim().min(1).optional(),
  language: z.string().optional(), provider: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/u).optional(),
  external_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u).optional(), sources: z.string().trim().min(1).optional(),
  rights: z.record(rightsSchema).optional() }).strict();

function requireBundle(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`huggingmath_bundle_${reason}`);
}
function object(value: unknown): Record<string, unknown> {
  requireBundle(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected_object');
  return value as Record<string, unknown>;
}
function safePath(value: string): string {
  requireBundle(value.length <= 255 && bundlePath.test(value), `unsafe_path:${value}`);
  return value;
}
function sourcePath(value: string): string {
  requireBundle(Boolean(value) && !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value) &&
    value.split('/').every(part => Boolean(part) && part !== '.' && part !== '..'), 'unsafe_source_path');
  return value;
}
function text(bytes: Uint8Array): string {
  const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  requireBundle(!value.includes('\0'), 'nul_text');
  return value;
}
function encodable(value: unknown): void {
  if (typeof value === 'string') requireBundle(Buffer.from(value).toString('utf8') === value, 'unpaired_surrogate');
  else if (typeof value === 'number') requireBundle(Number.isSafeInteger(value), 'unrepresentable_integer');
  else if (Array.isArray(value)) value.forEach(encodable);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { encodable(key); encodable(child); }
}
/** The Hub manifest uses Python code-point ordering, not Pack JCS/UTF-16 ordering. */
function canonical(value: unknown): string {
  encodable(value);
  return canonicalLibraryJson(value);
}
function strictJson(bytes: Uint8Array): unknown {
  const source = text(bytes);
  // parseLibraryJson rejects duplicate keys. This additional lexical pass rejects float/exponent spellings too.
  for (let offset = 0; offset < source.length; offset++) {
    if (source[offset] === '"') {
      for (offset++; offset < source.length; offset++) {
        if (source[offset] === '\\') { offset++; continue; }
        if (source[offset] === '"') break;
      }
    } else if (/[0-9-]/u.test(source[offset]!)) {
      const token = /^-?(?:0|[1-9][0-9]*)/u.exec(source.slice(offset));
      requireBundle(token && /[\s,}\]]/u.test(source[offset + token[0].length] ?? ' '), 'non_integer_number');
      offset += token[0].length - 1;
    }
  }
  const value = parseLibraryJson(bytes); encodable(value); return value;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}
/** Deterministic store-only ZIP. It contains inert exact bytes and no executable platform dependency. */
function zipFiles(files: Map<string, Buffer>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [file, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const name = Buffer.from(file), crc = crc32(bytes), header = Buffer.alloc(30), record = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(33, 14); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(record, name); offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...local, directory, end]); requireBundle(zip.length <= limits.zip, 'zip_too_large'); return zip;
}
function unzip(bytes: Buffer): Map<string, Buffer> {
  requireBundle(bytes.length <= limits.zip, 'zip_too_large');
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  requireBundle(end >= 0 && bytes.length === end + 22 + bytes.readUInt16LE(end + 20), 'invalid_zip');
  const entries = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  requireBundle(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 &&
    bytes.readUInt16LE(end + 8) === entries && entries <= 2048 && start + size === end, 'invalid_zip_directory');
  const files = new Map<string, Buffer>(), seen = new Set<string>(); let cursor = start, total = 0;
  for (let index = 0; index < entries; index++) {
    requireBundle(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50, 'invalid_zip_entry');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16),
      packed = bytes.readUInt32LE(cursor + 20), length = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28),
      extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32),
      mode = bytes.readUInt32LE(cursor + 38) >>> 16, local = bytes.readUInt32LE(cursor + 42);
    requireBundle(cursor + 46 + nameLength + extraLength + commentLength <= end, 'invalid_zip_entry');
    const name = text(bytes.subarray(cursor + 46, cursor + 46 + nameLength)), directory = name.endsWith('/');
    safePath(directory ? name.slice(0, -1) : name);
    requireBundle(!seen.has(name), 'duplicate_zip_path'); seen.add(name);
    requireBundle((flags & 1) === 0 && (method === 0 || method === 8) &&
      (!mode || (mode & 0o170000) === 0 || (mode & 0o170000) === (directory ? 0o040000 : 0o100000)), 'unsupported_zip_entry');
    requireBundle(local + 30 <= start && bytes.readUInt32LE(local) === 0x04034b50 &&
      bytes.readUInt16LE(local + 8) === method && bytes.readUInt16LE(local + 6) === flags, 'invalid_zip_local_header');
    const localName = bytes.readUInt16LE(local + 26), data = local + 30 + localName + bytes.readUInt16LE(local + 28);
    requireBundle(data + packed <= start && text(bytes.subarray(local + 30, local + 30 + localName)) === name, 'invalid_zip_local_header');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (directory) { requireBundle(length === 0, 'invalid_zip_directory'); continue; }
    requireBundle(length <= (name === 'manifest.json' ? limits.manifest : limits.file), 'file_too_large');
    total += length; requireBundle(total <= limits.total && files.size <= limits.files, 'bundle_too_large');
    const compressed = bytes.subarray(data, data + packed);
    const decoded = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: length + 1 });
    requireBundle(decoded.length === length && crc32(decoded) === crc, 'zip_crc_or_size_mismatch'); files.set(name, decoded);
  }
  requireBundle(cursor === end, 'invalid_zip_directory'); return files;
}
function readDirectory(directory: string): Map<string, Buffer> {
  requireBundle(fs.lstatSync(directory).isDirectory(), 'directory_required');
  const files = new Map<string, Buffer>(); let total = 0;
  const visit = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(directory, relative)).sort()) {
      const file = safePath(relative ? `${relative}/${entry}` : entry), full = path.join(directory, file), stat = fs.lstatSync(full);
      if (stat.isDirectory()) visit(file);
      else {
        requireBundle(stat.isFile(), 'special_or_symlink_file');
        const bytes = readMathFile(full, file === 'manifest.json' ? limits.manifest : limits.file).bytes;
        total += bytes.length; requireBundle(total <= limits.total && files.size <= limits.files, 'bundle_too_large'); files.set(file, bytes);
      }
    }
  };
  visit(''); return files;
}

function validateFiles(files: Map<string, Buffer>): { manifest: HuggingMathBundleManifest; bundleDigest: string } {
  const raw = files.get('manifest.json'); requireBundle(raw && raw.length <= limits.manifest, 'manifest_missing_or_large');
  requireBundle(files.size <= limits.files + 1 && [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) <= limits.total, 'bundle_too_large');
  const value = object(strictJson(raw)); requireBundle(value.schema === 'hm-problem-bundle/0', 'unsupported_schema');
  const manifest = value as unknown as HuggingMathBundleManifest;
  requireBundle(typeof manifest.provider === 'string' && /^[a-z0-9][a-z0-9.-]{0,63}$/u.test(manifest.provider) &&
    typeof manifest.external_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(manifest.external_id) &&
    typeof object(manifest.export).revision === 'string' && typeof manifest.historical === 'boolean', 'invalid_identity');
  requireBundle(Array.isArray(manifest.files) && manifest.files.length <= limits.files, 'invalid_files');
  const listed = new Map<string, HuggingMathBundleFile>();
  for (const file of manifest.files) {
    safePath(file.path); requireBundle(file.path !== 'manifest.json' && !listed.has(file.path) && sha.test(file.sha256) &&
      Number.isSafeInteger(file.bytes) && file.bytes >= 0 && roles.includes(file.role), 'invalid_file_entry');
    const bytes = files.get(file.path);
    requireBundle(bytes && bytes.length <= limits.file && bytes.length === file.bytes && mathDigest(bytes) === file.sha256, `file_changed:${file.path}`);
    text(bytes); listed.set(file.path, file);
  }
  requireBundle(files.size === listed.size + 1, 'unlisted_files');
  const ref = (name: string, role: Role) => { requireBundle(listed.get(name)?.role === role, `reference_role:${name}`); return text(files.get(name)!); };
  const problem = object(manifest.problem);
  requireBundle(typeof problem.title === 'string' && problem.title.trim().length > 0 && Array.from(problem.title.trim()).length <= 200 &&
    !problem.title.includes('\n') && typeof problem.language === 'string' && typeof problem.sources === 'string' && problem.sources.trim() &&
    ['unreviewed_draft', 'reviewed'].includes(problem.statement_review as string), 'invalid_problem');
  requireBundle(Buffer.byteLength(ref(problem.statement as string, 'statement').replaceAll('\r\n', '\n').trim()) <= limits.text, 'statement_projection_too_large');
  requireBundle(Array.isArray(manifest.formalizations) && manifest.formalizations.length >= 1 && manifest.formalizations.length <= limits.objects &&
    Array.isArray(manifest.proofs) && manifest.proofs.length <= limits.objects, 'object_limit');
  const forms = new Map<string, Set<string>>(), proofs = new Map<string, typeof manifest.proofs[number]>();
  for (const form of manifest.formalizations) {
    requireBundle(/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(form.key) && !forms.has(form.key) && Array.isArray(form.targets) && form.targets.length &&
      new Set(form.targets).size === form.targets.length && typeof form.note === 'string', 'invalid_formalization');
    const source = ref(form.entry, 'formalization'); requireBundle(Buffer.byteLength(source.replaceAll('\r\n', '\n')) <= limits.lean, 'lean_projection_too_large');
    for (const target of form.targets) requireBundle(typeof target === 'string' && /^[A-Za-z_À-῿][A-Za-z0-9_'!?À-῿]*(?:\.[A-Za-z_À-῿][A-Za-z0-9_'!?À-῿]*)*$/u.test(target) &&
      source.includes(target.split('.').at(-1)!), 'invalid_target');
    for (const file of form.context ?? []) ref(file, 'support'); forms.set(form.key, new Set(form.targets));
  }
  for (const proof of manifest.proofs) {
    requireBundle(/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(proof.key) && !proofs.has(proof.key) && forms.has(proof.formalization) &&
      typeof proof.summary === 'string' && Array.from(proof.summary).length <= 300 && typeof proof.attribution === 'string' && proof.attribution.trim(), 'invalid_proof');
    requireBundle(Buffer.byteLength(ref(proof.entry, 'proof').replaceAll('\r\n', '\n')) <= limits.lean, 'lean_projection_too_large');
    for (const file of proof.support ?? []) ref(file, 'support'); proofs.set(proof.key, proof);
  }
  requireBundle(typeof object(manifest.environment).complete === 'boolean' && Array.isArray(manifest.environment.files), 'invalid_environment');
  for (const file of manifest.environment.files) ref(file, 'environment');
  requireBundle(Array.isArray(manifest.external_verification), 'invalid_external_evidence');
  for (const receipt of manifest.external_verification) {
    ref(receipt.file, 'external_verification'); const proof = proofs.get(receipt.proof);
    requireBundle(proof && receipt.binds.proof_sha256 === listed.get(proof.entry)?.sha256 && Array.isArray(receipt.binds.targets) &&
      receipt.binds.targets.length && receipt.binds.targets.every(target => forms.get(proof.formalization)!.has(target)) &&
      typeof receipt.reported_status === 'string' && typeof receipt.note === 'string', 'external_evidence_binding');
  }
  requireBundle(Array.isArray(manifest.rights), 'invalid_rights'); const covered = new Set<string>();
  for (const right of manifest.rights) {
    rightsSchema.parse({ status: right.status, license: right.license, notice: right.notice });
    requireBundle(Array.isArray(right.files), 'invalid_rights');
    for (const file of right.files) { requireBundle(listed.has(file) && !covered.has(file), 'rights_coverage'); covered.add(file); }
  }
  requireBundle(covered.size === listed.size, 'rights_coverage');
  return { manifest, bundleDigest: mathDigest(canonical(manifest)) };
}

/** Accepts a bundle directory or ZIP. The returned ZIP is hash-checked against its manifest. */
export function readHuggingMathBundle(input: string): { zip: Buffer; bundleDigest: string; manifest: HuggingMathBundleManifest } {
  input = path.resolve(input); assertMathCanonicalPath(input);
  const stat = fs.lstatSync(input); requireBundle(stat.isFile() || stat.isDirectory(), 'special_or_symlink_file');
  const archive = stat.isDirectory() ? undefined : readMathFile(input, limits.zip).bytes;
  const files = archive ? unzip(archive) : readDirectory(input), checked = validateFiles(files);
  return { ...checked, zip: archive ?? zipFiles(files) };
}

type TreeEntry = { mode: string; oid: string };
function committedTree(repository: string, commit: string, project: string): Map<string, TreeEntry> {
  requireBundle(commitPattern.test(commit), 'invalid_commit'); sourcePath(project);
  const raw = mathGitBytes(repository, ['--no-replace-objects', 'ls-tree', '-rz', '--full-tree', commit, '--', project], { maxBuffer: 8 << 20 });
  const tree = new Map<string, TreeEntry>();
  for (const line of new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\0').filter(Boolean)) {
    const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/u.exec(line); requireBundle(match, 'unsupported_git_object');
    const file = match[3]!; requireBundle(file.startsWith(`${project}/`), 'git_path_mismatch');
    tree.set(sourcePath(file.slice(project.length + 1)), { mode: match[1]!, oid: match[2]! });
  }
  return tree;
}
function committedBytes(repository: string, tree: Map<string, TreeEntry>, file: string): Buffer {
  const entry = tree.get(sourcePath(file)); requireBundle(entry && ['100644', '100755'].includes(entry.mode), `source_missing_or_mode:${file}`);
  const bytes = mathGitBytes(repository, ['--no-replace-objects', 'cat-file', 'blob', entry.oid], { maxBuffer: limits.file + 1 });
  requireBundle(bytes.length <= limits.file, 'file_too_large'); text(bytes); return bytes;
}
function assertCheck(check: ProofCheck, state: SolverRunState, commit: string, sourceDigest: string, sources: Map<string, Buffer>): void {
  requireBundle(check?.passed === true && check.commit === commit && check.sourceDigest === sourceDigest, 'proof_identity_mismatch');
  const items = state.problem.targets.map(target => ({ proofPath: target.proofPath, theoremName: target.theoremName,
    statementHash: state.problem.contract.statementHash, leanStatementHash: state.problem.contract.leanStatementHash,
    expectedSourceDeclarationHash: hashMathFormalSourceDeclaration(text(sources.get(target.proofPath)!), target.theoremName) }));
  requireBundle(items.every((item, index) => item.expectedSourceDeclarationHash === state.problem.targets[index]!.declarationHash) &&
    check.verification.schema === 'deepscientist.mathematics.verification-batch/v1' && proofReceiptsMatch(check.verification, commit, items) &&
    check.verification.results.every(receipt => !receipt.cleanupError && receipt.sorryCount === 0 && receipt.admitCount === 0 && Array.isArray(receipt.axioms) &&
      receipt.axioms.every(isMathFoundationalLeanAxiom)), 'receipt_target_coverage');
}

/** Offline export of a finished, independently evaluated run. It never executes Lean or changes source state. */
export function exportHuggingMathRun(options: ExportHuggingMathRunOptions): {
  directory: string; zipFile: string; bundleDigest: string; manifest: HuggingMathBundleManifest; warnings: string[];
} {
  const stateFile = path.resolve(options.stateFile), resultFile = path.resolve(options.resultFile), output = path.resolve(options.outputDirectory);
  assertMathCanonicalPath(stateFile); assertMathCanonicalPath(resultFile); assertMathCanonicalPath(output);
  const state = readSolverRunState(stateFile), rawResult = readMathFile(resultFile, limits.file).bytes, result = object(parseLibraryJson(rawResult));
  const metadata = metadataSchema.parse(strictJson(readMathFile(path.resolve(options.metadataFile), limits.manifest).bytes));
  requireBundle(state.phase === 'finished' && !state.writerStopUnconfirmed && !state.pendingResearchFreeze && !state.pendingProofCheck &&
    !state.pendingDeclarationCheck && !(state.workers ?? []).some(worker => worker.writerStopUnconfirmed), 'run_not_finished');
  requireBundle(result.schema === 'deepscientist.math.run.v2' && result.status === 'evaluated_passed' &&
    (!result.run_outcome || result.run_outcome === 'evaluated_passed') && result.runId === state.runId &&
    result.problemId === state.problem.contract.problemId && typeof result.stateFile === 'string' && path.resolve(result.stateFile) === stateFile &&
    result.solver_ready_receipt_valid === true && result.completion_signal_valid === true && typeof result.solution_commit === 'string' &&
    commitPattern.test(result.solution_commit), 'result_identity_or_acceptance');
  const sourceCommit = result.solution_commit, repository = state.problem.workspace;
  assertMathCanonicalPath(repository);
  const baseTree = committedTree(repository, state.problem.baseCommit, state.problem.projectRelative),
    proofTree = committedTree(repository, sourceCommit, state.problem.projectRelative);
  const originals = new Map<string, Buffer>(), sources = new Map<string, Buffer>();
  const required = [...new Set([...state.problem.ownedFiles, ...Object.keys(state.problem.trustedFiles), ...Object.keys(state.problem.frozenFiles ?? {})])];
  requireBundle(required.length > 0, 'sources_missing');
  for (const file of required) {
    originals.set(file, committedBytes(repository, baseTree, file)); sources.set(file, committedBytes(repository, proofTree, file));
    const trusted = state.problem.trustedFiles[file] ?? state.problem.frozenFiles?.[file];
    if (trusted) requireBundle(mathDigest(sources.get(file)!) === trusted && mathDigest(originals.get(file)!) === trusted, `trusted_source_changed:${file}`);
  }
  const sourceDigest = mathDigest(canonicalMathJson(state.problem.ownedFiles.map(file => [file, mathDigest(sources.get(file)!)])));
  assertCheck(state.check!, state, sourceCommit, sourceDigest, sources);
  const evaluator = object(result.evaluator); requireBundle(evaluator.status === 'passed', 's3_not_passed');
  if (evaluator.method === 'host-lean-kernel-all-targets') assertCheck(evaluator.verification as ProofCheck, state, sourceCommit, sourceDigest, sources);
  else if (evaluator.method === 'official-comparator') requireBundle(evaluator.official === true && object(evaluator.comparison).status === 'official_verified', 's3_comparator_mismatch');
  else if (evaluator.method === 'external-command') {
    const command = object(evaluator.result); requireBundle(command.started === true && command.exitCode === 0 && !command.signal && !command.timedOut && !command.aborted, 's3_command_mismatch');
  } else requireBundle(false, 'unsupported_evaluator');
  const groups = new Map<string, string[]>();
  for (const target of state.problem.targets) {
    requireBundle(hashMathFormalSourceDeclaration(text(originals.get(target.proofPath)!), target.theoremName) === target.declarationHash,
      'original_target_changed');
    groups.set(target.proofPath, [...groups.get(target.proofPath) ?? [], target.theoremName]);
  }
  requireBundle(groups.size >= 1 && groups.size <= limits.objects, 'object_limit');
  const files = new Map<string, Buffer>(), entries: HuggingMathBundleFile[] = [], mappings: Record<string, unknown>[] = [];
  const add = (name: string, bytes: Buffer, role: Role) => {
    safePath(name); requireBundle(!files.has(name) && bytes.length <= limits.file, 'duplicate_or_large_file'); text(bytes);
    files.set(name, bytes); entries.push({ path: name, sha256: mathDigest(bytes), bytes: bytes.length, role }); return name;
  };
  const addJson = (name: string, value: unknown, role: Role) => add(name, Buffer.from(canonicalMathJson(value)), role);
  add('statement/original.md', Buffer.from(state.problem.contract.informalStatement), 'statement');
  const baseSupport: string[] = [], proofSupport: string[] = [], environmentFiles: string[] = [];
  for (const file of required) {
    if (LAKE_CONFIGURATION_FILES.includes(file)) continue;
    const originalName = add(`support/original/${file}`, originals.get(file)!, 'support'),
      proofName = add(`support/proof/${file}`, sources.get(file)!, 'support');
    baseSupport.push(originalName); proofSupport.push(proofName);
    mappings.push({ source: file, original: originalName, proof: proofName });
  }
  for (const file of LAKE_CONFIGURATION_FILES) {
    if (!proofTree.has(file)) continue;
    const bytes = committedBytes(repository, proofTree, file), original = committedBytes(repository, baseTree, file);
    requireBundle(mathDigest(bytes) === mathDigest(original), `environment_changed:${file}`);
    environmentFiles.push(add(`environment/${file.replace(/^\.lake\//u, '_lake/')}`, bytes, 'environment'));
  }
  requireBundle(environmentFiles.some(file => file.endsWith('/lean-toolchain')) && environmentFiles.some(file => /\/lakefile\.(?:toml|lean)$/u.test(file)), 'environment_configuration_missing');
  const warnings = ['Environment dependency closure and replay have not been independently established; environment.complete is false.',
    'External acceptance is historical source evidence. Hub imports the proof as not_run; fresh consumer checks are required.'];
  const localModules = new Set(required.filter(file => file.endsWith('.lean')).map(file => file.slice(0, -5).replaceAll('/', '.')));
  for (const [file, bytes] of sources) if (file.endsWith('.lean')) for (const module of mathConstructionImports(text(bytes))) {
    if (!localModules.has(module) && !/^(?:Init|Lean|Lake|Std|Mathlib|Batteries|Aesop|Qq|ProofWidgets|Plausible|ImportGraph)(?:\.|$)/u.test(module))
      warnings.push(`Import ${module} in ${file} is outside the exported local source set; no complete environment claim is made.`);
  }
  add('evidence/run-result.json', rawResult, 'external_verification');
  addJson('evidence/source-check.json', state.check, 'external_verification');
  const declarationIds = options.declarationIds ?? [];
  requireBundle(new Set(declarationIds).size === declarationIds.length, 'duplicate_declaration_selection');
  if (declarationIds.length) {
    const artifacts = readDeclarationArtifacts(path.dirname(stateFile), state), selected = new Map(artifacts.map(record => [record.id, record]));
    for (const id of declarationIds) {
      requireBundle(sha.test(id) && selected.has(id), `declaration_not_found:${id}`);
      addJson(`provenance/declarations/${id}.json`, selected.get(id), 'provenance');
    }
  }
  addJson('provenance/run.json', { schema: 'theorem-os.huggingmath-export.v1', runId: state.runId,
    problem: state.problem.contract, problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest,
    taskDigest: state.taskDigest, buildDigest: state.buildDigest, evaluatorDigest: state.evaluatorDigest,
    baseCommit: state.problem.baseCommit, sourceCommit, sourceDigest, checkedCommit: state.check!.verification.targetCommit,
    targets: state.problem.targets, ownedFiles: state.problem.ownedFiles, trustedFiles: state.problem.trustedFiles,
    frozenFiles: state.problem.frozenFiles ?? {}, libraryBinding: state.problem.libraryBinding ?? null, sourceFiles: mappings,
    selectedDeclarationIds: declarationIds, historicalConsumerCheckRequired: true, hubVerificationState: 'not_run' }, 'provenance');
  const formalizations: HuggingMathBundleManifest['formalizations'] = [], proofs: HuggingMathBundleManifest['proofs'] = [],
    evidence: HuggingMathBundleManifest['external_verification'] = [];
  let group = 0;
  for (const [file, targets] of groups) {
    const key = `target-${++group}`, formalization = add(`formalizations/${file}`, originals.get(file)!, 'formalization'),
      proof = add(`proofs/${file}`, sources.get(file)!, 'proof');
    formalizations.push({ key, entry: formalization, targets, context: baseSupport, note: 'Original source at the frozen base commit; every original target in this file is retained.' });
    proofs.push({ key, formalization: key, entry: proof, support: proofSupport,
      summary: 'TheoremOS independently evaluated original targets; the retained receipt is external source evidence.', attribution: metadata.attribution });
    evidence.push({ file: 'evidence/run-result.json', proof: key, reported_status: 'evaluated_passed',
      binds: { proof_sha256: mathDigest(sources.get(file)!), targets }, note: 'Historical S3 evaluation and source receipt; Hub verification remains not_run.' });
  }
  const overrides = metadata.rights ?? {};
  requireBundle(Object.keys(overrides).every(name => files.has(name)), 'rights_override_unknown_file');
  const rights = entries.map(file => ({ files: [file.path], status: overrides[file.path]?.status ?? 'unknown' as const,
    license: overrides[file.path]?.license ?? '', notice: overrides[file.path]?.notice ?? 'No publication rights are asserted by this exporter.' }));
  const manifest: HuggingMathBundleManifest = { schema: 'hm-problem-bundle/0', provider: metadata.provider ?? 'theoremos',
    external_id: metadata.external_id ?? state.problem.contract.problemId, export: { revision: sourceCommit, adapter: 'theorem-os.huggingmath-export.v1',
      run_id: state.runId, environment_digest: state.environmentDigest }, historical: true,
    problem: { title: metadata.title ?? state.problem.contract.problemId, statement: 'statement/original.md', language: metadata.language ?? 'en',
      statement_review: 'unreviewed_draft', sources: metadata.sources ?? `TheoremOS frozen problem ${state.problem.contract.problemId}, receipt ${state.problem.receiptDigest}.` },
    formalizations, proofs, environment: { files: environmentFiles, complete: false }, external_verification: evidence, rights, files: entries };
  const manifestBytes = Buffer.from(canonical(manifest)); requireBundle(manifestBytes.length <= limits.manifest, 'manifest_too_large');
  files.set('manifest.json', manifestBytes); const checked = validateFiles(files), archive = zipFiles(files);
  // Fail before creating output if any selection, identity, size or contract check failed.
  fs.mkdirSync(output, { mode: 0o700 }); const directory = path.join(output, 'bundle'), zipFile = path.join(output, 'bundle.zip');
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const [name, bytes] of files) {
    const destination = path.join(directory, name); fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
  }
  fs.writeFileSync(zipFile, archive, { flag: 'wx', mode: 0o600 });
  return { directory, zipFile, ...checked, warnings };
}
