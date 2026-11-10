import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { enrichArchiveProcesses, extractProcessEvidence } from '../scripts/enrich-archive-process';
import { importMathCampaign } from '../scripts/import-math-campaign';

const commit = 'a'.repeat(40), projected = 'b'.repeat(40), integrated = 'c'.repeat(40);
const source = 'theorem add_zero (n : Nat) : n + 0 = n := by simp\n';
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const sourceHash = hash(source);
function check(receiptId = 'lean-task', targetCommit = projected) {
  return { commit, verification: { status: 'kernel_verified', checkedAt: 1793604213709, targetCommit,
    results: [{ status: 'kernel_verified', receiptId, proofPath: 'Submission.lean', proofHash: sourceHash,
      targetCommit, checkedAt: 1793604213705 }] } };
}
function state() {
  return { runId: 'run-recorded', problem: { projectRelative: 'generated/problem' },
    cooperation: { tasks: [{ task: { id: 'goal-1' }, proof: check(), integratedCheck: check('lean-integrated', integrated) }],
      deliveries: [{ id: 'delivery-1', createdAt: 1793604260946, kind: 'proof', status: 'verified',
        taskId: 'goal-1', producer: 'worker-1', commit, summary: 'The fixed declaration was checked.' }] },
    workers: [{ id: 'worker-1', role: 'researcher', sessionTaskId: 'goal-1', check: check() }] };
}

