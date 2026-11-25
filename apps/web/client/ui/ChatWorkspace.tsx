import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { WebConversation, WebConversationMessage, WebConversationSummary } from '../../conversationTypes';
import type { WebFormalization } from '../../formalizationTypes';
import type { WebEffort, WebProvider, WebQuotaView, WebRun } from '../../shared';
import { researchExamples } from '../../problemExamples';
import { effortLabels, formatTokens, isAcceptedRun, isFaultedRun, isRejectedRun, planAwaitingApproval, resultDescription, runProgress, stoppedLabel } from '../../presentation';
import { acceptedTitle, acceptedVerdict, isStatementReviewed, statementConfirmation } from '../../presentation';
import type { NextStep } from '../../report';
import { locale, localizeText, t } from '../../i18n';
import { detailLevel, onDetailLevel } from '../detailLevel';
import type { SolveProcess } from '../solveProcess';
import type { ThinkingStep } from '../thinkingProcess';
import { formalizationPhaseText, formalizationReasonText, formalizationNextStep } from '../../formalizationReasons';
import { Icon } from './Icon';
import { ChatMessageContent } from './ChatMessageContent';
import { Rich, RichProse } from '../richText';
import { Elapsed, SolveProcessView } from './SolveProcess';
import type { PlanApprovalProps } from './RunHeader';
import type { ChatArtifactKind } from '../chatArtifactNavigation';
import { RecoveryChoices } from '../productFlowView';
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
import { chatMathematicsSummary, type ChatMathematics } from '../chatMathematics';
import { ChatAnswerActions, ChatMathematicalAnswer, ChatMathematicalProgress, ChatMathematicalSummary } from './ChatMathematicalWork';
import { chatReadingReveal } from '../chatReadingPosition';
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
  onOpenLivePlan?(): void;
  onQuestion?(entry: ThinkingStep): void;
  onGuidanceReceipt?(message: WebConversationMessage): void;
  /** Offered only while the run still holds the note in its queue. */
  onWithdrawGuidance?(message: WebConversationMessage): void; withdrawingGuidance?: readonly string[]; withdrawalNotes?: Record<string, string>;
  guidanceFeedback?: { records: ResearchFeedback[]; loading: boolean; error?: string; onRetry(): void };
  onEditProblem?(): void;
  onCancelTask?(): void;
  onStartResearch?(): void;
  onConfirmStatement?(): void;
  planDecision?: { approval?: PlanApprovalProps; connected: boolean; onReview(): void; onEdit(): void; onApprove(): void };
  startingResearch?: boolean;
  onRetry?(): void;
  onRetryAnswer?(message: WebConversationMessage): void;
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

