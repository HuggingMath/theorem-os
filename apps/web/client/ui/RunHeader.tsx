import { render } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { rollDigits, rollStatus } from '../motion';
import { Icon, Spinner } from './Icon';
import { fill } from './Section';
import { t } from '../../i18n';

export type HeaderStage = { label: string; state: 'done' | 'active' | 'stopped' | 'error' | 'pending' | 'skipped'; clock: string;
  /** The solve budget, on the stage it counts in; that stage's clock reads against it while it runs. */ budget?: string };
export type RunHeaderProps = {
  title: string; id: string; /** ISO time of the last recorded change; kept on the heading, not shown. */ updated: string; error: string;
  status: { key: string; label: string; tone: string; symbol: string };
  stages: HeaderStage[]; elapsed: string; tabs: readonly (readonly [string, string])[]; tab: string;
  active: boolean; cancelling: boolean; deleting: boolean; connected: boolean; download?: string; shareable: boolean;
  /** The read-only sample: it can be reused and downloaded, not deleted or shared. */ sample: boolean;
  /** Tokens the run has used, and its cap when it has one (both already formatted). */ tokens?: { used: string; cap?: string };
  /** Minutes the solving stage has gone without a passing check, once that counts as stuck. */ stalled?: number;
  /** The recorded version this run started from; `runId` is set while that run is still in the list. */
  continuation?: { label: string; runId?: string };
  formalizationId?: string;
  automaticFormalization?: boolean;
  /** Set while the run's first plan waits for its owner (先审计划); no Agent works on it until they approve it. */
  approval?: PlanApprovalProps;
};
export type PlanApprovalProps = {
  /** Tasks in the plan waiting for approval. */ tasks: number;
  /** The Lead is revising the plan after a note from the owner; approving waits for the revised version. */ revising: boolean;
  /** The owner's approval was sent and the run has not answered yet. */ busy: boolean;
  /** Why the owner's last approval did not take effect. */ error?: string;
};

function StatusBadge({ status }: { status: RunHeaderProps['status'] }) {
  const ref = useRef<HTMLSpanElement>(null), shown = useRef({ key: status.key, label: status.label }), width = useRef(0);
  // The width the badge is drawn at, part-way through a roll included, so the next roll starts from there.
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => { width.current = entry!.borderBoxSize[0]?.inlineSize ?? width.current; });
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, []);
  // Before paint, so the changed badge is never shown at full strength first.
  useLayoutEffect(() => {
    if (shown.current.key === status.key) return;
    const from = { label: shown.current.label, width: width.current };
    shown.current = { key: status.key, label: status.label };
    rollStatus(ref.current!, from);
  }, [status.key]);
  return <span ref={ref} class={`badge ${status.tone}`} data-status={status.key}><Icon name={status.symbol} /><span class="badge-label">{status.label}</span></span>;
}

/** A formatted count whose changed digits roll to their new value; the text is the count throughout. */
function Ticker({ value }: { value: string }) {
  const ref = useRef<HTMLSpanElement>(null), shown = useRef(value);
  useLayoutEffect(() => {
    const before = shown.current;
    if (before === value) return;
    shown.current = value;
    // Digits are compared from the right; a count that changed shape (another unit, another length) is simply replaced.
    const shape = (text: string) => text.replace(/\d/gu, '0');
    if (shape(before) !== shape(value)) return;
    const cells = [...ref.current!.querySelectorAll<HTMLElement>('[data-digit]')].flatMap(cell => {
      const at = Number(cell.dataset.at), from = Number(before[before.length - 1 - at]), to = Number(cell.dataset.digit);
      return from !== to ? [{ cell, from, to }] : [];
    });
    rollDigits(ref.current!, cells);
  }, [value]);
  const characters = [...value];
  return <span ref={ref} class="ticker">{characters.map((character, index) => /\d/u.test(character)
    ? <span key={characters.length - index} class="ticker-digit" data-digit={character} data-at={characters.length - 1 - index}>{character}</span> : character)}</span>;
}

const stageSymbol = { done: 'check', error: 'x', active: '', stopped: 'square', pending: '', skipped: '' } as const;
/** Only the stage in progress shows its clock; the others keep their duration in the tooltip, next to the total in the status line.
 * On a phone a running track names only the current stage; once the run has ended every stage names itself. */