describe('public archived process evidence', () => {
  it('deduplicates copied receipts while retaining separate checks and original scope', () => {
    const snapshot: any = state();
    snapshot.check = check();
    snapshot.workers.push({ id: 'solver', role: 'lead', check: check() });
    const before = structuredClone(snapshot), evidence = extractProcessEvidence(snapshot);
    expect(evidence.checks).toHaveLength(3);
    expect(evidence.checks.filter(item => item.scope === 'task')).toHaveLength(2);
    expect(evidence.checks.find(item => item.scope === 'original')).not.toHaveProperty('taskId');
    expect(evidence.checks.map(item => item.receiptIds)).toContainEqual(['lean-integrated']);
    expect(snapshot).toEqual(before);
  });

  it('attaches the immutable checked projection only after its source matches the receipt hash', () => {
    const seen: string[] = [];
    const evidence = extractProcessEvidence(state(), (revision, file) => {
      seen.push(`${revision}:${file}`);
      return revision === projected || revision === integrated ? source : 'different unchecked candidate';
    });
    expect(evidence.checks.every(item => item.sourceDigest === sourceHash)).toBe(true);
    expect(evidence.sources).toEqual({ [sourceHash]: { path: 'Submission.lean', code: source, sha256: sourceHash } });
    expect(seen).toContain(`${projected}:Submission.lean`);
    expect(evidence.checks[0].commit).toBe(projected);
    const mismatch = extractProcessEvidence(state(), () => 'different unchecked candidate');
    expect(mismatch.sources).toEqual({});
    expect(mismatch.checks.every(item => item.sourceDigest === undefined)).toBe(true);
  });

  it('binds a retained worker check to its receipt task after the worker takes another assignment', () => {
    const snapshot: any = state();
    snapshot.workers[0].sessionTaskId = 'next-unrelated-task';
    const evidence = extractProcessEvidence(snapshot);
    expect(evidence.checks).toHaveLength(2);
    expect(evidence.checks.every(item => item.taskId === 'goal-1')).toBe(true);
    expect(evidence.checks.some(item => item.taskId === 'next-unrelated-task')).toBe(false);
  });

  it('preserves failure diagnostics, redacts private text, and drops internal marker lines', () => {
    const snapshot: any = state();
    snapshot.cooperation.tasks = [{ task: { id: 'goal-1' }, proof: { commit, verification: {
      status: 'failed', checkedAt: 1793604213709, targetCommit: commit,
      results: [{ status: 'failed', stderrPreview: 'Submission.lean:2:3: error: tactic failed\n/home/private/proof.lean sk-fixture-secret-key-123456789',
        stdoutPreview: 'DS_DECL_REFERENCES_private:large internal index\nDEEPSCIENTIST_DECL_BEGIN_marker\nDemo.goal : True\nDEEPSCIENTIST_DECL_END_marker' }],
    } } }];
    snapshot.workers = [];
    snapshot.cooperation.deliveries[0].summary = 'A receipt in /tmp/private/check.json; sk-fixture-secret-key-123456789';
    const evidence = extractProcessEvidence(snapshot), encoded = JSON.stringify(evidence);
    expect(evidence.checks[0]).toMatchObject({ status: 'failed', receiptIds: [], scope: 'task' });
    expect(evidence.checks[0].diagnostics).toContain('tactic failed');
    expect(evidence.checks[0].diagnostics).toContain('Demo.goal : True');
    expect(encoded).toContain('[local file]');
    expect(encoded).toContain('[redacted key]');
    for (const privateText of ['/home/private', '/tmp/private', 'sk-fixture', 'DS_DECL_REFERENCES_', 'DEEPSCIENTIST_DECL_BEGIN'])
      expect(encoded).not.toContain(privateText);
  });

  it('exports recorded delivery identity and role without importing private dialogue', () => {
    const snapshot: any = state(); snapshot.privateDialogue = 'unpublished worker conversation';
    const evidence = extractProcessEvidence(snapshot);
    expect(evidence.deliveries).toEqual([{ id: 'delivery-1', at: '2026-11-02T07:24:20.946Z', kind: 'proof',
      status: 'verified', taskId: 'goal-1', workerId: 'worker-1', role: 'researcher', commit,
      summary: 'The fixed declaration was checked.' }]);
    expect(JSON.stringify(evidence)).not.toContain('unpublished worker conversation');
  });

  it('does not invent timestamps, checks from attempt counts, or source links for redacted bytes', () => {
    const snapshot: any = state();
    snapshot.cooperation.tasks[0].attempts = 6;
    delete snapshot.cooperation.tasks[0].proof.verification.checkedAt;
    delete snapshot.cooperation.tasks[0].proof.verification.results[0].checkedAt;
    snapshot.workers = [];
    const evidence = extractProcessEvidence(snapshot);
    expect(evidence.checks).toHaveLength(1);
    const privateSource = '-- /home/private/notes.md\ntheorem demo : True := by trivial\n';
    snapshot.cooperation.tasks[0].integratedCheck.verification.results[0].proofHash = hash(privateSource);
    const protectedEvidence = extractProcessEvidence(snapshot, () => privateSource);
    expect(protectedEvidence.sources).toEqual({});
    expect(protectedEvidence.checks[0]).not.toHaveProperty('sourceDigest');
  });
});

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
describe('process archive enrichment', () => {
  it('reads a hash-bound referenced snapshot and updates only process content and its manifest checksum', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-process-evidence-')); temporary.push(directory);
    const archive = path.join(directory, 'campaign'), destination = path.join(directory, 'published');
    fs.mkdirSync(path.join(archive, 'trajectories/problems/Example'), { recursive: true });
    fs.mkdirSync(path.join(archive, 'trajectories/objects'), { recursive: true });
    fs.mkdirSync(path.join(destination, 'Example'), { recursive: true });
    const snapshot = state(), bytes = Buffer.from(JSON.stringify(snapshot));
    fs.writeFileSync(path.join(archive, 'trajectories/objects/state.gz'), gzipSync(bytes));
    fs.writeFileSync(path.join(archive, 'trajectories/problems/Example/index.json'), JSON.stringify({
      runs: [{ runId: snapshot.runId, stateSnapshot: { object: 'objects/state.gz', sha256: hash(bytes) } }], repositories: {},
    }));
    const preserved = 'frozen proof and acceptance evidence';
    for (const name of ['Submission.lean', 'verification.json']) fs.writeFileSync(path.join(destination, 'Example', name), preserved);
    fs.writeFileSync(path.join(destination, 'Example/process.json'), JSON.stringify({ runs: [{ runId: snapshot.runId, tasks: [], events: [] }] }));
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ records: [{ directory: 'Example', files: {
      'Submission.lean': hash(preserved), 'verification.json': hash(preserved), 'process.json': 'old',
    } }] }));
    const totals = enrichArchiveProcesses(archive, destination);
    const processBytes = fs.readFileSync(path.join(destination, 'Example/process.json'));
    const process = JSON.parse(processBytes.toString()), manifest = JSON.parse(fs.readFileSync(path.join(destination, 'manifest.json'), 'utf8'));
    expect(totals).toMatchObject({ problems: 1, runs: 1, checks: 2, deliveries: 1, sources: 0 });
    expect(process.runs[0].checks).toHaveLength(2);
    expect(manifest.records[0].files['process.json']).toBe(hash(processBytes));
    for (const name of ['Submission.lean', 'verification.json']) {
      expect(fs.readFileSync(path.join(destination, 'Example', name), 'utf8')).toBe(preserved);
      expect(manifest.records[0].files[name]).toBe(hash(preserved));
    }
  });

  it('keeps checked evidence in a normal import and replaces a stale accepted-run snapshot with current native evidence', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-process-import-')); temporary.push(directory);
    const campaign = path.join(directory, 'campaign'), destination = path.join(directory, 'published');
    const repository = path.join(directory, 'proof-repository'), project = 'generated/problem';
    fs.mkdirSync(path.join(repository, project), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init');
    const sources = [source, 'theorem add_zero (n : Nat) : n + 0 = n := by omega\n',
      'theorem add_zero (n : Nat) : n + 0 = n := by exact Nat.add_zero n\n'];
    const revisions = sources.map((code, index) => {
      fs.writeFileSync(path.join(repository, project, 'Submission.lean'), code);
      fs.writeFileSync(path.join(repository, project, 'Challenge.lean'), 'theorem add_zero (n : Nat) : n + 0 = n := by sorry\n');
      git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', `Checked version ${index}`);
      return git('rev-parse', 'HEAD');
    });
    const fixtureState = (runId: string, index: number, at: number): any => {
      const snapshot: any = state();
      snapshot.runId = runId; snapshot.phase = 'finished'; snapshot.solveStartedAt = at - 1000; snapshot.solveFinishedAt = at;
      snapshot.model = 'fixture'; snapshot.workerCount = 1;
      snapshot.problem.targets = [{ theoremName: 'Demo.add_zero' }];
      snapshot.cooperation.tasks = [];
      snapshot.cooperation.deliveries[0].id = `delivery-${index}`;
      snapshot.cooperation.deliveries[0].commit = revisions[index];
      snapshot.workers = [];
      snapshot.check = check(`lean-${index}`, revisions[index]); snapshot.check.commit = revisions[index]; snapshot.check.passed = true;
      snapshot.check.verification.checkedAt = at;
      snapshot.check.verification.results[0].proofHash = hash(sources[index]);
      return snapshot;
    };
    const oldRun = fixtureState('historical-run', 0, 1793604000000);
    const staleAccepted = fixtureState('accepted-run', 1, 1793604100000);
    const liveAccepted = fixtureState('accepted-run', 2, 1793604200000);
    const resultPath = path.join(campaign, 'tasks/Example/result.json');
    fs.mkdirSync(resultPath + '.runtime', { recursive: true });
    fs.writeFileSync(resultPath + '.runtime/state.json', JSON.stringify(liveAccepted));
    fs.writeFileSync(resultPath, JSON.stringify({ runId: 'accepted-run', status: 'evaluated_passed',
      solution_commit: revisions[2], evaluator: { status: 'passed', result: { exitCode: 0, stdout: 'accepted' } } }));
    fs.mkdirSync(path.join(campaign, 'trajectories/problems/Example'), { recursive: true });
    fs.mkdirSync(path.join(campaign, 'trajectories/objects'), { recursive: true });
    const runs = [oldRun, staleAccepted].map((snapshot, index) => {
      const bytes = Buffer.from(JSON.stringify(snapshot)), object = `objects/state-${index}.gz`;
      fs.writeFileSync(path.join(campaign, 'trajectories', object), gzipSync(bytes));
      return { runId: snapshot.runId, state: index === 1 ? resultPath + '.runtime/state.json' : path.join(campaign, 'historical/result.json.runtime/state.json'),
        stateSnapshot: { object, sha256: hash(bytes) } };
    });
    fs.writeFileSync(path.join(campaign, 'trajectories/problems/Example/index.json'), JSON.stringify({
      runs, repositories: { proof: { archive: path.join(repository, '.git') } },
    }));
    fs.writeFileSync(path.join(campaign, 'trajectories/index.json'), JSON.stringify({ files: {} }));
    fs.writeFileSync(path.join(campaign, 'campaign-state.json'), JSON.stringify({ jobs: [{ id: 'Example', status: 'accepted',
      result: resultPath, runId: 'accepted-run', solutionCommit: revisions[2] }] }));
    importMathCampaign(campaign, destination);
    const process = JSON.parse(fs.readFileSync(path.join(destination, 'Example/process.json'), 'utf8'));
    expect(process.runs).toHaveLength(2);
    const current = process.runs.find((run: any) => run.runId === 'accepted-run');
    expect(current.checks[0]).toMatchObject({ scope: 'original', commit: revisions[2], receiptIds: ['lean-2'], sourceDigest: hash(sources[2]) });
    expect(current.deliveries.map((delivery: any) => delivery.id)).toEqual(['delivery-2']);
    expect(Object.keys(process.sources).sort()).toEqual([hash(sources[0]), hash(sources[2])].sort());
    for (const run of process.runs) for (const checked of run.checks)
      expect(process.sources[checked.sourceDigest]?.sha256).toBe(checked.sourceDigest);
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'manifest.json'), 'utf8'));
    expect(manifest.records[0].files['process.json']).toBe(hash(fs.readFileSync(path.join(destination, 'Example/process.json'))));

    // A new unsuccessful run must not hide the earlier hash-bound acceptance or regress its edited presentation.
    manifest.records[0].title = 'Edited problem title';
    manifest.records[0].en.area = 'Edited research field';
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest));
    const archiveObject = (name: string, value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value)), object = `objects/${name}.gz`;
      fs.writeFileSync(path.join(campaign, 'trajectories', object), gzipSync(bytes));
      return { object, sha256: hash(bytes) };
    };
    const acceptedResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    runs[1].stateSnapshot = archiveObject('final-accepted-state', liveAccepted);
    const resultReference = archiveObject('accepted-result', acceptedResult);
    fs.writeFileSync(path.join(campaign, 'trajectories/index.json'), JSON.stringify({ files: { [resultPath]: { versions: [resultReference] } } }));
    fs.writeFileSync(path.join(campaign, 'trajectories/problems/Example/index.json'), JSON.stringify({
      runs, repositories: { proof: { archive: path.join(repository, '.git') } },
    }));
    fs.writeFileSync(path.join(campaign, 'campaign-state.json'), JSON.stringify({ jobs: [{ id: 'Example', status: 'unsolved',
      result: path.join(campaign, 'later-failed-result.json'), runId: 'later-failed-run', solutionCommit: null }] }));
    fs.writeFileSync(resultPath, JSON.stringify({ runId: 'accepted-run', status: 'evaluated_failed' }));
    fs.writeFileSync(resultPath + '.runtime/state.json', JSON.stringify({ runId: 'accepted-run', check: { passed: false } }));
    importMathCampaign(campaign, destination);
    const historical = JSON.parse(fs.readFileSync(path.join(destination, 'manifest.json'), 'utf8'));
    expect(historical.records).toHaveLength(1);
    expect(historical.records[0]).toMatchObject({ title: 'Edited problem title', en: { area: 'Edited research field' },
      campaign: { runId: 'accepted-run', proofCommit: revisions[2], proofSha256: hash(sources[2]) } });
    const historicalProcess = JSON.parse(fs.readFileSync(path.join(destination, 'Example/process.json'), 'utf8'));
    expect(historicalProcess.runs.find((run: any) => run.runId === 'accepted-run').resultStatus).toBe('evaluated_passed');
    fs.writeFileSync(path.join(campaign, 'trajectories', resultReference.object), gzipSync(Buffer.from('{}')));
    expect(() => importMathCampaign(campaign, destination)).toThrow('Checkpoint hash mismatch');
  });
});
