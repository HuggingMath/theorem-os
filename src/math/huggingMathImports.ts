import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HuggingMathClient, readHubSessionProfile } from './huggingMathClient';
import { readHuggingMathBundle } from './huggingMathBundle';
import { readMathText, syncMathDirectory, writeMathJsonDurable } from './mathRuntimeIo';
import { assertMathCanonicalPath } from './paths';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const jsonObject = z.record(z.unknown());
const file = z.object({ path: z.string(), sha256: digest, bytes: z.number().int().nonnegative(), role: z.string() });
const journalSchema = z.object({
  schema: z.literal('theorem-os.huggingmath-import.v1'), server: z.string().url(),
  batchId: z.string().min(1), bundleDigest: digest, planDigest: digest,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/u),
  provider: z.string(), externalId: z.string(), owner: z.string(), files: z.array(file),
  preview: jsonObject, result: jsonObject.optional(), record: jsonObject.optional(),
}).strict();
export type HuggingMathImport = z.infer<typeof journalSchema>;

const serverIdentity = (url: string) => new URL(url).href.replace(/\/+$/u, '');
const fail = (reason: string): never => { throw new Error(`huggingmath_import_${reason}`); };

function newJournal(output: string, journal: HuggingMathImport): void {
  assertMathCanonicalPath(output);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(output, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(journal, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncMathDirectory(path.dirname(output));
}

export function readHuggingMathImport(input: string): HuggingMathImport {
  assertMathCanonicalPath(input);
  return journalSchema.parse(JSON.parse(readMathText(input, 32 * 1024 * 1024)));
}

function connection(input: string, profileFile: string) {
  const journal = readHuggingMathImport(input);
  const profile = readHubSessionProfile(profileFile);
  if (serverIdentity(profile.baseUrl) !== journal.server) fail('server_changed');
  return { journal, client: new HuggingMathClient(profile) };
}

/** Preview stores the exact retry tuple before any apply can create domain objects. */
export async function previewHuggingMathImport(options: {
  bundleFile: string; profileFile: string; owner?: string; outputFile: string;
}): Promise<HuggingMathImport> {
  const output = path.resolve(options.outputFile);
  assertMathCanonicalPath(output);
  if (fs.existsSync(output)) fail('output_exists');
  const selected = readHuggingMathBundle(options.bundleFile);
  const manifest = z.object({ provider: z.string(), external_id: z.string(), files: z.array(file) }).parse(selected.manifest);
  const profile = readHubSessionProfile(options.profileFile);
  const report = await new HuggingMathClient(profile).preview(selected.zip, options.owner);
  const preview = z.object({ batch_id: z.string().min(1), bundle_digest: digest, plan_digest: digest,
    owner: z.string(), provider: z.string(), external_id: z.string(), plan: jsonObject }).parse(report);
  if (preview.bundle_digest !== selected.bundleDigest || preview.provider !== manifest.provider ||
      preview.external_id !== manifest.external_id || options.owner && preview.owner !== options.owner)
    fail('preview_binding_mismatch');
  const journal = journalSchema.parse({ schema: 'theorem-os.huggingmath-import.v1',
    server: serverIdentity(profile.baseUrl), batchId: preview.batch_id, bundleDigest: preview.bundle_digest,
    planDigest: preview.plan_digest, idempotencyKey: crypto.randomUUID(),
    provider: manifest.provider, externalId: manifest.external_id, owner: preview.owner,
    files: manifest.files, preview: report });
  newJournal(output, journal);
  return journal;
}

function bindRecord(journal: HuggingMathImport, record: Record<string, unknown>) {
  const returned = z.object({ record_id: z.string(), bundle_digest: digest,
    provider: z.string(), external_id: z.string(), owner: z.string(), problem: z.string(), files: z.array(file) }).parse(record);
  if (returned.record_id !== journal.result?.record_id || returned.bundle_digest !== journal.bundleDigest ||
      returned.problem !== journal.result?.problem || returned.provider !== journal.provider ||
      returned.external_id !== journal.externalId || returned.owner !== journal.owner)
    fail('record_binding_mismatch');
  const identity = (files: z.infer<typeof file>[]) => files.map(f => JSON.stringify([f.path, f.role, f.sha256, f.bytes])).sort();
  if (JSON.stringify(identity(returned.files)) !== JSON.stringify(identity(journal.files))) fail('record_files_changed');
}

/** No automatic retry: a failed transport can be retried with the same saved batch/plan/key. */
export async function applyHuggingMathImport(input: string, profileFile: string): Promise<HuggingMathImport> {
  const { journal, client } = connection(input, profileFile);
  const result = await client.apply(journal.batchId, journal.planDigest, journal.idempotencyKey);
  const accepted = z.object({ outcome: z.enum(['create', 'update', 'noop']), record_id: z.string().min(1),
    problem: z.string().min(1), replayed: z.boolean() }).parse(result);
  if (journal.result && (journal.result.record_id !== accepted.record_id || journal.result.problem !== accepted.problem))
    fail('apply_mapping_changed');
  // Persist the successful write before attempting another network operation.
  journal.result = result;
  writeMathJsonDurable(input, journal);
  const record = await client.record(accepted.record_id);
  bindRecord(journal, record);
  journal.record = record;
  writeMathJsonDurable(input, journal);
  return journal;
}

export async function readbackHuggingMathImport(input: string, profileFile: string): Promise<HuggingMathImport> {
  const { journal, client } = connection(input, profileFile);
  if (!journal.result) {
    const batch = await client.batch(journal.batchId);
    if (batch.bundle_digest !== journal.bundleDigest || batch.plan_digest !== journal.planDigest) fail('batch_binding_mismatch');
    // An uncertain apply must be reconciled using its saved key, through apply, so a key
    // belonging to another invocation can never be mistaken for this journal's result.
    return journal;
  }
  const record = await client.record(String(journal.result.record_id));
  bindRecord(journal, record);
  journal.record = record;
  writeMathJsonDurable(input, journal);
  return journal;
}
