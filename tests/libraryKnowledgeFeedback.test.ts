import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../scripts/mathematics/prepareLibraryKnowledge';
import { AUTO_LIBRARY_RECORD_SCHEMA, autoLibraryModule } from '../src/math/autoLibrary';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { writeSolverRunState, type SolverRunState } from '../src/solver/archive';
import { knowledgeContextSections } from '../src/solver/knowledgeContext';
import { git, readSolverProblem } from '../src/solver/problem';
import { taskVersion, type CooperativeTask } from '../src/solver/tasks';
import { searchKnowledgeRouteFindings, searchTheoremKnowledge } from '../src/solver/theoremKnowledge';
import { prepareLibraryKnowledge } from '../src/solver/theoremKnowledgeLibrary';
import { getKnowledgeMetadata } from '../src/solver/theoremKnowledgeMetadata';
import { readKnowledgeCatalog } from '../src/solver/theoremKnowledgeStore';
import { temporaryDirectory } from './helpers/files';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const moduleName = 'Bridge', moduleFile = 'Submission/Library/Auto/Bridge.lean', declaration = 'TheoremOS.Auto.Bridge.bridge';
const library = 'namespace TheoremOS.Auto.Bridge\ntheorem bridge : True := trivial\nend TheoremOS.Auto.Bridge\n';
const challenge = 'namespace Original\ntheorem target : True := by sorry\nend Original\n';
const hash = (text: string) => mathDigest(text);
const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, canonicalMathJson(value) + '\n');
};
const commit = (workspace: string) => {
  git(workspace, ['add', '--', '.']);
  git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--quiet', '--no-gpg-sign', '-m', 'Recorded fixture']);
  return git(workspace, ['rev-parse', 'HEAD']);
};

function fixture(withLibrary = true, source = challenge) {
  const root = temporaryDirectory('library-knowledge-feedback-'); roots.push(root);
  const workspace = path.join(root, 'workspace'), output = path.join(root, 'catalog.json');
  const receipt = bootstrapLeanTask(workspace, { source, task: 'Prove target.\nFrozen library notice.',
    ...(withLibrary ? { libraryPack: { schema: LIBRARY_PACK_SCHEMA, modules: [{ file: moduleFile, source: library,
      origin: { kind: 'run', runId: 'fixture-library', commit: 'a'.repeat(40), file: 'Submission.lean' } }] } } : {}) });
  return { root, workspace, output, receipt };
}

function historicalRun(root: string, suffix = '') {
  const workspace = path.join(root, 'historical' + suffix), stateFile = path.join(root, 'snapshot' + suffix, 'state.json');
  const receipt = bootstrapLeanTask(workspace, { source: challenge, task: 'Historical entropy investigation.' });
  const problem = readSolverProblem(workspace, path.join(workspace, 'active-problem.json'));
  const helper: CooperativeTask = { id: 'bridge', kind: 'lemma', objective: 'Entropy contraction bridge.', revision: 0,
    dependsOn: [], proofPath: 'Submission.lean', theoremName: 'entropy_bridge', type: 'True' };
  const research: CooperativeTask = { id: 'research', kind: 'research', objective: 'Find entropy contraction normalization.',
    dependsOn: [], revision: 0 };
  const finding = { taskId: research.id, taskDigest: taskVersion(research), conclusion: 'supporting',
    summary: 'Entropy contraction requires checking kernel normalization.', remainingObligations: ['Check normalization.'] };
  const findingText = canonicalMathJson(finding);
  fs.appendFileSync(path.join(receipt.projectRoot, 'Submission.lean'), '\ntheorem entropy_bridge : True := trivial\n');
  fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), findingText);
  const checkedCommit = commit(workspace);
  const sourceDigest = mathDigest(canonicalMathJson(problem.ownedFiles.map(file => [file,
    mathDigest(fs.readFileSync(path.join(receipt.projectRoot, file)))])));
  const proof = { commit: checkedCommit, sourceDigest, passed: true, taskDigest: taskVersion(helper),
    seedCommit: receipt.baseCommit, changes: [], verification: { status: 'kernel_verified', targetCommit: checkedCommit,
      results: [{ status: 'kernel_verified', targetCommit: checkedCommit, receiptId: 'historical-receipt', claim: 'statement',
        proofPath: helper.proofPath, theoremName: helper.theoremName,
        statementHash: taskVersion(helper), leanStatementHash: taskVersion(helper) }] } };
  const state = { schema: 'deepscientist.math.solver.v1', runId: 'historical-run' + suffix, problem, worktree: workspace,
    taskDigest: hash('task'), buildDigest: hash('build'), environmentDigest: receipt.environmentDigest!,
    evaluatorDigest: hash('evaluation'), model: 'fixture', effort: 'max', phase: 'running', turns: 2,
    cooperation: { tasks: [{ task: helper, status: 'integrated', attempts: 1, integratedCheck: proof },
      { task: research, status: 'completed', attempts: 1, finding: findingText }], deliveries: [{ id: 'finding', producer: 'researcher',
        kind: 'research', status: 'advisory', taskId: research.id, taskDigest: taskVersion(research), finding: findingText,
        findingDigest: mathDigest(findingText), commit: checkedCommit, statement: research.objective, premises: [], dependencies: [],
        summary: finding.summary, remainingObligations: finding.remainingObligations, evidenceRefs: [], createdAt: 1 }] },
  } as unknown as SolverRunState;
  fs.mkdirSync(path.dirname(stateFile)); writeSolverRunState(stateFile, state);
  return { stateFile, state, helper, findingText };
}

