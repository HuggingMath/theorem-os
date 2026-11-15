import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { mathDigest, writeMathJsonDurable } from '../src/math/mathRuntimeIo';
import { writeSolverRunState } from '../src/solver/archive';
import { checkDeclarationArtifacts, writeDeclarationArtifacts } from '../src/solver/declarationArtifacts';
import { checkKnowledgeApplications } from '../src/solver/knowledgeApplications';
import type { KnowledgeUse } from '../src/solver/knowledgeUsage';
import { checkSolverProof, hasFreshSolverCheck } from '../src/solver/modules/evidence';
import { committedSource, commitSolverSources, readSolverProblem } from '../src/solver/problem';
import { buildTheoremKnowledge, getKnowledgeTheorem, searchTheoremKnowledge } from '../src/solver/theoremKnowledge';
import { getKnowledgeSource } from '../src/solver/theoremKnowledgeSource';
import { importKnowledgeRuns } from '../src/solver/theoremKnowledgeRuns';
import { readKnowledgeCatalog, writePackedKnowledge } from '../src/solver/theoremKnowledgeStore';
import { taskVersion, type CooperativeTask } from '../src/solver/tasks';
import { solverState } from './helpers/solver';

describe('independent skill artifacts consumed in a different real Lean project', () => {
  let root: string, catalogFile: string, catalogDigest: string, producerCommit: string;
  let env: NodeJS.ProcessEnv;
  const observations: Record<string, unknown>[] = [];
  const helperName = 'Artifact.reflexive_under_positive';
  const consumerSource = 'theorem Consumer.target (n : Nat) (h : 0 < n) : n + 0 = n := by sorry\n';

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-knowledge-consumer-')));
    const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
    if (!fs.existsSync(path.join(toolchain, 'bin/lean'))) throw new Error('Real Lean 4.33.0 is required.');
    env = { PATH: `${toolchain}/bin:/usr/bin:/bin`, ELAN_HOME: path.join(os.homedir(), '.elan'),
      LEAN_PATH: '', LEAN_SYSROOT: '', DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap',
      DEEPSCIENTIST_MATH_ENV_FILE: path.join(root, 'absent.env') };
    const producer = bootstrapLeanTask(path.join(root, 'producer'), {
      source: 'namespace Artifact\ntheorem original : True := by sorry\nend Artifact\n',
      task: 'Keep the original goal separate from independently delivered helpers.' });
    const problem = readSolverProblem(producer.workspaceRoot, producer.activeProblemPath);
    const sourceFile = path.join(producer.projectRoot, 'Submission.lean');
    fs.writeFileSync(sourceFile, fs.readFileSync(sourceFile, 'utf8').replace('end Artifact',
      'theorem reflexive_under_positive (n : Nat) (h : 0 < n) : n + 0 = n := by rfl\nend Artifact'));
    producerCommit = commitSolverSources(problem, producer.workspaceRoot);
    const state = solverState(problem, producer.workspaceRoot, { runId: 'independent-producer', phase: 'prepared',
      environmentDigest: mathDigest('producer-frozen-environment') });
    const artifacts = await checkDeclarationArtifacts({ state, worktree: producer.workspaceRoot,
      commit: producerCommit, declarations: [{ file: 'Submission.lean', name: helperName,
        type: '∀ (n : Nat), 0 < n → n + 0 = n', premises: ['The explicit argument h proves 0 < n.'] }],
      env, signal: new AbortController().signal, timeoutMs: 30_000, assertWriterStopped() {} });
    const runtime = path.join(root, 'producer.runtime'); fs.mkdirSync(runtime, { mode: 0o700 });
    writeDeclarationArtifacts(runtime, state, artifacts);
    const stateFile = path.join(runtime, 'state.json'); writeSolverRunState(stateFile, state);
    const imported = importKnowledgeRuns([stateFile]);
    expect(imported.skipped).toEqual([]);
    const published = writePackedKnowledge(path.join(root, 'catalog.json'), buildTheoremKnowledge(imported.candidates));
    catalogFile = published.file; catalogDigest = published.sha256;
    observations.push({ stage: 'producer-delivery', producerCommit, declarations: artifacts.length,
      producerReceipt: artifacts[0]!.proof.verification.results[0]!.receiptId, originalAccepted: state.check?.passed ?? false,
      catalogDigest, evidence: 'real-bwrap-Lean' });
  }, 60_000);

  afterAll(() => {
    if (process.env.THEOREMOS_EVIDENCE_ROOT) {
      const destination = path.resolve(process.env.THEOREMOS_EVIDENCE_ROOT);
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      writeMathJsonDurable(path.join(destination, 'knowledge-consumer.json'), {
        checkedAt: new Date().toISOString(), modelCalls: 0, verification: 'real-Lean-4.33-bwrap',
        passed: ['consumer-application-and-strict-check', 'missing-premise-rejected', 'stale-consumer-inputs-rejected']
          .every(stage => observations.some(item => item.stage === stage)), observations });
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function consumer(label: string, complete = false) {
    const snapshot = readKnowledgeCatalog(catalogFile, catalogDigest);
    const search = searchTheoremKnowledge(snapshot.base, helperName, {
      goal: 'n : Nat, h : 0 < n ⊢ n + 0 = n', environmentDigest: mathDigest('consumer-frozen-environment') });
    const hit = search.hits.find(item => item.name === helperName);
    expect(hit).toBeDefined();
    const item = getKnowledgeTheorem(snapshot.base, hit!.id);
    expect(item.requiresFreshCheck).toBe(true);
    const excerpt = getKnowledgeSource(snapshot.base, item.id, { name: item.name });
    expect(excerpt.declaration?.complete).toBe(true);
    const receipt = bootstrapLeanTask(path.join(root, label), { source: consumerSource,
      task: 'Prove the independent consumer using an available helper.' });
    const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
    // Adapt the declaration's qualified name without introducing new namespace commands
    // into the consumer's frozen surrounding context.
    const helper = excerpt.text.replace(/^theorem\s+\S+/u, 'theorem ' + excerpt.declaration!.qualifiedName) + '\n';
    fs.writeFileSync(path.join(receipt.projectRoot, 'Submission.lean'), helper + consumerSource.replace('by sorry',
      complete ? 'by exact Artifact.reflexive_under_positive n h' : 'by sorry'));
    const commit = commitSolverSources(problem, receipt.workspaceRoot);
    const task: CooperativeTask = { id: 'consumer-target', kind: 'goal', objective: 'Prove the new target.',
      revision: 0, dependsOn: [], proofPath: 'Submission.lean', theoremName: 'Consumer.target', type: 'n + 0 = n' };
    const use: KnowledgeUse = { source: 'catalog', id: item.id, catalogDigest,
      consumer: { taskId: task.id, taskDigest: taskVersion(task) },
      declaration: { name: helperName, file: 'Submission.lean' }, status: 'reported-attempt',
      attribution: 'model-reported-origin', application: { expression: `fun (n : Nat) (h : 0 < n) => ${helperName} n h`,
        expectedType: '∀ (n : Nat), 0 < n → n + 0 = n',
        context: { file: 'Submission.lean', declaration: 'Consumer.target' },
        additionalPremises: ['Use the consumer hypothesis h : 0 < n.'] } };
    const input = { projectRoot: receipt.projectRoot, env, environmentDigest: mathDigest('consumer-frozen-environment'),
      commit, task, timeoutMs: 30_000,
      sourceAtCommit: (file: string) => committedSource(receipt.workspaceRoot, commit, problem.projectRelative + '/' + file) };
    observations.push({ stage: 'consumer-search-read', consumer: label, id: item.id, catalogDigest,
      sourceDigest: excerpt.sha256, producerCommit, consumerCommit: commit, requiresFreshCheck: item.requiresFreshCheck });
    return { receipt, problem, commit, use, input };
  }

  it('finds, reads and applies the persisted artifact, then independently accepts the new target', async () => {
    const current = consumer('accepted-consumer', true);
    const [application] = await checkKnowledgeApplications([current.use], current.input);
    expect(application!.application!.check, application!.application!.check?.diagnostic).toMatchObject({ status: 'elaborated', selectedDeclarationUsed: true,
      proofAcceptance: 'not-assessed', commit: current.commit });
    const check = await checkSolverProof(current.problem, current.receipt.workspaceRoot, env,
      new AbortController().signal, undefined, 30_000);
    expect(check.passed).toBe(true);
    expect(hasFreshSolverCheck(check)).toBe(true);
    expect(check.commit).toBe(current.commit); expect(check.commit).not.toBe(producerCommit);
    expect(check.verification.results).toHaveLength(current.problem.targets.length);
    observations.push({ stage: 'consumer-application-and-strict-check', application: application!.application!.check,
      consumerCommit: current.commit, passed: check.passed, receiptIds: check.verification.results.map(item => item.receiptId) });
  }, 60_000);

  it('does not turn a historical receipt or a partial application into a new proof', async () => {
    const current = consumer('missing-premise-consumer');
    const missing = { ...current.use, application: { ...current.use.application!,
      expression: `fun (n : Nat) => ${helperName} n`, expectedType: '∀ (n : Nat), n + 0 = n' } };
    const [result] = await checkKnowledgeApplications([missing], current.input);
    expect(result!.application!.check).toMatchObject({ status: 'failed', proofAcceptance: 'not-assessed' });
    const check = await checkSolverProof(current.problem, current.receipt.workspaceRoot, env,
      new AbortController().signal, undefined, 30_000);
    expect(check.passed).toBe(false);
    expect(hasFreshSolverCheck(check)).toBe(false);
    observations.push({ stage: 'missing-premise-rejected', application: result!.application!.check,
      consumerCommit: current.commit, passed: check.passed });
  }, 60_000);

  it('does not reuse an application check after the consumer environment or submitted source changes', async () => {
    const current = consumer('changed-consumer');
    const previous = await checkKnowledgeApplications([current.use], current.input);
    expect(previous[0]!.application!.check?.status, previous[0]!.application!.check?.diagnostic).toBe('elaborated');
    const changedEnvironment = await checkKnowledgeApplications([current.use], { ...current.input,
      env: { ...env, LEAN_PATH: '/unfrozen/library' }, previous });
    expect(changedEnvironment[0]!.application!.check).toMatchObject({ status: 'unavailable',
      reason: 'application-environment-not-frozen' });
    fs.appendFileSync(path.join(current.receipt.projectRoot, 'Submission.lean'), '\n-- changed after submitted commit\n');
    const changedSource = await checkKnowledgeApplications([current.use], { ...current.input, previous });
    expect(changedSource[0]!.application!.check).toMatchObject({ status: 'unavailable',
      reason: 'application-source-not-submitted-snapshot' });
    observations.push({ stage: 'stale-consumer-inputs-rejected', environment: changedEnvironment[0]!.application!.check,
      source: changedSource[0]!.application!.check });
  }, 60_000);
});
