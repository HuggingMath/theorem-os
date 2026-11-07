import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupData, capacityEnvelope, inspectSignals, localOperations, main, maintenanceFile, pruneBackups, restoreData } from '../scripts/web-operations';

describe('operator backup, recovery and monitoring with disposable offline data', () => {
  let root: string, data: string;
  const write = (name: string, value: unknown) => {
    const file = path.join(data, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-operations-test-')); data = path.join(root, 'data'); fs.mkdirSync(data); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true }); });

  it('restores accounts, evidence and encrypted vault records without exposing them in output', () => {
    write('accounts/user.json', { id: 'one', email: 'private@example.test' });
    write('keys/one.json', { ciphertext: 'encrypted-fixture-value' });
    write('owners/one/runs/run/run.json', { owner: 'one', run: { id: 'run', status: 'completed', proof: 'private proof' } });
    const snapshot = path.join(root, 'backup'), restored = path.join(root, 'restored');
    const result = backupData(data, snapshot), recovery = restoreData(snapshot, restored);
    expect(result.files).toBe(3); expect(recovery.files).toBe(3);
    expect(fs.readFileSync(path.join(restored, 'keys/one.json'), 'utf8')).toBe(fs.readFileSync(path.join(data, 'keys/one.json'), 'utf8'));
    expect(fs.statSync(snapshot).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(snapshot, 'data/accounts/user.json')).mode & 0o777).toBe(0o600);
    expect(JSON.stringify([result, recovery])).not.toMatch(/private@example|private proof|encrypted-fixture/);
    expect(fs.readFileSync(path.join(snapshot, 'snapshot.json'), 'utf8')).not.toMatch(/private@example|private proof|encrypted-fixture/);
  });

  it('refuses to replace existing backup or restore destinations and never changes the source', () => {
    write('accounts/one.json', { existing: true });
    const snapshot = path.join(root, 'backup'); backupData(data, snapshot);
    expect(() => backupData(data, snapshot)).toThrow('destination_already_exists');
    expect(() => restoreData(snapshot, data)).toThrow('destination_already_exists');
    expect(JSON.parse(fs.readFileSync(path.join(data, 'accounts/one.json'), 'utf8'))).toEqual({ existing: true });
    expect(() => backupData(data, path.join(data, 'nested'))).toThrow('backup_must_be_outside_source');
  });

  it('rejects modified snapshots before any restored directory becomes available', () => {
    write('accounts/one.json', { original: true });
    const snapshot = path.join(root, 'backup'), restored = path.join(root, 'restored'); backupData(data, snapshot);
    fs.writeFileSync(path.join(snapshot, 'data/accounts/one.json'), '{"changed":true}');
    expect(() => restoreData(snapshot, restored)).toThrow('snapshot_checksum_mismatch');
    expect(fs.existsSync(restored)).toBe(false);
  });

  it('rejects links and manifest paths that could escape the snapshot', () => {
    write('accounts/one.json', { original: true });
    fs.symlinkSync(path.join(data, 'accounts/one.json'), path.join(data, 'alias'));
    expect(() => backupData(data, path.join(root, 'linked-backup'))).toThrow('snapshot_requires_regular_files');
    fs.unlinkSync(path.join(data, 'alias'));
    const snapshot = path.join(root, 'backup'); backupData(data, snapshot);
    const manifest = path.join(snapshot, 'snapshot.json'), content = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    content.files[0].path = '../outside'; fs.writeFileSync(manifest, JSON.stringify(content));
    expect(() => restoreData(snapshot, path.join(root, 'restored'))).toThrow('invalid_snapshot_entry');
  });

  it('keeps private snapshots out of Git checkouts, including a symlinked destination', () => {
    const repository = path.join(root, 'repository'); fs.mkdirSync(repository); execFileSync('git', ['init', '--quiet', repository]);
    const alias = path.join(root, 'alias'); fs.symlinkSync(repository, alias);
    expect(() => backupData(data, path.join(alias, 'private-backup'))).toThrow('private_data_destination_inside_repository');
  });

  it('writes persistent maintenance state without replacing other operational records', () => {
    write('operations/failures.json', { smtp: 1 });
    maintenanceFile(data, true); expect(localOperations(data).maintenance).toBe(true);
    maintenanceFile(data, false); expect(localOperations(data).maintenance).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(data, 'operations/failures.json'), 'utf8'))).toEqual({ smtp: 1 });
  });

  it('previews retention then deletes only expired completed snapshots, keeping current and unrelated directories', () => {
    const old = path.join(root, 'old'), current = path.join(root, 'current'), unrelated = path.join(root, 'unrelated');
    backupData(data, old); backupData(data, current); fs.mkdirSync(unrelated);
    const metadata = path.join(old, 'snapshot.json'), snapshot = JSON.parse(fs.readFileSync(metadata, 'utf8'));
    const now = Date.parse('2026-11-07T00:00:00Z'); snapshot.createdAt = '2026-10-30T00:00:00Z'; fs.writeFileSync(metadata, JSON.stringify(snapshot));
    fs.symlinkSync(old, path.join(root, 'linked-snapshot'));
    expect(pruneBackups(root, 7, false, now)).toMatchObject({ expired: [{ directory: 'old' }], removed: 0, preview: true });
    expect(fs.existsSync(old)).toBe(true);
    expect(pruneBackups(root, 7, true, now).removed).toBe(1);
    expect(fs.existsSync(old)).toBe(false); expect(fs.existsSync(current)).toBe(true); expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.lstatSync(path.join(root, 'linked-snapshot')).isSymbolicLink()).toBe(true);
    expect(() => pruneBackups(root, 8)).toThrow('retention_must_be_at_most_seven_days');
  });

  it('counts every persisted workload and outputs no email or proof data', () => {
    write('owners/owner/runs/first/run.json', { run: { status: 'running', source: 'private-proof' } });
    write('owners/owner/runs/second/run.json', { run: { status: 'queued', createdAt: '2026-11-07T00:00:00Z' } });
    write('owners/owner/runs/first/explanations/target/record.json', { status: 'running' });
    write('owners/owner/formalizations/first/record.json', { formalization: { status: 'queued', createdAt: '2026-11-07T01:00:00Z' } });
    write('owners/owner/conversations/first.json', { messages: [{ kind: 'text', status: 'pending', text: 'private question' }, { kind: 'guidance', status: 'pending' }] });
    write('owners/owner/runs/first/events/unrelated.json', 'not parsed as a job');
    const status = localOperations(data);
    expect(status.queues.research).toEqual({ running: 1, queued: 1, oldestQueuedAt: '2026-11-07T00:00:00Z' });
    expect(status.queues.explanation.running).toBe(1); expect(status.queues.formalization.queued).toBe(1); expect(status.queues.conversation.running).toBe(1);
    expect(JSON.stringify(status)).not.toMatch(/private-proof|private question/);
  });

  it('reports readiness, disk, queue and recent SMTP failures without paging anyone', () => {
    const now = Date.parse('2026-11-07T01:00:00Z');
    const status = { maintenance: false, ready: false, disk: { availableBytes: 10, totalBytes: 100 },
      queues: { research: { running: 1, queued: 2, oldestQueuedAt: '2026-11-07T00:00:00Z' } }, failures: { smtp: 1 } };
    expect(inspectSignals(status, { minFreeGiB: 1, maxQueueSeconds: 60, now })).toEqual(['service_not_ready', 'disk_space_low', 'research_queue_wait_long', 'smtp_delivery_failed']);
    expect(inspectSignals({ ...status, maintenance: true, failures: { smtp: 1, lastSmtpFailureAt: '2026-11-06T00:00:00Z' } }, { minFreeGiB: 1, maxQueueSeconds: 60, now })).toEqual(['disk_space_low', 'research_queue_wait_long']);
    expect(capacityEnvelope(1)).toMatchObject({ memoryLimitSumGiB: 44, cpuLimitSum: 10, suggestedFreeDiskGiB: 90 });
  });

  it('requires an explicitly offline source for file backup and a service origin for monitor', async () => {
    await expect(main(['backup', '--data-root', data, '--output', path.join(root, 'backup')])).rejects.toThrow('backup_requires_container_or_explicit_offline_source');
    await expect(main(['monitor', '--data-root', data])).rejects.toThrow('missing_base-url');
    const print = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['backup', '--data-root', data, '--offline', '--output', path.join(root, 'backup')]);
    expect(print).toHaveBeenCalledOnce();
  });

  it('refuses a live container before copying its data', async () => {
    const binary = path.join(root, 'docker');
    fs.writeFileSync(binary, `#!${process.execPath}\nif (process.argv[2] !== 'inspect') process.exit(23); console.log(JSON.stringify({Running:true,Paused:false}));\n`, { mode: 0o700 });
    vi.stubEnv('PATH', root);
    await expect(main(['backup', '--container', 'local-fixture', '--output', path.join(root, 'backup')])).rejects.toThrow('backup_requires_paused_or_stopped_container');
    expect(fs.existsSync(path.join(root, 'backup'))).toBe(false);
  });

  it('copies a paused container through a disposable Docker fixture and restores its private records', async () => {
    write('accounts/one.json', { email: 'private@example.test' });
    const binary = path.join(root, 'docker');
    fs.writeFileSync(binary, `#!${process.execPath}\nconst fs=require('node:fs'); const path=require('node:path');
if(process.argv[2]==='inspect') console.log(JSON.stringify({Running:true,Paused:true}));
else if(process.argv[2]==='cp') fs.cpSync(path.join(__dirname,'data'),process.argv[4],{recursive:true});
else process.exit(23);\n`, { mode: 0o700 });
    vi.stubEnv('PATH', root);
    const print = vi.spyOn(console, 'log').mockImplementation(() => {});
    const backup = path.join(root, 'backup');
    await main(['backup', '--container', 'paused-fixture', '--output', backup]);
    const restored = path.join(root, 'restored'); restoreData(backup, restored);
    expect(JSON.parse(fs.readFileSync(path.join(restored, 'accounts/one.json'), 'utf8'))).toEqual({ email: 'private@example.test' });
    expect(JSON.stringify(print.mock.calls)).not.toContain('private@example.test');
  });

  it('counts SMTP failures on stderr and orphan containers without printing raw logs', async () => {
    const binary = path.join(root, 'docker');
    fs.writeFileSync(binary, `#!${process.execPath}\nif(process.argv[2]==='ps') console.log('theoremos-check-fixture\\ntheoremos-web-orphan');
else if(process.argv[2]==='logs') process.stderr.write('[completion mail] run fixture: delivery failed secret-fixture-content\\n');
else process.exit(23);\n`, { mode: 0o700 });
    vi.stubEnv('PATH', root);
    const print = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['status', '--data-root', data, '--container', 'local-fixture']);
    const result = JSON.parse(print.mock.calls[0][0]);
    expect(result.failures.smtp).toBe(1); expect(result.queues.precheck.running).toBe(1); expect(result.queues.untrackedWorkers.running).toBe(1);
    expect(JSON.stringify(print.mock.calls)).not.toContain('secret-fixture-content');
  });

  it('uses a private session file and same-origin CSRF without including credentials in output', async () => {
    const file = path.join(root, 'session.json'); fs.writeFileSync(file, JSON.stringify({ cookie: 'theoremos_session=private-cookie', csrf: 'private-csrf' }), { mode: 0o600 });
    const request = vi.fn(async () => new Response(JSON.stringify({ maintenance: true }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', request); const print = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['maintenance', 'on', '--base-url', 'https://workbench.example.test', '--session-file', file]);
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'PUT', headers: { Cookie: 'theoremos_session=private-cookie', 'X-CSRF-Token': 'private-csrf', Origin: 'https://workbench.example.test' } });
    expect(JSON.stringify(print.mock.calls)).not.toMatch(/private-cookie|private-csrf/);
    fs.chmodSync(file, 0o644);
    await expect(main(['maintenance', 'off', '--base-url', 'https://workbench.example.test', '--session-file', file])).rejects.toThrow('session_file_must_be_private');
  });
});