function automaticBuild(input: ReturnType<typeof fixture>) {
  const directory = path.join(input.root, 'build');
  const request = { schema: 'theorem-os.auto-library-build.v1', buildId: '0f2d05e8-5d78-402b-b74e-3f0936f8e8b2',
    challengeId: 'fixture', challengeSource: input.receipt.contract.formalStatement, task: 'Prove target.', environment: 'standard',
    environmentDigest: input.receipt.environmentDigest!, pool: '/unused/pool', basePackDigest: null,
    buildManifestRef: '/unused/manifest.json', buildDigest: hash('build'),
    planner: { model: 'fixture', effort: 'max', executable: '/unused/model', profile: '/unused/profile' },
    prover: { model: 'fixture', effort: 'max', executable: '/unused/model', workers: 1, coordination: 'independent',
      maxRunSeconds: 1, maxTurns: 1, maxTurnSeconds: 1, maxTotalTokens: 100, prepareTimeoutSeconds: 1 },
    maxModules: 1, maxRounds: 1, maxRunSeconds: 1, maxTotalTokens: 100, plannerTurnSeconds: 1 };
  const application = { expression: declaration, expectedType: 'True', context: { file: 'Submission.lean', declaration: 'Original.target' },
    remainingGoals: ['Check the original consumer still needs the normalization premise.'], adaptationSteps: ['Instantiate the recorded term.'] };
  const selected = { declaration, application };
  const check = { status: 'elaborated', reason: 'selected-expression-elaborated-against-requested-type',
    authority: 'advisory-application-elaboration', proofAcceptance: 'not-assessed', consumerCoverage: 'not-assessed',
    commit: 'a'.repeat(40), environmentDigest: request.environmentDigest, sourceSnapshotDigest: hash('snapshot'), selectedDeclarationUsed: true,
    files: [{ file: moduleFile, digest: hash(library) },
      { file: 'Submission.lean', digest: hash(`import ${autoLibraryModule(moduleName)}\n${request.challengeSource}`) }] };
  const round = { round: 1, phase: 'done', pool: [], taken: [], name: moduleName, outcome: 'published',
    plan: { inputDigest: hash('input'), decision: 'module', reason: 'Reusable bridge.', name: moduleName,
      summary: 'Bridge for the original consumer.', sources: [], lean: library, target: 'Original.target',
      application: 'Use the bridge.', remaining: ['Check normalization.'], consumerApplication: selected },
    applicationCheck: { ...selected, check } };
  const state = { schema: 'theorem-os.auto-library-state.v1', requestDigest: hash(canonicalMathJson(request)), status: 'built', elapsedMs: 1,
    sessions: [], modules: [{ index: 0, status: 'published', published: moduleName, openedAtMs: 0, rounds: [round] }] };
  const record = { schema: AUTO_LIBRARY_RECORD_SCHEMA, name: moduleName, file: moduleFile, source: library, sourceDigest: hash(library),
    summary: 'Bridge for the original consumer.', sources: [], theorems: [declaration], requires: [], visible: [],
    environment: { id: 'standard', digest: request.environmentDigest },
    trigger: { challengeId: request.challengeId, challengeDigest: hash(request.challengeSource), taskDigest: hash(request.task) },
    cost: { plannerTokens: 0, proverTokens: 0, wallMs: 1, rounds: 1 }, planner: { model: 'fixture', effort: 'max' },
    prover: { runId: 'fixture-prover', commit: 'b'.repeat(40), model: 'fixture', dropped: [] },
    buildId: request.buildId, buildDigest: request.buildDigest, publishedAt: '2026-11-07T12:00:00.000Z' };
  const recordFile = path.join(directory, 'modules', '0', 'round-1', 'record.json');
  const save = () => { writeJson(path.join(directory, 'request.json'), request); writeJson(path.join(directory, 'state.json'), state); writeJson(recordFile, record); };
  save(); return { directory, request, state, round, record, recordFile, save, application };
}

