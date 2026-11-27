// Deterministic app-server peer for a rejected declaration followed by a new
// assignment in the same native thread. All checks and integration stay real.
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline'), crypto = require('node:crypto');
const actor = process.env.DEEPSCIENTIST_MATH_WORKER_ID === 'solver'
  ? 'lead' : process.env.DEEPSCIENTIST_MATH_WORKER_ID;
const workspace = process.env.DEEPSCIENTIST_MATH_WORKER_WORKTREE;
const traceFile = path.join(workspace, '.scratch/agent-team-peer.jsonl');
fs.mkdirSync(path.dirname(traceFile), { recursive: true });
const trace = value => fs.appendFileSync(traceFile, JSON.stringify(value) + '\n');
const send = value => { trace({ direction: 'peer', ...value }); process.stdout.write(JSON.stringify(value) + '\n'); };
const pending = new Map();
let threadId = `followup-${actor}`, turnId, nextCall = 10000, cursor = 0;
const initialObjective = 'Use domain expert D011 (elementary-number-theory), references/domain-experts/number-theory.md#elementary-number-theory. Act as Lean Prover (prover). Prove Team.helper : ∀ n : Nat, n + 0 = n and submit the exact declaration.';
const correctionObjective = 'Use domain expert D011 (elementary-number-theory), references/domain-experts/number-theory.md#elementary-number-theory. Act as Lean Debugger (lean-debugger) and Lean Prover (prover). Correct the rejected Team.helper proof using its host Lean feedback; preserve its statement and submit the saved helper.';

function assert(condition, reason) { if (!condition) throw new Error(reason); }

async function team(operation) {
  const requestId = ++nextCall;
  const result = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject, operation }));
  send({ id: requestId, method: 'item/tool/call', params: {
    threadId, turnId, callId: `call-${requestId}`, namespace: null, tool: 'theoremos_team', arguments: operation,
  } });
  return result;
}

async function until(predicate) {
  let snapshot = await team({ operation: 'poll', after: cursor });
  for (;;) {
    cursor = snapshot.cursor;
    if (predicate(snapshot)) return snapshot;
    const failed = snapshot.workers.find(worker => worker.status === 'failed');
    if (failed) throw new Error('child-infrastructure-failed:' + JSON.stringify(failed));
    snapshot = await team({ operation: 'wait', after: cursor, timeoutMs: 5000 });
  }
}

function complete(stage, text, status = 'completed') {
  const factor = stage + 1;
  send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: {
    total: { inputTokens: 7 * factor, outputTokens: 3 * factor, totalTokens: 10 * factor },
    last: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
  } } });
  send({ method: 'item/completed', params: { threadId, turnId,
    item: { type: 'agentMessage', id: 'final', text } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } });
}

function checkRole(method, params) {
  const lead = actor === 'lead';
  const expected = lead ? ['spawn', 'assign', 'amend', 'finish', 'message', 'poll', 'wait', 'inspect', 'inspect-research', 'adopt', 'stop', 'publish', 'cancel', 'budget', 'resume', 'history', 'retire_route', 'route_summary']
    : ['message', 'poll', 'wait', 'inspect', 'inspect-research', 'submit', 'yield', 'history', 'progress', 'route_summary'];
  const identity = lead ? 'You are the Lead of an Agent-organized research team; your agentId is lead.'
    : `You are a mathematical researcher and Lean proof writer; your agentId is ${JSON.stringify(actor)}, and your coordinator is lead.`;
  assert(params.developerInstructions.includes(identity), 'current-developer-identity-missing');
  if (!lead) assert(!params.developerInstructions.includes('You are the Lead'), 'worker-received-lead-identity');
  assert(params.config['features.multi_agent'] === false && params.config['features.multi_agent_v2'] === false,
    'native-unmanaged-delegation-enabled');
  if (method === 'thread/start') {
    const tool = params.dynamicTools.find(tool => tool.name === 'theoremos_team');
    assert(tool && JSON.stringify(tool.inputSchema.properties.operation.enum.toSorted()) === JSON.stringify(expected.toSorted()),
      'role-operation-schema-mismatch');
    assert(lead ? tool.inputSchema.properties.summary && !tool.inputSchema.properties.declarations
      : !tool.inputSchema.properties.targetId && tool.inputSchema.properties.summary && tool.inputSchema.properties.declarations,
    'role-parameter-schema-mismatch');
  } else assert(!params.dynamicTools, 'resume-redeclared-native-tools');
  trace({ observation: 'native-role-bound', actor, method, threadId, operations: expected });
}

