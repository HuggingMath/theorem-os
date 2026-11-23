import { Fragment } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { locale, t } from '../../i18n';
import { routeProofMapEdges } from '../proofMapModel';
import type { ProofMapBox, ProofMapChannel, ProofMapModel, ProofMapNode, RoutedProofEdge } from '../proofMapModel';
import { Rich } from '../richText';
import { Icon } from './Icon';
import type { WebTeamProof } from '../../collaboration';

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

function TeamProof({ proof, label, receipt }: { proof: WebTeamProof; label: string; receipt?: string }) {
  return <details class="pm-team-proof" data-team-proof={proof.commit}>
    <summary>{label} <code>{proof.commit.slice(0, 12)}</code></summary>
    <dl class="pm-detail-io">
      <div><dt>{tx('源码提交', 'Source commit')}</dt><dd><code>{proof.commit}</code></dd></div>
      <div><dt>{tx('源码摘要', 'Source digest')}</dt><dd><code>{proof.sourceDigest}</code></dd></div>
      <div><dt>{tx('检查环境', 'Check environment')}</dt><dd><code>{proof.environmentDigest}</code></dd></div>
      {receipt && <div><dt>{tx('整合回执', 'Integration receipt')}</dt><dd><code data-team-adoption-receipt>{receipt}</code></dd></div>}
    </dl>
    {proof.declarations.map(declaration => <div key={declaration.file + ':' + declaration.name} class="pm-team-declaration" data-team-declaration={declaration.name}>
      <p><code>{declaration.name}</code> · <code>{declaration.file}</code></p>
      {declaration.type && <pre>{declaration.type}</pre>}
      {declaration.checkedCommit && <p>{tx('Lean 检查提交', 'Lean check commit')} <code>{declaration.checkedCommit}</code></p>}
      {declaration.checkedSource !== undefined && <details class="pm-team-source">
        <summary>{tx('查看检查源码', 'View checked source')}</summary><pre>{declaration.checkedSource}</pre>
      </details>}
      {declaration.receipts.map(item => <div key={item.id} data-team-check-receipt={item.id}>
        <span>{item.status === 'kernel_verified' ? tx('内核通过', 'Kernel verified') : item.status}</span> <code>{item.id}</code>
        {item.diagnostic && <pre>{item.diagnostic}</pre>}
      </div>)}
    </div>)}
    {proof.sources.length ? proof.sources.map(source => <details key={source.file} class="pm-team-source">
      <summary>{tx('查看固定源码', 'View frozen source')} <code>{source.file}</code></summary>
      <pre data-team-frozen-source={source.file}>{source.source}</pre>
    </details>) : <p>{tx('此版本的源码未保存到工作台。', 'Source for this version is unavailable in this workbench.')}</p>}
  </details>;
}

function TeamEvidence({ evidence, onCheck }: { evidence: NonNullable<ProofMapNode['native']>; onCheck?: (id: string) => void }) {
  const { task, delivery, adoptions, findings, trials } = evidence;
  const state = { queued: tx('等待整合', 'Awaiting integration'), integrating: tx('正在整合', 'Integrating'),
    completed: tx('整合回执未记录', 'Integration receipt unavailable'), failed: tx('整合失败', 'Integration failed') };
  const relation = { direct: tx('直接引用', 'Direct reference'), indirect: tx('间接引用', 'Indirect reference'),
    referenced: tx('已引用', 'Referenced'), 'target-proof': tx('目标定理证明', 'Target proof') };
  return <div class="pm-team-evidence">
    {task?.reassignment && <p data-team-reassignment>
      {tx('据发现派工或修改任务', 'Assignment based on a finding')} · {tx('任务版本', 'Assignment revision')} {task.reassignment.revision}
      <br /><code>{task.reassignment.ref}</code>
    </p>}
    {findings.map(finding => <details key={finding.ref} class="pm-team-proof">
      <summary>{finding.status === 'accepted' ? tx('消息已入队', 'Message queued by Codex')
        : finding.status === 'queued' ? tx('等待消息入队', 'Message awaiting queue acceptance')
          : finding.status === 'uncertain' ? tx('消息入队状态不明', 'Queue acceptance uncertain')
            : tx('固定研究产物', 'Saved research artifact')} · <code>{finding.from}</code></summary>
      <code>{finding.ref}</code>{finding.text && <p>{finding.text}</p>}
    </details>)}
    {trials.map(trial => <div key={trial.id} data-team-candidate-trial={trial.id}>
      <span>{tx('候选已试用', 'Candidate tried')} · <code>{trial.consumer}</code> · {trial.passed ? tx('探针通过', 'Probe passed') : tx('探针未通过', 'Probe failed')}</span>
      {onCheck && <button type="button" class="pm-action" onClick={() => onCheck(trial.id)}>{tx('查看 Lean 检查', 'View Lean check')}</button>}
    </div>)}
    {task?.rejection && <TeamProof proof={task.rejection} label={tx('被拒提交的检查记录', 'Rejected submission check')} />}
    {delivery?.proof && <TeamProof proof={delivery.proof} label={tx('交付回执与源码', 'Delivery receipts and source')} />}
    {adoptions.map(adoption => <div key={adoption.id} data-team-adoption={adoption.id}>
      {adoption.proof && adoption.receiptId ? <TeamProof proof={adoption.proof} receipt={adoption.receiptId}
        label={tx('已采纳至', 'Adopted into') + ' ' + adoption.targetId} /> :
        <p>{state[adoption.status]} · <code>{adoption.targetId}</code>{adoption.error && <> · {adoption.error}</>}</p>}
    </div>)}
    {delivery?.references.map(ref => <p key={[ref.file, ref.name, ref.target].join(':')} data-team-final-reference={ref.relation}>
      {relation[ref.relation]} · <code>{ref.name}</code> → <code>{ref.target}</code>
    </p>)}
  </div>;
}

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
      <span class="pm-mode">{model.mode === 'native' ? tx('Codex 团队', 'Codex team')
        : model.mode === 'planned' ? tx('依赖归约图', 'Dependency reduction DAG') : tx('三阶段验证管线', '3-stage verification pipeline')}</span>
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

    {model.mode !== 'native' && <div class="pm-legend">
      <span><i class="pm-legend-line pm-line-settled" aria-hidden="true" />{tx('已核验供给', 'Verified supply')}</span>
      <span><i class="pm-legend-line pm-line-dependency" aria-hidden="true" />{tx('待完成依赖', 'Pending dependency')}</span>
      <span><i class="pm-legend-line pm-line-conditional" aria-hidden="true" />{tx('条件性推进', 'Conditional step')}</span>
      <span class="pm-legend-hint">{tx('点击节点展开输入前提与待证目标', 'Click a node to inspect inputs and proof obligation')}</span>
    </div>}

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
                  data-team-task={node.native?.task?.id} data-team-status={node.native?.task?.status}
                  data-team-delivery={node.native?.delivery?.id} data-open={open ? 'true' : undefined}
                  data-highlighted={hovered === node.id ? 'true' : undefined}
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
                    {model.mode === 'native' ? node.useSummary && <p class="pm-detail-note">{node.useSummary}</p> : <dl class="pm-detail-io">
                      <div><dt>{tx('输入前提 (Use)', 'Inputs (Use)')}</dt><dd translate={false}>{node.useSummary}</dd></div>
                      <div><dt>{tx('待证目标 (Prove)', 'Obligation (Prove)')}</dt><dd translate={false}>{node.proveSummary}</dd></div>
                    </dl>}
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
                    {node.native && <TeamEvidence evidence={node.native} onCheck={props.onCheck} />}
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
