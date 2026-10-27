import { render } from 'preact';
import { useState } from 'preact/hooks';
import { Icon, Spinner } from './Icon';
import { t } from '../../i18n';

export type ConversationTemplate = { id: string; name: string; environment: string };
export type ConversationEvent = { sequence: number; at: string; time: string; message: string };
export type ConversationRun = {
  id: string; task: string; environment: string; model: string; working: boolean; events: ConversationEvent[];
  result: { tone: string; symbol: string; label: string; description: string; candidate: boolean };
  /** Recovery for a run that stopped without a verdict; 'report' opens the report tab. */
  recovery?: { id: string; label: string }[];
  /** Prefilled feedback form for failures on our side, which the visitor cannot fix by changing the run. */
  feedback?: string;
  /** Desktop notification preference, offered while the run is active. */
  notify?: 'on' | 'off' | 'blocked' | 'unsupported';
};
const notifyLabels = { on: t('结束时通知我 · 已开启'), off: t('结束时通知我'), blocked: t('通知已被浏览器阻止'), unsupported: '' };
export type ConversationProps = { run?: ConversationRun; templates: ConversationTemplate[];
  /** The read-only sample run, when the server ships one. */ sample?: { title: string };
  /** No run yet in this account or session: the welcome explains the steps. */ firstRun: boolean };

const steps = [
  { title: t('写下原题'), detail: t('Lean 文件里用 sorry 留出要证明的定理，或者从下面的示例题目开始。') },
  { title: t('连接模型'), detail: t('在研究配置里选择服务商，填入自己的 API Key。Key 只用于调用服务商，是否保存由你决定。') },
  { title: t('等待验收'), detail: t('Agent 拆分任务、写证明，最后由隔离的 Lean 环境检查完整原题。') },
];

// aria-pressed on the suggestions is owned by app.ts's renderTemplateSelection, which runs after every render.
function Welcome({ templates, sample, firstRun }: Omit<ConversationProps, 'run'>) {
  return <div class="chat-welcome" data-first-run={firstRun}><img src="assets/mark.svg" alt="" width={40} height={40} /><h2>{t('从一道定理开始')}</h2>
    {/* The sample comes first: a visitor without a key can see the whole flow before reading how to start one. */}
    {sample && <button type="button" class="welcome-sample" data-chat-action="sample">
      <Icon name="play" /><span><strong>{t('先看一次完整运行')}</strong><span>{t('{0} · 无需 API Key', sample.title)}</span></span><Icon name="arrow-right" /></button>}
    {firstRun && <ol class="welcome-steps" aria-label={t('使用步骤')}>{steps.map((step, index) =>
      <li key={step.title}><span class="welcome-step-index mono" aria-hidden="true">{index + 1}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div></li>)}</ol>}
    <div class="chat-suggestions" aria-label={t('示例题目')}><span class="suggestions-label">{t('示例题目')}</span>
      {templates.map(template => <button key={template.id} type="button" class="template-suggestion" data-chat-template={template.id}>
        <Icon name="file-code-2" /><span>{template.name}</span><span class="suggestion-environment">{template.environment}</span><Icon name="arrow-up-right" />
      </button>)}</div>
    <div class="welcome-help">
      <a class="text-button" href="guide.html" target="_blank" rel="noopener" data-guide><Icon name="circle-help" />{t('使用说明')}</a>
      <button type="button" class="text-button welcome-glossary" data-chat-action="glossary"><Icon name="book-open" />{t('术语说明')}</button></div></div>;
}

function Event({ event, active, folded }: { event: ConversationEvent; active: boolean; folded: boolean }) {
  return <li class="timeline-event" data-sequence={event.sequence} data-tone={active ? 'active' : 'done'} hidden={folded}>
    <span class="timeline-marker" aria-hidden="true">{active && <Spinner />}</span>
    <div class="timeline-text"><span>{event.message}</span><time dateTime={event.at}>{event.time}</time></div>
  </li>;
}

// The thread shows the newest steps; older rows stay mounted but folded, so expanding keeps reading state and motion.
const recentSteps = 3, foldAbove = 5;
const recoveryIcons: Record<string, string> = { retry: 'refresh-cw', key: 'key-round', budget: 'clock-3', tokens: 'gauge', turns: 'list', workers: 'users', source: 'square-pen' };

function Thread({ run }: { run: ConversationRun }) {
  const { result, working } = run;
  const recovery = run.recovery?.filter(action => action.id !== 'report') ?? [];
  const [expanded, setExpanded] = useState(false);
  const foldable = run.events.length > foldAbove, folded = foldable && !expanded ? run.events.length - recentSteps : 0;
  return <>
    <article class="chat-message user" aria-label={t('用户研究任务')}><div class="message-body" translate={false}>{run.task}</div>
      <button type="button" class="message-attachment" data-chat-action="source"><Icon name="file-code-2" /><span>Submission.lean</span><span>{run.environment}</span></button></article>
    <article class="chat-message assistant" aria-label={t('TheoremOS 研究反馈')}>
      <div class="assistant-identity"><img src="assets/mark.svg" alt="" width={24} height={24} /><span>TheoremOS</span><span class="assistant-model mono">{run.model}</span></div>
      <div class="message-body">
        {foldable && <button type="button" class="text-button timeline-fold" data-timeline-fold aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} />{expanded ? t('收起步骤') : t('展开全部 {0} 步', run.events.length)}</button>}
        <ol class="research-timeline">{run.events.map((event, index) => <Event key={event.sequence} event={event} active={working && index === run.events.length - 1} folded={index < folded} />)}</ol>
        <div class={`chat-result ${result.tone}`}>
          <h3>{working ? <Spinner /> : <Icon name={result.symbol} />}{result.label}</h3><p>{result.description}</p>
          {result.candidate && <span class="candidate-notice">{t('候选源码已更新 · 尚未验收')}</span>}
        </div>
        <div class="chat-result-actions">
          {recovery.map(action => <button key={action.id} type="button" class="button recovery-action" data-chat-action="recover" data-recovery={action.id}>
            <Icon name={recoveryIcons[action.id] ?? 'refresh-cw'} />{action.label}</button>)}
          {run.notify && run.notify !== 'unsupported' && <button type="button" class="text-button" data-chat-action="notify" aria-pressed={run.notify === 'on'}>
            <Icon name={run.notify === 'on' ? 'bell-ring' : run.notify === 'blocked' ? 'bell-off' : 'bell'} />{notifyLabels[run.notify]}</button>}
          {run.feedback && <a class="text-button" href={run.feedback} target="_blank" rel="noopener noreferrer" data-feedback-link><Icon name="message-square" />{t('反馈问题')}</a>}
          <button type="button" class="text-button" data-chat-action={working ? 'events' : 'report'}><Icon name={working ? 'list' : 'file-json-2'} />{working ? t('活动记录') : t('查看报告')}</button>
          {!working && !recovery.some(action => action.id === 'retry') && <button type="button" class="text-button" data-chat-action="reuse"><Icon name="copy-plus" />{t('基于此题新建研究')}</button>}
        </div>
      </div>
    </article>
  </>;
}

const mounted = new WeakSet<HTMLElement>();
// Keyed by run id: a different run remounts the thread, while polling keeps message and row nodes.
export function renderConversation(root: HTMLElement, props: ConversationProps) {
  if (!mounted.has(root)) { root.textContent = ''; mounted.add(root); }
  render(props.run ? <Thread key={props.run.id} run={props.run} /> : <Welcome key="welcome" templates={props.templates} sample={props.sample} firstRun={props.firstRun} />, root);
}
