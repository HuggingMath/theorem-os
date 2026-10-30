// The sample's Agent actions. Its scripted offline Agent (tests/fixtures/web-cooperative-codex.mjs) writes files itself
// instead of through Codex, so the recording has no actions; these are the writes it made, rebuilt from the recorded
// plans, proof sources and review, at the times the fixture makes them, and passed through the worker's sanitizer.
// Its own bookkeeping (test notes, delivery lines) is left out, as are commands and reasoning, which it never had.
// Usage: bun scripts/web-sample-actions.ts (rewrites apps/web/sample/run.json in place).
import fs from 'node:fs';
import path from 'node:path';
import { structuredPatch } from 'diff';
import { sanitizeAgentItem } from '../apps/web/agentActions';
import type { WebSampleFile } from '../apps/web/sample';
import type { WebAgentAction, WebAgentActionBody, WebEvent } from '../apps/web/shared';

// The container directory the fixture worked in; the sanitizer shows its paths relative to it.
const worktree = '/workspace';
// The Lead's note around its plan, as build-web-sample shows the fixture's English.
const route = '直接证明两个固定目标。';
const summary = '两个定理都用标准库里的直接证明；第二个等人修改计划后再开始。';

/** A unified diff as Codex reports a file update: hunks with one line of context and no file headers. */
function unified(before: string, after: string) {
  return structuredPatch('a', 'b', before, after, '', '', { context: 1 }).hunks.map(hunk =>
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`).join('');
}
const time = (value: string, offset: number) => new Date(Date.parse(value) + offset).toISOString();

export function sampleActions(sample: Pick<WebSampleFile, 'events' | 'observations'>): WebAgentAction[] {
  const events = sample.events, observations = sample.observations;
  const after = (from: WebEvent, test: (event: WebEvent) => boolean) => events.find(event => event.sequence > from.sequence && test(event));
  const turns = (workerId: string) => events.filter(event => event.type === 'turn_started' && event.details?.workerId === workerId);
  const lead = observations.at(-1)?.inspection?.workers.find(worker => worker.role === 'lead')?.id;
  if (!lead) throw new Error('sample has no Lead');
  const written: { at: string; body: WebAgentActionBody }[] = [];
  const write = (workerId: string, at: string, changes: { path: string; kind: 'add' | 'update'; diff: string }[]) => {
    const n = written.filter(item => item.body.workerId === workerId).length + 1;
    const body = sanitizeAgentItem('completed', { type: 'fileChange', id: `${n}:fixture-write`, status: 'completed',
      changes: changes.map(change => ({ path: path.posix.join(worktree, change.path), kind: { type: change.kind }, diff: change.diff })) },
    { workerId, worktree, hidden: [] });
    if (!body) throw new Error('sanitizer dropped a sample action');
    written.push({ at, body });
  };

  // Each Lead turn writes its plan into RESEARCH.md as soon as it starts; the host then reads it ("研究计划已更新").
  let notes: string | undefined;
  for (const turn of turns(lead)) {
    const updated = after(turn, event => event.type === 'plan_updated');
    const plan = updated && observations.find(item => item.observedAt > updated.at)?.plan;
    if (!plan) throw new Error(`no plan after Lead turn ${turn.sequence}`);
    const tasks = plan.tasks.map(task => ({ id: task.id, kind: task.kind, objective: task.objective, theoremName: task.theoremName,
      proofPath: task.proofPath, dependsOn: task.dependsOn, revision: task.revision, ownerId: task.ownerId, status: task.status }));
    const text = `${route}\n\n\`\`\`math-plan\n${JSON.stringify({ tasks, summary }, null, 2)}\n\`\`\`\n`;
    write(lead, time(turn.at, 1), [notes === undefined ? { path: 'RESEARCH.md', kind: 'add', diff: text } : { path: 'RESEARCH.md', kind: 'update', diff: unified(notes, text) }]);
    notes = text;
  }

  // The Engineer replaces its target's `sorry` 100 ms after guidance reaches it, or 50 ms into an unguided turn.
  const proofs: Record<string, [before: string, after: string]> = {
    goal_1: ['n + 0 = n := by sorry', 'n + 0 = n := by rfl'], goal_2: ['0 + n = n := by sorry', '0 + n = n := by exact Nat.zero_add n'] };
  const sources = [...new Set(observations.flatMap(item => item.sources.map(source => source.source)))];
  for (const assigned of events.filter(event => event.type === 'task_assigned' && event.details?.taskId && event.details.workerId)) {
    const taskId = assigned.details!.taskId!, workerId = assigned.details!.workerId!, proof = proofs[taskId];
    const turn = after(assigned, event => event.type === 'turn_started' && event.details?.workerId === workerId);
    const checked = turn && after(turn, event => event.type === 'task_checked' && event.details?.taskId === taskId);
    if (!proof || !turn || !checked) throw new Error(`no recorded proof turn for ${taskId}`);
    // The recorded source holding this proof whose `sorry` form is recorded too (goal_2 starts from goal_1 proved).
    const edited = sources.filter(text => text.includes(proof[1]) && sources.includes(text.replace(proof[1], proof[0])));
    if (edited.length !== 1) throw new Error(`no single recorded source for ${taskId}`);
    const source = edited[0]!.replace(proof[1], proof[0]);
    const guided = observations.at(-1)!.guidance.find(item => item.deliveredTo?.includes(workerId) &&
      item.updatedAt > turn.at && item.updatedAt < checked.at);
    write(workerId, guided ? time(guided.updatedAt, 100) : time(turn.at, 50),
      [{ path: 'generated/problem/Submission.lean', kind: 'update', diff: unified(source, source.replace(proof[0], proof[1])) }]);
  }

  // The reviewer writes its verdict 100 ms after it is asked to report.
  const assigned = events.find(event => event.type === 'review_assigned'), reviewer = assigned?.details?.workerId;
  const review = observations.at(-1)?.inspection?.review;
  const asked = reviewer && observations.at(-1)!.guidance.find(item => item.deliveredTo?.includes(reviewer));
  if (!reviewer || !review || !asked) throw new Error('no recorded review');
  write(reviewer, time(asked.updatedAt, 100), [{ path: 'RESEARCH.md', kind: 'add',
    diff: JSON.stringify({ commit: review.commit, verdict: review.status, summary: review.summary }, null, 2) + '\n' }]);

  return written.sort((a, b) => a.at.localeCompare(b.at)).map((item, index) => ({ ...item.body, sequence: index + 1, at: item.at }));
}

if (import.meta.main) {
  const file = path.resolve('apps/web/sample/run.json');
  const sample = JSON.parse(fs.readFileSync(file, 'utf8')) as WebSampleFile;
  sample.actions = sampleActions(sample);
  sample.run = { ...sample.run, actions: { count: sample.actions.length } };
  fs.writeFileSync(file, JSON.stringify(sample) + '\n');
  console.log(`Wrote ${sample.actions.length} actions to ${path.relative(process.cwd(), file)}`);
}
