import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { campaignRecords } from '../docs/web/campaignCatalog';
import { archiveIndex } from '../docs/web/catalog';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const hash = (data: string) => crypto.createHash('sha256').update(data).digest('hex');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-campaign-site-'));
  directories.push(root);
  const base = path.join(root, 'research/openai-math');
  fs.mkdirSync(path.join(base, 'Example'), { recursive: true });
  const runId = '145b477c-2f3c-43e2-94d1-f0de28bc6015';
  const proof = 'theorem example : True := by trivial\n';
  const campaign = { target: 'Example', runId, targets: ['example'], proofCommit: 'a'.repeat(40), proofSha256: hash(proof),
    kernelReceiptIds: ['lean-fixture'], comparatorExitCode: 0, attribution: 'Recorded fixture', evidenceUrl: 'data/proofs/openai_example/verification.json' };
  const record = { id: 'openai_example', title: 'Example', subtitle: '示例', area: '数学', summary: '示例',
    en: { subtitle: 'Example', area: 'Mathematics', summary: 'Example' }, status: 'locally_verified', model: 'fixture',
    updatedAt: '2026-11-02T00:00:00Z', directory: 'Example', files: {} as Record<string, string>, declaration: 'theorem example',
    campaign, processSummary: { runs: 1, tasks: 0 } };
  const write = (name: string, value: string | object) => {
    const data = typeof value === 'string' ? value : JSON.stringify(value);
    fs.writeFileSync(path.join(base, 'Example', name), data);
    record.files[name] = hash(data);
  };
  write('Submission.lean', proof);
  write('Challenge.lean', 'theorem example : True := by sorry\n');
  write('verification.json', { ...campaign, status: 'evaluated_passed', kernelStatus: 'kernel_verified' });
  write('process.json', { runs: [{ runId, phase: 'finished', resultStatus: 'evaluated_passed', turns: 2, workers: 1, tasks: [], events: [] }] });
  const save = () => fs.writeFileSync(path.join(base, 'manifest.json'), JSON.stringify({
    schema: 'theoremos.campaign-archive.v1', capturedAt: '2026-11-02T01:00:00Z', records: [record],
  }));
  save();
  return { root, base, record, write, save };
}

describe('campaign results in the public proof archive', () => {
  it('keeps native acceptance, proof identity and recorded process without inventing official acceptance', () => {
    const { root } = fixture();
    const { records } = campaignRecords(root);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.status).toBe('locally_verified');
    expect(record.official).toBeUndefined();
    expect(record.sources.find(source => source.name === 'Submission.lean')?.code).toContain('by trivial');
    expect(record.process?.runs[0].runId).toBe(record.campaign?.runId);
    const index = archiveIndex({ schema: 'theoremos.public-archive.v1', repository: '', archiveRevision: 'a'.repeat(40), snapshotAt: '', records });
    expect(index.records[0]).not.toHaveProperty('process');
    expect(index.records[0].sources[0]).not.toHaveProperty('code');
    expect(index.records[0].processSummary?.runs).toBe(1);
  });

  it('refuses a changed proof even if the manifest still claims acceptance', () => {
    const { root, base } = fixture();
    fs.writeFileSync(path.join(base, 'Example/Submission.lean'), 'theorem example : False := by sorry\n');
    expect(() => campaignRecords(root)).toThrow('Campaign checksum mismatch');
  });

  it('refuses model completion or failed checking as proof acceptance', () => {
    const { root, record, write, save } = fixture();
    write('verification.json', { ...record.campaign, status: 'completed', kernelStatus: 'failed' });
    save();
    expect(() => campaignRecords(root)).toThrow('Campaign acceptance mismatch');
  });

  it('refuses a process belonging to another run', () => {
    const { root, write, save } = fixture();
    write('process.json', { runs: [{ runId: 'different-run', resultStatus: 'evaluated_passed' }] });
    save();
    expect(() => campaignRecords(root)).toThrow('Campaign process missing accepted run');
  });
});
