// Deterministic app-server peer: all tool requests go through the real adapter and
// host. It writes only its own worktree and never contacts a model or provider.
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const actor = process.env.DEEPSCIENTIST_MATH_WORKER_ID === 'solver'
  ? 'lead' : process.env.DEEPSCIENTIST_MATH_WORKER_ID;
const workspace = process.env.DEEPSCIENTIST_MATH_WORKER_WORKTREE;
const traceFile = path.join(workspace, '.scratch/agent-team-peer.jsonl');
fs.mkdirSync(path.dirname(traceFile), { recursive: true });
const trace = value => fs.appendFileSync(traceFile, JSON.stringify(value) + '\n');
const send = value => { trace({ direction: 'peer', ...value }); process.stdout.write(JSON.stringify(value) + '\n'); };
const pending = new Map();
let threadId = `peer-${actor}`, turnId, nextCall = 10000, cursor = 0;
const seen = [];
const initialResearch = 'Two complementary equality helpers supply the original equality; both helper claims remain unproved.';
const revisedResearch = 'The original target consumes fast then symmetric slow; check each exact helper before adoption.';

async function team(operation) {
  const requestId = ++nextCall;
  const result = new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject, operation }); });
  send({ id: requestId, method: 'item/tool/call', params: {
    threadId, turnId, callId: `call-${requestId}`, namespace: null, tool: 'theoremos_team', arguments: operation,
  } });
  return result;
}

async function until(predicate) {
  let snapshot = await team({ operation: 'poll', after: cursor });
  for (;;) {
    cursor = snapshot.cursor; seen.push(...snapshot.events);
    if (predicate(snapshot)) return snapshot;
    const failed = snapshot.workers.find(worker => worker.status === 'failed');
    if (failed) throw new Error('child-failed:' + JSON.stringify(failed));
    snapshot = await team({ operation: 'wait', after: cursor, timeoutMs: 5000 });
  }
}

function complete(stage, text, status = 'completed') {
  const factor = actor === 'lead' ? stage + 1 : 1;
  send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: {
    total: { inputTokens: 7 * factor, outputTokens: 3 * factor, totalTokens: 10 * factor },
    last: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
  } } });
  send({ method: 'item/completed', params: { threadId, turnId,
    item: { type: 'agentMessage', id: 'final', text } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } });
}

