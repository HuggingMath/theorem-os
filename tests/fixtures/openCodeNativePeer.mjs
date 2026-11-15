#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const cwd = process.cwd(), config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const data = process.env.XDG_DATA_HOME, file = path.join(data, 'opencode-peer-state.json');
const mode = process.env.THEOREMOS_OPENCODE_FIXTURE_MODE;
const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { sessions: {}, requests: [] };
const write = value => fs.writeFileSync(file, JSON.stringify(value));
const events = new Set();
const broadcast = event => { for (const response of events) response.write('data: ' + JSON.stringify(event) + '\n\n'); };
let pending;
const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== 'Basic ' + Buffer.from('theoremos:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64')) {
    response.writeHead(401).end(); return;
  }
  const target = new URL(request.url, 'http://local'), route = target.pathname;
  let body = ''; for await (const chunk of request) body += chunk;
  body = body ? JSON.parse(body) : undefined;
  const state = read(); state.requests.push({ route, method: request.method, body }); write(state);
  const json = (value, code = 200) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (route === '/provider') return json({ all: [{ id: 'fixture', models: { model: { id: 'model', providerID: 'fixture', variants: { high: {} } } } }] });
  if (route === '/event') {
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: {"type":"server.connected","properties":{}}\n\n');
    events.add(response); response.on('close', () => events.delete(response)); return;
  }
  if (route === '/session' && request.method === 'POST') {
    const session = { id: 'ses_fixture_' + Object.keys(state.sessions).length, directory: cwd,
      agent: body.agent, model: body.model, messages: [] };
    state.sessions[session.id] = session; write(state); return json(session);
  }
  const match = route.match(/^\/session\/([^/]+)(.*)$/), session = match && state.sessions[match[1]];
  if (!session) return json({ error: 'missing-session' }, 404);
  if (!match[2]) return json(mode === 'wrong-session' ? { ...session, id: 'ses_wrong' } : session);
  if (match[2] === '/abort') {
    if (pending) { pending.end(JSON.stringify({ info: { id: 'msg_aborted', role: 'assistant', parentID: pending.nativeId,
      sessionID: session.id, modelID: 'model', providerID: 'fixture',
      error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }, parts: [] })); pending = undefined; }
    return json(true);
  }
  if (match[2] !== '/message') return json({}, 404);
  if (request.method === 'GET') return json(session.messages);
  if (mode === 'http-error') return json({}, 503);
  if (mode === 'hang') { response.writeHead(200, { 'content-type': 'application/json' }); pending = response; pending.nativeId = body.messageID; return; }
  const info = (suffix, tokens) => ({ id: body.messageID + suffix, sessionID: session.id, role: 'assistant',
    parentID: body.messageID, providerID: 'fixture', modelID: 'model', time: { created: 1, completed: 2 }, tokens });
  const first = info('-1', { input: 8, output: 2, reasoning: 1, cache: { read: 2, write: 0 } });
  const second = info('-2', { input: 11, output: 4, reasoning: 0, cache: { read: 3, write: 1 } });
  const tool = { id: body.messageID + '-tool', sessionID: session.id, messageID: first.id, type: 'tool', tool: 'bash',
    state: { status: 'running', input: { command: 'echo isolated' } } };
  broadcast({ type: 'message.updated', properties: { info: first } });
  broadcast({ type: 'message.updated', properties: { info: first } });
  broadcast({ type: 'message.part.updated', properties: { part: tool } });
  broadcast({ type: 'message.part.updated', properties: { part: { ...tool, state: { status: 'completed', output: 'isolated' } } } });
  broadcast({ type: 'message.updated', properties: { info: { ...first, sessionID: 'foreign', tokens: { input: 999999 } } } });
  broadcast({ type: 'message.updated', properties: { info: second } });
  const text = { id: body.messageID + '-text', type: 'text', sessionID: session.id, messageID: second.id, text: 'A saved result.', time: { start: 1, end: 2 } };
  broadcast({ type: 'message.part.updated', properties: { part: text } });
  if (mode === 'missing-usage') delete second.tokens;
  if (mode === 'zero-usage') {
    for (const info of [first, second]) info.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  }
  if (mode === 'partial-zero-usage') {
    first.tokens = { input: 0, output: 3, reasoning: 0, cache: { read: 0, write: 0 } };
    second.tokens = { input: 7, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  }
  if (mode === 'error') second.error = { name: 'APIError', data: { message: 'fixture upstream request failed: secret-provider-canary' } };
  session.messages.push({ info: first, parts: [tool] }, { info: second, parts: [text] }); write(state);
  // Ensure SSE consumers see real in-flight events before the synchronous response settles.
  setTimeout(() => json({ info: second, parts: [text] }), 25);
});
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7));
server.listen(port, '127.0.0.1', () => {
  if (config.plugin.length || Object.keys(config.mcp).length || config.permission.task !== 'deny') throw new Error('unsafe config');
  console.log('opencode server listening on http://127.0.0.1:' + server.address().port);
});
