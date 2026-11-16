import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClaudeCodeMathSession } from '../src/runtime/claudeCodeSession';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import { temporaryDirectory } from './helpers/files';

describe('Claude Code stream-json adapter without provider calls', () => {
  let root: string, workspace: string, profile: string, options: MathAgentOptions;
  const sessions: MathAgentSession[] = [];
  beforeEach(() => {
    root = temporaryDirectory('claude-code-session-');
    workspace = path.join(root, 'workspace'); profile = path.join(root, 'profile');
    fs.mkdirSync(workspace); fs.mkdirSync(profile);
    const executable = path.join(root, 'claude-peer');
    fs.copyFileSync(path.resolve('tests/fixtures/claudeCodeProtocolPeer.cjs'), executable);
    fs.chmodSync(executable, 0o700);
    options = { executable, workspace, profile, model: 'claude-fixture', effort: 'high', instructions: 'Frozen host contract.',
      environment: { PATH: process.env.PATH }, onUsage: vi.fn(), onUsageIncomplete: vi.fn(),
      onActivity: vi.fn(), onItem: vi.fn(), onItemUpdate: vi.fn(),
      requestGate: vi.fn(() => ({ allowed: false as const, reason: 'math_model_usage_unavailable' as const })) };
  });
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map(session => session.close()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const open = async (config = options) => { const session = await createClaudeCodeMathSession(config); sessions.push(session); return session; };
  const calls = () => fs.readFileSync(path.join(profile, 'claude-peer-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

  it('uses a pinned model, effort, isolated configuration and explicit session; resumes that same native session', async () => {
    const session = await open(), started = vi.fn();
    expect(await session.run('first', 'turn-one', workspace, started)).toBe('completed');
    expect(started).toHaveBeenCalledExactlyOnceWith('turn-one');
    expect(session.lastCompletedResponse).toEqual({ turnId: 'turn-one', text: 'Saved fixture research.' });
    expect(session.usageSource).toBe('native-turn-totals');
    expect(options.onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 31, outputTokens: 5, totalTokens: 36,
      cachedInputTokens: 13, cacheCreationInputTokens: 11 }, { turnId: 'turn-one' });
    expect(session.lastInputTokens).toBe(31);
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
    await session.close();
    const resumed = await open({ ...options, threadId: session.threadId });
    expect(await resumed.run('second', 'turn-two', workspace, vi.fn())).toBe('completed');
    expect(resumed.threadId).toBe(session.threadId);
    const [first, second] = calls();
    expect(first.args).toEqual(expect.arrayContaining(['--session-id', session.threadId, '--model', 'claude-fixture', '--effort', 'high',
      '--bare', '--safe-mode', '--restricted', '--disable-slash-commands', '--strict-mcp-config', '--permission-mode', 'dontAsk']));
    expect(first.args).not.toContain('--dangerously-skip-permissions');
    expect(first.args[first.args.indexOf('--setting-sources') + 1]).toBe('');
    expect(first.args[first.args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
    expect(first.args[first.args.indexOf('--tools') + 1].split(',')).not.toEqual(expect.arrayContaining(['Agent', 'Task']));
    expect(first).toMatchObject({ config: profile, cwd: workspace });
    expect(first.tmp.startsWith(workspace + '/')).toBe(true);
    expect(second.args).toContain('--resume'); expect(second.args).not.toContain('--session-id');
    expect(second.args[second.args.indexOf('--resume') + 1]).toBe(session.threadId);
    expect(session.isolationReceipt).toMatchObject({ backend: 'bwrap', pidNamespace: true });
    expect(options.onUsage).toHaveBeenCalledTimes(2);
    expect(options.requestGate).not.toHaveBeenCalled();
  });

  it('exposes actual activity and final text without private reasoning or provider/tool errors', async () => {
    const session = await open();
    expect(await session.run('ordinary', 'turn-events', workspace, vi.fn())).toBe('completed');
    expect(options.onActivity).toHaveBeenCalledWith({ event: 'reasoning', itemType: 'reasoning' });
    expect(options.onActivity).toHaveBeenCalledWith({ event: 'item_started', itemType: 'commandExecution' });
    expect(options.onItemUpdate).toHaveBeenCalledWith(expect.objectContaining({ type: 'agentMessage', text: 'Saved fixture research.' }),
      { turnId: 'turn-events' });
    const events = JSON.stringify([vi.mocked(options.onActivity!).mock.calls, vi.mocked(options.onItem!).mock.calls,
      vi.mocked(options.onItemUpdate!).mock.calls, session.lastError, session.lastFailureDiagnostic]);
    expect(events).not.toMatch(/private|secret|fixture command/u);
  });

  it.each(['missing-usage', 'zero-usage', 'bad-usage', 'missing-cache-usage'])('records %s as unavailable rather than zero consumption', async prompt => {
    const session = await open();
    expect(await session.run(prompt, 'turn-usage', workspace, vi.fn())).toBe('completed');
    expect(options.onUsage).not.toHaveBeenCalled(); expect(options.onUsageIncomplete).toHaveBeenCalledTimes(1);
    expect(session.lastInputTokens).toBe(31); // Context occupancy comes from the actual assistant request.
  });

  it('clears prior context occupancy and never substitutes invocation totals for missing assistant usage', async () => {
    const session = await open();
    expect(await session.run('ordinary', 'turn-context-one', workspace, vi.fn())).toBe('completed');
    expect(session.lastInputTokens).toBe(31);
    expect(await session.run('missing-assistant-usage', 'turn-context-two', workspace, vi.fn())).toBe('completed');
    expect(options.onUsage).toHaveBeenCalledTimes(2);
    expect(options.onUsageIncomplete).not.toHaveBeenCalled();
    expect(session.lastInputTokens).toBeUndefined();
  });

  it.each(['crash', 'invalid', 'oversized', 'foreign', 'failure'])('handles %s with safe diagnostics and complete process cleanup', async prompt => {
    const session = await open();
    expect(await session.run(prompt, 'turn-failure', workspace, vi.fn())).toBe('failed');
    expect(session.lastError).toMatch(/^math_/u);
    expect(JSON.stringify([session.lastError, session.lastFailureDiagnostic])).not.toMatch(/private|secret/u);
    expect(session.lastCompletedResponse).toBeUndefined();
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
    if (prompt === 'failure') expect(options.onUsage).toHaveBeenCalledTimes(1);
    else expect(options.onUsageIncomplete).toHaveBeenCalledTimes(1);
  });

  it.each(['ordinary', 'delayed-write'])('stops %s when required turn-start handling fails', async prompt => {
    const session = await open(), started = vi.fn(() => { throw new Error('private host start failure'); });
    expect(await session.run(prompt, 'turn-start-failure', workspace, started)).toBe('failed');
    expect(started).toHaveBeenCalledExactlyOnceWith('turn-start-failure');
    expect(session.lastError).toBe('math_claude_turn_start_failed');
    expect(session.lastFailureDiagnostic).toEqual({ code: 'other' });
    expect(session.lastCompletedResponse).toBeUndefined();
    expect(options.onUsage).not.toHaveBeenCalled();
    expect(options.onUsageIncomplete).toHaveBeenCalledExactlyOnceWith();
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
    expect(fs.existsSync(path.join(workspace, 'claude-peer-delayed-write.txt'))).toBe(false);
  });

  it.each([
    ['failure-auth-enum', 'math_model_authentication_failed', { code: 'unauthorized' }],
    ['failure-context-structured', 'math_model_context_window_exceeded', { code: 'contextWindowExceeded' }],
    ['failure-rate-enum', 'math_model_concurrency_limit', { code: 'rateLimitExceeded' }],
    ['failure-client-http', 'math_model_turn_failed', { code: 'badRequest' }],
    ['failure-server-http', 'math_model_request_failed', { code: 'httpConnectionFailed', httpStatusCode: 503, reason: 'upstream_request_failed' }],
    ['failure-timeout-http', 'math_model_request_timeout', { code: 'httpConnectionFailed', httpStatusCode: 408, reason: 'upstream_request_failed' }],
    ['failure-auth-text', 'math_model_authentication_failed', { code: 'unauthorized' }],
    ['failure-context-text', 'math_model_context_window_exceeded', { code: 'contextWindowExceeded' }],
    ['failure-rate-text', 'math_model_concurrency_limit', { code: 'rateLimitExceeded' }],
  ] as const)('preserves the safe recovery category for %s', async (prompt, error, diagnostic) => {
    const session = await open();
    expect(await session.run(prompt, 'turn-classification', workspace, vi.fn())).toBe('failed');
    expect(session.lastError).toBe(error); expect(session.lastFailureDiagnostic).toEqual(diagnostic);
    expect(session.lastCompletedResponse).toBeUndefined();
    expect(JSON.stringify([session.lastError, session.lastFailureDiagnostic,
      vi.mocked(options.onItem!).mock.calls, vi.mocked(options.onItemUpdate!).mock.calls])).not.toMatch(/private|secret|API Error/iu);
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it('does not mistake a terminal message for writer shutdown', async () => {
    const session = await open();
    let settled = false;
    const run = session.run('result-then-wait', 'turn-open', workspace, vi.fn()).then(value => { settled = true; return value; });
    await expect.poll(() => vi.mocked(options.onUsage).mock.calls.length).toBe(1);
    expect(settled).toBe(false);
    expect(await session.stopForFreeze!()).toEqual({ status: 'unconfirmed', reason: 'turn-not-settled' });
    await session.interrupt();
    expect(await run).toBe('interrupted');
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it('keeps rejected and stale handoffs running, then stops for a valid exact completion file', async () => {
    const file = path.join(workspace, 'completed.json'), started = vi.fn();
    const validate = vi.fn((value: unknown) => {
      const handoff = value as { turn?: string; checked?: boolean };
      if (handoff.turn !== 'current' || handoff.checked !== true) throw new Error('fixture-handoff-rejected');
    });
    const session = await open({ ...options, completedOutput: { file, validate }, turnTimeoutMs: 2_147_483_648 });
    let settled = false;
    const run = session.run('wait', 'turn-handoff', workspace, started).then(value => { settled = true; return value; });
    await expect.poll(() => started.mock.calls.length).toBe(1);
    fs.writeFileSync(path.join(workspace, 'other.json'), '{"turn":"current","checked":true}');
    fs.writeFileSync(file, '{"turn":"older","checked":true}');
    await expect.poll(() => validate.mock.calls.some(([value]) => (value as { turn?: string }).turn === 'older')).toBe(true);
    expect(settled).toBe(false);
    expect(await session.stopForFreeze!()).toEqual({ status: 'unconfirmed', reason: 'turn-not-settled' });
    fs.writeFileSync(file, '{"turn":"current","checked":false}');
    await expect.poll(() => validate.mock.calls.some(([value]) => (value as { checked?: boolean }).checked === false)).toBe(true);
    expect(settled).toBe(false);
    fs.writeFileSync(file, '{"turn":"current","checked":true}');
    expect(await run).toBe('submitted');
    expect(options.onUsage).not.toHaveBeenCalled();
    expect(options.onUsageIncomplete).toHaveBeenCalledExactlyOnceWith();
    expect(session.lastError).toBeUndefined();
    expect(session.lastCompletedResponse).toBeUndefined();
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it('stops a background writer in the owned namespace before a freeze is confirmed', async () => {
    const session = await open();
    expect(await session.run('background', 'turn-background', workspace, vi.fn())).toBe('completed');
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
    const file = path.join(workspace, 'claude-peer-background.txt');
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').toBe(content);
  });

  it.each(['interrupt', 'abort', 'timeout'] as const)('handles %s while a native turn is running', async action => {
    const controller = new AbortController();
    const session = await open({ ...options, signal: controller.signal, ...(action === 'timeout' ? { turnTimeoutMs: 100 } : {}) });
    const started = vi.fn(), run = session.run('wait', 'turn-cancel', workspace, started);
    if (action !== 'timeout') {
      await expect.poll(() => started.mock.calls.length).toBe(1);
      if (action === 'abort') controller.abort(new Error('private abort reason'));
      else await session.interrupt();
    }
    expect(await run).toBe(action === 'timeout' ? 'failed' : 'interrupted');
    expect(session.lastError).toBe(action === 'timeout' ? 'math_model_request_timeout' : 'math_model_request_stopped');
    expect(options.onUsageIncomplete).toHaveBeenCalledTimes(1);
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it('enforces hidden roots and outside write restrictions for actual shell-capable child processes', async () => {
    const hidden = path.join(root, 'hidden'); fs.mkdirSync(hidden);
    const secret = path.join(hidden, 'secret.txt'), outside = path.join(root, 'outside.txt');
    fs.writeFileSync(secret, 'private hidden fixture');
    const session = await open({ ...options, hiddenRoots: [hidden], environment: { ...options.environment,
      CLAUDE_PEER_HIDDEN: secret, CLAUDE_PEER_OUTSIDE: outside } });
    expect(await session.run('isolation', 'turn-isolation', workspace, vi.fn())).toBe('completed');
    expect(JSON.parse(fs.readFileSync(path.join(profile, 'claude-peer-isolation.json'), 'utf8')))
      .toEqual({ hidden: 'denied', outside: 'denied' });
    expect(fs.readFileSync(path.join(workspace, 'peer-owned.txt'), 'utf8')).toBe('owned');
    expect(fs.existsSync(outside)).toBe(false); expect(fs.readFileSync(secret, 'utf8')).toBe('private hidden fixture');
  });

  it('loads file skills explicitly and leaves completed-output interpretation to the host after natural return', async () => {
    const skillFile = path.join(workspace, '.agents/skills/fixture/SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, '---\nname: fixture\ndescription: Disposable fixture research skill.\n---\nRead the frozen task.\n');
    const validate = vi.fn(), session = await open({ ...options, skills: [readMathAgentSkill(skillFile, 'file')],
      completedOutput: { file: path.join(workspace, 'unused.json'), validate } });
    expect(await session.run('skill', 'turn-skill', workspace, vi.fn())).toBe('completed');
    const args = calls()[0].args;
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain(JSON.stringify(skillFile));
    expect(validate).not.toHaveBeenCalled();
  });

  it('rejects unsupported responsibility contracts before starting a native process', async () => {
    await expect(open({ ...options, delegation: { mode: 'read-only', maxAgents: 2 } })).rejects.toThrow('math_claude_delegation_unsupported');
    await expect(open({ ...options, readIsolation: { environment: 'standard' } })).rejects.toThrow('math_sealed_provider_credential_unavailable');
    await expect(open({ ...options, skills: [{ name: 'fixture', path: '/never/SKILL.md', digest: 'a'.repeat(64), loading: 'native' }] }))
      .rejects.toThrow('math_claude_native_skill_loading_unsupported');
    await expect(open({ ...options, effort: 'none' })).rejects.toThrow('math_claude_effort_unsupported');
    await expect(open({ ...options, threadId: 'not-a-uuid' })).rejects.toThrow('math_claude_session_id_invalid');
    expect(fs.existsSync(path.join(profile, 'claude-peer-calls.jsonl'))).toBe(false);
  });

  it('keeps optional observer failures separate from the provider result', async () => {
    const session = await open({ ...options, onActivity: () => { throw new Error('private observer detail'); },
      onItem: () => { throw new Error('private observer detail'); } });
    expect(await session.run('ordinary', 'turn-observer', workspace, vi.fn())).toBe('completed');
    expect(session.lastError).toBeUndefined();
  });

  it('runs the installed Claude Code and resumes its persisted session against a fixed loopback Anthropic peer', async () => {
    const executable = '/home/lzh/.local/bin/claude';
    expect(fs.existsSync(executable)).toBe(true);
    const skillFile = path.join(workspace, '.agents/skills/native-fixture/SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, '---\nname: native-fixture\ndescription: Native loopback tool fixture.\n---\nFixture tag: native-skill-readback-381.\n');
    const written = path.join(workspace, 'native-tool-write.txt');
    let calls = 0, readback = false, shellResult = false;
    const server = http.createServer((request, response) => {
      let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        if (request.url?.includes('/count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":12}'); return; }
        if (!request.url?.startsWith('/v1/messages')) { response.writeHead(404); response.end('{}'); return; }
        calls++;
        const input = JSON.parse(body);
        const results = input.messages.flatMap((message: { content: unknown }) => Array.isArray(message.content)
          ? message.content.filter(value => value.type === 'tool_result') : []);
        if (calls === 2) readback = JSON.stringify(results).includes('native-skill-readback-381');
        if (calls === 3) shellResult = results.some(value => value.tool_use_id === 'native-shell-fixture' && !value.is_error);
        const message = { id: `msg_fixture_${calls}`, type: 'message', role: 'assistant', model: input.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
        response.setHeader('content-type', 'text/event-stream');
        const tool = calls === 1 ? { name: 'Read', id: 'native-read-fixture', input: { file_path: skillFile } }
          : calls === 2 ? { name: 'Bash', id: 'native-shell-fixture', input: {
            command: "printf '%s' native-shell-write-381 > " + "'" + written.replaceAll("'", "'\\''") + "'",
            description: 'Write a disposable local fixture artifact.',
          } } : undefined;
        for (const event of [
          { type: 'message_start', message },
          { type: 'content_block_start', index: 0, content_block: tool
            ? { type: 'tool_use', name: tool.name, id: tool.id, input: {} } : { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: tool
            ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) }
            : { type: 'text_delta', text: 'Loopback fixture response.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
          { type: 'message_stop' },
        ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address unavailable');
    const config = { ...options, executable, model: 'claude-sonnet-4-6', effort: 'high', turnTimeoutMs: 20_000,
      skills: [readMathAgentSkill(skillFile, 'file')],
      environment: { PATH: process.env.PATH, HOME: process.env.HOME,
        ANTHROPIC_API_KEY: 'loopback-fixture-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_MAX_RETRIES: '0', API_TIMEOUT_MS: '5000' } };
    try {
      const first = await open(config);
      expect(await first.run('Read the supplied skill and use the provided disposable fixture command, then return.', 'native-one', workspace, vi.fn())).toBe('completed');
      expect(first.lastCompletedResponse?.text).toBe('Loopback fixture response.');
      expect(first.lastInputTokens).toBe(12); // Latest request, despite three requests totaling 36 input tokens.
      expect(readback).toBe(true); expect(shellResult).toBe(true);
      expect(fs.readFileSync(written, 'utf8')).toBe('native-shell-write-381');
      expect(await first.stopForFreeze!()).toEqual({ status: 'stopped' });
      await first.close();
      const resumed = await open({ ...config, threadId: first.threadId });
      expect(await resumed.run('Continue with another fixture response. Do not use tools.', 'native-two', workspace, vi.fn())).toBe('completed');
      expect(resumed.threadId).toBe(first.threadId);
      expect(resumed.lastInputTokens).toBe(12);
      expect(await resumed.stopForFreeze!()).toEqual({ status: 'stopped' });
      expect(calls).toBe(4);
      expect(options.onUsage).toHaveBeenCalledTimes(2);
      expect(options.onUsageIncomplete).not.toHaveBeenCalled();
      expect(vi.mocked(options.onUsage).mock.calls.map(([usage]) => usage)).toEqual([
        { inputTokens: 36, outputTokens: 9, totalTokens: 45, cachedInputTokens: 0, cacheCreationInputTokens: 0 },
        { inputTokens: 12, outputTokens: 3, totalTokens: 15, cachedInputTokens: 0, cacheCreationInputTokens: 0 },
      ]);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 60_000);

  it.each(['omitted', 'omitted-input', 'omitted-output', 'zero'] as const)('marks %s provider usage unavailable through the installed Claude Code', async usageMode => {
    const executable = '/home/lzh/.local/bin/claude';
    expect(fs.existsSync(executable)).toBe(true);
    let calls = 0;
    const server = http.createServer((request, response) => {
      let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        if (request.url?.includes('/count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":12}'); return; }
        if (!request.url?.startsWith('/v1/messages')) { response.writeHead(404); response.end('{}'); return; }
        calls++;
        const input = JSON.parse(body);
        const message = { id: `msg_unknown_usage_${calls}`, type: 'message', role: 'assistant', model: input.model,
          content: [], stop_reason: null, stop_sequence: null,
          ...(usageMode !== 'omitted' ? { usage: {
            ...(usageMode !== 'omitted-input' ? { input_tokens: usageMode === 'zero' ? 0 : 12 } : {}),
            ...(usageMode !== 'omitted-output' ? { output_tokens: usageMode === 'zero' ? 0 : 1 } : {}),
            cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } : {}) };
        response.setHeader('content-type', 'text/event-stream');
        for (const event of [
          { type: 'message_start', message },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Loopback response with unknown usage.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
            ...(['zero', 'omitted-input'].includes(usageMode) ? { usage: { output_tokens: usageMode === 'zero' ? 0 : 3 } } : {}) },
          { type: 'message_stop' },
        ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address unavailable');
    try {
      const session = await open({ ...options, executable, model: 'claude-sonnet-4-6', turnTimeoutMs: 20_000,
        environment: { PATH: process.env.PATH, HOME: process.env.HOME,
          ANTHROPIC_API_KEY: 'loopback-fixture-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          CLAUDE_CODE_MAX_RETRIES: '0', API_TIMEOUT_MS: '5000' } });
      expect(await session.run('Return the fixed fixture response without tools.', 'native-unknown-usage', workspace, vi.fn())).toBe('completed');
      expect(session.lastCompletedResponse?.text).toBe('Loopback response with unknown usage.');
      expect(calls).toBe(1);
      expect(options.onUsage).not.toHaveBeenCalled();
      expect(options.onUsageIncomplete).toHaveBeenCalledExactlyOnceWith();
      expect(session.lastInputTokens).toBe(usageMode === 'omitted-output' ? 12 : undefined);
      expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
    } finally {
      await Promise.all(sessions.map(session => session.close()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 30_000);

  it('classifies an actual local HTTP 401 from the installed Claude Code without exposing its body', async () => {
    let requests = 0;
    const server = http.createServer(async (request, response) => {
      for await (const _chunk of request) { /* Drain a disposable fixture request. */ }
      if (request.url?.includes('/count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":12}'); return; }
      requests++;
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key: private provider secret' } }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address unavailable');
    try {
      const session = await open({ ...options, executable: '/home/lzh/.local/bin/claude', model: 'claude-sonnet-4-6', turnTimeoutMs: 20_000,
        environment: { PATH: process.env.PATH, HOME: process.env.HOME,
          ANTHROPIC_API_KEY: 'loopback-fixture-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          CLAUDE_CODE_MAX_RETRIES: '0', API_TIMEOUT_MS: '5000' } });
      expect(await session.run('Fixed local authentication failure fixture.', 'native-auth', workspace, vi.fn())).toBe('failed');
      expect(requests).toBe(1);
      expect(session.lastError).toBe('math_model_authentication_failed');
      expect(session.lastFailureDiagnostic).toEqual({ code: 'unauthorized' });
      expect(session.lastCompletedResponse).toBeUndefined();
      expect(options.onUsage).not.toHaveBeenCalled(); expect(options.onUsageIncomplete).toHaveBeenCalledOnce();
      expect(JSON.stringify([session.lastError, session.lastFailureDiagnostic,
        vi.mocked(options.onItem!).mock.calls, vi.mocked(options.onItemUpdate!).mock.calls])).not.toMatch(/private|secret|x-api-key/iu);
      expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
    } finally {
      await Promise.all(sessions.map(session => session.close()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 30_000);
});
