import { render } from 'preact';
import { Icon } from './Icon';
import { t } from '../../i18n';

export type ConversationTemplate = { id: string; name: string; environment: string };
export type ConversationProps = { templates: ConversationTemplate[];
  /** The read-only sample run, when the server ships one. */ sample?: { title: string };
  /** No run yet in this account or session: the welcome explains the steps. */ firstRun: boolean };

const steps = [
  { title: t('写下原题'), detail: t('Lean 文件里用 sorry 留出要证明的定理，也可以先选一道示例题目。') },
  { title: t('连接模型'), detail: t('在研究配置里选择服务商，填入自己的 API Key。Key 只用于调用服务商，是否保存由你决定。') },
  { title: t('等待验收'), detail: t('Agent 拆分任务、写证明，最后由隔离的 Lean 环境检查完整原题。') },
];

// aria-pressed on the suggestions is owned by app.ts's renderTemplateSelection, which runs after every render.
function Welcome({ templates, sample, firstRun }: ConversationProps) {
  return <div class="chat-welcome" data-first-run={firstRun}><img src="assets/mark.svg" alt="" width={40} height={40} /><h2>{t('从一道定理开始')}</h2>
    {/* The sample comes first: a visitor without a key can see the whole flow before choosing a problem. */}
    {sample && <button type="button" class="welcome-sample" data-chat-action="sample">
      <Icon name="play" /><span><strong>{t('先看一次完整运行')}</strong><span>{t('{0} · 无需 API Key', sample.title)}</span></span><Icon name="arrow-right" /></button>}
    <div class="chat-suggestions" aria-label={t('示例题目')}><span class="suggestions-label">{t('示例题目')}</span>
      {templates.map(template => <button key={template.id} type="button" class="template-suggestion" data-chat-template={template.id}>
        <Icon name="file-code-2" /><span>{template.name}</span><span class="suggestion-environment">{template.environment}</span><Icon name="arrow-up-right" />
      </button>)}</div>
    {/* Something to click comes before reading: the steps follow the sample problems, which then stay above the fold. */}
    {firstRun && <ol class="welcome-steps" aria-label={t('使用步骤')}>{steps.map((step, index) =>
      <li key={step.title}><span class="welcome-step-index mono" aria-hidden="true">{index + 1}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div></li>)}</ol>}
    <div class="welcome-help">
      <a class="text-button" href="guide.html" target="_blank" rel="noopener" data-guide><Icon name="circle-help" />{t('使用说明')}</a>
      <button type="button" class="text-button welcome-glossary" data-chat-action="glossary"><Icon name="book-open" />{t('术语说明')}</button></div></div>;
}

const mounted = new WeakSet<HTMLElement>();
/** The new-research page opens with the sample, the steps for a first run and the example statements; a run's progress lives in its document. */
export function renderConversation(root: HTMLElement, props: ConversationProps) {
  if (!mounted.has(root)) { root.textContent = ''; mounted.add(root); }
  render(<Welcome {...props} />, root);
}
