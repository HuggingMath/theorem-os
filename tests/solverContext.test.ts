import { expect, it } from 'vitest';
import { buildResearchContext, finalizeResearchDispatch } from '../src/solver/modules/context';
import type { SolverProblem } from '../src/solver/problem';
import type { SolverRunState } from '../src/solver/archive';
import type { DeliveryReceipt } from '../src/solver/deliveryReceipts';
import { deliveryDetails, parseMathResponse, type DeliveryRecord } from '../src/solver/deliveries';
import { assignmentDeliveryFile, leadPlanDeliveryFile, taskVersion, type CooperativeAction, type CooperativeTask } from '../src/solver/tasks';

it('deduplicates repeated findings and progress while preserving exact Lean types and version references', () => {
  const exactType = '∀ (n : Nat), ' + 'True ∧ '.repeat(2100) + 'True';
  const task: CooperativeTask = { id: 'core', kind: 'lemma', objective: 'Prove the core lemma',
    dependsOn: ['library'], revision: 0, theoremName: 'core', proofPath: 'Submission.lean', type: exactType };
  const library: CooperativeTask = { id: 'library', kind: 'research', objective: 'Search library', dependsOn: [], revision: 0 };
  const problem = { projectRelative: '.', ownedFiles: ['Submission.lean'], declarations: {}, targets: [], receiptDigest: 'problem',
    baseCommit: 'fixed-commit', contract: { formalStatement: 'theorem target : True := by sorry', assumptions: [] } } as unknown as SolverProblem;
  const delivery = (kind: DeliveryRecord['kind'], summary: string, id: string): DeliveryRecord => ({
    id, kind, taskId: 'library', taskDigest: taskVersion(library), producer: 'researcher', status: 'advisory',
    statement: '', premises: [], dependencies: [], remainingObligations: ['core'], summary, evidenceRefs: [], createdAt: 1 });
  const finding = 'library-finding: ' + 'long advisory explanation '.repeat(500);
  const action: CooperativeAction = { kind: 'lead', seedCommit: 'fixed-commit', planVersion: 'current-plan',
    planNonce: 'latest-dispatch-nonce', planningInputDigest: 'latest-planning-input' };
  const state = { cooperation: { tasks: [{ task, status: 'pending', attempts: 0 },
    { task: library,
      status: 'completed', attempts: 1, finding }], deliveries: [delivery('progress', 'obsolete-progress', 'old'),
      delivery('research', finding, 'research'), delivery('progress', 'latest-progress', 'new')] } } as unknown as SolverRunState;
  const context = buildResearchContext(problem, state, { root: '/runtime', worktree: '/proof', environment: {},
    taskText: 'Prove the target', retrievalRoot: '/library', frozenContexts: { 'Submission.lean': 'theorem target : True := /- body omitted -/' },
    assignment: action });
  expect(context.message).toContain(JSON.stringify(exactType));
  expect(context.message).toContain(taskVersion(library));
  expect(context.message).toContain('latest-progress');
  expect(context.message).not.toContain('obsolete-progress');
  expect(context.message.match(/library-finding:/gu)).toHaveLength(1);
  expect(context.message).toContain(finding);
  expect(context.continuationMessage).toBeDefined();
  expect(context.continuationMessage!.length).toBeLessThan(context.message.length / 2);
  expect(context.continuationMessage).not.toContain(exactType);
  expect(context.continuationMessage).not.toContain(finding);
  expect(context.continuationMessage).toContain(JSON.stringify(action));
  expect(context.continuationMessage).toContain(leadPlanDeliveryFile(action));
  expect(context.continuationMessage).toContain(JSON.stringify(context.workContract));
  expect(context.continuationMessage).toContain('replaces every previous dispatch nonce and receipt');
  expect(context.continuationMessage).toContain('RESEARCH.md');
  expect(context.continuationMessage).toContain('COOPERATION.json');
  expect(context.continuationMessage).toContain('host-synced accepted graph');
  expect(context.continuationMessage).toContain('{"baseVersion":"current-plan","upsert":[');
  expect(context.continuationMessage).toContain('proof acceptance');
  expect(context.manifest!.usedBytes).toBeLessThanOrEqual(context.manifest!.maxBytes);
  const graph = context.message.split('Lead task graph and host feedback:\n')[1].split('\n\nRoute groups')[0];
  expect(JSON.parse(graph)[0].type).toBe(exactType);
});