describe('explicit campaign knowledge feedback', () => {
  it('merges checked historical helpers and admitted findings with the frozen library', () => {
    const input = fixture(), history = historicalRun(input.root);
    const prepared = prepareLibraryKnowledge(input.workspace, input.output, { stateFiles: [history.stateFile, history.stateFile] });
    expect(prepared).toMatchObject({ enabled: true, entries: 2, solverCheckedEntries: 1, frozenLibraryPackEntries: 1, routeFindings: 1 });
    if (!prepared.enabled) throw new Error('No catalog');
    const { base } = readKnowledgeCatalog(prepared.file, prepared.sha256);
    expect(searchTheoremKnowledge(base, 'entropy contraction').hits.map(hit => hit.name)).toContain('entropy_bridge');
    expect(searchKnowledgeRouteFindings(base, 'entropy normalization').hits).toHaveLength(1);
    expect(base.entries.find(item => item.name === 'entropy_bridge')!.provenance[0]).toMatchObject({
      kind: 'solver-check', source: history.stateFile, runId: history.state.runId });
    expect(prepareLibraryKnowledge(input.workspace, input.output, { stateFiles: [history.stateFile] })).toMatchObject({ sha256: prepared.sha256 });
  });

  it('supports history without a library, while excluding conditional or stale proof records', () => {
    const input = fixture(false), history = historicalRun(input.root), conditional = historicalRun(input.root, '-conditional');
    conditional.state.cooperation!.tasks[0]!.integratedCheck!.conditions = [{ taskId: 'unproved', taskDigest: hash('unproved') }];
    writeSolverRunState(conditional.stateFile, conditional.state);
    const prepared = main(['--workspace', input.workspace, '--output', input.output,
      '--state', history.stateFile, '--state', conditional.stateFile]);
    expect(prepared).toMatchObject({ enabled: true, solverCheckedEntries: 1, libraryModules: 0, libraryPackDigest: null });
    expect(prepared.skipped).toContainEqual(expect.objectContaining({ reason: 'math_knowledge_run_proof_conditional' }));
    history.state.cooperation!.tasks[0]!.task.revision++;
    writeSolverRunState(history.stateFile, history.state);
    expect(() => prepareLibraryKnowledge(input.workspace, input.output, { stateFiles: [history.stateFile, conditional.stateFile] }))
      .toThrow('math_knowledge_identity_changed');
    const fresh = prepareLibraryKnowledge(input.workspace, path.join(input.root, 'fresh.json'), { stateFiles: [history.stateFile] });
    expect(fresh).toMatchObject({ enabled: true, entries: 0, routeFindings: 1 });
    expect(fresh.skipped).toContainEqual(expect.objectContaining({ reason: 'math_knowledge_run_proof_stale' }));
  });

  it('keeps invalid optional historical inputs visible as skips without discarding installed knowledge', () => {
    const input = fixture(), missing = path.join(input.root, 'missing', 'state.json');
    const prepared = prepareLibraryKnowledge(input.workspace, input.output, { stateFiles: [missing], autoLibraryBuilds: [path.join(input.root, 'missing-build')] });
    expect(prepared).toMatchObject({ enabled: true, entries: 1 });
    expect(prepared.skipped).toContainEqual({ source: missing, reason: 'math_knowledge_run_state_invalid' });
    expect(prepared.skipped).toContainEqual(expect.objectContaining({ source: path.join(input.root, 'missing-build') }));
  });

  it('does not silently disable an existing catalog after all its historical evidence disappears', () => {
    const input = fixture(false), history = historicalRun(input.root);
    expect(prepareLibraryKnowledge(input.workspace, input.output, { stateFiles: [history.stateFile] }).enabled).toBe(true);
    fs.rmSync(history.stateFile);
    expect(() => prepareLibraryKnowledge(input.workspace, input.output, { stateFiles: [history.stateFile] }))
      .toThrow('math_library_knowledge_snapshot_changed');
  });
});

