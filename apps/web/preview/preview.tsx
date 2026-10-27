import { render, type ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { locale, localeStorageKey, t } from '../i18n';
import { compareSources } from '../client/sourceDiff';
import { installTermHints } from '../client/termHints';
import { layoutTaskGraph } from '../client/taskGraphLayout';
import { renderAgentCards } from '../client/ui/AgentCards';
import { CollaborationSurface } from '../client/ui/CollaborationSurface';
import { createCommandPalette } from '../client/ui/CommandPalette';
import { renderConversation, type ConversationRun } from '../client/ui/Conversation';
import { Icon, iconNames, Spinner } from '../client/ui/Icon';
import { renderProgressSummary } from '../client/ui/ProgressSummary';
import { renderRunHeader, type RunHeaderProps } from '../client/ui/RunHeader';
import { renderRunMonitor } from '../client/ui/RunMonitor';
import { renderRunOverview, type RunOverviewProps } from '../client/ui/RunOverview';
import { Code, Detail, DiffRows, Empty, Facts } from '../client/ui/Section';
import { renderTaskGraph, renderTaskList, type TaskCard } from '../client/ui/TaskBoard';
import { renderTaskInspector } from '../client/ui/TaskInspector';
import { TermHint } from '../client/ui/TermHint';
import { renderTopbar } from '../client/ui/Topbar';

/**
 * Component preview: every workbench component with fixture props, in the interface language of the page.
 * Built by scripts/build-web-preview.ts into out/web-preview; it is never part of the deployed workbench.
 * Fixture content (task text, Lean source, Agent ids) stands in for recorded data and is not translated.
 */
document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
const noop = () => undefined;

/** Mounts a render-function component into its own root after the specimen frame exists. */
function Mount(props: { draw(root: HTMLElement): void; class?: string; [attribute: `data-${string}`]: string | undefined }) {
  const { draw, class: className, ...rest } = props;
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => draw(root.current!), [draw]);
  return <div ref={root} class={className} {...rest} />;
}

function Specimen(props: { id: string; title: string; note: string; children: ComponentChildren }) {
  return <section class="preview-specimen" id={props.id} data-specimen={props.id} aria-labelledby={`${props.id}-title`}>
    <header class="preview-specimen-heading"><h2 id={`${props.id}-title`}>{props.title}</h2><p>{props.note}</p></header>
    <div class="preview-stage">{props.children}</div>
  </section>;
}

const at = '2026-10-26T09:41:07.000Z';
const lean = (body: string) => `theorem add_comm' (a b : Nat) : a + b = b + a := by\n${body}`;
const card = (id: string, kind: string, state: string, proof: string, objective: string, owner: string, selected = false, share?: number): TaskCard => ({
  id, version: `${id}@3f2a91c`, kind, kindLabel: kind === 'goal' ? t('原始目标') : kind === 'lemma' ? t('引理') : t('研究'),
  state, stateLabel: state === 'integrated' ? t('已集成') : state === 'running' ? t('进行中') : t('待调度'), objective, owner,
  proof, proofLabel: proof === 'checked' ? t('已记录检查') : t('尚无证明'), selected,
  tokens: share === undefined ? undefined : { label: share > .5 ? '182K' : '41K', share, detail: '' },
});
const cards = [
  card('T1', 'lemma', 'integrated', 'checked', 'Prove Nat.add_zero for the inductive step.', 'prover-1', false, .22),
  card('T2', 'lemma', 'running', 'none', 'Show a + succ b = succ (a + b) from the recursor.', 'prover-2', true, 1),
  card('G', 'goal', 'pending', 'none', 'Assemble add_comm\' from T1 and T2.', 'lead'),
];
const graphEdges = [{ from: 'T1', to: 'G', kind: 'and' as const }, { from: 'T2', to: 'G', kind: 'and' as const }];

