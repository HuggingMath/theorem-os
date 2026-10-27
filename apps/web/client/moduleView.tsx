import type { WebCoordination, WebEvent, WebModuleId, WebModuleSnapshot, WebRun } from '../shared';
import { webCustomModuleSnapshots, webEventModule, webModuleSnapshots } from '../moduleTelemetry';
import { isAcceptedRun, runProgress } from '../presentation';
import { defaultResearchModulePlan, type CustomResearchModule, type ResearchModulePlan } from '../../../src/solver/modules/policy';
import { render, type ComponentChildren } from 'preact';
import { Icon } from './ui/Icon';
import { localeTag, localizeText, t } from '../i18n';

const modules = [
  { id: 'M5', name: t('协作与复用'), subject: t('任务分配 · 审阅 · 集成'), icon: 'network' },
  { id: 'M3', name: t('搜索决策'), subject: t('任务选择与重试'), icon: 'git-branch' },
  { id: 'M4', name: t('上下文选择'), subject: t('题目与研究证据'), icon: 'list' },
  { id: 'M2', name: t('检查与反馈'), subject: t('Lean 检查与诊断'), icon: 'circle-check' },
  { id: 'M1', name: t('证明构造'), subject: t('模型生成候选'), icon: 'cpu' },
  { id: 'S3', name: t('独立验收'), subject: t('完整原题 · 固定验收'), icon: 'shield-check' },
] as const;
type ModuleTone = 'pending' | 'active' | 'observed' | 'feedback' | 'passed' | 'failed' | 'stopped';
type ModuleState = { tone: ModuleTone; label: string };
export type ModuleViewInput = {
  id: string;
  run?: WebRun;
  model: string;
  workers: number;
  coordination: WebCoordination;
  environment: string;
  connected: boolean;
  editable?: boolean;
  modulePlan?: ResearchModulePlan;
};

const schedulers: Record<string, string> = { plan: t('按计划'), 'critical-path': t('关键路径优先'), continuation: t('延续已有进展') };

export function customModuleState(rule: CustomResearchModule, input: Pick<ModuleViewInput, 'run' | 'coordination' | 'workers'>,
  snapshot?: WebModuleSnapshot): string {
  if (!rule.enabled) return t('已停用');
  if (rule.slot === 'M5' && (input.coordination !== 'cooperative' || input.workers <= 1)) return t('当前模式不参与');
  if (snapshot) return t('已应用 {0} 次', snapshot.eventCount);
  return input.run && !['running', 'queued'].includes(input.run.status) ? t('无应用记录') : t('待应用');
}

export function latestModuleActivity(snapshots: Partial<Record<WebModuleId, WebModuleSnapshot>>) {
  let latest: { id: WebModuleId; event: WebEvent } | undefined;
  for (const { id } of modules) {
    const event = snapshots[id]?.lastEvent;
    if (event && (!latest || event.sequence > latest.event.sequence)) latest = { id, event };
  }
  return latest;
}

