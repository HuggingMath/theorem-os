import { Fragment } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { locale, t } from '../../i18n';
import { routeProofMapEdges } from '../proofMapModel';
import type { ProofMapBox, ProofMapChannel, ProofMapModel, ProofMapNode, RoutedProofEdge } from '../proofMapModel';
import { Rich } from '../richText';
import { Icon } from './Icon';

const tx = (zh: string, en: string) => (locale === 'en' ? en : zh);

export type ProofMapProps = {
  model: ProofMapModel;
  variant: 'workspace' | 'conversation';
  idPrefix: string;
  time?: (at: string) => string;
  onGuide?(taskId: string): void;
  onTask?(taskId: string): void;
  onCheck?(checkId: string): void;
  onEditPlan?(): void;
  onOpenWorkspace?(): void;
};

// The shared solve mark uses data-tone, which belongs only to the live workspace.
function ToneMark({ tone }: { tone: ProofMapNode['tone'] }) {
  const icons = { done: 'circle-check', active: 'circle-dot', pending: 'circle', failed: 'circle-alert', stopped: 'circle-dashed', skipped: 'minus' };
  const labels = { done: t('已完成'), active: t('进行中'), pending: t('未开始'), failed: t('未通过'), stopped: t('已停止'), skipped: t('已跳过') };
  return <span class="pm-tone-mark" data-pm-tone={tone}>
    {tone === 'active' ? <span class="pm-spinner" aria-hidden="true" /> : <Icon name={icons[tone]} />}
    <span class="sr-only">{labels[tone]}</span>
  </span>;
}

// Encoding every code point preserves distinct task ids, including punctuation and non-Latin names.
const safeNodeId = (id: string) => Array.from(id, character => character.codePointAt(0)!.toString(16)).join('-') || 'node';

