// Local deterministic app-server: native RPC, process isolation, source freezing,
// declaration checks and final acceptance all remain in the actual runtime.
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline'), crypto = require('node:crypto');
const actor = process.env.DEEPSCIENTIST_MATH_WORKER_ID === 'solver' ? 'lead' : process.env.DEEPSCIENTIST_MATH_WORKER_ID;
const workspace = process.env.DEEPSCIENTIST_MATH_WORKER_WORKTREE;
const traceFile = path.join(workspace, '.scratch/agent-team-peer.jsonl');
fs.mkdirSync(path.dirname(traceFile), { recursive: true });
const trace = value => fs.appendFileSync(traceFile, JSON.stringify(value) + '\n');
const send = value => { trace({ direction: 'peer', ...value }); process.stdout.write(JSON.stringify(value) + '\n'); };
const pending = new Map();
let threadId = `handoff-${actor}`, turnId, nextCall = 10000, cursor = 0;
const helper = 'theorem dependency (n : Nat) : n + 0 = n := by rfl\n';
const draft = 'theorem combined (n : Nat) : n + 0 = n := by\n  exact dependency n\n';
const consumerObjective = 'Retain a draft of Team.combined using Team.dependency, yield for its checked adoption, then resume this same task and submit only your own declaration.';
const resumeMessage = 'The peer dependency has been checked and adopted; continue the same saved task.';
const assert = (condition, reason) => { if (!condition) throw new Error(reason); };

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
    const failed = snapshot.workers.find(worker => worker.status === 'failed' || worker.tasks.some(task => task.status === 'failed'));
    if (failed) throw new Error('unexpected-handoff-worker-failure:' + JSON.stringify(failed));
    snapshot = await team({ operation: 'wait', after: cursor, timeoutMs: 5000 });
  }
}

function complete(stage, text, status = 'completed') {
  const factor = stage + 1;
  send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: {
    total: { inputTokens: 7 * factor, outputTokens: 3 * factor, totalTokens: 10 * factor },
    last: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
  } } });
  send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'final', text } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } });
}

function checkRole(method, params) {
  const expected = actor === 'lead'
    ? ['spawn', 'assign', 'amend', 'finish', 'message', 'poll', 'wait', 'inspect', 'inspect-research', 'adopt', 'stop', 'publish', 'cancel', 'budget', 'resume', 'history', 'coordinate', 'retire_route', 'route_summary']
    : ['message', 'poll', 'wait', 'inspect', 'inspect-research', 'submit', 'submit_helpers', 'yield', 'history', 'progress', 'route_summary'];
  assert(params.config['features.multi_agent'] === false && params.config['features.multi_agent_v2'] === false,
    'native-unmanaged-delegation-enabled');
  if (method === 'thread/start') {
    const tool = params.dynamicTools.find(tool => tool.name === 'theoremos_team');
    assert(tool && JSON.stringify(tool.inputSchema.properties.operation.enum.toSorted()) === JSON.stringify(expected.toSorted()),
      'handoff-role-operation-schema-mismatch');
  } else assert(!params.dynamicTools, 'handoff-resume-redeclared-native-tools');
  trace({ observation: 'handoff-native-role-bound', actor, method, threadId, operations: expected });
}