export function moduleState(id: WebModuleId, run?: WebRun, snapshot?: WebModuleSnapshot): ModuleState {
  if (!run) return { tone: 'pending', label: t('未运行') };
  const terminal = run.status !== 'running' && run.status !== 'queued';
  const last = snapshot?.lastEvent;
  if (id === 'S3') {
    if (isAcceptedRun(run)) return { tone: 'passed', label: t('验收通过') };
    if (run.status === 'completed' && ['evaluated_failed', 'evaluated_rejected'].includes(run.result?.status ?? ''))
      return { tone: 'failed', label: run.result?.status === 'evaluated_rejected' ? t('验收拒绝') : t('验收未通过') };
    if (last?.type === 'evaluation_finished') return { tone: 'observed', label: terminal ? t('尚未验收通过') : t('等待结果确认') };
    if (last || run.timings?.evaluating) return terminal
      ? { tone: 'stopped', label: t('验收已中断') } : { tone: 'active', label: t('独立验收中') };
    return { tone: 'pending', label: terminal ? t('无验收记录') : t('等待候选') };
  }
  if (!snapshot) return { tone: 'pending', label: run.status === 'queued' ? t('等待运行')
    : runProgress(run).index < 2 && !terminal ? t('等待研究') : t('无活动记录') };
  const researching = !terminal && runProgress(run).index < 3;
  if (snapshot.activeWorkers.length && researching)
    return { tone: 'active', label: id === 'M2' ? t('检查中') : t('构造中') };
  if (terminal && snapshot.activeWorkers.length) return { tone: 'stopped', label: t('已停止') };
  if (id === 'M1') return ['turn_failed', 'worker_failed'].includes(last!.type)
    ? { tone: 'feedback', label: t('尝试未完成') } : { tone: 'observed', label: t('已有执行记录') };
  if (id === 'M2') {
    if (last?.type === 'source_rejected') return { tone: 'feedback', label: t('约束拒绝') };
    if (last?.details?.passed === false) return { tone: 'feedback', label: t('待修复') };
    if (last?.details?.passed === true) return { tone: 'observed', label: last.details.conditional ? t('条件性通过')
      : last.type === 'proof_checked' ? t('候选通过') : t('局部通过') };
    return { tone: 'observed', label: t('已有检查记录') };
  }
  if (id === 'M5') {
    if (last?.type === 'plan_rejected') return { tone: 'feedback', label: t('计划待调整') };
    const labels: Record<string, string> = { plan_updated: t('已更新计划'), initial_plan_fallback: t('已建立计划'),
      assembly_started: t('集成已启动'), review_requested: t('已请求审阅'), statement_review_requested: t('已请求审阅'),
      task_assigned: t('已分配'), review_assigned: t('已分配'), statement_review_assigned: t('已分配'),
      review_completed: t('已审阅'), statement_review_completed: t('已审阅'), task_integrated: t('已集成'),
      delivery_published: t('已有交接'), research_delivered: t('已有交接') };
    return { tone: 'observed', label: labels[last!.type] ?? t('已有协作记录') };
  }
  return { tone: 'observed', label: id === 'M3' ? last?.type === 'turn_retry' ? t('已安排重试') : t('已决策')
    : last?.type === 'context_restarted' ? t('已重建') : t('已整理') };
}

function text(target: Element, value: string) {
  if (target.textContent !== value) target.textContent = value;
}
const timestamp = (value: string) => Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat(localeTag, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) : value;
const bytes = (value: number) => value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
const operations = { direct: t('直接证明'), decompose: t('分解任务'), bridge: t('检查引理连接'), 'prove-lemma': t('证明辅助引理'), 'integrate-lemma': t('集成辅助引理') };
function Node({ id }: { id: WebModuleId }) {
  const module = modules.find(module => module.id === id)!;
  return <button type="button" class="module-node" data-module-id={id} data-tone="pending" aria-pressed="false" aria-controls="module-inspector">
    <span class="module-node-top"><span class="module-code mono">{id}</span><Icon name={module.icon} /><span class="module-node-selected" aria-hidden="true"><Icon name="eye" />{t('查看中')}</span>
      <span class="module-node-state"><span class="module-state-dot" aria-hidden="true" /><span data-module-state>{t('未运行')}</span></span></span>
    <span class="module-node-name">{module.name}</span><span class="module-node-subject">{module.subject}</span>
  </button>;
}
const Edge = (props: { from: WebModuleId; to: WebModuleId | 'research'; direction: 'up' | 'down' | 'left' | 'right'; class: string }) =>
  <span class={`module-edge ${props.class}`} data-from={props.from} data-to={props.to} data-direction={props.direction} aria-hidden="true" />;
/** A keyed row's fixed structure; the view fills and reorders the row itself. */
function skeleton<K extends keyof HTMLElementTagNameMap>(tag: K, view: ComponentChildren) {
  const row = document.createElement(tag);
  render(<>{view}</>, row);
  return row;
}

