import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { WebConversation, WebConversationMessage, WebConversationSummary } from '../../conversationTypes';
import type { WebFormalization } from '../../formalizationTypes';
import type { WebProvider, WebQuotaView, WebRun } from '../../shared';
import { researchExamples } from '../../problemExamples';
import { formatTokens, isAcceptedRun, isFaultedRun, isRejectedRun, resultDescription, runProgress, stoppedLabel } from '../../presentation';
import { acceptedDescription, acceptedTitle, isStatementReviewed, statementConfirmation } from '../../presentation';
import type { NextStep } from '../../report';
import { locale, localizeText, t } from '../../i18n';
import type { SolveProcess } from '../solveProcess';
import type { ThinkingStep } from '../thinkingProcess';
import { formalizationReasonText, formalizationNextStep } from '../formalizationReasons';
import { Icon } from './Icon';
import { ChatMessageContent } from './ChatMessageContent';
import { Rich, RichProse } from '../richText';
import { Elapsed, SolveProcessView } from './SolveProcess';
import type { PlanApprovalProps } from './RunHeader';
import type { ChatArtifactKind } from '../chatArtifactNavigation';
import { RecoveryChoices, StartGuide } from '../productFlowView';
import { ResearchOverview, type ResearchOverviewProps } from '../researchOverview';
import { DecisionSummary, usePreviousDecisionPlan } from '../decisionSummary';
import { GuidanceOutcome } from '../guidanceOutcome';
import type { ResearchFeedback } from '../../researchProjectTypes';
import type { WebGuidanceRecord } from '../../collaboration';
import { FormalizationProgress, formalizationProgress } from './FormalizationProgress';
import { ThinkingProcess } from './ThinkingProcess';
import { BackgroundReview } from '../backgroundReview';
import { FirstResearchStart } from './FirstResearchStart';
import type { ChatAnswer } from '../chatAnswer';
import type { ChatMathematics } from '../chatMathematics';
import { ChatMathematicalAnswer, ChatMathematicalProgress } from './ChatMathematicalWork';
import type { ResearchStartCostProps } from '../researchStartCost';
import { libraryReferenceId, type ChatLibraryReference } from '../chatReference';
import { ProblemDraftPanel, type ProblemDraftPanelProps } from '../problemDrafts';
import { firstResearchBudgetIssues, type FirstResearchBudgetField, type FirstResearchBudgetIssue } from '../firstResearchBudgetValidation';


export type ChatThreadProps = {
  conversation?: WebConversation;
  run?: WebRun;
  formalization?: WebFormalization;
  sample?: boolean;
  missingTask?: boolean;
  loading: boolean;
  error?: string;
  /** The solving process of the task this thread shows, when it has one. */
  solve?: { process: SolveProcess; loading?: boolean; failed?: boolean; wide: boolean; time: (at: string) => string; onRetry?(): void; onCheck?(id: string): void };
  mathematics?: ChatMathematics;
  answer?: ChatAnswer;
  onAnswerRetry?(): void;
  onAnswerTarget?(target: string): void;
  onAnswerQuestion?(text: string): void;
  onArtifact(kind: ChatArtifactKind, target?: { taskId?: string; messageId?: string }, auto?: boolean): void;
  onShare?(): void;
  recovery?: { steps: NextStep[]; limits?: import('../../shared').WebSession['limits']; onAction(id: string, button: HTMLButtonElement): void };
  onGuidance?(text?: string, taskId?: string): void;
  onQuestion?(entry: ThinkingStep): void;
  onGuidanceReceipt?(message: WebConversationMessage): void;
  guidanceFeedback?: { records: ResearchFeedback[]; loading: boolean; error?: string; onRetry(): void };
  onEditProblem?(): void;
  onCancelTask?(): void;
  onStartResearch?(): void;
  onConfirmStatement?(): void;
  planDecision?: { approval?: PlanApprovalProps; connected: boolean; onReview(): void; onEdit(): void; onApprove(): void };
  startingResearch?: boolean;
  onRetry?(): void;
  onConfigure?(): void;
  onFirstExample?(): void;
  startGuide?: { onTemplate(): void; onLean(): void; ready: boolean };
  overview?: ResearchOverviewProps;
  onSample?(): void;
  onManageRecords?(): void;
};

function StatementDecision(props: ChatThreadProps) {
  const item = props.formalization, report = item?.report;
  if (!item?.humanReview || !report || props.run || !['review', 'confirmed'].includes(item.status)) return null;
  return <section class="chat-decision" data-chat-statement-decision aria-labelledby="chat-statement-decision-heading">
    <header><Icon name="languages" /><h3 id="chat-statement-decision-heading">{item.status === 'review' ? t('先确认：这是不是你要证明的题目？') : t('题意已由你确认')}</h3></header>
    <div class="chat-decision-mathematics" translate={false}><ChatMessageContent text={report.backtranslation?.mathematics ?? report.original} /></div>
    {!!report.backtranslation?.assumptions.length && <ul class="chat-decision-assumptions">{report.backtranslation.assumptions.map((assumption, index) => <li key={index} translate={false}><Rich text={assumption} /></li>)}</ul>}
    <p class="chat-decision-next">{t('确认后，2 个 Agent 会拟定研究计划，等你批准再展开证明。')}</p>
    <div class="chat-task-actions">
      <button type="button" class="button" data-research-artifact="original" onClick={() => props.onArtifact('original')}><Icon name="languages" />{t('核对原题与 Lean')}</button>
      {props.onEditProblem && <button type="button" class="text-button" disabled={props.startingResearch} onClick={props.onEditProblem}>{t('修改题目')}</button>}
      <button type="button" class="button button-primary" data-chat-confirm-statement disabled={props.startingResearch}
        onClick={item.status === 'review' ? props.onConfirmStatement : props.onStartResearch}>
        {props.startingResearch ? t('正在拟定计划…') : item.status === 'review' ? t('题意正确，拟定计划') : t('继续拟定研究计划')}</button>
    </div>
  </section>;
}

function PlanDecision(props: ChatThreadProps) {
  const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
  const run = props.run, decision = props.planDecision;
  const previousPlan = usePreviousDecisionPlan(run?.observation?.plan, run?.id ?? '');
  if (!run || !decision) return null;
  const plan = run.observation?.plan, approval = decision.approval;
  const approved = run.observation?.inspection.planApproval?.status === 'approved';
  return <section class="chat-decision" data-chat-plan-decision data-waiting={Boolean(approval)} aria-labelledby="chat-plan-decision-heading">
    <header><Icon name="git-branch" /><h3 id="chat-plan-decision-heading">{approval ? approval.revising ? t('正在按你的意见修改计划') : t('研究计划，等你决定')
      : !plan && run.planApproval ? t('正在拟定研究计划') : t('你可以调整这次研究')}</h3></header>
    <p class="chat-decision-next">{approval ? approval.revising ? t('正在按你的指导修改计划，修改期间计入执行预算。完成后等你确认。')
      : t('先核对任务与依赖。等待确认不计入证明预算，批准后继续本次研究。')
      : approved ? t('初始计划已由你批准。后续仍可修改任务、依赖和研究方向。')
        : run.planApproval && !plan ? t('计划拟好后会停下来，等你确认。') : t('修改任务会更新研究计划；指导意见会发送给研究组。')}</p>
    {plan && <DecisionSummary plan={plan} previousPlan={previousPlan} expectedVersion={approval ? run.observation?.inspection.planApproval?.planVersion : undefined}
      onOpenTask={id => props.onArtifact('roadmap', { taskId: id })} />}
    {approval?.error && <p class="chat-error" role="alert">{approval.error}</p>}
    {approval?.original && <div class="chat-send-status" data-chat-original-plan-approval={approval.original.id}>
      <p>{tx('原批准版本：', 'Original approval version: ')}<code translate={false}>{approval.original.planVersion}</code></p>
      {approval.original.planVersion !== run.observation?.inspection.planApproval?.planVersion && <p>{tx('当前计划已有变化，先核对原决定；这不会批准新版本。', 'The current plan has changed. Check the original decision first; this does not approve the new version.')}</p>}
      {approval.original.status && <p>{tx('原提交回执：', 'Original receipt: ')}{approval.original.status}</p>}
    </div>}
    <div class="chat-task-actions">
      {plan && <>
        <button type="button" class="button" data-chat-review-plan data-research-artifact="plan" onClick={decision.onReview}><Icon name="network" />{t('查看全部 {0} 项任务', plan.tasks.length)}</button>
        <button type="button" class="button" data-chat-edit-plan disabled={!decision.connected || approval?.busy || approval?.revising} onClick={decision.onEdit}><Icon name="square-pen" />{t('修改任务与依赖')}</button>
      </>}
      {props.onGuidance && <button type="button" class="text-button" data-research-guidance onClick={() => props.onGuidance?.()}>{t('调整研究方向')}</button>}
      {approval && <button type="button" class="button button-primary" data-chat-approve-plan disabled={!decision.connected || approval.busy || approval.revising || approval.reviewable === false || !plan} onClick={decision.onApprove}>
        {approval.original ? tx('原批准待核对', 'Original approval awaiting confirmation') : approval.onReviewCurrent ? tx('先重新核对计划', 'Review the current plan first') : approval.busy ? t('正在批准') : approval.revising ? t('等待修改完成') : t('批准计划，开始证明')}</button>}
      {approval?.onCheck && <button type="button" class="button" data-chat-check-plan-approval disabled={!decision.connected || approval.checking} onClick={approval.onCheck}>
        {approval.checking ? tx('正在核对…', 'Checking…') : approval.original ? tx('核对并重试原提交', 'Check and retry the original submission') : tx('重新读取批准记录', 'Reload approval record')}</button>}
      {approval?.onReviewCurrent && <button type="button" class="button" data-chat-review-current-plan disabled={!decision.connected || approval.checking || approval.revising || !plan} onClick={approval.onReviewCurrent}>
        {tx('已重新核对当前计划', 'I reviewed the current plan again')}</button>}
    </div>
  </section>;
}