const tabs = [['collaboration', t('研究协作')], ['source', t('Lean 源码')], ['modules', t('模块')], ['overview', t('概览')], ['report', t('报告')], ['events', t('活动')]] as const;
const header = (sample: boolean, active: boolean): RunHeaderProps => ({
  title: 'add_comm\'', id: 'run-7c1d0e2a', environment: 'Lean 4.19 · Mathlib', updated: t('更新 {0}', '09:41:07'), error: '',
  status: active ? { key: 'running', label: t('构造证明'), tone: 'running', symbol: 'refresh-cw' } : { key: 'passed', label: t('完整原题通过'), tone: 'passed', symbol: 'circle-check' },
  stages: [{ label: t('排队'), state: 'done', clock: '0:02' }, { label: t('准备环境'), state: 'done', clock: '0:41' },
    { label: t('构造证明'), state: active ? 'active' : 'done', clock: '6:18' }, { label: t('独立验收'), state: active ? 'pending' : 'done', clock: active ? '' : '0:37' }],
  elapsed: '7:38', tabs, tab: 'overview', active, cancelling: false, deleting: false, connected: true,
  download: active ? undefined : '#', shareable: !sample && !active, sample,
});
const overview: RunOverviewProps = {
  runId: 'run-7c1d0e2a', active: false, tone: 'passed', symbol: 'circle-check', title: t('完整原题通过'), description: t('完整原题已通过独立验收'),
  phaseLabel: t('独立验收'), elapsed: '7:38', solving: '6:18', budget: '30:00', budgetUsed: .21,
  steps: [{ label: t('排队'), state: 'done', stateLabel: '✓', clock: '0:02', share: .01 }, { label: t('准备环境'), state: 'done', stateLabel: '✓', clock: '0:41', share: .09 },
    { label: t('构造证明'), state: 'done', stateLabel: '✓', clock: '6:18', share: .82 }, { label: t('独立验收'), state: 'done', stateLabel: '✓', clock: '0:37', share: .08 }],
  downloads: { proof: true, report: true }, task: 'Prove add_comm\' for natural numbers without using Nat.add_comm.',
  facts: [{ label: 'Model', value: 'deepseek-flash', mono: true }, { label: 'Lean', value: '4.19.0', mono: true }],
  agents: [{ id: 'lead', state: 'idle', phase: 'finished' }, { id: 'prover-1', state: 'idle', phase: 'finished', task: 'T1' }],
  events: [{ sequence: 3, at, time: '09:41:07', type: 'evaluation_finished', message: 'S3 accepted the full statement.' },
    { sequence: 2, at, time: '09:40:30', type: 'evaluation_started', message: 'Independent acceptance started.' },
    { sequence: 1, at, time: '09:34:12', type: 'proof_checked', message: 'T1 and T2 checked; goal assembled.' }],
  eventCount: 41,
};
const conversation = (working: boolean, failed = false): ConversationRun => ({
  id: working ? 'live' : failed ? 'failed' : 'done', task: lean('  sorry'), environment: 'Lean 4.19', model: 'deepseek-flash', working,
  events: [{ sequence: 1, at, time: '09:33:40', message: 'Environment ready.' }, { sequence: 2, at, time: '09:34:12', message: 'Lead split the goal into T1 and T2.' }],
  result: failed ? { tone: 'failed', symbol: 'circle-alert', label: t('运行失败'), description: 'The provider rejected the API key.', candidate: false }
    : working ? { tone: 'running', symbol: 'refresh-cw', label: t('构造证明'), description: 'prover-2 is working on T2.', candidate: true }
    : { tone: 'passed', symbol: 'circle-check', label: t('完整原题通过'), description: t('完整原题已通过独立验收'), candidate: false },
  recovery: failed ? [{ id: 'key', label: t('研究配置') }, { id: 'retry', label: t('重新连接') }] : undefined,
  feedback: failed ? '#' : undefined, notify: working ? 'off' : undefined,
});

const before = lean('  induction b with\n  | zero => simp\n  | succ n ih => sorry'), after = lean('  induction b with\n  | zero => simp\n  | succ n ih => omega');
const comparison = compareSources(before, after);
const layout = layoutTaskGraph(cards.map(item => item.id), graphEdges);

