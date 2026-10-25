import { render } from 'preact';
import { Icon, Spinner } from './Icon';

export type ConversationTemplate = { id: string; name: string; environment: string };
export type ConversationEvent = { sequence: number; at: string; time: string; message: string };
export type ConversationRun = {
  id: string; task: string; environment: string; model: string; working: boolean; events: ConversationEvent[];
  result: { tone: string; symbol: string; label: string; description: string; candidate: boolean };
};
export type ConversationProps = { run?: ConversationRun; templates: ConversationTemplate[] };

// aria-pressed on the suggestions is owned by app.ts's renderTemplateSelection, which runs after every render.
function Welcome({ templates }: { templates: ConversationTemplate[] }) {
  return <div class="chat-welcome"><img src="assets/mark.svg" alt="" width={40} height={40} /><h2>从一道定理开始</h2>
    <div class="chat-suggestions" aria-label="示例题目"><span class="suggestions-label">示例题目</span>
      {templates.map(template => <button key={template.id} type="button" class="template-suggestion" data-chat-template={template.id}>
        <Icon name="file-code-2" /><span>{template.name}</span><span class="suggestion-environment">{template.environment}</span><Icon name="arrow-up-right" />
      </button>)}</div></div>;
}

function Event({ event, active }: { event: ConversationEvent; active: boolean }) {
  return <li class="timeline-event" data-sequence={event.sequence} data-tone={active ? 'active' : 'done'}>
    <span class="timeline-marker" aria-hidden="true">{active && <Spinner />}</span>
    <div class="timeline-text"><span>{event.message}</span><time dateTime={event.at}>{event.time}</time></div>
  </li>;
}

function Thread({ run }: { run: ConversationRun }) {
  const { result, working } = run;
  return <>
    <article class="chat-message user" aria-label="用户研究任务"><div class="message-body">{run.task}</div>
      <button type="button" class="message-attachment" data-chat-action="source"><Icon name="file-code-2" /><span>Submission.lean</span><span>{run.environment}</span></button></article>
    <article class="chat-message assistant" aria-label="TheoremOS 研究反馈">
      <div class="assistant-identity"><img src="assets/mark.svg" alt="" width={24} height={24} /><span>TheoremOS</span><span class="assistant-model mono">{run.model}</span></div>
      <div class="message-body">
        <ol class="research-timeline">{run.events.map((event, index) => <Event key={event.sequence} event={event} active={working && index === run.events.length - 1} />)}</ol>
        <div class={`chat-result ${result.tone}`}>
          <h3>{working ? <Spinner /> : <Icon name={result.symbol} />}{result.label}</h3><p>{result.description}</p>
          {result.candidate && <span class="candidate-notice">候选源码已更新 · 尚未验收</span>}
        </div>
        <div class="chat-result-actions">
          <button type="button" class="text-button" data-chat-action={working ? 'events' : 'report'}><Icon name={working ? 'list' : 'file-json-2'} />{working ? '活动记录' : '查看报告'}</button>
          {!working && <button type="button" class="text-button" data-chat-action="reuse"><Icon name="copy-plus" />基于此题新建研究</button>}
        </div>
      </div>
    </article>
  </>;
}

const mounted = new WeakSet<HTMLElement>();
// Keyed by run id: a different run remounts the thread, while polling keeps message and row nodes.
export function renderConversation(root: HTMLElement, props: ConversationProps) {
  if (!mounted.has(root)) { root.textContent = ''; mounted.add(root); }
  render(props.run ? <Thread key={props.run.id} run={props.run} /> : <Welcome key="welcome" templates={props.templates} />, root);
}
