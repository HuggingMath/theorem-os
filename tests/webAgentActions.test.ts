import { describe, expect, test, vi } from 'vitest';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { isWebAgentActionBody, sanitizeAgentItem, unwrapShell, type AgentActionContext } from '../apps/web/agentActions';
import { webAgentActionLimits, type WebAgentActionBody, type WorkerInput } from '../apps/web/shared';
import type { SolverProblem } from '../src/solver/problem';
import type { SolverRunState } from '../src/solver/archive';

const { opened, turns } = vi.hoisted(() => ({ opened: [] as MathAgentOptions[], turns: [] as Parameters<MathAgentSession['run']>[] }));
vi.mock('../src/runtime/codexSession', async original => ({ ...await original<object>(),
  createCodexMathSession: async (options: MathAgentOptions) => { opened.push(options); return {
    threadId: 'fixture', run: async (...args: Parameters<MathAgentSession['run']>) => { turns.push(args); return 'completed'; },
    interrupt: async () => {}, close: async () => {},
  }; } }));
const { webSolverModules } = await import('../apps/web/worker');

// The worker's layout: the application, its build state and the run directory holding every Agent's worktree.
const app = '/opt/theorem-os', run = '/work/run-abc123', own = `${run}/workspace/workers/engineer`;
// Agent shells cannot read the application; they run the bundled commands from outside it.
const tools = '/opt/theoremos-agent-tools/math.mjs';
const key = 'sk-agent-actions-fixture-key';
const context: AgentActionContext = { workerId: 'engineer', worktree: own, tool: tools, apiKey: key,
  hidden: [app, '/var/lib/theoremos/builds', run] };
const done = (item: Record<string, unknown>) => sanitizeAgentItem('completed', { id: 'item-1', status: 'completed', ...item }, context);
const checkResult = (exitCode: number, messages: unknown[]) => JSON.stringify({ exitCode, timedOut: false, stdout: `${app}/.lake/packages/mathlib`,
  messages, omittedMessages: 0 });
const library = { id: 'theorem-os-standard', revision: 'standard-v1', catalogDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) };
const libraryDeclaration = (name = 'Tutorial.zero_add', installation = 'not-installed') => ({ name, file: 'Submission/Library/Tutorial.lean',
  import: 'Submission.Library.Tutorial', sourceDigest: 'c'.repeat(64), installation, origin: { file: `${app}/library/Tutorial.lean` } });
const libraryCommand = (operation: string, result: unknown, extra: Record<string, unknown> = {}) => done({ type: 'commandExecution', exitCode: 0,
  cwd: own, command: `bun '${tools}' library ${operation}`, aggregatedOutput: JSON.stringify(result), ...extra });