/** The module graph and inspector. Rendered once per host; ModuleView then updates the nodes in place. */
function Scaffold() {
  return <>
    <header class="module-view-heading"><div><h3><span>{t('研究模块')}</span><button type="button" class="icon-button module-configure" data-module-configure title={t('编辑模块方案')} aria-label={t('编辑模块方案')}><Icon name="sliders-horizontal" /></button></h3><p data-module-configuration /></div>
      <span class="module-observation" role="status" aria-atomic="true" /></header>
    <section class="module-live" aria-label={t('最近模块活动')} hidden>
      <div class="module-live-heading"><span>{t('最近活动')}</span><time class="mono" /></div>
      <div class="module-live-controls"><label class="module-follow"><input type="checkbox" data-module-follow aria-controls="module-inspector" /><span>{t('实时跟随')}</span></label>
        <button type="button" class="icon-button" data-module-latest title={t('定位最近活动')} aria-label={t('定位最近活动')} aria-controls="module-inspector"><Icon name="locate-fixed" /></button></div>
      <p class="module-live-event"><strong data-module-live-name /><span data-module-live-message /></p>
    </section>
    <div class="module-layout">
      <div class="module-graph" role="group" aria-label={t('M3 搜索、M4 上下文、M1 构造、M2 检查组成研究循环，M5 协调，S3 独立验收')} aria-describedby="module-graph-note">
        <Node id="M5" /><Edge from="M5" to="research" direction="down" class="module-coordination-edge" />
        <div class="module-research"><div class="module-cycle"><Node id="M3" /><Edge from="M3" to="M4" direction="right" class="module-edge-context" /><Node id="M4" /><Edge from="M2" to="M3" direction="up" class="module-edge-retry" />
          <span class="module-cycle-label"><Icon name="refresh-cw" /><span>{t('研究循环')}</span></span><Edge from="M4" to="M1" direction="down" class="module-edge-construction" /><Node id="M2" />
          <Edge from="M1" to="M2" direction="left" class="module-edge-feedback" /><Node id="M1" /></div></div>
        <div class="module-acceptance-edge"><Edge from="M2" to="S3" direction="down" class="" /><span>{t('候选检查通过后')}</span></div><Node id="S3" />
        <div class="module-legend"><span><i class="module-selected-key" />{t('查看中')}</span><span><i class="module-recent-key" />{t('最新记录')}</span><span><i data-tone="active" />{t('进行中')}</span>
          <span><i data-tone="observed" />{t('已有记录')}</span><span><i data-tone="pending" />{t('尚无记录')}</span></div>
        <p class="module-graph-note" id="module-graph-note">{t('点击模块查看记录 · 连线表示结构关系')}</p>
        <section class="module-customizations" aria-labelledby="module-customizations-title" hidden><header><h4 id="module-customizations-title">{t('自定义策略')}</h4><span data-module-custom-count /></header><ol /></section>
      </div>
      <section class="module-inspector" id="module-inspector" aria-labelledby="module-inspector-title" tabIndex={-1}>
        <header><span class="module-inspector-code mono" /><h4 id="module-inspector-title" /><span class="module-inspector-state" role="status" aria-atomic="true" />
          <button type="button" class="icon-button module-policy-add" data-module-policy-add aria-haspopup="dialog" aria-controls="run-settings" hidden><Icon name="plus" /></button>
          <button type="button" class="icon-button module-graph-return" data-module-return title={t('返回模块图')} aria-label={t('返回模块图')}><Icon name="arrow-up" /></button></header>
        <p class="module-output" /><section class="module-policies" aria-label={t('当前模块的自定义策略')} hidden><div /></section><dl class="module-facts" />
        <section class="module-workers" hidden aria-labelledby="module-workers-title"><header><h4 id="module-workers-title" title={t('依据已收到的开始和结束事件，不代表实时请求占用')}>{t('未结束的 Agent 记录')}</h4><span data-module-worker-count /></header><ul /></section>
        <p class="module-verification-note" hidden />
        <div class="module-history-heading"><h4>{t('最近活动')}</h4><button type="button" class="icon-button" data-module-destination="events" title={t('打开活动记录')} aria-label={t('打开活动记录')}><Icon name="list" /></button></div>
        <p class="module-retention" /><ol class="module-events" /><p class="module-events-empty" />
        <button type="button" class="text-button module-destination" data-module-destination="source"><Icon name="file-code-2" /><span>{t('Lean 源码')}</span></button>
      </section>
    </div>
  </>;
}

