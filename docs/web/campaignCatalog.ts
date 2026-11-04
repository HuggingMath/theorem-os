import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { ArchiveProcess, ArchiveRecord } from './types';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const campaignSchema = z.object({
  target: z.string().regex(/^[A-Za-z0-9_-]+$/u), runId: z.string().uuid(), targets: z.array(z.string()).min(1),
  proofCommit: z.string().regex(/^[a-f0-9]{40}$/u), proofSha256: digest, kernelReceiptIds: z.array(z.string()).min(1),
  comparatorExitCode: z.literal(0), reviewStatus: z.string().optional(), attribution: z.string(), attributionEn: z.string().optional(), evidenceUrl: z.string(),
});
const schema = z.object({
  schema: z.literal('theoremos.campaign-archive.v1'), capturedAt: z.string().datetime(),
  records: z.array(z.object({
    id: z.string().regex(/^openai_[a-z0-9_]+$/u), title: z.string(), subtitle: z.string(), area: z.string(), summary: z.string(),
    en: z.object({ subtitle: z.string(), area: z.string(), summary: z.string() }),
    status: z.literal('locally_verified'), model: z.string(), updatedAt: z.string().datetime(),
    directory: z.string().regex(/^[A-Za-z0-9_-]+$/u), files: z.record(digest), declaration: z.string(),
    campaign: campaignSchema, processSummary: z.object({ runs: z.number().int().positive(), tasks: z.number().int().nonnegative() }),
  })),
});

export function campaignRecords(root: string): { records: ArchiveRecord[]; capturedAt?: string } {
  const base = path.join(root, 'research/openai-math');
  const manifest = path.join(base, 'manifest.json');
  if (!fs.existsSync(manifest)) return { records: [] };
  const parsed = schema.parse(JSON.parse(fs.readFileSync(manifest, 'utf8')));
  const records = parsed.records.map(entry => {
    if (entry.directory !== entry.campaign.target) throw new Error(`Campaign identity mismatch: ${entry.id}`);
    const content = new Map<string, string>();
    for (const [name, expected] of Object.entries(entry.files)) {
      const filename = path.resolve(base, entry.directory, name);
      if (!filename.startsWith(path.resolve(base, entry.directory) + path.sep)) throw new Error(`Invalid campaign file: ${name}`);
      const bytes = fs.readFileSync(filename);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Campaign checksum mismatch: ${entry.id}/${name}`);
      content.set(name, bytes.toString('utf8'));
    }
    if (entry.files['Submission.lean'] !== entry.campaign.proofSha256 || !content.has('Challenge.lean')) throw new Error(`Campaign proof mismatch: ${entry.id}`);
    const evidence = JSON.parse(content.get('verification.json') ?? 'null');
    if (evidence?.runId !== entry.campaign.runId || evidence?.proofSha256 !== entry.campaign.proofSha256 ||
      evidence?.status !== 'evaluated_passed' || evidence?.kernelStatus !== 'kernel_verified' || evidence?.comparatorExitCode !== 0) {
      throw new Error(`Campaign acceptance mismatch: ${entry.id}`);
    }
    const process: ArchiveProcess = JSON.parse(content.get('process.json') ?? 'null');
    if (!process?.runs.some(run => run.runId === entry.campaign.runId && run.resultStatus === 'evaluated_passed')) {
      throw new Error(`Campaign process missing accepted run: ${entry.id}`);
    }
    const { target, runId, targets, proofCommit, proofSha256, kernelReceiptIds, comparatorExitCode, reviewStatus,
      attribution, attributionEn, evidenceUrl } = entry.campaign;
    return { id: entry.id, title: entry.title, subtitle: entry.subtitle, area: entry.area, summary: entry.summary,
      en: { subtitle: entry.en.subtitle, area: entry.en.area, summary: entry.en.summary },
      status: entry.status, model: entry.model, updatedAt: entry.updatedAt, declaration: entry.declaration,
      campaign: { target, runId, targets, proofCommit, proofSha256, kernelReceiptIds, comparatorExitCode, reviewStatus,
        attribution, attributionEn, evidenceUrl },
      processSummary: { runs: entry.processSummary.runs, tasks: entry.processSummary.tasks }, process,
      archiveUrl: `data/proofs/${entry.id}/process.json`,
      sources: [...content.entries()].filter(([name]) => name.endsWith('.lean')).map(([name, code]) => ({
        name, code, path: `research/openai-math/${entry.directory}/${name}`, url: `data/proofs/${entry.id}/${name}`,
        sha256: entry.files[name], lines: code.split('\n').length - Number(code.endsWith('\n')),
      })),
    } satisfies ArchiveRecord;
  });
  return { records, capturedAt: parsed.capturedAt };
}
