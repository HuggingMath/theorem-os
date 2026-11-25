import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalMathJson, mathDigest, syncMathDirectory, writeMathFrozen } from '../../src/math/mathRuntimeIo';
import type { WebArchive, WebCheckReceipt, WebCommandResult, WebObservation, WebTaskSource } from './collaboration';
import type { WebAccountIdentity, WebAgentAction, WebEvent, WebExplanation, WebRun, WorkerExplanationCheckpoint } from './shared';
import { webRunEventLimit } from './shared';
import type { WebShareSnapshot } from './share';
import { archiveObservationCompactor, compactObservation, hydrateArchiveObservation, hydrateObservation,
  type ArchivedWebObservation, type CompactWebObservation, type CompactWebTaskSource } from './observationSources';
import { projectStoredObservationChecks } from './observationChecks';
import { paperDraftActive, type WebPaperDraftJob } from './paperTypes';

export type WebCreation = { schema: 'theorem-os.web-creation.v1'; requestId: string; digest: string };
type StoredRun = { owner: string; run: WebRun; creation?: WebCreation };
type RunRecord = StoredRun & { observationSequence?: number };
type ObservationRecord = WebObservation | CompactWebObservation;
type StoredExplanationCheckpoint = { binding: string; checkpoint: WorkerExplanationCheckpoint };

export type StoredWebSession = { id: string; csrf: string; touchedAt: number; account?: WebAccountIdentity & { id: string }; passwordResetUntil?: number };
type ArchiveEvidence = {
  run: WebRun;
  observations: WebObservation[];
  sources: WebTaskSource[];
};
type ArchiveRecords = {
  summary: WebArchive;
  checks: WebCheckReceipt[];
  events: WebEvent[];
  /** Older saved archives did not contain the separately stored Agent actions. */
  actions?: WebAgentAction[];
};
type StoredWebArchiveV1 = ArchiveRecords & ArchiveEvidence & { schema: 'theorem-os.web-archive.v1'; commands: WebCommandResult[] };
export type StoredWebArchiveV2 = ArchiveRecords & {
  schema: 'theorem-os.web-archive.v2';
  run: Omit<WebRun, 'observation'> & { observation?: ArchivedWebObservation };
  observations: ArchivedWebObservation[];
  sources: CompactWebTaskSource[];
  sourceBlobs: Record<string, string>;
  commands: (Omit<WebCommandResult, 'observation'> & { observation?: ArchivedWebObservation })[];
};
export type StoredWebArchive = StoredWebArchiveV1 | StoredWebArchiveV2;

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
const immutableRecordChanged = 'web_storage_immutable_record_changed';
const credentialFields = new Set(['apiKey', 'api_key', 'access_token', 'refresh_token', 'authorization']);
/** Records accept visible run data only. Credential objects never become restart state. */
const publicRecord = <T>(value: T): T => JSON.parse(JSON.stringify(value,
  (key, item) => credentialFields.has(key) ? undefined : item));

/** All retained process evidence, with coverage of the recording rather than a claim of fresh proof acceptance. */
export function webArchive(run: WebRun, records: { observations: WebObservation[]; events: WebEvent[];
  actions: WebAgentAction[]; commands: WebCommandResult[] }, catalogDigest?: string): StoredWebArchiveV2 {
  const { events, actions, commands } = records;
  const sourceBlobs: Record<string, string> = {};
  const referenceSources = archiveObservationCompactor((digest, source) => { sourceBlobs[digest] = source; });
  const compact = (frame: WebObservation) => referenceSources(projectStoredObservationChecks(frame));
  const observations = records.observations.map(compact);
  const { observation, ...runFields } = run;
  const archivedRun = { ...runFields, ...(observation ? { observation: compact(observation) } : {}) };
  const archivedCommands = commands.map(({ observation: recorded, ...command }) =>
    ({ ...command, ...(recorded ? { observation: compact(recorded) } : {}) }));
  const unique = <T>(items: T[]) => [...new Map(items.map(item => [mathDigest(encoded(item)), item])).values()];
  const sources = unique(observations.flatMap(item => item.sources)), checks = unique(observations.flatMap(item => item.checks));
  const complete = (items: { sequence: number }[], expected: number) => items.length === expected
    && items.every((item, index) => item.sequence === index + 1);
  const coverage: WebArchive['coverage'] = {
    events: complete(events, Math.max(run.events.at(-1)?.sequence ?? 0, events.at(-1)?.sequence ?? 0)) ? 'complete' : 'partial',
    observations: complete(observations, Math.max(run.observation?.sequence ?? 0, observations.at(-1)?.sequence ?? 0)) ? 'complete' : 'partial',
    actions: complete(actions, run.actions?.count ?? actions.length) && !run.actions?.dropped ? 'complete' : 'partial',
    commands: 'recorded',
    sources: observations.length && observations.every(item => item.coverage.sources === 'recorded') ? 'recorded' : 'partial',
    checks: observations.length && observations.every(item => item.coverage.checks === 'recorded') ? 'recorded' : 'partial',
  };
  const identity = { id: crypto.randomUUID(), runId: run.id, createdAt: new Date().toISOString(),
    evidence: 'recorded-not-replayed' as const, requiresFreshCheck: true as const,
    events: events.length, observations: observations.length, actions: actions.length, commands: commands.length,
    droppedActions: run.actions?.dropped ?? 0, sources: sources.length, checks: checks.length, coverage,
    ...(catalogDigest ? { catalogDigest } : {}) };
  const payload = publicRecord({
    schema: 'theorem-os.web-archive.v2' as const, run: archivedRun, observations, sources, sourceBlobs, checks, events, actions,
    commands: archivedCommands,
  });
  return { ...payload, summary: { ...identity, digest: mathDigest(encoded({ ...payload, identity })) } };
}

