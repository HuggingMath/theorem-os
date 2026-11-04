import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalMathJson, mathDigest, syncMathDirectory, writeMathFrozen } from '../../src/math/mathRuntimeIo';
import type { WebArchive, WebCheckReceipt, WebCommandResult, WebObservation, WebTaskSource } from './collaboration';
import type { WebAgentAction, WebEvent, WebExplanation, WebRun } from './shared';
import type { WebShareSnapshot } from './share';

export type WebCreation = { schema: 'theorem-os.web-creation.v1'; requestId: string; digest: string };
type StoredRun = { owner: string; run: WebRun; creation?: WebCreation };

export type StoredWebSession = { id: string; csrf: string; touchedAt: number; account?: { id: string; email: string }; passwordResetUntil?: number };
export type StoredWebArchive = {
  schema: 'theorem-os.web-archive.v1';
  summary: WebArchive;
  run: WebRun;
  observations: WebObservation[];
  sources: WebTaskSource[];
  checks: WebCheckReceipt[];
  events: WebEvent[];
  commands: WebCommandResult[];
};

export type StoredWebShare = { token: string; createdAt: string; snapshot: WebShareSnapshot };
type ShareIndex = { ownerDigest: string; runId: string };

export class WebStorageError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const digestKey = (value: string) => mathDigest(value);
const encoded = (value: unknown) => canonicalMathJson(value) + '\n';
const safeRunId = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new WebStorageError(400, '运行标识无效。');
  return id;
};
const bySequence = <T extends { sequence: number }>(items: T[]) => items.sort((a, b) => a.sequence - b.sequence);
const credentialFields = new Set(['apiKey', 'api_key', 'access_token', 'refresh_token', 'authorization']);
/** Records accept visible run data only. Credential objects never become restart state. */
const publicRecord = <T>(value: T): T => JSON.parse(JSON.stringify(value,
  (key, item) => credentialFields.has(key) ? undefined : item));

/** Optional web-only persistence. An omitted root keeps the same API in memory for disposable fixtures. */
export class WebStorage {
  readonly root?: string;
  private readonly memory = new Map<string, string>();

  constructor(dataRoot?: string) {
    if (dataRoot) {
      fs.mkdirSync(path.resolve(dataRoot), { recursive: true, mode: 0o700 });
      this.root = fs.realpathSync(path.resolve(dataRoot));
    }
  }

  ownerDirectory(owner: string): string | undefined {
    return this.root ? path.join(this.root, 'owners', digestKey(owner)) : undefined;
  }
  private ownerPath(owner: string): string[] {
    if (!owner || owner.length > 256) throw new WebStorageError(400, '会话标识无效。');
    return ['owners', digestKey(owner)];
  }
  private runPath(owner: string, id: string): string[] { return [...this.ownerPath(owner), 'runs', safeRunId(id)]; }
  private key(segments: string[]): string {
    if (!segments.length || segments.some(segment => !/^[A-Za-z0-9_.-]+$/u.test(segment) || segment === '.' || segment === '..'))
      throw new Error('web_storage_invalid_key');
    return segments.join('/');
  }
  getRecord<T>(segments: string[]): T | undefined {
    const key = this.key(segments), file = this.root ? path.join(this.root, key) : undefined;
    const text = file ? (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined) : this.memory.get(key);
    return text === undefined ? undefined : JSON.parse(text) as T;
  }
  saveRecord(segments: string[], value: unknown, immutable = false): void {
    const key = this.key(segments), text = encoded(publicRecord(value));
    if (!this.root) {
      const previous = this.memory.get(key);
      if (immutable && previous !== undefined && previous !== text) throw new Error('web_storage_immutable_record_changed');
      this.memory.set(key, text); return;
    }
    const file = path.join(this.root, key);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (immutable) {
      if (fs.existsSync(file)) {
        if (fs.readFileSync(file, 'utf8') !== text) throw new Error('web_storage_immutable_record_changed');
        return;
      } else writeMathFrozen(file, text);
    } else {
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    }
    syncMathDirectory(path.dirname(file));
  }
  listRecords(segments: string[]): string[] {
    const key = this.key(segments);
    if (!this.root) return [...new Set([...this.memory.keys()].filter(item => item.startsWith(key + '/'))
      .map(item => item.slice(key.length + 1).split('/')[0]!))].sort();
    const directory = path.join(this.root, key);
    return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
  }
  deleteRecord(segments: string[]): void {
    const key = this.key(segments);
    if (this.root) fs.rmSync(path.join(this.root, key), { recursive: true, force: true });
    else for (const item of this.memory.keys()) if (item === key || item.startsWith(key + '/')) this.memory.delete(item);
  }

