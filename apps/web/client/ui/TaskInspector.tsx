import { render } from 'preact';
import { jsonText } from '../collaborationUi';

export type InspectorDetail = { title: string; value: unknown; id: string };
export type InspectorArtifact = { kind: 'source' | 'check'; label: string; attributes: Record<string, string> };
export type InspectedTask = {
  id: string; version: string; kindLabel: string; state: string; stateLabel: string; proof: string; objective: string; historical: boolean;
  currentVersion?: string; facts: { name: string; value: string }[]; type: string; details: InspectorDetail[];
  artifacts: InspectorArtifact[]; hasChecks: boolean;
};
export type TaskInspectorProps =
  | { mode: 'empty' }
  | { mode: 'missing'; id: string; version: string; hasCurrent: boolean }
  | { mode: 'task'; task: InspectedTask };

// Detail blocks match collaborationUi.detailBlock. Preact never touches `open`, so the reader's choice survives updates.
const Detail = ({ title, value, id }: InspectorDetail) => <details class="collab-detail" data-detail-key={id}>
  <summary>{title}</summary><pre class="collab-code" tabIndex={0}>{typeof value === 'string' ? value : jsonText(value)}</pre></details>;

function Task({ task }: { task: InspectedTask }) {
  return <>
    <div class="collab-inspected-title" data-task-state={task.state} data-task-proof={task.proof}>
      <h4 data-inspected-task-heading data-focus-key={`inspected-${task.id}-${task.version}`} tabIndex={-1}>{task.id} · {task.kindLabel}</h4>
      {!task.historical && <span class="collab-inspected-state">{task.stateLabel}</span>}
    </div>
    {task.historical && <>
      <p class="collab-notice" data-task-history-notice>正在查看历史任务合同。{task.currentVersion ? `当前版本为 ${task.currentVersion}` : '当前计划已无此任务'}；旧合同未保存完整调度历史。</p>
      {task.currentVersion && <button type="button" class="button" data-task-current data-focus-key="task-current">查看当前版本</button>}
    </>}
    <p class="collab-inspected-objective">{task.objective}</p>
    <div class="collab-inspected-version"><span>{task.historical ? '历史任务版本' : '当前任务版本'}</span><code data-inspected-task-version>{task.version}</code></div>
    <dl class="collab-facts">{task.facts.map(fact => <div key={fact.name}><dt>{fact.name}</dt><dd>{fact.value}</dd></div>)}</dl>
    <div class="collab-artifact-links">
      <button type="button" class="text-button" data-collab-deliveries-task>查看此任务交付</button>
      <button type="button" class="text-button" data-collab-changes-task>查看此任务变化</button>
      <button type="button" class="text-button" data-collab-reviews-task>查看此任务审阅</button>
    </div>
    <h5>精确类型</h5><pre class="collab-code" tabIndex={0}>{task.type}</pre>
    {task.details.map(detail => <Detail key={detail.id} {...detail} />)}
    <h5>源码与检查回执</h5><p class="collab-help">每份产物固定到其任务版本、commit 和环境。</p>
    <div class="collab-artifact-links">{task.artifacts.map(artifact =>
      <button key={artifact.attributes['data-focus-key']} type="button" class={`button collab-artifact-${artifact.kind}`} {...artifact.attributes}>{artifact.label}</button>)}</div>
    {!task.hasChecks && <p class="collab-help">尚无已归档检查回执</p>}
  </>;
}

function TaskInspector(props: TaskInspectorProps) {
  if (props.mode === 'empty') return <p class="collab-help">选择一个任务查看合同与证据</p>;
  if (props.mode === 'missing') return <>
    <h4 data-inspected-task-heading data-focus-key={`inspected-${props.id}-${props.version}`} tabIndex={-1}>{props.id}</h4>
    <p data-task-history-notice>所选任务合同未保留，不能以当前同名任务替代。</p><code data-inspected-task-version>{props.version}</code>
    {props.hasCurrent && <button type="button" class="button" data-task-current>查看当前版本</button>}
  </>;
  return <Task task={props.task} />;
}

const mounted = new WeakSet<HTMLElement>();
// Keyed by task version: another contract remounts, while observation updates of the same contract keep nodes and focus.
export function renderTaskInspector(root: HTMLElement, props: TaskInspectorProps) {
  if (!mounted.has(root)) { root.textContent = ''; delete root.dataset.markup; mounted.add(root); }
  const key = props.mode === 'task' ? `task:${props.task.id}:${props.task.version}` : props.mode === 'missing' ? `missing:${props.id}:${props.version}` : 'empty';
  const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : undefined;
  const focusKey = focused?.dataset.focusKey;
  render(<TaskInspector key={key} {...props} />, root);
  if (focusKey && focused && !focused.isConnected) root.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}
