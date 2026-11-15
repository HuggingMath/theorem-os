import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeMathSession } from '../src/runtime/openCodeSession';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';

const roots: string[] = [], sessions: MathAgentSession[] = [];
afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map(session => session.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fixture = (mode = '') => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-session-'))); roots.push(root);
  const workspace = path.join(root, 'workspace'), profile = path.join(root, 'profile'), hidden = path.join(root, 'hidden');
  for (const directory of [workspace, profile, hidden]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(hidden, 'secret'), 'hidden-canary');
  const executable = path.join(root, 'opencode-peer');
  fs.copyFileSync(path.resolve('tests/fixtures/openCodeNativePeer.mjs'), executable); fs.chmodSync(executable, 0o700);
  fs.writeFileSync(path.join(profile, 'opencode.json'), JSON.stringify({ provider: { fixture: {
    npm: '@ai-sdk/openai-compatible', models: { model: { name: 'Fixture', variants: { high: {} } } },
  } }, plugin: ['must-not-load'], mcp: { forbidden: { command: ['false'] } } }));
  const skillRoot = path.join(workspace, '.agents/skills/research'); fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '---\nname: research\ndescription: Research fixture.\n---\nRead the statement.\n');
  const skill = readMathAgentSkill(path.join(skillRoot, 'SKILL.md'), 'file');
  const usage = vi.fn(), missing = vi.fn(), activity = vi.fn(), items = vi.fn(), updates = vi.fn();
  const options: MathAgentOptions = { executable, workspace, profile, model: 'fixture/model', effort: 'high',
    instructions: 'Fixed theorem host contract.', skills: [skill], hiddenRoots: [hidden],
    environment: { PATH: process.env.PATH, THEOREMOS_OPENCODE_FIXTURE_MODE: mode },
    onUsage: usage, onUsageIncomplete: missing, onActivity: activity, onItem: items, onItemUpdate: updates };
  const open = async (override: Partial<MathAgentOptions> = {}) => {
    const session = await createOpenCodeMathSession({ ...options, ...override }); sessions.push(session); return session;
  };
  return { root, workspace, profile, hidden, options, open, usage, missing, activity, items, updates,
    state: () => JSON.parse(fs.readFileSync(path.join(profile, 'xdg/data/opencode-peer-state.json'), 'utf8')) };
};