it('names the bundled Agent commands instead of the application when the shell cannot read it', () => {
  const problem = { projectRelative: '.', ownedFiles: ['Submission.lean'], declarations: {}, targets: [], receiptDigest: 'problem',
    baseCommit: 'fixed-commit', contract: { formalStatement: 'theorem target : True := by sorry', assumptions: [] } } as unknown as SolverProblem;
  const access = { root: '/opt/app', worktree: '/proof', environment: {}, taskText: 'Prove the target', retrievalRoot: '/library',
    frozenContexts: { 'Submission.lean': 'theorem target : True := by sorry' } };
  const instructions = (tools?: string) => buildResearchContext(problem, {} as SolverRunState, { ...access, ...(tools ? { tools } : {}) }).instructions;
  expect(instructions()).toContain("bun '/opt/app/bin/math.ts' check-lean --workspace");
  const bundled = instructions('/opt/agent-tools/math.mjs');
  expect(bundled).toContain("bun '/opt/agent-tools/math.mjs' check-lean --workspace");
  expect(bundled).toContain("bun '/opt/agent-tools/math.mjs' check-finite --json");
  expect(bundled).not.toContain('/opt/app');
});

it.each(['cooperative', 'independent'] as const)('gives a single solver a complete diagnostic handoff without team protocols (coordination: %s)', coordination => {
  const problem = { projectRelative: 'generated/problem', ownedFiles: ['Submission.lean', 'Other.lean'], declarations: {},
    targets: [
      { proofPath: 'Submission.lean', theoremName: 'first', declarationHash: 'first' },
      { proofPath: 'Submission.lean', theoremName: 'second', declarationHash: 'second' },
      { proofPath: 'Other.lean', theoremName: 'third', declarationHash: 'third' },
    ], receiptDigest: 'problem', baseCommit: 'fixed-commit',
    contract: { formalStatement: 'Prove all three targets.', assumptions: [] } } as unknown as SolverProblem;
  const state = { coordination, workerCount: 1 } as SolverRunState;
  const context = buildResearchContext(problem, state, { root: '/runtime', worktree: '/proof', environment: {},
    taskText: 'Prove all three targets.', retrievalRoot: '/library',
    frozenContexts: { 'Submission.lean': 'theorem first : True := by sorry\ntheorem second : True := by sorry',
      'Other.lean': 'theorem third : True := by sorry' },
    customModuleRules: [{ id: 'team-rule', name: 'Team rule', slot: 'M5', mode: 'append', enabled: true,
      instructions: 'TEAM_ONLY_SENTINEL' }] });
  const instructions = context.instructions;
  expect(instructions).toContain('save all proof files and a concise worktree-root RESEARCH.md before the final diagnostic');
  expect(instructions).toContain("check-lean --worktree '/proof' --file 'Submission.lean' --file 'Other.lean' --timeout-seconds 0");
  expect(instructions).not.toContain("--file 'Submission.lean' --file 'Submission.lean'");
  expect(instructions).toContain('automatically hands writing back to the host');
  expect(instructions).toContain('Reuse a successful diagnostic when its sources and environment are unchanged');
  expect(instructions).toContain('Return briefly if the turn is still open');
  expect(instructions).toContain('The host freezes the sources and performs independent Lean acceptance');
  expect(instructions).toContain('a local diagnostic is not acceptance');
  expect(instructions).toContain('If the host reports a failed check, repair the reported error');
  expect(instructions).toContain('Do not search for delivery protocols or create result JSON or receipts');
  for (const text of ['delivery logs', 'cooperative agents', 'Lead planning', 'task graph', 'TEAM_ONLY_SENTINEL'])
    expect(instructions).not.toContain(text);
});

it('keeps independent multiworker completion on the existing return protocol', () => {
  const problem = { projectRelative: '.', ownedFiles: ['Submission.lean'], declarations: {}, targets: [], receiptDigest: 'problem',
    baseCommit: 'fixed-commit', contract: { formalStatement: 'theorem target : True := by sorry', assumptions: [] } } as unknown as SolverProblem;
  const context = buildResearchContext(problem, { workerCount: 2, coordination: 'independent' } as SolverRunState,
    { root: '/runtime', worktree: '/proof', environment: {}, taskText: 'Prove the target', retrievalRoot: '/library',
      frozenContexts: { 'Submission.lean': 'theorem target : True := by sorry' } });
  expect(context.instructions).toContain('Then return for independent host checking.');
  expect(context.instructions).not.toContain('automatically hands writing back to the host');
  expect(context.instructions).not.toContain('Lead planning');
});