async function research(params) {
  const sourceFile = path.join(workspace, 'generated/problem/Submission.lean');
  const source = fs.readFileSync(sourceFile, 'utf8');
  const skillRoot = path.join(workspace, '.agents/skills/theoremos-research');
  assert(fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8').includes('theoremos_team') &&
    fs.readFileSync(path.join(skillRoot, 'references/parallel-work.md'), 'utf8').includes('`inspect`'),
  'pinned-team-skill-missing');
  const roleGuide = fs.readFileSync(path.join(skillRoot, 'references/team-roles.md'));
  trace({ observation: 'team-role-guide-read', actor, bytes: roleGuide.length });
  for (const resource of ['references/domain-experts.md', 'references/domain-experts/number-theory.md',
    'references/domain-materials.md', 'references/domain-materials/number-theory.md']) {
    const content = fs.readFileSync(path.join(skillRoot, resource));
    trace({ observation: 'domain-expert-resource-read', actor, expertId: 'D011', resource,
      sha256: crypto.createHash('sha256').update(content).digest('hex') });
  }
  trace({ observation: 'pinned-skill-read', actor });

  if (actor !== 'lead') {
    const text = params.input.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const line = text.split('\n').find(line => line.startsWith('{"agentId":'));
    assert(line, 'current-worker-assignment-missing');
    const assignment = JSON.parse(line);
    assert(assignment.agentId === actor && assignment.coordinator === 'lead' && assignment.taskId === turnId,
      'current-worker-assignment-binding-mismatch');
    const checkpoint = path.join(workspace, '.scratch/first-followup-assignment.json');
    let stage = 0, updated;
    if (!assignment.previousTask) {
      assert(assignment.objective === initialObjective && !source.includes('theorem helper'), 'initial-assignment-mismatch');
      assert(assignment.deliveryBaseCommit === assignment.sourceCommit, 'initial-delivery-base-mismatch');
      fs.writeFileSync(checkpoint, JSON.stringify(assignment));
      updated = source.replace('theorem original',
        'theorem helper (n : Nat) : n + 0 = n := by exact Nat.succ_ne_zero n\ntheorem original');
    } else {
      stage = 1;
      const previous = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
      assert(assignment.objective === correctionObjective && assignment.taskId !== previous.taskId,
        'followup-did-not-replace-task');
      assert(assignment.previousTask.id === previous.taskId && assignment.previousTask.status === 'failed' &&
        assignment.previousTask.error.includes('math_declaration_artifact_check_failed:Team.helper:') &&
        /type mismatch/iu.test(assignment.previousTask.error), 'own-lean-rejection-feedback-missing');
      assert(assignment.deliveryBaseCommit === previous.deliveryBaseCommit &&
        assignment.sourceCommit !== assignment.deliveryBaseCommit && source.includes('by exact Nat.succ_ne_zero n'),
      'followup-lost-rejected-draft-or-delivery-base');
      updated = source.replace('by exact Nat.succ_ne_zero n', 'by rfl');
      trace({ observation: 'worker-followup-context', threadId, assignment });
    }
    trace({ observation: 'worker-current-task', threadId, stage, assignment });
    fs.writeFileSync(sourceFile, updated);
    fs.appendFileSync(path.join(workspace, 'RESEARCH.md'), `${stage ? 'Corrected' : 'Candidate'} Team.helper source saved.\n`);
    const submitted = await team({ operation: 'submit', summary: stage ? 'Corrected helper proved.' : 'Candidate helper submitted.',
      declarations: [{ file: 'Submission.lean', name: 'Team.helper', type: '∀ n : Nat, n + 0 = n' }] });
    assert(submitted.status === 'pending-writer-stop' && submitted.taskId === assignment.taskId,
      'submission-not-bound-to-current-task');
    complete(stage, stage ? 'Corrected helper ready for independent checking.' : 'Candidate helper ready for host checking.');
    return;
  }

  if (!source.includes('theorem helper')) {
    const spawned = await team({ operation: 'spawn', agentId: 'child', message: initialObjective });
    const rejected = await until(snapshot => snapshot.workers.some(worker =>
      worker.id === 'child' && worker.tasks.some(task => task.id === spawned.taskId && task.status === 'failed')));
    const failure = rejected.workers.find(worker => worker.id === 'child').tasks.find(task => task.id === spawned.taskId);
    assert(rejected.deliveries.length === 0 && failure.error.includes('math_declaration_artifact_check_failed:Team.helper:') &&
      /type mismatch/iu.test(failure.error), 'candidate-not-rejected-by-real-lean');
    const assigned = await team({ operation: 'assign', agentId: 'child', message: correctionObjective });
    assert(assigned.taskId !== spawned.taskId, 'followup-reused-task-id');
    trace({ observation: 'lead-assigned-correction', failedTaskId: spawned.taskId, taskId: assigned.taskId, error: failure.error });
    const corrected = await until(snapshot => snapshot.deliveries.some(delivery =>
      delivery.agentId === 'child' && delivery.taskId === assigned.taskId));
    const delivery = corrected.deliveries.find(delivery => delivery.taskId === assigned.taskId);
    const inspected = await team({ operation: 'inspect', deliveryId: delivery.id });
    assert(inspected.taskId === assigned.taskId && inspected.declarations[0].name === 'Team.helper' &&
      inspected.artifacts[0].proof.verification.status === 'kernel_verified' &&
      inspected.originalProblemAcceptance === 'not-assessed', 'corrected-delivery-not-independently-checked');
    trace({ observation: 'lead-inspected-corrected-helper', deliveryId: inspected.id, taskId: inspected.taskId });
    await team({ operation: 'adopt', deliveryId: delivery.id });
    complete(0, 'Adopt corrected helper and return to release the Lead writer.');
    return;
  }

  assert(source.includes('theorem helper (n : Nat) : n + 0 = n := by rfl'), 'lead-resumed-with-wrong-helper');
  trace({ observation: 'lead-resumed-with-corrected-helper', threadId });
  fs.writeFileSync(sourceFile, source.replace('by sorry', 'by\n  exact helper n'));
  fs.appendFileSync(path.join(workspace, 'RESEARCH.md'), 'Original target uses the corrected, checked and adopted helper.\n');
  complete(1, 'Original proof saved using the corrected team helper.');
}