/** Where a formalization stopped, why, what was kept and what the reader can do; the code is the diagnostic. */
function FormalizationFailure({ item }: { item: WebFormalization }) {
  const code = item.researchError || item.reason!;
  const phases: Record<string, string> = { queued: t("等待开始"), preparing: t("准备证明环境"), planning: t("理解题目与定义"),
    generating: t("生成 Lean 陈述"), compiling: t("检查 Lean 陈述"), translating: t("核对自然语言与 Lean"),
    reviewing: t("审核原题一致性"), finishing: t("整理形式化结果") };
  const stage = item.researchError ? t('启动证明研究') : phases[item.progress?.phase ?? ''] ?? t('形式化');
  const kept = item.report || item.compiled ? t('已保存这次生成的 Lean 陈述与检查记录，可在“原题 / Lean”中查看。') : t('没有保存可用的 Lean 陈述。');
  return <details class="chat-task-details" data-formalization-failure open>
    <summary>{t("查看详情")}</summary>
    <dl>
      <dt>{t('停止阶段')}</dt><dd>{stage}</dd>
      <dt>{t('原因')}</dt><dd>{formalizationReasonText(code)}</dd>
      <dt>{t('保留成果')}</dt><dd>{kept}</dd>
      <dt>{t('下一步')}</dt><dd>{formalizationNextStep(code)}</dd>
      <dt>{t('错误代码')}</dt><dd><code>{code}</code></dd>
    </dl>
  </details>;
}

function TaskMessage(props: ChatThreadProps) {
  const { run, formalization: item } = props;
  const proofActive = !!run && ['queued', 'running'].includes(run.status);
  const reviewActive = !!item && ['queued', 'running'].includes(item.status);
  const active = proofActive || reviewActive;
  const accepted = !!run && isAcceptedRun(run);
  const reviewed = !!run && isStatementReviewed(run);
  const natural = !!(item || run?.formalization);
  const statementDecision = !run && !!item?.humanReview && !!item.report && ['review', 'confirmed'].includes(item.status);
  const confirmation = run?.formalization?.confirmation ?? item?.confirmation ?? (item?.compiled && reviewActive ? 'pending' : undefined);
  const reviewMode = item?.reviewMode ?? run?.formalization?.reviewMode;
  const direct = reviewMode === 'direct' || item?.report?.semanticReview === 'not-performed';
  const formalProgress = item && formalizationProgress(item, props.solve?.process);
  const backgroundReview = item?.backgroundReview ?? item?.report?.backgroundReview;
  const failed = run ? isFaultedRun(run) || isRejectedRun(run) : !!item && (['error', 'exhausted'].includes(item.status) || !!item.researchError);
  const phaseNames: Record<string, string> = {
    queued: t("等待开始"), preparing: t("准备证明环境"),
    planning: t("理解题目与定义"), generating: t("生成 Lean 陈述"),
    compiling: t("检查 Lean 陈述"), translating: t("核对自然语言与 Lean"),
    reviewing: t("审核原题一致性"), finishing: t("整理形式化结果"),
  };
  const title = run ? accepted ? acceptedTitle(run) : proofActive ? runProgress(run).phaseLabel
    : reviewActive ? phaseNames[item?.progress?.phase ?? 'queued']
    : run.status === 'cancelled' ? t('已取消') : failed ? t('运行失败') : stoppedLabel(run)
    : failed ? t("形式化未完成") : item?.status === 'cancelled' ? t('已取消')
      : active ? formalProgress?.revising ? t('根据 Lean 报错修改陈述') : phaseNames[item?.progress?.phase ?? 'queued']
        : item?.status === 'review' ? direct ? t('Lean 代码已就绪') : t("陈述待核对")
          : item?.status === 'confirmed' ? direct ? t('Lean 代码已就绪') : t("陈述已确认") : props.missingTask ? t('关联任务记录已删除') : t("正在读取任务");
  const description = props.missingTask ? t('原题和对话仍保留，可以修改题目后重新发送。') : run ? accepted ? acceptedDescription(run) : resultDescription(run) : failed
    ? item?.researchError ? t("Lean 陈述已生成，但证明研究未能启动。")
      : t("本次未能完成原题形式化，请查看详情中的原因和下一步。")
    : item?.status === 'cancelled' ? t("任务已停止，已保存的消息仍可查看。")
      : active && item?.compiled ? t('Lean 陈述已编译，可以查看和下载；原题含义正在后台审核。')
        : formalProgress?.description ?? t("陈述检查不代表证明通过，最终结果以 Lean 独立验收为准。");
  const proof = run?.result?.proof || run?.artifact?.source;
  const solve = props.solve;
  const hasSource = solve?.process.current !== undefined || solve?.process.checks.some(check => check.source !== undefined);
  const liveAvailable = Boolean(solve && (solve.process.active || hasSource));
  const resultActions = run && !proofActive && <>
    {accepted && <button type="button" class="text-button" data-research-artifact="roadmap" onClick={() => props.onArtifact('roadmap')}><Icon name="network" />{t('路线图')}</button>}
    <button type="button" class="button" data-research-artifact="result" onClick={() => props.onArtifact('result')}>
      <Icon name="shield-check" />{accepted ? t('查看验收报告') : t('查看原因与报告')}</button>
    {accepted && <>
      <a class="button" data-chat-download-kit href={`/api/runs/${encodeURIComponent(run.id)}/verification-kit`} download>{t('下载本地复核包')}</a>
      {reviewed && props.onShare && <button type="button" class="button" data-chat-share onClick={props.onShare}><Icon name="share-2" />{t('分享研究成果')}</button>}
      {!props.sample && <a class="button" data-save-library href={`library.html?${new URLSearchParams({ create: '1', fromRun: run.id })}`}>{t('保存到我的 Library')}</a>}
    </>}
    <a class="text-button" href={`/api/runs/${encodeURIComponent(run.id)}/download`} download>{t('下载完整研究归档')}</a>
    {accepted && props.onEditProblem && <button type="button" class="text-button" onClick={props.onEditProblem}>{t('修改题目')}</button>}
  </>;
  return <div class="chat-task">
    {props.sample && <p class="sample-note" data-chat-sample-note>{t('预设示例 · 附 Lean 验收记录')}</p>}
    <div class="research-conversation-status" data-active={active} data-accepted={accepted} data-failed={failed}>
      <p class="research-conversation-state" role="status" aria-atomic="true">
        <Icon name={accepted ? 'circle-check' : failed ? 'circle-alert' : active ? 'clock-3' : !run && formalProgress?.ready ? 'file-code-2' : 'square'} /><strong>{title}</strong></p>
      {solve && <p class="research-conversation-meta">
        {solve.process.startedAt && <Elapsed from={solve.process.startedAt} to={solve.process.endedAt} />}
        {solve.process.tokens !== undefined && <span>{t('Token {0}', formatTokens(solve.process.tokens))}</span>}
        {liveAvailable && <button type="button" class="text-button" data-research-artifact="live" onClick={() => props.onArtifact('live')}>
          <Icon name="file-code-2" />{hasSource ? t('查看当前代码') : t('实时工作区')}</button>}
        {active && props.onCancelTask && <button type="button" class="text-button" data-research-stop onClick={props.onCancelTask}>{t("停止解题")}</button>}
      </p>}
      {(!statementDecision || failed) && <p class="research-conversation-description">{description}</p>}
      {!run && item?.status === 'queued' && item.queue && <p class="research-conversation-latest" data-formalization-queue>{t('排队第 {0} 位 · 前方 {1} 项等待 · {2} 项执行中', item.queue.position, item.queue.ahead, item.queue.running)}</p>}
      {solve && <div class="chat-outcome-summary" data-chat-outcomes>
        <p><span>{t('已有成果')}</span><strong>{solve.process.current?.kind === 'proof' ? t('已验收证明') : solve.process.current?.kind === 'candidate' ? t('证明候选，可查看和下载') : hasSource ? t('Lean 陈述，可查看和下载') : t('正在准备，尚无代码')}</strong></p>
        <p><span>{t('当前进展')}</span><strong>{title}</strong></p>
        <p><span>{t('需要你做')}</span><strong>{statementDecision ? item?.status === 'review' ? t('核对题意并确认继续') : t('继续拟定研究计划') : props.planDecision?.approval && !props.planDecision.approval.busy && !props.planDecision.approval.revising ? t('查看并确认研究计划') : failed ? t('查看失败原因后选择继续方式') : active ? t('无需操作，可以继续浏览已有成果') : t('可阅读结果或继续提问')}</strong></p>
      </div>}
      {item && <FormalizationProgress item={item} process={solve?.process} wide={solve?.wide}
        onCode={() => props.onArtifact('live')} />}
      {item?.compiled && reviewActive && <p class="chat-statement-verdict" data-chat-background-review role="status">
        {accepted ? t('候选 Lean 陈述已证明，原题含义仍在后台审核。') : proofActive ? t('证明与原题含义审核同时进行，已有代码可以立即使用。')
          : t('Lean 陈述已编译，可以查看和下载；原题含义正在后台审核。')}
      </p>}
      {!statementDecision && natural && (item?.report || item?.compiled || run?.formalization) && <p class="chat-statement-verdict" data-statement-verdict>
        {direct && (!confirmation || ['automatic', 'manual'].includes(confirmation)) ? t('Lean 编译通过') : statementConfirmation(confirmation, false, reviewMode)}
        {' '}{t('Lean 验收证明的是这份陈述，不能替代对自然语言原意的核对。')}
      </p>}
    </div>
    {solve && <ThinkingProcess process={solve.process} time={solve.time} onCheck={solve.onCheck} onQuestion={props.onQuestion} />}
    {backgroundReview && <BackgroundReview review={backgroundReview} compact />}
    <StatementDecision {...props} />
    <PlanDecision {...props} />
    {accepted && reviewed && run && <ChatMathematicalAnswer runId={run.id} answer={props.answer} onRetry={() => props.onAnswerRetry?.()} onTarget={target => props.onAnswerTarget?.(target)} onQuestion={props.onAnswerQuestion} />}
    {!accepted && props.mathematics && <ChatMathematicalProgress work={props.mathematics} onTask={taskId => props.onArtifact('roadmap', { taskId })} />}
    {solve && <SolveProcessView process={solve.process} wide={solve.wide} time={solve.time} onCheck={solve.onCheck}
      loading={solve.loading} failed={solve.failed} onRetry={solve.onRetry} />}
    {item && (['error', 'exhausted'].includes(item.status) || item.researchError) && (item.reason || item.researchError) && <FormalizationFailure item={item} />}
    {!statementDecision && (run || item?.report || item?.compiled) && <div class="research-conversation-artifacts" role="group" aria-label={t('结果')}>
      {accepted && <button type="button" class="chat-result-primary" data-research-artifact="source" disabled={!proof} onClick={() => props.onArtifact('source')}><Icon name="file-code-2" /><span>{t('查看验收证明')}</span><Icon name="arrow-up-right" /></button>}
      {run && !accepted && <button type="button" data-research-artifact="roadmap" onClick={() => props.onArtifact('roadmap')}><Icon name="network" /><span>{t('路线图')}</span><Icon name="arrow-up-right" /></button>}
      <button type="button" data-research-artifact="original" onClick={() => props.onArtifact('original')}><Icon name="languages" /><span>{t('原题')} / Lean</span><Icon name="arrow-up-right" /></button>
      {run && !accepted && <button type="button" data-research-artifact="source" disabled={!proof} onClick={() => props.onArtifact('source')}><Icon name="file-code-2" /><span>{t('候选源码')}</span><Icon name="arrow-up-right" /></button>}
    </div>}
    <div class="chat-task-actions">
      {accepted ? <details class="chat-result-more" data-chat-result-more><summary>{t('更多结果操作')}</summary><div class="chat-result-more-actions">{resultActions}</div></details> : resultActions}
      {props.onStartResearch && !item?.humanReview && <button type="button" class="button button-primary" data-research-continue disabled={props.startingResearch} onClick={props.onStartResearch}>
        {props.startingResearch ? t('正在进入证明队列…') : t('继续证明')}</button>}
      {active && run && props.onGuidance && !props.planDecision && <button type="button" class="text-button" data-research-guidance onClick={() => props.onGuidance?.()}>{t('调整研究方向')}</button>}
      {!accepted && !active && !statementDecision && props.onEditProblem && <button type="button" class="text-button" onClick={props.onEditProblem}>{t("修改题目")}</button>}
    </div>
    {run && props.recovery && <RecoveryChoices run={run} {...props.recovery} />}
  </div>;
}