it.each([false, true])('keeps the Lead on read-only planning and prompt delivery (existing graph: %s)', existing => {
  const formal = 'theorem target (P : Prop) (h : P) : P := by sorry';
  const frozen = 'theorem target (P : Prop) (h : P) : P := /- body omitted -/';
  const taskText = 'Restore the proof, run a fresh Lean check, publish a plan and wait for mathematician approval.';
  const problem = { projectRelative: '.', ownedFiles: ['Submission.lean'], declarations: {}, targets: [], receiptDigest: 'problem',
    baseCommit: 'fixed-commit', contract: { formalStatement: formal, assumptions: [] } } as unknown as SolverProblem;
  const task: CooperativeTask = { id: 'core', kind: 'lemma', objective: 'Prove the core lemma.',
    dependsOn: [], revision: 0, theoremName: 'core', proofPath: 'Submission.lean', type: 'True' };
  const state = { cooperation: { tasks: existing ? [{ task, status: 'pending', attempts: 0 }] : [] } } as unknown as SolverRunState;
  const dispatchNonce = existing ? 'revision-dispatch-nonce' : 'initial-dispatch-nonce';
  const context = buildResearchContext(problem, state, { root: '/runtime', worktree: '/proof', environment: {},
    taskText, retrievalRoot: '/library', frozenContexts: { 'Submission.lean': frozen },
    assignment: { kind: 'lead', seedCommit: 'fixed-commit', planVersion: 'current-plan',
      ...(existing ? { planNonce: dispatchNonce } : { initialPlanNonce: dispatchNonce }) } });
  expect(context.instructions).toContain('Once a complete plan has useful executable work, save the plan, or a revision of the accepted graph, and return promptly so peers can start it.');
  expect(context.instructions).toContain('Delegate unresolved library or mathematical searches as research tasks to eligible Researchers or the Engineer.');
  for (const message of [context.instructions, context.continuationMessage]) {
    expect(message).toContain(`"dispatchNonce":${JSON.stringify(dispatchNonce)}`);
    expect(message).toContain('Copy the dispatchNonce and baseVersion fields exactly as shown');
    expect(message).toContain('Create this current dispatch log by appending if absent');
    expect(message).toContain('a second copy of the graph in RESEARCH.md or the final response is unnecessary');
    expect(message).toContain('return after publication without polling or waiting for approval');
    expect(message).toContain('ready tasks reserved by ownerId to a busy worker');
    expect(message).toContain('Explicitly reassign an unstarted, unassigned task through the plan');
    expect(message).toContain('Preserve route gates, group scope, independent reviewer eligibility and running assignments');
    expect(message).toContain('A goal/lemma objective may guide the argument, but cannot replace its frozen proof deliverable');
    expect(message).toContain('Create a separate untyped research/sketch task for those checks');
  }
  const log = leadPlanDeliveryFile(context.assignment as Extract<CooperativeAction, { kind: 'lead' }>);
  expect(context.workContract).toMatchObject({ stage: 'route-planning', sourcePolicy: 'host-checks-any-source-repair' });
  expect(context.message).toContain(taskText);
  expect(context.message).toContain(formal);
  expect(context.message).toContain(frozen);
  for (const continuation of [false, true]) {
    const dispatched = finalizeResearchDispatch(context, { continuation });
    expect(dispatched.instructions.split('\n').find(line => line.startsWith('Edit only ')))
      .toBe(`Edit only /proof/RESEARCH.md, /proof/${log}.`);
    expect(dispatched.instructions).toContain('Develop a mathematically plausible route from the exact original statement, definitions and relevant saved findings');
    expect(dispatched.instructions).toContain('put a direct original-goal task in the graph; the assigned worker carries out its proof');
    expect(dispatched.instructions).toContain('Return the plan without running Lean diagnostics');
    expect(dispatched.instructions).toContain('Leave all Lean source files, imports and environment configuration unchanged');
    expect(dispatched.instructions).toContain('names, parameters, types, assumptions, existing imports');
    expect(dispatched.instructions).toContain('Plan a shared helper before its consumers when needed; assigned workers implement it');
    expect(dispatched.instructions).toContain('only a further substantive change requires another final plan response');
    for (const writableAdvice of ['bodies must be filled', 'You may add explicit Mathlib.* imports', 'Add helpers in owned modules',
      'For diagnostics, run', 'check-lean --workspace', 'proof-search --workspace', 'Repair the earliest error',
      'restore the offending context', 'For type lookup, add single-name #check'])
      expect(dispatched.instructions).not.toContain(writableAdvice);
    expect(dispatched.message).toContain(JSON.stringify(context.assignment));
    expect(dispatched.message).toContain(JSON.stringify(context.workContract));
    expect(dispatched.workContract).toEqual(context.workContract);
    expect(dispatched.manifest!.usedBytes).toBeLessThanOrEqual(dispatched.manifest!.maxBytes);
  }
  expect(context.instructions).toContain('The host launches the cooperative agents');
  expect(context.instructions).toContain('Lead planning saves a task graph and returns promptly');
  expect(context.instructions).not.toContain('automatically hands writing back to the host');
  // Only an accepted graph can be revised; initial planning still writes a complete plan.
  for (const message of [context.instructions, context.continuationMessage]) {
    expect(message?.includes('Revise the accepted graph instead of retyping it.')).toBe(existing);
    expect(message?.includes('it does not need a complete proof decomposition')).toBe(!existing);
    if (!existing) {
      expect(message).toContain('Keep original goals independent of advisory research in proof dependencies');
      expect(message).toContain('never invent a proposition to fill the graph');
      expect(message).toContain('before further literature searches or proof exploration');
      expect(message).not.toContain('before choosing a task graph');
    }
  }
  expect(context.continuationMessage?.includes('revise the accepted graph or return it unchanged')).toBe(existing);
  expect(context.continuationMessage?.includes('No task graph has been accepted')).toBe(!existing);
  if (!existing) {
    expect(context.continuationMessage).toContain('"baseVersion":"current-plan"');
    expect(context.continuationMessage).toContain('Inline the complete valid graph covering every original target exactly once');
  }
});

