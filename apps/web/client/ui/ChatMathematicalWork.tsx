import type { WebExplanationPhase, WebExplanationSection } from '../../shared';
import { locale, t } from '../../i18n';
import { explanationStepQuestion, type ChatAnswer } from '../chatAnswer';
import type { ChatMathematicalTask, ChatMathematics } from '../chatMathematics';
import { explanationModelRequestFailuresText, explanationReasonText, explanationUnavailableText } from '../explanationState';
import { ChatMessageContent } from './ChatMessageContent';
import { Icon } from './Icon';

export function ChatMathematicalProgress({ work, onTask }: { work: ChatMathematics; onTask(id: string): void }) {
  if (!work.checked.length && !work.working.length && !work.blockers.length && !work.latest) return null;
  const statuses = { running: t('正在证明'), delivered: t('候选已提交，等待检查'), conditional: t('候选仍有前提待证明') };
  const tasks = (items: ChatMathematicalTask[]) => <ul class="chat-math-tasks">{items.map(task => <li key={task.id}>
    {task.status && <span class="chat-math-task-status" data-chat-math-status={task.status}>{statuses[task.status]}</span>}
    <ChatMessageContent text={task.statement} /><button type="button" class="text-button" data-chat-math-task={task.id} onClick={() => onTask(task.id)}>
      <Icon name="network" /><span translate={false}>{task.name}</span></button>
  </li>)}</ul>;
  return <section class="chat-mathematics" data-chat-mathematics tabIndex={-1} aria-labelledby="chat-mathematics-heading">
    <h3 id="chat-mathematics-heading">{t('数学进展')}</h3>
    {work.blockers.length > 0 && <div data-chat-math-blockers><h4>{t('当前障碍')}</h4><ul>{work.blockers.map(blocker => <li key={blocker.id}><ChatMessageContent text={blocker.text} /></li>)}</ul></div>}
    {work.working.length > 0 && <div data-chat-math-working><h4>{t('当前目标与候选')}</h4>{tasks(work.working)}</div>}
    {work.checked.length > 0 && <div data-chat-math-checked><h4>{t('已检查的引理与目标（{0}）', work.checked.length)}</h4>
      {tasks(work.checked.slice(0, 3))}{work.checked.length > 3 && <details><summary>{t('查看其余 {0} 项', work.checked.length - 3)}</summary>{tasks(work.checked.slice(3))}</details>}
    </div>}
    {work.latest && <div class="chat-math-finding" data-chat-math-finding><h4>{work.latest.kind === 'finding' ? t('研究记录') : t('题意与目标记录')}</h4>
      <ChatMessageContent text={work.latest.text} />
    </div>}
  </section>;
}

export function ChatMathematicalSummary({ work }: { work: ChatMathematics }) {
  const blocker = work.blockers[0], working = work.working[0], checked = work.checked[0];
  const latest = !blocker && !working && !checked ? work.latest : undefined;
  const statuses = { running: t('正在证明'), delivered: t('候选已提交，等待检查'), conditional: t('候选仍有前提待证明') };
  if (!blocker && !working && !checked && !latest) return null;
  return <section class="chat-mathematics chat-mathematics-summary" data-chat-math-summary tabIndex={-1} aria-labelledby="chat-mathematics-summary-heading">
    <h3 id="chat-mathematics-summary-heading">{t('数学进展')}</h3>
    {blocker && <div data-chat-math-summary-blocker><h4>{t('当前障碍')}</h4><ChatMessageContent text={blocker.text} /></div>}
    {working && <div data-chat-math-summary-working><h4>{t('当前目标与候选')}</h4>
      {working.status && <span class="chat-math-task-status" data-chat-math-summary-status={working.status}>{statuses[working.status]}</span>}
      <ChatMessageContent text={working.statement} />
    </div>}
    {checked && <div data-chat-math-summary-checked={work.checked.length}><h4>{t('已检查的引理与目标（{0}）', work.checked.length)}</h4>
      <ChatMessageContent text={checked.statement} />
    </div>}
    {latest && <div class="chat-math-finding" data-chat-math-summary-latest={latest.kind}><h4>{latest.kind === 'finding' ? t('研究记录') : t('题意与目标记录')}</h4>
      <ChatMessageContent text={latest.text} />
    </div>}
  </section>;
}