describe('Agent actions as the run owner sees them', () => {
  test('a Lean check reads as its messages, errors first, with host paths masked', () => {
    const action = done({ type: 'commandExecution', exitCode: 1, durationMs: 1840, cwd: own,
      command: `/bin/bash -lc "bun ${tools} check-lean --workspace ${own}/generated/problem --file Submission.lean --timeout-seconds 120"`,
      aggregatedOutput: '{"event":"lean_lock_waiting","at":1}\n{"event":"lean_check_started","file":"Submission.lean"}\n' + checkResult(1, [
        { format: 'lean-json', severity: 'warning', file: `${own}/generated/problem/Submission.lean`, line: 3, column: 8, message: "declaration uses 'sorry'" },
        { format: 'lean-json', severity: 'error', file: `${own}/generated/problem/Submission.lean`, line: 5, column: 44, message: `unsolved goals\n⊢ 0 + n = n` },
        { format: 'raw', severity: 'note', message: 'not a Lean severity' }]) });
    expect(action).toEqual({ workerId: 'engineer', itemId: 'item-1', phase: 'completed', kind: 'command', status: 'failed', exitCode: 1, durationMs: 1840,
      command: 'math check-lean --workspace ./generated/problem --file Submission.lean --timeout-seconds 120',
      lean: { passed: false, messages: [
        { severity: 'error', file: './generated/problem/Submission.lean', line: 5, column: 44, text: 'unsolved goals\n⊢ 0 + n = n' },
        { severity: 'warning', file: './generated/problem/Submission.lean', line: 3, column: 8, text: "declaration uses 'sorry'" }] } });
    expect(isWebAgentActionBody(action)).toBe(true);
    const passed = done({ type: 'commandExecution', exitCode: 0, command: `bun '${tools}' check-lean --file Submission.lean`, aggregatedOutput: checkResult(0, []) });
    expect(passed).toMatchObject({ command: 'math check-lean --file Submission.lean', lean: { passed: true, messages: [] } });
    const many = Array.from({ length: webAgentActionLimits.leanMessages + 3 }, (_, index) => ({ severity: 'error', message: `error ${index}` }));
    expect(done({ type: 'commandExecution', command: 'math check-lean', aggregatedOutput: checkResult(1, many) })!.lean)
      .toMatchObject({ omittedMessages: 3, messages: expect.arrayContaining([{ severity: 'error', text: `error ${webAgentActionLimits.leanMessages - 1}` }]) });
  });

  test('long Lean diagnostics retain their messages and survive JSON escaping within the action envelope', () => {
    const text = `unsolved goals\n${'\u0000'.repeat(webAgentActionLimits.leanMessage - 15)}`;
    const file = `./${'\u0000'.repeat(998)}`;
    const messages = Array.from({ length: webAgentActionLimits.leanMessages }, () => ({ severity: 'error', file, message: text }));
    const command = 'math check-lean';
    const action = done({ type: 'commandExecution', exitCode: 1, command: command + '\u0000'.repeat(webAgentActionLimits.command - command.length),
      commandActions: Array.from({ length: webAgentActionLimits.intents }, () => ({ type: 'search', path: '\u0000'.repeat(1_000), query: '\u0000'.repeat(webAgentActionLimits.query) })),
      aggregatedOutput: checkResult(1, messages) })!;
    expect(action.lean!.messages).toHaveLength(webAgentActionLimits.leanMessages);
    expect(action.lean!.messages.every(message => message.text === text && message.file === file)).toBe(true);
    expect(action.lean!.omittedMessages).toBeUndefined();
    expect(JSON.stringify(action).length).toBeGreaterThan(512 * 1024);
    expect(isWebAgentActionBody(action)).toBe(true);

    const clipped = done({ type: 'commandExecution', exitCode: 1, command: 'math check-lean', aggregatedOutput: JSON.stringify({
      exitCode: 1, timedOut: false, omittedMessages: 4, messages: Array.from({ length: webAgentActionLimits.leanMessages + 3 }, () => ({
        severity: 'error', file: `${app}/hidden.lean`, message: `Inspect ${key} ${own}/Submission.lean\n${'x'.repeat(webAgentActionLimits.leanMessage)}`,
      })),
    }) })!;
    expect(clipped.lean!.messages).toHaveLength(webAgentActionLimits.leanMessages);
    expect(clipped.lean!.omittedMessages).toBe(7);
    expect(clipped.lean!.messages.every(message => message.text.length === webAgentActionLimits.leanMessage && message.text.endsWith('…'))).toBe(true);
    expect(clipped.lean!.messages[0]).toMatchObject({ file: '…', text: expect.stringContaining('Inspect [REDACTED] ./Submission.lean') });
    expect(JSON.stringify(clipped)).not.toMatch(/sk-agent-actions|\/opt\/|\/work\//);
    expect(isWebAgentActionBody(clipped)).toBe(true);
  });

  test('a Mathlib search reads as how many matched and the first names per query', () => {
    const results = (query: string, total: number) => ({ query, totalMatches: total, truncated: false,
      results: Array.from({ length: Math.min(total, 10) }, (_, index) => ({ name: `lemma_${index}`, qualifiedName: `Nat.${query}_${index}`,
        sourceFile: `${app}/.lake/packages/mathlib/Mathlib/Algebra/Group/Basic.lean`, sourceContext: 'theorem …' })) });
    const action = done({ type: 'commandExecution', exitCode: 0, command: `bun ${tools} search-lean --query zero_add --query add_comm`,
      aggregatedOutput: JSON.stringify({ queries: [results('zero_add', 12), results('add_comm', 0)] }) });
    expect(action).toMatchObject({ command: 'math search-lean --query zero_add --query add_comm', found: [
      { query: 'zero_add', total: 12, names: Array.from({ length: 8 }, (_, index) => `Nat.zero_add_${index}`) },
      { query: 'add_comm', total: 0, names: [] }] });
    expect(action).not.toHaveProperty('output');
    expect(isWebAgentActionBody(action)).toBe(true);
  });

  test('library searches report candidates and exact release identity without source or origin paths', () => {
    const action = libraryCommand('search', { schema: 'theorem-os.library-search.v1', library, query: 'zero_add', goal: '0 + n = n',
      hits: [libraryDeclaration(), libraryDeclaration('Tutorial.add_zero', 'installed-frozen')], namedReferences: [libraryDeclaration()] })!;
    expect(action).toMatchObject({ command: 'math library search', library: {
      library: { id: library.id, revision: library.revision, catalogDigest: library.catalogDigest }, operation: 'search', query: 'zero_add', goal: '0 + n = n',
      hits: [{ name: 'Tutorial.zero_add', installation: 'not-installed' }, { name: 'Tutorial.add_zero', installation: 'installed-frozen' }],
      namedReferences: [{ name: 'Tutorial.zero_add', installation: 'not-installed' }] } });
    expect(action).not.toHaveProperty('output'); expect(action).not.toHaveProperty('lean');
    expect(JSON.stringify(action)).not.toContain(app);
    expect(isWebAgentActionBody(action)).toBe(true);
    const many = libraryCommand('search', { schema: 'theorem-os.library-search.v1', library, query: key + 'q'.repeat(500),
      hits: Array.from({ length: 12 }, (_, i) => libraryDeclaration(`Tutorial.${i}.${'n'.repeat(300)}`)), namedReferences: [] })!;
    expect(many.library).toMatchObject({ omittedHits: 4, hits: expect.arrayContaining([{ name: expect.any(String), installation: 'not-installed' }]) });
    expect(many.library!.operation === 'search' && many.library.query.length).toBe(webAgentActionLimits.query);
    expect(many.library!.operation === 'search' && many.library.hits[0]!.name.length).toBe(webAgentActionLimits.name);
    expect(JSON.stringify(many)).not.toContain(key); expect(isWebAgentActionBody(many)).toBe(true);
  });

  test('library source reads report the current page without claiming the entire source was read', () => {
    for (const [offset, nextOffset, complete] of [[0, 2048, false], [2048, null, true]] as const) {
      const action = libraryCommand('get', { schema: 'theorem-os.library-source.v1', library, declaration: libraryDeclaration(), installation: 'not-installed',
        source: { text: `private source ${key} ${app}/library/Tutorial.lean`, offset, nextOffset, complete, note: 'Read every page' } })!;
      expect(action.library).toEqual({ library: { id: library.id, revision: library.revision, catalogDigest: library.catalogDigest }, operation: 'get',
        declaration: { name: 'Tutorial.zero_add', installation: 'not-installed' }, source: { offset, nextOffset, complete } });
      expect(action).not.toHaveProperty('output'); expect(action).not.toHaveProperty('lean');
      expect(JSON.stringify(action)).not.toMatch(/private source|\/opt\/|sk-agent/u);
      expect(isWebAgentActionBody(action)).toBe(true);
    }
  });

  test('library requests preserve queued versus already installed as tool reports', () => {
    for (const status of ['queued', 'already-installed']) {
      const installation = status === 'queued' ? 'not-installed' : 'installed-frozen';
      const action = libraryCommand('request', { schema: 'theorem-os.library-request-result.v1', library, status,
        declarations: [libraryDeclaration('Tutorial.zero_add', installation)], requestDigest: 'd'.repeat(64), nextStep: 'Save and return' })!;
      expect(action.library).toMatchObject({ operation: 'request', status, declarations: [{ name: 'Tutorial.zero_add', installation }] });
      expect(action).not.toHaveProperty('lean'); expect(action).not.toHaveProperty('output'); expect(isWebAgentActionBody(action)).toBe(true);
    }
  });

  test('library summaries require the matching command and schema and retain host read restrictions', () => {
    const result = { schema: 'theorem-os.library-search.v1', library, query: 'zero_add', hits: [libraryDeclaration()], namedReferences: [] };
    for (const action of [libraryCommand('get', result), libraryCommand('search', { ...result, schema: 'theorem-os.library-search.v2' }),
      libraryCommand('search', { ...result, hits: [libraryDeclaration('Tutorial.zero_add', 'applied')] }),
      libraryCommand('search', result, { command: 'echo result' }), libraryCommand('search', result, { cwd: '/tmp' }),
      libraryCommand('search', result, { command: `cat ${app}/catalog.json; math library search` })]) expect(action).not.toHaveProperty('library');
    expect(libraryCommand('search', result, { cwd: '/tmp' })).toMatchObject({ withheld: true });
    expect(libraryCommand('search', result, { command: `cat ${app}/catalog.json; math library search` })).toMatchObject({ withheld: true });
    for (const source of [{ offset: -1, nextOffset: 10, complete: false }, { offset: 10, nextOffset: 10, complete: false },
      { offset: 10, nextOffset: 20, complete: true }, { offset: 10, nextOffset: null, complete: false }])
      expect(libraryCommand('get', { schema: 'theorem-os.library-source.v1', library, declaration: libraryDeclaration(), installation: 'not-installed', source }))
        .not.toHaveProperty('library');
  });

  test('the worker protocol rejects malformed, oversized or extra library summary fields', () => {
    const search = libraryCommand('search', { schema: 'theorem-os.library-search.v1', library, query: 'zero_add', hits: [libraryDeclaration()], namedReferences: [] })!;
    const valid = search.library!;
    for (const summary of [{ ...valid, extra: true }, { ...valid, operation: 'apply' }, { ...valid, library: { ...library } },
      { ...valid, library: { ...valid.library, catalogDigest: 'not-a-digest' } }, { ...valid, query: 'q'.repeat(webAgentActionLimits.query + 1) },
      { ...valid, hits: Array.from({ length: 9 }, () => ({ name: 'T.x', installation: 'not-installed' })) },
      { ...valid, hits: [{ name: 'T.x', installation: 'applied' }] }, { ...valid, hits: [{ name: 'T.x', installation: 'not-installed', origin: '/opt/private' }] },
      { ...valid, omittedHits: -1 }, { ...valid, operation: 'get', source: { offset: 0, nextOffset: null, complete: true, text: 'source' } },
      { library: valid.library, operation: 'request', status: 'passed', declarations: [{ name: 'T.x', installation: 'installed-frozen' }] }])
      expect(isWebAgentActionBody({ ...search, library: summary })).toBe(false);
    expect(isWebAgentActionBody({ ...search, phase: 'started' })).toBe(false);
    expect(isWebAgentActionBody({ ...search, kind: 'message' })).toBe(false);
    expect(isWebAgentActionBody({ ...search, output: 'raw library source' })).toBe(false);
    expect(isWebAgentActionBody({ ...search, withheld: true })).toBe(false);
  });

  test('a command that touches host files keeps only the command, with those paths hidden', () => {
    const read = done({ type: 'commandExecution', exitCode: 0, command: `sed -n 1,80p ${app}/apps/web/server.ts`, aggregatedOutput: 'import fs from "node:fs";' });
    expect(read).toMatchObject({ command: 'sed -n 1,80p …', withheld: true });
    expect(read).not.toHaveProperty('output');
    const peer = done({ type: 'commandExecution', exitCode: 0, cwd: own, command: 'grep -rn sorry .',
      aggregatedOutput: `./generated/problem/Submission.lean:5\n${run}/workspace/workers/solver/RESEARCH.md:1` });
    expect(peer).toMatchObject({ command: 'grep -rn sorry .', withheld: true });
    const elsewhere = done({ type: 'commandExecution', exitCode: 0, cwd: '/tmp', command: 'ls', aggregatedOutput: 'notes' });
    expect(elsewhere).toMatchObject({ withheld: true });
    // A Lean check outside the Agent's worktree is not read either.
    expect(done({ type: 'commandExecution', exitCode: 1, cwd: '/', command: 'math check-lean', aggregatedOutput: checkResult(1, []) }))
      .toMatchObject({ withheld: true });
  });

  test('its own commands keep their output, without terminal colours, lock lines or the API key', () => {
    const action = done({ type: 'commandExecution', exitCode: 0, cwd: own, command: `bash -lc 'echo '\\''${key}'\\'' && lake env lean --version'`,
      aggregatedOutput: `\u001b[32m${key}\u001b[0m\n{"event":"lean_lock_acquired","at":2}\nLean (version 4.28.0)\n\n` });
    expect(action).toMatchObject({ command: "echo '[REDACTED]' && lake env lean --version", output: '[REDACTED]\nLean (version 4.28.0)', status: 'done' });
    const output = `${'first line\n'.repeat(1_600)}last line`;
    const retained = done({ type: 'commandExecution', exitCode: 0, cwd: own, command: 'lake build', aggregatedOutput: output })!;
    expect(retained.output).toBe(output); expect(retained.outputClipped).toBeUndefined();
    expect(isWebAgentActionBody(retained)).toBe(true);
    const long = done({ type: 'commandExecution', exitCode: 2, cwd: own, command: 'lake build',
      aggregatedOutput: 'a'.repeat(webAgentActionLimits.output) + 'b'.repeat(webAgentActionLimits.output) })!;
    expect(long).toMatchObject({ status: 'failed', exitCode: 2, outputClipped: true });
    expect(long.output).toBe(`${'a'.repeat(webAgentActionLimits.outputHead)}\n…\n${'b'.repeat(webAgentActionLimits.output - webAgentActionLimits.outputHead - 3)}`);
    expect(isWebAgentActionBody(long)).toBe(true);
    expect(sanitizeAgentItem('started', { id: 'run-1', type: 'commandExecution', status: 'inProgress', command: 'lake build', cwd: own }, context))
      .toEqual({ workerId: 'engineer', itemId: 'run-1', phase: 'started', kind: 'command', status: 'running', command: 'lake build' });
    expect(unwrapShell(`/bin/zsh -lc "echo \\"quoted\\" \\$HOME"`)).toBe('echo "quoted" $HOME');
  });

  test('file changes keep their diff inside the worktree and drop it for host files', () => {
    const action = done({ type: 'fileChange', changes: [
      { path: `${own}/generated/problem/Submission.lean`, kind: { type: 'update', move_path: null },
        diff: '@@ -5,1 +5,1 @@\n-theorem zero_add (n : Nat) : 0 + n = n := by sorry\n+theorem zero_add (n : Nat) : 0 + n = n := by simp\n' },
      { path: `${own}/RESEARCH.md`, kind: { type: 'add' }, diff: `Route: ${own}/generated/problem\n` },
      { path: `${app}/apps/web/server.ts`, kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] });
    expect(action).toEqual({ workerId: 'engineer', itemId: 'item-1', phase: 'completed', kind: 'edit', status: 'done', changes: [
      { path: './generated/problem/Submission.lean', change: 'update',
        diff: '@@ -5,1 +5,1 @@\n-theorem zero_add (n : Nat) : 0 + n = n := by sorry\n+theorem zero_add (n : Nat) : 0 + n = n := by simp\n' },
      { path: './RESEARCH.md', change: 'add', diff: 'Route: ./generated/problem\n' },
      { path: '…', change: 'update', clipped: true }] });
    const many = done({ type: 'fileChange', changes: Array.from({ length: 30 }, (_, index) => ({ path: `${own}/f${index}.lean`, kind: { type: 'add' }, diff: 'x'.repeat(5_000) })) })!;
    expect(many.changes).toHaveLength(webAgentActionLimits.changes);
    expect(many.omittedChanges).toBe(10);
    expect(many.changes!.reduce((sum, change) => sum + (change.diff?.length ?? 0), 0)).toBeLessThanOrEqual(webAgentActionLimits.diffs);
    expect(isWebAgentActionBody(many)).toBe(true);
  });

  test('long commands, tool arguments and file diffs keep their supported details within the envelope', () => {
    const command = `lean ${'argument '.repeat(800)}`.trim();
    const shell = done({ type: 'commandExecution', command })!;
    expect(shell.command).toBe(command);
    const argumentsValue = { text: 'evidence '.repeat(500), key };
    const tool = done({ type: 'mcpToolCall', tool: 'verify', arguments: argumentsValue })!;
    expect(tool.arguments).toBe(JSON.stringify({ ...argumentsValue, key: '[REDACTED]' }));
    const clipped = done({ type: 'mcpToolCall', tool: 'verify', arguments: { text: 'x'.repeat(webAgentActionLimits.arguments) } })!;
    expect(clipped.arguments).toHaveLength(webAgentActionLimits.arguments);
    expect(clipped.arguments!.endsWith('…')).toBe(true);

    const diff = '\u0000'.repeat(webAgentActionLimits.diff);
    const changes = done({ type: 'fileChange', changes: Array.from({ length: webAgentActionLimits.changes }, (_, index) => ({
      path: `${index}${'\u0000'.repeat(1_000)}`, kind: { type: 'update', move_path: '\u0000'.repeat(1_000) }, diff,
    })) })!;
    expect(changes.changes![0]!.diff).toBe(diff);
    expect(changes.changes![1]!.diff).toBe(diff);
    expect(changes.changes![2]).toMatchObject({ clipped: true });
    expect(changes.changes![2]!.diff).toBeUndefined();
    expect(changes.changes!.reduce((length, change) => length + (change.diff?.length ?? 0), 0)).toBe(webAgentActionLimits.diffs);
    for (const action of [shell, tool, clipped, changes]) expect(isWebAgentActionBody(action)).toBe(true);
  });

  test('reasoning shows only its public summary and commentary is explicitly marked; host prompts are not actions', () => {
    expect(done({ type: 'reasoning', summary: ['**Plan** use `Nat.zero_add`.'], content: ['raw chain'] }))
      .toMatchObject({ kind: 'reasoning', text: '**Plan** use `Nat.zero_add`.', textSource: 'summary' });
    expect(done({ type: 'reasoning', summary: [''], content: ['First try rfl.', 'It fails: recursion is on the second argument.'] }))
      .toBeUndefined();
    expect(done({ type: 'reasoning', content: ['raw reasoning'] })).toBeUndefined();
    expect(done({ type: 'agentMessage', phase: 'commentary', text: 'Checking the statement.' }))
      .toMatchObject({ kind: 'message', textSource: 'commentary', text: 'Checking the statement.' });
    expect(done({ type: 'agentMessage', phase: 'final', text: 'Final output.' })).not.toHaveProperty('textSource');
    expect(done({ type: 'agentMessage', text: `Saved in ${own}/generated/problem/Submission.lean.` })).toMatchObject({ kind: 'message', text: 'Saved in ./generated/problem/Submission.lean.' });
    expect(done({ type: 'plan', text: '1. prove add_zero\n2. prove zero_add' })).toMatchObject({ kind: 'plan' });
    expect(done({ type: 'webSearch', query: 'Nat.zero_add mathlib' })).toMatchObject({ kind: 'search', query: 'Nat.zero_add mathlib' });
    expect(done({ type: 'mcpToolCall', server: 'math', tool: 'lookup', arguments: { name: 'Nat.zero_add', key } })).toMatchObject({ kind: 'tool', tool: 'math.lookup',
      arguments: '{"name":"Nat.zero_add","key":"[REDACTED]"}' });
    expect(done({ type: 'contextCompaction' })).toMatchObject({ kind: 'compaction' });
    expect(done({ type: 'userMessage', content: [{ type: 'text', text: 'host instructions' }] })).toBeUndefined();
    expect(sanitizeAgentItem('started', { id: 'm', type: 'agentMessage', text: '' }, context)).toBeUndefined();
    const clipped = done({ type: 'agentMessage', text: 'x'.repeat(webAgentActionLimits.text + 1) })!;
    expect(clipped).toMatchObject({ textClipped: true, text: `${'x'.repeat(webAgentActionLimits.text - 1)}…` });
    expect(isWebAgentActionBody(clipped)).toBe(true);
  });

  test('long public summaries and commentary retain their sanitized text without exposing raw reasoning', () => {
    const paragraphs = ['First public step.\n'.repeat(500), 'Second public step.\n'.repeat(500)];
    const summary = done({ type: 'reasoning', summary: [...paragraphs, `Inspect ${own}/Submission.lean using ${key}.`], content: ['raw reasoning'] })!;
    expect(summary.text).toBe([...paragraphs, 'Inspect ./Submission.lean using [REDACTED].'].join('\n\n'));
    expect(summary.text!.length).toBeGreaterThan(8_000);
    expect(summary).toMatchObject({ textSource: 'summary' }); expect(summary.textClipped).toBeUndefined();
    const commentary = done({ type: 'agentMessage', phase: 'commentary', text: `${paragraphs.join('\n')} ${key} ${app}/secret` })!;
    expect(commentary.text).toBe(`${paragraphs.join('\n')} [REDACTED] …`);
    expect(commentary).toMatchObject({ textSource: 'commentary' }); expect(commentary.textClipped).toBeUndefined();
    for (const action of [summary, commentary]) {
      expect(isWebAgentActionBody(action)).toBe(true);
      expect(JSON.stringify(action)).not.toMatch(/raw reasoning|sk-agent-actions|\/opt\/|\/work\//);
    }
    const clipped = done({ type: 'reasoning', summary: ['x'.repeat(webAgentActionLimits.text + 1)], content: ['raw reasoning'] })!;
    expect(clipped).toMatchObject({ textSource: 'summary', textClipped: true, text: `${'x'.repeat(webAgentActionLimits.text - 1)}…` });
  });

  test('the server accepts only the shape and limits the sanitizer writes', () => {
    const valid = done({ type: 'agentMessage', text: 'done' })!;
    expect(isWebAgentActionBody(valid)).toBe(true);
    for (const invalid of [{ ...valid, extra: 1 }, { ...valid, workerId: '../solver' }, { ...valid, itemId: '' }, { ...valid, kind: 'shell' },
      { ...valid, textSource: 'summary' }, { ...valid, kind: 'command', textSource: 'commentary' },
      { ...valid, kind: 'reasoning', textSource: 'commentary' }, { ...valid, textSource: 'raw' },
      { ...valid, output: 'x'.repeat(webAgentActionLimits.output + 1) }, { ...valid, withheld: false },
      { ...valid, lean: { passed: true, messages: [], secret: 'x' } }, { ...valid, lean: { passed: true, messages: [{ severity: 'fatal', text: 'x' }] } },
      { ...valid, lean: { passed: false, messages: Array.from({ length: webAgentActionLimits.leanMessages + 1 }, () => ({ severity: 'error', text: 'x' })) } },
      { ...valid, lean: { passed: false, messages: [{ severity: 'error', text: 'x'.repeat(webAgentActionLimits.leanMessage + 1) }] } },
      { ...valid, found: [] }, { ...valid, found: [{ query: 'q', total: -1, names: [] }] },
      { ...valid, changes: [{ path: 'a', change: 'rename' }] }, { ...valid, intents: [{ type: 'write' }] }])
      expect(isWebAgentActionBody(invalid)).toBe(false);
    expect(isWebAgentActionBody({ ...valid, textSource: 'commentary' })).toBe(true);
    expect(isWebAgentActionBody({ ...valid, kind: 'reasoning', textSource: 'summary' })).toBe(true);
  });

  test.each(['lead', 'engineer', 'researcher', 'reviewer'])('the web %s explains mathematical progress on initial and continuation turns', async workerId => {
    const request = { id: 'fixture', input: { apiKey: key, workers: 4, coordination: 'cooperative' } } as unknown as WorkerInput;
    const instructions = 'Keep the frozen task and existing delivery protocol. Independent host checking accepts the proof.';
    opened.length = 0; turns.length = 0;
    const session = await webSolverModules(request, { sink: () => {}, hidden: [app, run] }).M1.open({
      workspace: own, instructions, environment: { DEEPSCIENTIST_MATH_WORKER_ID: workerId },
    } as unknown as MathAgentOptions);
    const onStarted = vi.fn(), messages = ['Original mathematical assignment.', 'Continue from the saved lemma and new Lean feedback.'];
    try {
      for (const [index, message] of messages.entries()) expect(await session.run(message, `turn-${index}`, own, onStarted)).toBe('completed');
      expect(opened).toHaveLength(1); expect(opened[0]!.instructions).toBe(instructions);
      expect(turns).toHaveLength(2);
      for (const [index, args] of turns.entries()) {
        expect(args[0].startsWith(`${messages[index]}\n\nPublic mathematical progress for the user:`)).toBe(true);
        expect(args[0]).toContain('public commentary messages in the language of the original problem');
        expect(args[0]).toContain('concrete lemma statements and their hypotheses');
        expect(args[0]).toContain('how Lean feedback changes the approach');
        expect(args[0]).toContain('what you will verify next');
        expect(args[0]).toContain('keep private reasoning and scratch work private');
        expect(args[0]).toContain('Keep the existing delivery contracts, allowed edits and independent proof acceptance unchanged');
        expect(args[0]).toContain('Continue the assigned work in this same turn');
        expect(args[0]).toContain('an update is not required before every command');
        expect(args.slice(1)).toEqual([`turn-${index}`, own, onStarted]);
      }
    } finally { await session.close(); }
  });

  test.each([false, true])('sessions without an observable worker retain their run messages (actions enabled: %s)', async observe => {
    const request = { id: 'fixture', input: { apiKey: key, workers: 1, coordination: 'cooperative' } } as unknown as WorkerInput;
    opened.length = 0; turns.length = 0;
    const originalItem = vi.fn(), originalUpdate = vi.fn(), instructions = 'Original session instructions.';
    const session = await webSolverModules(request, observe ? { sink: () => {}, hidden: [app, run] } : undefined).M1.open({
      workspace: own, instructions, onItem: originalItem, onItemUpdate: originalUpdate,
      environment: observe ? {} : { DEEPSCIENTIST_MATH_WORKER_ID: 'engineer' },
    } as unknown as MathAgentOptions);
    const onStarted = vi.fn();
    try {
      await session.run('Original turn instructions.', 'first', own, onStarted);
      await session.run('Original continuation instructions.', 'second', own, onStarted);
      expect(opened[0]).toMatchObject({ instructions, onItem: originalItem, onItemUpdate: originalUpdate });
      expect(turns).toEqual([
        ['Original turn instructions.', 'first', own, onStarted],
        ['Original continuation instructions.', 'second', own, onStarted],
      ]);
    } finally { await session.close(); }
  });

  test('the worker numbers each Codex session, so a restarted Agent never replaces its earlier items', () => {
    const sent: unknown[] = [];
    const request = { id: 'fixture', provider: { id: 'openai', name: 'Fixture', baseUrl: 'https://example.invalid/v1' },
      input: { apiKey: key, workers: 3, coordination: 'cooperative' } } as unknown as WorkerInput;
    const modules = webSolverModules(request, { sink: action => sent.push(action), hidden: [app, run] });
    opened.length = 0;
    for (let index = 0; index < 2; index++) void modules.M1.open({ workspace: own, environment: { DEEPSCIENTIST_MATH_WORKER_ID: 'engineer' } } as unknown as MathAgentOptions);
    void modules.M1.open({ workspace: own, environment: {} } as unknown as MathAgentOptions);
    for (const options of opened.slice(0, 2)) options.onItem!('completed', { id: 'item-1', type: 'agentMessage', text: `key ${key}` });
    expect(opened[2]!.onItem).toBeUndefined();
    expect(opened[2]!.onItemUpdate).toBeUndefined();
    expect(sent).toEqual([1, 2].map(session => ({ workerId: 'engineer', itemId: `${session}:item-1`, phase: 'completed', kind: 'message', status: 'done', text: 'key [REDACTED]' })));
  });

  test('the worker throttles and deduplicates sanitized public snapshots, and completion is authoritative', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    let session: MathAgentSession | undefined;
    try {
      const sent: WebAgentActionBody[] = [];
      const request = { id: 'fixture', provider: { id: 'openai', name: 'Fixture', baseUrl: 'https://example.invalid/v1' },
        input: { apiKey: key, workers: 1, coordination: 'cooperative' } } as unknown as WorkerInput;
      opened.length = 0;
      session = await webSolverModules(request, { sink: action => sent.push(action), hidden: [app, run] }).M1.open({
        workspace: own, environment: { DEEPSCIENTIST_MATH_WORKER_ID: 'engineer' },
      } as unknown as MathAgentOptions);
      const observer = opened[0]!;
      const update = (text: string) => observer.onItemUpdate!({ id: 'r', type: 'reasoning', summary: [text], content: ['raw never shown'] });
      update(`Inspect ${own}/Submission.lean with key ${key}`);
      update('Inspect ./Submission.lean with key [REDACTED]');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ workerId: 'engineer', itemId: '1:r', phase: 'started', status: 'running',
        kind: 'reasoning', textSource: 'summary', text: 'Inspect ./Submission.lean with key [REDACTED]' });
      for (let index = 0; index < 100; index++) update(`Public revision ${index}`);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(999); expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1); expect(sent).toHaveLength(2);
      expect(sent.at(-1)!.text).toBe('Public revision 99');
      update('A pending old snapshot');
      observer.onItem!('completed', { id: 'r', type: 'reasoning', summary: ['Authoritative final summary'], content: ['raw final'] });
      update('A late snapshot');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toHaveLength(3);
      expect(sent.at(-1)).toMatchObject({ itemId: '1:r', phase: 'completed', status: 'done', text: 'Authoritative final summary', textSource: 'summary' });
      expect(sent.every(isWebAgentActionBody)).toBe(true);
      expect(JSON.stringify(sent)).not.toMatch(/raw|sk-agent-actions|\/opt\/|\/work\//);
    } finally { await session?.close(); vi.useRealTimers(); }
  });

  test('the worker preserves the last public text on a textless completion and cancels pending updates on interruption', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    let session: MathAgentSession | undefined;
    try {
      const sent: WebAgentActionBody[] = [];
      const request = { id: 'fixture', provider: { id: 'openai', name: 'Fixture', baseUrl: 'https://example.invalid/v1' },
        input: { apiKey: key, workers: 1, coordination: 'cooperative' } } as unknown as WorkerInput;
      opened.length = 0;
      session = await webSolverModules(request, { sink: action => sent.push(action), hidden: [app, run] }).M1.open({
        workspace: own, environment: { DEEPSCIENTIST_MATH_WORKER_ID: 'engineer' },
      } as unknown as MathAgentOptions);
      const observer = opened[0]!;
      observer.onItemUpdate!({ id: 'm', type: 'agentMessage', phase: 'commentary', text: `Checking ${key}` });
      observer.onItemUpdate!({ id: 'm', type: 'agentMessage', phase: 'commentary', text: 'Latest public explanation.' });
      observer.onItem!('completed', { id: 'm', type: 'agentMessage', phase: 'commentary', text: '' });
      expect(sent.at(-1)).toMatchObject({ itemId: '1:m', phase: 'completed', textSource: 'commentary', text: 'Latest public explanation.' });
      observer.onItemUpdate!({ id: 'cancelled', type: 'reasoning', summary: ['First public snapshot'] });
      observer.onItemUpdate!({ id: 'cancelled', type: 'reasoning', summary: ['Pending public snapshot'] });
      const count = sent.length;
      await session.interrupt(); await vi.advanceTimersByTimeAsync(1_000);
      observer.onItemUpdate!({ id: 'cancelled', type: 'reasoning', summary: ['Late after cancellation'] });
      expect(sent).toHaveLength(count);
    } finally { await session?.close(); vi.useRealTimers(); }
  });

  test('an isolated worker hides the application from every session and names the bundled commands', () => {
    const sent: { command?: string }[] = [];
    const request = { id: 'fixture', provider: { id: 'openai', name: 'Fixture', baseUrl: 'https://example.invalid/v1' },
      input: { apiKey: key, workers: 3, coordination: 'cooperative' } } as unknown as WorkerInput;
    const builds = '/opt/runtime-state';
    const modules = webSolverModules(request, { sink: action => sent.push(action), hidden: [app, run] }, { tools, hiddenRoots: [app, builds] });
    opened.length = 0;
    void modules.M1.open({ workspace: own, environment: { DEEPSCIENTIST_MATH_WORKER_ID: 'engineer' } } as unknown as MathAgentOptions);
    expect(opened[0]!.hiddenRoots).toEqual([app, builds]);
    opened[0]!.onItem!('completed', { id: 'c', type: 'commandExecution', exitCode: 0, command: `bun ${tools} check-finite --json '{}'`, aggregatedOutput: '{}' });
    expect(sent[0]!.command).toBe("math check-finite --json '{}'");
    const problem = { projectRelative: '.', ownedFiles: ['Submission.lean'], declarations: {}, targets: [], receiptDigest: 'problem',
      baseCommit: 'fixed-commit', contract: { formalStatement: 'theorem target : True := by sorry', assumptions: [] } } as unknown as SolverProblem;
    const { instructions } = modules.M4.build(problem, {} as SolverRunState, { root: app, worktree: own, environment: {}, taskText: 'Prove it',
      retrievalRoot: own, frozenContexts: { 'Submission.lean': 'theorem target : True := by sorry' } });
    expect(instructions).toContain(`bun '${tools}' check-lean`);
    expect(instructions).not.toContain(`${app}/`);
    // Without isolation (the CLI and campaigns) nothing changes.
    expect(webSolverModules(request).M4.build(problem, {} as SolverRunState, { root: app, worktree: own, environment: {}, taskText: 'Prove it',
      retrievalRoot: own, frozenContexts: { 'Submission.lean': 'theorem target : True := by sorry' } }).instructions).toContain(`bun '${app}/bin/math.ts' check-lean`);
  });
});
