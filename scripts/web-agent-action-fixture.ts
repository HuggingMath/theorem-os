// A synthetic sample with Codex items of every kind the route map shows: reasoning, file reads, Mathlib searches,
// failing and passing Lean checks, edits, a command that read another Agent's files, a long build and messages.
// They are made up for local checks and screenshots and sit inside the sample's own turns; the file edits keep the
// sample's recorded diffs. Each raw item goes through the worker's sanitizer, so the map reads what a live run would
// store. Never shipped as the sample.
import { sanitizeAgentItem } from '../apps/web/agentActions';
import type { WebSampleFile } from '../apps/web/sample';
import type { WebAgentAction, WebAgentActionBody, WebEvent, WorkerMessage } from '../apps/web/shared';

// The worker's layout (apps/web/worker.ts): the application, its build state and the run directory with every worktree.
const app = '/opt/theorem-os', run = '/work/run-fixture', builds = '/var/lib/theoremos/builds';
const worktree = (workerId: string) => `${run}/workspace/workers/${workerId}`;
const submission = (workerId: string) => `${worktree(workerId)}/generated/problem/Submission.lean`;
// Agent shells run the bundled commands; the application itself is hidden from them.
const math = 'bun /opt/theoremos-agent-tools/math.mjs';
const checkCommand = (workerId: string) => `${math} check-lean --workspace ${worktree(workerId)}/generated/problem --file Submission.lean --timeout-seconds 120`;
/** What `math check-lean` prints: its lock and start lines, then its result as one JSON line with host paths in it. */
const checked = (workerId: string, exitCode: number, messages: { severity: string; line: number; column: number; message: string }[]) =>
  `{"event":"lean_lock_acquired","at":1}\n{"event":"lean_check_started","file":"Submission.lean"}\n` + JSON.stringify({ exitCode, timedOut: false,
    stdout: `${app}/.lake/packages/mathlib/.lake/build/lib/lean`, stderr: '',
    messages: messages.map(message => ({ format: 'lean-json', file: submission(workerId), ...message })), omittedMessages: 0 });
const searched = (queries: [string, number, string[]][]) => JSON.stringify({ queries: queries.map(([query, totalMatches, names]) => ({ query, totalMatches,
  truncated: false, results: names.map(name => ({ name: name.split('.').at(-1), qualifiedName: name, sourceFile: `${app}/.lake/packages/mathlib/Mathlib/Algebra/Group/Defs.lean` })) })) });
const source = (first: string, second: string) => `namespace Tutorial\n\ntheorem add_zero (n : Nat) : n + 0 = n := by ${first}\n\ntheorem zero_add (n : Nat) : 0 + n = n := by ${second}\n\nend Tutorial\n`;
const update = (file: string, diff: string) => ({ path: file, kind: { type: 'update', move_path: null }, diff });
type Raw = { at: number; workerId: string; session: number; phase: 'started' | 'completed'; item: Record<string, unknown> };

