import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { mathDigest, parseMathJson, readMathFile, readMathText } from '../math/mathRuntimeIo';
import { buildRunInspection, readRunInspection } from './inspection';
import { buildResearchContributionFlow } from './contributionFlow';
import { readContinuationSnapshot } from './continuationInput';
import type { SolverRunState } from './archive';
import { DECLARATION_ARTIFACTS_FILE, readDeclarationArtifacts } from './declarationArtifacts';
import { continuationSourcePolicyDigest } from './continuationSeed';
import { assertMathCanonicalPath } from '../math/paths';

export type StoredRunInspectionOptions = {
  journal?: { batchFile: string } | { logFile: string };
};

type JournalEvent = { line: number; data: Record<string, unknown> };
export type StoredInspectionJournal = {
  source: 'none' | 'log' | 'batch';
  status: 'absent' | 'read' | 'unreadable' | 'invalid' | 'unmapped' | 'ambiguous';
  batchFile?: string;
  file?: string;
  outputFile?: string;
  runBinding: 'matched' | 'mismatched' | 'unknown';
  coverage: 'unknown' | 'partial';
  bytesRead: number;
  digest?: string;
  ignoredLines: number;
  truncated: boolean;
  incompleteTailBytes: number;
  diagnostics: string[];
};

const seedHistorySchema = z.object({
  source: z.object({ runId: z.string().min(1), stateFile: z.string().min(1),
    stateDigest: z.string().regex(/^[a-f0-9]{64}$/u), buildDigest: z.string().min(1),
    methodDigest: z.string().optional(), canonicalCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    planVersion: z.string().optional() }),
  capturedAt: z.number().int().nonnegative(), capture: z.string().min(1),
});
const singleSourceInspectionSchema = z.object({ schema: z.literal('theorem-os.single-continuation-source.v1'),
  taskDigest: z.string(), problemReceiptDigest: z.string(), sourcePolicyDigest: z.string(),
  destination: z.object({ runId: z.string(), stateFile: z.string() }),
  source: z.object({ runId: z.string(), stateFile: z.string(), stateDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    canonicalCommit: z.string().regex(/^[a-f0-9]{40,64}$/u), environmentDigest: z.string(),
    capturedAt: z.number().int().nonnegative() }),
});
const archivedSingleHistorySchema = z.object({ schema: z.literal('deepscientist.math.solver.v1'),
  runId: z.string().min(1), taskDigest: z.string(), buildDigest: z.string(), environmentDigest: z.string(),
  methodDigest: z.string().optional(), cooperation: z.object({ canonicalCommit: z.string().optional(), planVersion: z.string().optional() }).optional(),
});

export type StoredInspectionContinuation =
  | { status: 'absent' }
  | { status: 'unknown'; file: string; snapshotDigest: string; reason: string }
  | { status: 'recorded'; file: string; snapshotDigest: string; evidence: 'recorded-not-replayed';
      attachment: { id: 'seed-history'; sha256: string; bytes: number };
      source: z.infer<typeof seedHistorySchema>['source']; capturedAt: number; capture: string };

export type StoredRunInspectionArtifacts = {
  stateFile: string;
  resultFile?: string;
  journal: StoredInspectionJournal;
  continuation: StoredInspectionContinuation;
  declarations?: StoredInspectionDeclarations;
};

export type StoredInspectionDeclarations = {
  evidence: 'recorded-not-replayed'; acceptance: 'not-assessed'; requiresFreshCheck: true;
} & (
  | { status: 'absent' }
  | { status: 'unknown'; file: string; reason: string }
  | { status: 'recorded'; file: string; digest: string; declarations: {
      id: string; file: string; name: string; type: string; elaboratedType?: string; premises: string[];
      sourceCommit: string; checkedCommit: string; environmentDigest: string; receiptIds: string[];
    }[] });

