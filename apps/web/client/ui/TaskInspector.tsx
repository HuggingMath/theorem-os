import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { jsonText } from '../collaborationUi';
import { t } from '../../i18n';

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

// Long objectives start clamped so the type, facts and evidence stay within reach; remounts per task version.
function Objective({ text }: { text: string }) {
  const node = useRef<HTMLParagraphElement>(null), [expanded, setExpanded] = useState(false), [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = node.current!;
    const measure = () => { if (!expanded) setOverflows(element.scrollHeight > element.clientHeight + 1); };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  return <>
    <p ref={node} class="collab-inspected-objective" data-clamped={expanded ? undefined : 'true'}>{text}</p>
    {(overflows || expanded) && <button type="button" class="text-button collab-objective-toggle" aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>{expanded ? t('收起目标') : t('展开完整目标')}</button>}
  </>;
}

function Task({ task }: { task: InspectedTask }) {
  return <>
    <div class="collab-inspected-title" data-task-state={task.state} data-task-proof={task.proof}>
      <h4 data-inspected-task-heading data-focus-key={`inspected-${task.id}-${task.version}`} tabIndex={-1}>{task.id} · {task.kindLabel}</h4>
      {!task.historical && <span class="collab-inspected-state">{task.stateLabel}</span>}
    </div>
    {task.historical && <>
      <p class="collab-notice" data-task-history-notice>{t('正在查看历史任务合同。{0}；旧合同未保存完整调度历史。', task.currentVersion ? t('当前版本为 {0}', task.currentVersion) : t('当前计划已无此任务'))}</p>
      {task.currentVersion && <button type="button" class="button" data-task-current data-focus-key="task-current">{t('查看当前版本')}</button>}
    </>}
    <Objective text={task.objective} />
    <div class="collab-inspected-version"><span>{task.historical ? t('历史任务版本') : t('当前任务版本')}</span><code data-inspected-task-version>{task.version}</code></div>
    <dl class="collab-facts">{task.facts.map(fact => <div key={fact.name}><dt>{fact.name}</dt><dd>{fact.value}</dd></div>)}</dl>
    <div class="collab-artifact-links">
      <button type="button" class="text-button" data-collab-deliveries-task>{t('查看此任务交付')}</button>
      <button type="button" class="text-button" data-collab-changes-task>{t('查看此任务变化')}</button>
      <button type="button" class="text-button" data-collab-reviews-task>{t('查看此任务审阅')}</button>
    </div>
    <h5>{t('精确类型')}</h5><pre class="collab-code" tabIndex={0}>{task.type}</pre>
    {task.details.map(detail => <Detail key={detail.id} {...detail} />)}
    <h5>{t('源码与检查回执')}</h5><p class="collab-help">{t('每份产物固定到其任务版本、commit 和环境。')}</p>
    <div class="collab-artifact-links">{task.artifacts.map(artifact =>
      <button key={artifact.attributes['data-focus-key']} type="button" class={`button collab-artifact-${artifact.kind}`} {...artifact.attributes}>{artifact.label}</button>)}</div>
    {!task.hasChecks && <p class="collab-help">{t('尚无已归档检查回执')}</p>}
  </>;
}

function TaskInspector(props: TaskInspectorProps) {
  if (props.mode === 'empty') return <p class="collab-help">{t('选择一个任务查看合同与证据')}</p>;
  if (props.mode === 'missing') return <>
    <h4 data-inspected-task-heading data-focus-key={`inspected-${props.id}-${props.version}`} tabIndex={-1}>{props.id}</h4>
    <p data-task-history-notice>{t('所选任务合同未保留，不能以当前同名任务替代。')}</p><code data-inspected-task-version>{props.version}</code>
    {props.hasCurrent && <button type="button" class="button" data-task-current>{t('查看当前版本')}</button>}
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