describe('exact frozen auto-library application handoff', () => {
  it('retains the exact original term, distinct task identity and historical authority through the CLI', () => {
    const input = fixture(), build = automaticBuild(input);
    const prepared = main(['--workspace', input.workspace, '--output', input.output,
      '--auto-library-build', build.directory, '--auto-library-build', build.directory]);
    expect(prepared).toMatchObject({ enabled: true, applicationHints: 1, skipped: [] });
    if (!prepared.enabled) throw new Error('No catalog');
    const { base } = readKnowledgeCatalog(prepared.file, prepared.sha256), hint = base.entries[0]!.applicationHints![0]!;
    expect(hint).toMatchObject({ evidence: 'recorded-not-replayed', requiresFreshCheck: true, proofAcceptance: 'not-assessed',
      application: build.application, historicalCheck: { status: 'elaborated', selectedDeclarationUsed: true },
      scope: { originalTaskDigest: hash(build.request.task), problemReceiptDigest: hash(canonicalMathJson(input.receipt)) } });
    expect(hint.scope.originalTaskDigest).not.toBe(hash(input.receipt.contract.informalStatement));
    expect(prepareLibraryKnowledge(input.workspace, input.output, { autoLibraryBuilds: [build.directory] })).toMatchObject({ sha256: prepared.sha256 });
    expect(Object.keys(build.record)).not.toContain('applicationHints');
    expect(base.entries[0]!.provenance[0]!.receiptIds).toEqual([]);
  });

  it('pages complete remaining obligations and exposes a bounded context read handle', () => {
    const input = fixture(), build = automaticBuild(input);
    build.application.remainingGoals = ['必须证明归一化条件😀'.repeat(650)]; build.save();
    const prepared = prepareLibraryKnowledge(input.workspace, input.output, { autoLibraryBuilds: [build.directory] });
    if (!prepared.enabled) throw new Error('No catalog');
    const { base } = readKnowledgeCatalog(prepared.file, prepared.sha256), entry = base.entries[0]!;
    const metadata = getKnowledgeMetadata(base, entry.id, { maxBytes: 6000 });
    if (metadata.mode !== 'summary') throw new Error('Expected summary');
    expect(metadata.fields.applicationHints).toMatchObject({ complete: false, read: { field: 'applicationHints', startOffset: 0 } });
    let offset = 0, joined = '';
    for (;;) {
      const page = getKnowledgeMetadata(base, entry.id, { field: 'applicationHints', startOffset: offset, maxBytes: 1200 });
      if (page.mode !== 'field') throw new Error('Expected page');
      expect(Buffer.byteLength(JSON.stringify(page)) + 1).toBeLessThanOrEqual(1200);
      joined += page.text;
      if (!page.truncated) break;
      offset = page.nextOffset!;
    }
    expect(JSON.parse(joined)).toEqual(entry.applicationHints);
    const sections = knowledgeContextSections({ problem: readSolverProblem(input.workspace, path.join(input.workspace, 'active-problem.json')),
      environmentDigest: input.receipt.environmentDigest, knowledge: { digest: prepared.sha256, base } });
    expect(sections).toHaveLength(1);
    expect(Buffer.byteLength(sections[0]!.text)).toBeLessThanOrEqual(4096);
    expect(sections[0]!.text).toContain('"field":"applicationHints"');
    expect(sections[0]!.text).toContain('"historicalStatus":"elaborated"');
    expect(sections[0]!.text).not.toContain(build.application.remainingGoals[0]);
  });

  it('hands an exact scoped application to its consumer even when lexical theorem search returns no candidate', () => {
    const input = fixture(true, challenge.replace('True', '2 = 2')), build = automaticBuild(input);
    const prepared = prepareLibraryKnowledge(input.workspace, input.output, { autoLibraryBuilds: [build.directory] });
    if (!prepared.enabled) throw new Error('No catalog');
    const { base } = readKnowledgeCatalog(prepared.file, prepared.sha256);
    const problem = readSolverProblem(input.workspace, path.join(input.workspace, 'active-problem.json'));
    const args = { problem, environmentDigest: input.receipt.environmentDigest, knowledge: { digest: prepared.sha256, base } };
    const sections = knowledgeContextSections(args), handoff = sections.find(section => section.id.startsWith('knowledge-application-hints:'))!;
    expect(sections[0]!.knowledge.candidateIds).toEqual([]);
    expect(handoff.knowledge.candidateIds).toEqual([base.entries[0]!.id]);
    expect(handoff.knowledge.searchCandidateIds).toEqual([]);
    expect(JSON.parse(handoff.text)).toMatchObject({ selection: 'exact-recorded-application-scope', proofAcceptance: 'not-assessed',
      consumerCoverage: 'not-assessed', candidates: [{ applicationHints: { read: { field: 'applicationHints' } } }] });
    expect(Buffer.byteLength(handoff.text)).toBeLessThanOrEqual(4096);
    expect(knowledgeContextSections({ ...args, environmentDigest: hash('different') })
      .some(section => section.id.startsWith('knowledge-application-hints:'))).toBe(false);
    expect(knowledgeContextSections({ ...args, problem: { ...problem, receiptDigest: hash('different') } })
      .some(section => section.id.startsWith('knowledge-application-hints:'))).toBe(false);
  });

  it.each(['missing-check', 'unbound-source', 'changed-selection', 'changed-module', 'changed-challenge'])
    ('skips %s and keeps the existing library catalog usable', change => {
      const input = fixture(), build = automaticBuild(input);
      if (change === 'missing-check') delete (build.round as { applicationCheck?: unknown }).applicationCheck;
      if (change === 'unbound-source') build.round.applicationCheck.check.files = [];
      if (change === 'changed-selection') build.round.applicationCheck = { ...build.round.applicationCheck,
        application: { ...build.application, expression: 'True.intro' } };
      if (change === 'changed-module') { build.record.source += '\n'; build.record.sourceDigest = hash(build.record.source); }
      if (change === 'changed-challenge') { build.request.challengeSource += '\n'; build.state.requestDigest = hash(canonicalMathJson(build.request)); }
      build.save();
      const prepared = prepareLibraryKnowledge(input.workspace, input.output, { autoLibraryBuilds: [build.directory] });
      expect(prepared).toMatchObject({ enabled: true, entries: 1, applicationHints: 0 });
      expect(prepared.skipped).toContainEqual(expect.objectContaining({ reason: {
        'missing-check': 'math_library_application_check_not_recorded', 'unbound-source': 'math_library_application_check_source_unbound',
        'changed-selection': 'math_library_application_selection_mismatch', 'changed-module': 'math_library_application_module_not_installed',
        'changed-challenge': 'math_library_application_challenge_mismatch',
      }[change] }));
    });
});