export class ModuleView {
  private root?: HTMLElement;
  private input?: ModuleViewInput;
  private identity = '';
  private selected: WebModuleId = 'M1';
  private selectedPolicy?: string;
  private following = false;
  private scrollTop = 0;

  update(root?: HTMLElement, input?: ModuleViewInput) {
    if (this.root?.getClientRects().length) this.scrollTop = this.scroller()?.scrollTop ?? 0;
    if (input && this.identity !== input.id) {
      this.selected = 'M1'; this.selectedPolicy = undefined; this.following = false; this.scrollTop = 0; this.identity = input.id;
    }
    if (!root || !input) { this.root = undefined; return; }
    this.input = input;
    this.root = root;
    if (!root.querySelector('.module-layout')) this.mount();
    this.render();
    const scroll = this.scroller();
    if (scroll && root.getClientRects().length) scroll.scrollTop = this.scrollTop;
  }

  private scroller() { return this.root?.closest<HTMLElement>('.detail-panel,.draft-preview'); }

  focusPolicy(id: string) {
    if (!this.root?.getClientRects().length) return;
    const rule = this.input?.modulePlan?.custom.find(rule => rule.id === id);
    if (rule) { this.select(rule.slot, rule.id); return; }
    const node = this.root.querySelector<HTMLButtonElement>(`[data-module-id="${this.selected}"]`);
    node?.focus({ preventScroll: true }); node?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }

  private mount() {
    const root = this.root!;
    root.textContent = '';
    render(<Scaffold />, root);
    root.addEventListener('change', event => {
      const follow = (event.target as Element).closest<HTMLInputElement>('[data-module-follow]');
      if (!follow) return;
      this.following = follow.checked;
      this.render();
    });
    root.addEventListener('click', event => {
      if ((event.target as Element).closest('[data-module-return]')) {
        root.querySelector('.module-graph')!.scrollIntoView({ block: 'start', behavior: 'instant' });
        root.querySelector<HTMLButtonElement>(`[data-module-id="${this.selected}"]`)!.focus({ preventScroll: true });
        return;
      }
      if ((event.target as Element).closest('[data-module-latest]')) {
        const latest = this.input?.run && latestModuleActivity(webModuleSnapshots(this.input.run));
        if (!latest) return;
        this.select(latest.id);
        return;
      }
      const id = (event.target as Element).closest<HTMLElement>('[data-module-id]')?.dataset.moduleId;
      const slot = id ?? (event.target as Element).closest<HTMLElement>('[data-module-slot]')?.dataset.moduleSlot;
      if (!modules.some(module => module.id === slot)) return;
      const policy = (event.target as Element).closest<HTMLElement>('[data-module-custom-id]')?.dataset.moduleCustomId;
      this.select(slot as WebModuleId, policy);
    });
  }