function readInspectionDeclarations(stateFile: string, state: SolverRunState): StoredInspectionDeclarations {
  const directory = path.dirname(stateFile), file = path.join(directory, DECLARATION_ARTIFACTS_FILE);
  const evidence = { evidence: 'recorded-not-replayed', acceptance: 'not-assessed', requiresFreshCheck: true } as const;
  if (!fs.existsSync(file)) return { ...evidence, status: 'absent' };
  try {
    const digest = mathDigest(readMathText(file, 32 * 1024 * 1024));
    const artifacts = readDeclarationArtifacts(directory, state);
    if (mathDigest(readMathText(file, 32 * 1024 * 1024)) !== digest)
      throw new Error('math_inspect_declarations_changed');
    return { ...evidence, status: 'recorded', file, digest, declarations: artifacts.map(artifact => ({
      id: artifact.id, file: artifact.declaration.file, name: artifact.declaration.name, type: artifact.declaration.type,
      elaboratedType: artifact.proof.verification.results[0]?.elaboratedDeclarationType,
      premises: [...(artifact.declaration.premises ?? [])], sourceCommit: artifact.proof.commit,
      checkedCommit: artifact.proof.verification.targetCommit, environmentDigest: artifact.environmentDigest,
      receiptIds: artifact.proof.verification.results.map(receipt => receipt.receiptId),
    })) };
  } catch (error) {
    return { ...evidence, status: 'unknown', file,
      reason: error instanceof Error ? error.message : 'math_inspect_declarations_unreadable' };
  }
}

const maxJournalBytes = 16 * 1024 * 1024;
const maxBatchBytes = 4 * 1024 * 1024;

function outputForState(stateFile: string): string | undefined {
  const directory = path.dirname(stateFile);
  return path.basename(stateFile) === 'state.json' && directory.endsWith('.runtime')
    ? directory.slice(0, -'.runtime'.length) : undefined;
}

function readInspectionContinuation(stateFile: string, state: SolverRunState): StoredInspectionContinuation {
  if (!state.continuationDigest) return { status: 'absent' };
  const file = path.join(path.dirname(stateFile), 'continuation.json'), snapshotDigest = state.continuationDigest;
  const unknown = (reason: string): StoredInspectionContinuation => ({ status: 'unknown', file, snapshotDigest, reason });
  try {
    const snapshot = readContinuationSnapshot(file, snapshotDigest,
      { taskDigest: state.taskDigest, problemReceiptDigest: state.problem.receiptDigest });
    const item = snapshot.manifest.attachments.find(attachment => attachment.id === 'seed-history');
    if (!item) return unknown('math_inspect_seed_history_unavailable');
    const bytes = readMathFile(path.join(path.dirname(snapshot.file), item.contentPath), item.bytes).bytes;
    if (bytes.length !== item.bytes || mathDigest(bytes) !== item.sha256)
      return unknown('math_continuation_content_changed');
    const history = seedHistorySchema.safeParse(parseMathJson(bytes, 'math_inspect_seed_history_invalid'));
    if (!history.success) {
      if (state.researchMode !== 'skill') return unknown('math_inspect_seed_history_source_invalid');
      const sourceFile = path.join(path.dirname(stateFile), 'continuation-single-source.json');
      assertMathCanonicalPath(sourceFile);
      if ((fs.lstatSync(sourceFile).mode & 0o777) !== 0o400)
        return unknown('math_inspect_single_source_not_frozen');
      const sourceText = readMathText(sourceFile), description = singleSourceInspectionSchema.safeParse(
        parseMathJson(sourceText, 'math_inspect_single_source_invalid'));
      const archived = archivedSingleHistorySchema.safeParse(parseMathJson(bytes, 'math_inspect_seed_history_invalid'));
      if (!description.success || !archived.success) return unknown('math_inspect_single_source_invalid');
      const record = description.data, source = record.source;
      if (record.taskDigest !== state.taskDigest || record.problemReceiptDigest !== state.problem.receiptDigest ||
          record.sourcePolicyDigest !== continuationSourcePolicyDigest(state.problem) ||
          record.destination.runId !== state.runId || record.destination.stateFile !== stateFile ||
          source.runId === state.runId || source.runId !== archived.data.runId || source.stateDigest !== item.sha256 ||
          archived.data.taskDigest !== state.taskDigest || source.environmentDigest !== archived.data.environmentDigest ||
          item.provenance.runId !== source.runId || item.provenance.source !== source.stateFile ||
          archived.data.cooperation?.canonicalCommit && archived.data.cooperation.canonicalCommit !== source.canonicalCommit)
        return unknown('math_inspect_single_source_identity_mismatch');
      if (mathDigest(readMathText(sourceFile)) !== mathDigest(sourceText)) return unknown('math_inspect_single_source_changed');
      return { status: 'recorded', file, snapshotDigest, evidence: 'recorded-not-replayed',
        attachment: { id: 'seed-history', sha256: item.sha256, bytes: item.bytes },
        source: { runId: source.runId, stateFile: source.stateFile, stateDigest: source.stateDigest,
          buildDigest: archived.data.buildDigest, methodDigest: archived.data.methodDigest,
          canonicalCommit: source.canonicalCommit, planVersion: archived.data.cooperation?.planVersion },
        capturedAt: source.capturedAt, capture: 'single-researcher-frozen-source-and-advisory-history' };
    }
    return { status: 'recorded', file, snapshotDigest, evidence: 'recorded-not-replayed',
      attachment: { id: 'seed-history', sha256: item.sha256, bytes: item.bytes },
      source: history.data.source, capturedAt: history.data.capturedAt, capture: history.data.capture };
  } catch (error) {
    return unknown(error instanceof Error ? error.message : 'math_inspect_continuation_unreadable');
  }
}