export function withAgentActions(base: WebSampleFile, buildOutput = Array.from({ length: 400 }, (_, index) => `✔ [${index + 1}/400] Built Tutorial.Part${index + 1} (${(index % 7) + 1}ms)`).join('\n')): WebSampleFile {
  const sample = structuredClone(base);
  const turn = (workerId: string, number: number) => {
    const found = sample.events.find((event: WebEvent) => event.type === 'turn_started' && event.details?.workerId === workerId && event.details.turn === number);
    if (!found) throw new Error(`the sample has no turn ${number} of ${workerId}; the action fixture follows its turns`);
    return Date.parse(found.at);
  };
  const recorded = (workerId: string, session: number) => {
    const diff = sample.actions?.find(action => action.workerId === workerId && action.itemId === `${session}:fixture-write`)?.changes?.[0]?.diff;
    if (!diff) throw new Error(`the sample has no recorded edit ${session} of ${workerId}`);
    return diff;
  };
  const [guidance, release] = sample.observations.at(-1)!.guidance.map(item => Date.parse(item.updatedAt));
  const raws: Raw[] = [];
  const add = (workerId: string, session: number, at: number, item: Record<string, unknown>) =>
    raws.push({ at, workerId, session, phase: 'completed', item: { status: item.exitCode ? 'failed' : 'completed', ...item } });
  // A command reports when it starts and again when it ends; the map keeps it where it started.
  const exec = (workerId: string, session: number, from: number, to: number, item: Record<string, unknown>) => {
    raws.push({ at: from, workerId, session, phase: 'started', item: { ...item, type: 'commandExecution', status: 'inProgress', aggregatedOutput: '', exitCode: undefined, durationMs: undefined } });
    add(workerId, session, to, { ...item, type: 'commandExecution', durationMs: to - from });
  };

  // The Lead's first turn: why the plan splits, its to-do list, the plan file and what it says.
  const lead = turn('solver', 1);
  add('solver', 1, lead + 10, { id: 'r1', type: 'reasoning', summary: ['**两个目标互不依赖**\n\n`add_zero` 按定义成立；`zero_add` 需要归纳或标准库引理。先交给 Engineer 证第一个，第二个等人确认路线。'], content: [] });
  add('solver', 1, lead + 30, { id: 'p1', type: 'plan', text: '1. Engineer 证明 add_zero（rfl）\n2. zero_add 暂停，等计划修改' });
  add('solver', 1, lead + 90, { id: 'e1', type: 'fileChange', changes: [{ path: `${worktree('solver')}/RESEARCH.md`, kind: { type: 'add' }, diff: recorded('solver', 1) }] });
  add('solver', 1, lead + 120, { id: 'm1', type: 'agentMessage', text: '计划已写入 RESEARCH.md：goal_1 先做，goal_2 暂停。' });

  // The Engineer on add_zero: reads, searches, tries rfl for both, Lean rejects zero_add, the guidance narrows it to add_zero.
  const engineer = turn('engineer', 1);
  add('engineer', 1, engineer + 20, { id: 'r1', type: 'reasoning', summary: ['**先看原题**\n\n两个定理都是 `sorry`。`n + 0` 按 `Nat.add` 的定义归约到 `n`。'], content: [] });
  exec('engineer', 1, engineer + 40, engineer + 58, { id: 'c1', command: `/bin/bash -lc "sed -n '1,40p' generated/problem/Submission.lean"`, cwd: worktree('engineer'),
    commandActions: [{ type: 'read', command: 'sed', name: 'Submission.lean', path: submission('engineer') }], aggregatedOutput: source('sorry', 'sorry'), exitCode: 0 });
  exec('engineer', 1, engineer + 80, engineer + 390, { id: 'c2', command: `${math} search-lean --query 'Nat.add_zero' --query 'n + 0 = n'`, cwd: worktree('engineer'),
    aggregatedOutput: searched([['Nat.add_zero', 3, ['Nat.add_zero', 'Nat.add_zero_iff', 'AddMonoid.add_zero']], ['n + 0 = n', 2, ['Nat.add_zero', 'add_zero']]]), exitCode: 0 });
  add('engineer', 1, engineer + 420, { id: 'e1', type: 'fileChange', changes: [update(submission('engineer'),
    '@@ -2,5 +2,5 @@\n \n-theorem add_zero (n : Nat) : n + 0 = n := by sorry\n+theorem add_zero (n : Nat) : n + 0 = n := by rfl\n \n-theorem zero_add (n : Nat) : 0 + n = n := by sorry\n+theorem zero_add (n : Nat) : 0 + n = n := by rfl\n \n')] });
  exec('engineer', 1, engineer + 440, guidance - 10, { id: 'c3', command: `/bin/bash -lc "${checkCommand('engineer')}"`, cwd: worktree('engineer'),
    aggregatedOutput: checked('engineer', 1, [{ severity: 'error', line: 5, column: 45, message: 'The rfl tactic failed. Possible reasons:\n- The goal is not a reflexive relation (neither `=` nor a relation with a @[refl] lemma).\n- The arguments of the relation are not equal.\nn : Nat\n⊢ 0 + n = n' }]),
    exitCode: 1 });
  add('engineer', 1, guidance + 40, { id: 'r2', type: 'reasoning', summary: ['**按指导只改 add_zero**\n\n`0 + n` 对第二个参数递归，`rfl` 算不下去。把 zero_add 恢复成 `sorry`，留给它自己的任务。'], content: [] });
  add('engineer', 1, guidance + 100, { id: 'e2', type: 'fileChange', changes: [update(submission('engineer'),
    '@@ -4,3 +4,3 @@\n \n-theorem zero_add (n : Nat) : 0 + n = n := by rfl\n+theorem zero_add (n : Nat) : 0 + n = n := by sorry\n \n')] });
  exec('engineer', 1, guidance + 120, guidance + 1_180, { id: 'c4', command: checkCommand('engineer'), cwd: worktree('engineer'),
    aggregatedOutput: checked('engineer', 0, [{ severity: 'warning', line: 5, column: 8, message: "declaration uses 'sorry'" }]), exitCode: 0 });
  add('engineer', 1, guidance + 1_220, { id: 'm1', type: 'agentMessage', text: 'add_zero 已用 `rfl` 证明，Lean 没有报错；zero_add 保持 `sorry`，按计划留给 goal_2。' });

  // The Engineer on zero_add: one search, the recorded edit, one passing check.
  const second = turn('engineer', 2);
  add('engineer', 2, second + 5, { id: 'r1', type: 'reasoning', summary: ['**直接用标准库**\n\n`Nat.zero_add` 正好是这个命题。'], content: [] });
  exec('engineer', 2, second + 10, second + 160, { id: 'c1', command: `${math} search-lean --query 'Nat.zero_add'`, cwd: worktree('engineer'),
    aggregatedOutput: searched([['Nat.zero_add', 1, ['Nat.zero_add']]]), exitCode: 0 });
  add('engineer', 2, second + 180, { id: 'e1', type: 'fileChange', changes: [update(submission('engineer'), recorded('engineer', 2))] });
  exec('engineer', 2, second + 200, second + 700, { id: 'c2', command: checkCommand('engineer'), cwd: worktree('engineer'), aggregatedOutput: checked('engineer', 0, []), exitCode: 0 });

  // The Lead's second turn, after the person's plan edit: its context was compacted, and it writes the edited plan.
  const revise = turn('solver', 2);
  add('solver', 2, revise + 2, { id: 'k1', type: 'contextCompaction' });
  add('solver', 2, revise + 8, { id: 'e1', type: 'fileChange', changes: [update(`${worktree('solver')}/RESEARCH.md`, recorded('solver', 2))] });
  add('solver', 2, revise + 14, { id: 'm1', type: 'agentMessage', text: '按修改后的计划：goal_2 依赖 goal_1，两个都开始。' });

  // The reviewer: reads the candidate, reads the Lead's notes in another worktree (withheld), checks it, builds, and reports.
  const review = turn('researcher-1', 1);
  add('researcher-1', 1, review + 20, { id: 'r1', type: 'reasoning', summary: ['**审阅完整候选**\n\n先读两个定理的最终版本，再独立跑一次 Lean 检查。'], content: [] });
  exec('researcher-1', 1, review + 40, review + 49, { id: 'c1', command: 'cat generated/problem/Submission.lean', cwd: worktree('researcher-1'),
    commandActions: [{ type: 'read', command: 'cat', name: 'Submission.lean', path: submission('researcher-1') }], aggregatedOutput: source('rfl', 'exact Nat.zero_add n'), exitCode: 0 });
  exec('researcher-1', 1, review + 60, review + 67, { id: 'c2', command: `cat ${worktree('solver')}/RESEARCH.md`, cwd: worktree('researcher-1'),
    aggregatedOutput: '直接证明两个固定目标。', exitCode: 0 });
  exec('researcher-1', 1, review + 80, review + 1_010, { id: 'c3', command: checkCommand('researcher-1'), cwd: worktree('researcher-1'), aggregatedOutput: checked('researcher-1', 0, []), exitCode: 0 });
  exec('researcher-1', 1, review + 1_030, release - 30, { id: 'c4', command: `/bin/bash -lc 'lake build 2>&1 | tail -n 400'`, cwd: worktree('researcher-1'),
    aggregatedOutput: buildOutput, exitCode: 0 });
  add('researcher-1', 1, release + 90, { id: 'e1', type: 'fileChange', changes: [{ path: `${worktree('researcher-1')}/RESEARCH.md`, kind: { type: 'add' }, diff: recorded('researcher-1', 1) }] });
  add('researcher-1', 1, release + 110, { id: 'm1', type: 'agentMessage', text: '审阅完成：同意提交。最终是否通过，以独立的 Lean 验收为准。' });

  sample.actions = raws.sort((a, b) => a.at - b.at).map((raw, index): WebAgentAction => {
    const body = sanitizeAgentItem(raw.phase, { ...raw.item, id: `${raw.session}:${String(raw.item.id)}` },
      { workerId: raw.workerId, worktree: worktree(raw.workerId), hidden: [app, builds, run], tool: '/opt/theoremos-agent-tools/math.mjs', apiKey: 'sk-action-fixture-never-shown' });
    if (!body) throw new Error(`the sanitizer dropped ${raw.workerId} ${String(raw.item.id)}`);
    return { ...body, sequence: index + 1, at: new Date(raw.at).toISOString() };
  });
  sample.run = { ...sample.run, actions: { count: sample.actions.length } };
  return sample;
}

/** What a worker sends for one Agent that writes and checks `rounds` times: a lane long enough to fold. */
export function longLane(rounds: number): WorkerMessage[] {
  return Array.from({ length: rounds }, (_, index): WorkerMessage[] => {
    const round = index + 1;
    const edit: WebAgentActionBody = { workerId: 'solver', itemId: `${round}:e1`, phase: 'completed', kind: 'edit', status: 'done',
      changes: [{ path: './generated/problem/Submission.lean', change: 'update', diff: `@@ -3,1 +3,1 @@\n-  omega -- try ${round - 1}\n+  omega -- try ${round}\n` }] };
    return [
      { type: 'progress', event: 'turn_started', message: 'Agent 正在构造候选 · solver', details: { workerId: 'solver', turn: round } },
      { type: 'action', action: edit },
      { type: 'progress', event: 'proof_checked', message: '候选检查完成 · solver', details: { workerId: 'solver', passed: round === rounds } },
    ];
  }).flat();
}