  private select(id: WebModuleId, policy?: string) {
    this.following = false;
    this.selected = id; this.selectedPolicy = policy;
    this.render();
    const rule = policy && Array.from(this.root!.querySelectorAll<HTMLDetailsElement>('[data-module-policy-id]'))
      .find(row => row.dataset.modulePolicyId === policy);
    if (rule) {
      rule.open = true;
      rule.querySelector('summary')!.focus({ preventScroll: true });
      rule.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      return;
    }
    const inspector = this.root!.querySelector<HTMLElement>('.module-inspector')!;
    if (inspector.getBoundingClientRect().top >= this.root!.querySelector('.module-graph')!.getBoundingClientRect().bottom) {
      inspector.focus({ preventScroll: true });
      inspector.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }

  private render() {
    const root = this.root!, input = this.input!, run = input.run;
    const plan = input.modulePlan ?? defaultResearchModulePlan();
    const selectedRule = plan.custom.find(rule => rule.id === this.selectedPolicy);
    if (selectedRule) this.selected = selectedRule.slot;
    else this.selectedPolicy = undefined;
    const snapshots = run ? webModuleSnapshots(run) : {};
    const latest = latestModuleActivity(snapshots);
    const live = Boolean(run && (run.status === 'running' || run.status === 'queued'));
    if (!live) this.following = false;
    if (this.following && input.connected && latest) { this.selected = latest.id; this.selectedPolicy = undefined; }
    const activity = root.querySelector<HTMLElement>('.module-live')!;
    activity.hidden = !run;
    const follow = activity.querySelector<HTMLInputElement>('[data-module-follow]')!;
    follow.checked = this.following;
    follow.disabled = !live;
    activity.querySelector<HTMLButtonElement>('[data-module-latest]')!.disabled = !latest;
    const latestTime = activity.querySelector('time')!;
    latestTime.dateTime = latest?.event.at ?? '';
    text(latestTime, latest ? timestamp(latest.event.at) : '');
    text(activity.querySelector('[data-module-live-name]')!, latest ? `${latest.id} · ${modules.find(module => module.id === latest.id)!.name}` : '');
    text(activity.querySelector('[data-module-live-message]')!, (latest ? localizeText(latest.event.message) : t('等待模块活动')));
    activity.querySelector<HTMLElement>('.module-live-event')!.title = latest ? localizeText(latest.event.message) : '';
    const configuredWorkers = Number.isSafeInteger(input.workers) && input.workers > 0 ? input.workers : t('未设置');
    text(root.querySelector('[data-module-configuration]')!, t('5 个研究模块 · {0} 个 Agent · {1}', configuredWorkers, input.coordination === 'cooperative' ? t('任务协作') : t('独立并行')));
    root.querySelector<HTMLButtonElement>('[data-module-configure]')!.hidden = Boolean(run);
    root.dataset.stale = String(!input.connected);
    text(root.querySelector('.module-observation')!, !input.connected ? t('连接中断 · 最近状态') : !run ? t('未提交')
      : `${runProgress(run).phaseLabel} · ${timestamp(run.updatedAt)}`);
    for (const module of modules) {
      const button = root.querySelector<HTMLButtonElement>(`[data-module-id="${module.id}"]`)!;
      const value = moduleState(module.id, run, snapshots[module.id]);
      const rules = plan.custom.filter(rule => rule.enabled && rule.slot === module.id
        && (rule.slot !== 'M5' || input.coordination === 'cooperative' && input.workers > 1));
      button.dataset.tone = value.tone;
      button.dataset.recent = String(latest?.id === module.id);
      button.setAttribute('aria-pressed', String(this.selected === module.id));
      button.setAttribute('aria-current', String(latest?.id === module.id));
      button.title = `${module.name} · ${value.label}${latest?.id === module.id ? t(' · 最新模块记录') : ''}${rules.length ? ` · ${rules.map(rule => rule.name).join(t('、'))}` : ''}`;
      text(button.querySelector('.module-node-subject')!, rules.length ? t('{0} 个自定义策略', rules.length) : module.subject);
      text(button.querySelector('[data-module-state]')!, value.label);
    }
    for (const connector of root.querySelectorAll<HTMLElement>('.module-edge'))
      connector.dataset.selected = String(connector.dataset.from === this.selected || connector.dataset.to === this.selected);
    const module = modules.find(module => module.id === this.selected)!, snapshot = snapshots[this.selected];
    const value = moduleState(this.selected, run, snapshot);
    const inspector = root.querySelector<HTMLElement>('.module-inspector')!;
    inspector.dataset.module = this.selected; inspector.dataset.tone = value.tone;
    text(inspector.querySelector('.module-inspector-code')!, module.id);
    text(inspector.querySelector('h4')!, module.name);
    text(inspector.querySelector('.module-inspector-state')!, value.label);
    const add = inspector.querySelector<HTMLButtonElement>('[data-module-policy-add]')!;
    add.hidden = Boolean(run) || !['M1', 'M3', 'M4', 'M5'].includes(this.selected);
    add.dataset.modulePolicyAdd = this.selected; add.disabled = plan.custom.length >= 8;
    add.title = add.disabled ? t('最多保存 8 个自定义策略') : t('新增 {0} 策略', this.selected);
    add.setAttribute('aria-label', add.title);
    const outputs: Record<WebModuleId, string> = { M1: t('输出：候选源码与研究进展'), M2: t('输出：候选检查结果与 Lean 反馈'), M3: t('输出：下一步研究动作'), M4: t('输出：当前尝试的研究上下文'), M5: t('输出：任务分配、审阅与集成记录'), S3: t('验收范围：固定的完整原题') };
    text(inspector.querySelector('.module-output')!, outputs[this.selected]);
    const note = inspector.querySelector<HTMLElement>('.module-verification-note')!;
    note.hidden = !['M1', 'M2', 'S3'].includes(this.selected);
    text(note, this.selected === 'S3' ? t('完整原题通过独立 Lean 验收，才记为验收通过。') : t('候选、局部任务和条件性检查结果均不代表完整原题验收通过。'));
    const details = snapshot?.lastEvent.details;
    const facts: Array<[string, string]> = [[t('状态'), value.label], [t('活动事件'), String(snapshot?.eventCount ?? 0)]];
    if (this.selected === 'M1') facts.push([t('模型'), input.model || t('未设置')]);
    if (this.selected === 'M2' || this.selected === 'S3') facts.push([t('证明环境'), input.environment]);
    if (this.selected === 'M3' && details?.operation) facts.push([t('最近决策'), operations[details.operation]]);
    if (this.selected === 'M3') facts.push([t('调度策略'), `${schedulers[plan.scheduler] ?? plan.scheduler}${input.coordination !== 'cooperative' || input.workers <= 1 ? t(' · 多 Agent 协作时生效') : ''}`]);
    if (this.selected === 'M4') facts.push([t('上下文范围'), plan.context === 'essential' ? t('必要原题、接口与检查反馈') : t('完整研究证据')]);
    if (this.selected === 'M4' && details?.usedBytes !== undefined)
      facts.push([t('上下文大小'), `${bytes(details.usedBytes)}${details.maxBytes !== undefined ? ` / ${bytes(details.maxBytes)}` : ''}`]);
    if (this.selected === 'M5') facts.push([t('运行模式'), input.coordination === 'cooperative' ? t('任务协作') : t('独立并行')], [t('Agent 配置'), String(configuredWorkers)]);
    if (details?.workerId) facts.push([t('最近 Agent'), details.workerId]);
    if (details?.turn !== undefined) facts.push([t('最近轮次'), String(details.turn)]);
    if (snapshot) facts.push([t('最近记录'), timestamp(snapshot.lastEvent.at)]);
    this.renderFacts(facts);
    this.renderCustomizations(plan.custom);
    this.renderPolicies(plan.custom.filter(rule => rule.slot === this.selected));
    this.renderWorkers(value.tone === 'active' ? snapshot?.activeWorkers ?? [] : []);
    const events = run?.events.filter(event => webEventModule(event.type) === this.selected).slice(-6).reverse() ?? [];
    this.renderEvents(events);
    const cumulative = Boolean(run?.modules?.[this.selected]);
    text(inspector.querySelector('.module-retention')!, events.length
      ? t('显示最近 {0} 条{1}', events.length, snapshot && snapshot.eventCount > events.length ? t(' · {0} {1} 条', cumulative ? t('累计') : t('保留窗口内'), snapshot.eventCount) : '')
      : snapshot ? t('累计 {0} 条 · 较早活动已移出保留范围', snapshot.eventCount) : '');
    const empty = inspector.querySelector<HTMLElement>('.module-events-empty')!;
    empty.hidden = Boolean(events.length);
    text(empty, run ? snapshot ? localizeText(snapshot.lastEvent.message) : t('该模块暂无活动记录') : t('提交后记录真实模块活动'));
    inspector.querySelector<HTMLButtonElement>('[data-module-destination="events"]')!.hidden = !run;
    const destination = inspector.querySelector<HTMLButtonElement>('.module-destination')!;
    destination.dataset.moduleDestination = this.selected === 'S3' && run ? 'report' : 'source';
    text(destination.querySelector('span')!, this.selected === 'S3' && run ? t('验收报告') : t('Lean 源码'));
  }

  private renderCustomizations(rules: CustomResearchModule[]) {
    const section = this.root!.querySelector<HTMLElement>('.module-customizations')!;
    section.hidden = !rules.length;
    text(section.querySelector('[data-module-custom-count]')!, t('{0} / {1} 已启用', rules.filter(rule => rule.enabled).length, rules.length));
    const target = section.querySelector('ol')!;
    const rows = new Map(Array.from(target.querySelectorAll<HTMLElement>('[data-module-custom-id]')).map(row => [row.dataset.moduleCustomId!, row]));
    for (const [id, row] of rows) if (!rules.some(rule => rule.id === id)) row.closest('li')!.remove();
    const applications = this.input!.run ? webCustomModuleSnapshots(this.input!.run) : {};
    let cursor = target.firstElementChild;
    for (const rule of rules) {
      let button = rows.get(rule.id);
      if (!button) {
        const row = skeleton('li', <><label class="module-custom-toggle"><input type="checkbox" data-module-custom-enabled /></label>
          <button type="button" class="module-customization" aria-controls="module-inspector"><span class="module-custom-slot mono" /><span class="module-custom-name" /><span class="module-custom-mode" /><span data-module-custom-state /><Icon name="arrow-up-right" /></button></>);
        row.className = 'module-customization-row';
        button = row.querySelector('button')!; button.dataset.moduleCustomId = rule.id;
      }
      const row = button.closest('li')!;
      row.dataset.selected = String(this.selectedPolicy === rule.id);
      const toggle = row.querySelector<HTMLInputElement>('[data-module-custom-enabled]')!;
      toggle.dataset.moduleCustomEnabled = rule.id;
      if (toggle.checked !== rule.enabled) toggle.checked = rule.enabled;
      toggle.disabled = Boolean(this.input!.run) || this.input!.editable === false;
      toggle.setAttribute('aria-label', t('启用{0}', rule.name || t('未命名策略')));
      const label = toggle.closest<HTMLLabelElement>('label')!;
      label.hidden = Boolean(this.input!.run);
      label.title = `${rule.enabled ? t('停用') : t('启用')}${rule.name || t('未命名策略')}`;
      const state = customModuleState(rule, this.input!, applications[rule.id]);
      button.dataset.moduleSlot = rule.slot;
      button.dataset.enabled = String(rule.enabled);
      button.dataset.appliedCount = String(applications[rule.id]?.eventCount ?? 0);
      button.setAttribute('aria-label', `${rule.name || t('未命名策略')} · ${rule.slot} · ${state}`);
      button.title = rule.name || t('未命名策略');
      if (this.selectedPolicy === rule.id) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
      text(button.querySelector('.module-custom-slot')!, rule.slot);
      text(button.querySelector('.module-custom-name')!, rule.name || t('未命名策略'));
      text(button.querySelector('.module-custom-mode')!, rule.mode === 'replace' ? t('替换建议') : t('补充建议'));
      text(button.querySelector('[data-module-custom-state]')!, state);
      if (row !== cursor) target.insertBefore(row, cursor);
      cursor = row.nextElementSibling;
    }
  }

  private renderPolicies(rules: CustomResearchModule[]) {
    const section = this.root!.querySelector<HTMLElement>('.module-policies')!;
    section.hidden = !rules.length;
    const target = section.querySelector('div')!;
    const rows = new Map(Array.from(target.querySelectorAll<HTMLElement>('[data-module-policy-id]')).map(row => [row.dataset.modulePolicyId!, row]));
    for (const [id, row] of rows) if (!rules.some(rule => rule.id === id)) row.remove();
    const applications = this.input!.run ? webCustomModuleSnapshots(this.input!.run) : {};
    let cursor = target.firstElementChild;
    for (const rule of rules) {
      let row = rows.get(rule.id);
      if (!row) {
        row = skeleton('details', <><summary><span class="module-policy-name" /><span class="module-policy-state" /><Icon name="chevron-down" /></summary>
          <div class="module-policy-tools"><p class="module-policy-mode" /><button type="button" class="icon-button module-policy-edit" aria-haspopup="dialog" aria-controls="run-settings" hidden><Icon name="square-pen" /></button></div>
          <p class="module-policy-instructions" /></>);
        row.dataset.modulePolicyId = rule.id;
      }
      row.dataset.enabled = String(rule.enabled);
      row.dataset.selected = String(this.selectedPolicy === rule.id);
      const edit = row.querySelector<HTMLButtonElement>('.module-policy-edit')!;
      edit.dataset.modulePolicyEdit = rule.id; edit.hidden = Boolean(this.input!.run);
      edit.title = t('编辑{0}', rule.name || t('未命名策略')); edit.setAttribute('aria-label', edit.title);
      text(row.querySelector('.module-policy-name')!, rule.name || t('未命名策略'));
      text(row.querySelector('.module-policy-state')!, customModuleState(rule, this.input!, applications[rule.id]));
      text(row.querySelector('.module-policy-mode')!, rule.mode === 'replace' ? t('替换默认建议') : t('补充默认建议'));
      text(row.querySelector('.module-policy-instructions')!, rule.instructions || t('规则未填写'));
      if (row !== cursor) target.insertBefore(row, cursor);
      cursor = row.nextElementSibling;
    }
  }

  private renderWorkers(workers: string[]) {
    const section = this.root!.querySelector<HTMLElement>('.module-workers')!;
    section.hidden = !workers.length;
    text(section.querySelector('[data-module-worker-count]')!, String(workers.length));
    const target = section.querySelector('ul')!;
    const rows = new Map(Array.from(target.querySelectorAll<HTMLElement>('[data-worker-id]')).map(row => [row.dataset.workerId!, row]));
    for (const [id, row] of rows) if (!workers.includes(id)) row.remove();
    let cursor = target.firstElementChild;
    for (const id of workers) {
      let row = rows.get(id);
      if (!row) { row = skeleton('li', <><span aria-hidden="true" /><code /></>); row.dataset.workerId = id; }
      text(row.querySelector('code')!, id);
      if (row !== cursor) target.insertBefore(row, cursor);
      cursor = row.nextElementSibling;
    }
  }

  private renderFacts(facts: Array<[string, string]>) {
    const target = this.root!.querySelector('.module-facts')!;
    const rows = new Map(Array.from(target.children).map(row => [row.querySelector('dt')!.textContent, row]));
    for (const [label] of rows) if (!facts.some(fact => fact[0] === label)) rows.get(label)!.remove();
    let cursor = target.firstElementChild;
    for (const [label, value] of facts) {
      let row = rows.get(label);
      if (!row) row = skeleton('div', <><dt /><dd /></>);
      text(row.querySelector('dt')!, label); text(row.querySelector('dd')!, value);
      if (row !== cursor) target.insertBefore(row, cursor);
      cursor = row.nextElementSibling;
    }
  }

  private renderEvents(events: WebEvent[]) {
    const target = this.root!.querySelector('.module-events')!;
    const rows = new Map(Array.from(target.querySelectorAll<HTMLElement>('[data-sequence]')).map(row => [Number(row.dataset.sequence), row]));
    for (const [sequence, row] of rows) if (!events.some(event => event.sequence === sequence)) row.remove();
    let cursor = target.firstElementChild;
    for (const event of events) {
      let row = rows.get(event.sequence);
      if (!row) {
        row = skeleton('li', <><time class="mono" /><p /></>); row.dataset.sequence = String(event.sequence);
      }
      const time = row.querySelector('time')!;
      time.dateTime = event.at; text(time, timestamp(event.at));
      text(row.querySelector('p')!, localizeText(event.message));
      if (row !== cursor) target.insertBefore(row, cursor);
      cursor = row.nextElementSibling;
    }
  }
}