async function research(params) {
  const sourceFile = path.join(workspace, 'generated/problem/Submission.lean');
  const source = fs.readFileSync(sourceFile, 'utf8');
  // Read the actual pinned method and collaboration reference in every process.
  const skillRoot = path.join(workspace, '.agents/skills/theoremos-research');
  const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const reference = fs.readFileSync(path.join(skillRoot, 'references/parallel-work.md'), 'utf8');
  if (!skill.includes('theoremos_team') || !reference.includes('`inspect`')) throw new Error('pinned-team-skill-missing');
  trace({ observation: 'pinned-skill-read', actor });

  if (actor !== 'lead') {
    const input = params.input.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const assignment = JSON.parse(input.split('\n').find(line => line.startsWith('{"agentId":')));
    if (assignment.researchState?.revision !== 1 || assignment.researchState.summary !== initialResearch ||
        assignment.researchState.advisory !== true) throw new Error('published-research-missing-from-worker-assignment');
    trace({ observation: 'worker-received-research', actor, revision: assignment.researchState.revision });
    await team({ operation: 'message', agentId: 'lead', message: 'ready' });
    const current = await until(() => seen.some(event => event.kind === 'message' && event.text === 'prove-now'));
    if (current.researchState?.revision !== 2 || current.researchState.summary !== revisedResearch ||
        !seen.some(event => event.kind === 'research-updated' && event.to === actor))
      throw new Error('published-research-update-missing-from-worker-inbox');
    trace({ observation: 'worker-polled-current-research', actor, revision: current.researchState.revision });
    const name = actor === 'fast' ? 'fast' : 'slow';
    const type = actor === 'fast' ? '∀ n : Nat, n + 0 = n' : '∀ n : Nat, 0 + n = n';
    const helper = actor === 'fast'
      ? 'theorem fast (n : Nat) : n + 0 = n := by rfl\n'
      : 'theorem slow (n : Nat) : 0 + n = n := by exact Nat.zero_add n\n';
    fs.writeFileSync(sourceFile, source.replace('theorem original', helper + 'theorem original'));
    fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), `${actor}: exact helper source saved.\n`);
    const submitted = await team({ operation: 'submit', summary: `${name} helper proved.`,
      declarations: [{ file: 'Submission.lean', name: `Team.${name}`, type }] });
    if (submitted.status !== 'pending-writer-stop') throw new Error('submission-did-not-wait-for-stop');
    complete(0, `${name} source and declaration saved.`);
    return;
  }

  if (!source.includes('theorem fast')) {
    const publication = await team({ operation: 'publish', summary: initialResearch });
    if (publication.researchState?.revision !== 1 || publication.researchState.advisory !== true)
      throw new Error('research-publication-not-saved');
    await team({ operation: 'spawn', agentId: 'fast', message: 'Prove Team.fast; wait for prove-now.' });
    await team({ operation: 'spawn', agentId: 'slow', message: 'Prove Team.slow; wait for prove-now.' });
    await until(() => ['fast', 'slow'].every(id => seen.some(event => event.from === id && event.text === 'ready')));
    await team({ operation: 'publish', summary: revisedResearch });
    await team({ operation: 'message', agentId: 'fast', message: 'prove-now' });
    const snapshot = await until(state => state.deliveries.some(delivery => delivery.agentId === 'fast') &&
      state.workers.find(worker => worker.id === 'fast').tasks.some(task => task.researchArtifactId));
    if (snapshot.workers.find(worker => worker.id === 'slow').status !== 'running')
      throw new Error('slow-writer-did-not-overlap-fast-delivery');
    trace({ observation: 'fast-delivered-while-slow-running' });
    const delivery = snapshot.deliveries.find(item => item.agentId === 'fast');
    const inspected = await team({ operation: 'inspect', deliveryId: delivery.id });
    if (inspected.declarations[0].name !== 'Team.fast' || inspected.originalProblemAcceptance !== 'not-assessed')
      throw new Error('fast-delivery-interface-invalid');
    const task = snapshot.workers.find(worker => worker.id === 'fast').tasks.find(task => task.id === delivery.taskId);
    const reference = snapshot.researchArtifacts.find(artifact => artifact.id === task.researchArtifactId);
    if (!reference || reference.commit !== task.sourceCommit || Object.hasOwn(reference, 'path'))
      throw new Error('research-reference-not-bound-to-stopped-source');
    const firstPage = await team({ operation: 'inspect-research', artifactId: reference.id, offset: 0, limit: 9 });
    const secondPage = await team({ operation: 'inspect-research', artifactId: reference.id, offset: firstPage.notes.nextOffset });
    if (firstPage.commit !== task.sourceCommit || firstPage.advisory !== true || secondPage.advisory !== true ||
        firstPage.originalProblemAcceptance !== 'not-assessed' || firstPage.notes.nextOffset !== 9 ||
        firstPage.notes.text + secondPage.notes.text !== 'fast: exact helper source saved.\n')
      throw new Error('research-notes-pagination-invalid');
    trace({ observation: 'lead-inspected-research', artifactId: reference.id, taskId: task.id, commit: task.sourceCommit });
    await team({ operation: 'message', agentId: 'slow', message: 'prove-now' });
    await team({ operation: 'adopt', deliveryId: delivery.id });
    complete(0, 'Adopt fast and return to release the Lead writer.');
    return;
  }

  if (!source.includes('theorem slow')) {
    trace({ observation: 'lead-resumed-with-fast', threadId });
    const snapshot = await until(state => state.deliveries.some(delivery => delivery.agentId === 'slow'));
    const delivery = snapshot.deliveries.find(item => item.agentId === 'slow');
    const inspected = await team({ operation: 'inspect', deliveryId: delivery.id });
    if (inspected.declarations[0].name !== 'Team.slow') throw new Error('slow-delivery-interface-invalid');
    await team({ operation: 'adopt', deliveryId: delivery.id });
    complete(1, 'Adopt slow and return to release the Lead writer.');
    return;
  }

  trace({ observation: 'lead-resumed-with-both', threadId });
  fs.writeFileSync(sourceFile, source.replace('by sorry', 'by\n  exact Eq.trans (fast n) (Eq.symm (slow n))'));
  fs.appendFileSync(path.join(workspace, 'RESEARCH.md'), 'Original target consumes both checked child declarations.\n');
  complete(2, 'Original proof saved using both team helpers.');
}

const stream = readline.createInterface({ input: process.stdin });
stream.on('close', () => process.exit(0));
stream.on('line', line => {
  const call = JSON.parse(line), params = call.params || {};
  trace({ direction: 'host', ...call });
  if (!call.method && pending.has(call.id)) {
    const waiter = pending.get(call.id); pending.delete(call.id);
    try {
      if (!call.result?.success) throw new Error('tool-transport-failed:' + JSON.stringify(call));
      const value = JSON.parse(call.result.contentItems[0].text);
      if (!value.ok) throw new Error('team-operation-failed:' + JSON.stringify(value));
      if (waiter.operation.operation === 'message' && (value.delivery !== 'saved-inbox' ||
          !['queued', 'unavailable'].includes(value.notification))) throw new Error('message-acknowledgment-invalid');
      waiter.resolve(value);
    } catch (error) { waiter.reject(error); }
    return;
  }
  const reply = result => send({ id: call.id, result });
  // The injected nativeFileWatchFixture owns these connection-scoped calls.
  if (call.method === 'fs/watch' || call.method === 'fs/unwatch') return;
  if (call.method === 'initialize') return reply({});
  if (call.method === 'thread/start' || call.method === 'thread/resume') {
    threadId = params.threadId || threadId;
    if (call.method === 'thread/start') {
      const expected = actor === 'lead'
        ? ['spawn', 'assign', 'amend', 'finish', 'message', 'poll', 'wait', 'inspect', 'inspect-research', 'adopt', 'stop', 'publish', 'cancel', 'budget', 'resume', 'history', 'coordinate']
        : ['message', 'poll', 'wait', 'inspect', 'inspect-research', 'submit', 'yield', 'history', 'progress'];
      const tool = params.dynamicTools.find(tool => tool.name === 'theoremos_team');
      if (!tool || JSON.stringify(tool.inputSchema.properties.operation.enum.toSorted()) !== JSON.stringify(expected.toSorted()))
        throw new Error('role-operation-schema-mismatch');
    }
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
  if (call.method === 'turn/interrupt') {
    reply({}); complete(0, 'Interrupted by host.', 'interrupted'); return;
  }
  if (call.id !== undefined) reply({});
});