function MessageTaskLinks({ message, ...props }: ChatThreadProps & { message: WebConversationMessage }) {
  const tasks = props.run?.observation?.inspection.tasks.filter(task => task.theorem && message.text.includes(task.theorem) || message.guidance?.input.taskRef?.id === task.id) ?? [];
  return tasks.length > 0 ? <div class="chat-task-links" aria-label={t('相关引理与任务')}>{tasks.map(task => <button type="button" class="text-button" data-chat-task-link={task.id}
    onClick={() => props.onArtifact('roadmap', { taskId: task.id, messageId: message.id })}><Icon name="network" />{task.theorem || task.objective || task.id}</button>)}</div> : null;
}

function GuidanceReceipt({ message, onGuidanceReceipt, feedback, record, onOpenRunTask }: { message: WebConversationMessage; onGuidanceReceipt?: ChatThreadProps['onGuidanceReceipt']; feedback?: ChatThreadProps['guidanceFeedback']; record?: WebGuidanceRecord; onOpenRunTask?:(task:{ id:string; version:string })=>void }) {
  const guidance = message.guidance!;
  const labels: Record<string, string> = { queued: t('排队中'), deferred: t('暂缓'), delivered: t('已送达'), failed: t('失败'), rejected: t('已拒绝'), unknown: t('结果尚未确认') };
  const receipt = guidance.receipt;
  return <div class="chat-guidance-receipt" data-chat-guidance-receipt={guidance.input.id} data-guidance-status={receipt?.status ?? 'pending'} role="status">
    <p><strong>{t('研究指导')}</strong> · {guidance.input.recipient.kind === 'lead' ? t('证明任务负责人') : guidance.input.recipient.id} · {receipt ? labels[receipt.status] ?? receipt.status : t('正在核对回执…')}</p>
    {receipt?.reason && <p>{localizeText(receipt.reason)}</p>}
    {(!receipt || receipt.status === 'unknown') && onGuidanceReceipt && <button class="text-button" type="button" data-chat-guidance-recover onClick={() => onGuidanceReceipt(message)}>{t('核对并重试原提交')}</button>}
    <GuidanceOutcome guidance={record} onOpenRunTask={onOpenRunTask} feedback={feedback?.records.find(item => item.target?.runId === guidance.runId && (item.id === guidance.input.id || item.requestId === guidance.input.id))} />
    {feedback?.error && <details><summary>{t('后续记录读取失败')}</summary><p role="alert">{feedback.error} <button type="button" class="text-button" onClick={feedback.onRetry}>{t('重新读取')}</button></p></details>}
  </div>;
}

