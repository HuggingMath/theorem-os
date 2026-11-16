// Deterministic protocol peer. Its only HTTP request goes to the adapter's local relay;
// tests replace the relay's upstream fetch with fixed bytes. This is not a model.
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const directory = process.env.THEOREMOS_COMPARISON_FIXTURE_ROOT;
const variant = process.env.THEOREMOS_COMPARISON_FIXTURE_VARIANT || 'complete';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const stream = readline.createInterface({ input: process.stdin });
stream.on('close', () => process.exit(0));
let settings, workspace;
stream.on('line', async line => {
  const call = JSON.parse(line), params = call.params || {};
  fs.appendFileSync(path.join(directory, 'protocol.jsonl'), JSON.stringify({ method: call.method,
    turnId: params.clientUserMessageId, workspace: params.cwd }) + '\n');
  const reply = result => send({ id: call.id, result });
  if (call.method === 'initialize') return reply({});
  if (call.method === 'thread/start') {
    settings = params; workspace = params.cwd;
    return reply({ thread: { id: 'comparison-fixture-thread' }, model: params.model,
      modelProvider: params.config.model_provider, reasoningEffort: params.config.model_reasoning_effort,
      approvalPolicy: params.approvalPolicy, activePermissionProfile: { id: params.config.default_permissions } });
  }
  if (call.method === 'skills/list') return reply({ data: [{ cwd: workspace, errors: [], skills: [{
    name: 'theoremos-research', enabled: true,
    path: path.join(workspace, '.agents/skills/theoremos-research/SKILL.md') }] }] });
  if (call.method !== 'turn/start') return;
  const turnId = params.clientUserMessageId, threadId = 'comparison-fixture-thread';
  reply({ turn: { id: turnId } });
  const response = await fetch(settings.config['model_providers.sub2api.base_url'] + '/responses', {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: 'Bearer ' + process.env.THEOREM_OS_MODEL_RELAY_CAPABILITY },
    body: JSON.stringify({ model: params.model, reasoning: { effort: params.effort },
      stream: true, store: false, input: 'Disposable protocol fixture.' }) });
  await response.text();
  if (variant === 'crash') process.exit(3);
  if (variant !== 'done-only') {
    const first = variant === 'changed-type'
      ? 'theorem comparison_add_zero (n : Nat) : n = n := by rfl\n'
      : 'theorem comparison_add_zero (n : Nat) : n + 0 = n := by rfl\n';
    fs.writeFileSync(path.join(workspace, 'generated/problem/Submission.lean'), first +
      (variant === 'partial' ? 'theorem comparison_keep (p : Prop) (h : p) : p := by sorry\n'
        : 'theorem comparison_keep (p : Prop) (h : p) : p := by exact h\n'));
    fs.appendFileSync(path.join(workspace, 'RESEARCH.md'), 'Disposable protocol proof saved.\n');
  }
  if (variant === 'crash-after-write') process.exit(3);
  send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'fixture-tool', type: 'commandExecution',
    command: 'fixture local write', exitCode: 0, aggregatedOutput: 'Fixture delivery complete.' } } });
  // Native aggregate counters deliberately disagree; the request receipt is the charged source.
  send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId,
    tokenUsage: { total: { totalTokens: 999 }, last: { totalTokens: 999 } } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
});
