import { describe, expect, it } from 'vitest';
import type { WebObservation } from '../apps/web/collaboration';
import { recordedSolutionRoute } from '../apps/web/client/solutionRoute';
import { explanationSolutionRoute } from '../apps/web/client/explainSolutionRoute';
import { buildTrajectory, emptyTrajectory, trajectoryTally, type TrajectoryStep } from '../apps/web/client/trajectory';
import type { WebExplanationDocument } from '../apps/web/shared';
import { loadWebSample } from '../apps/web/sample';
import { recordedTrajectory, trajectoryPage, type TrajectoryPlanItem, type TrajectoryVersion } from '../apps/web/trajectory';

const epoch = Date.UTC(2026, 10, 8);
const item = (id: string, dependencies: string[] = []): TrajectoryPlanItem => ({ id, kind: id === 'finish' ? 'goal' : 'lemma', name: `Fresh.${id}`,
  objective: `Establish ${id}.`, type: `${id}_statement`, dependsOn: dependencies, taskDigest: `${id}-version` });
function run() {
  const data = emptyTrajectory();
  data.context = { workers: [{ id: 'author', role: 'engineer' }, { id: 'lead', role: 'lead' }], targets: ['Fresh.finish'] };
  data.plans.set(1, { observation: 1, at: epoch, added: [item('normalize'), item('bound', ['normalize']), item('finish', ['bound'])],
    changed: [], removed: [], omitted: 0, revision: 1 });
  return data;
}
const version = (taskId: string, commit: string, passed: boolean, seconds: number): TrajectoryVersion => ({
  key: `${taskId}\0${commit}`, taskId, commit, source: 1, file: 'Submission.lean', firstAt: epoch + seconds * 1000, revision: 1,
  checks: [{ at: epoch + seconds * 1000, passed, status: passed ? 'kernel_verified' : 'failed', receiptIds: [`receipt-${commit}`], theorems: [`Fresh.${taskId}`],
    observation: 1, ...passed ? {} : { headline: 'type mismatch at the connecting lemma' } }],
});
const attempt = (taskId: string, number: number, passed: boolean): TrajectoryStep => {
  const saved = version(taskId, `commit-${number}`, passed, number);
  return { kind: 'attempt', taskId, number, at: saved.firstAt, outcome: passed ? 'passed' : 'failed', workerId: 'author',
    reused: false, integrated: passed, ref: { version: saved, check: saved.checks[0] } };
};

