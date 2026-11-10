import type { WebExplanationSection } from '../../shared';
import { t } from '../../i18n';
import type { ChatAnswer } from '../chatAnswer';
import type { ChatMathematicalTask, ChatMathematics } from '../chatMathematics';
import { ChatMessageContent } from './ChatMessageContent';
import { Icon } from './Icon';

export function ChatMathematicalProgress({ work, onTask }: { work: ChatMathematics; onTask(id: string): void }) {
  const tasks = (items: ChatMathematicalTask[]) => <ul class="chat-math-tasks">{items.map(task => <li key={task.id}>
    <ChatMessageContent text={task.statement} /><button type="button" class="text-button" data-chat-math-task={task.id} onClick={() => onTask(task.id)}>
      <Icon name="network" /><span translate={false}>{task.name}</span></button>
  </li>)}</ul>;
  return <section class="chat-mathematics" data-chat-mathematics aria-labelledby="chat-mathematics-heading">
    <h3 id="chat-mathematics-heading">{t('数学进展')}</h3>
    {work.checked.length > 0 && <div data-chat-math-checked><h4>{t('已检查的引理与目标（{0}）', work.checked.length)}</h4>
      {tasks(work.checked.slice(0, 3))}{work.checked.length > 3 && <details><summary>{t('查看其余 {0} 项', work.checked.length - 3)}</summary>{tasks(work.checked.slice(3))}</details>}
    </div>}
    {work.working.length > 0 && <div data-chat-math-working><h4>{t('正在处理')}</h4>{tasks(work.working)}</div>}
    {work.blockers.length > 0 && <div data-chat-math-blockers><h4>{t('当前障碍')}</h4><ul>{work.blockers.map(blocker => <li key={blocker.id}><ChatMessageContent text={blocker.text} /></li>)}</ul></div>}
    {work.latest && <div class="chat-math-finding" data-chat-math-finding><h4>{work.latest.kind === 'finding' ? t('研究记录') : t('题意与目标记录')}</h4>
      <ChatMessageContent text={work.latest.text} />
    </div>}
    {!work.checked.length && !work.working.length && !work.blockers.length && !work.latest && <p class="chat-math-empty">{t('数学记录会在题意、引理或研究结果写入后显示。')}</p>}
  </section>;
}

function AnswerSection({ section }: { section: WebExplanationSection }) {
  const content = <>
    {section.statement && <div class="chat-answer-statement"><ChatMessageContent text={section.statement} /></div>}
    {section.steps.length > 0 && <ol class="chat-answer-steps">{section.steps.map((step, index) => <li key={index}>
      <ChatMessageContent text={step.text} />
      {step.uses.length > 0 && <p class="chat-answer-uses"><span>{t('用到')}</span>{step.uses.map(use => <code key={use.name} translate={false}>{use.name}</code>)}</p>}
    </li>)}</ol>}
  </>;
  return section.target ? <section class="chat-answer-target" data-chat-answer-target={section.name}>
    <h4 translate={false}>{section.title || section.name}</h4>{content}
  </section> : <details class="chat-answer-support"><summary translate={false}>{section.title || section.name}</summary>{content}</details>;
}

export function ChatMathematicalAnswer({ runId, answer, onRetry, onTarget }: {
  runId: string; answer?: ChatAnswer; onRetry(): void; onTarget(target: string): void;
}) {
  const document = answer?.document, targets = answer?.overview?.targets ?? [];
  const explanationUrl = `explain.html?${new URLSearchParams({ run: runId, ...(answer?.target ? { target: answer.target } : {}) })}`;
  return <section class="chat-mathematical-answer" data-chat-answer aria-labelledby="chat-answer-heading" aria-busy={answer?.loading}>
    <h3 id="chat-answer-heading">{t('详细解答')}</h3>
    {targets.length > 1 && <label class="chat-answer-selection">{t('阅读目标')}<select data-chat-answer-select value={answer?.target} onChange={event => onTarget(event.currentTarget.value)}>
      {targets.map(target => <option key={target.name} value={target.name}>{target.name}</option>)}
    </select></label>}
    {answer?.loading && !document && <p class="chat-answer-state" role="status"><span class="spinner" />{t('正在读取已有讲解…')}</p>}
    {answer?.error && <div class="chat-error" role="alert"><p>{answer.error}</p><button type="button" class="text-button" data-chat-answer-retry onClick={onRetry}>{t('重新读取讲解')}</button></div>}
    {document && <div data-chat-answer-document={document.target}>
      <ChatMessageContent text={document.overview} />
      {document.sections.map(section => <AnswerSection key={section.name} section={section} />)}
    </div>}
    {!document && !answer?.loading && !answer?.error && <p class="chat-math-empty">{t('这份验收证明还没有可阅读的讲解。')}</p>}
    <div class="chat-task-actions">
      <a class={document ? 'text-button' : 'button'} data-chat-explain href={explanationUrl} target="_blank" rel="noopener">{document ? t('打开完整讲解') : t('生成详细解答')}</a>
      {document && <button type="button" class="text-button" disabled={answer?.loading} data-chat-answer-refresh onClick={onRetry}>{t('刷新讲解')}</button>}
    </div>
  </section>;
}