export function ProofMap(props: ProofMapProps) {
  const { model } = props, workspace = props.variant === 'workspace';
  const mapRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [hovered, setHovered] = useState<string>();
  const [drawing, setDrawing] = useState<{ width: number; height: number; edges: RoutedProofEdge[] }>({ width: 1, height: 1, edges: [] });
  const nodeById = new Map(model.nodes.map(node => [node.id, node]));
  const isOpen = (node: ProofMapNode) => expanded.get(node.id) ?? (workspace ? node.tone === 'failed' : false);
  const highlighted = new Set(model.nodes.filter(isOpen).map(node => node.id));
  if (hovered) highlighted.add(hovered);

  const toggle = (node: ProofMapNode) => {
    const defaultOpen = workspace ? node.tone === 'failed' : false;
    setExpanded(previous => new Map(previous).set(node.id, !(previous.get(node.id) ?? defaultOpen)));
  };
  const jumpTo = (id: string) => {
    if (!nodeById.has(id)) return;
    setExpanded(previous => new Map(previous).set(id, true));
    setHovered(id);
    requestAnimationFrame(() => {
      const node = [...(mapRef.current?.querySelectorAll<HTMLElement>('[data-pm-node]') ?? [])]
        .find(element => element.dataset.pmNode === id);
      node?.querySelector<HTMLButtonElement>('.pm-node-head')?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    });
  };

  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let frame = 0;
    const measure = () => {
      const rect = map.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const boxes: Record<string, ProofMapBox> = Object.fromEntries([...map.querySelectorAll<HTMLElement>('[data-pm-box]')].map(element => {
        const box = element.getBoundingClientRect();
        return [element.dataset.pmBox!, { x: box.left - rect.left, y: box.top - rect.top, width: box.width, height: box.height }];
      }));
      const stageByNode = Object.fromEntries(model.nodes.map(node => [node.id, node.stageIndex]));
      const channels: ProofMapChannel[] = [...map.querySelectorAll<HTMLElement>('[data-pm-channel]')].map(element => {
        const channel = element.getBoundingClientRect();
        return { afterStage: Number(element.dataset.pmChannel), y: channel.top - rect.top + channel.height / 2 };
      });
      const edges = routeProofMapEdges(boxes, stageByNode, channels, model.edges);
      setDrawing(previous => previous.width === rect.width && previous.height === rect.height
        && previous.edges.length === edges.length && previous.edges.every((edge, index) => {
          const next = edges[index]!;
          return edge.id === next.id && edge.from === next.from && edge.to === next.to && edge.kind === next.kind && edge.path === next.path;
        }) ? previous : { width: rect.width, height: rect.height, edges });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(map);
    map.querySelectorAll('[data-pm-box], [data-pm-channel]').forEach(element => observer.observe(element));
    window.addEventListener('resize', schedule);
    return () => { observer.disconnect(); window.removeEventListener('resize', schedule); cancelAnimationFrame(frame); };
  }, [model, expanded]);

  const bridge = model.goalBridge;
  const externalCount = model.external.agents.length + model.external.checks.length + model.external.citations.length;
  return <section class="pm-root" data-proof-map={props.variant} data-pm-mode={model.mode} aria-label={tx('解题进展证明地图', 'Solving progress proof map')}>
    <header class="pm-header">
      <div class="pm-heading"><span class="pm-eyebrow">{tx('证明结构', 'Structure of the argument')}</span>
        <h3>{tx('解题进展地图', 'Solving progress map')}</h3>
      </div>
      <span class="pm-mode">{model.mode === 'planned' ? tx('依赖归约图', 'Dependency reduction DAG') : tx('三阶段验证管线', '3-stage verification pipeline')}</span>
      {!workspace && props.onOpenWorkspace && <button type="button" class="pm-action" data-pm-open-workspace onClick={props.onOpenWorkspace}>
        <Icon name="panel-right" />{tx('在右侧工作区展开', 'Open in live workspace')}
      </button>}
      {workspace && props.onEditPlan && model.mode === 'planned' && <button type="button" class="pm-action" data-live-edit-plan onClick={props.onEditPlan}>
        <Icon name="square-pen" />{t('修改任务与依赖')}
      </button>}
    </header>

    {bridge && <div class="pm-goal-bridge" data-pm-goal-bridge>
      <div class="pm-goal-original"><span class="pm-goal-label">{bridge.originalLabel}</span>
        <div class="pm-goal-copy" role="region" tabIndex={0} aria-label={bridge.originalLabel} translate={false}><Rich text={bridge.originalGoal} /></div>
      </div>
      <div class="pm-bridge-link"><span class="pm-bridge-symbol" aria-hidden="true">⇔</span>
        <div class="pm-bridge-pill"><span class="pm-bridge-status"><ToneMark tone={bridge.bridgeTone} /><span>{bridge.bridgeLabel}</span></span>
          {bridge.bridgeNote && <span class="pm-bridge-note">{bridge.bridgeNote}</span>}
          {bridge.theoremNames.length > 0 && <span class="pm-theorem-names">{bridge.theoremNames.map(name => <code key={name} translate={false}>{name}</code>)}</span>}
        </div>
        <span class="pm-bridge-symbol" aria-hidden="true">⇔</span>
      </div>
      <div class="pm-goal-formal"><span class="pm-goal-label">{bridge.formalLabel}</span>
        <div class="pm-formal-target" role="region" tabIndex={0} aria-label={bridge.formalLabel}><code translate={false}>{bridge.formalTarget}</code></div>
      </div>
    </div>}

    <section class="pm-reduction" data-pm-reduction>
      <h4>{tx('前沿归约', 'Narrowing the frontier')}</h4>
      <ol class="pm-reduction-list" aria-label={tx('证明瓶颈归约', 'Bottleneck reduction')}>{model.reduction.map(step =>
        <li key={step.step} data-pm-tone={step.tone} data-pm-step={step.step}>
          <span class="pm-reduction-heading"><span class="pm-step-number">{step.step}</span><span>{step.title}</span></span>
          <strong class="pm-reduction-value">{step.value}</strong><span class="pm-reduction-detail">{step.detail}</span>
        </li>)}</ol>
    </section>

    <div class="pm-legend">
      <span><i class="pm-legend-line pm-line-settled" aria-hidden="true" />{tx('已核验供给', 'Verified supply')}</span>
      <span><i class="pm-legend-line pm-line-dependency" aria-hidden="true" />{tx('待完成依赖', 'Pending dependency')}</span>
      <span><i class="pm-legend-line pm-line-conditional" aria-hidden="true" />{tx('条件性推进', 'Conditional step')}</span>
      <span class="pm-legend-hint">{tx('点击节点展开输入前提与待证目标', 'Click a node to inspect inputs and proof obligation')}</span>
    </div>

    <div class="pm-flow" data-has-external={externalCount > 0 ? 'true' : undefined}>
      <div class="pm-map" ref={mapRef}>
        <svg class="pm-edges" aria-hidden="true" viewBox={`0 0 ${drawing.width} ${drawing.height}`} data-has-highlight={highlighted.size > 0 ? 'true' : undefined}>
          <defs>{(['settled', 'dependency', 'conditional'] as const).map(kind => <marker key={kind} id={`${props.idPrefix}-arrow-${kind}`}
            class={`pm-arrow pm-arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 1 1 L 9 5 L 1 9" />
          </marker>)}</defs>
          {drawing.edges.map(edge => <path key={edge.id} d={edge.path} data-pm-edge={edge.id} data-pm-edge-kind={edge.kind}
            data-highlighted={highlighted.has(edge.from) || highlighted.has(edge.to) ? 'true' : undefined} marker-end={`url(#${props.idPrefix}-arrow-${edge.kind})`} />)}
        </svg>
        {model.stages.map((stage, stageIndex) => {
          const stageNodes = stage.nodeIds.flatMap(id => { const node = nodeById.get(id); return node ? [node] : []; });
          return <Fragment key={stage.index}>
            <section class="pm-stage" data-pm-stage={stage.number} data-pm-tone={stage.tone} aria-label={`${stage.number} ${stage.title}`}>
              <header class="pm-stage-head"><span class="pm-stage-number">{stage.number}</span>
                <div><h4>{stage.title}</h4>{stage.subtitle && <p>{stage.subtitle}</p>}</div><ToneMark tone={stage.tone} />
              </header>
              <div class="pm-stage-grid" data-node-count={stageNodes.length}>{stageNodes.map(node => {
                const open = isOpen(node), detailId = `${props.idPrefix}-detail-${safeNodeId(node.id)}`;
                const taskId = node.taskId, preview = node.formulaOrType || node.statement;
                return <article key={node.id} class="pm-node" data-pm-box={node.id} data-pm-node={node.id} data-pm-origin={node.origin} data-pm-tone={node.tone}
                  data-live-task={workspace ? taskId : undefined} data-tone={workspace && taskId !== undefined ? node.tone : undefined}
                  data-open={open ? 'true' : undefined} data-highlighted={hovered === node.id ? 'true' : undefined}
                  onMouseEnter={() => setHovered(node.id)} onMouseLeave={() => setHovered(undefined)} onFocus={() => setHovered(node.id)}
                  onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovered(undefined); }}>
                  <button type="button" class={props.variant === 'workspace' ? 'pm-node-head live-task-head' : 'pm-node-head'} aria-expanded={open}
                    aria-controls={open ? detailId : undefined} onClick={() => toggle(node)}>
                    <span class="pm-node-top"><ToneMark tone={node.tone} /><span class="pm-kind">{node.kindLabel}</span>
                      <span class="pm-status">{node.statusLabel}</span><Icon name={open ? 'chevron-up' : 'chevron-down'} />
                    </span>
                    <span class="pm-node-title live-task-label" translate={false}>{node.title}</span>
                    {node.codeName && <code class="pm-node-code" translate={false}>{node.codeName}</code>}
                    {!open && preview && <span class="pm-node-preview" translate={false}><Rich text={preview} /></span>}
                    <span class="pm-node-ports"><span aria-label={`${tx('输入前提', 'Inputs')}: ${node.checkpointsIn.length}`}>← {node.checkpointsIn.length}</span>
                      <span aria-label={`${tx('下游交付', 'Handoffs')}: ${node.handoffsOut.length}`}>→ {node.handoffsOut.length}</span></span>
                    {!open && node.note && node.tone !== 'done' && <span class="pm-node-note" translate={false}>{node.note}</span>}
                  </button>
                  {open && <div class="pm-detail" id={detailId}>
                    {node.statement && <div class="pm-detail-statement" translate={false}><Rich text={node.statement} /></div>}
                    <dl class="pm-detail-io">
                      <div><dt>{tx('输入前提 (Use)', 'Inputs (Use)')}</dt><dd translate={false}>{node.useSummary}</dd></div>
                      <div><dt>{tx('待证目标 (Prove)', 'Obligation (Prove)')}</dt><dd translate={false}>{node.proveSummary}</dd></div>
                    </dl>
                    {node.checkpointsIn.length > 0 && <section class="pm-detail-transfers"><h5>{tx('上游前提', 'Upstream inputs')}</h5>
                      <div class="pm-chips">{node.checkpointsIn.map(input => nodeById.has(input.id)
                        ? <button key={input.id} type="button" class="pm-chip" data-settled={input.settled ? 'true' : undefined} onClick={() => jumpTo(input.id)}>
                          <Icon name={input.settled ? 'circle-check' : 'arrow-up'} /><span translate={false}>{input.label}</span>
                        </button>
                        : <span key={input.id} class="pm-chip" data-settled={input.settled ? 'true' : undefined}><Icon name={input.settled ? 'circle-check' : 'arrow-up'} /><span translate={false}>{input.label}</span></span>)}</div>
                    </section>}
                    {node.handoffsOut.length > 0 && <section class="pm-detail-transfers"><h5>{tx('下游交付', 'Downstream handoffs')}</h5>
                      <div class="pm-chips">{node.handoffsOut.map(output => <span key={output.id} class="pm-chip pm-handoff" data-settled={output.settled ? 'true' : undefined}>
                        <Icon name="arrow-down" /><span translate={false}>{output.label}</span>
                      </span>)}</div>
                    </section>}
                    {node.conditions.length > 0 && <section class="pm-detail-conditions"><h5>{tx('仍需满足', 'Open conditions')}</h5>
                      <ul>{node.conditions.map((condition, index) => <li key={index} translate={false}><Rich text={condition} /></li>)}</ul>
                    </section>}
                    {node.reason && (workspace
                      ? <p class="pm-detail-reason live-task-reason" data-live-task-reason translate={false}>{node.reason}</p>
                      : <p class="pm-detail-reason" data-pm-reason translate={false}>{node.reason}</p>)}
                    {node.finding && <section class="pm-detail-finding"><h5>{tx('研究发现', 'Research finding')}</h5><div translate={false}><Rich text={node.finding} /></div></section>}
                    {node.note && <p class="pm-detail-note" translate={false}>{node.note}</p>}
                    {taskId !== undefined && (props.onGuide && node.canGuide || props.onTask) && <div class="pm-detail-actions">
                      {props.onGuide && node.canGuide && <button type="button" class="pm-action" data-live-guide={workspace ? taskId : undefined} data-pm-guide={!workspace ? taskId : undefined}
                        onClick={() => props.onGuide!(taskId)}><Icon name="message-square-text" />{t('指导这项任务')}</button>}
                      {props.onTask && <button type="button" class="pm-action" data-live-task-roadmap={workspace ? taskId : undefined} data-pm-roadmap={!workspace ? taskId : undefined}
                        onClick={() => props.onTask!(taskId)}><Icon name="network" />{t('在路线图中查看')}</button>}
                    </div>}
                  </div>}
                </article>;
              })}</div>
            </section>
            {stageIndex < model.stages.length - 1 && <div class="pm-channel" data-pm-channel={stage.index} aria-hidden="true" />}
          </Fragment>;
        })}
      </div>

      {externalCount > 0 && <aside class="pm-external" aria-label={tx('外部活动与核验', 'Activity and verification')}>
        <header class="pm-external-heading"><span class="pm-eyebrow">{tx('外部记录', 'External records')}</span><h4>{tx('活动与证据', 'Activity and evidence')}</h4></header>
        {model.external.agents.length > 0 && <section class="pm-external-block"><h5><Icon name="users" />{t('正在执行')}</h5>
          <ul class="pm-agent-list">{model.external.agents.map(agent => <li key={agent.id}>
            {agent.who && <strong translate={false}>{agent.who}</strong>}<p translate={false}>{agent.text}</p>
            {agent.code && <code translate={false}>{agent.code}</code>}
            {agent.targetNodeId && nodeById.has(agent.targetNodeId) && <button type="button" class="pm-rail-target" onClick={() => jumpTo(agent.targetNodeId!)}>
              <Icon name="locate-fixed" /><span translate={false}>{agent.targetLabel || tx('定位任务', 'Locate task')}</span>
            </button>}
          </li>)}</ul>
        </section>}
        {model.external.checks.length > 0 && <section class="pm-external-block"><h5><Icon name="shield-check" />{t('Lean 检查')}</h5>
          <ul class="pm-check-list">{model.external.checks.map(check => {
            const content = <><span class="pm-check-label" translate={false}>{check.label}</span>
              <span class="pm-check-result" data-pm-check-tone={check.outcomeTone}>{check.outcomeText}</span>
              {check.at && <time dateTime={check.at}>{props.time ? props.time(check.at) : check.at}</time>}</>;
            return <li key={check.id}>{props.onCheck
              ? <button type="button" class="pm-check" data-pm-check={check.id} onClick={() => props.onCheck!(check.id)}>{content}</button>
              : <div class="pm-check" data-pm-check={check.id}>{content}</div>}</li>;
          })}</ul>
        </section>}
        {model.external.citations.length > 0 && <section class="pm-external-block"><h5><Icon name="book-open" />{tx('引用库与声明', 'Cited library and declarations')}</h5>
          <ul class="pm-citation-list">{model.external.citations.map(citation => <li key={citation.id}>
            {citation.targetNodeId && nodeById.has(citation.targetNodeId)
              ? <button type="button" class="pm-rail-target" onClick={() => jumpTo(citation.targetNodeId!)}><Icon name="arrow-up-right" /><code translate={false}>{citation.label}</code></button>
              : <code translate={false}>{citation.label}</code>}
            {citation.detail && <p translate={false}>{citation.detail}</p>}
          </li>)}</ul>
        </section>}
      </aside>}
    </div>
  </section>;
}