function StageTrack({ stages }: { stages: HeaderStage[] }) {
  return <section class="artifact-progress" aria-label={t('实时运行进度')}>
    <ol class="artifact-stages" data-ended={stages.every(stage => stage.state !== 'active') || undefined}>{stages.map(stage => <li key={stage.label} class={stage.state} data-stage={stage.state} data-elapsed={stage.clock}
      title={stage.clock && stage.state !== 'active' ? t('{0} · 用时 {1}', stage.label, stage.clock) : undefined} aria-current={stage.state === 'active' ? 'step' : undefined}>
      <span class="stage-marker" aria-hidden="true">{stageSymbol[stage.state] && <Icon name={stageSymbol[stage.state]} />}</span>
      <span class="stage-copy"><span class="stage-label">{stage.label}</span>{stage.state === 'active' && stage.clock && <span class="stage-clock mono"
        title={stage.budget ? t('解题预算 {0}，从构造证明开始计时', stage.budget) : undefined}>{stage.budget ? `${stage.clock} / ${stage.budget}` : stage.clock}</span>}</span>
    </li>)}</ol>
  </section>;
}

function Tabs({ tabs, tab }: { tabs: RunHeaderProps['tabs']; tab: string }) {
  const list = useRef<HTMLDivElement>(null), bar = useRef<HTMLSpanElement>(null), placed = useRef(false);
  useLayoutEffect(() => {
    const root = list.current!, indicator = bar.current!;
    const place = () => {
      const selected = root.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!selected?.offsetWidth) return;
      indicator.style.width = `${selected.offsetWidth}px`;
      indicator.style.transform = `translateX(${selected.offsetLeft}px)`;
      // The first measurement only positions the indicator; later tab changes slide it.
      if (!placed.current) requestAnimationFrame(() => { indicator.dataset.ready = 'true'; });
      placed.current = true;
      // Scroll only the tab strip; scrollIntoView would also move the surrounding panes.
      if (selected.offsetLeft < root.scrollLeft) root.scrollLeft = selected.offsetLeft;
      else if (selected.offsetLeft + selected.offsetWidth > root.scrollLeft + root.clientWidth) root.scrollLeft = selected.offsetLeft + selected.offsetWidth - root.clientWidth;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(root);
    return () => observer.disconnect();
  }, [tab]);
  return <div ref={list} class="detail-tabs" role="tablist" aria-label={t('运行详情视图')}>
    {tabs.map(([id, label]) => <button key={id} type="button" role="tab" id={`detail-tab-${id}`} data-detail-tab={id} aria-controls="detail-panel"
      aria-selected={id === tab} tabIndex={id === tab ? 0 : -1}>{label}</button>)}
    <span ref={bar} class="detail-tab-indicator" aria-hidden="true" />
  </div>;
}

/** Less frequent actions live behind ⋯, so the heading stays one line; the run's id is copied from here rather than shown. */
function RunMenu(props: RunHeaderProps) {
  return <details class="run-menu" data-run-menu>
    <summary class="icon-button" aria-label={t('更多操作')} title={t('更多操作')}><Icon name="ellipsis" /></summary>
    <div class="run-menu-panel">
      <button type="button" class="run-menu-item" data-action="show-modules"><Icon name="blocks" />{t('模块方案')}</button>
      {props.download && <>
        <a class="run-menu-item" data-action="download-run" href={props.download} download><Icon name="download" />{t('下载完整研究归档')}</a>
        <a class="run-menu-item" data-action="download-snapshot" href={props.download.replace(/\/download$/u, '/snapshot')} download><Icon name="download" />{t('下载运行快照')}</a>
      </>}
      <button type="button" class="run-menu-item" data-action="copy-id"><Icon name="copy" />{t('复制运行 ID')}</button>
      {!props.sample && !props.active && <button type="button" class="run-menu-item danger" data-action="delete-run" disabled={!props.connected || props.deleting}>
        <Icon name="trash-2" />{t('删除运行记录')}</button>}
    </div>
  </details>;
}

function Actions(props: RunHeaderProps) {
  return <div class="detail-actions">
    {props.sample
      ? <button type="button" class="button button-primary" data-action="reuse-run"><Icon name="copy-plus" />{t('用这道题开始研究')}</button>
      : <button type="button" class="icon-button" data-action="reuse-run" aria-label={t('复用任务配置')} title={t('复用任务配置')}><Icon name="copy-plus" /></button>}
    {props.shareable && <button type="button" class="icon-button" data-action="share-run" aria-label={t('分享研究成果')} title={t('分享研究成果')}
      disabled={!props.connected}><Icon name="share-2" /></button>}
    {!props.sample && props.active && <button key="cancel" type="button" class="button button-danger" data-action="cancel" disabled={props.cancelling || !props.connected}>
      {props.cancelling ? <Spinner /> : <Icon name="square" />}{props.cancelling ? t('正在取消') : t('取消运行')}</button>}
    <RunMenu {...props} />
  </div>;
}