function drawCollaboration(root: HTMLElement) {
  // The specimen shows the full layer; the simple layer is covered by test:web-collaboration-layers.
  root.className = 'collab-surface'; root.dataset.detail = 'full';
  render(<CollaborationSurface runId="preview" taskView="graph" taskStates={[['running', t('进行中')], ['integrated', t('已集成')]]} />, root);
  const part = (selector: string) => root.querySelector<HTMLElement>(selector)!;
  part('[data-collab-observation]').textContent = '09:41:07';
  renderProgressSummary(part('[data-collab-summary]'), {
    proof: { checked: 1, total: 3, meter: { name: 'proof', segments: [{ key: 'checked', label: t('已检查'), count: 1 }, { key: 'running', label: t('进行中'), count: 1 }, { key: 'pending', label: t('待调度'), count: 1 }] } },
    agents: { working: 1, total: 3, meter: { name: 'agents', segments: [{ key: 'working', label: t('工作中'), count: 1 }, { key: 'idle', label: t('空闲'), count: 2 }] } },
    accepted: false, completedResearch: 0,
  });
  const graph = part('[data-collab-graph]');
  graph.style.width = `${layout.width}px`; graph.style.height = `${layout.height}px`; graph.dataset.density = 'comfortable';
  renderTaskGraph(graph, { cards, edges: layout.paths.map(({ edge, d }) => ({ ...edge, d })), positions: layout.positions, width: layout.width, height: layout.height, selected: 'T2' });
  renderTaskList(part('[data-collab-task-list]'), cards.map(item => ({ ...item, dependencies: item.id === 'G' ? 'T1, T2' : '—' })));
  part('[data-collab-task-count]').textContent = t('显示 {0} / {1} 个任务', cards.length, cards.length);
  renderTaskInspector(part('[data-collab-inspector]'), { mode: 'task', task: {
    id: 'T2', version: 'T2@3f2a91c', kindLabel: t('引理'), state: 'running', stateLabel: t('进行中'), proof: 'none', historical: false,
    objective: 'Show a + succ b = succ (a + b) from the recursor, then rewrite with the induction hypothesis so the goal closes without Nat.add_comm.',
    facts: [{ name: 'Owner', value: 'prover-2' }, { name: 'Commit', value: '3f2a91c' }], type: '∀ (a b : Nat), a + Nat.succ b = Nat.succ (a + b)',
    details: [{ title: t('前提'), value: ['Nat.rec', 'T1'], id: 'premises-T2' }, { title: t('检查反馈'), value: { status: 'pending' }, id: 'feedback-T2' }],
    artifacts: [{ kind: 'source', label: 'Source · T2.lean · 3f2a91c', attributes: { 'data-focus-key': 'source-T2' } }], hasChecks: false,
  } });
  renderAgentCards(part('[data-collab-agents]'), [
    { id: 'lead', role: 'Lead / Lead', scheduling: t('空闲'), schedulingStatus: 'idle', phase: t('已准备'), turns: '4', details: [] },
    { id: 'prover-2', role: 'Prover / Prover', scheduling: t('工作中'), schedulingStatus: 'working', phase: t('研究中'), turns: '9', task: 'T2',
      details: [{ title: t('最近故障'), value: { kind: 'timeout', turn: 7 }, id: 'failure-prover-2' }] },
  ]);
}

const palette = createCommandPalette(() => [
  { id: 'glossary', group: t('帮助'), label: t('术语说明'), icon: 'circle-help', run: noop },
  { id: 'sample', group: t('帮助'), label: t('先看一次完整运行'), icon: 'play', run: noop },
  { id: 'settings', group: t('研究'), label: t('研究配置'), icon: 'sliders-horizontal', run: noop },
]);
installTermHints(noop);

const specimens = [
  ['foundations', 'Foundations'], ['sections', 'Section helpers'], ['topbar', 'Topbar'], ['conversation', 'Conversation'],
  ['monitor', 'Run monitor'], ['header', 'Run header'], ['overview', 'Run overview'], ['collaboration', 'Collaboration'],
] as const;

