import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recoverScheduledBackup, scheduledBackup } from '../scripts/web-operations-scheduled';

describe('scheduled backups on disposable private records without production access', () => {
  let root: string, source: string, backupRoot: string, stateRoot: string;
  let paused: boolean, maintenance: { enabled: boolean; owner?: string }, active: boolean;
  let calls: string[][], fail: string | undefined, replacement: boolean;
  const id = 'a'.repeat(64), other = 'b'.repeat(64);
  const options = () => ({ container: 'disposable-fixture', backupRoot, stateRoot });
  const command = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'inspect') return JSON.stringify({ Id: replacement ? other : id, Image: 'sha256:fixture', State: { Running: true, Paused: paused },
      Mounts: [{ Type: 'volume', Destination: '/var/lib/theorem-os' }] });
    if (args[0] === 'pause') { paused = true; return ''; }
    if (args[0] === 'unpause') { paused = false; return ''; }
    if (args[0] === 'cp') {
      if (fail === 'copy') throw new Error('copy_fixture_failed');
      fs.cpSync(source, args[2], { recursive: true });
      return '';
    }
    if (args[0] === 'exec' && args[3] === '-e') {
      const { action, owner } = JSON.parse(args.at(-1)!);
      if (action === 'begin') maintenance = { enabled: true, owner };
      if (action === 'check' && maintenance.owner !== owner) throw new Error('maintenance_owner_changed');
      if (action === 'release' && maintenance.owner === owner) maintenance = { enabled: false };
      return '{}';
    }
    if (args.includes('wait-drained')) {
      if (fail === 'drain') throw new Error('drain_fixture_failed');
      return '{}';
    }
    if (args.includes('status')) return JSON.stringify({ maintenance: maintenance.enabled, queues: { research: { running: active ? 1 : 0, queued: 0 } } });
    throw new Error('unexpected_fixture_command');
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-scheduled-'));
    source = path.join(root, 'source'); backupRoot = path.join(root, 'backups'); stateRoot = path.join(root, 'state');
    fs.mkdirSync(source); fs.mkdirSync(path.join(source, 'accounts'));
    fs.writeFileSync(path.join(source, 'accounts', 'c'.repeat(64) + '.json'), JSON.stringify({ email: 'private-fixture@example.test', id: 'account-fixture' }));
    fs.mkdirSync(path.join(source, 'owners', 'fixture', 'runs', 'run'), { recursive: true });
    fs.writeFileSync(path.join(source, 'owners', 'fixture', 'runs', 'run', 'run.json'), JSON.stringify({ owner: 'fixture', run: { status: 'completed', proof: 'private fixture proof' } }));
    paused = false; maintenance = { enabled: false }; active = false; calls = []; fail = undefined; replacement = false;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('copies only while paused, resumes before restore, and marks a verified complete snapshot privately', () => {
    const result = scheduledBackup(options(), command);
    expect(result).toMatchObject({ status: 'completed', passed: true, verification: { schema: 'theorem-os.backup-verification.v1', files: 2, passed: true } });
    const pause = calls.findIndex(args => args[0] === 'pause'), copy = calls.findIndex(args => args[0] === 'cp'), resume = calls.findIndex(args => args[0] === 'unpause');
    expect(pause).toBeGreaterThan(0); expect(copy).toBeGreaterThan(pause); expect(resume).toBeGreaterThan(copy);
    expect(paused).toBe(false); expect(maintenance.enabled).toBe(false);
    expect(fs.existsSync(path.join(stateRoot, 'backup-lease.json'))).toBe(false);
    expect(fs.existsSync(path.join(stateRoot, 'backup-work.json'))).toBe(false);
    const directories = fs.readdirSync(backupRoot); expect(directories).toHaveLength(1);
    const snapshot = path.join(backupRoot, directories[0]);
    expect(fs.statSync(snapshot).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(snapshot, 'verification.json')).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toMatch(/private-fixture@|private fixture proof|account-fixture/);
    expect(scheduledBackup(options(), command)).toMatchObject({ status: 'fresh', passed: true });
    expect(calls.filter(args => args[0] === 'pause')).toHaveLength(1);
  });

  it('leaves active jobs and operator maintenance alone', () => {
    active = true;
    expect(scheduledBackup(options(), command)).toMatchObject({ status: 'deferred', reason: 'active_work' });
    active = false; maintenance = { enabled: true };
    expect(scheduledBackup(options(), command)).toMatchObject({ status: 'deferred', reason: 'operator_maintenance' });
    expect(calls.some(args => args[0] === 'pause' || args[0] === 'cp')).toBe(false);
    expect(maintenance.enabled).toBe(true);
  });

  it.each(['drain', 'copy'])('recovers maintenance and pause after %s fails, retaining no private work copy', reason => {
    fail = reason;
    expect(() => scheduledBackup(options(), command)).toThrow(reason + '_fixture_failed');
    expect(paused).toBe(false); expect(maintenance.enabled).toBe(false);
    expect(fs.readdirSync(backupRoot)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(stateRoot, 'backup.json'), 'utf8'))).toMatchObject({ status: 'failed', cleanupRequired: false });
    expect(fs.existsSync(path.join(stateRoot, 'backup-lease.json'))).toBe(false);
  });

  it('recovers its persisted lease after process termination and preserves a newer manual maintenance state', () => {
    fs.mkdirSync(stateRoot); const owner = 'scheduled-backup-' + crypto.randomUUID();
    fs.writeFileSync(path.join(stateRoot, 'backup-lease.json'), JSON.stringify({ containerId: id, owner, startedAt: new Date().toISOString() }));
    paused = true; maintenance = { enabled: true, owner: 'manual-maintenance' };
    expect(recoverScheduledBackup(options(), command)).toEqual({ recovered: true });
    expect(paused).toBe(false); expect(maintenance).toEqual({ enabled: true, owner: 'manual-maintenance' });
    expect(recoverScheduledBackup(options(), command)).toEqual({ recovered: false });
  });

  it('keeps the recovery marker and refuses to resume a replacement container', () => {
    fs.mkdirSync(stateRoot);
    fs.writeFileSync(path.join(stateRoot, 'backup-lease.json'), JSON.stringify({ containerId: id, owner: 'scheduled-backup-' + crypto.randomUUID(), startedAt: new Date().toISOString() }));
    paused = true; replacement = true;
    expect(() => recoverScheduledBackup(options(), command)).toThrow('backup_recovery_container_changed');
    expect(calls.filter(args => args[0] === 'unpause')).toEqual([]);
    expect(fs.existsSync(path.join(stateRoot, 'backup-lease.json'))).toBe(true);
  });

  it('does not accept a changed verification manifest as a fresh backup', () => {
    scheduledBackup(options(), command);
    const snapshot = path.join(backupRoot, fs.readdirSync(backupRoot)[0]);
    fs.appendFileSync(path.join(snapshot, 'snapshot.json'), '\n');
    expect(scheduledBackup(options(), command)).toMatchObject({ status: 'completed', passed: true });
    expect(calls.filter(args => args[0] === 'pause')).toHaveLength(2);
  });
});