function ChatThread(props: ChatThreadProps) {
  const { conversation, loading, error } = props;
  const errorNotice = error && <div id="formalize-error" class="chat-error" role="alert"><p>{error}</p>
    {props.onRetry && <button type="button" class="text-button" onClick={props.onRetry}>{t("重试")}</button>}
    {props.onManageRecords && <button type="button" class="text-button" data-chat-error-records onClick={props.onManageRecords}>{t('管理题目记录')}</button>}</div>;
  if (!conversation && (props.run || props.formalization)) {
    const original = props.formalization?.original ?? props.run?.formalization?.original;
    return <div class="chat-messages" data-research-conversation={props.run?.id}>
      <article class="chat-message chat-message-user" aria-label={t("你")}>
        {original !== undefined ? <div class="chat-message-text" translate={false}>{original}</div>
          : <pre class="research-conversation-lean" tabIndex={0} aria-label={t('Lean 源码')} translate={false}><code>{props.run?.source}</code></pre>}
      </article>
      <article class="chat-message chat-message-assistant" aria-label="TheoremOS">
        <div class="research-conversation-byline"><img src="assets/mark.svg" alt="" width={24} height={24} /><span>TheoremOS</span></div>
        <TaskMessage {...props} />
      </article>
      {errorNotice}
    </div>;
  }
  if (!conversation) return <div class="chat-start">
    {loading ? <p role="status">{t("正在读取对话…")}</p> : <>
      <h1>{t("今天想证明什么？")}</h1>
      <p>{t('用自然语言或 TeX 写下题目。')}</p>
    </>}
    {errorNotice}
  </div>;
  return <div class="chat-messages" data-conversation={conversation.id}>
    {conversation.messages.map(message => <article key={message.id} class={`chat-message chat-message-${message.role}`}
      data-message-id={message.id} data-message-status={message.status} aria-label={message.role === 'user' ? t("你") : 'TheoremOS'}>
      {message.role === 'assistant' && <div class="research-conversation-byline"><img src="assets/mark.svg" alt="" width={24} height={24} /><span>TheoremOS</span></div>}
      {message.kind === 'task' ? <TaskMessage {...props} /> : <>
        {message.text && <ChatMessageContent text={message.text} />}
        {message.kind === 'guidance' && message.guidance && <GuidanceReceipt message={message} onGuidanceReceipt={props.onGuidanceReceipt} feedback={props.guidanceFeedback}
          record={props.run?.observation?.guidance.find(record => record.id === message.guidance!.input.id)}
          {...(props.run?.observation?.guidance.find(record => record.id === message.guidance!.input.id)?.decision?.evidenceRefs.every(ref => ref.kind !== 'task' || props.run!.observation!.inspection.tasks.some(task => task.id === ref.id && task.version === ref.version))
            ? { onOpenRunTask: (task:{id:string;version:string}) => props.onArtifact('roadmap', { taskId: task.id, messageId: message.id }) } : {})} />}
        <MessageTaskLinks {...props} message={message} />
        {message.kind === 'text' && message.status === 'pending' && <p class="chat-answer-state" role="status"><span class="spinner" />{message.text ? t('正在回答…') : t("正在思考…")}</p>}
        {message.status === 'interrupted' && <p class="chat-answer-state">{t("已停止回答")}</p>}
        {message.kind === 'text' && message.status === 'error' && <div class="chat-error" role="alert"><p>{localizeText(message.error || t("回答未完成，请重试。"))}</p>
          {props.onRetry && conversation.messages.at(-1)?.id === message.id && <button class="text-button" type="button" onClick={props.onRetry}>{t("重新回答")}</button>}</div>}
        {message.truncated && <p class="chat-answer-state">{t("回答已达到长度上限，可继续追问。")}</p>}
        {message.kind === 'text' && message.role === 'user' && message.id !== conversation.messages[0]?.id && props.onGuidance
          && <button type="button" class="text-button chat-message-action" data-chat-use-guidance onClick={() => props.onGuidance?.(message.text)}>{t('转为研究指导')}</button>}
      </>}
    </article>)}
    {errorNotice}
  </div>;
}

export type ChatBudgets = { maxRunSeconds: number; maxTotalTokens: number; research: { maxRunSeconds: number; maxTotalTokens: number; maxTurns: number } };
export type ChatProvider = WebProvider & { defaultModel: string; key: 'required' | 'saved' | 'server'; keyUrl?: string };
export type ChatComposerProps = {
  home?: Pick<ChatThreadProps, 'overview' | 'startGuide' | 'onConfigure' | 'onFirstExample' | 'onSample'>;
  originalRecovery?(): void;
  problemDrafts?: ProblemDraftPanelProps;
  draftPersistence?: { retry(): void; download(): void };
  input: string; onInput(value: string): void; onSubmit(): void; onStop(): void;
  references?: ChatLibraryReference[]; onRemoveReference?(id: string): void;
  editedProblem?: { research?: boolean; onReturnHome(): void };
  pending: boolean; submitting: boolean; disabled: boolean; hasConversation: boolean; newProblem: boolean; sendStatus?: string;
  environment: 'standard' | 'mathlib'; effort: 'low' | 'high' | 'max'; apiKey: string;
  onEnvironment(value: 'standard' | 'mathlib'): void; onEffort(value: 'low' | 'high' | 'max'): void; onKey(value: string): void;
  keyRequired: boolean; onExample(id: string): void; onLean(): void;
  providers: ChatProvider[]; providerId: string; model: string;
  onProvider(value: string): void; onModel(value: string): void;
  budgets: ChatBudgets; budgetLimits: ChatBudgets; onBudget(stage: 'formalization' | 'research', field: 'maxRunSeconds' | 'maxTotalTokens' | 'maxTurns', value: number): void;
  quota?: WebQuotaView;
  cost?: Pick<ResearchStartCostProps, 'owner' | 'account' | 'request'>;
  checkingConnection: boolean; connection?: { status: 'available' | 'unknown' | 'error'; message: string }; onCheckConnection(): void;
  keyManagement?: { busy: boolean; ending?: string; notice?: string; onSave(): void; onDelete(): void };
  onGuidance?(): void;
  participation: 'guided' | 'automatic'; onParticipation(value: 'guided' | 'automatic'): void; participationLocked: boolean;
  submissionRecovery?: { busy: boolean; onRecover(): void; onPrepareEdited(): void };
  guidance?: { target: string; targets: { id: string; label: string }[]; onTarget(id: string): void; onCancel(): void; onConfirmTarget?(): void };
  quote?: { count: number; onUndo(): void };
};

