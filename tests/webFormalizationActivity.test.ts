import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormalizationActivity, formalizationLeanFailure, formalizationSlot } from '../apps/web/formalizationActivity';
import { isWebFormalizationActivityBody } from '../apps/web/formalizationActivityValidation';
import { webFormalizationActivityLimits, type WebFormalizationActivityBody } from '../apps/web/formalizationTypes';
import { webAgentActionLimits } from '../apps/web/shared';
import { parseFormalizationMessage } from '../apps/web/runner';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';

const KEY = 'sk-activity-private-key';
const PROTOCOL = 'Bind every conclusion to its exact span identifiers and the Lean target names it must produce.';
const DESCRIPTION = 'An exact substring of parsed INPUT.statement, including its original whitespace and punctuation.';
type Item = Record<string, unknown>;
type Fake = { items: [phase: 'started' | 'completed', item: Item][]; output?: unknown; status?: string; fail?: Error };

describe('formalization process view for its owner', () => {
  let scratch: string, directory: string, sent: WebFormalizationActivityBody[];
  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalize-')));
    directory = path.join(scratch, 'run'); sent = [];
  });
  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const activity = () => createFormalizationActivity({ scratch, directory, root: '/app', apiKey: KEY, redact: ['https://gateway.private.example/v1'],
    send: entry => { sent.push(JSON.parse(JSON.stringify(entry))); } });
  function workspace(relative: string) {
    const where = path.join(directory, relative);
    fs.mkdirSync(where, { recursive: true });
    fs.writeFileSync(path.join(where, 'ROLE.md'), `${PROTOCOL}\n`);
    fs.writeFileSync(path.join(where, 'OUTPUT.schema.json'), JSON.stringify({ title: 'TheoremOS plan OUTPUT.json',
      properties: { spans: { description: DESCRIPTION } } }));
    return where;
  }
  /** A session that reports `items` while it runs, then writes `output` as OUTPUT.json. */
  const inner = (fake: Fake) => async (options: MathAgentOptions): Promise<MathAgentSession> => ({
    threadId: 'thread',
    run: async () => {
      for (const [phase, item] of fake.items) options.onItem?.(phase, item);
      if (fake.fail) throw fake.fail;
      if (fake.output !== undefined) fs.writeFileSync(path.join(options.workspace, 'OUTPUT.json'), JSON.stringify(fake.output));
      return fake.status ?? 'submitted';
    },
    interrupt: async () => {}, close: async () => {},
  });
  const options = (where: string): MathAgentOptions => ({ executable: 'codex', profile: '/profile', workspace: where, model: 'm', effort: 'max',
    instructions: `You are the planner.\n${PROTOCOL}\nStop after submitting.`, onUsage: () => {} });
  const command = (id: string, command: string, aggregatedOutput: string, extra: Item = {}): [ 'completed', Item ] =>
    ['completed', { type: 'commandExecution', id, command, aggregatedOutput, exitCode: 0, status: 'completed', cwd: '/workspace', ...extra }];

  it('shows a role its own workspace, masks credentials and host paths, and withholds the role protocol', async () => {
    const where = workspace('round-01-abc/plan-1'), view = activity();
    const session = await view.openSession(inner({ items: [
      command('c1', 'cat ROLE.md', `${PROTOCOL}\n`),
      command('c2', 'cat INPUT.json', JSON.stringify({ statement: 'n + 0 = n', feedback: `failed at ${directory}/round-01-abc/x` })),
      command('c3', 'env', `FORMALIZATION_RELAY_CAPABILITY=cap-0123456789\nOPENAI_API_KEY=${KEY}\nLANG=C.UTF-8`),
      command('c4', 'cat *', `{"description":"${DESCRIPTION}"}`),
      command('c5', 'ls', 'INPUT.json\nOUTPUT.schema.json\nROLE.md'),
      command('c6', 'cat /profile/config.toml', 'model = "m"'),
      ['completed', { type: 'reasoning', id: 'r1', summary: [`The key ${KEY} must not show. ${PROTOCOL}`] }],
      ['completed', { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'host prompt' }] }],
    ], output: { taskKind: 'prove', conclusions: [{ id: 'c', spanIds: ['s'], mathematics: 'n + 0 = n' }], assumptions: [], definitions: [],
      unresolved: [{ id: 'u', spanIds: ['s'], description: 'Is 0 natural?' }], objects: [] } }))(options(where));
    expect(await session.run('prompt', 'id', where, () => {})).toBe('submitted');
    const text = JSON.stringify(sent);
    for (const hidden of [KEY, scratch, PROTOCOL, DESCRIPTION, 'cap-0123456789', 'host prompt', 'model = "m"']) expect(text).not.toContain(hidden);
    expect(sent.every(isWebFormalizationActivityBody)).toBe(true);
    const actions = sent.flatMap(entry => entry.type === 'action' ? [entry.action] : []);
    expect(new Set(actions.map(action => action.workerId))).toEqual(new Set(['r1-plan-1']));
    const by = (id: string) => actions.find(action => action.itemId === `1:${id}`)!;
    expect(by('c1')).toMatchObject({ command: 'cat ROLE.md', withheld: true }); expect(by('c1').output).toBeUndefined();
    expect(by('c2').output).toContain('…/round-01-abc/x'); expect(by('c2').withheld).toBeUndefined();
    expect(by('c3').output).toBe('FORMALIZATION_RELAY_CAPABILITY=[REDACTED]\nOPENAI_API_KEY=[REDACTED]\nLANG=C.UTF-8');
    expect(by('c4')).toMatchObject({ withheld: true });
    expect(by('c5').output).toContain('ROLE.md');
    expect(by('c6')).toMatchObject({ withheld: true });
    expect(by('r1').text).toBe('The key [REDACTED] must not show. …');
    expect(actions.some(action => action.itemId === '1:u1')).toBe(false);
    const steps = sent.flatMap(entry => entry.type === 'step' ? [entry.step] : []);
    expect(steps).toEqual([
      { round: 1, step: 'role', workerId: 'r1-plan-1', role: 'plan', slot: 'plan-1', state: 'started' },
      { round: 1, step: 'role', workerId: 'r1-plan-1', role: 'plan', slot: 'plan-1', state: 'finished', summary: { taskKind: 'prove',
        sections: [{ kind: 'conclusions', items: ['n + 0 = n'] }, { kind: 'unresolved', items: ['Is 0 natural?'] }] } }]);
    await session.close();
    expect(sent.filter(entry => entry.type === 'step')).toHaveLength(2);
  });

  it('streams only sanitized public summaries and commentary, coalescing protocol-masked duplicates', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    let session: MathAgentSession | undefined;
    try {
      const where = workspace('round-01-abc/generate'), view = activity();
      let observer!: MathAgentOptions;
      const forwarded = vi.fn();
      session = await view.openSession(async options => { observer = options; return inner({ items: [] })(options); })({
        ...options(where), onItemUpdate: forwarded,
      });
      const actions = () => sent.flatMap(entry => entry.type === 'action' ? [entry.action] : []);
      observer.onItemUpdate!({ id: 'r', type: 'reasoning', summary: [`Inspect ${directory}/source using ${KEY}. ${PROTOCOL}`], content: ['raw never shown'] }, { turnId: 'turn' });
      expect(actions()).toHaveLength(1);
      expect(actions()[0]).toMatchObject({ workerId: 'r1-generate', itemId: '1:r', phase: 'started', textSource: 'summary' });
      const masked = actions()[0]!.text!;
      observer.onItemUpdate!({ id: 'r', type: 'reasoning', summary: [masked] });
      expect(actions()).toHaveLength(1);
      for (let index = 0; index < 100; index++) observer.onItemUpdate!({ id: 'r', type: 'reasoning', summary: [`Public step ${index}. ${PROTOCOL}`] });
      expect(actions()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(actions()).toHaveLength(2); expect(actions().at(-1)!.text).toBe('Public step 99. …');
      observer.onItemUpdate!({ id: 'r', type: 'reasoning', summary: ['Pending summary'] });
      observer.onItem!('completed', { id: 'r', type: 'reasoning', summary: ['Final public summary'] });
      observer.onItemUpdate!({ id: 'r', type: 'reasoning', summary: ['Late summary'] });
      observer.onItemUpdate!({ id: 'raw', type: 'reasoning', content: ['raw never shown'] });
      observer.onItem!('completed', { id: 'raw', type: 'reasoning', content: ['raw never shown'] });
      observer.onItemUpdate!({ id: 'm', type: 'agentMessage', phase: 'commentary', text: `Checking ${KEY}` });
      observer.onItemUpdate!({ id: 'm', type: 'agentMessage', phase: 'commentary', text: 'Latest public explanation' });
      observer.onItem!('completed', { id: 'm', type: 'agentMessage', phase: 'commentary', text: '' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(actions()).toHaveLength(5);
      expect(actions()[2]).toMatchObject({ itemId: '1:r', phase: 'completed', text: 'Final public summary', textSource: 'summary' });
      expect(actions().at(-1)).toMatchObject({ itemId: '1:m', phase: 'completed', text: 'Latest public explanation', textSource: 'commentary' });
      expect(forwarded).toHaveBeenCalledWith(expect.objectContaining({ id: 'r' }), { turnId: 'turn' });
      expect(sent.every(isWebFormalizationActivityBody)).toBe(true);
      const text = JSON.stringify(sent);
      for (const hidden of [KEY, scratch, PROTOCOL, 'raw never shown', 'Pending summary', 'Late summary']) expect(text).not.toContain(hidden);
    } finally { await session?.close(); vi.useRealTimers(); }
  });

  it.each(['interrupt', 'close', 'abort'] as const)('cancels pending formalization summary snapshots on %s', async method => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    let session: MathAgentSession | undefined;
    try {
      const where = workspace('round-01-abc/generate'), view = activity();
      let observer!: MathAgentOptions;
      const controller = new AbortController();
      session = await view.openSession(async options => { observer = options; return inner({ items: [] })(options); })({
        ...options(where), signal: controller.signal,
      });
      const actions = () => sent.filter(entry => entry.type === 'action');
      observer.onItemUpdate!({ id: 'r', type: 'reasoning', summary: ['First public summary'] });
      observer.onItemUpdate!({ id: 'r', type: 'reasoning', summary: ['Pending summary'] });
      expect(actions()).toHaveLength(1);
      if (method === 'abort') controller.abort();
      else await session[method]();
      await vi.advanceTimersByTimeAsync(1_000);
      observer.onItemUpdate!({ id: 'r', type: 'reasoning', summary: ['Late summary'] });
      expect(actions()).toHaveLength(1);
    } finally { await session?.close(); vi.useRealTimers(); }
  });

  it('retains long public summaries, role results, tool output and Lean diagnostics through the worker protocol', async () => {
    const where = workspace('round-01-abc/backtranslate'), view = activity();
    const publicText = 'A public mathematical explanation.\n'.repeat(500);
    const roleText = `${publicText}Inspect ${KEY} ${directory}/source.`;
    const diagnostic = `unsolved goals\n${'a detailed Lean goal\n'.repeat(70)}${KEY}`;
    const output = `${'a line of tool output\n'.repeat(800)}${KEY}`;
    const session = await view.openSession(inner({ items: [
      ['completed', { type: 'reasoning', id: 'r', summary: [`${publicText}${PROTOCOL}`], content: ['raw reasoning must stay hidden'] }],
      ['completed', { type: 'agentMessage', id: 'm', phase: 'commentary', text: `${publicText}${KEY}` }],
      command('output', 'lake build', output),
      command('lean', 'math check-lean', JSON.stringify({ exitCode: 1, timedOut: false,
        messages: Array.from({ length: webAgentActionLimits.leanMessages }, () => ({ severity: 'error', file: '/workspace/Formalization.lean', message: diagnostic })) })),
    ], output: { mathematics: roleText, assumptions: ['An assumption. '.repeat(100)], definitions: [] } }))(options(where));
    await session.run('p', 'id', where, () => {});
    const actions = sent.flatMap(entry => entry.type === 'action' ? [entry.action] : []);
    expect(actions).toHaveLength(4);
    expect(actions[0]).toMatchObject({ text: `${publicText}…`, textSource: 'summary' });
    expect(actions[1]).toMatchObject({ text: `${publicText}[REDACTED]`, textSource: 'commentary' });
    expect(actions[0]!.textClipped).toBeUndefined(); expect(actions[1]!.textClipped).toBeUndefined();
    expect(actions[2]!.output).toBe(output.replaceAll(KEY, '[REDACTED]')); expect(actions[2]!.outputClipped).toBeUndefined();
    expect(actions[3]!.lean!.messages).toHaveLength(webAgentActionLimits.leanMessages);
    expect(actions[3]!.lean!.messages.every(message => message.text === diagnostic.replaceAll(KEY, '[REDACTED]') && message.file === './Formalization.lean')).toBe(true);
    expect(sent.find(entry => entry.type === 'step' && entry.step.step === 'role' && entry.step.state === 'finished')).toMatchObject({
      step: { summary: { text: `${publicText}Inspect [REDACTED] …/source.`, sections: [{ kind: 'assumptions', items: ['An assumption. '.repeat(100).trim()] }] } },
    });

    const failing = view.elaborate(async () => { throw new Error(`formalization_elaboration_failed: Formalization.lean:7:3: error: ${KEY} ${directory}/source\n${'a long Lean failure\n'.repeat(200)}`); });
    await expect(failing(path.join(directory, 'e'), 'theorem t : True := by sorry', 'standard' as never, { timeoutMs: 0 })).rejects.toThrow('formalization_elaboration_failed');
    const failure = sent.at(-1)!;
    expect(failure).toMatchObject({ type: 'step', step: { step: 'compile', state: 'failed', lean: { messages: [
      { text: expect.stringContaining('[REDACTED] …/source') },
    ] } } });
    if (failure.type === 'step' && failure.step.step === 'compile') {
      expect(failure.step.lean!.messages[0]!.text).toHaveLength(webAgentActionLimits.leanMessage);
      expect(failure.step.lean!.messages[0]!.text.endsWith('…')).toBe(true);
    }
    for (const entry of sent) {
      expect(isWebFormalizationActivityBody(entry)).toBe(true);
      expect(parseFormalizationMessage(JSON.stringify({ type: 'activity', activity: entry }))).toEqual({ type: 'activity', activity: entry });
    }
    expect(JSON.stringify(sent)).not.toMatch(new RegExp(`${KEY}|raw reasoning must stay hidden`));
    for (const hidden of [scratch, PROTOCOL]) expect(JSON.stringify(sent)).not.toContain(hidden);
    await session.close();
  });

  it('allows maximum retained diagnostics and structured role summaries even with six-character JSON escapes', async () => {
    const where = workspace('round-01-abc/backtranslate'), view = activity();
    const diagnostic = '\u0000'.repeat(webAgentActionLimits.leanMessage);
    const summaryItem = '\u0000'.repeat(webFormalizationActivityLimits.summaryItem);
    const entries = Array.from({ length: webFormalizationActivityLimits.summaryItems }, () => summaryItem);
    const session = await view.openSession(inner({ items: [command('lean', 'math check-lean', JSON.stringify({ exitCode: 1, timedOut: false,
      messages: Array.from({ length: webAgentActionLimits.leanMessages }, () => ({ severity: 'error', file: '\u0000'.repeat(1_000), message: diagnostic })) }))],
      output: { mathematics: '\u0000'.repeat(webFormalizationActivityLimits.summaryText), assumptions: entries, definitions: entries,
        targets: entries.map((mathematics, index) => ({ name: `target${index}`, mathematics })) },
    }))(options(where));
    await session.run('p', 'id', where, () => {});
    const action = sent.find(entry => entry.type === 'action');
    expect(action).toBeDefined();
    if (action?.type === 'action') {
      expect(action.action.lean!.messages).toHaveLength(webAgentActionLimits.leanMessages);
      expect(action.action.lean!.messages.every(message => message.text === diagnostic)).toBe(true);
    }
    const role = sent.find(entry => entry.type === 'step' && entry.step.step === 'role' && entry.step.state === 'finished')!;
    expect(JSON.stringify(action).length).toBeGreaterThan(512 * 1024);
    expect(JSON.stringify(role).length).toBeGreaterThan(512 * 1024);
    if (role.type === 'step' && role.step.step === 'role') expect(role.step.summary!.text).toHaveLength(webFormalizationActivityLimits.summaryText);
    for (const entry of sent) {
      expect(JSON.stringify(entry).length).toBeLessThanOrEqual(webFormalizationActivityLimits.encoded);
      expect(isWebFormalizationActivityBody(entry)).toBe(true);
      expect(parseFormalizationMessage(JSON.stringify({ type: 'activity', activity: entry }))).toEqual({ type: 'activity', activity: entry });
    }
    await session.close();
  });

  it('records each compilation with the statement Lean read and where it failed', async () => {
    const view = activity();
    const failing = view.elaborate(async () => { throw new Error(`formalization_elaboration_failed: Formalization.lean:7:3: error(lean.unknownIdentifier): unknown identifier 'Nat.foo'\nElaboration diagnostics: ${directory}/round-01-abc/elaboration`); });
    await expect(failing(path.join(directory, 'e'), 'theorem t : Nat.foo := by sorry', 'standard' as never, { timeoutMs: 0 })).rejects.toThrow('formalization_elaboration_failed');
    const passing = view.elaborate(async (_directory, source) => ({ source, targets: [{ name: 't', declarationHash: 'a'.repeat(64) }] }) as never);
    view.onEvent({ event: 'formalization_compilation_started', round: 2 });
    await passing(path.join(directory, 'f'), 'theorem t : 1 = 1 := by sorry', 'standard' as never, { timeoutMs: 0 });
    const infrastructure = view.elaborate(async () => { throw new Error(`formalization_lean_toolchain_unavailable: missing ${scratch}/lean`); });
    await expect(infrastructure(path.join(directory, 'g'), 'x', 'standard' as never, { timeoutMs: 0 })).rejects.toThrow();
    const aborted = new AbortController(); aborted.abort();
    const cancelled = view.elaborate(async () => { throw new Error('This operation was aborted'); });
    await expect(cancelled(path.join(directory, 'h'), 'x', 'standard' as never, { timeoutMs: 0, signal: aborted.signal })).rejects.toThrow();
    expect(sent.map(entry => entry.type === 'step' ? entry.step : undefined)).toEqual([
      { round: 1, step: 'compile', state: 'started', source: 'theorem t : Nat.foo := by sorry' },
      { round: 1, step: 'compile', state: 'failed', lean: { passed: false, messages: [{ severity: 'error', line: 7, column: 2,
        text: "unknown identifier 'Nat.foo'" }] } },
      { round: 2, step: 'compile', state: 'started', source: 'theorem t : 1 = 1 := by sorry' },
      { round: 2, step: 'compile', state: 'passed', targets: ['t'] },
      { round: 2, step: 'compile', state: 'started', source: 'x' },
      { round: 2, step: 'compile', state: 'failed', text: 'formalization_lean_toolchain_unavailable: missing …/lean' },
      { round: 2, step: 'compile', state: 'started', source: 'x' }]);
  });

  it('shows warnings and informational diagnostics from successful host compilations and preserves later failure details', async () => {
    const view = activity();
    const diagnostics = { exitCode: 0, timedOut: false, omittedMessages: 0, messages: [
      { severity: 'warning', file: `${directory}/project/Formalization.lean`, line: 4, column: 2, message: `declaration uses sorry ${KEY}` },
      { severity: 'info', file: '/workspace/Formalization.lean', line: 5, column: 0, message: 'elaborated target' },
    ] };
    const passing = view.elaborate(async (_directory, source) => ({ source, targets: [{ name: 'target', declarationHash: 'a'.repeat(64) }],
      compilation: { exitCode: 0, timedOut: false, diagnostics } }) as never);
    await passing(path.join(directory, 'successful-compile'), 'theorem target : True := by sorry', 'standard' as never, { timeoutMs: 0 });
    const lean = { passed: true, messages: [
      { severity: 'warning', file: '…/project/Formalization.lean', line: 4, column: 2, text: 'declaration uses sorry [REDACTED]' },
      { severity: 'info', file: './Formalization.lean', line: 5, column: 0, text: 'elaborated target' },
    ] };
    expect(sent.at(-1)).toMatchObject({ type: 'step', step: { step: 'compile', state: 'passed', targets: ['target'], lean } });

    const failing = view.elaborate(async where => {
      fs.mkdirSync(where, { recursive: true }); fs.writeFileSync(path.join(where, 'diagnostics.json'), JSON.stringify(diagnostics));
      throw new Error(`formalization_detailed_context_missing: ${KEY}`);
    });
    await expect(failing(path.join(directory, 'context-failure'), 'theorem target : True := by sorry', 'standard' as never, { timeoutMs: 0 })).rejects.toThrow('formalization_detailed_context_missing');
    expect(sent.at(-1)).toMatchObject({ type: 'step', step: { step: 'compile', state: 'failed', lean, text: 'formalization_detailed_context_missing: [REDACTED]' } });
    for (const entry of sent) {
      expect(isWebFormalizationActivityBody(entry)).toBe(true);
      expect(parseFormalizationMessage(JSON.stringify({ type: 'activity', activity: entry }))).toEqual({ type: 'activity', activity: entry });
    }
  });

  it('reads all retained host diagnostics from the known compilation directory instead of the first-error preview', async () => {
    const view = activity();
    const failure = `unsolved goals\n${KEY} ${directory}/source\n${'a detailed Lean goal\n'.repeat(120)}`;
    const messages = [
      { severity: 'warning', file: '/workspace/Formalization.lean', line: 3, column: 1, message: `a warning ${KEY}` },
      { severity: 'info', file: `${directory}/project/Formalization.lean`, line: 4, column: 0, message: 'an informational diagnostic' },
      { severity: 'error', file: `${directory}/project/Formalization.lean`, line: 7, column: 2, message: failure },
      ...Array.from({ length: webAgentActionLimits.leanMessages - 3 }, (_, index) => ({ severity: 'error', file: 'Formalization.lean', line: index + 10, column: 0, message: `error ${index}` })),
    ];
    const failing = view.elaborate(async where => {
      fs.mkdirSync(where, { recursive: true });
      fs.writeFileSync(path.join(where, 'diagnostics.json'), JSON.stringify({ exitCode: 1, timedOut: false, omittedMessages: 2,
        stdout: 'x'.repeat(2_000_100), messages }));
      throw new Error('formalization_elaboration_failed: Formalization.lean:1:1: error: first-error preview\nElaboration diagnostics: /profile/untrusted-path');
    });
    await expect(failing(path.join(directory, 'failed-compile'), 'theorem target : True := by sorry', 'standard' as never, { timeoutMs: 0 })).rejects.toThrow('first-error preview');
    const entry = sent.at(-1)!;
    expect(entry).toMatchObject({ type: 'step', step: { step: 'compile', state: 'failed', lean: { passed: false, omittedMessages: 2 } } });
    if (entry.type === 'step' && entry.step.step === 'compile') {
      const lean = entry.step.lean!;
      expect(lean.messages).toHaveLength(webAgentActionLimits.leanMessages);
      expect(lean.messages[0]).toMatchObject({ severity: 'error', file: '…/project/Formalization.lean', line: 7, column: 2,
        text: expect.stringContaining('unsolved goals\n[REDACTED] …/source') });
      expect(lean.messages[0]!.text).toHaveLength(webAgentActionLimits.leanMessage);
      expect(lean.messages[0]!.text.endsWith('…')).toBe(true);
      expect(lean.messages.slice(-2)).toEqual([
        { severity: 'warning', file: './Formalization.lean', line: 3, column: 1, text: 'a warning [REDACTED]' },
        { severity: 'info', file: '…/project/Formalization.lean', line: 4, column: 0, text: 'an informational diagnostic' },
      ]);
    }
    expect(isWebFormalizationActivityBody(entry)).toBe(true);
    expect(parseFormalizationMessage(JSON.stringify({ type: 'activity', activity: entry }))).toEqual({ type: 'activity', activity: entry });
    const recorded = JSON.stringify(sent);
    for (const hidden of [KEY, directory, 'first-error preview', '/profile/untrusted-path', 'x'.repeat(100)]) expect(recorded).not.toContain(hidden);
  });

  it('keeps saved diagnostic omissions and timeout state while cancellation emits no failure', async () => {
    const view = activity(), controller = new AbortController();
    const diagnostics = { exitCode: 124, timedOut: true, omittedMessages: 4,
      messages: Array.from({ length: webAgentActionLimits.leanMessages + 3 }, (_, index) => ({ severity: 'error', line: index + 1, column: 0, message: `error ${index}` })) };
    const failing = view.elaborate(async where => {
      fs.mkdirSync(where, { recursive: true }); fs.writeFileSync(path.join(where, 'diagnostics.json'), JSON.stringify(diagnostics));
      if (where.endsWith('cancelled')) controller.abort();
      throw new Error('formalization_elaboration_timeout');
    });
    await expect(failing(path.join(directory, 'timed-out'), 'source', 'standard' as never, { timeoutMs: 0 })).rejects.toThrow('formalization_elaboration_timeout');
    const entry = sent.at(-1)!;
    expect(entry).toMatchObject({ type: 'step', step: { step: 'compile', state: 'failed', lean: { passed: false, timedOut: true, omittedMessages: 7 } } });
    if (entry.type === 'step' && entry.step.step === 'compile') expect(entry.step.lean!.messages).toHaveLength(webAgentActionLimits.leanMessages);
    const count = sent.length;
    await expect(failing(path.join(directory, 'cancelled'), 'source', 'standard' as never, { timeoutMs: 0, signal: controller.signal })).rejects.toThrow('formalization_elaboration_timeout');
    expect(sent).toHaveLength(count + 1);
    expect(sent.at(-1)).toMatchObject({ type: 'step', step: { step: 'compile', state: 'started' } });
    expect(sent.every(isWebFormalizationActivityBody)).toBe(true);
  });

  it('carries the host feedback between rounds and a stop without repeating it', async () => {
    const view = activity(), first = workspace('round-01-abc/plan-1'), second = workspace('round-01-abc/plan-2');
    fs.writeFileSync(path.join(directory, 'round-01-abc', 'plan-failure-1.json'), JSON.stringify({ error: `formalization_plan_unbound_span: s9 in ${directory}` }));
    await (await view.openSession(inner({ items: [], output: {} }))(options(first))).run('p', 'i', first, () => {});
    await (await view.openSession(inner({ items: [], output: {} }))(options(second))).run('p', 'i', second, () => {});
    const feedback = `formalization_semantic_mismatch: reviewer-1 says the domain is ℤ, key ${KEY}\nElaboration diagnostics: ${directory}/x`;
    view.onEvent({ event: 'formalization_revision_requested', round: 1, error: feedback });
    view.onEvent({ event: 'formalization_role_started', round: 2, role: 'plan' });
    view.stopped('formalization_rounds_exhausted', feedback);
    const steps = sent.flatMap(entry => entry.type === 'step' ? [entry.step] : []);
    expect(steps.map(step => `${step.step}:${'state' in step ? step.state : 'stage' in step ? step.stage : ''}`))
      .toEqual(['role:started', 'role:finished', 'revision:plan', 'role:started', 'role:finished', 'revision:round', 'stopped:']);
    expect(steps[2]).toEqual({ round: 1, step: 'revision', stage: 'plan', text: 'formalization_plan_unbound_span: s9 in …' });
    expect(steps[5]).toEqual({ round: 1, step: 'revision', stage: 'round', text: 'formalization_semantic_mismatch: reviewer-1 says the domain is ℤ, key [REDACTED]' });
    expect(steps[6]).toEqual({ round: 2, step: 'stopped', reason: 'formalization_rounds_exhausted' });
    view.stopped('formalization_failed', 'formalization_role_incomplete:failed:responseStreamDisconnected');
    view.stopped('formalization_time_limit', 'formalization_time_limit');
    expect(sent.slice(-2).map(entry => entry.type === 'step' && entry.step)).toEqual([
      { round: 2, step: 'stopped', reason: 'formalization_failed', text: 'formalization_role_incomplete:failed:responseStreamDisconnected' },
      { round: 2, step: 'stopped', reason: 'formalization_time_limit' }]);
    view.onEvent({ event: 'formalization_approved', round: 2 });
    expect(sent.at(-1)).toEqual({ type: 'step', step: { round: 2, step: 'approved' } });
  });

  it('ends every role row once, failed when the session never handed in', async () => {
    const view = activity();
    const reviewer = workspace('round-02-abc/retry-def/compare-reviewer-1');
    const thrown = await view.openSession(inner({ items: [], fail: new Error('formalization_role_incomplete:failed:private text') }))(options(reviewer));
    await expect(thrown.run('p', 'i', reviewer, () => {})).rejects.toThrow(); await thrown.close();
    const interrupted = await view.openSession(inner({ items: [] }))(options(workspace('round-02-abc/backtranslate')));
    await interrupted.close();
    const failed = await view.openSession(inner({ items: [], status: 'failed' }))(options(workspace('round-02-abc/generate')));
    await failed.run('p', 'i', '', () => {});
    await expect(view.openSession(async () => { throw new Error('formalization_sandbox_canary_failed: x'); })(options(workspace('round-02-abc/refute'))))
      .rejects.toThrow();
    expect(sent.map(entry => entry.type === 'step' && entry.step.step === 'role' ? `${entry.step.workerId}:${entry.step.state}:${entry.step.reason ?? ''}` : ''))
      .toEqual(['r2-compare-reviewer-1:started:', 'r2-compare-reviewer-1:failed:formalization_role_incomplete',
        'r2-backtranslate:started:', 'r2-backtranslate:failed:formalization_role_interrupted',
        'r2-generate:started:', 'r2-generate:failed:formalization_role_failed', 'r2-refute:started:', 'r2-refute:failed:formalization_sandbox_canary_failed']);
    // Sessions outside a round directory are not a role this view knows; they run unobserved.
    const other = await view.openSession(inner({ items: [command('x', 'ls', 'a')] }))(options(path.join(scratch, 'elsewhere')));
    await other.run('p', 'i', '', () => {});
    expect(sent).toHaveLength(8);
  });

  it('reads a role lane from its workspace and reviews from their verdicts', () => {
    expect(formalizationSlot(directory, path.join(directory, 'round-03-x/retry-y/compare-reviewer-2')))
      .toEqual({ round: 3, slot: 'compare-reviewer-2', role: 'compare', workerId: 'r3-compare-reviewer-2' });
    expect(formalizationSlot(directory, path.join(directory, 'round-01-x/plan-2'))).toMatchObject({ role: 'plan', workerId: 'r1-plan-2' });
    for (const outside of ['round-01-x', 'round-01-x/elaboration/project', '../round-01-x/plan-1', 'round-00-x/plan-1', 'round-01-x/unknown'])
      expect(formalizationSlot(directory, path.join(directory, outside))).toBeUndefined();
    expect(formalizationLeanFailure('formalization_elaboration_failed: /tmp/a/project/Formalization.lean:2:1: error: x\ny\nElaboration diagnostics: /tmp/a'))
      .toEqual({ passed: false, messages: [{ severity: 'error', line: 2, column: 0, text: 'x\ny' }] });
    expect(formalizationLeanFailure('formalization_elaboration_failed: FormalizationContext.lean:2:1: error: x')).toBeUndefined();
    expect(formalizationLeanFailure('formalization_elaboration_failed: Lean did not finish elaborating the declarations.')).toBeUndefined();
  });

  it('accepts from the worker only the entries this view produces', () => {
    const action = { workerId: 'r1-plan-1', itemId: '1:a', phase: 'completed', kind: 'message', status: 'done', text: 'ok' };
    const valid: unknown[] = [{ type: 'action', action },
      { type: 'step', step: { round: 1, step: 'role', workerId: 'r1-plan-1', role: 'plan', slot: 'plan-1', state: 'finished',
        summary: { verdict: 'approved', text: 'faithful', sections: [{ kind: 'issues', items: ['x'], omitted: 2 }] } } },
      { type: 'step', step: { round: 1, step: 'compile', state: 'failed', lean: { passed: false, messages: [{ severity: 'error', line: 1, column: 0, text: 'e' }] } } },
      { type: 'step', step: { round: 2, step: 'revision', stage: 'round', text: 'fix' } },
      { type: 'step', step: { round: 2, step: 'stopped', reason: 'formalization_time_limit' } }];
    for (const entry of valid) {
      expect(isWebFormalizationActivityBody(entry)).toBe(true);
      expect(parseFormalizationMessage(JSON.stringify({ type: 'activity', activity: entry }))).toEqual({ type: 'activity', activity: entry });
    }
    for (const entry of [null, { type: 'action', action: { ...action, apiKey: KEY } }, { type: 'action', action, extra: 1 },
      { type: 'step', step: { round: 0, step: 'approved' } }, { type: 'step', step: { round: 1, step: 'approved', note: 'x' } },
      { type: 'step', step: { round: 1, step: 'role', workerId: 'r1 plan', role: 'plan', slot: 'plan-1', state: 'started' } },
      { type: 'step', step: { round: 1, step: 'role', workerId: 'r1', role: 'judge', slot: 'plan-1', state: 'started' } },
      { type: 'step', step: { round: 1, step: 'compile', state: 'started', source: 'x'.repeat(40_000) } },
      { type: 'step', step: { round: 1, step: 'stopped', reason: 'provider said secret' } },
      { type: 'step', step: { round: 1, step: 'revision', stage: 'round', text: 'x'.repeat(7_000) } },
      { type: 'event', step: { round: 1, step: 'approved' } }]) {
      expect(isWebFormalizationActivityBody(entry)).toBe(false);
      expect(parseFormalizationMessage(JSON.stringify({ type: 'activity', activity: entry }))).toBeUndefined();
    }
  });
});
