#!/usr/bin/env bun
/** Restore public research evidence from archived snapshots. Does not run or change the solver. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { ArchiveProcess } from '../docs/web/types';

type ProcessRun = ArchiveProcess['runs'][number];
type ProcessCheck = NonNullable<ProcessRun['checks']>[number];
type CheckedSource = NonNullable<ArchiveProcess['sources']>[string];
type SourceReader = (commit: string, proofPath: string) => string | undefined;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
// Keep the same public-text boundary as import-math-campaign.ts.
const publicText = (value: unknown): string => String(value ?? '')
  .replace(/\/(?:home|tmp|data|runtime)\/[^\s"'`<>\])}]+/gu, '[local file]')
  .replace(/\bsk-[A-Za-z0-9_-]{12,}/gu, '[redacted key]');
const validCommit = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const text = (value: unknown) => typeof value === 'string' && value ? publicText(value) : undefined;
function date(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return;
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
function receipts(verification: any): string[] {
  return [...new Set<string>((verification?.results ?? []).flatMap((result: any) =>
    [result.receiptId, result.receipt?.id, ...(result.checks ?? []).map((check: any) => check.receiptId)]
      .filter((id: unknown): id is string => typeof id === 'string' && Boolean(id)).map(publicText)))].sort();
}
function diagnostics(verification: any): string | undefined {
  const parts: string[] = [];
  for (const result of verification.results ?? []) for (const field of ['stdoutPreview', 'stderrPreview', 'error']) {
    if (typeof result[field] !== 'string') continue;
    const output = publicText(result[field]).split('\n').filter(line =>
      !/^DS_DECL_REFERENCES_[^:]+:/u.test(line) && !/^DEEPSCIENTIST_(?:DECL|AXIOMS)_(?:BEGIN|END)_/u.test(line)).join('\n').trim();
    if (output && !parts.includes(output)) parts.push(output);
  }
  if (typeof verification.error === 'string') {
    const error = publicText(verification.error).trim();
    if (error && !parts.includes(error)) parts.push(error);
  }
  return parts.length ? parts.join('\n\n') : undefined;
}

/** A checked file is only attached when its bytes match the receipt's proofHash. */
function checkedSource(record: any, verification: any, readSource?: SourceReader): CheckedSource | undefined {
  if (!readSource) return;
  const results = verification.results ?? [];
  const files = results.filter((result: any) => typeof result.proofPath === 'string' && validHash(result.proofHash));
  if (!files.length || new Set(files.map((result: any) => `${result.proofPath}:${result.proofHash}`)).size !== 1) return;
  const result = files[0];
  const commits = [...new Set([result.targetCommit, verification.targetCommit, record.commit].filter(validCommit))];
  for (const commit of commits) {
    const code = readSource(commit, result.proofPath);
    // Redacting source bytes would break their receipt binding; omit such a file instead.
    if (code !== undefined && hash(code) === result.proofHash && publicText(code) === code)
      return { path: publicText(result.proofPath), code, sha256: result.proofHash };
  }
}

/** Only host-recorded verifications and typed deliveries are selected, never model dialogue. */
export function extractProcessEvidence(state: any, readSource?: SourceReader): {
  checks: NonNullable<ProcessRun['checks']>; deliveries: NonNullable<ProcessRun['deliveries']>;
  sources: NonNullable<ArchiveProcess['sources']>;
} {
  const checks = new Map<string, ProcessCheck>(), sources: NonNullable<ArchiveProcess['sources']> = {};
  function add(record: any, scope: ProcessCheck['scope'], taskId?: string) {
    const verification = record?.verification;
    if (!verification || typeof verification.status !== 'string') return;
    const at = date(verification.checkedAt) ?? date(verification.results?.[0]?.checkedAt) ?? date(verification.startedAt);
    if (!at) return;
    const commits = [...new Set<string>((verification.results ?? []).map((result: any) => result.targetCommit).filter(validCommit))];
    const commit = commits.length === 1 ? commits[0] : validCommit(verification.targetCommit) ? verification.targetCommit
      : validCommit(record.commit) ? record.commit : undefined;
    const receiptIds = receipts(verification), status = publicText(verification.status);
    const identity = JSON.stringify([scope, taskId ?? '', commit ?? '', receiptIds.length ? receiptIds : [at, status]]);
    const key = hash(identity), output = diagnostics(verification), source = checkedSource(record, verification, readSource);
    const previous = checks.get(key);
    if (source) sources[source.sha256] = source;
    if (!previous) checks.set(key, { id: `check-${key.slice(0, 20)}`, at, scope,
      ...(taskId ? { taskId: publicText(taskId) } : {}), ...(commit ? { commit } : {}), status, receiptIds,
      ...(output ? { diagnostics: output } : {}), ...(source ? { sourceDigest: source.sha256 } : {}) });
    else {
      if (source) previous.sourceDigest = source.sha256;
      if (output && !previous.diagnostics) previous.diagnostics = output;
    }
  }
  const cooperation = state.cooperation ?? {};
  const receiptTasks = new Map<string, Set<string>>();
  for (const entry of cooperation.tasks ?? []) {
    if (typeof entry.task?.id !== 'string') continue;
    add(entry.proof, 'task', entry.task.id);
    add(entry.integratedCheck, 'task', entry.task.id);
    for (const record of [entry.proof, entry.integratedCheck]) for (const receipt of receipts(record?.verification)) {
      const tasks = receiptTasks.get(receipt) ?? new Set<string>();
      tasks.add(entry.task.id); receiptTasks.set(receipt, tasks);
    }
  }
  // The whole-original-target check stays separate even when one original goal is also a task.
  add(state.check, 'original');
  for (const worker of state.workers ?? []) {
    if (worker.id === 'solver' && !worker.sessionTaskId) { add(worker.check, 'original'); continue; }
    // A worker may already be assigned to its next task while retaining the previous task's check.
    const matched = new Set(receipts(worker.check?.verification).flatMap(receipt => [...(receiptTasks.get(receipt) ?? [])]));
    if (matched.size === 1) { add(worker.check, 'task', [...matched][0]); continue; }
    const names = new Set<string>((worker.check?.verification?.results ?? []).map((result: any) => result.theoremName).filter(Boolean));
    const candidates = (cooperation.tasks ?? []).filter((entry: any) => names.size === 1 && names.has(entry.task?.theoremName));
    if (candidates.length === 1) add(worker.check, 'task', candidates[0].task.id);
  }
  for (const record of cooperation.proofReadyRecords ?? []) if (record.taskId) {
    add(record, 'task', record.taskId);
    add(record.check, 'task', record.taskId);
  }
  const roles = new Map<string, string>((state.workers ?? []).map((worker: any) => [worker.id, worker.role]));
  const deliveries = new Map<string, NonNullable<ProcessRun['deliveries']>[number]>();
  for (const delivery of cooperation.deliveries ?? []) {
    const at = date(delivery.createdAt);
    if (!at || typeof delivery.id !== 'string' || typeof delivery.kind !== 'string' || typeof delivery.status !== 'string') continue;
    const workerId = text(delivery.producer), role = workerId && text(roles.get(workerId));
    deliveries.set(delivery.id, { id: publicText(delivery.id), at, kind: publicText(delivery.kind), status: publicText(delivery.status),
      ...(text(delivery.taskId) ? { taskId: publicText(delivery.taskId) } : {}), ...(workerId ? { workerId } : {}),
      ...(role ? { role } : {}), ...(validCommit(delivery.commit) ? { commit: delivery.commit } : {}), summary: publicText(delivery.summary) });
  }
  return { checks: [...checks.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
    deliveries: [...deliveries.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)), sources };
}