function ChatComposer(props: ChatComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [setupStep, setSetupStep] = useState(1);
  const settings = useRef<HTMLDetailsElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState(false);
  const composing = useRef(false);
  const missingKey = props.keyRequired && !props.apiKey.trim();
  const configureKey = () => {
    setSetupStep(2);
    if (settings.current) settings.current.open = true;
    keyInput.current?.focus();
  };
  const provider = props.providers.find(item => item.id === props.providerId);
  const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
  const configure = (step: number, selector: string) => {
    setSetupStep(step);
    const settings = document.querySelector<HTMLDetailsElement>('#formalize-settings');
    if (settings) { settings.open = true; settings.querySelector<HTMLElement>(selector)?.focus(); }
  };
  const configuration = !props.model.trim() || props.keyRequired && !props.apiKey.trim() ? tx('待配置', 'Setup needed')
    : props.checkingConnection ? tx('正在检查', 'Checking') : props.connection?.status === 'available' ? tx('模型列表可访问', 'Model list accessible')
      : props.connection?.status === 'error' ? tx('连接需处理', 'Connection needs attention')
        : props.connection?.status === 'unknown' ? tx('仍需核对', 'Needs confirmation') : tx('已填写，待检查', 'Filled in, not checked');
  const budgetIssues = firstResearchBudgetIssues(props.budgets, props.budgetLimits), validBudget = budgetIssues.length === 0;
  const budgetLabel = (field: FirstResearchBudgetField) => ({
    'formalize-minutes': tx('形式化时间', 'Statement time'), 'formalize-tokens': tx('形式化 Token 上限', 'Statement token limit'),
    'research-minutes': tx('证明时间', 'Proof time'), 'research-tokens': tx('证明 Token 上限', 'Proof token limit'),
    'research-turns': tx('研究轮次', 'Research turns'),
  })[field];
  const budgetIssueText = ({ kind, maximum }: FirstResearchBudgetIssue) => {
    const upper = (kind === 'minutes' ? Math.floor(maximum / 60) : maximum).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN');
    if (kind === 'tokens') return maximum > 0
      ? tx(`请填写 10,000 至 ${upper} 的整数，或留空表示不限。`, `Enter a whole number from 10,000 to ${upper}, or leave blank for unlimited.`)
      : tx('请填写至少 10,000 的整数，或留空表示不限。', 'Enter a whole number of at least 10,000, or leave blank for unlimited.');
    return maximum > 0
      ? tx(`请填写 1 至 ${upper} 的整数，或留空表示不限。`, `Enter a whole number from 1 to ${upper}, or leave blank for unlimited.`)
      : tx('请填写正整数，或留空表示不限。', 'Enter a positive whole number, or leave blank for unlimited.');
  };
  const budgetFieldProps = (field: FirstResearchBudgetField) => ({
    'aria-invalid': budgetIssues.some(issue => issue.field === field) || undefined,
    'aria-describedby': budgetIssues.some(issue => issue.field === field) ? `${field}-error` : undefined,
  });
  const budgetFieldError = (field: FirstResearchBudgetField) => {
    const issue = budgetIssues.find(issue => issue.field === field);
    return issue && <span class="field-validation" id={`${field}-error`} data-chat-budget-field-error={field}>{budgetIssueText(issue)}</span>;
  };
  const focusBudget = (field: FirstResearchBudgetField) => {
    if (settings.current) {
      settings.current.open = true;
      const advanced = settings.current.querySelector<HTMLDetailsElement>('[data-chat-advanced-settings]');
      if (advanced) advanced.open = true;
      settings.current.querySelector<HTMLInputElement>(`#${field}`)?.focus();
    }
  };
  const canSend = !!props.input.trim() && !!props.model.trim() && (props.hasConversation || !!provider && validBudget)
    && !props.pending && !props.submitting && !props.disabled && (!props.keyRequired || !!props.apiKey.trim());
  useLayoutEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(Math.max(node.scrollHeight, 92), 260)}px`;
  }, [props.input]);
  return <div class="chat-composer">
    <form id="formalize-form" onSubmit={event => { event.preventDefault(); if (canSend) props.onSubmit(); }}>
      {props.editedProblem && <div class="chat-editing-problem" data-chat-editing-problem><span>{props.editedProblem.research ? t('独立研究草稿 · 单独保存') : t('正在修改题目 · 草稿单独保存')}</span>
        <button type="button" class="text-button" data-chat-return-home disabled={props.submitting} onClick={props.editedProblem.onReturnHome}>{t('返回首页草稿')}</button></div>}
      {Boolean(props.references?.length) && <div class="chat-reference-list" role="group" aria-label={t('数学库参考')}>
        {props.references!.map(reference => <article class="chat-library-reference" key={libraryReferenceId(reference)} data-chat-library-reference={reference.declaration}>
          <div class="chat-library-reference-heading"><strong translate={false}>{reference.declaration.split('.').at(-1)}</strong>
            <button type="button" class="text-button" data-chat-remove-reference disabled={props.submitting}
              aria-label={t('移除参考：{0}', reference.declaration)} onClick={() => props.onRemoveReference?.(libraryReferenceId(reference))}><Icon name="x" /></button></div>
          <p>{reference.summary[locale]}</p>
          <p class="chat-reference-expression" translate={false}>{reference.expression}</p>
          <div class="chat-library-reference-tools"><a data-chat-reference-source href={reference.source}>{t('查看来源')}</a>
            <details data-chat-reference-details><summary>{t('条件与完整 Lean 类型')}</summary>
              <p class="chat-reference-context">{t('模块作用域可能包含未使用变量；实际隐式参数可用 #check @ 查看。')}</p>
              {reference.conditions.length > 0 && <ul>{reference.conditions.map((condition, index) => <li key={index}><span>{condition.meaning[locale]}</span><code>{condition.expression}</code></li>)}</ul>}
              <pre>{[reference.import, `#check @${reference.declaration}`, ...reference.context, reference.type].join('\n\n')}</pre>
            </details></div>
        </article>)}
      </div>}
      {props.hasConversation && props.onGuidance && <div class="chat-message-destination" role="group" aria-label={t('消息用途')}>
        <button type="button" data-chat-discussion-mode aria-pressed={!props.guidance} disabled={props.submitting} onClick={() => props.guidance?.onCancel()}>{t('讨论思路')}</button>
        <button type="button" data-chat-guidance-mode-open aria-pressed={Boolean(props.guidance)} disabled={props.submitting} onClick={props.onGuidance}>{t('指导研究')}</button>
      </div>}
      {props.guidance && <div class="chat-guidance-target" data-chat-guidance-mode>
        <label>{t('发送研究指导至')}<select data-chat-guidance-target value={props.guidance.target} disabled={props.submitting} onChange={event => props.guidance!.onTarget(event.currentTarget.value)}>
          <option value="">{t('证明任务负责人')}</option>{props.guidance.targets.map(target => <option value={target.id}>{target.label}</option>)}
        </select></label>
        {props.guidance.onConfirmTarget && <button type="button" class="text-button" onClick={props.guidance.onConfirmTarget}>{t('确认当前任务版本')}</button>}
        <button type="button" class="text-button" data-chat-guidance-cancel disabled={props.submitting} onClick={props.guidance.onCancel}>{t('返回讨论')}</button>
      </div>}
      {props.quote && <div class="chat-quote-notice" data-chat-quote>
        <span role="status" data-chat-quote-count={props.quote.count}>{t('已引用 {0} 条记录', props.quote.count)}</span>
        <button type="button" class="text-button" data-chat-quote-undo disabled={props.submitting} onClick={props.quote.onUndo}>{t('撤回上次引用')}</button>
      </div>}
      {props.newProblem && <div class="chat-input-view" role="group" aria-label={tx('原题输入视图', 'Problem input view')}>
        <button type="button" class="text-button" data-input-view="edit" aria-pressed={!preview} onClick={() => { setPreview(false); requestAnimationFrame(() => textarea.current?.focus()); }}>{tx('编辑', 'Edit')}</button>
        <button type="button" class="text-button" data-input-view="preview" aria-pressed={preview} onClick={() => setPreview(true)}>{tx('预览公式', 'Preview formulas')}</button>
      </div>}
      <label class="sr-only" for="formalize-original">{props.hasConversation ? t("继续对话") : t("自然语言或 TeX 原题")}</label>
      <textarea ref={textarea} id="formalize-original" rows={3} value={props.input} spellcheck={false}
        hidden={props.newProblem && preview}
        placeholder={props.guidance ? t('建议证明方法，或指出需要调整的引理…') : props.hasConversation ? t("追问思路、引理或证明细节…") : t("输入你想证明的题目…")}
        onInput={event => props.onInput(event.currentTarget.value)}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || composing.current || event.keyCode === 229 || matchMedia('(pointer: coarse)').matches) return;
          if (props.newProblem ? !event.ctrlKey && !event.metaKey : event.ctrlKey || event.metaKey) return;
          event.preventDefault(); if (canSend) props.onSubmit(); else if (missingKey && props.input.trim() && !props.disabled && !props.submitting) configureKey();
        }} />
      {props.newProblem && <p class="chat-send-status" data-new-problem-shortcut>{tx('Enter 换行；Ctrl / ⌘ + Enter 提交题目。', 'Enter adds a line; Ctrl / ⌘ + Enter submits the problem.')}</p>}
      {props.draftPersistence && <div class="chat-error" role="alert" data-chat-draft-save-error>
        <p>{tx('草稿尚未保存，刷新或关闭页面会丢失当前输入。请先下载原题，或重试保存。', 'Your draft has not been saved. Reloading or closing this page will lose your input. Download the problem or retry saving first.')}</p>
        <button type="button" class="text-button" data-retry-chat-draft onClick={props.draftPersistence.retry}>{tx('重试保存', 'Retry saving')}</button>{' '}
        <button type="button" class="text-button" data-download-chat-draft onClick={props.draftPersistence.download}>{tx('下载原题', 'Download problem')}</button>
      </div>}
      {props.originalRecovery && <div class="chat-send-status" data-original-recovery role="status"><span>{tx('上一份原题与配置已保留。', 'Your previous problem and settings are kept.')} </span>
        <button type="button" class="text-button" data-recover-original disabled={props.submitting} onClick={props.originalRecovery}>{tx('恢复上一份原题', 'Restore previous problem')}</button></div>}
      {props.newProblem && preview && <section class="chat-input-preview" data-input-preview tabIndex={0} aria-label={tx('原题公式预览', 'Problem formula preview')}>
        {props.input.trim() ? <RichProse text={props.input} /> : <p>{tx('先在编辑中写下原题，这里会预览文字和公式。', 'Write a problem in Edit to preview its text and formulas here.')}</p>}
      </section>}
      {props.newProblem && <FirstResearchStart participation={props.participation} budgets={props.budgets} limits={props.budgetLimits}
        cost={props.cost && { ...props.cost, providerId: props.providerId, model: props.model }}
        locked={props.submitting || props.participationLocked} quota={props.quota} onBudget={value => {
          props.onBudget('formalization', 'maxRunSeconds', value.maxRunSeconds); props.onBudget('formalization', 'maxTotalTokens', value.maxTotalTokens);
          props.onBudget('research', 'maxRunSeconds', value.research.maxRunSeconds); props.onBudget('research', 'maxTotalTokens', value.research.maxTotalTokens);
          props.onBudget('research', 'maxTurns', value.research.maxTurns);
        }} />}
      {props.newProblem && <button type="button" class="first-research-connection" data-first-connection onClick={() => configure(1, '#formalize-provider')}>
        <span>{provider?.name ?? tx('选择模型服务商', 'Choose a model provider')}{props.model.trim() && <> · <span translate={false}>{props.model}</span></>}</span>
        <span data-status={props.connection?.status ?? 'unchecked'}>{configuration} <Icon name="chevron-right" /></span>
      </button>}
      <div class="chat-composer-toolbar">
        {props.newProblem && <details class="chat-participation-control" data-chat-participation-control onToggle={event => {
          if (event.currentTarget.open) { const settings = event.currentTarget.parentElement?.querySelector<HTMLDetailsElement>('#formalize-settings'); if (settings) settings.open = false; }
        }}>
          <summary><span>{props.participation === 'guided' ? t('共同推进') : t('自动推进')}</span><Icon name="chevron-down" /></summary>
          <fieldset class="chat-participation" data-chat-participation disabled={props.submitting || props.participationLocked}>
            <legend>{t('研究方式')}</legend>
            <label><input type="radio" name="chat-participation" value="guided" checked={props.participation === 'guided'} onChange={event => { props.onParticipation('guided'); event.currentTarget.closest('details')!.open = false; }} />
              <span><strong>{t('共同推进')}</strong><span>{t('题意和初始计划由你确认 · 2 个 Agent')}</span></span></label>
            <label><input type="radio" name="chat-participation" value="automatic" checked={props.participation === 'automatic'} onChange={event => { props.onParticipation('automatic'); event.currentTarget.closest('details')!.open = false; }} />
              <span><strong>{t('自动推进')}</strong><span>{t('自动核对并开始证明 · 1 个 Agent')}</span></span></label>
          </fieldset>
        </details>}
        <details ref={settings} id="formalize-settings" class="chat-composer-settings" onToggle={event => {
          // On the empty home the fields open below the composer; a short screen scrolls them into view.
          const details = event.currentTarget;
          if (details.open) { const participation = details.parentElement?.querySelector<HTMLDetailsElement>('[data-chat-participation-control]'); if (participation) participation.open = false; }
          if (details.open && document.body.dataset.chatEmpty === 'true') details.querySelector('.chat-settings-fields')?.scrollIntoView({ block: 'nearest' });
        }}><summary title={t("模型设置")}><Icon name="sliders-horizontal" /><span>{t("设置")}</span></summary>
          <div class="chat-settings-fields">
            {props.newProblem && <ol class="first-research-setup-steps" aria-label={tx('配置连接', 'Set up your connection')}>
              {[[1, tx('选服务商', 'Provider'), '#formalize-provider'], [2, tx('Key 与模型', 'Key and model'), '#formalize-key'], [3, tx('检查连接', 'Check'), '#check-model-connection']].map(([step, label, selector]) => <li key={step}>
                <button type="button" aria-current={setupStep === step ? 'step' : undefined} onClick={() => configure(Number(step), String(selector))}><span>{step}</span>{label}</button>
              </li>)}
            </ol>}
            <section class="first-research-setup-part" data-setup-part="1" data-current={setupStep === 1}>
            <label for="formalize-provider">{t('模型服务商')}<select id="formalize-provider" value={props.providerId}
              onChange={event => { props.onProvider(event.currentTarget.value); setSetupStep(2); }} disabled={props.hasConversation || props.submitting}>
              {!provider && <option value={props.providerId} disabled>{props.providerId ? `${props.providerId} · ` : ''}{t('请选择可用的服务商')}</option>}
              {props.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
            {props.newProblem && <button type="button" class="text-button" data-setup-next="credentials" onClick={() => configure(2, props.keyRequired ? '#formalize-key' : '#formalize-model')}>{tx('使用这个服务商，继续', 'Use this provider and continue')} →</button>}
            </section>
            <section class="first-research-setup-part" data-setup-part="2" data-current={setupStep === 2}>
            <label for="formalize-model">{t('模型')}<input id="formalize-model" type="text" value={props.model} spellcheck={false}
              onInput={event => props.onModel(event.currentTarget.value)} disabled={props.hasConversation || props.submitting} required maxlength={160}
              list="chat-model-options" /></label>
            <datalist id="chat-model-options">{provider?.defaultModel && <option value={provider.defaultModel} />}</datalist>
            <label for="formalize-key">API Key {props.keyRequired && <span>{t("（必填）")}</span>}</label>
            <input ref={keyInput} id="formalize-key" type="password" autocomplete="off" spellcheck={false} value={props.apiKey} onInput={event => props.onKey(event.currentTarget.value)} placeholder={t('临时使用的 API Key')} aria-describedby="chat-key-help" />
            <p id="chat-key-help" class="field-note">{provider?.keyUrl ? <a href={provider.keyUrl} target="_blank" rel="noopener noreferrer">{t('创建 API Key')}</a>
              : t('网关 Key 请向管理员获取。')}
              {' '}{provider?.key === 'saved' ? t('留空使用账号中已保存的 Key。') : provider?.key === 'server' ? t('留空使用管理员已配置的 Key。') : ''}</p>
            {props.keyManagement && <div class="chat-key-management">
              {props.keyManagement.ending && <p class="field-note">{t('已保存 Key · 末四位 {0}', props.keyManagement.ending)}</p>}
              <div class="chat-task-actions">
                <button type="button" class="button" id="chat-save-key" disabled={props.keyManagement.busy || !props.apiKey.trim()}
                  onClick={props.keyManagement.onSave}>{props.keyManagement.busy ? t('正在保存…') : props.keyManagement.ending ? t('替换已保存的 Key') : t('保存到我的账号')}</button>
                {props.keyManagement.ending && <button type="button" class="text-button" id="chat-delete-key" disabled={props.keyManagement.busy}
                  onClick={props.keyManagement.onDelete}>{t('删除已保存的 Key')}</button>}
              </div>
              <p class="field-note">{t('保存后加密存入你的账号，可随时删除。')}</p>
              {props.keyManagement.notice && <p class="field-note" id="chat-key-notice" role="status">{props.keyManagement.notice}</p>}
            </div>}
            </section>
            <section class="first-research-setup-part" data-setup-part="3" data-current={setupStep === 3}>
            <div class="chat-connection-check"><button type="button" class="button" id="check-model-connection" onClick={() => { setSetupStep(3); props.onCheckConnection(); }}
              title={t('通过模型列表检查连接')}
              disabled={props.checkingConnection || !props.model.trim() || props.keyRequired && !props.apiKey.trim()}>{props.checkingConnection ? t('正在检查连接…') : t('检查 Key 与模型')}</button></div>
            {props.connection && <p class="field-note" id="chat-connection-result" role="status" data-status={props.connection.status}>{props.connection.message}</p>}
            {props.newProblem && <p class="field-note">{tx('这一步只读取模型列表，不调用模型。', 'This check reads the model list and does not call a model.')}</p>}
            </section>
            <details class="chat-advanced-settings" data-chat-advanced-settings><summary>{t('高级设置')}<span>{t('环境、推理与预算')}</span></summary>
              <div class="chat-advanced-settings-fields">
              <div class="chat-settings-options"><label for="formalize-environment">{t("证明环境")}<select id="formalize-environment" value={props.environment} onChange={event => props.onEnvironment(event.currentTarget.value as ChatComposerProps['environment'])} disabled={props.hasConversation}><option value="mathlib">{t('TheoremOS 数学环境')}</option><option value="standard" hidden>{t('Lean 标准库')}</option></select></label>
                <label for="formalize-effort">{t("推理强度")}<select id="formalize-effort" value={props.effort} onChange={event => props.onEffort(event.currentTarget.value as ChatComposerProps['effort'])} disabled={props.hasConversation}><option value="max">{t("最高")}</option><option value="high">{t("高")}</option><option value="low">{t("低")}</option></select></label></div>
            {!props.hasConversation && <>
              <fieldset class="chat-budget-fields"><legend>{t('形式化预算')}</legend><div class="chat-settings-options">
                <label for="formalize-minutes">{t('最多分钟')}<input id="formalize-minutes" type="number" min={0} max={props.budgetLimits.maxRunSeconds ? Math.floor(props.budgetLimits.maxRunSeconds / 60) : undefined} step={1}
                  {...budgetFieldProps('formalize-minutes')}
                  value={props.budgets.maxRunSeconds ? props.budgets.maxRunSeconds / 60 : ''} placeholder={t('不限')}
                  onInput={event => props.onBudget('formalization', 'maxRunSeconds', Number(event.currentTarget.value) * 60)} />{budgetFieldError('formalize-minutes')}</label>
                <label for="formalize-tokens">{t('最多 Token')}<input id="formalize-tokens" type="number" min={10000} max={props.budgetLimits.maxTotalTokens || undefined} step={1}
                  {...budgetFieldProps('formalize-tokens')}
                  value={props.budgets.maxTotalTokens || ''} placeholder={t('不限')}
                  onInput={event => props.onBudget('formalization', 'maxTotalTokens', Number(event.currentTarget.value))} />{budgetFieldError('formalize-tokens')}</label>
              </div></fieldset>
              <fieldset class="chat-budget-fields"><legend>{t('随后证明的预算')}</legend><div class="chat-settings-options">
                <label for="research-minutes">{t('最多分钟')}<input id="research-minutes" type="number" min={0} max={props.budgetLimits.research.maxRunSeconds ? Math.floor(props.budgetLimits.research.maxRunSeconds / 60) : undefined} step={1}
                  {...budgetFieldProps('research-minutes')}
                  value={props.budgets.research.maxRunSeconds ? props.budgets.research.maxRunSeconds / 60 : ''} placeholder={t('不限')}
                  onInput={event => props.onBudget('research', 'maxRunSeconds', Number(event.currentTarget.value) * 60)} />{budgetFieldError('research-minutes')}</label>
                <label for="research-tokens">{t('最多 Token')}<input id="research-tokens" type="number" min={10000} max={props.budgetLimits.research.maxTotalTokens || undefined} step={1}
                  {...budgetFieldProps('research-tokens')}
                  value={props.budgets.research.maxTotalTokens || ''} placeholder={t('不限')}
                  onInput={event => props.onBudget('research', 'maxTotalTokens', Number(event.currentTarget.value))} />{budgetFieldError('research-tokens')}</label>
                <label for="research-turns">{t('最多研究轮次')}<input id="research-turns" type="number" min={0} max={props.budgetLimits.research.maxTurns || undefined} step={1}
                  {...budgetFieldProps('research-turns')}
                  value={props.budgets.research.maxTurns || ''} placeholder={t('不限')}
                  onInput={event => props.onBudget('research', 'maxTurns', Number(event.currentTarget.value))} />{budgetFieldError('research-turns')}</label>
              </div></fieldset>
              <p class="field-note">{t('按已报告用量停止，在途请求可能超额；Token 上限不代表金额封顶。')}</p>
            </>}
              </div>
            </details>
          </div>
        </details>
        {!props.hasConversation && <button class="text-button chat-lean-entry" type="button" onClick={props.onLean}>Lean <Icon name="chevron-right" /></button>}
        <div class="chat-composer-submit">{props.pending ? <button id="chat-stop" type="button" class="chat-send" onClick={props.onStop} aria-label={t("停止回答")} title={t("停止回答")}><Icon name="square" /></button>
          : <button id="formalize-start" type="submit" class={`chat-send${props.newProblem ? ' chat-send-start' : ''}`} disabled={!canSend}
            aria-label={props.guidance ? t('发送研究指导') : !props.newProblem ? t("发送") : props.participation === 'guided' ? tx('开始核对题目', 'Start statement review') : tx('开始解题', 'Start solving')}
            title={props.guidance ? t('发送研究指导') : !props.newProblem ? t("发送") : props.participation === 'guided' ? tx('开始核对题目', 'Start statement review') : tx('开始解题', 'Start solving')}>
            {props.newProblem && <span>{props.participation === 'guided' ? tx('开始核对题目', 'Start statement review') : tx('开始解题', 'Start solving')}</span>}{props.submitting ? <span class="spinner" /> : <Icon name="arrow-up" />}</button>}</div>
      </div>
    </form>
    {props.submissionRecovery && <div class="chat-send-status" data-chat-submission-recovery role="status">
      <p>{t('原任务已创建，对话连接尚未恢复。修改后的题目已保留，尚未发送。')}</p>
      <button type="button" class="button" data-chat-recover-submission disabled={props.submissionRecovery.busy}
        onClick={props.submissionRecovery.onRecover}>{t('恢复原任务')}</button>{' '}
      <button type="button" class="button" data-chat-prepare-edited disabled={props.submissionRecovery.busy}
        onClick={props.submissionRecovery.onPrepareEdited}>{t('保留修改，另起新题')}</button>
      <p>{t('另起新题会先恢复原任务记录，再准备修改后的题目；再次发送才会启动。')}</p>
    </div>}
    {!props.hasConversation && !validBudget && <div class="chat-send-status" role="alert" data-chat-budget-errors>{budgetIssues.map(issue => <p key={issue.field}>
      <button type="button" class="text-button" data-chat-fix-budget={issue.field} onClick={() => focusBudget(issue.field)}>{budgetLabel(issue.field)}</button>{' · '}{budgetIssueText(issue)}
    </p>)}</div>}
    {props.sendStatus && <p id="formalize-send-status" class="chat-send-status" role="status">{props.sendStatus}</p>}
    {props.input.trim() && missingKey && <div class="chat-key-next-step" role="status" data-chat-key-required>
      <p>{t('题目已保留，填写 API Key 后即可发送。')}</p>
      <button type="button" class="button" data-chat-configure-key onClick={configureKey}>{t('配置 Key 后开始')}</button>
    </div>}
    {props.home && <HomeResearchDetails {...props.home} />}
    {props.newProblem && <details class="chat-examples"><summary>{t("试试例题")}</summary><label class="sr-only" for="formalize-example">{t("选择自然语言例题")}</label><select id="formalize-example" value="" onChange={event => { props.onExample(event.currentTarget.value); event.currentTarget.value = ''; textarea.current?.focus(); }}><option value="">{t("选择一个题目")}</option>{researchExamples.map(example => <option key={example.id} value={example.id}>{locale === 'en' ? example.nameEn : example.name}</option>)}</select></details>}
    {props.problemDrafts && <ProblemDraftPanel key={props.problemDrafts.owner} {...props.problemDrafts} />}
  </div>;
}