function Preview() {
  const switchTo = locale === 'en' ? 'zh' : 'en';
  return <>
    <header class="preview-bar"><strong>TheoremOS components</strong>
      <nav aria-label="Specimens"><ul>{specimens.map(([id, name]) => <li key={id}><a href={`#${id}`}>{name}</a></li>)}</ul></nav>
      <button type="button" class="button" data-preview-locale={switchTo} onClick={() => { localStorage.setItem(localeStorageKey, switchTo); location.reload(); }}>
        {switchTo === 'en' ? 'English' : '中文'}</button>
      <button type="button" class="button" data-preview-palette onClick={() => palette.open()}>{t('打开命令面板')}</button>
    </header>
    <main id="preview-main" class="preview-main" tabIndex={-1}>
      <Specimen id="foundations" title="Foundations" note="Icons, buttons, badges, spinner and the term hint.">
        <ul class="preview-icons" aria-label="Icons">{iconNames.map(name => <li key={name} title={name}><Icon name={name} /><code>{name}</code></li>)}</ul>
        <div class="preview-row"><button type="button" class="button">Button</button><button type="button" class="button button-primary">Primary</button>
          <button type="button" class="button button-danger">Danger</button><button type="button" class="text-button">Text button</button>
          <button type="button" class="icon-button" aria-label="Icon button"><Icon name="copy" /></button><button type="button" class="button" disabled>Disabled</button></div>
        <div class="preview-row">{['passed', 'running', 'warning', 'failed', ''].map(tone => <span key={tone} class={`badge ${tone}`}><Icon name="circle-check" />{tone || 'neutral'}</span>)}
          <Spinner /><span class="term-heading"><strong>{t('独立验收')}</strong><TermHint id="acceptance" /></span></div>
      </Specimen>
      <Specimen id="sections" title="Section helpers" note="Code, Detail, Facts, Empty and DiffRows from ui/Section.">
        <div class="collab-surface preview-column">
          <Facts facts={[['Run', 'run-7c1d0e2a'], ['Commit', '3f2a91c'], ['Missing', undefined]]} />
          <Code value={before} label="Lean source" />
          <Detail title={t('检查反馈')} value={{ status: 'passed', receipts: ['T1', 'T2'] }} detailKey="preview" />
          <Empty>{t('尚无人工计划编辑记录')}</Empty>
          <div class="diff-scroll" tabIndex={0} aria-label="Diff"><table class="source-diff"><tbody><DiffRows rows={comparison.rows} /></tbody></table></div>
        </div>
      </Specimen>
      <Specimen id="topbar" title="Topbar" note="Connected with a live run and an account; offline without them.">
        <Mount class="topbar" data-variant="live" draw={root => renderTopbar(root, { title: 'add_comm\'', model: 'deepseek-flash', connection: { tone: 'ready', label: t('环境就绪') },
          settingsDisabled: false, mac: false, account: 'reader@example.com', live: { label: t('构造证明'), detail: '6:18', tone: 'running', count: 1 },
          onHistory: noop, onSettings: noop, onPalette: () => palette.open(), onLive: noop, onAccount: noop, onGlossary: noop, onLocale: noop })} />
        <Mount class="topbar" data-variant="offline" draw={root => renderTopbar(root, { title: t('新研究'), model: 'deepseek-flash', connection: { tone: 'offline', label: t('连接中断') },
          settingsDisabled: true, mac: true, onHistory: noop, onSettings: noop, onPalette: noop, onLive: noop, onAccount: noop, onGlossary: noop, onLocale: noop })} />
      </Specimen>
      <Specimen id="conversation" title="Conversation" note="First-run welcome, a live run, an accepted run and a failure with recovery.">
        <div class="preview-grid">
          <Mount class="chat-thread" draw={root => renderConversation(root, { firstRun: true, sample: { title: 'Commutativity of Nat addition' }, templates: [{ id: 'add', name: 'add_comm\'', environment: 'Lean 4.19' }] })} />
          <Mount class="chat-thread" draw={root => renderConversation(root, { run: conversation(true), templates: [], firstRun: false })} />
          <Mount class="chat-thread" draw={root => renderConversation(root, { run: conversation(false), templates: [], firstRun: false })} />
          <Mount class="chat-thread" draw={root => renderConversation(root, { run: conversation(false, true), templates: [], firstRun: false })} />
        </div>
      </Specimen>
      <Specimen id="monitor" title="Run monitor" note="One run in progress and one finished, dismissible run.">
        <nav class="run-monitor" aria-label={t('当前会话运行任务')}><Mount class="run-monitor-list" draw={root => renderRunMonitor(root, [
          { id: 'a', title: 'add_comm\'', description: t('构造证明'), tone: 'running', symbol: 'refresh-cw', current: true, cancelling: false, active: true, stages: ['done', 'done', 'active', 'pending'] },
          { id: 'b', title: 'mul_comm\'', description: t('完整原题通过'), tone: 'passed', symbol: 'circle-check', current: false, cancelling: false, active: false, stages: ['done', 'done', 'done', 'done'] },
        ])} /></nav>
      </Specimen>
      <Specimen id="header" title="Run header" note="A live run, an accepted run and the read-only sample.">
        <section class="run-detail preview-column" aria-label="Live"><Mount draw={root => renderRunHeader(root, header(false, true))} /></section>
        <section class="run-detail preview-column" aria-label="Accepted"><Mount draw={root => renderRunHeader(root, header(false, false))} /></section>
        <section class="run-detail preview-column" aria-label="Sample"><Mount draw={root => renderRunHeader(root, header(true, false))} /></section>
      </Specimen>
      <Specimen id="overview" title="Run overview" note="The overview tab of an accepted run.">
        <div class="detail-panel"><Mount class="overview-workspace" draw={root => renderRunOverview(root, overview)} /></div>
      </Specimen>
      <Specimen id="collaboration" title="Collaboration" note="The collaboration surface with a graph, an inspected task and Agent cards.">
        <Mount draw={drawCollaboration} />
      </Specimen>
    </main>
  </>;
}

render(<Preview />, document.querySelector<HTMLElement>('#preview')!);
