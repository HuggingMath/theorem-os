import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { projectMathematicsRuntimeEnvironment } from '../src/math/mathRuntimeEnvironment';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { saveAgentTeamResearchArtifact } from '../src/solver/agentTeamResearch';
import { searchContinuation } from '../src/solver/continuationSearch';
import { seedSingleSolverContinuation } from '../src/solver/singleContinuationSeed';
import { freezeContinuationInput, readContinuationContents, readContinuationPage, type ContinuationManifest } from '../src/solver/continuationInput';
import { readDeclarationArtifacts } from '../src/solver/declarationArtifacts';
import { committedSource, commitSolverSources, git } from '../src/solver/problem';
import { taskVersion, type CooperativeTask } from '../src/solver/tasks';
import { localExample, solverState } from './helpers/solver';
import { failedBatch, receiptBatch } from './helpers/verifier';
import { readMathAgentSkill } from '../src/runtime/codexSkills';
import { researchSkillIdentity } from '../src/solver/researchSkill';

const host = vi.hoisted(() => ({ verify: vi.fn(), build: vi.fn() }));
vi.mock('../src/math/mathBuildManifest', async original => ({ ...await original<typeof import('../src/math/mathBuildManifest')>(),
  readMathBuildManifest: host.build }));
vi.mock('../src/math/verifier', async original => ({ ...await original<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, resolveMathematicsLakePackagesCache: () => undefined }));

const roots: string[] = [];
function fixture() {
  const f = localExample('single-continuation-test-'); roots.push(f.directory);
  const oldDirectory = path.join(f.directory, 'old.runtime'), directory = path.join(f.directory, 'new.runtime');
  for (const runtimeDirectory of [oldDirectory, directory]) {
    fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
    git(f.workspace, ['worktree', 'add', '--quiet', '--detach', path.join(runtimeDirectory, 'worktree'), f.problem.baseCommit]);
  }
  const sourceWorktree = path.join(oldDirectory, 'worktree'), worktree = path.join(directory, 'worktree');
  const peer = path.join(oldDirectory, 'worktree-2');
  git(f.workspace, ['worktree', 'add', '--quiet', '--detach', peer, f.problem.baseCommit]);
  const file = path.join(sourceWorktree, f.problem.projectRelative, 'Submission.lean');
  const sources = fs.readFileSync(file, 'utf8').replace('namespace Tutorial',
    'namespace Tutorial\nlemma saved_helper : True := by trivial\n');
  fs.writeFileSync(file, sources);
  const canonicalNotes = '\ufeffcanonical λ notes\r\n';
  fs.writeFileSync(path.join(sourceWorktree, 'RESEARCH.md'), canonicalNotes);
  const canonical = commitSolverSources(f.problem, sourceWorktree);
  fs.writeFileSync(path.join(peer, 'RESEARCH.md'), '\ufeffunfinished peer λ notes\r\n');
  const draft = fs.readFileSync(path.join(peer, f.problem.projectRelative, 'Submission.lean'), 'utf8');
  fs.writeFileSync(path.join(peer, f.problem.projectRelative, 'Submission.lean'), draft.replace('namespace Tutorial',
    'namespace Tutorial\nlemma worker_draft : True := by sorry\n'));
  const helper: CooperativeTask = { id: 'saved', kind: 'lemma', proofPath: 'Submission.lean',
    theoremName: 'Tutorial.saved_helper', type: 'True', objective: 'Historical helper', revision: 0, dependsOn: [], ownerId: 'engineer' };
  const archived = solverState(f.problem, sourceWorktree, { runId: 'old-run', phase: 'running',
    taskDigest: mathDigest('Original task'), environmentDigest: mathDigest('old-environment'), turns: 12,
    usage: { totalTokens: 18000 }, workerCount: 2, coordination: 'cooperative',
    workers: [{ id: 'solver', role: 'lead', worktree: sourceWorktree, turns: 7, phase: 'running', threadId: 'old-lead' },
      { id: 'engineer', role: 'engineer', worktree: peer, turns: 5, phase: 'running', threadId: 'old-engineer' }],
    cooperation: { canonicalCommit: canonical, tasks: [{ task: helper, attempts: 1, status: 'integrated',
      integratedCheck: { commit: canonical, sourceDigest: mathDigest(sources), taskDigest: taskVersion(helper),
        seedCommit: f.problem.baseCommit, changes: [], passed: true,
        verification: { status: 'kernel_verified', results: [{ receiptId: 'old-receipt' }] } as never } }] } });
  const sourceStateFile = path.join(oldDirectory, 'state.json'), stateFile = path.join(directory, 'state.json');
  writeSolverRunState(sourceStateFile, archived);
  const buildFile = path.join(f.directory, 'build.json'); fs.writeFileSync(buildFile, '{}');
  const state = solverState(f.problem, worktree, { runId: 'new-run', phase: 'prepared', taskDigest: archived.taskDigest,
    environmentDigest: mathDigest('new-environment'), buildDigest: mathDigest('{}'), methodDigest: mathDigest('new-method'),
    workerCount: 1, coordination: 'independent', researchMode: 'skill',
    researchSkill: { name: 'theoremos-research', digest: mathDigest('skill'), loading: 'native' } });
  writeSolverRunState(stateFile, state);
  const environmentFile = path.join(directory, 'environment-solver.json');
  const environment = projectMathematicsRuntimeEnvironment({ PATH: process.env.PATH });
  fs.writeFileSync(environmentFile, canonicalMathJson(environment), { mode: 0o400 });
  // This models the separately frozen skill projection owned by run.ts, outside the Lean source set.
  const skill = path.join(worktree, '.agents', 'skills', 'theoremos-research', 'SKILL.md');
  const skillText = '---\nname: theoremos-research\ndescription: Research the fixed mathematical problem with independent proof checks.\n---\nRetain exact research artifacts.\n';
  fs.mkdirSync(path.dirname(skill), { recursive: true }); fs.writeFileSync(skill, skillText);
  state.researchSkill = researchSkillIdentity(readMathAgentSkill(skill, 'native')); writeSolverRunState(stateFile, state);
  const options = { sourceRun: sourceStateFile, run: stateFile, root: f.directory, buildManifest: buildFile,
    signal: new AbortController().signal, preparedEnvironment: environment };
  return { ...f, directory, oldDirectory, sourceWorktree, worktree, sourceStateFile, stateFile, helper, archived,
    state, sources, canonical, canonicalNotes, peer, skill, skillText, options, seed: () => seedSingleSolverContinuation(options) };
}

