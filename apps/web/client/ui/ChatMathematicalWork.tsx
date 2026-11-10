import type { WebExplanationPhase, WebExplanationSection } from '../../shared';
import { locale, t } from '../../i18n';
import { explanationStepQuestion, type ChatAnswer } from '../chatAnswer';
import type { ChatMathematicalTask, ChatMathematics } from '../chatMathematics';
import { explanationReasonText, explanationUnavailableText } from '../explanationState';
import { ChatMessageContent } from './ChatMessageContent';
import { Icon } from './Icon';

export function ChatMathematicalProgress({ work, onTask }: { work: ChatMathematics; onTask(id: string): void }) {
  const statuses = { running: t('正在证明'), delivered: t('候选已提交，等待检查'), conditional: t('候选仍有前提待证明') };
  const tasks = (items: ChatMathematicalTask[]) => <ul class="chat-math-tasks">{items.map(task => <li key={task.id}>
    {task.status && <span class="chat-math-task-status" data-chat-math-status={task.status}>{statuses[task.status]}</span>}
    <ChatMessageContent text={task.statement} /><button type="button" class="text-button" data-chat-math-task={task.id} onClick={() => onTask(task.id)}>
      <Icon name="network" /><span translate={false}>{task.name}</span></button>
  </li>)}</ul>;
  return <section class="chat-mathematics" data-chat-mathematics aria-labelledby="chat-mathematics-heading">
    <h3 id="chat-mathematics-heading">{t('数学进展')}</h3>
    {work.blockers.length > 0 && <div data-chat-math-blockers><h4>{t('当前障碍')}</h4><ul>{work.blockers.map(blocker => <li key={blocker.id}><ChatMessageContent text={blocker.text} /></li>)}</ul></div>}
    {work.working.length > 0 && <div data-chat-math-working><h4>{t('当前目标与候选')}</h4>{tasks(work.working)}</div>}
    {work.checked.length > 0 && <div data-chat-math-checked><h4>{t('已检查的引理与目标（{0}）', work.checked.length)}</h4>
      {tasks(work.checked.slice(0, 3))}{work.checked.length > 3 && <details><summary>{t('查看其余 {0} 项', work.checked.length - 3)}</summary>{tasks(work.checked.slice(3))}</details>}
    </div>}
    {work.latest && <div class="chat-math-finding" data-chat-math-finding><h4>{work.latest.kind === 'finding' ? t('研究记录') : t('题意与目标记录')}</h4>
      <ChatMessageContent text={work.latest.text} />
    </div>}
    {!work.checked.length && !work.working.length && !work.blockers.length && !work.latest && <p class="chat-math-empty">{t('数学记录会在题意、引理或研究结果写入后显示。')}</p>}
  </section>;
}

function AnswerSection({ section, sections, anchor, source, onQuestion }: { section: WebExplanationSection; sections: WebExplanationSection[];
  anchor(name: string): string; source: string; onQuestion?(text: string): void }) {
  const content = <>
    {section.statement && <div class="chat-answer-statement"><ChatMessageContent text={section.statement} /></div>}
    {section.steps.length > 0 && <ol class="chat-answer-steps">{section.steps.map((step, index) => <li key={index}>
      <ChatMessageContent text={step.text} />
      {step.uses.length > 0 && <p class="chat-answer-uses"><span>{t('用到')}</span>{step.uses.map(use => {
        const matches = sections.filter(item => item.name === use.name || item.name.split('.').at(-1) === use.name);
        const local = matches.length === 1 ? matches[0] : undefined;
        return local ? <a key={use.name} href={`#${anchor(local.name)}`} title={use.name} data-chat-answer-use={local.name} onClick={event => {
          event.preventDefault();
          const node = window.document.getElementById(anchor(local.name));
          if (node instanceof HTMLDetailsElement) node.open = true;
          node?.scrollIntoView({ block: 'nearest' }); node?.focus({ preventScroll: true });
        }}>{local.title || local.name}</a> : <code key={use.name} translate={false}>{use.name}</code>;
      })}</p>}
      {onQuestion && <button type="button" class="text-button chat-answer-question" data-chat-answer-question={`${section.name}:${index}`}
        onClick={() => onQuestion(explanationStepQuestion(section, index, source, locale))}>{t('解释这一步')}</button>}
    </li>)}</ol>}
  </>;
  return section.target ? <section id={anchor(section.name)} tabIndex={-1} class="chat-answer-target" data-chat-answer-target={section.name}>
    <h4 translate={false}>{section.title || section.name}</h4>{content}
  </section> : <details id={anchor(section.name)} tabIndex={-1} class="chat-answer-support"><summary translate={false}>{section.title || section.name}</summary>{content}</details>;
}