export function archivedSourceReader(index: any, project: string): SourceReader {
  const repositories = Object.values(index.repositories ?? {}) as { archive?: string }[];
  const cache = new Map<string, string | undefined>();
  return (commit, proofPath) => {
    const relative = path.posix.normalize(proofPath);
    if (path.posix.isAbsolute(relative) || relative.startsWith('../') || !relative.endsWith('.lean')) return;
    const file = relative.startsWith(project + '/') ? relative : path.posix.join(project, relative);
    const key = `${commit}:${file}`;
    if (cache.has(key)) return cache.get(key);
    for (const repository of repositories) {
      if (!repository.archive) continue;
      try {
        const code = execFileSync('git', [`--git-dir=${repository.archive}`, 'show', key],
          { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        cache.set(key, code); return code;
      } catch { /* Historical projections without a retained commit have no source attachment. */ }
    }
    cache.set(key, undefined);
  };
}

/** Enrich existing published processes while leaving their Lean files and acceptance evidence unchanged. */
export function enrichArchiveProcesses(campaign: string, destination = path.join(root, 'research/openai-math')) {
  const manifestPath = path.join(destination, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const totals = { problems: 0, runs: 0, checks: 0, deliveries: 0, sources: 0, sourceBytes: 0 };
  for (const entry of manifest.records) {
    const index = JSON.parse(fs.readFileSync(path.join(campaign, 'trajectories/problems', entry.directory, 'index.json'), 'utf8'));
    const file = path.join(destination, entry.directory, 'process.json');
    const process: ArchiveProcess = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sources: NonNullable<ArchiveProcess['sources']> = {};
    for (const run of process.runs) {
      const archived = index.runs.find((candidate: any) => candidate.runId === run.runId);
      if (!archived?.stateSnapshot) throw new Error(`Missing archived snapshot: ${entry.directory}/${run.runId}`);
      const snapshot = archived.stateSnapshot;
      const bytes = gunzipSync(fs.readFileSync(path.join(campaign, 'trajectories', snapshot.object)));
      if (hash(bytes) !== snapshot.sha256) throw new Error(`Archived snapshot checksum mismatch: ${run.runId}`);
      const state = JSON.parse(bytes.toString('utf8'));
      if (state.runId !== run.runId) throw new Error(`Archived run identity mismatch: ${run.runId}`);
      const evidence = extractProcessEvidence(state, archivedSourceReader(index, state.problem.projectRelative));
      run.checks = evidence.checks; run.deliveries = evidence.deliveries;
      Object.assign(sources, evidence.sources);
      totals.runs++; totals.checks += run.checks.length; totals.deliveries += run.deliveries.length;
    }
    if (Object.keys(sources).length) process.sources = sources; else delete process.sources;
    const content = JSON.stringify(process, null, 2) + '\n';
    fs.writeFileSync(file, content); entry.files['process.json'] = hash(content);
    totals.problems++; totals.sources += Object.keys(sources).length;
    totals.sourceBytes += Object.values(sources).reduce((sum, source) => sum + Buffer.byteLength(source.code), 0);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return totals;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const campaign = process.argv[2] && path.resolve(process.argv[2]);
  if (!campaign) throw new Error('Usage: bun scripts/enrich-archive-process.ts <campaign directory>');
  console.log(JSON.stringify(enrichArchiveProcesses(campaign), null, 2));
}