function PlanDecision(props: ChatThreadProps & { simple: boolean }) {
  const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
  const run = props.run, decision = props.planDecision;
  const previousPlan = usePreviousDecisionPlan(run?.observation?.plan, run?.id ?? '');
  if (!run || !decision) return null;
  const plan = run.observation?.plan, approval = decision.approval;
  // 简洁 keeps this card for the decision itself; afterwards the plan and its editing live in the workspace's roadmap.
  if (props.simple && !approval && (plan || !run.planApproval)) return null;
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
function FormalizationFailure({ item, code, onOriginal }: { item: WebFormalization; code: string; onOriginal(): void }) {
  const stage = item.researchError ? t('启动证明研究') : formalizationPhaseText(item.progress?.phase);
  const kept = Boolean(item.report || item.compiled);
  return <div class="chat-task-failure" data-formalization-failure>
    <p>{formalizationReasonText(code)}</p>
    <dl>
      <dt>{t('错误代码')}</dt><dd><code translate={false}>{code}</code></dd>
      <dt>{t('停止阶段')}</dt><dd>{stage}</dd>
      <dt>{t('保留成果')}</dt><dd>{kept ? <button type="button" class="text-button" data-research-artifact="original"
        onClick={onOriginal}>{t('查看原题与 Lean 陈述')}</button> : t('没有保存可用的 Lean 陈述。')}</dd>
    </dl>
    <p class="chat-failure-next">{formalizationNextStep(code)}</p>
  </div>;
}

function TaskMessage(props: ChatThreadProps) {
  const { run, formalization: item } = props;
  const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
  const [, relevel] = useState(0);
  useEffect(() => onDetailLevel(() => relevel(value => value + 1)), []);
  // Keep decisions and the mathematical answer in the conversation; open the process and artifacts on demand.
  const simple = detailLevel() === 'simple';
  const proofActive = !!run && ['queued', 'running'].includes(run.status);
  const reviewActive = !!item && ['queued', 'running'].includes(item.status);
  const active = proofActive || reviewActive;
  const accepted = !!run && isAcceptedRun(run);
  const compactMathematics = simple && !accepted ? props.mathematics : undefined;
  const acceptance = accepted && run ? acceptedVerdict(run) : undefined;
  const reviewed = !!run && isStatementReviewed(run);
  const explanationStatus = props.answer?.explanation?.status;
  const showAnswer = accepted && (reviewed || Boolean(explanationStatus && explanationStatus !== 'approved'));
  const natural = !!(item || run?.formalization);
  const statementDecision = !run && !!item?.humanReview && !!item.report && ['review', 'confirmed'].includes(item.status);
  const openingStatement = props.conversation?.messages.find(message => message.role === 'user' && message.kind === 'text')?.text;
  const mathematicsSummary = chatMathematicsSummary(compactMathematics, [
    ...(openingStatement === undefined ? [] : [openingStatement]),
    ...(statementDecision && item?.report ? [item.report.backtranslation?.mathematics ?? item.report.original] : []),
  ]);
  const confirmation = run?.formalization?.confirmation ?? item?.confirmation ?? (item?.compiled && reviewActive ? 'pending' : undefined);
  const reviewMode = item?.reviewMode ?? run?.formalization?.reviewMode;
  const direct = reviewMode === 'direct' || item?.report?.semanticReview === 'not-performed';
  const formalProgress = item && formalizationProgress(item, props.solve?.process);
  const backgroundReview = item?.backgroundReview ?? item?.report?.backgroundReview;
  const formalizationFailed = !!item && (['error', 'exhausted'].includes(item.status) || !!item.researchError);
  const failed = run ? isFaultedRun(run) || isRejectedRun(run) : formalizationFailed;
  const failureCode = formalizationFailed ? item.researchError || item.reason : undefined;
  const originalInFailure = !!failureCode && !!(item?.report || item?.compiled);
  const formalizationPhase = formalizationPhaseText(item?.progress?.phase ?? 'queued');
  const title = run ? accepted ? acceptedTitle(run) : proofActive ? runProgress(run).phaseLabel
    : reviewActive ? formalizationPhase
    : run.status === 'cancelled' ? t('已取消') : failed ? t('运行失败') : stoppedLabel(run)
    : failed ? item?.researchError ? t('证明研究未能启动') : t("形式化未完成") : item?.status === 'cancelled' ? t('已取消')
      : active ? formalProgress?.revising ? t('根据 Lean 报错修改陈述') : formalizationPhase
        : item?.status === 'review' ? direct ? t('Lean 代码已就绪') : t("陈述待核对")
          : item?.status === 'confirmed' ? direct ? t('Lean 代码已就绪') : t("陈述已确认") : props.missingTask ? t('关联任务记录已删除') : t("正在读取任务");
  const description = props.missingTask ? t('原题和对话仍保留，可以修改题目后重新发送。') : run ? acceptance?.description ?? resultDescription(run) : failed
    ? t('本次生成未完成。')
    : item?.status === 'cancelled' ? t("任务已停止，已保存的消息仍可查看。")
      : active && item?.compiled ? t('Lean 陈述已编译，可以查看和下载；原题含义正在后台审核。')
        : formalProgress?.description ?? t("陈述检查不代表证明通过，最终结果以 Lean 独立验收为准。");
  const proof = run?.result?.proof || run?.artifact?.source;
  const solve = props.solve;
  const planTasks = solve?.process.tasks ?? [];
  const showPlanProgress = proofActive && planTasks.length > 0 && !props.planDecision?.approval && props.onOpenLivePlan;
  const hasSource = solve?.process.current !== undefined || solve?.process.checks.some(check => check.source !== undefined);
  const liveAvailable = Boolean(solve && (solve.process.active || hasSource));
  const detailedAcceptance = simple && accepted && !props.missingTask;
  const metadata = solve && <p class="research-conversation-meta" data-chat-run-meta>
    {solve.process.startedAt && <Elapsed from={solve.process.startedAt} to={solve.process.endedAt} />}
    {solve.process.tokens !== undefined && <span>{t('Token {0}', formatTokens(solve.process.tokens))}</span>}
    {liveAvailable && active && <button type="button" class="text-button" data-research-artifact="live" onClick={() => props.onArtifact('live')}>
      <Icon name="panel-right" />{t('实时工作区')}</button>}
    {!simple && active && props.onCancelTask && <button type="button" class="text-button" data-research-stop onClick={props.onCancelTask}>{t("停止解题")}</button>}
  </p>;
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
    {props.sample && <p class="sample-note" data-chat-sample-note>{t('附 Lean 验收记录')}</p>}
    <div class="research-conversation-status" data-active={active} data-accepted={accepted} data-failed={failed}>
      <div class="chat-task-status-line"><p class="research-conversation-state" role="status" aria-atomic="true">
        <Icon name={accepted ? 'circle-check' : failed ? 'circle-alert' : active ? 'clock-3' : !run && formalProgress?.ready ? 'file-code-2' : 'square'} /><strong>{title}</strong></p>
      {simple && solve && active && props.onCancelTask && <button type="button" class="text-button" data-research-stop onClick={props.onCancelTask}>{t("停止解题")}</button>}
      </div>
      {!simple && metadata}
      {(run || !failureCode) && (!statementDecision || failed) && !detailedAcceptance && <p class="research-conversation-description">{description}</p>}
      {item && failureCode && <FormalizationFailure item={item} code={failureCode} onOriginal={() => props.onArtifact('original')} />}
      {!run && item?.status === 'queued' && item.queue && <p class="research-conversation-latest" data-formalization-queue>{t('排队第 {0} 位 · 前方 {1} 项等待 · {2} 项执行中', item.queue.position, item.queue.ahead, item.queue.running)}</p>}
      {item?.compiled && reviewActive && <p class="chat-statement-verdict" data-chat-background-review role="status">
        {accepted ? t('候选 Lean 陈述已证明，原题含义仍在后台审核。') : proofActive ? t('证明与原题含义审核同时进行，已有代码可以立即使用。')
          : t('Lean 陈述已编译，可以查看和下载；原题含义正在后台审核。')}
      </p>}
      {!statementDecision && natural && (item?.report || item?.compiled || run?.formalization) && <p class="chat-statement-verdict" data-statement-verdict>
        {acceptance?.meaning ?? (direct && (!confirmation || confirmation === 'automatic') ? t('Lean 编译通过') : statementConfirmation(confirmation, false, reviewMode))}
        {' '}{t('Lean 验收证明的是这份陈述，不能替代对自然语言原意的核对。')}
      </p>}
    </div>
    {backgroundReview && <BackgroundReview review={backgroundReview} compact />}
    <StatementDecision {...props} />
    <PlanDecision {...props} simple={simple} />
    {showAnswer && run && <ChatMathematicalAnswer runId={run.id} answer={props.answer} onRetry={() => props.onAnswerRetry?.()} onTarget={target => props.onAnswerTarget?.(target)} onQuestion={props.onAnswerQuestion} />}
    {accepted && !reviewed && (confirmation === 'rejected' || confirmation === 'interrupted' || confirmation === 'superseded') &&
      <p class="chat-math-empty">{t('原题含义审核尚未通过，暂未生成讲解。')}</p>}
    {mathematicsSummary && <ChatMathematicalSummary work={mathematicsSummary} />}
    {!accepted && props.mathematics && !compactMathematics && <ChatMathematicalProgress work={props.mathematics} onTask={taskId => props.onArtifact('roadmap', { taskId })} />}
    {accepted && run && <div class="research-conversation-artifacts">
      <button type="button" class="chat-result-primary" data-research-artifact="source" disabled={!proof} onClick={() => props.onArtifact('source')}><Icon name="file-code-2" /><span>{t('查看验收证明')}</span><Icon name="arrow-up-right" /></button>
      {!props.sample && run.result?.proof && <a class="chat-result-primary" data-chat-paper href={`paper.html?${new URLSearchParams({ run: run.id,
        ...(props.conversation ? { chat: props.conversation.id } : {}),
        ...(new URLSearchParams(location.search).has('lang') ? { lang: locale } : {}) })}`}>
        <Icon name="file-pen" /><span>{tx('论文初稿', 'Paper draft')}</span><Icon name="arrow-up-right" />
      </a>}
    </div>}
    {showPlanProgress && <div class="chat-plan-progress" data-chat-plan-progress>
      <span>{t('已完成 {0}/{1}', planTasks.filter(task => task.tone === 'done').length, planTasks.length)}</span>
      <button type="button" class="text-button" data-chat-open-live-plan onClick={props.onOpenLivePlan}>
        <Icon name="network" />{tx('打开进展地图', 'Open progress map')}<Icon name="arrow-up-right" />
      </button>
    </div>}
    {(solve || run || item) && <details class="chat-result-more" data-chat-result-more open={!simple && !accepted} onToggle={event => {
      if (!event.currentTarget.open || !compactMathematics) return;
      const progress = event.currentTarget.querySelector<HTMLElement>('[data-chat-mathematics]');
      progress?.querySelector('h3')?.scrollIntoView({ block: 'nearest' });
      progress?.focus({ preventScroll: true });
      progress?.dispatchEvent(new Event(chatReadingReveal, { bubbles: true }));
    }}>
      <summary>{active ? tx('查看解题进展', 'View solving progress') : tx('证明详情与报告', 'Proof details and reports')}</summary>
      <div class="chat-result-details">
      {detailedAcceptance && <p class="research-conversation-description">{description}</p>}
      {simple && metadata}
      {accepted && reviewed && run && props.answer?.document && <ChatAnswerActions runId={run.id} answer={props.answer} onRetry={() => props.onAnswerRetry?.()} />}
      {compactMathematics && <ChatMathematicalProgress work={compactMathematics} onTask={taskId => props.onArtifact('roadmap', { taskId })} />}
      {item && <FormalizationProgress item={item} process={solve?.process} wide={solve?.wide} onCode={() => props.onArtifact('live')} />}
      {solve && <ThinkingProcess process={solve.process} time={solve.time} onCheck={solve.onCheck} onQuestion={props.onQuestion} />}
      {solve && <SolveProcessView process={solve.process} wide={solve.wide} time={solve.time} onCheck={solve.onCheck}
        loading={solve.loading} failed={solve.failed} onRetry={solve.onRetry} />}
      {liveAvailable && !active && <button type="button" class="text-button" data-research-artifact="live" onClick={() => props.onArtifact('live')}>
        <Icon name="panel-right" />{tx('查看工作区', 'View workspace')}</button>}
      {(run && !accepted || !originalInFailure && (run || item?.report || item?.compiled)) && <div class="research-conversation-artifacts" role="group" aria-label={t('结果')}>
      {run && !accepted && <button type="button" data-research-artifact="roadmap" onClick={() => props.onArtifact('roadmap')}><Icon name="network" /><span>{t('路线图')}</span><Icon name="arrow-up-right" /></button>}
      {!originalInFailure && <button type="button" data-research-artifact="original" onClick={() => props.onArtifact('original')}><Icon name="languages" /><span>{t('原题')} / Lean</span><Icon name="arrow-up-right" /></button>}
      {run && !accepted && <button type="button" data-research-artifact="source" disabled={!proof} onClick={() => props.onArtifact('source')}><Icon name="file-code-2" /><span>{t('候选源码')}</span><Icon name="arrow-up-right" /></button>}
      </div>}
      <div class="chat-result-more-actions">{resultActions}</div>
      {simple && run && props.recovery && props.recovery.steps.length > 1 && <RecoveryChoices run={run} {...props.recovery} steps={props.recovery.steps.slice(1)} />}
      </div>
    </details>}
    <div class="chat-task-actions">
      {props.onStartResearch && !item?.humanReview && <button type="button" class="button button-primary" data-research-continue disabled={props.startingResearch} onClick={props.onStartResearch}>
        {props.startingResearch ? t('正在进入证明队列…') : t('继续证明')}</button>}
      {!accepted && !active && !statementDecision && props.onEditProblem && <button type="button" class="text-button" onClick={props.onEditProblem}>{t("修改题目")}</button>}
    </div>
    {run && props.recovery && <RecoveryChoices run={run} {...props.recovery} steps={simple ? props.recovery.steps.slice(0, 1) : props.recovery.steps} />}
  </div>;
}

function MessageTaskLinks({ message, ...props }: ChatThreadProps & { message: WebConversationMessage }) {
  const tasks = props.run?.observation?.inspection.tasks.filter(task => task.theorem && message.text.includes(task.theorem) || message.guidance?.input.taskRef?.id === task.id) ?? [];
  return tasks.length > 0 ? <div class="chat-task-links" aria-label={t('相关引理与任务')}>{tasks.map(task => <button key={task.id} type="button" class="text-button" data-chat-task-link={task.id}
    onClick={() => props.onArtifact('roadmap', { taskId: task.id, messageId: message.id })}><Icon name="network" />{task.theorem || task.objective || task.id}</button>)}</div> : null;
}

function GuidanceReceipt({ message, onGuidanceReceipt, onWithdraw, withdrawing, withdrawalNote, feedback, record, onOpenRunTask }: { message: WebConversationMessage; onGuidanceReceipt?: ChatThreadProps['onGuidanceReceipt'];
  onWithdraw?: ChatThreadProps['onWithdrawGuidance']; withdrawing?: boolean; withdrawalNote?: string; feedback?: ChatThreadProps['guidanceFeedback']; record?: WebGuidanceRecord; onOpenRunTask?:(task:{ id:string; version:string })=>void }) {
  const guidance = message.guidance!;
  const labels: Record<string, string> = { queued: t('排队中'), deferred: t('暂缓'), delivered: t('已送达'), failed: t('失败'), rejected: t('已拒绝'), unknown: t('结果尚未确认') };
  const receipt = guidance.receipt, withdrawn = receipt?.status === 'failed' && receipt.reason === 'math_guidance_withdrawn';
  const waiting = receipt && ['queued', 'deferred'].includes(receipt.status);
  return <div class="chat-guidance-receipt" data-chat-guidance-receipt={guidance.input.id} data-guidance-status={withdrawn ? 'withdrawn' : receipt?.status ?? 'pending'} role="status">
    <p><strong>{t('研究指导')}</strong> · {guidance.input.recipient.kind === 'lead' ? t('证明任务负责人') : guidance.input.recipient.id} · {withdrawn ? t('已撤回') : receipt ? labels[receipt.status] ?? receipt.status : t('正在核对回执…')}</p>
    {withdrawn ? <p>{t('Agent 不会收到这条指导。')}</p> : receipt?.reason && <p>{localizeText(receipt.reason)}</p>}
    {waiting && onWithdraw && <button class="text-button" type="button" data-chat-guidance-withdraw disabled={withdrawing}
      title={t('还没有 Agent 收到时可以撤回')} onClick={() => onWithdraw(message)}>{withdrawing ? t('正在撤回…') : t('撤回')}</button>}
    {withdrawalNote && <p class="chat-guidance-withdrawal-note" data-chat-withdrawal-note>{withdrawalNote}</p>}
    {(!receipt || receipt.status === 'unknown') && onGuidanceReceipt && <button class="text-button" type="button" data-chat-guidance-recover onClick={() => onGuidanceReceipt(message)}>{t('核对并重试原提交')}</button>}
    {!withdrawn && <GuidanceOutcome guidance={record} onOpenRunTask={onOpenRunTask} feedback={feedback?.records.find(item => item.target?.runId === guidance.runId && (item.id === guidance.input.id || item.requestId === guidance.input.id))} />}
    {feedback?.error && <details><summary>{t('后续记录读取失败')}</summary><p role="alert">{feedback.error} <button type="button" class="text-button" onClick={feedback.onRetry}>{t('重新读取')}</button></p></details>}
  </div>;
}

function ChatThread(props: ChatThreadProps & { readingArea: HTMLElement }) {
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
    {loading ? <p role="status">{t("正在读取对话…")}</p> : !error && <>
      <div class="chat-start-emblem" aria-hidden="true">
        <span class="chat-start-rule" />
        <img src="assets/mark.svg" alt="" width={18} height={18} />
        <span class="chat-start-tag mono">LEAN 4 &#xB7; ATELIER</span>
        <span class="chat-start-rule" />
      </div>
      <h1>{t("今天想证明什么？")}</h1>
    </>}
    {errorNotice}
  </div>;
  return <div class="chat-messages" data-conversation={conversation.id}>
    {conversation.messages.map(message => <article key={message.id} class={`chat-message chat-message-${message.role}`}
      data-message-id={message.id} data-message-status={message.status} aria-label={message.role === 'user' ? t("你") : 'TheoremOS'}>
      {message.role === 'assistant' && <div class="research-conversation-byline"><img src="assets/mark.svg" alt="" width={24} height={24} /><span>TheoremOS</span></div>}
      {message.kind === 'task' ? <TaskMessage {...props} /> : <>
        {message.text && <ChatMessageContent text={message.text} readingArea={props.readingArea} />}
        {message.kind === 'guidance' && message.guidance && <GuidanceReceipt message={message} onGuidanceReceipt={message.guidance.runId === conversation.runId ? props.onGuidanceReceipt : undefined} feedback={props.guidanceFeedback}
          onWithdraw={props.onWithdrawGuidance} withdrawing={props.withdrawingGuidance?.includes(message.guidance.input.id)} withdrawalNote={props.withdrawalNotes?.[message.guidance.input.id]}
          record={props.run?.observation?.guidance.find(record => record.id === message.guidance!.input.id)}
          {...(props.run?.observation?.guidance.find(record => record.id === message.guidance!.input.id)?.decision?.evidenceRefs.every(ref => ref.kind !== 'task' || props.run!.observation!.inspection.tasks.some(task => task.id === ref.id && task.version === ref.version))
            ? { onOpenRunTask: (task:{id:string;version:string}) => props.onArtifact('roadmap', { taskId: task.id, messageId: message.id }) } : {})} />}
        <MessageTaskLinks {...props} message={message} />
        {message.kind === 'text' && message.status === 'pending' && <p class="chat-answer-state" role="status"><span class="spinner" />{message.text ? t('正在回答…') : t("正在思考…")}</p>}
        {message.status === 'interrupted' && <p class="chat-answer-state">{t("已停止回答")}</p>}
        {message.kind === 'text' && message.status === 'error' && <div class="chat-error" role="alert"><p>{localizeText(message.error || t("回答未完成，请重试。"))}</p>
          {props.onRetryAnswer && conversation.messages.at(-1)?.id === message.id && <button class="text-button" type="button" onClick={() => props.onRetryAnswer?.(message)}>{t("重新回答")}</button>}</div>}
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
const chatEfforts = ['low', 'high', 'max'] as const;
export type ChatComposerProps = {
  home?: Pick<ChatThreadProps, 'overview' | 'startGuide' | 'onConfigure' | 'onFirstExample' | 'onSample'>;
  originalRecovery?(): void;
  problemDrafts?: ProblemDraftPanelProps;
  draftPersistence?: { retry(): void; download(): void };
  input: string; onInput(value: string): void; onSubmit(): void; onStop(): void;
  references?: ChatLibraryReference[]; onRemoveReference?(id: string): void;
  editedProblem?: { research?: boolean; onReturnHome(): void };
  pending: boolean; submitting: boolean; disabled: boolean; hasConversation: boolean; newProblem: boolean; sendStatus?: string;
  environment: 'standard' | 'mathlib'; effort: WebEffort; apiKey: string;
  onEnvironment(value: 'standard' | 'mathlib'): void; onEffort(value: typeof chatEfforts[number]): void; onKey(value: string): void;
  keyRequired: boolean; onExample(id: string): void; onLean(): void;
  providers: ChatProvider[]; providerId: string; model: string;
  onProvider(value: string): void; onModel(value: string): void;
  budgets: ChatBudgets; budgetLimits: ChatBudgets; onBudget(stage: 'formalization' | 'research', field: 'maxRunSeconds' | 'maxTotalTokens' | 'maxTurns', value: number): void;
  quota?: WebQuotaView;
  cost?: Pick<ResearchStartCostProps, 'owner' | 'account' | 'request'>;
  checkingConnection: boolean; connection?: { status: 'available' | 'unknown' | 'error'; message: string }; onCheckConnection(): void;
  keyManagement?: { busy: boolean; ending?: string; notice?: string; onSave(): void; onDelete(): void };
  tabKeyMemory?: { remembered: boolean; notice?: string; onChange(value: boolean): void };
  guidanceAction?: { ready: boolean; onOpen(): void };
  participation: 'guided' | 'automatic'; onParticipation(value: 'guided' | 'automatic'): void; participationLocked: boolean;
  submissionRecovery?: { busy: boolean; onRecover(): void; onPrepareEdited(): void };
  guidanceRecovery?(): void;
  guidance?: { target: string; targets: { id: string; label: string }[]; onTarget(id: string): void; onCancel(): void; onConfirmTarget?(): void };
  quote?: { count: number; onUndo(): void };
};

function ChatComposer(props: ChatComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const settings = useRef<HTMLDetailsElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState(false);
  const [showResearch, setShowResearch] = useState(false);
  const composing = useRef(false);
  const previewable = props.newProblem && Boolean(props.input.trim());
  const previewing = previewable && preview;
  const compactInput = props.hasConversation && !props.newProblem;
  const modelLocked = !props.newProblem || props.submitting;
  const missingKey = props.keyRequired && !props.apiKey.trim();
  const needsKey = !!props.input.trim() && missingKey;
  const configureKey = () => {
    if (settings.current) settings.current.open = true;
    keyInput.current?.focus();
  };
  const provider = props.providers.find(item => item.id === props.providerId);
  const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
  const modelLabel = props.model.trim() || t('配置模型');
  const effortLabel = props.effort === 'max' ? t('推理 最高') : props.effort === 'low' ? t('推理 低') : props.effort === 'high'
    ? t('推理 高') : `${t('推理强度')} · ${effortLabels[props.effort]}`;
  const researchSettingsLabel = tx('研究配置', 'Research settings');
  const revealSettings = (event: Event) => {
    const details = event.currentTarget as HTMLDetailsElement;
    if (!details.open) return;
    if (details === settings.current && document.body.dataset.chatEmpty === 'false' && matchMedia('(max-width:600px)').matches) return;
    details.querySelector('.chat-settings-fields')?.scrollIntoView({ block: 'nearest' });
  };
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
  const previewLabel = previewing ? tx('继续编辑', 'Continue editing') : tx('预览公式', 'Preview formulas');
  const switchPreview = () => {
    setPreview(!previewing);
    requestAnimationFrame(() => {
      if (previewing) textarea.current?.focus();
      else textarea.current?.closest('form')?.querySelector<HTMLElement>('[data-input-preview]')?.focus();
    });
  };
  const sendLabel = props.guidance ? t('发送研究指导') : !props.newProblem ? t('发送')
    : props.participation === 'guided' ? tx('开始核对题目', 'Start statement review') : tx('开始解题', 'Start solving');
  const shortcut = props.newProblem ? 'Control+Enter Meta+Enter' : 'Enter';
  useEffect(() => { if (!previewable) setPreview(false); }, [previewable]);
  useLayoutEffect(() => {
    const node = textarea.current;
    if (!node || previewing) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(Math.max(node.scrollHeight, compactInput ? 56 : 92), 260)}px`;
  }, [props.input, compactInput, previewing]);
  return <div class="chat-composer" data-chat-followup={compactInput || undefined}>
    <form id="formalize-form" onSubmit={event => event.preventDefault()}>
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
      {props.guidanceAction && <div class="chat-message-destination" role="group" aria-label={t('消息用途')}>
        <button type="button" data-chat-discussion-mode aria-pressed={!props.guidance} disabled={props.submitting} title={t('提问和讨论，不会送到 Agent')} onClick={() => props.guidance?.onCancel()}>{t('讨论思路')}</button>
        <button type="button" data-chat-guidance-mode-open aria-pressed={Boolean(props.guidance)}
          disabled={props.submitting || !props.guidanceAction.ready} aria-describedby={props.guidanceAction.ready ? undefined : 'chat-guidance-wait'}
          title={t('不必停止解题：指导会送到正在工作的 Agent')} onClick={props.guidanceAction.onOpen}>{t('指导 Agent')}</button>
        {!props.guidanceAction.ready && <span id="chat-guidance-wait">{tx('计划就绪后可指导', 'Available when the plan is ready')}</span>}
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
      <label class="sr-only" for="formalize-original">{props.hasConversation ? t("继续对话") : t("自然语言或 TeX 原题")}</label>
      <textarea ref={textarea} id="formalize-original" rows={compactInput ? 1 : 3} value={props.input} spellcheck={false}
        hidden={previewing}
        placeholder={props.guidance ? t('建议证明方法，或指出需要调整的引理…') : props.guidanceAction
          ? tx('讨论这道题…', 'Discuss this problem…') : props.hasConversation ? t('继续提问…') : tx('自然语言或 TeX…', 'Natural language or TeX…')}
        onInput={event => props.onInput(event.currentTarget.value)}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || composing.current || event.keyCode === 229 || matchMedia('(pointer: coarse)').matches) return;
          if (props.newProblem ? !event.ctrlKey && !event.metaKey : event.ctrlKey || event.metaKey) return;
          event.preventDefault(); if (canSend) props.onSubmit(); else if (missingKey && props.input.trim() && !props.disabled && !props.submitting) configureKey();
        }} />
      {previewing && <section class="chat-input-preview" data-input-preview tabIndex={0} aria-label={tx('原题公式预览', 'Problem formula preview')}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); switchPreview(); }
        }}>
        <RichProse text={props.input} />
      </section>}
      {props.draftPersistence && <div class="chat-error" role="alert" data-chat-draft-save-error>
        <p>{tx('草稿尚未保存，刷新或关闭页面会丢失当前输入。请先下载原题，或重试保存。', 'Your draft has not been saved. Reloading or closing this page will lose your input. Download the problem or retry saving first.')}</p>
        <button type="button" class="text-button" data-retry-chat-draft onClick={props.draftPersistence.retry}>{tx('重试保存', 'Retry saving')}</button>{' '}
        <button type="button" class="text-button" data-download-chat-draft onClick={props.draftPersistence.download}>{tx('下载原题', 'Download problem')}</button>
      </div>}
      {props.originalRecovery && <div class="chat-send-status" data-original-recovery role="status"><span>{tx('上一份原题与配置已保留。', 'Your previous problem and settings are kept.')} </span>
        <button type="button" class="text-button" data-recover-original disabled={props.submitting} onClick={props.originalRecovery}>{tx('恢复上一份原题', 'Restore previous problem')}</button></div>}
      <div class="chat-composer-toolbar">
        <details id="chat-model-settings" name="chat-composer-settings" class="chat-composer-settings" onToggle={revealSettings}>
          <summary title={`${t('模型设置')} · ${modelLabel} · ${effortLabel}`}>
          <span class="chat-model-label" translate={props.model.trim() ? false : undefined}>{modelLabel}</span>
          <span class="chat-model-effort" data-chat-model-effort={props.effort}>{effortLabel}</span>
          <Icon name="chevron-down" /></summary>
          <div class="chat-settings-fields chat-model-fields">
            <label for="formalize-provider">{t('模型服务商')}<select id="formalize-provider" value={props.providerId}
              onChange={event => props.onProvider(event.currentTarget.value)} disabled={modelLocked}>
              {!provider && <option value={props.providerId} disabled>{props.providerId ? `${props.providerId} · ` : ''}{t('请选择可用的服务商')}</option>}
              {props.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
            <label for="formalize-model">{t('模型')}<input id="formalize-model" type="text" value={props.model} spellcheck={false}
              onInput={event => props.onModel(event.currentTarget.value)} disabled={modelLocked} required maxlength={160}
              list="chat-model-options" /></label>
            <datalist id="chat-model-options">{provider?.defaultModel && <option value={provider.defaultModel} />}</datalist>
            <label for="formalize-effort">{t('推理强度')}<select id="formalize-effort" value={props.effort} disabled={modelLocked}
              onChange={event => props.onEffort(event.currentTarget.value as typeof chatEfforts[number])}>
              {chatEfforts.map(effort => <option key={effort} value={effort}>{effortLabels[effort]}</option>)}
              {!chatEfforts.some(effort => effort === props.effort) && <option value={props.effort}>{effortLabels[props.effort]}</option>}
            </select></label>
          </div>
        </details>
        <details ref={settings} id="formalize-settings" name="chat-composer-settings" class="chat-composer-settings" onToggle={revealSettings}>
          <summary class="chat-toolbar-control" data-chat-configure-key={needsKey || undefined}
            onClick={event => { if (needsKey && !settings.current?.open) { event.preventDefault(); configureKey(); } }}
            title={needsKey ? `${researchSettingsLabel} · ${tx('填写 API Key', 'Enter API key')}` : researchSettingsLabel}
            aria-label={needsKey ? tx('填写 API Key', 'Enter API key') : researchSettingsLabel}>
            <Icon name={needsKey ? 'key-round' : 'sliders-horizontal'} /><span class="chat-control-label">{needsKey ? tx('填写 Key', 'Enter key') : researchSettingsLabel}</span>
          </summary>
          <div class="chat-settings-fields">
            <header class="chat-research-settings-heading">
              <strong>{researchSettingsLabel}</strong>
              <button type="button" class="text-button" data-chat-close-settings onClick={() => {
                if (settings.current) settings.current.open = false;
                if (textarea.current && !textarea.current.hidden) textarea.current.focus();
                else settings.current?.querySelector('summary')?.focus();
              }}>{tx('返回输入', 'Back to input')}</button>
            </header>
            <div class="chat-connection-fields">
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
            {props.tabKeyMemory && <div class="chat-tab-key-memory">
              <label><input type="checkbox" checked={props.tabKeyMemory.remembered}
                disabled={!props.apiKey.trim() && !props.tabKeyMemory.remembered} onChange={event => props.tabKeyMemory?.onChange(event.currentTarget.checked)} />
                {t('在此标签页记住')}</label>
              {props.tabKeyMemory.notice && <p class="field-note" role="status">{props.tabKeyMemory.notice}</p>}
            </div>}
            <div class="chat-connection-check"><button type="button" class="button" id="check-model-connection" onClick={props.onCheckConnection}
              title={t('通过模型列表检查连接')}
              disabled={props.checkingConnection || !props.model.trim() || props.keyRequired && !props.apiKey.trim()}>{props.checkingConnection ? t('正在检查连接…') : t('检查 Key 与模型')}</button></div>
            {props.connection && <p class="field-note" id="chat-connection-result" role="status" data-status={props.connection.status}>{props.connection.message}</p>}
            </div>
            {props.newProblem && <fieldset class="chat-participation" data-chat-participation disabled={props.submitting || props.participationLocked}>
              <legend>{t('研究方式')}</legend>
              <label><input type="radio" name="chat-participation" value="guided" checked={props.participation === 'guided'} onChange={() => props.onParticipation('guided')} />
                <span><strong>{t('共同推进')}</strong><span>{t('题意和初始计划由你确认 · 2 个 Agent')}</span></span></label>
              <label><input type="radio" name="chat-participation" value="automatic" checked={props.participation === 'automatic'} onChange={() => props.onParticipation('automatic')} />
                <span><strong>{t('自动推进')}</strong><span>{t('自动核对并开始证明 · 1 个 Agent')}</span></span></label>
            </fieldset>}
            <details class="chat-advanced-settings" data-chat-advanced-settings><summary>{tx('环境与预算', 'Environment and limits')}</summary>
              <div class="chat-advanced-settings-fields">
              <div class="chat-settings-options"><label for="formalize-environment">{t("证明环境")}<select id="formalize-environment" value={props.environment} onChange={event => props.onEnvironment(event.currentTarget.value as ChatComposerProps['environment'])} disabled={props.hasConversation}><option value="mathlib">{t('TheoremOS 数学环境')}</option><option value="standard" hidden>{t('Lean 标准库')}</option></select></label></div>
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
            {props.newProblem && <FirstResearchStart participation={props.participation} budgets={props.budgets}
              cost={props.cost && { ...props.cost, providerId: props.providerId, model: props.model }}
              locked={props.submitting || props.participationLocked} quota={props.quota} onAdjust={() => focusBudget('formalize-minutes')} />}
            {!props.hasConversation && <button class="text-button chat-lean-entry" type="button" onClick={() => {
              if (settings.current) settings.current.open = false;
              props.onLean();
            }}>{tx('已有 Lean 代码？打开编辑器', 'Have Lean code? Open the editor')}<Icon name="chevron-right" /></button>}
          </div>
        </details>
        {previewable && <button type="button" class="chat-toolbar-control" data-input-view={previewing ? 'edit' : 'preview'}
          aria-label={previewLabel} title={previewLabel} onClick={switchPreview}>
          <Icon name={previewing ? 'square-pen' : 'eye'} /><span class="chat-control-label">{previewLabel}</span>
        </button>}
        <div class="chat-composer-submit">{props.pending ? <button id="chat-stop" type="button" class="chat-send" onClick={props.onStop} aria-label={t("停止回答")} title={t("停止回答")}><Icon name="square" /></button>
          : <button id="formalize-start" type="button" class={`chat-send${props.newProblem ? ' chat-send-start' : ''}`} disabled={!canSend}
            onClick={event => { if (event.currentTarget.form?.reportValidity()) props.onSubmit(); }}
            aria-label={sendLabel} aria-keyshortcuts={shortcut}
            title={`${sendLabel} (${props.newProblem ? 'Ctrl / ⌘ + Enter' : 'Enter'})`}>
            {props.newProblem && <span class="chat-send-label">{sendLabel}</span>}{props.submitting ? <span class="spinner" /> : <Icon name="arrow-up" />}</button>}</div>
      </div>
    </form>
    {props.guidanceRecovery && <div class="chat-send-status" data-chat-guidance-recovery role="status">
      <span>{tx('上一条指导的发送结果尚未确认。', 'The last guidance submission is unconfirmed.')}</span>{' '}
      <button type="button" class="text-button" data-chat-guidance-retry disabled={props.submitting} onClick={props.guidanceRecovery}>{t('核对并重试原提交')}</button>
    </div>}
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
    {props.newProblem && <div class="chat-home-options"><details class="chat-examples" data-chat-examples><summary data-chat-first-example>{t("试试例题")}<Icon name="chevron-down" /></summary>
      <div class="chat-examples-content"><label class="sr-only" for="formalize-example">{t("选择自然语言例题")}</label><select id="formalize-example" value="" onChange={event => { props.onExample(event.currentTarget.value); event.currentTarget.value = ''; textarea.current?.focus(); }}><option value="">{t("选择一个题目")}</option>{researchExamples.map(example => <option key={example.id} value={example.id}>{locale === 'en' ? example.nameEn : example.name}</option>)}</select>
      {props.home?.startGuide && <button type="button" class="text-button" data-start-prepare onClick={props.home.startGuide.onTemplate}>{tx('填写命题模板', 'Use a statement template')}</button>}
      {props.home?.onSample && <button type="button" class="text-button chat-start-sample" data-chat-sample title={t('无需 API Key')} onClick={props.home.onSample}>{t('查看完整示例')}<Icon name="arrow-up-right" /></button>}
      </div>
    </details>
    {props.home?.overview && <details class="chat-saved-research" data-chat-research-overview onToggle={event => setShowResearch(event.currentTarget.open)}>
      <summary>{tx('继续已有研究', 'Continue previous research')}<Icon name="chevron-down" /></summary>
      {showResearch && <ResearchOverview key={props.home.overview.owner} {...props.home.overview} />}
    </details>}
    </div>}
    {props.problemDrafts && (props.problemDrafts.account || props.problemDrafts.target) && <div key={props.problemDrafts.owner}>
      <ProblemDraftPanel {...props.problemDrafts} />
    </div>}
  </div>;
}

export type ChatHistoryProps = {
  items: WebConversationSummary[]; selectedId?: string; onOpen(id: string): void; failed?: boolean; onRetry?(): void;
  runs?: readonly WebRun[];
  onRename(id: string, title: string): Promise<void>; onDelete(id: string): Promise<void>;
  records: WebFormalization[]; recordLimit: number; onDeleteRecord(id: string): Promise<void>; onRefreshRecords(): void;
};
type HistoryGroup = 'waiting' | 'running' | 'recent';
function ChatHistory(props: ChatHistoryProps) {
  const { items, selectedId, onOpen, failed, onRetry } = props;
  const search = useRef<HTMLInputElement>(null);
  const editForm = useRef<HTMLFormElement>(null);
  const editTrigger = useRef<HTMLElement>();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ id: string; action: 'rename' | 'delete' | 'record'; title: string; group?: HistoryGroup }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const matching = items.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const decisions = new Map<string, string>();
  for (const item of matching) {
    if (item.runId) {
      const run = props.runs?.find(run => run.id === item.runId);
      const pending = run && planAwaitingApproval(run);
      if (pending && !pending.leadRevising) decisions.set(item.id, t('研究计划等你批准'));
      continue;
    }
    if (!item.formalizationId) continue;
    const record = props.records.find(record => record.id === item.formalizationId);
    // The index omits the report; its recorded lifecycle identifies the pending human action.
    if (!record?.humanReview || record.runId) continue;
    if (record.status === 'review') decisions.set(item.id, t('等你确认题意'));
    else if (record.status === 'confirmed') decisions.set(item.id, t('继续拟定研究计划'));
  }
  // Work still moving is pinned below decisions, so it is found without scanning the dated list.
  const running = new Set(matching.filter(item => {
    if (decisions.has(item.id)) return false;
    const run = props.runs?.find(run => run.id === item.runId);
    if (run) return ['queued', 'running'].includes(run.status);
    const record = props.records.find(record => record.id === item.formalizationId);
    return record ? ['queued', 'running'].includes(record.status) : item.answering;
  }).map(item => item.id));
  const groupFor = (id: string): HistoryGroup => decisions.has(id) ? 'waiting' : running.has(id) ? 'running' : 'recent';
  const groups: Record<HistoryGroup, WebConversationSummary[]> = { waiting: [], running: [], recent: [] };
  // A live status change can move the row after editing, without replacing the focused input.
  for (const item of matching) {
    const group = item.id === editing?.id ? editing.group ?? groupFor(item.id) : groupFor(item.id);
    groups[group].push(item);
  }
  useLayoutEffect(() => {
    editForm.current?.querySelector<HTMLElement>('[data-chat-title], [data-chat-history-cancel]')?.focus();
  }, [editing?.id, editing?.action]);
  const edit = (id: string, action: 'rename' | 'delete' | 'record', title: string, trigger?: HTMLElement) => {
    editTrigger.current = trigger;
    setEditing({ id, action, title, group: action === 'record' ? undefined : groupFor(id) });
    setError('');
    setNotice('');
  };
  const finishEdit = () => {
    const trigger = editTrigger.current, form = editForm.current;
    setEditing(undefined);
    setError('');
    editTrigger.current = undefined;
    if (form?.contains(document.activeElement) || document.activeElement === document.body) {
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body && document.activeElement !== trigger) return;
        const movedTrigger = editing?.group && search.current?.closest('.chat-history')?.querySelector<HTMLElement>(
          `[data-chat-row="${CSS.escape(editing.id)}"] [data-chat-row-actions]`,
        );
        const target = trigger?.isConnected && !trigger.matches(':disabled') ? trigger : movedTrigger || search.current;
        target?.focus();
      });
    }
  };
  const apply = async () => {
    if (!editing || busy) return;
    setBusy(true); setError('');
    try {
      if (editing.action === 'rename') await props.onRename(editing.id, editing.title);
      else if (editing.action === 'delete') await props.onDelete(editing.id);
      else { await props.onDeleteRecord(editing.id); setNotice(t('题目记录已删除，对话仍保留。')); }
      finishEdit();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const confirmation = (id: string) => editing?.id === id && <form ref={editForm} class="chat-history-edit"
    onSubmit={event => { event.preventDefault(); void apply(); }} onKeyDown={event => {
      if (event.key !== 'Escape' || busy || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      finishEdit();
    }}>
    {editing.action === 'rename' ? <label>{t('对话标题')}<input data-chat-title value={editing.title} maxlength={80} required disabled={busy}
      onInput={event => setEditing({ ...editing, title: event.currentTarget.value })} /></label>
      : <p>{editing.action === 'delete' ? t('只删除这段对话，题目、证明任务和分享链接仍保留。') : t('删除这份题目与形式化审核记录？对话记录仍保留。')}</p>}
    <div><button type="submit" class="button" data-chat-history-confirm disabled={busy || !editing.title.trim()}>{busy ? t('正在处理…') : editing.action === 'rename' ? t('保存') : t('确认删除')}</button>
      <button type="button" class="text-button" data-chat-history-cancel disabled={busy} onClick={finishEdit}>{t('取消')}</button></div>
    {error && <p class="chat-history-error" role="alert">{error}</p>}
  </form>;
  const rows = (entries: WebConversationSummary[]) => entries.map(item => {
    const run = props.runs?.find(run => run.id === item.runId);
    const record = props.records.find(record => record.id === item.formalizationId);
    const decision = decisions.get(item.id);
    const active = running.has(item.id);
    const failed = run ? isFaultedRun(run) || isRejectedRun(run) : record?.status === 'error' || record?.status === 'exhausted';
    const accepted = run && isAcceptedRun(run);
    const status = active ? run ? runProgress(run).phaseLabel : item.answering ? t('正在回答') : t('形式化进行中')
      : failed ? run ? t('研究未完成') : t('形式化未完成') : undefined;
    const chooseAction = (event: Event, action: 'rename' | 'delete') => {
      const menu = (event.currentTarget as HTMLElement).closest('details');
      if (menu) menu.open = false;
      edit(item.id, action, item.title, menu?.querySelector('summary') ?? undefined);
    };
    return <div key={item.id} class="chat-history-row" data-chat-row={item.id}>
      <a href={`?chat=${encodeURIComponent(item.id)}`} class="chat-history-item" aria-current={item.id === selectedId ? 'page' : undefined}
        title={item.title}
        onClick={event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpen(item.id); }}>
        <span class="chat-history-copy"><span class="chat-history-title" translate={false}><Rich text={item.title} /></span>
          {decision ? <span class="chat-history-status" data-chat-awaiting>{decision}</span>
            : status && <span class="chat-history-status" data-chat-history-status data-tone={failed ? 'danger' : 'running'}>{status}</span>}
        </span>
        {active && item.answering && <span class="spinner" aria-hidden="true" />}
        {accepted && !active && <span class="chat-history-verified" role="img" aria-label={t('证明已验收')} title={t('证明已验收')}><Icon name="check" /></span>}
      </a>
      <details class="chat-history-actions" name="chat-history-actions"
        onToggle={event => {
          if (event.currentTarget.open) event.currentTarget.querySelector('.chat-history-menu')?.scrollIntoView({ block: 'nearest' });
        }}
        onFocusOut={event => {
          const next = event.relatedTarget;
          if (next instanceof Node && !event.currentTarget.contains(next)) event.currentTarget.open = false;
        }}>
        <summary class="icon-button" data-chat-row-actions aria-label={t('对话操作')} title={t('对话操作')}><Icon name="ellipsis" /></summary>
        <div class="chat-history-menu">
          <button type="button" class="run-menu-item" data-chat-rename disabled={busy} onClick={event => chooseAction(event, 'rename')}><Icon name="square-pen" />{t('重命名对话')}</button>
          <button type="button" class="run-menu-item danger" data-chat-delete disabled={busy} onClick={event => chooseAction(event, 'delete')}><Icon name="trash-2" />{t('删除对话')}</button>
          <time class="chat-history-time" dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
        </div>
      </details>
      {confirmation(item.id)}
    </div>;
  });
  return <nav class="chat-history" aria-label={t("对话历史")}>
    <label class="chat-history-search"><span class="sr-only">{t('搜索对话标题')}</span><Icon name="search" /><input ref={search} type="search" data-chat-search placeholder={t('搜索对话标题')} value={query} onInput={event => setQuery(event.currentTarget.value)} /></label>
    {items.length ? matching.length ? <>
      {groups.waiting.length > 0 && <section class="chat-history-waiting" data-chat-waiting aria-label={t('等你处理')}>
        <p class="chat-history-heading">{t('等你处理')}</p>
        {rows(groups.waiting)}
      </section>}
      {groups.running.length > 0 && <section class="chat-history-running" data-chat-running aria-label={t('运行中')}>
        <p class="chat-history-heading">{t('运行中')}</p>
        {rows(groups.running)}
      </section>}
      {groups.recent.length > 0 && groups.recent.length < matching.length && <p class="chat-history-heading" data-chat-recent>{t('最近')}</p>}
      {rows(groups.recent)}
    </> : <p class="chat-history-empty">{t('没有匹配的对话')}</p>
      : failed ? <p class="chat-history-empty" role="alert">{t("对话列表暂时没有加载出来。")}<button type="button" class="text-button" data-chat-history-retry onClick={onRetry}>{t("重试")}</button></p>
      : <p class="chat-history-empty">{t("还没有对话")}</p>}
    <details id="chat-problem-records" class="chat-problem-records" onToggle={event => { if (event.currentTarget.open) props.onRefreshRecords(); }}>
      <summary>{t('管理题目记录')}<span>{props.records.length} / {props.recordLimit}</span></summary>
      <p class="chat-history-empty">{t('记录满后可在这里清理。有研究使用的题目，需要先删除关联研究。')}</p>
      {props.records.map(item => <div class="chat-problem-record" key={item.id} data-chat-record={item.id}>
        <a href={`formalize.html?id=${encodeURIComponent(item.id)}`} target="_blank" rel="noreferrer" translate={false}><Rich text={item.original} inline /></a>
        <div>{item.runId && <a class="text-button" href={`?run=${encodeURIComponent(item.runId)}`}>{t('查看关联研究')}</a>}
          <button type="button" class="text-button" data-chat-delete-record disabled={busy || ['queued', 'running'].includes(item.status)} onClick={event => edit(item.id, 'record', item.original, event.currentTarget)}>{t('删除题目')}</button></div>
        {confirmation(item.id)}
      </div>)}
      {!props.records.length && <p class="chat-history-empty">{t('还没有形式化记录。')}</p>}
      {notice && <p class="chat-history-empty" role="status">{notice}</p>}
    </details>
  </nav>;
}

export function renderChatThread(root: HTMLElement, props: ChatThreadProps) { render(<ChatThread {...props} readingArea={root} />, root); }
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