/** The plan waits for its owner: approve it as it is, change it first, or ask the Lead to revise it. */
function ApprovalBanner({ approval, connected }: { approval: PlanApprovalProps; connected: boolean }) {
  return <section class="run-approval" aria-labelledby="run-approval-heading" data-run-approval>
    <Icon name="list-ordered" />
    <div class="run-approval-copy">
      <h3 id="run-approval-heading">{approval.revising ? t('Lead 正在按你的留言修改计划') : t('研究计划等你批准')}</h3>
      <p>{approval.revising ? t('修改完成后可以再看一遍再批准。')
        : t('Lead 把题目拆成了 {0} 项任务。批准后 Agent 才开始工作；也可以先改计划，或给 Lead 留言让它修改。', approval.tasks)}</p>
      <p class="run-approval-note">{t('等待确认不计入证明预算；拟定和修改计划正常计时。')}</p>
      {approval.error && <p class="run-approval-error" role="alert">{approval.error}</p>}
      <div class="run-approval-actions">
        <button type="button" class="button button-primary" data-action="approve-plan" disabled={!connected || approval.busy || approval.revising}>
          {approval.busy ? <Spinner /> : <Icon name="check" />}{approval.busy ? t('正在批准') : t('批准并开始')}</button>
        <button type="button" class="button" data-action="show-plan"><Icon name="network" />{t('查看计划')}</button>
        <button type="button" class="button" data-action="edit-plan" disabled={!connected || approval.busy}><Icon name="square-pen" />{t('修改计划')}</button>
        <button type="button" class="text-button" data-action="guide-lead" disabled={!connected || approval.busy}><Icon name="message-square" />{t('给 Lead 留言')}</button>
      </div>
    </div>
  </section>;
}

function RunHeader(props: RunHeaderProps) {
  return <>
    <header class="detail-heading" data-run={props.id} data-updated-at={props.updated}>
      <div class="detail-heading-text">
        <h2 translate={false} title={props.title}>{props.title}</h2>
        <div class="detail-statusline">
          <StatusBadge status={props.status} />
          {props.sample && <span class="badge sample-badge" data-sample-badge><Icon name="eye" />{t('示例 · 只读')}</span>}
          <span class="detail-elapsed" title={t('总用时')}><Icon name="clock-3" /><span class="mono" data-header-clock>{props.elapsed}</span></span>
          {props.tokens && <span class="detail-elapsed" data-header-tokens title={props.tokens.cap ? t('这次运行所有 Agent 用掉的 Token；到达上限 {0} 后停止新的调用', props.tokens.cap) : t('这次运行所有 Agent 用掉的 Token')}>
            <Icon name="gauge" /><span class="mono">{props.tokens.cap ? fill(t('Token {0} / {1}'), <Ticker value={props.tokens.used} />, props.tokens.cap) : fill(t('Token {0}'), <Ticker value={props.tokens.used} />)}</span></span>}
        </div>
      </div>
      <Actions {...props} />
    </header>
    {props.sample && <p class="sample-note" data-sample-note>{t('这是一次录制好的运行：Agent 由离线脚本代替模型，环境、任务协作、Lean 检查和独立验收都是真实执行的。可以浏览每个标签页；点「用这道题开始研究」会把题目和配置填进新草稿，填入自己的 API Key 即可提交。')}</p>}
    {props.formalizationId && <p class="run-continuation" data-run-formalization><Icon name="languages" /><a class="text-button" href={`formalize.html?id=${encodeURIComponent(props.formalizationId)}`}>{props.automaticFormalization ? t('系统已形式化 · 查看原题与 Lean 对照') : t('原题已确认 · 查看原意与 Lean 对照')}</a></p>}
    {props.continuation && <p class="run-continuation" data-run-continuation><Icon name="git-branch" />
      <span>{t('从「{0}」继续：这一版的代码交给了每个 Agent 参考，仍要重新通过 Lean 检查。', props.continuation.label)}</span>
      {props.continuation.runId && <button type="button" class="text-button" data-action="open-continued" data-run-id={props.continuation.runId}>{t('看原运行')}</button>}</p>}
    <StageTrack stages={props.stages} />
    {props.approval && <ApprovalBanner approval={props.approval} connected={props.connected} />}
    {props.stalled !== undefined && <div class="run-stall" role="status" data-run-stall>
      <Icon name="hourglass" /><p>{t('近 {0} 分钟没有新进展：没有新的 Lean 检查通过，也没有新的结果集成。', props.stalled)}</p>
      <button type="button" class="text-button" data-action="guide-run"><Icon name="message-square" />{t('提供指导')}</button></div>}
    <div class="inline-error" data-detail-error role="alert" hidden={!props.error}>{props.error}</div>
    <Tabs tabs={props.tabs} tab={props.tab} />
  </>;
}

export function renderRunHeader(root: HTMLElement, props: RunHeaderProps) { render(<RunHeader {...props} />, root); }
export function unmountRunHeader(root: HTMLElement) { render(null, root); }