describe('OpenCode native session adapter', () => {
  it('binds native IDs, streams tools and final text, accounts every assistant request once and resumes the same session', async () => {
    const f = fixture(), first = await f.open(), started = vi.fn();
    expect(first.threadId).toMatch(/^ses_fixture_/u); expect(first.usageSource).toBe('native-turn-totals');
    expect(await first.run('Continue research.', 'host-turn-1', f.workspace, started)).toBe('completed');
    expect(started).toHaveBeenCalledWith('host-turn-1');
    expect(f.usage).toHaveBeenCalledOnce();
    expect(f.usage).toHaveBeenLastCalledWith({ inputTokens: 25, outputTokens: 7, totalTokens: 32,
      cachedInputTokens: 5, reasoningOutputTokens: 1 }, { turnId: 'host-turn-1' });
    expect(first.lastInputTokens).toBe(15);
    expect(f.missing).not.toHaveBeenCalled();
    expect(f.activity.mock.calls.map(([event]) => event.event)).toContain('command_output');
    expect(f.items).toHaveBeenCalled(); expect(f.updates).toHaveBeenCalled();
    expect(first.lastCompletedResponse).toEqual({ turnId: 'host-turn-1', text: 'A saved result.' });
    const sent = f.state().requests.find((request: { method: string; body?: unknown }) => request.method === 'POST' && request.body &&
      Object.hasOwn(request.body, 'messageID')).body;
    expect(sent.parts[0].text).toContain(f.options.skills![0].path);
    expect(sent.system).toBe(f.options.instructions); expect(sent.variant).toBe('high');
    expect(await first.stopForFreeze!()).toEqual({ status: 'stopped' });
    const resumed = await f.open({ threadId: first.threadId });
    expect(resumed.threadId).toBe(first.threadId);
    expect(await resumed.run('Continue saved work.', 'host-turn-2', f.workspace, vi.fn())).toBe('completed');
    expect(Object.keys(f.state().sessions)).toHaveLength(1); expect(f.usage).toHaveBeenCalledTimes(2);
    expect(f.usage.mock.calls[1][0].totalTokens).toBe(32);
  });

  it('rejects unavailable effort before starting a session or prompt', async () => {
    const f = fixture();
    await expect(f.open({ effort: 'unavailable' })).rejects.toThrow('math_opencode_effort_unsupported');
    expect(f.state().requests.map((request: { route: string }) => request.route)).toEqual(['/provider']);
  });

  it('rejects a substituted session on native resume', async () => {
    const f = fixture('wrong-session'), first = await f.open(); await first.close();
    await expect(f.open({ threadId: first.threadId })).rejects.toThrow('math_opencode_session_binding_mismatch');
  });

  it('marks missing usage as incomplete and does not replace it with zero', async () => {
    const f = fixture('missing-usage'), session = await f.open();
    expect(await session.run('Research.', 'turn', f.workspace, vi.fn())).toBe('completed');
    expect(f.missing).toHaveBeenCalledOnce();
    expect(f.usage.mock.calls[0][0]).toMatchObject({ inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  });

  it.each(['zero-usage', 'partial-zero-usage'])('treats OpenCode synthetic %s counters as unknown provider usage', async mode => {
    const f = fixture(mode), session = await f.open();
    expect(await session.run('Research.', 'turn', f.workspace, vi.fn())).toBe('completed');
    expect(f.missing).toHaveBeenCalledOnce(); expect(f.usage).not.toHaveBeenCalled();
  });

  it('returns failed native provider results with unknown usage marked incomplete', async () => {
    const f = fixture('error'), session = await f.open();
    expect(await session.run('Research.', 'turn', f.workspace, vi.fn())).toBe('failed');
    expect(session.lastError).toBe('math_model_request_failed'); expect(session.lastError).not.toContain('secret-provider-canary');
    expect(f.missing).toHaveBeenCalledOnce();
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it('closes its owned writer after HTTP failure', async () => {
    const f = fixture('http-error'), session = await f.open();
    await expect(session.run('Research.', 'turn', f.workspace, vi.fn())).rejects.toThrow('math_model_request_failed');
    expect(session.lastFailureDiagnostic).toMatchObject({ code: 'httpConnectionFailed', httpStatusCode: 503 });
    expect(f.missing).toHaveBeenCalledOnce();
    expect(await session.stopForFreeze!()).toMatchObject({ status: 'stopped' });
  });

  it('interrupts a native turn and confirms writer shutdown after settlement', async () => {
    const f = fixture('hang'), session = await f.open(), started = vi.fn();
    const completion = session.run('Research.', 'turn', f.workspace, started);
    await expect.poll(() => f.state().requests.some((request: { route: string; method: string }) =>
      request.route.endsWith('/message') && request.method === 'POST')).toBe(true);
    expect(await session.stopForFreeze!()).toMatchObject({ status: 'unconfirmed', reason: 'turn-not-settled' });
    await session.interrupt();
    expect(await completion).toBe('interrupted'); expect(f.missing).toHaveBeenCalledOnce();
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it('hands back writing only after the host validates the saved completion file', async () => {
    const f = fixture('hang'), file = path.join(f.workspace, 'completed.json');
    const validate = vi.fn((value: unknown) => {
      if (!(value as { checked?: boolean }).checked) throw new Error('not-yet-complete');
    });
    const session = await f.open({ completedOutput: { file, validate } });
    const completion = session.run('Research.', 'turn', f.workspace, vi.fn());
    fs.writeFileSync(file, '{"checked":false}');
    await expect.poll(() => validate.mock.calls.length).toBeGreaterThan(0);
    expect(f.state().requests.some((request: { route: string }) => request.route.endsWith('/abort'))).toBe(false);
    fs.writeFileSync(file, '{"checked":true}');
    expect(await completion).toBe('submitted');
    expect(f.missing).toHaveBeenCalledOnce(); expect(f.usage).not.toHaveBeenCalled();
    expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it('bounds silent turns with the supplied timeout and closes the writer', async () => {
    const f = fixture('hang'), session = await f.open({ turnTimeoutMs: 50 });
    await expect(session.run('Research.', 'turn', f.workspace, vi.fn())).rejects.toThrow('math_model_request_timeout');
    expect(f.missing).toHaveBeenCalledOnce();
  });

  it('cancels a pending turn through the host signal', async () => {
    const f = fixture('hang'), controller = new AbortController(), session = await f.open({ signal: controller.signal });
    const completion = session.run('Research.', 'turn', f.workspace, vi.fn());
    await expect.poll(() => f.state().requests.some((request: { route: string; method: string }) =>
      request.route.endsWith('/message') && request.method === 'POST')).toBe(true);
    controller.abort(); await expect(completion).rejects.toThrow(); expect(f.missing).toHaveBeenCalledOnce();
  });

  it('fails before launch for unsupported native skill and delegation', async () => {
    const f = fixture();
    await expect(f.open({ skills: [{ ...f.options.skills![0], loading: 'native' }] })).rejects.toThrow('requires_file_skill');
    await expect(f.open({ delegation: { mode: 'read-only', maxAgents: 2 } })).rejects.toThrow('delegation_unsupported');
    expect(fs.existsSync(path.join(f.profile, 'xdg/data/opencode-peer-state.json'))).toBe(false);
  });

  it('keeps native turn usage observational instead of pretending it is provider-request admission', async () => {
    const f = fixture(), gate = vi.fn(), session = await f.open({ requestGate: gate });
    expect(await session.run('Research.', 'turn', f.workspace, vi.fn())).toBe('completed');
    expect(gate).not.toHaveBeenCalled(); expect(session.usageSource).toBe('native-turn-totals');
    expect(f.usage).toHaveBeenCalledOnce();
  });
});
