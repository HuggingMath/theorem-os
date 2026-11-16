#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const args = process.argv.slice(2);
const argument = name => args[args.indexOf(name) + 1];
const profile = process.env.CLAUDE_CONFIG_DIR;
const session = argument(args.includes('--resume') ? '--resume' : '--session-id');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => { prompt += text; });
const send = value => process.stdout.write(JSON.stringify({ session_id: session, ...value }) + '\n');
const usage = { input_tokens: 7, output_tokens: 5, cache_creation_input_tokens: 11, cache_read_input_tokens: 13 };
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(profile, 'claude-peer-calls.jsonl'), JSON.stringify({ args, prompt,
    cwd: process.cwd(), config: profile, tmp: process.env.TMPDIR }) + '\n');
  if (prompt === 'crash') { process.stderr.write('private provider secret\n'); process.exit(9); }
  if (prompt === 'invalid') { process.stdout.write('[]\n'); return; }
  if (prompt === 'oversized') { process.stdout.write('x'.repeat(9 * 1024 * 1024)); return; }
  send({ type: 'system', subtype: 'init', session_id: prompt === 'foreign' ? 'foreign-session' : session,
    model: argument('--model'), tools: ['Bash', 'Read'], mcp_servers: [], agents: [], skills: [] });
  if (prompt === 'delayed-write') {
    setTimeout(() => {
      fs.writeFileSync(path.join(process.cwd(), 'claude-peer-delayed-write.txt'), 'late native write');
      send({ type: 'assistant', message: { content: [], usage } });
      send({ type: 'result', subtype: 'success', is_error: false, result: 'Saved delayed write.', usage });
    }, 200);
    return;
  }
  const failures = {
    'failure-auth-enum': { assistantError: 'authentication_failed' },
    'failure-context-structured': { terminal_reason: 'prompt_too_long', api_error_status: 400 },
    'failure-rate-enum': { assistantError: 'rate_limit' },
    'failure-client-http': { api_error_status: 400 },
    'failure-server-http': { api_error_status: 503 },
    'failure-timeout-http': { api_error_status: 408 },
    'failure-auth-text': { result: 'API Error: 401 invalid api key: private provider secret' },
    'failure-context-text': { result: 'Prompt is too long: 42000 tokens > 32000 maximum; private provider secret' },
    'failure-rate-text': { errors: ['Rate limit exceeded: private provider secret'] },
  };
  if (failures[prompt]) {
    const { assistantError, ...failure } = failures[prompt];
    if (assistantError) send({ type: 'assistant', error: assistantError, is_api_error_message: true,
      message: { content: [{ type: 'text', text: 'private provider secret' }] } });
    send({ type: 'result', subtype: 'success', is_error: true, result: 'private provider secret', usage, ...failure });
    return;
  }
  if (prompt === 'wait') { setInterval(() => {}, 1000); return; }
  if (prompt === 'isolation') {
    const outcome = {};
    try { outcome.hidden = fs.readFileSync(process.env.CLAUDE_PEER_HIDDEN, 'utf8'); } catch { outcome.hidden = 'denied'; }
    try { fs.writeFileSync(process.env.CLAUDE_PEER_OUTSIDE, 'forbidden'); outcome.outside = 'written'; } catch { outcome.outside = 'denied'; }
    fs.writeFileSync(path.join(process.cwd(), 'peer-owned.txt'), 'owned');
    fs.writeFileSync(path.join(profile, 'claude-peer-isolation.json'), JSON.stringify(outcome));
  }
  if (prompt === 'background') {
    const writer = childProcess.spawn(process.execPath, ['-e',
      'setInterval(() => require("node:fs").appendFileSync(process.argv[1], "write\\n"), 10)',
      path.join(process.cwd(), 'claude-peer-background.txt')], { stdio: 'ignore' });
    fs.writeFileSync(path.join(profile, 'claude-peer-writer.pid'), String(writer.pid));
    writer.unref();
  }
  send({ type: 'stream_event', event: { type: 'content_block_start', index: 0,
    content_block: { type: 'thinking', thinking: 'private internal reasoning' } } });
  send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
    delta: { type: 'thinking_delta', thinking: 'private internal reasoning' } } });
  send({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  send({ type: 'stream_event', event: { type: 'content_block_start', index: 1,
    content_block: { type: 'tool_use', id: 'tool-fixture', name: 'Bash', input: { command: 'fixture command' } } } });
  send({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
  send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-fixture',
    is_error: true, content: 'private tool error' }] } });
  send({ type: 'stream_event', event: { type: 'content_block_start', index: 2,
    content_block: { type: 'text', text: '' } } });
  send({ type: 'stream_event', event: { type: 'content_block_delta', index: 2,
    delta: { type: 'text_delta', text: 'Saved fixture research.' } } });
  send({ type: 'stream_event', event: { type: 'content_block_stop', index: 2 } });
  // Assistant event usage is per API request, not the native turn's complete result.
  send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Saved fixture research.' }],
    ...(prompt !== 'missing-assistant-usage' ? { usage } : {}) } });
  const result = { type: 'result', subtype: prompt === 'failure' ? 'error_during_execution' : 'success',
    is_error: prompt === 'failure', result: prompt === 'failure' ? 'private provider secret' : 'Saved fixture research.',
    errors: ['private provider secret'], usage };
  if (prompt === 'missing-usage') delete result.usage;
  if (prompt === 'zero-usage') result.usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (prompt === 'bad-usage') result.usage = { ...usage, cache_read_input_tokens: -1 };
  if (prompt === 'missing-cache-usage') result.usage = { input_tokens: 7, output_tokens: 5 };
  send(result);
  if (prompt === 'result-then-wait') setInterval(() => {}, 1000);
});
