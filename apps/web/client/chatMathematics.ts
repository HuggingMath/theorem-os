import type { WebFormalizationActivity } from '../formalizationTypes';
import type { WebRun } from '../shared';

export type ChatMathematicalTask = { id: string; name: string; statement: string };
export type ChatMathematics = {
  checked: ChatMathematicalTask[];
  working: ChatMathematicalTask[];
  blockers: { id: string; text: string }[];
  latest?: { text: string; at?: string; kind: 'statement' | 'finding' };
};

/** A reading of recorded mathematical work; a checked helper never means the whole problem was accepted. */
export function chatMathematics(run?: WebRun, activity: readonly WebFormalizationActivity[] = []): ChatMathematics {
  const tasks = run?.observation?.inspection.tasks ?? [];
  const describe = (task: typeof tasks[number]): ChatMathematicalTask => ({ id: task.id,
    name: task.theorem || task.id, statement: task.informalStatement || task.objective || task.type || task.theorem || task.id });
  const checked = tasks.filter(task => task.control === 'active' && task.proof.status === 'checked'
    && !task.proof.conditions?.length && ['lemma', 'goal'].includes(task.kind)).map(describe);
  const working = tasks.filter(task => task.control === 'active' && ['running', 'delivered', 'conditional'].includes(task.status)
    && !checked.some(done => done.id === task.id)).map(describe);
  const blockers = tasks.filter(task => task.control === 'active' && ['blocked', 'failed'].includes(task.status))
    .map(task => ({ id: task.id, text: task.finding || task.feedback || task.informalStatement || task.objective }));
  let latest: ChatMathematics['latest'];
  for (const entry of activity) {
    if (entry.type !== 'step' || entry.step.step !== 'role' || entry.step.state !== 'finished'
      || !['plan', 'backtranslate'].includes(entry.step.role) || !entry.step.summary) continue;
    const summary = entry.step.summary;
    const text = summary.sections.filter(section => ['conclusions', 'targets', 'definitions'].includes(section.kind))
      .flatMap(section => section.items).join('\n\n') || summary.text;
    if (text) latest = { text, at: entry.at, kind: 'statement' };
  }
  const finding = [...tasks].reverse().find(task => task.control === 'active' && task.finding);
  // Task snapshots do not timestamp findings. A heartbeat is not the time a mathematical result was produced.
  if (finding) latest = { text: finding.finding!, kind: 'finding' };
  return { checked, working, blockers, ...(latest ? { latest } : {}) };
}