it.each(['append', 'replace'] as const)('retains custom Lead strategies and installed mathematics tools (%s)', mode => {
  const problem = { projectRelative: '.', ownedFiles: ['Submission.lean'], declarations: {}, targets: [], receiptDigest: 'problem',
    baseCommit: 'fixed-commit', contract: { formalStatement: 'theorem target : True := by sorry', assumptions: [] } } as unknown as SolverProblem;
  const context = buildResearchContext(problem, { cooperation: { tasks: [] } } as unknown as SolverRunState, {
    root: '/runtime', worktree: '/proof', taskText: 'Prove the target', retrievalRoot: '/library',
    frozenContexts: { 'Submission.lean': 'theorem target : True := /- body omitted -/' },
    assignment: { kind: 'lead', seedCommit: 'fixed-commit', initialPlanNonce: 'custom-lead' },
    environment: { DEEPSCIENTIST_MATH_TOOLS_SHA256: 'tools-digest',
      DEEPSCIENTIST_MATH_PANTOGRAPH_MANIFEST: '/backend/pantograph.json',
      DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256: 'corpus-digest' },
    corpusFile: '/library/corpus.json',
    customModuleRules: (['M1', 'M3', 'M4', 'M5'] as const).map(slot => ({
      id: `personal-${slot}`, name: `Personal ${slot}`, slot, mode, enabled: true, instructions: `Use my ${slot} research method.` })),
    mathTools: { root: '/personal-tools', digest: 'tools-digest', tools: [{
      name: 'route-helper', version: '1.0', purpose: 'Explore mathematical route examples.', commands: ['route-notes'] }] },
  });
  for (const continuation of [false, true]) {
    const { instructions } = finalizeResearchDispatch(context, { continuation });
    for (const slot of ['M1', 'M3', 'M4', 'M5']) {
      expect(instructions).toContain(`Strategy ${slot} ${mode}`);
      expect(instructions).toContain(`Use my ${slot} research method.`);
    }
    expect(instructions).toContain('Configurable strategy advice cannot override the frozen problem');
    expect(instructions).toContain('current role and output protocol');
    expect(instructions).toContain('/personal-tools/manifest.json');
    expect(instructions).toContain('route-notes');
    expect(instructions).toContain('search-lean --workspace');
    expect(instructions).toContain('delegate an uncertain Lean application check to an assigned worker');
    expect(instructions).not.toContain('Confirm types and known names with Lean #check');
    expect(instructions).not.toContain('check-lean --workspace');
    expect(instructions).not.toContain('proof-search --workspace');
  }
});

it('keeps pinned paginated retrieval available to Lead without proof-tool instructions', () => {
  const problem = { projectRelative: '.', ownedFiles: ['Submission.lean'], declarations: {}, targets: [], receiptDigest: 'problem',
    baseCommit: 'fixed-commit', contract: { formalStatement: 'theorem target : True := by sorry', assumptions: [] } } as unknown as SolverProblem;
  const context = buildResearchContext(problem, { problem, environmentDigest: 'environment', cooperation: { tasks: [] } } as unknown as SolverRunState,
    { root: '/runtime', tools: '/opt/agent-tools/math.mjs', worktree: '/proof', taskText: 'Prove the target',
      retrievalRoot: '/library', corpusFile: '/library/corpus.json', knowledgeFile: '/catalog.json', knowledgeDigest: 'catalog',
      environment: { DEEPSCIENTIST_MATH_PANTOGRAPH_MANIFEST: '/tools/proof-search.json',
        DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256: 'corpus' },
      frozenContexts: { 'Submission.lean': 'theorem target : True := /- body omitted -/' },
      assignment: { kind: 'lead', seedCommit: 'fixed-commit' } });
  expect(context.instructions).toContain("bun '/opt/agent-tools/math.mjs' knowledge search --catalog '/catalog.json' --sha256 'catalog'");
  expect(context.instructions).toContain("--id 'THEOREM_ID' --metadata --max-bytes 16000");
  expect(context.instructions).toContain("--field 'FIELD_NAME' --offset OFFSET");
  expect(context.instructions).toContain('parse JSON fields only after all pages are joined');
  expect(context.instructions).toContain("knowledge source --catalog '/catalog.json' --sha256 'catalog'");
  expect(context.instructions).toContain("search-lean --workspace '/library' --corpus '/library/corpus.json' --sha256 'corpus'");
  expect(context.instructions).toContain('Historical receipts never accept a proof in the current problem.');
  expect(context.instructions).not.toContain(' check-lean ');
  expect(context.instructions).not.toContain(' proof-search ');
  expect(context.instructions).not.toContain('check-finite');
});