export function ChatMathematicalAnswer({ runId, answer, onRetry, onTarget, onQuestion }: {
  runId: string; answer?: ChatAnswer; onRetry(): void; onTarget(target: string): void; onQuestion?(text: string): void;
}) {
  const document = answer?.document, targets = answer?.overview?.targets ?? [];
  const explanation = answer?.explanation, generation = answer?.overview?.generation;
  const generating = explanation?.status === 'queued' || explanation?.status === 'running';
  const stopped = explanation && ['error', 'exhausted', 'cancelled'].includes(explanation.status);
  const phases: Record<WebExplanationPhase, string> = { queued: t('讲解正在排队'), preparing: t('正在准备讲解'),
    extracting: t('正在提取证明结构'), writing: t('正在撰写详细解答'), auditing: t('正在核对讲解与证明'),
    revising: t('正在修订讲解'), retrying: t('正在重试生成讲解'), finishing: t('正在保存讲解') };
  const explanationUrl = `explain.html?${new URLSearchParams({ run: runId, ...(answer?.target ? { target: answer.target } : {}) })}`;
  const anchor = (name: string) => `chat-answer-${encodeURIComponent(runId)}-${encodeURIComponent(answer?.target ?? '')}-${encodeURIComponent(name)}`;
  return <section class="chat-mathematical-answer" data-chat-answer data-chat-answer-status={document ? 'ready' : answer?.error ? 'read-error'
    : answer?.loading ? 'reading' : explanation?.status ?? (generation?.available ? 'missing' : 'unavailable')}
    aria-labelledby="chat-answer-heading" aria-busy={answer?.loading || generating}>
    <h3 id="chat-answer-heading">{t('详细解答')}</h3>
    {targets.length > 1 && <label class="chat-answer-selection">{t('阅读目标')}<select data-chat-answer-select value={answer?.target} onChange={event => onTarget(event.currentTarget.value)}>
      {targets.map(target => <option key={target.name} value={target.name}>{answer?.targetTitles?.[target.name] || target.name}</option>)}
    </select></label>}
    {answer?.targetTitles?.[answer.target] && <p class="chat-answer-lean-name" translate={false}>{answer.target}</p>}
    {answer?.loading && !document && <p class="chat-answer-state" role="status"><span class="spinner" />{t('正在读取已有讲解…')}</p>}
    {answer?.error && <div class="chat-error" role="alert">{document && <p>{t('刷新失败，下面保留上次读取的解答。')}</p>}<p>{answer.error}</p><button type="button" class="text-button" data-chat-answer-retry onClick={onRetry}>{t('重新读取讲解')}</button></div>}
    {document && <div data-chat-answer-document={document.target}>
      <ChatMessageContent text={document.overview} />
      {document.sections.map(section => <AnswerSection key={section.name} section={section} sections={document.sections} anchor={anchor}
        source={`${new URL(explanationUrl, location.href).href}#explain-section-${document.sections.indexOf(section)}`} onQuestion={onQuestion} />)}
    </div>}
    {!document && !answer?.loading && !answer?.error && <>
      {generating ? <div class="chat-answer-generation" role="status"><p class="chat-answer-state"><span class="spinner" />{explanation.status === 'queued'
        ? t('讲解正在排队') : phases[explanation.progress?.phase ?? 'writing']}</p>
        {explanation.queue && <p>{t('前面 {0} 份', explanation.queue.ahead)}</p>}
        {explanation.progress?.batches !== undefined && <p>{t('已通过批次')} {explanation.progress.approvedBatches ?? 0} / {explanation.progress.batches}</p>}
        <p>{t('讲解会在后台继续，完成后自动显示。')}</p></div>
        : <>
          {stopped ? <div class="chat-answer-stopped" role="status"><strong>{explanation.status === 'cancelled' ? t('已停止生成')
            : explanation.status === 'exhausted' ? t('讲解没有完成') : t('生成失败')}</strong>
            {explanation.status !== 'cancelled' && <p>{explanationReasonText(explanation.reason)}</p>}</div>
            : <p class="chat-math-empty">{t('这份验收证明还没有可阅读的讲解。')}</p>}
          {generation && 'reason' in generation && <p class="chat-math-empty" data-chat-answer-unavailable>{explanationUnavailableText(generation.reason)}</p>}
        </>}
    </>}
    <div class="chat-task-actions">
      {(document || generating || !answer?.loading && !answer?.error && generation?.available) && <a class={document || generating ? 'text-button' : 'button button-primary'}
        data-chat-explain href={explanationUrl} target="_blank" rel="noopener">{document ? t('打开完整讲解') : generating ? t('查看讲解进度')
          : stopped ? t('重新生成详细解答') : t('生成详细解答')}</a>}
      {!answer?.error && <button type="button" class="text-button" disabled={answer?.loading} data-chat-answer-refresh onClick={onRetry}>{t('刷新讲解')}</button>}
    </div>
  </section>;
}