describe('universal workbench solution route', () => {
  it('keeps the recorded DAG, complete findings and every failed/successful source version for a new problem', () => {
    const data = run(), finding = 'Detailed derivation. '.repeat(400) + 'The final link is now explicit.';
    data.deliveries.set('research', { id: 'research', kind: 'research', status: 'advisory', producer: 'author', taskId: 'bound',
      summary: 'Use the normalized expression to prove the bound.', finding, createdAt: epoch + 3000, revision: 1,
      dependencies: [{ taskId: 'normalize', taskDigest: 'normalize-version' }], statement: 'bound_statement', premises: ['x ≥ 0'] });
    const steps = [attempt('bound', 1, false), attempt('bound', 2, true)];
    const model = recordedSolutionRoute({ id: 'fresh-problem', data, steps, status: 'completed', taskDetails: [{ id: 'bound', kind: 'lemma',
      objective: 'Establish the bound.', informalProof: 'Substitute the normalization into the inequality.', premises: ['x ≥ 0'], version: 'bound-version' }] });
    expect(model.edges).toEqual(expect.arrayContaining([
      { from: 'task:normalize', to: 'task:bound', kind: 'dependency' }, { from: 'task:bound', to: 'task:finish', kind: 'dependency' },
    ]));
    const tries = model.nodes.filter(node => node.kind === 'attempt');
    expect(tries.map(node => node.status)).toEqual(['failed', 'passed']);
    expect(tries.map(node => node.source?.commit)).toEqual(['commit-1', 'commit-2']);
    expect(tries.map(node => node.action?.target)).toEqual(['step:0', 'step:1']);
    expect(tries[0]!.sections?.some(section => section.text.includes('type mismatch'))).toBe(true);
    expect(model.nodes.find(node => node.id === 'delivery:research')?.sections?.some(section => section.text === finding)).toBe(true);
    expect(model.nodes.find(node => node.id === 'task:bound')?.sections?.some(section => section.text === 'Substitute the normalization into the inequality.')).toBe(true);
    expect(model.edges.some(edge => edge.from === 'task:normalize' && edge.to === 'delivery:research' && edge.kind === 'reference')).toBe(true);
    expect(model.nodes.find(node => node.id === 'evaluation')?.status).toBe('pending');
    expect(new Set(model.nodes.map(node => node.id)).size).toBe(model.nodes.length);
    expect(model.edges.every(edge => model.nodes.some(node => node.id === edge.from) && model.nodes.some(node => node.id === edge.to))).toBe(true);
  });

  it('keeps delivery, human approval and independent acceptance distinct', () => {
    const data = run();
    const guidance = { id: 'human-input', recipient: { kind: 'task' as const, id: 'bound' }, taskRef: { id: 'bound', version: 'bound-version' },
      text: 'Use the monotonicity argument, then check the endpoint.', status: 'delivered' as const, deliveredTo: ['author'],
      createdAt: new Date(epoch).toISOString(), updatedAt: new Date(epoch + 1000).toISOString(), revision: 1 };
    data.guidance.set(guidance.id, guidance);
    const steps: TrajectoryStep[] = [
      { kind: 'approval', at: epoch, event: { at: new Date(epoch).toISOString(), sequence: 1, type: 'plan_approved', message: 'Plan approved.' } },
      { kind: 'guidance', at: epoch + 1000, guidance },
      { kind: 'delivery', at: epoch + 2000, delivery: { id: 'review', kind: 'review', status: 'accepted', producer: 'reviewer', summary: 'The proof is ready for acceptance.', createdAt: epoch + 2000, revision: 1 } },
    ];
    const before = recordedSolutionRoute({ id: 'fresh', data, steps, status: 'completed' });
    expect(before.nodes.find(node => node.id === 'guidance:human-input')).toMatchObject({ status: 'human', summary: guidance.text });
    expect(before.edges).toContainEqual({ from: 'guidance:human-input', to: 'task:bound', kind: 'decision' });
    expect(before.nodes.find(node => node.id === 'record:approval:1')).toMatchObject({ kind: 'decision', status: 'human' });
    expect(before.nodes.find(node => node.id === 'evaluation')?.status).toBe('pending');
    const after = recordedSolutionRoute({ id: 'fresh', data, status: 'completed', steps: [...steps,
      { kind: 'evaluation', at: epoch + 3000, status: 'passed', outcome: 'passed' }] });
    expect(after.nodes.find(node => node.id === 'evaluation')?.status).toBe('passed');
  });

  it('shows unattempted original targets without inventing a task dependency', () => {
    const data = emptyTrajectory(); data.context.targets = ['Unplanned.first', 'Unplanned.second'];
    const route = recordedSolutionRoute({ id: 'no-plan', data, steps: [], status: 'running' });
    expect(route.nodes.filter(node => node.kind === 'task').map(node => node.id)).toEqual(['target:Unplanned.first', 'target:Unplanned.second']);
    expect(route.edges.filter(edge => edge.kind === 'dependency')).toEqual([]);
    expect(route.nodes.find(node => node.id === 'evaluation')?.status).toBe('pending');
  });

  it('keeps alternative proof routes as planned references and record IDs stable as more events arrive', () => {
    const data = run(), step = attempt('bound', 1, false);
    const first = recordedSolutionRoute({ id: 'fresh', data, steps: [step], status: 'running',
      proofRoutes: [{ id: 'alternative', targetTaskId: 'finish', prerequisiteTaskIds: ['normalize'], closingTaskId: 'bound' }] });
    const next = recordedSolutionRoute({ id: 'fresh', data, steps: [{ kind: 'notice', at: epoch - 1000, count: 1,
      event: { sequence: 100, type: 'route_parked', at: new Date(epoch - 1000).toISOString(), message: 'A branch is parked.' } }, step], status: 'running' });
    expect(first.nodes.find(node => node.kind === 'attempt')?.id).toBe(next.nodes.find(node => node.kind === 'attempt')?.id);
    expect(next.nodes.find(node => node.kind === 'attempt')?.action?.target).toBe('step:1');
    expect(first.edges).toContainEqual({ from: 'task:bound', to: 'task:finish', kind: 'reference' });
    expect(first.nodes.find(node => node.id === 'task:finish')?.sections?.some(section => section.text.includes('alternative'))).toBe(true);
  });

  it('keeps both same-commit orphan checks when their events arrive, with stable IDs and separate reuse records', () => {
    const data = run(), saved = version('bound', 'stable-source', false, 1);
    saved.checks.push({ ...saved.checks[0]!, at: epoch + 5000, passed: true, status: 'kernel_verified', headline: undefined,
      receiptIds: ['later-receipt'] });
    data.versions.set(saved.key, saved);
    const trajectory = () => buildTrajectory({ data, status: 'running', createdAt: new Date(epoch).toISOString() });
    const project = () => recordedSolutionRoute({ id: 'fresh', data, steps: trajectory(), status: 'running' });
    const before = project().nodes.filter(node => node.kind === 'attempt');
    expect(before.map(node => node.status)).toEqual(['failed', 'passed']);
    const originalIds = before.map(node => node.id);
    data.events.push({ sequence: 1, type: 'task_checked', at: new Date(saved.checks[0]!.at + 50).toISOString(),
      message: 'The check failed.', details: { taskId: 'bound', passed: false } });
    expect(project().nodes.filter(node => node.kind === 'attempt').map(node => node.id)).toEqual(originalIds);
    data.events.push({ sequence: 2, type: 'task_checked', at: new Date(saved.checks[1]!.at + 50).toISOString(),
      message: 'The check passed.', details: { taskId: 'bound', passed: true } });
    expect(project().nodes.filter(node => node.kind === 'attempt').map(node => node.id)).toEqual(originalIds);
    data.events.push(
      { sequence: 3, type: 'route_parked', at: new Date(epoch + 6000).toISOString(), message: 'Pause this branch.' },
      { sequence: 4, type: 'task_check_reused', at: new Date(epoch + 7000).toISOString(),
        message: 'Reuse the saved passed check.', details: { taskId: 'bound', passed: true } },
    );
    const reused = project().nodes.filter(node => node.kind === 'attempt');
    expect(reused).toHaveLength(3);
    expect(reused.slice(0, 2).map(node => node.id)).toEqual(originalIds);
    expect(reused[2]!.id).toContain(':true:');
    expect(reused[2]!.at).toBe(new Date(epoch + 7000).toISOString());
    expect(reused[2]!.source?.commit).toBe(saved.commit);
    expect(trajectoryTally(trajectory(), data)).toMatchObject({ checks: 2, attempts: 2 });
  });

  it('recovers unused checks without duplicating assembly, standalone rechecks or rechecks folded into a human edit', () => {
    const data = run(), bound = version('bound', 'same-bound', false, 1), normalized = version('normalize', 'after-edit', true, 31);
    bound.checks.push({ ...bound.checks[0]!, at: epoch + 10000, passed: true, status: 'kernel_verified', receiptIds: ['recheck-bound'] });
    const assembled = version('finish', 'assembled', true, 50), assemblyCopy = { ...assembled,
      key: 'normalize\0assembled', taskId: 'normalize', checks: structuredClone(assembled.checks) };
    for (const saved of [bound, normalized, assembled, assemblyCopy]) data.versions.set(saved.key, saved);
    data.edits.set('change-premise', { id: 'change-premise', status: 'applied', revision: 1,
      receivedAt: epoch + 30000, appliedAt: epoch + 30000, affectedTasks: ['normalize'] });
    data.events.push(
      { sequence: 1, type: 'task_recheck_finished', at: new Date(epoch + 10050).toISOString(),
        message: 'Bound rechecked.', details: { taskId: 'bound', passed: true } },
      { sequence: 2, type: 'task_recheck_finished', at: new Date(epoch + 31050).toISOString(),
        message: 'Edited premise rechecked.', details: { taskId: 'normalize', passed: true } },
      { sequence: 3, type: 'assembly_started', at: new Date(epoch + 49950).toISOString(), message: 'Assemble.' },
      { sequence: 4, type: 'proof_checked', at: new Date(epoch + 50050).toISOString(), message: 'Assembly checked.', details: { passed: true } },
      { sequence: 5, type: 'task_check_reused', at: new Date(epoch + 70000).toISOString(),
        message: 'Reuse the saved bound.', details: { taskId: 'bound', passed: true } },
    );
    const steps = buildTrajectory({ data, status: 'running', createdAt: new Date(epoch).toISOString() });
    expect(steps.filter(step => step.kind === 'attempt' && !step.reused).map(step => step.ref?.check?.receiptIds)).toEqual([bound.checks[0]!.receiptIds]);
    expect(steps.filter(step => step.kind === 'recheck').flatMap(step => step.results.map(result => result.ref?.check?.receiptIds))).toEqual([['recheck-bound']]);
    expect(steps.filter(step => step.kind === 'edit').flatMap(step => step.results.map(result => result.ref?.check?.receiptIds))).toEqual([normalized.checks[0]!.receiptIds]);
    expect(steps.filter(step => step.kind === 'proof')).toHaveLength(1);
    expect(trajectoryTally(steps, data)).toMatchObject({ checks: 4, attempts: 1 });
  });

  it('binds each same-commit task revision to its own receipts and retains unmatched or ambiguous deliveries', () => {
    const data = run(), saved = version('bound', 'same-code', false, 1);
    saved.checks[0]!.receiptIds = ['old-receipt'];
    saved.checks.push({ ...saved.checks[0]!, at: epoch + 5000, passed: true, status: 'kernel_verified', headline: undefined,
      receiptIds: ['new-receipt'] });
    data.versions.set(saved.key, saved);
    const old = { ...item('bound', ['normalize']), informalProof: 'Use the original lower bound.' };
    const revised = { ...old, taskDigest: 'bound-revised', type: 'revised_bound_statement', informalProof: 'Use the strengthened bound.' };
    data.plans.get(1)!.added[1] = old;
    data.plans.set(2, { observation: 2, revision: 2, previousAt: epoch + 2000, at: epoch + 4000, added: [], removed: [], omitted: 0,
      changed: [{ before: old, after: revised }] });
    for (const [id, receiptId, snapshot, summary, at] of [
      ['old', 'old-receipt', old, 'Account for the original argument.', epoch + 1000],
      ['new', 'new-receipt', revised, 'Account for the strengthened argument.', epoch + 5000],
    ] as const) data.deliveries.set(id, { id, kind: 'proof', taskId: 'bound', taskDigest: snapshot.taskDigest,
      status: 'verified', producer: 'author', commit: saved.commit, createdAt: at, revision: 1, summary,
      evidence: { passed: true, verification: { status: 'kernel_verified', targetCommit: saved.commit, results: [{ receiptId }] } } });
    data.events.push(...saved.checks.map((check, index) => ({ sequence: index + 1, type: 'task_checked',
      at: new Date(check.at + 50).toISOString(), message: 'Saved check.', details: { taskId: 'bound', passed: check.passed } })));
    const steps = buildTrajectory({ data, status: 'running', createdAt: new Date(epoch).toISOString() });
    expect(steps.filter(step => step.kind === 'attempt').map(step => step.note)).toEqual([
      'Account for the original argument.', 'Account for the strengthened argument.',
    ]);
    const project = (stepsToShow: TrajectoryStep[] = steps) => recordedSolutionRoute({ id: 'fresh', data, steps: stepsToShow, status: 'running' });
    const model = project(), tries = model.nodes.filter(node => node.kind === 'attempt');
    expect(tries.map(node => node.sections!.find(section => section.title === '这一版的思路')!.text)).toEqual([old.informalProof, revised.informalProof]);
    expect(model.nodes.some(node => node.id === 'delivery:old' || node.id === 'delivery:new')).toBe(false);
    const oldAttempt = steps.filter(step => step.kind === 'attempt').slice(0, 1);
    data.deliveries.delete('old');
    const mismatched = project(oldAttempt);
    expect(mismatched.nodes.find(node => node.kind === 'attempt')?.sections?.some(section => section.text === revised.informalProof)).toBe(false);
    expect(mismatched.nodes.some(node => node.id === 'delivery:new')).toBe(true);
    data.deliveries.set('legacy', { id: 'legacy', taskId: 'bound', commit: saved.commit, kind: 'proof', status: 'verified',
      producer: 'author', summary: 'Legacy argument without a receipt link.', createdAt: epoch + 1000, revision: 1 });
    const ambiguous = project(oldAttempt);
    expect(ambiguous.nodes.find(node => node.kind === 'attempt')?.sections?.some(section => section.text === 'Legacy argument without a receipt link.')).toBe(false);
    expect(ambiguous.nodes.some(node => node.id === 'delivery:legacy')).toBe(true);
    data.deliveries.delete('new');
    expect(project(oldAttempt).nodes.find(node => node.kind === 'attempt')?.sections?.some(section =>
      section.text === 'Legacy argument without a receipt link.')).toBe(true);
  });

  it('shows every recheck outcome, commit and receipt inside the human plan edit that caused it', () => {
    const data = run(), passed = version('normalize', 'after-edit-passed', true, 2), failed = version('bound', 'after-edit-failed', false, 3);
    const steps: TrajectoryStep[] = [{ kind: 'edit', at: epoch + 1000, edit: { id: 'change-premise', status: 'applied', revision: 1,
      receivedAt: epoch + 1000, appliedAt: epoch + 1000, affectedTasks: ['normalize', 'bound'] }, results: [
      { taskId: 'normalize', passed: true, conditional: true, ref: { version: passed, check: passed.checks[0] } },
      { taskId: 'bound', passed: false, ref: { version: failed, check: failed.checks[0] } },
    ] }];
    const model = recordedSolutionRoute({ id: 'fresh', data, steps, status: 'running' });
    const edit = model.nodes.find(node => node.id === 'record:edit:change-premise')!;
    expect(edit.action?.target).toBe('step:0');
    expect(edit.sections?.map(section => section.text)).toEqual(expect.arrayContaining([
      '有条件通过', '未通过\ntype mismatch at the connecting lemma', passed.commit, failed.commit,
      passed.checks[0]!.receiptIds[0], failed.checks[0]!.receiptIds[0],
    ]));
    expect(model.edges).toEqual(expect.arrayContaining([
      { from: edit.id, to: 'task:normalize', kind: 'decision' }, { from: edit.id, to: 'task:bound', kind: 'decision' },
    ]));
  });
});

