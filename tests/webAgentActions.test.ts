import { describe, expect, test, vi } from 'vitest';
import type { MathAgentOptions } from '../src/runtime/codexSession';
import { isWebAgentActionBody, sanitizeAgentItem, unwrapShell, type AgentActionContext } from '../apps/web/agentActions';
import { webAgentActionLimits, type WorkerInput } from '../apps/web/shared';
import type { SolverProblem } from '../src/solver/problem';
import type { SolverRunState } from '../src/solver/archive';

const { opened } = vi.hoisted(() => ({ opened: [] as MathAgentOptions[] }));
vi.mock('../src/runtime/codexSession', async original => ({ ...await original<object>(),
  createCodexMathSession: async (options: MathAgentOptions) => { opened.push(options); return {}; } }));
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
    const many = Array.from({ length: 15 }, (_, index) => ({ severity: 'error', message: `error ${index}` }));
    expect(done({ type: 'commandExecution', command: 'math check-lean', aggregatedOutput: checkResult(1, many) })!.lean)
      .toMatchObject({ omittedMessages: 3, messages: expect.arrayContaining([{ severity: 'error', text: 'error 11' }]) });
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
    const long = done({ type: 'commandExecution', exitCode: 2, cwd: own, command: 'lake build', aggregatedOutput: 'a'.repeat(5_000) + 'b'.repeat(5_000) })!;
    expect(long).toMatchObject({ status: 'failed', exitCode: 2, outputClipped: true });
    expect(long.output!.length).toBeLessThanOrEqual(webAgentActionLimits.output);
    expect(long.output!.startsWith('a'.repeat(100)) && long.output!.endsWith('b'.repeat(100))).toBe(true);
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

  test('reasoning shows its summary, or its text when there is no summary; the host\'s prompts are not actions', () => {
    expect(done({ type: 'reasoning', summary: ['**Plan** use `Nat.zero_add`.'], content: ['raw chain'] })).toMatchObject({ kind: 'reasoning', text: '**Plan** use `Nat.zero_add`.' });
    expect(done({ type: 'reasoning', summary: [''], content: ['First try rfl.', 'It fails: recursion is on the second argument.'] }))
      .toMatchObject({ text: 'First try rfl.\n\nIt fails: recursion is on the second argument.' });
    expect(done({ type: 'agentMessage', text: `Saved in ${own}/generated/problem/Submission.lean.` })).toMatchObject({ kind: 'message', text: 'Saved in ./generated/problem/Submission.lean.' });
    expect(done({ type: 'plan', text: '1. prove add_zero\n2. prove zero_add' })).toMatchObject({ kind: 'plan' });
    expect(done({ type: 'webSearch', query: 'Nat.zero_add mathlib' })).toMatchObject({ kind: 'search', query: 'Nat.zero_add mathlib' });
    expect(done({ type: 'mcpToolCall', server: 'math', tool: 'lookup', arguments: { name: 'Nat.zero_add', key } })).toMatchObject({ kind: 'tool', tool: 'math.lookup',
      arguments: '{"name":"Nat.zero_add","key":"[REDACTED]"}' });
    expect(done({ type: 'contextCompaction' })).toMatchObject({ kind: 'compaction' });
    expect(done({ type: 'userMessage', content: [{ type: 'text', text: 'host instructions' }] })).toBeUndefined();
    expect(sanitizeAgentItem('started', { id: 'm', type: 'agentMessage', text: '' }, context)).toBeUndefined();
    expect(done({ type: 'agentMessage', text: 'x'.repeat(5_000) })).toMatchObject({ textClipped: true });
  });

  test('the server accepts only the shape and limits the sanitizer writes', () => {
    const valid = done({ type: 'agentMessage', text: 'done' })!;
    expect(isWebAgentActionBody(valid)).toBe(true);
    for (const invalid of [{ ...valid, extra: 1 }, { ...valid, workerId: '../solver' }, { ...valid, itemId: '' }, { ...valid, kind: 'shell' },
      { ...valid, output: 'x'.repeat(webAgentActionLimits.output + 1) }, { ...valid, withheld: false },
      { ...valid, lean: { passed: true, messages: [], secret: 'x' } }, { ...valid, lean: { passed: true, messages: [{ severity: 'fatal', text: 'x' }] } },
      { ...valid, lean: { passed: false, messages: Array.from({ length: 13 }, () => ({ severity: 'error', text: 'x' })) } },
      { ...valid, found: [] }, { ...valid, found: [{ query: 'q', total: -1, names: [] }] },
      { ...valid, changes: [{ path: 'a', change: 'rename' }] }, { ...valid, intents: [{ type: 'write' }] }])
      expect(isWebAgentActionBody(invalid)).toBe(false);
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
    expect(sent).toEqual([1, 2].map(session => ({ workerId: 'engineer', itemId: `${session}:item-1`, phase: 'completed', kind: 'message', status: 'done', text: 'key [REDACTED]' })));
  });

  test('an isolated worker hides the application from every session and names the bundled commands', () => {
    const sent: { command?: string }[] = [];
    const request = { id: 'fixture', provider: { id: 'openai', name: 'Fixture', baseUrl: 'https://example.invalid/v1' },
      input: { apiKey: key, workers: 3, coordination: 'cooperative' } } as unknown as WorkerInput;
    const builds = '/opt/runtime-state';
    const modules = webSolverModules(request, { sink: action => sent.push(action), hidden: [app, run] }, { tools, hiddenRoots: [app, builds] });
    opened.length = 0;
    const hostCache = '/var/tmp/fixture-host-tactic-cache';
    void modules.M1.open({ workspace: own, hiddenRoots: [hostCache],
      environment: { DEEPSCIENTIST_MATH_WORKER_ID: 'engineer' } } as unknown as MathAgentOptions);
    expect(opened[0]!.hiddenRoots).toEqual([hostCache, app, builds]);
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