function AnswerSection({ section, sections, anchor, source, showStatement = true, showTitle = true, onQuestion }: { section: WebExplanationSection; sections: WebExplanationSection[];
  anchor(name: string): string; source: string; showStatement?: boolean; showTitle?: boolean; onQuestion?(text: string): void }) {
  const content = <>
    {showStatement && section.statement && <div class="chat-answer-statement"><ChatMessageContent text={section.statement} /></div>}
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
  return section.target ? <section id={anchor(section.name)} tabIndex={-1} class="chat-answer-target" data-chat-answer-target={section.name}
    aria-label={section.title || section.name}>
    {showTitle && <h4 translate={false}>{section.title || section.name}</h4>}{content}
  </section> : <details id={anchor(section.name)} tabIndex={-1} class="chat-answer-support"><summary translate={false}>{section.title || section.name}</summary>{content}</details>;
}

export function ChatAnswerActions({ runId, answer, onRetry }: { runId: string; answer?: ChatAnswer; onRetry(): void }) {
  const document = answer?.document, generation = answer?.overview?.generation;
  const status = answer?.explanation?.status, generating = status === 'queued' || status === 'running';
  const stopped = status && ['error', 'exhausted', 'cancelled'].includes(status);
  const unavailable = !document && !generating && !stopped && generation && !generation.available;
  const explanationUrl = `explain.html?${new URLSearchParams({ run: runId, ...(answer?.target ? { target: answer.target } : {}),
    ...(answer?.explanation ? { language: answer.explanation.language } : {}) })}`;
  return <div class="chat-task-actions">
    {(document || generating || !answer?.loading && !answer?.error && generation?.available) && <a class={document || generating ? 'text-button' : 'button button-primary'}
      data-chat-explain href={explanationUrl} target="_blank" rel="noopener">{document ? t('打开完整讲解') : generating ? t('查看讲解进度')
        : stopped ? t('重新生成详细解答') : t('生成详细解答')}</a>}
    {!answer?.error && !unavailable && <button type="button" class="text-button" disabled={answer?.loading} data-chat-answer-refresh onClick={onRetry}>{t('刷新讲解')}</button>}
  </div>;
}