async function research(params) {
  const sourceFile = path.join(workspace, 'generated/problem/Submission.lean');
  const source = fs.readFileSync(sourceFile, 'utf8');
  const skillRoot = path.join(workspace, '.agents/skills/theoremos-research');
  const reference = fs.readFileSync(path.join(skillRoot, 'references/parallel-work.md'), 'utf8');
  assert(reference.includes('`yield`') && reference.includes('`resume`') && reference.includes('`history`'), 'handoff-skill-interface-missing');

  if (actor !== 'lead') {
    const input = params.input.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const assignment = JSON.parse(input.split('\n').find(line => line.startsWith('{"agentId":')));
    assert(assignment.taskId === params.clientUserMessageId && assignment.agentId === actor, 'handoff-assignment-binding-changed');
    const history = await team({ operation: 'history', agentId: actor, offset: 0, limit: 1 });
    assert(history.total === 1 && history.nextOffset === null && history.tasks[0].id === assignment.taskId &&
      history.tasks[0].objective === assignment.objective, 'handoff-worker-history-incomplete');
    trace({ observation: 'handoff-worker-history', actor, taskId: assignment.taskId, history });

    if (actor === 'producer') {
      fs.writeFileSync(sourceFile, source.replace('theorem original', helper + 'theorem original'));
      fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), 'The dependency declaration is ready for fresh host checking.\n');
      await team({ operation: 'submit', summary: 'Peer dependency proved.', declarations: [
        { file: 'Submission.lean', name: 'Team.dependency', type: '∀ n : Nat, n + 0 = n' },
      ] });
      complete(0, 'Peer helper saved and submitted.'); return;
    }

    const checkpointFile = path.join(workspace, '.scratch/handoff-first-assignment.json');
    if (!fs.existsSync(checkpointFile)) {
      assert(assignment.objective === consumerObjective && !source.includes('theorem dependency'), 'handoff-initial-consumer-context-invalid');
      fs.writeFileSync(sourceFile, source.replace('end Team', draft + 'end Team'));
      fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), 'The retained combined draft awaits checked Team.dependency.\n');
      fs.writeFileSync(checkpointFile, JSON.stringify({ assignment, threadId, turnId, draft }));
      await team({ operation: 'message', agentId: 'lead', message: 'My saved draft needs the peer dependency before I can finish.' });
      const yielded = await team({ operation: 'yield', reason: 'Need the checked peer dependency while preserving this draft and task.' });
      assert(yielded.status === 'pending-writer-stop' && yielded.taskId === assignment.taskId, 'handoff-yield-did-not-await-writer-stop');
      trace({ observation: 'consumer-yield-requested', taskId: assignment.taskId, threadId, turnId,
        deliveryBaseCommit: assignment.deliveryBaseCommit });
      complete(0, 'Saved the blocked draft and yielded for peer adoption.'); return;
    }

    const first = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
    assert(assignment.taskId === first.assignment.taskId && threadId === first.threadId && turnId !== first.turnId,
      'handoff-resume-lost-task-or-thread-identity');
    assert(assignment.deliveryBaseCommit === first.assignment.deliveryBaseCommit && source.includes(first.draft) && source.includes(helper),
      'handoff-resume-lost-draft-peer-or-source-baseline');
    assert(assignment.inbox.events.some(event => event.kind === 'message' && event.text === resumeMessage),
      'handoff-resume-missed-saved-inbox');
    assert(history.tasks[0].turns === 2 && history.tasks[0].budget.turns === 2, 'handoff-task-allowance-was-reset');
    fs.appendFileSync(path.join(workspace, 'RESEARCH.md'), 'Resumed the same task after adoption; the retained combined draft now uses its checked dependency.\n');
    const declarations = [{ file: 'Submission.lean', name: 'Team.combined', type: '∀ n : Nat, n + 0 = n' }];
    const submitted = await team({ operation: 'submit', summary: 'The retained combined draft is complete.', declarations });
    assert(submitted.taskId === assignment.taskId && submitted.status === 'pending-writer-stop', 'handoff-resumed-submission-unbound');
    trace({ observation: 'consumer-resumed-and-submitted-own-declaration', taskId: assignment.taskId,
      threadId, turnId, assignment, declarations });
    complete(1, 'The same task submitted only its own combined declaration.'); return;
  }

  if (!source.includes('theorem combined')) {
    await team({ operation: 'publish', summary: 'Producer checks the dependency while consumer retains its dependent draft across an explicit handoff.' });
    const reserve = await team({ operation: 'budget', leadReserve: { tokens: 50, turns: 2 } });
    assert(reserve.budget.leadReserve.tokens === 50 && reserve.budget.leadReserve.turns === 2, 'handoff-lead-reserve-not-projected');
    const consumer = await team({ operation: 'spawn', agentId: 'consumer', message: consumerObjective, budget: { tokens: 100, turns: 1 } });
    await team({ operation: 'spawn', agentId: 'producer', message: 'Prove and submit Team.dependency as a checked equality helper.',
      budget: { tokens: 100, turns: 1 } });
    const paused = await until(snapshot => snapshot.workers.find(worker => worker.id === 'consumer')?.tasks
      .some(task => task.id === consumer.taskId && task.status === 'paused') && snapshot.deliveries.some(delivery => delivery.agentId === 'producer'));
    const history = await team({ operation: 'history', agentId: 'consumer', offset: 0, limit: 1 });
    assert(history.tasks[0].id === consumer.taskId && history.tasks[0].status === 'paused' &&
      history.tasks[0].objective === consumerObjective && history.tasks[0].sourceCommit, 'handoff-paused-history-invalid');
    trace({ observation: 'lead-observed-paused-draft', taskId: consumer.taskId, history });
    const peer = paused.deliveries.find(delivery => delivery.agentId === 'producer');
    await team({ operation: 'inspect', deliveryId: peer.id });
    await team({ operation: 'adopt', deliveryId: peer.id, targetId: 'consumer' });
    const integrated = await until(snapshot => snapshot.adoptions.some(adoption =>
      adoption.deliveryId === peer.id && adoption.targetId === 'consumer' && adoption.status === 'completed'));
    assert(integrated.workers.find(worker => worker.id === 'consumer').tasks[0].status === 'paused', 'handoff-adoption-resumed-without-lead');
    const allowance = await team({ operation: 'budget', agentId: 'consumer', taskId: consumer.taskId, budget: { tokens: 100, turns: 2 } });
    assert(allowance.budget.task.id === consumer.taskId && allowance.budget.task.used.turns === 1 &&
      allowance.budget.task.remaining.turns === 1, 'handoff-budget-update-reset-task-use');
    await team({ operation: 'message', agentId: 'consumer', message: resumeMessage, relatedTaskId: consumer.taskId });
    const resumed = await team({ operation: 'resume', agentId: 'consumer', taskId: consumer.taskId });
    assert(resumed.taskId === consumer.taskId, 'handoff-resume-created-another-task');
    trace({ observation: 'lead-resumed-same-consumer-task', taskId: consumer.taskId, budget: allowance.budget });
    const completed = await until(snapshot => snapshot.deliveries.some(delivery => delivery.agentId === 'consumer'));
    const delivery = completed.deliveries.find(delivery => delivery.agentId === 'consumer');
    const inspected = await team({ operation: 'inspect', deliveryId: delivery.id });
    assert(JSON.stringify(inspected.declarations.map(item => item.name).toSorted()) === JSON.stringify(['Team.combined', 'Team.dependency']),
      'handoff-host-did-not-carry-peer-declarations');
    assert(inspected.artifacts.every(artifact => artifact.proof.verification.status === 'kernel_verified') &&
      inspected.originalProblemAcceptance === 'not-assessed', 'handoff-combined-delivery-not-freshly-checked');
    trace({ observation: 'lead-inspected-carried-peer', taskId: consumer.taskId, deliveryId: delivery.id,
      declarations: inspected.declarations });
    await team({ operation: 'adopt', deliveryId: delivery.id });
    complete(0, 'Adopt the checked combined delivery and release the Lead writer.'); return;
  }

  assert(source.includes(helper) && source.includes(draft), 'handoff-lead-adoption-lost-either-declaration');
  const original = 'theorem original (n : Nat) : n + 0 = n := by sorry\n';
  assert(source.includes(original), 'handoff-frozen-original-missing');
  // The retained draft follows the original target; put its consumer after the
  // adopted declaration before asking the independent checker to accept it.
  fs.writeFileSync(sourceFile, source.replace(original, '').replace('end Team',
    original.replace('by sorry', 'by\n  exact combined n') + 'end Team'));
  fs.appendFileSync(path.join(workspace, 'RESEARCH.md'), 'Original target completed using the resumed consumer declaration.\n');
  trace({ observation: 'handoff-lead-proved-original', threadId });
  complete(1, 'Original proof uses the adopted consumer declaration.');
}

