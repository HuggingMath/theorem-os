#!/usr/bin/env node
// Disposable native-protocol peer. This executes deterministic tutorial actions,
// never contacts a model, and never supplies proof acceptance to the host.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const argument = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const harness = process.env.CLAUDE_CONFIG_DIR ? 'claude-code' : process.env.OPENCODE_CONFIG_CONTENT ? 'opencode' : 'cli';
const profile = process.env.CLAUDE_CONFIG_DIR || (harness === 'opencode'
  ? path.dirname(path.dirname(process.env.XDG_DATA_HOME)) : argument('--profile'));
const worker = process.env.DEEPSCIENTIST_MATH_WORKER_ID;
const scenario = JSON.parse(fs.readFileSync(path.join(profile, 'portable-fixture.json'), 'utf8'));
const calls = path.join(profile, 'portable-native-calls.jsonl');

function execute(sessionId) {
  const root = process.cwd();
  const cooperation = JSON.parse(fs.readFileSync(path.join(root, 'COOPERATION.json'), 'utf8'));
  const action = cooperation.agents.find(agent => agent.id === worker)?.work;
  if (!action) throw new Error('fixture_missing_host_assignment:' + worker);
  const skill = fs.readFileSync(path.join(root, '.agents/skills/theoremos-research/SKILL.md'));
  fs.appendFileSync(calls, JSON.stringify({ worker, kind: action.kind, taskId: action.taskId, sessionId,
    pid: process.pid, skillSha256: crypto.createHash('sha256').update(skill).digest('hex') }) + '\n');
  if (action.kind === 'lead') {
    const tasks = cooperation.tasks.length ? cooperation.tasks.filter(node => !node.capacityExploration).map(node => node.task)
      : scenario.tasks;
    fs.writeFileSync(path.join(root, 'RESEARCH.md'), 'Deterministic isolated tutorial plan.\n\n```math-plan\n' +
      JSON.stringify({ tasks }) + '\n```\n');
  } else if (action.kind === 'task') {
    const assignment = cooperation.researchDelivery?.assignment;
    if (!assignment || assignment.taskId !== action.taskId || assignment.workerId !== worker)
      throw new Error('fixture_assignment_identity_mismatch');
    const task = cooperation.tasks.find(node => node.task.id === action.taskId)?.task;
    if (!task || task.kind !== 'goal') throw new Error('fixture_expected_original_goal');
    const file = path.join(root, cooperation.researchDelivery.projectRelative, task.proofPath);
    const name = task.theoremName.split('.').at(-1);
    const pattern = new RegExp('(theorem ' + name + '[^\\n]*:=)[^\\n]*');
    const before = fs.readFileSync(file, 'utf8');
    const proof = scenario.invalid && name === 'zero_add' ? 'by rfl' : scenario.proofs[task.theoremName];
    if (!proof || !pattern.test(before)) throw new Error('fixture_missing_frozen_goal');
    fs.writeFileSync(file, before.replace(pattern, (_match, prefix) => prefix + ' ' + proof));
    fs.writeFileSync(path.join(root, 'RESEARCH.md'), 'Saved only the assigned tutorial goal; host verification remains required.\n');
    const scratch = path.join(root, '.scratch'); fs.mkdirSync(scratch, { recursive: true });
    const writer = spawn(process.execPath, ['-e',
      'setInterval(() => require("node:fs").appendFileSync(process.argv[1], "late write\\n"), 10)',
      path.join(scratch, 'portable-background.txt')], { detached: true, stdio: 'ignore' });
    writer.unref();
  } else if (action.kind === 'review') {
    fs.writeFileSync(path.join(root, 'RESEARCH.md'), JSON.stringify({ verdict: 'accepted',
      summary: 'Reviewed the fixed tutorial candidate; the host Lean evidence determines acceptance.', evidenceRefs: [] }) + '\n');
  } else throw new Error('fixture_unexpected_assignment:' + action.kind);
}

if (harness === 'opencode') {
  const configuration = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  const [providerID, modelID] = configuration.model.split('/');
  const file = path.join(profile, 'portable-opencode-' + worker + '.json');
  const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { sessions: {} };
  const write = value => fs.writeFileSync(file, JSON.stringify(value));
  const streams = new Set();
  const emit = event => { for (const response of streams) response.write('data: ' + JSON.stringify(event) + '\n\n'); };
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== 'Basic ' + Buffer.from('theoremos:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64'))
      return response.writeHead(401).end();
    const route = new URL(request.url, 'http://local').pathname;
    let text = ''; for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (route === '/provider') return json({ all: [{ id: providerID, models: { [modelID]: {
      id: modelID, providerID, variants: { high: {} } } } }] });
    if (route === '/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: {"type":"server.connected","properties":{}}\n\n');
      streams.add(response); response.on('close', () => streams.delete(response)); return;
    }
    const state = read();
    if (route === '/session' && request.method === 'POST') {
      const session = { id: 'ses_' + crypto.randomUUID().replaceAll('-', ''), directory: process.cwd(),
        agent: body.agent, model: body.model, messages: [] };
      state.sessions[session.id] = session; write(state); return json(session);
    }
    const match = route.match(/^\/session\/([^/]+)(.*)$/), session = match && state.sessions[match[1]];
    if (!session) return json({}, 404);
    if (!match[2]) return json(session);
    if (match[2] === '/abort') return json(true);
    if (match[2] !== '/message') return json({}, 404);
    if (request.method === 'GET') return json(session.messages);
    execute(session.id);
    const info = { id: body.messageID + '-assistant', sessionID: session.id, role: 'assistant', parentID: body.messageID,
      providerID, modelID, time: { created: 1, completed: 2 },
      tokens: { input: 11, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } };
    const part = { id: body.messageID + '-text', sessionID: session.id, messageID: info.id, type: 'text',
      text: 'Saved deterministic tutorial work for independent host checking.', time: { start: 1, end: 2 } };
    emit({ type: 'message.updated', properties: { info } });
    emit({ type: 'message.part.updated', properties: { part } });
    const result = { info, parts: [part] }; session.messages.push(result); write(state); json(result);
  });
  const port = Number(args.find(value => value.startsWith('--port='))?.slice(7));
  server.listen(port, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + server.address().port));
} else {
  let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { prompt += chunk; });
  process.stdin.on('end', () => {
    const session = argument('--resume') || argument('--session-id');
    if (!prompt || !session) throw new Error('fixture_native_request_missing');
    if (harness === 'claude-code') {
      const send = value => process.stdout.write(JSON.stringify({ session_id: session, ...value }) + '\n');
      send({ type: 'system', subtype: 'init', model: argument('--model'), tools: ['Bash', 'Read'], mcp_servers: [], agents: [], skills: [] });
      execute(session);
      const usage = { input_tokens: 11, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Saved deterministic tutorial work.' }], usage } });
      send({ type: 'result', subtype: 'success', is_error: false, result: 'Saved deterministic tutorial work.', usage });
    } else {
      execute(session);
      process.stdout.write(JSON.stringify({ session: { id: session }, result: { text: 'Saved deterministic tutorial work.' },
        stats: { input: 11, output: 5 } }));
    }
  });
}