const stream = readline.createInterface({ input: process.stdin });
stream.on('close', () => process.exit(0));
stream.on('line', line => {
  const call = JSON.parse(line), params = call.params || {};
  trace({ direction: 'host', ...call });
  if (!call.method && pending.has(call.id)) {
    const waiter = pending.get(call.id); pending.delete(call.id);
    try {
      assert(call.result?.success, 'tool-transport-failed:' + JSON.stringify(call));
      const value = JSON.parse(call.result.contentItems[0].text);
      assert(value.ok, 'team-operation-failed:' + JSON.stringify(value));
      if (waiter.operation.operation === 'message') assert(value.delivery === 'saved-inbox' &&
        ['queued', 'unavailable'].includes(value.notification), 'message-acknowledgment-invalid');
      waiter.resolve(value);
    } catch (error) { waiter.reject(error); }
    return;
  }
  const reply = result => send({ id: call.id, result });
  // The injected nativeFileWatchFixture owns these connection-scoped calls.
  if (call.method === 'fs/watch' || call.method === 'fs/unwatch') return;
  try {
    if (call.method === 'initialize') return reply({});
    if (call.method === 'thread/start' || call.method === 'thread/resume') {
      threadId = params.threadId || threadId;
      checkRole(call.method, params);
      return reply({ thread: { id: threadId }, model: params.model, modelProvider: params.config.model_provider,
        reasoningEffort: params.config.model_reasoning_effort, approvalPolicy: 'never',
        activePermissionProfile: { id: 'math-worker' } });
    }
    if (call.method === 'skills/list') return reply({ data: [{ cwd: workspace, errors: [], skills: [{
      name: 'theoremos-research', enabled: true,
      path: path.join(workspace, '.agents/skills/theoremos-research/SKILL.md'),
    }] }] });
    if (call.method === 'turn/start') {
      turnId = params.clientUserMessageId; reply({ turn: { id: turnId } });
      send({ method: 'item/started', params: { threadId, turnId, item: { type: 'reasoning', id: 'research' } } });
      void research(params).catch(error => {
        process.stderr.write(String(error.stack || error) + '\n');
        trace({ observation: 'peer-error', error: String(error) }); complete(0, String(error), 'failed');
      });
      return;
    }
    if (call.method === 'turn/interrupt') { reply({}); complete(0, 'Interrupted by host.', 'interrupted'); return; }
    if (call.id !== undefined) reply({});
  } catch (error) {
    trace({ observation: 'peer-error', error: String(error) });
    if (call.id !== undefined) send({ id: call.id, error: { code: -32000, message: String(error) } });
  }
});