const gapContext = (kind: 'research' | 'lemma' | 'goal' | 'lead' | 'review', taskText = 'Prove the target',
  objective = 'Resolve the precise missing classification input.') => {
  const formal = 'theorem target : True := by sorry';
  const problem = { projectRelative: '.', ownedFiles: ['Submission.lean'],
    declarations: { 'Submission.lean': [{ name: 'target', header: 'target : True' }] }, targets: [],
    receiptDigest: 'problem', baseCommit: 'fixed-commit',
    contract: { formalStatement: formal, assumptions: [] } } as unknown as SolverProblem;
  const task: CooperativeTask = { id: 'frontier', kind: kind === 'lead' || kind === 'review' ? 'research' : kind,
    objective, dependsOn: [], revision: 0,
    ...(['lemma', 'goal'].includes(kind) ? { theoremName: 'target', proofPath: 'Submission.lean', type: 'True' } : {}) };
  const state = { cooperation: { tasks: [{ task, status: 'pending', attempts: 0 }] } } as unknown as SolverRunState;
  const action: CooperativeAction = kind === 'lead' ? { kind, seedCommit: 'fixed-commit' } :
    kind === 'review' ? { kind, seedCommit: 'fixed-commit', sourceDigest: 'fixed-source' } :
      { kind: 'task', task, assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: 'worker', seedCommit: 'fixed-commit' } };
  return buildResearchContext(problem, state, { root: '/runtime', worktree: '/proof', environment: {},
    taskText, retrievalRoot: '/library', maxOptionalContextBytes: 0,
    frozenContexts: { 'Submission.lean': formal }, assignment: action });
};

it.each(['lemma', 'goal', 'lead', 'research'] as const)(
  'scopes the %s prompt to its assignment while keeping the whole problem as background', kind => {
    const taskText = 'Prove every target in generated/problem/Submission.lean.';
    const context = gapContext(kind, taskText);
    expect(context.instructions.startsWith('Carry out only your current cooperative assignment.')).toBe(true);
    expect(context.instructions).toContain('task text describe the overall research objective');
    expect(context.instructions).toContain('The host integrates checked work and verifies every original target.');
    expect(context.instructions).not.toContain('You prove the original mathematical problem in Lean.');
    expect(context.message).toContain(taskText);
    expect(context.message).toContain('theorem target : True := by sorry');
    if (kind === 'lemma') {
      expect(context.instructions).toContain('every original goal proof exactly as it appears in assignment.seedCommit, including existing sorry placeholders');
      expect(context.instructions).toContain('A preserved placeholder in another declaration does not block delivery of your completed helper.');
      expect(context.instructions).toContain('Proofs you submit for acceptance must not use sorry');
      expect(context.instructions).toContain('confirmed shutdown');
    }
  });

it.each(['lemma', 'goal'] as const)('keeps Lead planning requests out of a dispatched %s proof', kind => {
  const request = 'Prove the target. Publish a minimal executable plan promptly and wait for mathematician approval.';
  const context = gapContext(kind, request);
  const deliveryFile = assignmentDeliveryFile((context.assignment as Extract<CooperativeAction, { kind: 'task' }>).assignment);
  for (const continuation of [false, true]) {
    const dispatched = finalizeResearchDispatch(context, { continuation });
    expect(dispatched.instructions).toContain('plan approval belong to the Lead and host');
    expect(dispatched.instructions).toContain('before dispatching typed proof work');
    expect(dispatched.instructions).toContain('do not start another planning or approval cycle');
    expect(dispatched.instructions).toContain(`append JSON to ${deliveryFile}`);
    expect(dispatched.instructions).toContain('create it by appending if absent');
    expect(dispatched.message).toContain(JSON.stringify(context.assignment));
    expect(dispatched.workContract).toEqual(context.workContract);
    expect(dispatched.manifest!.usedBytes).toBeLessThanOrEqual(dispatched.manifest!.maxBytes);
  }
  expect(context.message).toContain(request);
  const lead = gapContext('lead', request);
  expect(lead.instructions).toContain('You are the Lead.');
  expect(lead.instructions).toContain('Once a complete plan has useful executable work');
  expect(lead.instructions).not.toContain('do not start another planning or approval cycle');
});

