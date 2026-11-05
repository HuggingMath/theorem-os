import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AUTO_LIBRARY_RECORD_SCHEMA, autoLibraryLiveUsage, parseAutoLibraryRecord } from '../src/math/autoLibrary';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { temporaryDirectory } from './helpers/files';

let directory: string;
beforeEach(() => { directory = temporaryDirectory('auto-library-live-'); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
const file = 'Submission/Library/Auto/Truth.lean';
const source = 'namespace TheoremOS.Auto.Truth\ntheorem truth : True := trivial\nend TheoremOS.Auto.Truth\n';
const entry = () => parseAutoLibraryRecord({ schema: AUTO_LIBRARY_RECORD_SCHEMA, name: 'Truth', file, source,
  sourceDigest: mathDigest(source), summary: 'Truth', sources: [], theorems: ['TheoremOS.Auto.Truth.truth'], requires: [], visible: [],
  environment: { id: 'standard', digest: 'a'.repeat(64) },
  trigger: { challengeId: 'fixture', challengeDigest: 'b'.repeat(64), taskDigest: 'c'.repeat(64) },
  cost: { plannerTokens: 0, proverTokens: 0, wallMs: 1, rounds: 1 }, planner: { model: 'preset', effort: 'max' },
  prover: { runId: 'fixture', commit: 'd'.repeat(40), model: 'preset', dropped: [] },
  buildId: '0f2d05e8-5d78-402b-b74e-3f0936f8e8b2', buildDigest: 'e'.repeat(64), publishedAt: '2026-11-02T12:00:00.000Z' });
const draftSource = 'import Submission.Library.Auto.Truth\ntheorem target : True := TheoremOS.Auto.Truth.truth\n';
function fixture() {
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), { source: 'theorem target : True := by sorry\n', task: 'Fixture.',
    libraryPack: { schema: LIBRARY_PACK_SCHEMA, modules: [{ file, source,
      origin: { kind: 'run', runId: 'fixture', commit: 'd'.repeat(40), file: 'Submission.lean' } }] } });
  const worker = path.join(directory, 'worker');
  fs.cpSync(receipt.projectRoot, path.join(worker, 'generated/problem'), { recursive: true });
  fs.writeFileSync(path.join(worker, 'generated/problem/Submission.lean'), draftSource);
  fs.writeFileSync(path.join(receipt.projectRoot, 'Submission.lean'), draftSource);
  const git = (args: string[]) => execFileSync('git', args, { cwd: receipt.workspaceRoot, encoding: 'utf8' }).trim();
  git(['add', '--', 'generated/problem/Submission.lean']);
  git(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
    'commit', '--quiet', '--no-gpg-sign', '-m', 'Disposable canonical fixture']);
  const state = { runId: 'live-fixture', worktree: receipt.workspaceRoot,
    problem: { projectRelative: 'generated/problem', baseCommit: receipt.baseCommit, frozenFiles: receipt.libraryPack!.files },
    workers: [{ id: 'engineer', worktree: worker }], cooperation: { canonicalCommit: git(['rev-parse', 'HEAD']) },
    check: { commit: receipt.baseCommit, passed: false } };
  const stateFile = path.join(directory, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  return { receipt, state, stateFile, worker };
}

it('separates installed modules, live imports, canonical imports and an older checked commit', () => {
  const { stateFile, state } = fixture();
  const result = autoLibraryLiveUsage({ records: [entry()], stateFile });
  expect(result.installed).toEqual([expect.objectContaining({ file, name: 'Truth', sourceDigest: mathDigest(source) })]);
  expect(result.drafts[0]).toMatchObject({ workerId: 'engineer', stage: 'worker-draft', status: 'observed',
    authority: 'lexical-import-observation', proofAcceptance: 'not-assessed', sourceDigest: mathDigest(draftSource),
    modules: [expect.objectContaining({ name: 'Truth', direct: true, mentioned: ['TheoremOS.Auto.Truth.truth'] })] });
  expect(result.canonical).toMatchObject({ commit: state.cooperation.canonicalCommit, status: 'observed',
    modules: [expect.objectContaining({ name: 'Truth' })] });
  expect(result.checked).toMatchObject({ commit: state.check.commit, passed: false, matchesCanonical: false, modules: [] });
  expect(result.checkpointDigest).toBe(mathDigest(fs.readFileSync(stateFile)));
});

it('reports a changed draft pack and a missing worker separately from immutable observations', () => {
  const { state, stateFile, worker } = fixture();
  fs.appendFileSync(path.join(worker, 'generated/problem', file), '-- changed\n');
  state.workers.push({ id: 'missing', worktree: path.join(directory, 'missing') });
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const result = autoLibraryLiveUsage({ records: [entry()], stateFile });
  expect(result.drafts[0]).toMatchObject({ status: 'unavailable', modules: [],
    error: `auto_library_usage_frozen_source_changed: ${file}` });
  expect(result.drafts[1]).toMatchObject({ workerId: 'missing', status: 'unavailable', modules: [] });
  expect(result.canonical?.status).toBe('observed');
});

it('does not attribute a different pool revision or manufacture a checked observation', () => {
  const { stateFile, state } = fixture();
  const { check: _check, cooperation: _cooperation, ...withoutCommits } = state;
  fs.writeFileSync(stateFile, JSON.stringify(withoutCommits));
  const differentSource = source + '-- later revision\n';
  const different = parseAutoLibraryRecord({ ...entry(), source: differentSource, sourceDigest: mathDigest(differentSource) });
  const result = autoLibraryLiveUsage({ records: [different], stateFile });
  expect(result.installed).toEqual([{ file, sourceDigest: mathDigest(source) }]);
  expect(result.drafts[0]?.modules).toEqual([]);
  expect(result.canonical).toBeNull(); expect(result.checked).toBeNull();
});