  saveSession(session: StoredWebSession): void {
    this.saveRecord(['sessions', `${digestKey(session.id)}.json`], { id: session.id, csrf: session.csrf, touchedAt: session.touchedAt,
      ...(session.account ? { account: session.account } : {}),
      ...(session.passwordResetUntil ? { passwordResetUntil: session.passwordResetUntil } : {}) });
  }
  getSession(id: string): StoredWebSession | undefined { return this.getRecord(['sessions', `${digestKey(id)}.json`]); }
  listSessions(): StoredWebSession[] {
    return this.listRecords(['sessions']).map(file => this.getRecord<StoredWebSession>(['sessions', file])!);
  }
  deleteSession(id: string): void { this.deleteRecord(['sessions', `${digestKey(id)}.json`]); }

  saveRun(owner: string, run: WebRun, creation?: WebCreation): void {
    const directory = this.runPath(owner, run.id);
    this.saveRecord([...this.ownerPath(owner), 'owner.json'], { owner }, true);
    if (run.observation) this.saveObservation(owner, run.observation);
    for (const event of run.events) this.saveRecord([...directory, 'events', `${event.sequence}.json`], event, true);
    creation ??= this.getRecord<StoredRun>([...directory, 'run.json'])?.creation;
    this.saveRecord([...directory, 'run.json'], { owner, run, ...(creation ? { creation } : {}) });
  }
  getRun(owner: string, id: string): WebRun | undefined {
    return this.getRecord<{ owner: string; run: WebRun }>([...this.runPath(owner, id), 'run.json'])?.run;
  }
  loadRuns(): StoredRun[] {
    return this.listRecords(['owners']).flatMap(directory => this.listRecords(['owners', directory, 'runs'])
      .map(id => this.getRecord<StoredRun>(['owners', directory, 'runs', id, 'run.json']))
      .filter((item): item is StoredRun => Boolean(item)))
      .sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt));
  }
  deletedCreation(owner: string, requestId: string): WebCreation | undefined {
    return this.getRecord([...this.ownerPath(owner), 'deleted-requests', `${digestKey(requestId)}.json`]);
  }
  deleteRun(owner: string, id: string): void {
    const creation = this.getRecord<StoredRun>([...this.runPath(owner, id), 'run.json'])?.creation;
    // Keep a tombstone: a delayed retry must never resurrect a deliberately deleted run.
    if (creation) this.saveRecord([...this.ownerPath(owner), 'deleted-requests', `${digestKey(creation.requestId)}.json`], creation, true);
    this.deleteShare(owner, id); this.deleteRecord(this.runPath(owner, id));
  }
  /** Everything a session or account owns: runs, share links, archives, knowledge catalogs and module plans. */
  deleteOwner(owner: string): void {
    for (const id of this.listRecords([...this.ownerPath(owner), 'runs'])) this.deleteShare(owner, id);
    this.deleteRecord(this.ownerPath(owner));
  }

  /** The snapshot lives with the run, so deleting the run always ends the link; the index only resolves tokens. */
  saveShare(owner: string, runId: string, share: StoredWebShare): void {
    this.saveRecord([...this.runPath(owner, runId), 'share.json'], share, true);
    this.saveRecord(['shares', `${digestKey(share.token)}.json`], { ownerDigest: digestKey(owner), runId } satisfies ShareIndex, true);
  }
  getOwnShare(owner: string, runId: string): StoredWebShare | undefined {
    return this.getRecord([...this.runPath(owner, runId), 'share.json']);
  }
  getShare(token: string): StoredWebShare | undefined {
    const index = this.getRecord<ShareIndex>(['shares', `${digestKey(token)}.json`]);
    if (!index || !/^[a-f0-9]{64}$/u.test(index.ownerDigest)) return;
    const share = this.getRecord<StoredWebShare>(['owners', index.ownerDigest, 'runs', safeRunId(index.runId), 'share.json']);
    return share?.token === token ? share : undefined;
  }
  deleteShare(owner: string, runId: string): void {
    const share = this.getOwnShare(owner, runId);
    if (!share) return;
    this.deleteRecord(['shares', `${digestKey(share.token)}.json`]);
    this.deleteRecord([...this.runPath(owner, runId), 'share.json']);
  }

  saveObservation(owner: string, observation: WebObservation): void {
    if (!Number.isSafeInteger(observation.sequence) || observation.sequence < 1) throw new Error('web_storage_invalid_observation_sequence');
    const directory = this.runPath(owner, observation.webRunId);
    this.saveRecord([...directory, 'observations', `${observation.sequence}.json`], observation, true);
  }
  listObservations(owner: string, runId: string): WebObservation[] {
    const directory = [...this.runPath(owner, runId), 'observations'];
    return bySequence(this.listRecords(directory).map(file => this.getRecord<WebObservation>([...directory, file])!));
  }
  getObservation(owner: string, runId: string, sequence?: number): WebObservation | undefined {
    if (sequence !== undefined) return this.getRecord([...this.runPath(owner, runId), 'observations', `${sequence}.json`]);
    return this.listObservations(owner, runId).at(-1);
  }
  getTaskSource(owner: string, runId: string, taskId: string, version?: string): WebTaskSource | undefined {
    return this.listObservations(owner, runId).reverse().flatMap(item => item.sources)
      .find(item => item.taskId === taskId && (version === undefined || item.taskVersion === version));
  }
  getCheckReceipt(owner: string, runId: string, receiptId: string): WebCheckReceipt | undefined {
    return this.listObservations(owner, runId).reverse().flatMap(item => item.checks).find(item => item.id === receiptId);
  }

  saveCommand(owner: string, runId: string, id: string, result: WebCommandResult): void {
    this.saveRecord([...this.runPath(owner, runId), 'commands', `${digestKey(id)}.json`], result);
  }
  getCommand(owner: string, runId: string, id: string): WebCommandResult | undefined {
    return this.getRecord([...this.runPath(owner, runId), 'commands', `${digestKey(id)}.json`]);
  }
  listCommands(owner: string, runId: string): WebCommandResult[] {
    const directory = [...this.runPath(owner, runId), 'commands'];
    return this.listRecords(directory).map(file => this.getRecord<WebCommandResult>([...directory, file])!);
  }
  /** One explanation per target and language; the approved evidence is written once and never replaced. */
  private explanationPath(owner: string, runId: string, key: string): string[] {
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new WebStorageError(400, '讲解标识无效。');
    return [...this.runPath(owner, runId), 'explanations', key];
  }
  saveExplanation(owner: string, key: string, explanation: WebExplanation): void {
    this.saveRecord([...this.explanationPath(owner, explanation.runId, key), 'record.json'], explanation);
  }
  getExplanation(owner: string, runId: string, key: string): WebExplanation | undefined {
    return this.getRecord([...this.explanationPath(owner, runId, key), 'record.json']);
  }
  listExplanations(owner: string, runId: string): { key: string; explanation: WebExplanation }[] {
    return this.listRecords([...this.runPath(owner, runId), 'explanations']).flatMap(key => {
      const explanation = /^[a-f0-9]{64}$/u.test(key) ? this.getExplanation(owner, runId, key) : undefined;
      return explanation ? [{ key, explanation }] : [];
    });
  }
  saveExplanationEvidence(owner: string, runId: string, key: string, evidence: unknown): void {
    this.saveRecord([...this.explanationPath(owner, runId, key), 'evidence.json'], evidence, true);
  }
  getExplanationEvidence(owner: string, runId: string, key: string): unknown {
    return this.getRecord([...this.explanationPath(owner, runId, key), 'evidence.json']);
  }
  deleteExplanation(owner: string, runId: string, key: string): void { this.deleteRecord(this.explanationPath(owner, runId, key)); }
  listEvents(owner: string, runId: string): WebEvent[] {
    const directory = [...this.runPath(owner, runId), 'events'];
    return bySequence(this.listRecords(directory).map(file => this.getRecord<WebEvent>([...directory, file])!));
  }
  getEvents(owner: string, runId: string): WebEvent[] { return this.listEvents(owner, runId); }
  /** The first and last stored event sequence, read from the record names alone. */
  eventRange(owner: string, runId: string): { first: number; last: number } {
    let first = 0, last = 0;
    for (const file of this.listRecords([...this.runPath(owner, runId), 'events'])) {
      if (!/^\d+\.json$/u.test(file)) continue;
      const sequence = Number.parseInt(file, 10);
      if (!first || sequence < first) first = sequence;
      if (sequence > last) last = sequence;
    }
    return { first, last };
  }
  /** Events after a sequence, oldest first, at most `limit`; for incremental readers such as the trajectory index. */
  listEventsAfter(owner: string, runId: string, after: number, limit: number): WebEvent[] {
    return this.recordsAfter<WebEvent>([...this.runPath(owner, runId), 'events'], after, limit);
  }
  saveAction(owner: string, runId: string, action: WebAgentAction): void {
    if (!Number.isSafeInteger(action.sequence) || action.sequence < 1) throw new Error('web_storage_invalid_action_sequence');
    this.saveRecord([...this.runPath(owner, runId), 'actions', `${action.sequence}.json`], action, true);
  }
  /** Agent actions after a sequence, oldest first, at most `limit`. */
  listActionsAfter(owner: string, runId: string, after: number, limit: number): WebAgentAction[] {
    return this.recordsAfter<WebAgentAction>([...this.runPath(owner, runId), 'actions'], after, limit);
  }
  listObservationsAfter(owner: string, runId: string, after: number, limit: number): WebObservation[] {
    return this.recordsAfter<WebObservation>([...this.runPath(owner, runId), 'observations'], after, limit);
  }
  /** Numbered records after `after` in sequence order; reading stops at a record that cannot be parsed, to be read again later. */
  private recordsAfter<T>(directory: string[], after: number, limit: number): T[] {
    const sequences = this.listRecords(directory).flatMap(file => /^\d+\.json$/u.test(file) ? [Number.parseInt(file, 10)] : [])
      .filter(sequence => sequence > after).sort((a, b) => a - b).slice(0, limit);
    const records: T[] = [];
    for (const sequence of sequences) {
      let record: T | undefined;
      try { record = this.getRecord<T>([...directory, `${sequence}.json`]); } catch { break; }
      if (record === undefined) break;
      records.push(record);
    }
    return records;
  }

  archiveRun(owner: string, run: WebRun, catalogDigest?: string): WebArchive {
    if (!this.getRun(owner, run.id)) throw new WebStorageError(404, '运行不存在或不属于当前会话。');
    this.saveRun(owner, run);
    const observations = this.listObservations(owner, run.id), events = this.listEvents(owner, run.id);
    const unique = <T>(items: T[]) => [...new Map(items.map(item => [mathDigest(encoded(item)), item])).values()];
    const sources = unique(observations.flatMap(item => item.sources)), checks = unique(observations.flatMap(item => item.checks));
    const last = observations.at(-1);
    const coverage: WebArchive['coverage'] = {
      events: events.every((event, index) => event.sequence === index + 1) ? 'complete' : 'partial',
      sources: last?.coverage.sources ?? 'partial', checks: last?.coverage.checks ?? 'partial',
    };
    const identity = { id: crypto.randomUUID(), runId: run.id, createdAt: new Date().toISOString(),
      evidence: 'recorded-not-replayed' as const, requiresFreshCheck: true as const,
      sources: sources.length, checks: checks.length, coverage, ...(catalogDigest ? { catalogDigest } : {}) };
    const payload = publicRecord({ schema: 'theorem-os.web-archive.v1' as const, run, observations, sources, checks, events,
      commands: this.listCommands(owner, run.id) });
    const summary: WebArchive = { ...identity, digest: mathDigest(encoded({ ...payload, identity })) };
    this.saveRecord([...this.runPath(owner, run.id), 'archives', `${summary.id}.json`], { ...payload, summary }, true);
    return summary;
  }
  getArchive(owner: string, runId: string, archiveId: string): StoredWebArchive | undefined {
    if (!/^[a-f0-9-]{36}$/u.test(archiveId)) return undefined;
    const stored = this.getRecord<StoredWebArchive>([...this.runPath(owner, runId), 'archives', `${archiveId}.json`]);
    if (stored) {
      const { summary, ...payload } = stored, { digest, ...identity } = summary;
      if (mathDigest(encoded({ ...payload, identity })) !== digest) throw new Error('web_archive_identity_changed');
    }
    return stored;
  }
}