it.each(['lemma', 'goal'] as const)('delivers a completed %s without requiring a separate advisory observation', kind => {
  const context = gapContext(kind);
  for (const continuation of [false, true]) {
    const dispatched = finalizeResearchDispatch(context, { continuation });
    expect(dispatched.instructions).toContain('Once the assigned proof is complete and saved, use the ready delivery protocol above and return');
    expect(dispatched.instructions).toContain('no separate research observation is required');
    expect(dispatched.instructions).not.toContain('Publish a single research observation promptly');
    expect(dispatched.instructions).toContain('only for a substantive intermediate finding or gap');
    expect(dispatched.instructions).toContain('theorem-os research-observe --worktree');
    expect(dispatched.instructions).toContain('--finding FINDING_FILE');
    expect(dispatched.instructions).toContain('Save the finding object shown above in the JSON file FINDING_FILE');
    expect(dispatched.instructions).toContain('When supporting Lean code is saved but the assigned declaration is still unproved');
    expect(dispatched.instructions).toContain('append {"kind":"ready","summary":"saved proof"}, stop editing and return');
    expect(dispatched.instructions).toContain('after turn settlement and confirmed shutdown');
  }
});

it('retains the full original-problem responsibility without a cooperative assignment', () => {
  const problem = { projectRelative: '.', ownedFiles: ['Submission.lean'], declarations: {}, targets: [], receiptDigest: 'problem',
    baseCommit: 'fixed-commit', contract: { formalStatement: 'theorem target : True := by sorry', assumptions: [] } } as unknown as SolverProblem;
  const context = buildResearchContext(problem, {} as SolverRunState, { root: '/runtime', worktree: '/proof', environment: {},
    taskText: 'Prove every target in generated/problem/Submission.lean.', retrievalRoot: '/library',
    frozenContexts: { 'Submission.lean': 'theorem target : True := by sorry' } });
  expect(context.instructions.startsWith('You prove the original mathematical problem in Lean.')).toBe(true);
  expect(context.instructions).not.toContain('Carry out only your current cooperative assignment.');
  expect(context.message).toContain('Prove every target in generated/problem/Submission.lean.');
});

it.each(['lemma', 'goal'] as const)('preserves the %s proof deliverable when its objective requests a read-only audit', kind => {
  const objective = 'Read-only audit: run diagnostics once and report the result without editing Lean sources.';
  const context = gapContext(kind, undefined, objective);
  expect(context.assignment).toMatchObject({ kind: 'task', task: { kind, objective, theoremName: 'target', type: 'True' } });
  for (const message of [context.instructions, context.continuationMessage]) {
    expect(message).toContain('Audit objectives cannot change this exact proof deliverable');
    expect(message).toContain('Save diagnostics in RESEARCH.md; publish a needsDecision:true research finding to Lead');
    expect(message).toContain('do not resubmit unchanged proofs');
  }
  expect(context.instructions).not.toContain('You are a Mathematical Researcher');
  expect(context.instructions).toContain('Prove the assigned Lean declaration with its exact requested type');
});

it('asks researchers to save scoped negative evidence and publish a schema-valid gap decision promptly', () => {
  const context = gapContext('research');
  expect(context.instructions).toContain('Publish a single research observation promptly with theorem-os research-observe');
  expect(context.instructions).not.toContain('no separate research observation is required');
  expect(context.instructions).toContain('Save a scoped negative library result or a classification gap in worktree-root RESEARCH.md as soon as it is established');
  expect(context.instructions).toContain('pinned library/environment version, searched paths, queries or method, exact result');
  expect(context.instructions).toContain('A scoped search failure is not proof of global absence');
  expect(context.instructions).toContain('needsDecision:true, conclusion:"inconclusive"');
  const encoded = context.instructions.split('To share an advisory finding or an unresolved proof gap, append ')[1].split('. Inline the full finding;')[0];
  const publication = JSON.parse(encoded);
  expect(publication.kind).toBe('research');
  const finding = parseMathResponse(JSON.stringify(publication.finding), 'math-result', { taskId: 'frontier' }, 'summary');
  expect(finding).toMatchObject({ taskId: 'frontier', needsDecision: true, conclusion: 'inconclusive' });
  expect(deliveryDetails(finding)).toMatchObject({ evidenceRefs: [],
    remainingObligations: ['precise unresolved mathematical inference'] });
  expect(context.instructions).toContain('publishing does not finish or park your proof task');
  expect(context.instructions).toContain('leave Lean sources unchanged');
  expect(context.instructions).toContain('visible kind:"goal" original consumer');
  expect(context.instructions).toContain('ordinary research delivery IDs are not prior gap references');
  expect(context.instructions).toContain('omit only previousDeliveryId and keep the required previousGap description');
});