/** Consumers that need inline observations can read either archive format. */
export function readWebArchiveObservations(archive: StoredWebArchive): Pick<ArchiveEvidence, 'run' | 'observations'> {
  if (archive.schema === 'theorem-os.web-archive.v1') return { run: archive.run, observations: archive.observations };
  const { observation, ...run } = archive.run;
  const hydrate = (frame: ArchivedWebObservation) => hydrateArchiveObservation(frame, digest => archive.sourceBlobs[digest]);
  return { run: { ...run, ...(observation ? { observation: hydrate(observation) } : {}) },
    observations: archive.observations.map(hydrate) };
}

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
  /** Exclusively create a record; account provisioning must never replace another process's credentials. */
  createRecord(segments: string[], value: unknown): boolean {
    const key = this.key(segments), text = encoded(publicRecord(value));
    if (!this.root) {
      if (this.memory.has(key)) return false;
      this.memory.set(key, text); return true;
    }
    const file = path.join(this.root, key);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let fd: number;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncMathDirectory(path.dirname(file));
    return true;
  }
  saveRecord(segments: string[], value: unknown, immutable = false): void {
    const key = this.key(segments), text = encoded(publicRecord(value));
    if (!this.root) {
      const previous = this.memory.get(key);
      if (immutable && previous !== undefined && previous !== text) throw new Error(immutableRecordChanged);
      this.memory.set(key, text); return;
    }
    const file = path.join(this.root, key);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (immutable) {
      if (fs.existsSync(file)) {
        if (fs.readFileSync(file, 'utf8') !== text) throw new Error(immutableRecordChanged);
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
    return this.listRecords(['sessions']).filter(file => /^[a-f0-9]{64}\.json$/u.test(file))
      .map(file => this.getRecord<StoredWebSession>(['sessions', file])!);
  }
  deleteSession(id: string): void { this.deleteRecord(['sessions', `${digestKey(id)}.json`]); }

  saveRun(owner: string, run: WebRun, creation?: WebCreation): void {
    const directory = this.runPath(owner, run.id);
    this.saveRecord([...this.ownerPath(owner), 'owner.json'], { owner }, true);
    if (run.observation) this.saveObservation(owner, run.observation);
    for (const event of run.events) this.saveRecord([...directory, 'events', `${event.sequence}.json`], event, true);
    creation ??= this.getRecord<StoredRun>([...directory, 'run.json'])?.creation;
    const { observation, ...summary } = run;
    this.saveRecord([...directory, 'run.json'], { owner, run: summary,
      ...(observation ? { observationSequence: observation.sequence } : {}), ...(creation ? { creation } : {}) });
  }
  private readRun(directory: string[]): StoredRun | undefined {
    const stored = this.getRecord<RunRecord>([...directory, 'run.json']);
    if (!stored) return;
    const { observationSequence, ...result } = stored;
    if (observationSequence !== undefined) {
      const observation = this.readObservation(directory, observationSequence);
      if (observation) result.run.observation = observation;
    }
    return result;
  }
  getRun(owner: string, id: string): WebRun | undefined {
    return this.readRun(this.runPath(owner, id))?.run;
  }
  loadRuns(): StoredRun[] {
    return this.listRecords(['owners']).flatMap(directory => this.listRecords(['owners', directory, 'runs'])
      .map(id => {
        const location = ['owners', directory, 'runs', id];
        const stored = this.readRun(location);
        if (!stored) return;
        // An event may have reached disk just before the summary was replaced.
        const events = stored.run.events;
        for (let sequence = (events.at(-1)?.sequence ?? 0) + 1; ; sequence++) {
          const event = this.getRecord<WebEvent>([...location, 'events', `${sequence}.json`]);
          if (!event) break;
          events.push(event);
          if (events.length > webRunEventLimit) events.shift();
        }
        return stored;
      })
      .filter((item): item is StoredRun => Boolean(item)))
      .sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt));
  }
  /** Evidence files can reach disk before their counters and pointers in run.json. */
  recoverRunTail(owner: string, run: WebRun): { observation?: WebObservation; actionCount?: number } {
    const directory = this.runPath(owner, run.id);
    const frame = this.latestWrittenRecord<ObservationRecord>([...directory, 'observations'],
      run.solverAttempt?.sequence ?? run.observation?.sequence ?? 0);
    const action = this.latestWrittenRecord<WebAgentAction>([...directory, 'actions'], run.actions?.count ?? 0);
    return { ...(frame ? { observation: this.hydrateObservations(directory, [frame])[0] } : {}),
      ...(action ? { actionCount: action.sequence } : {}) };
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

  getPaperDraft(owner: string, runId: string, key: string): WebPaperDraftJob | undefined {
    return this.getRecord([...this.runPath(owner, runId), 'papers', `${key}.json`]);
  }
  savePaperDraft(owner: string, runId: string, key: string, draft: WebPaperDraftJob): void {
    this.saveRecord([...this.runPath(owner, runId), 'papers', `${key}.json`], draft);
  }

  interruptPaperDrafts(): void {
    for (const owner of this.listRecords(['owners'])) {
      const runs = ['owners', owner, 'runs'];
      for (const run of this.listRecords(runs)) {
        const papers = [...runs, run, 'papers'];
        for (const file of this.listRecords(papers).filter(file => /^[a-f0-9]{64}\.json$/u.test(file))) {
          const location = [...papers, file];
          const job = this.getRecord<WebPaperDraftJob>(location);
          if (job && paperDraftActive(job.status)) this.saveRecord(location, { ...job, status: 'error', error: 'interrupted' });
        }
      }
    }
  }

  saveObservation(owner: string, observation: WebObservation): void {
    if (!Number.isSafeInteger(observation.sequence) || observation.sequence < 1) throw new Error('web_storage_invalid_observation_sequence');
    const directory = this.runPath(owner, observation.webRunId);
    const recordPath = [...directory, 'observations', `${observation.sequence}.json`];
    const existing = this.getRecord<ObservationRecord>(recordPath);
    const inline = existing?.sources.some(source => typeof source.source === 'string');
    const record = inline ? observation : compactObservation(observation, (digest, source) => {
      const segments = [...directory, 'source-blobs', `${digest}.json`], key = this.key(segments);
      if (!(this.root ? fs.existsSync(path.join(this.root, key)) : this.memory.has(key))) this.saveRecord(segments, source, true);
    });
    try { this.saveRecord(recordPath, record, true); }
    catch (error) {
      // The read projection can normalize legacy receipts without changing the frozen observation.
      if (!existing || !(error instanceof Error) || error.message !== immutableRecordChanged ||
          encoded(this.hydrateObservations(directory, [existing])[0]) !== encoded(publicRecord(observation))) throw error;
    }
  }
  private hydrateObservations(directory: string[], records: ObservationRecord[]): WebObservation[] {
    const sources = new Map<string, string>();
    return records.map(record => projectStoredObservationChecks(hydrateObservation(record, digest => {
      const cached = sources.get(digest);
      if (cached !== undefined) return cached;
      const text = this.getRecord<string>([...directory, 'source-blobs', `${digest}.json`]);
      if (text !== undefined) sources.set(digest, text);
      return text;
    })));
  }
  private readObservation(directory: string[], sequence: number): WebObservation | undefined {
    const observation = this.getRecord<ObservationRecord>([...directory, 'observations', `${sequence}.json`]);
    return observation && this.hydrateObservations(directory, [observation])[0];
  }
  listObservations(owner: string, runId: string): WebObservation[] {
    return this.listObservationsAfter(owner, runId, 0, Number.MAX_SAFE_INTEGER);
  }
  getObservation(owner: string, runId: string, sequence?: number): WebObservation | undefined {
    const directory = this.runPath(owner, runId);
    if (sequence !== undefined) return sequence ? this.readObservation(directory, sequence) : undefined;
    const latest = this.latestWrittenRecord<ObservationRecord>([...directory, 'observations'], 0);
    return latest && this.hydrateObservations(directory, [latest])[0];
  }
  getTaskSource(owner: string, runId: string, taskId: string, version?: string, commit?: string): WebTaskSource | undefined {
    return this.listObservations(owner, runId).reverse().flatMap(item => item.sources)
      .find(item => item.taskId === taskId && (version === undefined || item.taskVersion === version) && (commit === undefined || item.commit === commit));
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
  deleteExplanationEvidence(owner: string, runId: string, key: string): void {
    this.deleteRecord([...this.explanationPath(owner, runId, key), 'evidence.json']);
  }
  saveExplanationCheckpoint(owner: string, runId: string, key: string, checkpoint: StoredExplanationCheckpoint): void {
    this.saveRecord([...this.explanationPath(owner, runId, key), 'checkpoint.json'], checkpoint);
  }
  getExplanationCheckpoint(owner: string, runId: string, key: string): StoredExplanationCheckpoint | undefined {
    return this.getRecord([...this.explanationPath(owner, runId, key), 'checkpoint.json']);
  }
  deleteExplanationCheckpoint(owner: string, runId: string, key: string): void {
    this.deleteRecord([...this.explanationPath(owner, runId, key), 'checkpoint.json']);
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
    const directory = this.runPath(owner, runId);
    return this.hydrateObservations(directory, this.recordsAfter<ObservationRecord>([...directory, 'observations'], after, limit));
  }
  /** Numbered records after `after` in sequence order; reading stops at a record that cannot be parsed, to be read again later. */
  listRecordsAfter<T>(directory: string[], after: number, limit: number): T[] { return this.recordsAfter<T>(directory, after, limit); }
  private numberedSequences(directory: string[], after: number): number[] {
    return this.listRecords(directory).flatMap(file => /^\d+\.json$/u.test(file) ? [Number.parseInt(file, 10)] : [])
      .filter(sequence => sequence > after);
  }
  private latestWrittenRecord<T extends { sequence: number }>(directory: string[], after: number): T | undefined {
    for (const sequence of this.numberedSequences(directory, after).sort((a, b) => b - a)) {
      try {
        const record = this.getRecord<T>([...directory, `${sequence}.json`]);
        if (record?.sequence === sequence) return record;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // A crash during exclusive file creation can leave a truncated final record.
      }
    }
  }
  private recordsAfter<T>(directory: string[], after: number, limit: number): T[] {
    const sequences = this.numberedSequences(directory, after).sort((a, b) => a - b).slice(0, limit);
    const records: T[] = [];
    for (const sequence of sequences) {
      let record: T | undefined;
      try { record = this.getRecord<T>([...directory, `${sequence}.json`]); } catch { break; }
      if (record === undefined) break;
      records.push(record);
    }
    return records;
  }

  exportRun(owner: string, run: WebRun, catalogDigest?: string): StoredWebArchiveV2 {
    if (!this.getRun(owner, run.id)) throw new WebStorageError(404, '运行不存在或不属于当前会话。');
    return webArchive(run, { observations: this.listObservations(owner, run.id), events: this.listEvents(owner, run.id),
      actions: this.listActionsAfter(owner, run.id, 0, Number.MAX_SAFE_INTEGER), commands: this.listCommands(owner, run.id) }, catalogDigest);
  }
  archiveRun(owner: string, run: WebRun, catalogDigest?: string): WebArchive {
    if (!this.getRun(owner, run.id)) throw new WebStorageError(404, '运行不存在或不属于当前会话。');
    this.saveRun(owner, run);
    const bundle = this.exportRun(owner, run, catalogDigest);
    this.saveRecord([...this.runPath(owner, run.id), 'archives', `${bundle.summary.id}.json`], bundle, true);
    return bundle.summary;
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