describe('complete recorded explanation projection', () => {
  it('retains long mathematics and evidence through the saved-observation trajectory index, including same-status enrichment', () => {
    const sample = loadWebSample()!, observation = structuredClone(sample.observations.at(-1)!) as WebObservation;
    const text = 'a mathematical explanation '.repeat(300);
    observation.plan!.tasks[0] = { ...observation.plan!.tasks[0]!, objective: text, informalProof: text, premises: ['x ≥ 0'], citations: ['A saved source'] };
    observation.plan!.proofRoutes = [{ id: 'path', targetTaskId: observation.plan!.tasks[1]!.id,
      prerequisiteTaskIds: [], closingTaskId: observation.plan!.tasks[0]!.id }];
    observation.deliveries = [{ id: 'full', producer: 'author', kind: 'research', status: 'advisory', taskId: observation.plan!.tasks[0]!.id,
      statement: 'P', premises: ['x ≥ 0'], dependencies: [{ taskId: 'upstream', taskDigest: 'saved-version' }], remainingObligations: [],
      summary: text, finding: text, evidenceRefs: ['source-a'], createdAt: epoch }];
    const updated = structuredClone(observation); updated.sequence++;
    updated.deliveries![0]!.evidenceRefs = [...updated.deliveries![0]!.evidenceRefs, 'source-b'];
    const page = trajectoryPage(recordedTrajectory([], [observation, updated]), { after: 0, since: 0 });
    expect(page.plans[0]!.added[0]).toMatchObject({ objective: text, informalProof: text, premises: ['x ≥ 0'], citations: ['A saved source'] });
    expect(page.plans[0]!.proofRoutes).toEqual(observation.plan!.proofRoutes);
    expect(page.deliveries[0]).toMatchObject({ summary: text, finding: text, evidenceRefs: ['source-a', 'source-b'], dependencies: [{ taskId: 'upstream', taskDigest: 'saved-version' }] });
  });

  it('connects cited declarations and step states to the exact source lines without creating mathematical claims from chronology', () => {
    const proof = 'theorem helper : P := by\n  exact hp\ntheorem target : Q := by\n  have h := helper\n  exact finish h\n';
    const document: WebExplanationDocument = {
      schema: 'theorem-os.web-explanation.v1', target: 'target', language: 'en', toolchain: 'test', mathlibRevision: null,
      overview: 'Prove P, then use it to derive Q.', axioms: [], model: 'fixture', effort: 'max', auditors: 2, rounds: 1, tokens: 0,
      metrics: { declarations: 2, steps: 3, citations: 1, excerptCoverage: 1, proofLines: 3, explainedLines: 3, ambiguousExcerpts: 0 },
      sections: [
        { name: 'helper', kind: 'theorem', target: false, title: 'Establish P', statement: 'P holds.', lines: { start: 1, end: 2 }, signature: { start: 1, end: 1 }, unexplained: [], statementReviews: [],
          steps: [{ text: 'Apply the given hypothesis hp.', lines: [{ start: 2, end: 2 }], uses: [], reviews: [] }] },
        { name: 'target', kind: 'theorem', target: true, title: 'Derive Q', statement: 'Q follows from P.', lines: { start: 3, end: 5 }, signature: { start: 3, end: 3 }, unexplained: [], statementReviews: [],
          steps: [
            { text: 'Obtain P from the helper theorem.', lines: [{ start: 4, end: 4 }], uses: [{ name: 'helper', place: 'step', spans: [] }], reviews: ['The quoted Lean obtains exactly P.'],
              goals: { before: ['⊢ Q'], beforeCount: 1, after: ['h : P\n⊢ Q'], afterCount: 1, lines: { start: 4, end: 4 } } },
            { text: 'Use h with finish to close Q.', lines: [{ start: 5, end: 5 }], uses: [], reviews: [],
              goals: { before: ['h : P\n⊢ Q'], beforeCount: 1, after: [], afterCount: 0, lines: { start: 5, end: 5 } } },
          ] },
      ],
    };
    const route = explanationSolutionRoute(document, proof), first = route.nodes.find(node => node.id === 'derivation:target:0')!;
    expect(route.basis).toBe('explanation');
    expect(route.edges).toEqual(expect.arrayContaining([
      { from: 'declaration:helper', to: 'declaration:target', kind: 'dependency' },
      { from: 'declaration:helper', to: 'derivation:target:0', kind: 'reference' },
      { from: 'derivation:target:0', to: 'derivation:target:1', kind: 'sequence' },
    ]));
    expect(first.source).toMatchObject({ line: 4, endLine: 4 });
    expect(first.action?.target).toBe('step:1:0');
    expect(first.sections?.map(section => section.text)).toEqual(expect.arrayContaining(['Obtain P from the helper theorem.', '⊢ Q', 'h : P\n⊢ Q', '  have h := helper']));
    expect(route.nodes.find(node => node.id === 'derivation:target:1')?.sections?.some(section => section.text === 'This goal is closed.')).toBe(true);
    expect(route.nodes.some(node => node.kind === 'acceptance')).toBe(false);
  });
});