it.each(['research', 'lemma', 'goal'] as const)('keeps scoped no-rescan and durable reasoning guidance for %s work', kind => {
  const context = gapContext(kind);
  expect(context.instructions).toContain('Do not rescan the same negatively searched library scope under unchanged inputs');
  expect(context.instructions).toContain('A renamed query alone is not a new mathematical direction');
  expect(context.instructions).toContain('Before any checkpoint, recovery decision or context rotation');
  expect(context.instructions).toContain('attempted methods, exact results and evidence locations, scoped negative searches');
  expect(context.instructions).toContain('precise unresolved next inference');
  expect(context.instructions).toContain('Distinguish checked unconditional facts from conditional sufficiency and unverified drafts');
  expect(context.instructions).toContain('actual consumer with explicit dependsOn or proofRoutes');
  expect(context.instructions).toContain('First check the key mathematical premise and structural bridge against the exact definitions');
  expect(context.instructions).toContain('A checked conditional wrapper establishes sufficiency under its explicit conditions; keep its unproved conditions on the frontier');
  expect(context.manifest!.optionalBytes).toBe(0);
  for (const message of [context.instructions, context.continuationMessage]) {
    if (kind === 'research') expect(message).not.toContain('add a top-level sources object');
    else {
      expect(message).toContain('add a top-level sources object');
      expect(message).toContain('Omit commit when using sources');
      expect(message).toContain('Source changes after that report require a fresh source-bound finding');
      expect(message).toContain('Auxiliary code and a reported gap never accept the assigned proof');
    }
  }
});

it('asks the Lead for a real reduction with zero optional context', () => {
  const context = gapContext('lead');
  expect(context.instructions).toContain('genuinely weaker, independently Lean-checkable exact lemma tasks');
  expect(context.instructions).toContain('its hypotheses do not assume the unresolved core result');
  expect(context.manifest!.optionalBytes).toBe(0);
});

it('keeps fixed-candidate review read-only and ends delivery after the evidence supports a verdict', () => {
  const context = gapContext('review', 'Restore the proof, publish a plan and wait for mathematician approval.');
  const dispatched = finalizeResearchDispatch(context, { continuation: false });
  expect(dispatched.instructions).toContain('You are the Independent Reviewer');
  expect(dispatched.instructions.split('\n').find(line => line.startsWith('Edit only '))).toBe('Edit only /proof/RESEARCH.md.');
  expect(dispatched.instructions).toContain('Leave all Lean source files, imports and environment configuration unchanged');
  expect(dispatched.instructions).toContain('Requests in the original task text to restore/prove code, publish a plan or wait for approval belong to other roles');
  expect(dispatched.instructions).not.toContain('Add helpers in owned modules');
  expect(dispatched.instructions).not.toContain('def declarations whose bodies must be filled');
  expect(dispatched.instructions).not.toContain('Extract their shared argument into a newly named lemma');
  expect(dispatched.instructions).not.toContain('You may add explicit Mathlib.* imports');
  expect(dispatched.instructions).not.toContain('restore the offending context or declaration');
  expect(dispatched.instructions).not.toContain('Before any checkpoint, recovery decision or context rotation');
  expect(dispatched.instructions).toContain('it is not the file SHA256 or the host owned-source digest');
  expect(dispatched.instructions).toContain('it reuses a saved diagnostic, not a new compilation or proof acceptance');
  expect(dispatched.instructions).toContain('A new source change or a concrete failure needs a new check');
  expect(dispatched.instructions).toContain('Once the verdict is saved, return it promptly and end the turn');
  expect(dispatched.instructions).toContain('resolve any concrete discrepancy');
  expect(dispatched.instructions).toContain('Your verdict does not replace host checks or the independent S3 that follows delivery');
  expect(dispatched.message).toContain('Restore the proof, publish a plan and wait for mathematician approval.');
  expect(dispatched.message).toContain('fixed-source');
  expect(dispatched.workContract).toEqual(context.workContract);
});