beforeEach(() => {
  host.build.mockReset(); host.verify.mockReset().mockImplementation((request: MathematicsVerifierBatchRequest) =>
    receiptBatch(request, { sessionId: 'new-check', receiptId: (_index, name) => `fresh-${name}` }));
});
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('single researcher continuation', () => {
  it('imports canonical bytes, records drafts and costs, and independently checks helpers without restoring a task graph', async () => {
    const f = fixture(), oldState = fs.readFileSync(f.sourceStateFile), oldNotes = fs.readFileSync(path.join(f.peer, 'RESEARCH.md'));
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report).toMatchObject({ stage: 'complete', checked: ['saved'], failed: [], evidence: 'fresh-helper-receipts' });
    expect(state).toMatchObject({ phase: 'prepared', turns: 0, runId: 'new-run', researchMode: 'skill' });
    for (const key of ['threadId', 'previousThreadIds', 'usage', 'workers', 'cooperation', 'check']) expect(state[key]).toBeUndefined();
    expect(fs.readFileSync(path.join(f.worktree, f.problem.projectRelative, 'Submission.lean'), 'utf8')).toBe(f.sources);
    expect(fs.readFileSync(path.join(f.worktree, 'RESEARCH.md'), 'utf8')).toBe(f.canonicalNotes);
    expect(fs.readFileSync(f.skill, 'utf8')).toBe(f.skillText);
    const snapshot = path.join(f.directory, 'continuation.json');
    const history = JSON.parse(readContinuationPage(snapshot, state.continuationDigest!, 'seed-history').text);
    expect(history).toMatchObject({ runId: 'old-run', usage: { totalTokens: 18000 }, turns: 12 });
    const draft = JSON.parse(readContinuationPage(snapshot, state.continuationDigest!, 'draft-engineer').text);
    expect(draft.notes).toBe(oldNotes.toString('utf8')); expect(draft.sources['Submission.lean']).toContain('worker_draft');
    const artifacts = readDeclarationArtifacts(f.directory, state);
    expect(artifacts).toHaveLength(1); expect(artifacts[0].runId).toBe('new-run');
    expect(artifacts[0].proof.verification.results[0].receiptId).toBe('fresh-Tutorial.saved_helper');
    expect(host.verify).toHaveBeenCalledOnce(); expect(fs.readFileSync(f.sourceStateFile)).toEqual(oldState);
    expect(fs.readFileSync(path.join(f.peer, 'RESEARCH.md'))).toEqual(oldNotes);
  });

  it('keeps a rejected helper advisory with its exact diagnostic, without discarding the source', async () => {
    const f = fixture();
    host.verify.mockImplementation((request: MathematicsVerifierBatchRequest) => failedBatch(receiptBatch(request,
      { sessionId: 'failed-check', receiptId: () => 'failed-receipt' }), { stdoutPreview: () => 'not proved' }));
    const report = await f.seed();
    expect(report).toMatchObject({ stage: 'complete', checked: [], failed: ['saved'],
      evidence: 'advisory-sources-require-recheck', declarationFailures: [{ id: 'saved', name: 'Tutorial.saved_helper',
        error: expect.stringContaining('math_declaration_artifact_check_failed') }] });
    expect(readDeclarationArtifacts(f.directory, readSolverRunState(f.stateFile))).toEqual([]);
    expect(fs.readFileSync(path.join(f.worktree, f.problem.projectRelative, 'Submission.lean'), 'utf8')).toBe(f.sources);
  });

  it('does not reinterpret a historical conditional helper as an unconditional candidate', async () => {
    const f = fixture(); f.archived.cooperation!.tasks[0].integratedCheck!.conditions = [{ taskId: 'condition', taskDigest: mathDigest('condition') }];
    writeSolverRunState(f.sourceStateFile, f.archived);
    expect(await f.seed()).toMatchObject({ stage: 'complete', candidates: [], checked: [] }); expect(host.verify).not.toHaveBeenCalled();
  });

  it('retries an interrupted zero-turn import from the frozen capture even if the old run has changed', async () => {
    const f = fixture(); host.verify.mockRejectedValueOnce(new Error('fixture_interrupted_check'));
    await expect(f.seed()).rejects.toThrow('fixture_interrupted_check');
    const frozen = fs.readFileSync(path.join(f.directory, 'continuation-single-source.json'));
    fs.appendFileSync(path.join(f.sourceWorktree, 'RESEARCH.md'), 'New old-run activity after capture');
    f.archived.turns += 1; writeSolverRunState(f.sourceStateFile, f.archived);
    expect(await f.seed()).toMatchObject({ stage: 'complete', checked: ['saved'] });
    expect(fs.readFileSync(path.join(f.directory, 'continuation-single-source.json'))).toEqual(frozen);
    expect(fs.readFileSync(path.join(f.worktree, 'RESEARCH.md'), 'utf8')).toBe(f.canonicalNotes);
  });

  it('rejects changed destination source and started research instead of overwriting it', async () => {
    const f = fixture(); await f.seed();
    const target = path.join(f.worktree, f.problem.projectRelative, 'Submission.lean'); fs.appendFileSync(target, '\n-- new work\n');
    await expect(f.seed()).rejects.toThrow('math_continuation_seed_destination_changed');
    expect(fs.readFileSync(target, 'utf8')).toContain('-- new work');
    git(f.worktree, ['checkout', '--', path.relative(f.worktree, target)]);
    const state = readSolverRunState(f.stateFile); state.turns = 1; state.threadId = 'new-thread'; writeSolverRunState(f.stateFile, state);
    await expect(f.seed()).rejects.toThrow('math_continuation_seed_requires_fresh_prepared_run');
  });

  it('binds a frozen import to the destination skill and environment identities', async () => {
    const f = fixture(); host.verify.mockRejectedValueOnce(new Error('interrupted'));
    await expect(f.seed()).rejects.toThrow('interrupted');
    const state = readSolverRunState(f.stateFile); state.researchSkill!.digest = mathDigest('different-skill');
    writeSolverRunState(f.stateFile, state);
    await expect(f.seed()).rejects.toThrow('math_research_skill_changed');
  });

  it('re-pins an existing untracked skill projection for each freshly loaded problem on retry', async () => {
    const f = fixture();
    expect(git(f.worktree, ['ls-files', '--others', '--exclude-standard', '--', '.agents'])).toContain('SKILL.md');
    host.verify.mockRejectedValueOnce(new Error('interrupted'));
    await expect(f.seed()).rejects.toThrow('interrupted');
    expect(await f.seed()).toMatchObject({ stage: 'complete', checked: ['saved'] });
    expect(fs.readFileSync(f.skill, 'utf8')).toBe(f.skillText);
    expect(git(f.worktree, ['ls-files', '--', '.agents'])).toBe('');
  });

  it('does not overwrite new untracked research notes during an interrupted retry', async () => {
    const f = fixture();
    // Freeze an import, then model the crash before its first destination install.
    host.verify.mockRejectedValueOnce(new Error('interrupted'));
    await expect(f.seed()).rejects.toThrow('interrupted');
    git(f.worktree, ['reset', '--hard', f.problem.baseCommit]);
    const notesFile = path.join(f.worktree, 'RESEARCH.md'); fs.writeFileSync(notesFile, 'New destination research');
    await expect(f.seed()).rejects.toThrow('math_continuation_seed_destination_changed');
    expect(fs.readFileSync(notesFile, 'utf8')).toBe('New destination research');
  });

  it('can continue a single source without inventing cooperative task state', async () => {
    const f = fixture(); delete f.archived.cooperation; delete f.archived.workers; f.archived.workerCount = 1;
    f.archived.coordination = 'independent'; f.archived.threadId = 'old-single-thread'; writeSolverRunState(f.sourceStateFile, f.archived);
    expect(await f.seed()).toMatchObject({ stage: 'complete', candidates: [] });
    const state = readSolverRunState(f.stateFile), contents = readContinuationContents(path.join(f.directory, 'continuation.json'), state.continuationDigest!);
    expect(contents.snapshot.manifest.attachments.map(item => item.id)).toContain('draft-solver');
    expect(state.threadId).toBeUndefined(); expect(state.cooperation).toBeUndefined(); expect(host.verify).not.toHaveBeenCalled();
    expect(committedSource(f.worktree, git(f.worktree, ['rev-parse', 'HEAD']), `${f.problem.projectRelative}/Submission.lean`)).toBe(f.sources);
  });

  it('carries checked archive bytes of explicit member notes as searchable advisory history, without importing private summaries', async () => {
    const f = fixture(), text = 'A counterexample at the endpoint disproves the proposed monotonicity inference.\r\n';
    delete f.archived.workers; delete f.archived.cooperation; f.archived.coordination = 'independent'; f.archived.workerCount = 1;
    const directory = path.join(f.oldDirectory, 'agent-team/research'), privateSummary = 'private-terminal-response';
    const save = (taskId: string, commit: string) => saveAgentTeamResearchArtifact({ state: f.archived, directory,
      worktree: f.peer, agentId: 'researcher', taskId, commit, summary: privateSummary, status: 'interrupted' });
    const missing = save('no-notes', f.problem.baseCommit);
    fs.writeFileSync(path.join(f.peer, 'RESEARCH.md'), text);
    const commit = commitSolverSources(f.problem, f.peer), first = save('endpoint', commit), second = save('boundary', commit);
    fs.writeFileSync(path.join(f.peer, 'RESEARCH.md'), 'new unpublished draft');
    f.archived.agentTeam = { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control', workers: [],
      deliveries: [], adoptions: [], events: [], operations: [], researchArtifacts: [first, first, second, missing] };
    writeSolverRunState(f.sourceStateFile, f.archived);
    const migrated = await f.seed(), state = readSolverRunState(f.stateFile), file = path.join(f.directory, 'continuation.json');
    const input = readContinuationContents(file, migrated.snapshotDigest!);
    const refs = input.snapshot.manifest.attachments.filter(item => item.id.startsWith('member-notes-'));
    expect(refs).toHaveLength(1);
    expect(refs[0]!.provenance).toMatchObject({ runId: f.archived.runId, source: f.sourceStateFile, commit, evidence: 'recorded-not-replayed' });
    const note = input.contents.get(refs[0]!.sha256)!;
    expect(note.slice(note.indexOf('\n') + 1)).toBe(text);
    expect(JSON.parse(note.split('\n')[0]!)).toMatchObject({ advisory: true, originalProblemAcceptance: 'not-assessed',
      sha256: mathDigest(text), origins: [expect.objectContaining({ artifactId: first.id, agentId: 'researcher', taskId: 'endpoint' }),
        expect.objectContaining({ artifactId: second.id, taskId: 'boundary' })] });
    expect(JSON.stringify(searchContinuation(file, migrated.snapshotDigest!, 'monotonicity', { kinds: ['research-notes'] }))).toContain(refs[0]!.id);
    const captured = fs.readFileSync(path.join(f.directory, 'continuation-single-source.json'), 'utf8');
    for (const secret of [privateSummary, 'new unpublished draft']) expect(captured).not.toContain(secret);
    expect(migrated.candidates).toEqual([]); expect(migrated.checked).toEqual([]); expect(host.verify).not.toHaveBeenCalled();
    expect(state.agentTeam).toBeUndefined(); expect(state.check).toBeUndefined();

    const laterDir = path.join(f.oldDirectory, '..', 'third.runtime'), laterTree = path.join(laterDir, 'worktree');
    fs.mkdirSync(laterDir, { mode: 0o700 }); git(f.workspace, ['worktree', 'add', '--quiet', '--detach', laterTree, f.problem.baseCommit]);
    const skillDir = path.dirname(path.join(laterTree, path.relative(f.worktree, f.skill)));
    fs.mkdirSync(skillDir, { recursive: true }); fs.writeFileSync(path.join(skillDir, 'SKILL.md'), f.skillText);
    const laterStateFile = path.join(laterDir, 'state.json');
    writeSolverRunState(laterStateFile, { ...f.state, runId: 'third-run', worktree: laterTree });
    const later = await seedSingleSolverContinuation({ ...f.options, sourceRun: f.stateFile, run: laterStateFile });
    const repeated = readContinuationContents(path.join(laterDir, 'continuation.json'), later.snapshotDigest!);
    expect(repeated.snapshot.manifest.attachments.filter(item => item.sha256 === refs[0]!.sha256))
      .toEqual([expect.objectContaining({ kind: 'research-notes', provenance: refs[0]!.provenance })]);
  });

  it('preserves a full historical attachment set across repeated migration within existing manifest bounds', async () => {
    const f = fixture(), bodies = Array.from({ length: 32 }, (_, index) => `reference ${index}: λ\n\"exact\"\r\n`);
    const manifest: ContinuationManifest = { schema: 'theorem-os.continuation-snapshot.v1', taskDigest: f.archived.taskDigest,
      problemReceiptDigest: f.problem.receiptDigest, attachments: bodies.map((text, index) => ({ id: `reference-${index}`,
        kind: 'reference', path: `ref-${index}.txt`, sha256: mathDigest(text), bytes: Buffer.byteLength(text),
        contentPath: `continuation/${mathDigest(text)}.txt`, provenance: { runId: 'earlier-run', evidence: 'unverified' } })) };
    const old = freezeContinuationInput({ manifest, digest: mathDigest(canonicalMathJson(manifest)),
      contents: new Map(bodies.map(text => [mathDigest(text), text])) }, f.oldDirectory);
    f.archived.continuationDigest = old.digest; writeSolverRunState(f.sourceStateFile, f.archived);
    const report = await f.seed(), state = readSolverRunState(f.stateFile);
    expect(report.stage).toBe('complete');
    const next = readContinuationContents(path.join(f.directory, 'continuation.json'), state.continuationDigest!);
    expect(next.snapshot.manifest.attachments.length).toBeLessThanOrEqual(32);
    const texts = [...next.contents.values()].join('\n');
    for (const text of bodies) expect(texts).toContain(text);
    expect(texts).toContain('earlier-run'); expect(texts).toContain('textSha256');
  });

  it('rejects a member note reference outside the host archive before creating the frozen seed', async () => {
    const f = fixture();
    const ref = saveAgentTeamResearchArtifact({ state: f.archived, directory: path.join(f.oldDirectory, 'alternate'),
      agentId: 'researcher', taskId: 'archived', worktree: f.sourceWorktree, commit: f.canonical,
      summary: 'Terminal response', status: 'completed' });
    f.archived.agentTeam = { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control', workers: [],
      deliveries: [], adoptions: [], events: [], operations: [], researchArtifacts: [ref] };
    writeSolverRunState(f.sourceStateFile, f.archived);
    await expect(f.seed()).rejects.toThrow('math_agent_team_research_reference_changed');
    expect(fs.existsSync(path.join(f.directory, 'continuation-single-source.json'))).toBe(false);
    expect(readSolverRunState(f.stateFile).continuationDigest).toBeUndefined();
  });

  it('projects private run history before freezing a new snapshot, including renamed and nested legacy diagnostics', async () => {
    const f = fixture();
    const privateCard = 'PRIVATE_CARD_BODY_CANARY', privateTurn = 'PRIVATE_WORKER_TURN_CANARY';
    f.archived.agentTeam = { schema: 'theorem-os.agent-team.v1', workers: [], adoptions: [], events: [],
      deliveries: [], operations: [{ key: 'example-call', digest: 'a'.repeat(64), result: { response: privateTurn } }] };
    f.archived.usage = { totalTokens: 480, customBackendField: privateCard };
    const legacy = JSON.stringify({ ...f.archived, runId: 'prior-generation', historicalPrivateConfiguration: privateCard }, null, 2);
    const provenance = { runId: 'prior-generation', source: '/archived/source/state.json', evidence: 'recorded-not-replayed' as const };
    const framed = (id: string, body: string) => canonicalMathJson({ schema: 'theorem-os.continuation-text-record.v1',
      id, kind: 'diagnostics', provenance, textLength: body.length, textBytes: Buffer.byteLength(body), textSha256: mathDigest(body) }) +
      '\n' + body + '\n';
    const note = 'Exact mathematical study note 🧮\nincluding empty lines\n\n';
    const bodies = [legacy, framed('previous-7', framed('previous-11', legacy) + framed('probe', note)), note];
    const manifest: ContinuationManifest = { schema: 'theorem-os.continuation-snapshot.v1', taskDigest: f.archived.taskDigest,
      problemReceiptDigest: f.problem.receiptDigest, attachments: bodies.map((body, i) => ({ id: 'previous-' + (i + 1),
        kind: i === 2 ? 'research-notes' : 'diagnostics', path: i + '.txt', bytes: Buffer.byteLength(body), sha256: mathDigest(body),
        contentPath: 'continuation/' + mathDigest(body) + '.txt', provenance })) };
    const source = freezeContinuationInput({ manifest, digest: mathDigest(canonicalMathJson(manifest)),
      contents: new Map(bodies.map(body => [mathDigest(body), body])) }, f.oldDirectory);
    f.archived.continuationDigest = source.digest; writeSolverRunState(f.sourceStateFile, f.archived);
    const sourceBytes = fs.readFileSync(f.sourceStateFile);
    const result = await f.seed(), next = readContinuationContents(path.join(f.directory, 'continuation.json'), result.snapshotDigest!);
    const read = (id: string) => next.contents.get(next.snapshot.manifest.attachments.find(item => item.id === id)!.sha256)!;
    expect(JSON.parse(read('seed-history'))).toMatchObject({ schema: 'theorem-os.single-continuation-history.v1',
      stateDigest: mathDigest(sourceBytes), usage: { totalTokens: 480 } });
    expect(JSON.parse(read('previous-1'))).toMatchObject({ runId: 'prior-generation', stateDigest: mathDigest(legacy) });
    expect(read('previous-2')).toContain(mathDigest(legacy)); expect(read('previous-2')).toContain(note);
    expect(read('previous-3')).toBe(note);
    expect(next.snapshot.manifest.attachments.find(item => item.id === 'previous-3')!.provenance).toEqual(provenance);
    const saved = fs.readFileSync(path.join(f.directory, 'continuation-single-source.json'), 'utf8') +
      [...next.contents.values()].join('');
    for (const privateValue of [privateCard, privateTurn, 'old-engineer']) expect(saved).not.toContain(privateValue);
    expect(fs.readFileSync(f.sourceStateFile)).toEqual(sourceBytes);
  });
});