const stream = readline.createInterface({ input: process.stdin });
stream.on('close', () => process.exit(0));
stream.on('line', line => {
  const call = JSON.parse(line), params = call.params || {};
  trace({ direction: 'host', ...call });
  if (!call.method && pending.has(call.id)) {
    const waiter = pending.get(call.id); pending.delete(call.id);
    try {
      assert(call.result?.success, 'handoff-tool-transport-failed:' + JSON.stringify(call));
      const value = JSON.parse(call.result.contentItems[0].text);
      assert(value.ok, 'handoff-team-operation-failed:' + JSON.stringify(value));
      if (waiter.operation.operation === 'message') assert(value.delivery === 'saved-inbox' &&
        ['queued', 'unavailable'].includes(value.notification), 'handoff-message-acknowledgment-invalid');
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
      threadId = params.threadId || threadId; checkRole(call.method, params);
      return reply({ thread: { id: threadId }, model: params.model, modelProvider: params.config.model_provider,
        reasoningEffort: params.config.model_reasoning_effort, approvalPolicy: 'never', activePermissionProfile: { id: 'math-worker' } });
    }
    if (call.method === 'skills/list') return reply({ data: [{ cwd: workspace, errors: [], skills: [{
      name: 'theoremos-research', enabled: true, path: path.join(workspace, '.agents/skills/theoremos-research/SKILL.md'),
    }] }] });
    if (call.method === 'turn/start') {
      turnId = `handoff-${actor}-${crypto.randomUUID()}`; reply({ turn: { id: turnId } });
      send({ method: 'item/started', params: { threadId, turnId, item: { type: 'reasoning', id: 'research' } } });
      void research(params).catch(error => {
        process.stderr.write(String(error.stack || error) + '\n'); trace({ observation: 'peer-error', error: String(error) });
        complete(0, String(error), 'failed');
      }); return;
    }
    if (call.method === 'turn/interrupt') { reply({}); complete(0, 'Interrupted by host.', 'interrupted'); return; }
    if (call.id !== undefined) reply({});
  } catch (error) {
    trace({ observation: 'peer-error', error: String(error) });
    if (call.id !== undefined) send({ id: call.id, error: { code: -32000, message: String(error) } });
  }
});
