import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliMathSession } from '../src/runtime/cliSession';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import { temporaryDirectory } from './helpers/files';

describe('configured headless CLI sessions with isolated local children', () => {
  let root: string, workspace: string, profile: string, executable: string, options: MathAgentOptions;
  let configuration: Record<string, unknown>;
  const sessions: MathAgentSession[] = [];
  const usage = (completeness = 'complete', scope = 'turn') => ({ when: { field: '/kind', value: 'final' },
    inputTokens: '/stats/input', outputTokens: '/stats/output', cachedInputTokens: '/stats/cached',
    reasoningOutputTokens: '/stats/reasoning', lastInputTokens: '/stats/context', completeness, scope });
  const structured = (format = 'jsonl') => ({ format, text: { field: '/result/text', when: { field: '/kind', value: 'final' } },
    sessionId: { field: '/session/id', when: { field: '/kind', value: format === 'json' ? 'final' : 'init' } }, usage: usage() });
  beforeEach(() => {
    root = temporaryDirectory('generic-cli-session-');
    workspace = path.join(root, 'workspace'); profile = path.join(root, 'profile'); executable = path.join(root, 'cli-peer');
    fs.mkdirSync(workspace); fs.mkdirSync(profile);
    fs.copyFileSync(path.resolve('tests/fixtures/cliProtocolPeer.cjs'), executable); fs.chmodSync(executable, 0o700);
    configuration = { schema: 'theorem-os.cli-harness.v1', executable,
      args: ['--model', '{model}', '--effort', '{effort}', '--profile', '{profile}', '--format', 'jsonl'],
      efforts: ['high'], output: structured() };
    options = { executable, workspace, profile, model: 'fixture/model', effort: 'high', instructions: 'Frozen mathematical host contract.',
      environment: { PATH: process.env.PATH }, onUsage: vi.fn(), onUsageIncomplete: vi.fn(), onActivity: vi.fn(),
      requestGate: vi.fn(() => ({ allowed: false as const, reason: 'math_model_usage_unavailable' as const })) };
  });
  afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.close())); fs.rmSync(root, { recursive: true, force: true }); });
  const open = async (config = options) => {
    fs.writeFileSync(path.join(profile, 'cli.json'), JSON.stringify(configuration));
    const session = await createCliMathSession(config); sessions.push(session); return session;
  };
  const scenario = (name: string) => { configuration.args = [...configuration.args as string[], '--scenario', name]; };
  const calls = () => fs.readFileSync(path.join(profile, 'cli-peer-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

  it('sends pinned skill references, complete host instructions and the current request through stdin', async () => {
    const skill = path.join(workspace, '.agents/skills/fixture/SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, '---\nname: fixture\ndescription: Disposable local research skill.\n---\nRead and test the fixed problem.\n');
    const session = await open({ ...options, skills: [readMathAgentSkill(skill, 'file')] }), started = vi.fn();
    expect(await session.run('Full original problem: preserve this exact statement.', 'turn-1', workspace, started)).toBe('completed');
    expect(started).toHaveBeenCalledExactlyOnceWith('turn-1');
    expect(calls()[0]).toMatchObject({ home: profile, cwd: workspace });
    expect(calls()[0].prompt).toContain(options.instructions); expect(calls()[0].prompt).toContain(JSON.stringify(skill));
    expect(calls()[0].prompt).toContain('Full original problem: preserve this exact statement.');
    expect(session.lastCompletedResponse).toEqual({ turnId: 'turn-1', text: 'Saved generic research. λ' });
    expect(options.onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 11, outputTokens: 5, totalTokens: 16,
      cachedInputTokens: 2, reasoningOutputTokens: 1 }, { turnId: 'turn-1' });
    expect(options.onUsageIncomplete).not.toHaveBeenCalled(); expect(options.requestGate).not.toHaveBeenCalled();
    expect(session.lastInputTokens).toBe(9); expect(session.usageSource).toBe('native-turn-totals');
    expect(session.isolationReceipt).toMatchObject({ backend: 'bwrap', pidNamespace: true });
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it('uses plain output without inventing usage or a native session for fresh commands', async () => {
    configuration.output = { format: 'text' };
    configuration.args = (configuration.args as string[]).map(value => value === 'jsonl' ? 'text' : value);
    const first = await open();
    expect(await first.run('Stateless first task.', 'turn-plain', workspace, vi.fn())).toBe('completed');
    expect(first.lastCompletedResponse?.text).toBe('Saved generic research. λ');
    expect(options.onUsage).not.toHaveBeenCalled(); expect(options.onUsageIncomplete).toHaveBeenCalledExactlyOnceWith();
    expect(first.lastInputTokens).toBeUndefined(); await first.close();
    const next = await open({ ...options, threadId: first.threadId });
    expect(next.threadId).not.toBe(first.threadId);
  });

  it.each(['file', 'argument'] as const)('delivers the same full prompt by %s with a literal argv and single template expansion', async mode => {
    configuration.prompt = mode;
    configuration.args = [...configuration.args as string[], mode === 'file' ? '--prompt-file' : '--prompt',
      mode === 'file' ? '{promptFile}' : '{prompt}', '--literal', '$(touch SHOULD_NOT_EXIST);`touch ALSO_NOT_CREATED`;{model}'];
    configuration.environment = { CLI_FIXTURE_VALUE: '{model}::{effort}' };
    const message = 'Literal $HOME; $(touch NEVER_CREATED) `whoami` and {model} must remain unchanged.';
    const session = await open();
    expect(await session.run(message, 'literal-turn', workspace, vi.fn())).toBe('completed');
    const call = calls()[0];
    expect(call.prompt).toContain(options.instructions); expect(call.prompt).toContain(message); expect(call.stdin).toBe('');
    expect(call.args).toContain('$(touch SHOULD_NOT_EXIST);`touch ALSO_NOT_CREATED`;fixture/model');
    expect(call.fixtureEnvironment).toBe('fixture/model::high');
    for (const name of ['NEVER_CREATED', 'SHOULD_NOT_EXIST', 'ALSO_NOT_CREATED']) expect(fs.existsSync(path.join(workspace, name))).toBe(false);
    if (mode === 'file') {
      expect(call.promptFile.startsWith(path.join(workspace, '.scratch/cli-prompts') + '/')).toBe(true);
      expect(fs.lstatSync(call.promptFile).mode & 0o777).toBe(0o400);
      expect(fs.readFileSync(call.promptFile, 'utf8')).toBe(call.prompt);
    }
  });

  it('reads a configured JSON document after natural exit', async () => {
    configuration.output = structured('json');
    configuration.args = (configuration.args as string[]).map(value => value === 'jsonl' ? 'json' : value);
    const session = await open();
    expect(await session.run('Fixed JSON fixture.', 'json-turn', workspace, vi.fn())).toBe('completed');
    expect(session.lastCompletedResponse?.text).toBe('Saved generic research. λ'); expect(options.onUsage).toHaveBeenCalledOnce();
  });

  it('appends only matching text fields and accepts a final JSONL frame without a newline', async () => {
    scenario('append');
    configuration.output = { ...structured(), text: { field: '/text', when: { field: '/kind', value: 'delta' }, mode: 'append' } };
    const session = await open();
    expect(await session.run('Append fixture.', 'append-turn', workspace, vi.fn())).toBe('completed');
    expect(session.lastCompletedResponse?.text).toBe('First second.');
    await session.close();
    configuration.output = structured(); configuration.args = (configuration.args as string[]).map(value => value === 'append' ? 'no-newline' : value);
    const next = await open();
    expect(await next.run('No final newline.', 'last-frame-turn', workspace, vi.fn())).toBe('completed');
    expect(next.lastCompletedResponse?.text).toBe('Saved generic research. λ');
  });

  it('reopens the same generated native session using exact supplied start and resume arguments', async () => {
    configuration.session = { mode: 'generated', startArgs: ['--session-id', '{sessionId}'], resumeArgs: ['--resume', '{sessionId}'] };
    const first = await open();
    expect(await first.run('First native fixture.', 'generated-one', workspace, vi.fn())).toBe('completed');
    const id = first.threadId; expect(id).toMatch(/^[a-f0-9-]{36}$/u); await first.close();
    const resumed = await open({ ...options, threadId: id });
    expect(await resumed.run('Same saved native fixture.', 'generated-two', workspace, vi.fn())).toBe('completed');
    expect(resumed.threadId).toBe(id);
    expect(calls()[0].args).toEqual(expect.arrayContaining(['--session-id', id]));
    expect(calls()[1].args).toEqual(expect.arrayContaining(['--resume', id]));
    expect(calls()[1].args).not.toContain('--session-id'); expect(await resumed.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it('binds a reported native ID before onStarted and resumes precisely that ID across processes', async () => {
    configuration.session = { mode: 'reported', startArgs: [], resumeArgs: ['--resume', '{sessionId}'] };
    const first = await open(); expect(first.threadId).toBe('');
    const seen: string[] = [];
    expect(await first.run('Discover native fixture.', 'reported-one', workspace, () => { seen.push(first.threadId); })).toBe('completed');
    expect(seen).toEqual([first.threadId]); expect(first.threadId).toMatch(/^native-/u);
    const id = first.threadId; await first.close();
    const resumed = await open({ ...options, threadId: id });
    expect(await resumed.run('Continue the exact native fixture.', 'reported-two', workspace, vi.fn())).toBe('completed');
    expect(resumed.threadId).toBe(id); expect(calls()[1].args).toEqual(expect.arrayContaining(['--resume', id]));
  });

  it('stops when the mandatory onStarted persistence callback throws, without exposing its raw error', async () => {
    configuration.session = { mode: 'reported', startArgs: [], resumeArgs: ['--resume', '{sessionId}'] };
    const session = await open();
    expect(await session.run('Failed binding persistence fixture.', 'binding-write-turn', workspace,
      () => { throw new Error('private host storage path and secret'); })).toBe('failed');
    expect(session.lastError).toBe('math_cli_turn_start_failed');
    expect(options.onUsage).not.toHaveBeenCalled(); expect(options.onUsageIncomplete).toHaveBeenCalledOnce();
    expect(JSON.stringify([session.lastError, session.lastFailureDiagnostic])).not.toMatch(/private|secret/u);
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it('defaults HOME to the dedicated profile and isolates optional observer failures', async () => {
    const session = await open({ ...options, environment: { ...options.environment, HOME: path.join(root, 'outside-home') },
      onActivity: () => { throw new Error('private observer detail'); } });
    expect(await session.run('Isolated home fixture.', 'home-turn', workspace, vi.fn())).toBe('completed');
    expect(calls()[0].home).toBe(profile); expect(session.lastError).toBeUndefined();
  });

  it.each(['missing-id', 'foreign-id', 'changed-id'])('rejects %s without claiming a resumed conversation', async name => {
    scenario(name); configuration.session = { mode: 'reported', startArgs: [], resumeArgs: ['--resume', '{sessionId}'] };
    const session = await open({ ...options, ...(name === 'foreign-id' ? { threadId: 'saved-native-session' } : {}) }), started = vi.fn();
    expect(await session.run('Binding rejection fixture.', 'binding-turn', workspace, started)).toBe('failed');
    expect(session.lastError).toMatch(/^math_cli_session_(?:id_missing|binding_mismatch)$/u);
    if (name !== 'changed-id') expect(started).not.toHaveBeenCalled();
    expect(options.onUsage).not.toHaveBeenCalled(); expect(options.onUsageIncomplete).toHaveBeenCalledOnce();
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it.each(['complete', 'partial'] as const)('reports the final aggregate once with %s completeness', async completeness => {
    scenario('multiple-finals'); configuration.output = { ...structured(), usage: usage(completeness) };
    const session = await open();
    expect(await session.run('Two aggregate receipts.', 'aggregate-turn', workspace, vi.fn())).toBe('completed');
    expect(options.onUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ totalTokens: 16 }), { turnId: 'aggregate-turn' });
    expect(vi.mocked(options.onUsageIncomplete!).mock.calls.length).toBe(completeness === 'partial' ? 1 : 0);
  });

  it('reports session totals under their native cumulative accounting contract', async () => {
    configuration.session = { mode: 'generated', startArgs: ['--session-id', '{sessionId}'], resumeArgs: ['--resume', '{sessionId}'] };
    configuration.output = { ...structured(), usage: usage('complete', 'session') };
    const session = await open(); expect(session.usageSource).toBe('native-thread-totals');
    expect(await session.run('Native cumulative receipt.', 'session-total-turn', workspace, vi.fn())).toBe('completed');
    expect(options.onUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ totalTokens: 16 }), { turnId: 'session-total-turn' });
  });

  it('rejects overlapping turns while reaping the previous process before another launch', async () => {
    const session = await open();
    expect(await session.run('First turn.', 'first-turn', workspace, vi.fn())).toBe('completed');
    const next = session.run('Second turn.', 'second-turn', workspace, vi.fn());
    await expect(session.run('Forbidden overlapping turn.', 'third-turn', workspace, vi.fn())).rejects.toThrow('math_cli_turn_active');
    expect(await next).toBe('completed'); expect(calls()).toHaveLength(2);
  });

  it.each(['missing-usage', 'zero-usage', 'bad-subset', 'bad-output-subset', 'overflow-usage', 'trailing-invalid-usage'])
    ('records %s as unavailable and never falls back to an older matching aggregate', async name => {
      scenario(name); const session = await open();
      expect(await session.run('Unknown usage fixture.', 'unknown-turn', workspace, vi.fn())).toBe('completed');
      expect(options.onUsage).not.toHaveBeenCalled(); expect(options.onUsageIncomplete).toHaveBeenCalledExactlyOnceWith();
    });

  it('never substitutes aggregate input for missing explicit context occupancy', async () => {
    const mapping = usage(); delete (mapping as Partial<typeof mapping>).lastInputTokens;
    configuration.output = { ...structured(), usage: mapping };
    const session = await open();
    expect(await session.run('No occupancy measurement.', 'context-turn', workspace, vi.fn())).toBe('completed');
    expect(options.onUsage).toHaveBeenCalledOnce(); expect(session.lastInputTokens).toBeUndefined();
  });

  it.each(['authentication', 'context', 'rate-limit', 'request', 'invalid-request'] as const)
    ('maps only configured %s failures to safe recovery metadata', async reason => {
      scenario('failure-' + reason);
      configuration.output = { ...structured(), failures: [{ when: { field: '/reason', value: reason }, reason }] };
      const session = await open();
      expect(await session.run('Safe error fixture.', 'failure-turn', workspace, vi.fn())).toBe('failed');
      const codes = { authentication: 'unauthorized', context: 'contextWindowExceeded', 'rate-limit': 'rateLimitExceeded',
        request: 'httpConnectionFailed', 'invalid-request': 'badRequest' };
      expect(session.lastFailureDiagnostic?.code).toBe(codes[reason]);
      expect(JSON.stringify([session.lastError, session.lastFailureDiagnostic, session.lastCompletedResponse,
        vi.mocked(options.onActivity!).mock.calls])).not.toMatch(/private|secret/u);
    });

  it.each(['nonzero', 'signal'])('makes %s exit a command failure and drains private stderr', async name => {
    scenario(name); const session = await open();
    expect(await session.run('Command failure fixture.', 'exit-turn', workspace, vi.fn())).toBe('failed');
    expect(session.lastError).toBe('math_cli_command_failed'); expect(session.lastCompletedResponse).toBeUndefined();
    expect(JSON.stringify([session.lastError, session.lastFailureDiagnostic])).not.toMatch(/private|secret/u);
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it.each(['invalid-json', 'invalid-utf8', 'oversized'])('stops %s protocol output safely', async name => {
    scenario(name); const session = await open();
    expect(await session.run('Bad protocol fixture.', 'protocol-turn', workspace, vi.fn())).toBe('failed');
    expect(session.lastError).toMatch(/^math_cli_(?:protocol_invalid|output_too_large)$/u);
    expect(options.onUsage).not.toHaveBeenCalled(); expect(options.onUsageIncomplete).toHaveBeenCalledOnce();
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it('waits for process exit before accounting even after a final JSONL result', async () => {
    scenario('final-then-wait'); const session = await open(); let settled = false;
    const run = session.run('Final output with live process.', 'open-turn', workspace, vi.fn()).then(value => { settled = true; return value; });
    await expect.poll(() => fs.existsSync(path.join(profile, 'cli-peer-ready'))).toBe(true);
    expect(settled).toBe(false); expect(options.onUsage).not.toHaveBeenCalled();
    expect(await session.stopForFreeze!()).toEqual({ status: 'unconfirmed', reason: 'turn-not-settled' });
    await session.interrupt(); expect(await run).toBe('interrupted');
    expect(options.onUsage).toHaveBeenCalledOnce(); expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it.each(['interrupt', 'abort', 'timeout'] as const)('stops a running command on %s', async action => {
    scenario('hang'); const controller = new AbortController();
    const session = await open({ ...options, signal: controller.signal, ...(action === 'timeout' ? { turnTimeoutMs: 100 } : {}) }), started = vi.fn();
    const run = session.run('Cancellation fixture.', 'cancel-turn', workspace, started);
    if (action !== 'timeout') {
      await expect.poll(() => started.mock.calls.length).toBe(1);
      if (action === 'abort') controller.abort(); else await session.interrupt();
    }
    expect(await run).toBe(action === 'timeout' ? 'failed' : 'interrupted');
    expect(session.lastError).toBe(action === 'timeout' ? 'math_model_request_timeout' : 'math_model_request_stopped');
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it.each(['jsonl', 'json'])('yields only for the validator-accepted exact completion file with %s output', async format => {
    scenario('hang'); const file = path.join(workspace, 'completed.json');
    configuration.output = structured(format);
    configuration.args = (configuration.args as string[]).map(value => value === 'jsonl' ? format : value);
    const validate = vi.fn((value: unknown) => { if ((value as { current?: boolean }).current !== true) throw new Error('stale'); });
    const session = await open({ ...options, turnTimeoutMs: 2_147_483_648, completedOutput: { file, validate } });
    const run = session.run('Completion fixture.', 'handoff-turn', workspace, vi.fn());
    fs.writeFileSync(path.join(workspace, 'other.json'), '{"current":true}'); fs.writeFileSync(file, '{"current":false}');
    await expect.poll(() => validate.mock.calls.length).toBeGreaterThan(0);
    expect(await session.stopForFreeze!()).toEqual({ status: 'unconfirmed', reason: 'turn-not-settled' });
    fs.writeFileSync(file, '{"current":true}'); expect(await run).toBe('submitted');
    expect(session.lastCompletedResponse).toBeUndefined(); expect(options.onUsage).not.toHaveBeenCalled();
    expect(options.onUsageIncomplete).toHaveBeenCalledOnce(); expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it('reaps a detached background writer before freezing sources', async () => {
    scenario('background'); const session = await open();
    expect(await session.run('Background fixture.', 'background-turn', workspace, vi.fn())).toBe('completed');
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
    const file = path.join(workspace, 'background.txt'), content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').toBe(content);
  });

  it('shares actual filesystem isolation for arbitrary shell-capable CLI children', async () => {
    scenario('isolation'); const hidden = path.join(root, 'hidden'); fs.mkdirSync(hidden);
    const secret = path.join(hidden, 'secret'), outside = path.join(root, 'outside'); fs.writeFileSync(secret, 'private fixture');
    const session = await open({ ...options, hiddenRoots: [hidden], environment: { ...options.environment,
      CLI_FIXTURE_HIDDEN: secret, CLI_FIXTURE_OUTSIDE: outside } });
    expect(await session.run('Isolation fixture.', 'isolation-turn', workspace, vi.fn())).toBe('completed');
    expect(JSON.parse(fs.readFileSync(path.join(profile, 'cli-peer-isolation.json'), 'utf8'))).toEqual({ hidden: 'denied', outside: 'denied' });
    expect(fs.readFileSync(path.join(workspace, 'owned.txt'), 'utf8')).toBe('owned'); expect(fs.existsSync(outside)).toBe(false);
  });

  it('rejects unsupported responsibility contracts and effort before launching a process', async () => {
    await expect(open({ ...options, readIsolation: { environment: {} as never } })).rejects.toThrow('math_cli_read_isolation_unsupported');
    await expect(open({ ...options, delegation: { mode: 'read-only', maxAgents: 2 } })).rejects.toThrow('math_cli_delegation_unsupported');
    await expect(open({ ...options, outputSchema: {} })).rejects.toThrow('math_cli_output_schema_unsupported');
    await expect(open({ ...options, skills: [{ name: 'fixture', path: '/never/SKILL.md', digest: 'a'.repeat(64), loading: 'native' }] }))
      .rejects.toThrow('math_cli_requires_file_skill');
    await expect(open({ ...options, effort: 'unsupported' })).rejects.toThrow('math_cli_effort_unsupported');
    expect(fs.existsSync(path.join(profile, 'cli-peer-calls.jsonl'))).toBe(false);
  });
});