export function ChatMathematicalAnswer({ runId, answer, onRetry, onTarget, onQuestion }: {
  runId: string; answer?: ChatAnswer; onRetry(): void; onTarget(target: string): void; onQuestion?(text: string): void;
}) {
  const document = answer?.document, targets = answer?.overview?.targets ?? [];
  const explanation = answer?.explanation, generation = answer?.overview?.generation;
  const modelRequestFailures = explanationModelRequestFailuresText(explanation?.progress?.modelRequestFailures);
  const generating = explanation?.status === 'queued' || explanation?.status === 'running';
  const stopped = explanation && ['error', 'exhausted', 'cancelled'].includes(explanation.status);
  const phases: Record<WebExplanationPhase, string> = { queued: t('讲解正在排队'), waiting_review: t('等待原题含义审核'), preparing: t('正在准备讲解'),
    extracting: t('正在提取证明结构'), writing: t('正在撰写详细解答'), auditing: t('正在核对讲解与证明'),
    revising: t('正在修订讲解'), retrying: t('正在重试生成讲解'), finishing: t('正在保存讲解') };
  const explanationUrl = `explain.html?${new URLSearchParams({ run: runId, ...(answer?.target ? { target: answer.target } : {}),
    ...(explanation ? { language: explanation.language } : {}) })}`;
  const anchor = (name: string) => `chat-answer-${encodeURIComponent(runId)}-${encodeURIComponent(answer?.target ?? '')}-${encodeURIComponent(name)}`;
  const targetSection = document?.sections.find(section => section.target && section.name === document.target);
  const conclusion = targetSection?.statement.trim() ? targetSection : undefined;
  const repeatedTitle = document && targets.length > 1 && answer?.target === document.target
    && document.sections.filter(section => section.target).length === 1 ? targetSection : undefined;
  return <section class="chat-mathematical-answer" data-chat-answer data-chat-answer-status={document ? 'ready' : answer?.error ? 'read-error'
    : answer?.loading ? 'reading' : explanation?.status ?? (generation?.available ? 'missing' : 'unavailable')}
    aria-labelledby="chat-answer-heading" aria-busy={answer?.loading || generating}>
    <div class="chat-answer-header"><h3 id="chat-answer-heading">{t('详细解答')}</h3>
      {targets.length > 1 && <label class="chat-answer-selection"><span class="sr-only">{t('阅读目标')}</span><select data-chat-answer-select value={answer?.target} onChange={event => onTarget(event.currentTarget.value)}>
        {targets.map(target => <option key={target.name} value={target.name}>{answer?.targetTitles?.[target.name] || target.name}</option>)}
      </select></label>}
    </div>
    {answer?.loading && !document && <p class="chat-answer-state" role="status"><span class="spinner" />{t('正在读取已有讲解…')}</p>}
    {answer?.error && <div class="chat-error" role="alert">{document && <p>{t('刷新失败，下面保留上次读取的解答。')}</p>}<p>{answer.error}</p><button type="button" class="text-button" data-chat-answer-retry onClick={onRetry}>{t('重新读取讲解')}</button></div>}
    {document && <div data-chat-answer-document={document.target}>
      {conclusion && <div class="chat-answer-conclusion" data-chat-answer-conclusion><h4>{t('结论')}</h4><ChatMessageContent text={conclusion.statement} /></div>}
      {document.overview.trim() && <div class="chat-answer-idea" data-chat-answer-idea><h4>{t('证明思路')}</h4><ChatMessageContent text={document.overview} /></div>}
      {document.sections.length > 0 && <div class="chat-answer-derivation" data-chat-answer-derivation><h4>{t('推导过程')}</h4>
        {document.sections.map((section, index) => <AnswerSection key={section.name} section={section} sections={document.sections} anchor={anchor}
          showStatement={section !== conclusion} showTitle={section !== repeatedTitle}
          source={`${new URL(explanationUrl, location.href).href}#explain-section-${index}`} onQuestion={onQuestion} />)}
      </div>}
    </div>}
    {!document && !answer?.loading && !answer?.error && <>
      {generating ? <div class="chat-answer-generation" role="status"><p class="chat-answer-state"><span class="spinner" />{phases[explanation.progress?.phase ?? (explanation.status === 'queued' ? 'queued' : 'writing')]}</p>
        {explanation.queue && <p>{t('前面 {0} 份', explanation.queue.ahead)}</p>}
        {explanation.progress?.batches !== undefined && <p>{t('已通过批次')} {explanation.progress.approvedBatches ?? 0} / {explanation.progress.batches}</p>}
        {modelRequestFailures && <p>{modelRequestFailures}</p>}
        <p>{t('讲解会在后台继续，完成后自动显示。')}</p></div>
        : <>
          {stopped ? <div class="chat-answer-stopped" role="status"><strong>{explanation.status === 'cancelled' ? t('已停止生成')
            : explanation.status === 'exhausted' ? t('讲解没有完成') : t('生成失败')}</strong>
            {explanation.status !== 'cancelled' && <p>{explanationReasonText(explanation.reason)}</p>}
            {modelRequestFailures && <p>{modelRequestFailures}</p>}</div>
            : <p class="chat-math-empty">{t('这份验收证明还没有可阅读的讲解。')}</p>}
          {generation && 'reason' in generation && <p class="chat-math-empty" data-chat-answer-unavailable>{explanationUnavailableText(generation.reason)}</p>}
        </>}
    </>}
    {!document && <ChatAnswerActions runId={runId} answer={answer} onRetry={onRetry} />}
  </section>;
}