/** Capture an existing prefix; appends never extend the observation being read. */
function readJournalPrefix(file: string) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error('math_inspect_log_invalid');
    const plannedBytes = Math.min(stat.size, maxJournalBytes);
    const buffer = Buffer.alloc(plannedBytes);
    let size = 0;
    while (size < plannedBytes) {
      const read = fs.readSync(descriptor, buffer, size, plannedBytes - size, size);
      if (!read) break;
      size += read;
    }
    return { bytes: buffer.subarray(0, size), truncated: stat.size > plannedBytes || size < plannedBytes };
  } finally { fs.closeSync(descriptor); }
}

function parseJournal(bytes: Buffer) {
  const events: JournalEvent[] = [];
  let start = 0, line = 0, ignoredLines = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(10, start);
    if (end < 0) break;
    line += 1;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end));
      const data: unknown = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
          typeof (data as Record<string, unknown>).event !== 'string') ignoredLines += 1;
      else events.push({ line, data: data as Record<string, unknown> });
    } catch { ignoredLines += 1; }
    start = end + 1;
  }
  return { events, ignoredLines, incompleteTailBytes: bytes.length - start };
}

function readInspectionJournal(runId: string, outputFile: string | undefined,
  options?: StoredRunInspectionOptions): { journal: StoredInspectionJournal; events: JournalEvent[] } {
  const source = options?.journal;
  const journal: StoredInspectionJournal = { source: !source ? 'none' : 'batchFile' in source ? 'batch' : 'log',
    status: 'absent', ...(outputFile ? { outputFile } : {}), runBinding: 'unknown', coverage: 'unknown',
    bytesRead: 0, ignoredLines: 0, truncated: false, incompleteTailBytes: 0, diagnostics: [] };
  if (!source) return { journal, events: [] };
  if ('batchFile' in source) {
    journal.batchFile = path.resolve(source.batchFile);
    let batchText: string;
    try { batchText = readMathText(journal.batchFile, maxBatchBytes); }
    catch {
      journal.status = 'unreadable'; journal.diagnostics.push('math_inspect_batch_unreadable');
      return { journal, events: [] };
    }
    let batch: unknown;
    try { batch = JSON.parse(batchText); }
    catch {
      journal.status = 'invalid'; journal.diagnostics.push('math_inspect_batch_invalid');
      return { journal, events: [] };
    }
    if (!batch || typeof batch !== 'object' || !Array.isArray((batch as { jobs?: unknown }).jobs)) {
      journal.status = 'invalid'; journal.diagnostics.push('math_inspect_batch_invalid');
      return { journal, events: [] };
    }
    if (!outputFile) {
      journal.status = 'unmapped'; journal.diagnostics.push('math_inspect_batch_output_unknown');
      return { journal, events: [] };
    }
    const jobs = (batch as { jobs: unknown[] }).jobs.filter((job): job is { output: string; log?: unknown } =>
      Boolean(job && typeof job === 'object' && typeof (job as { output?: unknown }).output === 'string' &&
        path.isAbsolute((job as { output: string }).output) && path.resolve((job as { output: string }).output) === outputFile));
    if (jobs.length !== 1) {
      journal.status = jobs.length ? 'ambiguous' : 'unmapped';
      journal.diagnostics.push(jobs.length ? 'math_inspect_batch_multiple_jobs' : 'math_inspect_batch_no_job');
      return { journal, events: [] };
    }
    if (typeof jobs[0].log !== 'string' || !path.isAbsolute(jobs[0].log)) {
      journal.status = 'invalid'; journal.diagnostics.push('math_inspect_batch_log_invalid');
      return { journal, events: [] };
    }
    journal.file = path.resolve(jobs[0].log);
  } else journal.file = path.resolve(source.logFile);
  try {
    const prefix = readJournalPrefix(journal.file);
    const parsed = parseJournal(prefix.bytes);
    Object.assign(journal, { status: 'read', bytesRead: prefix.bytes.length, digest: mathDigest(prefix.bytes),
      ignoredLines: parsed.ignoredLines, truncated: prefix.truncated, incompleteTailBytes: parsed.incompleteTailBytes,
      coverage: prefix.truncated || parsed.incompleteTailBytes || parsed.ignoredLines ? 'partial' : 'unknown' });
    const runIds = new Set(parsed.events.flatMap(({ data }) => typeof data.runId === 'string' ? [data.runId] : []));
    journal.runBinding = runIds.size === 0 ? 'unknown' : runIds.size === 1 && runIds.has(runId) ? 'matched' : 'mismatched';
    if (journal.runBinding !== 'matched') journal.diagnostics.push(`math_inspect_log_run_${journal.runBinding}`);
    if (prefix.truncated) journal.diagnostics.push('math_inspect_log_prefix_limit');
    if (parsed.incompleteTailBytes) journal.diagnostics.push('math_inspect_log_incomplete_tail');
    return { journal, events: parsed.events };
  } catch {
    journal.status = 'unreadable'; journal.diagnostics.push('math_inspect_log_unreadable');
    return { journal, events: [] };
  }
}

/** Interpret saved artifacts without accepting proofs, changing state or following historical runs. */
export async function inspectStoredRun(run: string, options?: StoredRunInspectionOptions) {
  const stored = readRunInspection(run);
  const input = path.resolve(run);
  const resultFile = path.basename(input) !== 'state.json' ? input : undefined;
  const outputFile = resultFile ?? outputForState(stored.stateFile);
  const { journal, events } = readInspectionJournal(stored.state.runId, outputFile, options);
  const artifacts: StoredRunInspectionArtifacts = { stateFile: stored.stateFile,
    ...(resultFile ? { resultFile } : {}), journal, continuation: readInspectionContinuation(stored.stateFile, stored.state),
    declarations: readInspectionDeclarations(stored.stateFile, stored.state) };
  return { ...buildRunInspection(stored.state, stored.result),
    artifacts,
    contributionFlow: buildResearchContributionFlow(stored.state, journal.status === 'read'
      ? { runBinding: journal.runBinding, ...(journal.digest ? { digest: journal.digest } : {}), events } : undefined) };
}