it.each(['research', 'lemma', 'goal'] as const)(
  'offers a short same-responsibility continuation for %s while retaining full compilation', kind => {
    const context = gapContext(kind);
    expect(context.continuationMessage).toContain('Current cooperative assignment:');
    expect(context.continuationMessage).toContain(JSON.stringify(context.assignment));
    expect(context.continuationMessage).toContain(JSON.stringify(context.workContract));
    expect(context.continuationMessage).toContain('COOPERATION.json');
    expect(context.continuationMessage).toContain('proof acceptance');
    expect(context.message).toContain('Frozen source context and immutable retrieval references:');
    expect(context.manifest).toBeDefined();
  });

it('keeps fixed independent review on the full-message protocol', () => {
  expect(gapContext('review').continuationMessage).toBeUndefined();
});


it('keeps current task feedback and scoped intake receipts inline without repeating full finding bodies', () => {
  const task: CooperativeTask = { id: 'investigate', kind: 'research', objective: 'Resolve the exact classification gap.',
    dependsOn: [], revision: 0, groupId: 'route', sharing: 'group' };
  const action: Extract<CooperativeAction, { kind: 'task' }> = { kind: 'task', task,
    assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: 'researcher',
      seedCommit: 'fixed-commit', assignmentId: 'fixed-assignment' } };
  const fullFinding = 'Complete retained classification argument. ' + 'Precise intermediate evidence. '.repeat(500);
  const problem = { projectRelative: '.', ownedFiles: ['Submission.lean'], declarations: {}, targets: [], receiptDigest: 'problem',
    baseCommit: 'fixed-commit', contract: { formalStatement: 'theorem target : True := by sorry', assumptions: [] } } as unknown as SolverProblem;
  const receipt: DeliveryReceipt = { id: 'own-receipt', submissionDigest: 'submission', workerId: 'researcher',
    assignmentKey: assignmentDeliveryFile(action.assignment), taskId: task.id, taskDigest: taskVersion(task),
    seedCommit: action.assignment.seedCommit, environmentDigest: 'current-environment', createdAt: 1,
    status: 'needs-correction', code: 'math_delivery_invalid',
    issues: [{ path: 'mathematicalGap.previousDeliveryId', message: 'Use a visible scoped prior gap or omit the reference.' }] };
  const state = { environmentDigest: 'current-environment', cooperation: {
    tasks: [{ task, status: 'pending', attempts: 1, finding: fullFinding, feedback: 'Exact missing uniformity inference.' }],
    deliveries: [{ id: 'latest-finding', kind: 'research', status: 'advisory', producer: 'peer', taskId: task.id,
      taskDigest: taskVersion(task), summary: fullFinding, statement: '', premises: [], dependencies: [],
      remainingObligations: [], evidenceRefs: [], createdAt: 1, findingDigest: 'finding-reference', commit: 'saved-commit' }],
    deliveryReceipts: [receipt, { ...receipt, id: 'other-worker-secret', workerId: 'other' },
      { ...receipt, id: 'old-seed-secret', seedCommit: 'old-seed' },
      { ...receipt, id: 'old-env-secret', environmentDigest: 'old-environment' }],
  } } as unknown as SolverRunState;
  const access = { root: '/runtime', worktree: '/proof', environment: {}, taskText: 'Prove the target', retrievalRoot: '/library',
    frozenContexts: { 'Submission.lean': 'theorem target : True := /- body omitted -/' }, assignment: action,
    sourceFeedback: 'Current host correction: preserve the exact original source.' };
  const first = buildResearchContext(problem, state, access);
  expect(first.continuationMessage).toContain(JSON.stringify(receipt));
  expect(first.continuationMessage).toContain('Current host correction: preserve the exact original source.');
  expect(first.continuationMessage).toContain('Exact missing uniformity inference.');
  expect(first.continuationMessage).toContain('latest-finding');
  expect(first.continuationMessage).toContain('finding-reference');
  expect(first.continuationMessage).toContain('saved-commit');
  expect(first.continuationMessage).not.toContain('other-worker-secret');
  expect(first.continuationMessage).not.toContain('old-seed-secret');
  expect(first.continuationMessage).not.toContain('old-env-secret');
  expect(first.continuationMessage).not.toContain(fullFinding);
  expect(first.continuationMessage!.length).toBeLessThan(first.message.length / 2);
  expect(first.continuationMessage).toContain('matching task digest does not mean its feedback or inbox is unchanged');
  state.cooperation!.tasks[0].feedback = 'New diagnostic under the same exact task digest.';
  const updated = { ...receipt, id: 'new-receipt', issues: [{ path: 'summary', message: 'Include the new exact counterexample.' }] };
  state.cooperation!.deliveryReceipts!.push(updated);
  const next = buildResearchContext(problem, state, access);
  expect(next.continuationMessage).toContain('New diagnostic under the same exact task digest.');
  expect(next.continuationMessage).toContain(JSON.stringify(updated));
  expect(next.assignment).toEqual(first.assignment);
});