function HomeResearchDetails(props: NonNullable<ChatComposerProps['home']>) {
  const returning = Boolean(props.overview && (props.overview.runs.length || props.overview.conversations.length || props.overview.formalizations.length));
  return <div class="chat-home-details">
      <div class="chat-start-actions">
        <button type="button" class="button" data-chat-configure onClick={props.onConfigure}><Icon name="sliders-horizontal" />{t('配置模型')}</button>
        <button type="button" class="button" data-chat-first-example onClick={props.onFirstExample}><Icon name="plus" />{t('试一道简单题')}</button>
        <a class="button" href="workspace.html">{t('我的研究')}</a>
      </div>
      <p class="chat-start-tools"><a href={`workspace.html?tab=search&lang=${locale}`}>{t('搜索全部研究记录')}</a> · <a href={`practice.html?lang=${locale}`}>{t('体验参与决策')}</a></p>
      {props.onSample && <button type="button" class="text-button chat-start-sample" data-chat-sample title={t('无需 API Key')} onClick={props.onSample}>{t('查看完整示例')}<Icon name="arrow-up-right" /><span>{t('免费浏览')}</span></button>}

    {props.startGuide && (returning ? <details class="research-returning-guide"><summary>{t('准备一道新题')}</summary><StartGuide {...props.startGuide} onConfigure={props.onConfigure} /></details>
      : <StartGuide {...props.startGuide} onConfigure={props.onConfigure} />)}
    {props.overview && <ResearchOverview key={props.overview.owner} {...props.overview} />}
  </div>;
}

export type ChatHistoryProps = {
  items: WebConversationSummary[]; selectedId?: string; onOpen(id: string): void; failed?: boolean; onRetry?(): void;
  runs?: readonly WebRun[];
  onRename(id: string, title: string): Promise<void>; onDelete(id: string): Promise<void>;
  records: WebFormalization[]; recordLimit: number; onDeleteRecord(id: string): Promise<void>; onRefreshRecords(): void;
};
function ChatHistory(props: ChatHistoryProps) {
  const { items, selectedId, onOpen, failed, onRetry } = props;
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ id: string; action: 'rename' | 'delete' | 'record'; title: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const matching = items.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const decisions = new Map<string, string>();
  for (const item of matching) {
    if (item.runId || !item.formalizationId) continue;
    const record = props.records.find(record => record.id === item.formalizationId);
    // The index omits the report; its recorded lifecycle identifies the pending human action.
    if (!record?.humanReview || record.runId) continue;
    if (record.status === 'review') decisions.set(item.id, t('等你确认题意'));
    else if (record.status === 'confirmed') decisions.set(item.id, t('继续拟定研究计划'));
  }
  const edit = (id: string, action: 'rename' | 'delete' | 'record', title: string) => { setEditing({ id, action, title }); setError(''); setNotice(''); };
  const apply = async () => {
    if (!editing || busy) return;
    setBusy(true); setError('');
    try {
      if (editing.action === 'rename') await props.onRename(editing.id, editing.title);
      else if (editing.action === 'delete') await props.onDelete(editing.id);
      else { await props.onDeleteRecord(editing.id); setNotice(t('题目记录已删除，对话仍保留。')); }
      setEditing(undefined);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const confirmation = (id: string) => editing?.id === id && <form class="chat-history-edit" onSubmit={event => { event.preventDefault(); void apply(); }}>
    {editing.action === 'rename' ? <label>{t('对话标题')}<input data-chat-title value={editing.title} maxlength={80} required disabled={busy}
      onInput={event => setEditing({ ...editing, title: event.currentTarget.value })} /></label>
      : <p>{editing.action === 'delete' ? t('只删除这段对话，题目、证明任务和分享链接仍保留。') : t('删除这份题目与形式化审核记录？对话记录仍保留。')}</p>}
    <div><button type="submit" class="button" data-chat-history-confirm disabled={busy || !editing.title.trim()}>{busy ? t('正在处理…') : editing.action === 'rename' ? t('保存') : t('确认删除')}</button>
      <button type="button" class="text-button" disabled={busy} onClick={() => { setEditing(undefined); setError(''); }}>{t('取消')}</button></div>
    {error && <p class="chat-history-error" role="alert">{error}</p>}
  </form>;
  const rows = (entries: WebConversationSummary[]) => entries.map(item => <div key={item.id} class="chat-history-row" data-chat-row={item.id}>
    <div class="chat-history-line"><a href={`?chat=${encodeURIComponent(item.id)}`} class="chat-history-item" aria-current={item.id === selectedId ? 'page' : undefined}
      onClick={event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpen(item.id); }}>
      <span class="chat-history-copy"><span translate={false}>{item.title}</span>{decisions.has(item.id) ? <span class="chat-history-decision" data-chat-awaiting>{decisions.get(item.id)}</span> : <span class="chat-history-status" data-chat-history-status>{(() => {
        const run = props.runs?.find(run => run.id === item.runId), record = props.records.find(record => record.id === item.formalizationId);
        if (run) return isAcceptedRun(run) ? t('证明已验收') : isFaultedRun(run) || isRejectedRun(run) ? t('研究未完成，查看原因') : ['queued', 'running'].includes(run.status) ? runProgress(run).phaseLabel : stoppedLabel(run);
        if (record) return record.status === 'error' || record.status === 'exhausted' ? t('形式化未完成') : record.status === 'cancelled' ? t('已停止') : record.status === 'confirmed' ? t('陈述已确认') : record.status === 'review' ? t('陈述待核对') : t('形式化进行中');
        return item.answering ? t('正在回答') : item.runId || item.formalizationId ? t('查看题目进展') : t('讨论');
      })()}</span>}<time class="chat-history-time" dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></span>
      {item.answering && <span class="spinner" aria-label={t("正在回答")} />}</a>
      <button type="button" class="icon-button" data-chat-rename disabled={busy} aria-label={t('重命名对话')} title={t('重命名对话')} onClick={() => edit(item.id, 'rename', item.title)}><Icon name="square-pen" /></button>
      <button type="button" class="icon-button" data-chat-delete disabled={busy} aria-label={t('删除对话')} title={t('删除对话')} onClick={() => edit(item.id, 'delete', item.title)}><Icon name="trash-2" /></button></div>
    {confirmation(item.id)}
  </div>);
  return <nav class="chat-history" aria-label={t("对话历史")}>
    <p class="chat-history-heading">{t("对话")}</p>
    <label class="chat-history-search"><span class="sr-only">{t('搜索对话标题')}</span><Icon name="search" /><input type="search" data-chat-search placeholder={t('搜索对话标题')} value={query} onInput={event => setQuery(event.currentTarget.value)} /></label>
    {items.length ? matching.length ? <>
      {!!decisions.size && <section class="chat-history-waiting" data-chat-waiting aria-label={t('等你处理')}>
        <p class="chat-history-heading">{t('等你处理')} <span>{decisions.size}</span></p>
        {rows(matching.filter(item => decisions.has(item.id)))}
      </section>}
      {rows(matching.filter(item => !decisions.has(item.id)))}
    </> : <p class="chat-history-empty">{t('没有匹配的对话')}</p>
      : failed ? <p class="chat-history-empty" role="alert">{t("对话列表暂时没有加载出来。")}<button type="button" class="text-button" data-chat-history-retry onClick={onRetry}>{t("重试")}</button></p>
      : <p class="chat-history-empty">{t("新对话会保存在这里")}</p>}
    <details id="chat-problem-records" class="chat-problem-records" onToggle={event => { if (event.currentTarget.open) props.onRefreshRecords(); }}>
      <summary>{t('管理题目记录')}<span>{props.records.length} / {props.recordLimit}</span></summary>
      <p class="chat-history-empty">{t('记录满后可在这里清理。有研究使用的题目，需要先删除关联研究。')}</p>
      {props.records.map(item => <div class="chat-problem-record" key={item.id} data-chat-record={item.id}>
        <a href={`formalize.html?id=${encodeURIComponent(item.id)}`} target="_blank" rel="noreferrer" translate={false}>{item.original}</a>
        <div>{item.runId && <a class="text-button" href={`?run=${encodeURIComponent(item.runId)}`}>{t('查看关联研究')}</a>}
          <button type="button" class="text-button" data-chat-delete-record disabled={busy || ['queued', 'running'].includes(item.status)} onClick={() => edit(item.id, 'record', item.original)}>{t('删除题目')}</button></div>
        {confirmation(item.id)}
      </div>)}
      {!props.records.length && <p class="chat-history-empty">{t('还没有形式化记录。')}</p>}
      {notice && <p class="chat-history-empty" role="status">{notice}</p>}
    </details>
  </nav>;
}

export function renderChatThread(root: HTMLElement, props: ChatThreadProps) { render(<ChatThread {...props} />, root); }
/** No conversation key: the textarea, focus, IME composition and settings survive polling and navigation. */
export function renderChatComposer(root: HTMLElement, props: ChatComposerProps) { render(<ChatComposer {...props} />, root); }
export function renderChatHistory(root: HTMLElement, props: ChatHistoryProps) { render(<ChatHistory {...props} />, root); }

export type ChatOriginalProps = { formalization?: WebFormalization; run?: WebRun };
function ChatOriginal({ formalization, run }: ChatOriginalProps) {
  const report = formalization?.report;
  const reviewMode = formalization?.reviewMode ?? run?.formalization?.reviewMode;
  const direct = reviewMode === 'direct' || report?.semanticReview === 'not-performed';
  const original = report?.original ?? formalization?.original ?? run?.formalization?.original;
  const source = report?.statement ?? formalization?.compiled?.source ?? run?.source;
  const [copied, setCopied] = useState<string>();
  const [copyError, setCopyError] = useState(false);
  const confirmation = run?.formalization?.confirmation ?? formalization?.confirmation
    ?? (formalization?.compiled && ['queued', 'running'].includes(formalization.status) ? 'pending' : undefined);
  const formalizationId = formalization?.id ?? run?.formalizationId;
  const backgroundReview = formalization?.backgroundReview ?? report?.backgroundReview;
  const relations: Record<string, string> = { direct: t("直接对应"), equivalent: t("等价表达"), unresolved: t("待核对"), mismatch: t("不一致") };
  const aspects: Record<string, string> = { domains: t("对象与类型"), assumptions: t("假设"), conclusions: t("结论"), definitions: t("定义"), quantifierScope: t("量词范围"), instanceCoherence: t("结构与实例") };
  return <div class="chat-original-content">
    <header class="chat-original-header"><h2>{t("原题与 Lean")}</h2>
      {formalizationId && <a class="text-button" href={`formalize.html?id=${encodeURIComponent(formalizationId)}`} target="_blank" rel="noreferrer">{formalization ? direct ? t('形式化详情') : t("完整审核") : t("查看最新审核")}<Icon name="arrow-up-right" /></a>}
    </header>
    {(report || formalization?.compiled || run?.formalization) && <p class="chat-statement-verdict">{direct && (!confirmation || ['automatic', 'manual'].includes(confirmation)) ? t('Lean 编译通过') : statementConfirmation(confirmation, false, formalization?.reviewMode ?? run?.formalization?.reviewMode)}
      {' '}{t('Lean 验收证明的是这份陈述，不能替代对自然语言原意的核对。')}</p>}
    {backgroundReview && <BackgroundReview review={backgroundReview} />}
    <div class="chat-original-columns">
      <section><h3>{t("自然语言原题")}</h3><div class="chat-message-text" translate={false}><Rich text={original ?? t("此题直接从 Lean 陈述开始。")} /></div></section>
      <section><h3>{t("Lean 陈述")}</h3>{source ? <>
        <div class="chat-task-actions"><button type="button" class="text-button" data-chat-statement-copy onClick={() => {
          setCopyError(false); void (navigator.clipboard?.writeText(source) ?? Promise.reject()).then(() => setCopied(source), () => setCopyError(true));
        }}><Icon name={copied === source ? 'check' : 'copy'} />{copied === source ? t('代码已复制') : t('复制代码')}</button>
        <a class="text-button" data-chat-statement-download data-download-statement href={`data:text/plain;charset=utf-8,${encodeURIComponent(source)}`} download="Formalization.lean"><Icon name="download" />{t('下载 Lean')}</a></div>
        {copyError && <p role="status">{t('复制失败，请选择代码复制。')}</p>}
        <pre tabIndex={0} translate={false}><code>{source}</code></pre>
      </> : <p>{t("陈述尚未生成。")}</p>}</section>
    </div>
    {report && <>
      {report.backtranslation && <section class="chat-backtranslation"><h3>{t("独立回译")}</h3><p class="chat-message-text" translate={false}><Rich text={report.backtranslation?.mathematics ?? report.original} /></p>
        {!!report.backtranslation.assumptions.length && <><h4>{t("假设")}</h4><ul>{report.backtranslation.assumptions.map((value, index) => <li key={index} translate={false}><Rich text={value} /></li>)}</ul></>}
        {!!report.backtranslation.definitions.length && <><h4>{t("定义")}</h4><ul>{report.backtranslation.definitions.map((value, index) => <li key={index} translate={false}><Rich text={value} /></li>)}</ul></>}
      </section>}
      {(!direct || report.correspondences.length > 0) && <section class="chat-correspondences"><h3>{t("具体对应关系")}</h3>
        {report.correspondences.length ? report.correspondences.map((item, index) => <article key={index} data-relation={item.relation}>
          <header><strong>{aspects[item.aspect]}</strong><span>{relations[item.relation]}</span></header>
          <div class="chat-original-columns"><blockquote translate={false}><Rich text={item.original} /></blockquote><pre tabIndex={0} translate={false}><code>{item.leanText}</code></pre></div>
          {item.explanations.map((explanation, n) => <p key={n} translate={false}><Rich text={explanation} /></p>)}
        </article>) : <p>{t("本次报告未记录逐项对应关系。")}</p>}
      </section>}
    </>}
  </div>;
}
export function renderChatOriginal(root: HTMLElement, props: ChatOriginalProps) { render(<ChatOriginal {...props} />, root); }
