import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { WebConversation, WebConversationMessage, WebConversationSummary } from '../../conversationTypes';
import type { WebFormalization } from '../../formalizationTypes';
import type { WebProvider, WebRun } from '../../shared';
import { researchExamples } from '../../problemExamples';
import { formatTokens, isAcceptedRun, isFaultedRun, isRejectedRun, resultDescription, runProgress, stoppedLabel } from '../../presentation';
import { acceptedTitle, statementConfirmation } from '../../presentation';
import type { NextStep } from '../../report';
import { locale, localizeText, t } from '../../i18n';
import type { SolveProcess } from '../solveProcess';
import { formalizationReasonText } from '../formalizationReasons';
import { Icon } from './Icon';
import { ChatMessageContent } from './ChatMessageContent';
import { Elapsed, SolveProcessView } from './SolveProcess';


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
  onArtifact(kind: 'roadmap' | 'original' | 'source' | 'live' | 'result', target?: { taskId?: string; messageId?: string }, auto?: boolean): void;
  onShare?(): void;
  recovery?: { steps: NextStep[]; onAction(id: string, button: HTMLButtonElement): void };
  onGuidance?(text?: string, taskId?: string): void;
  onGuidanceReceipt?(message: WebConversationMessage): void;
  onEditProblem?(): void;
  onCancelTask?(): void;
  onStartResearch?(): void;
  startingResearch?: boolean;
  onRetry?(): void;
  onConfigure?(): void;
  onFirstExample?(): void;
  onSample?(): void;
  onManageRecords?(): void;
};

/** Where a formalization stopped, why, what was kept and what the reader can do; the code is the diagnostic. */
function FormalizationFailure({ item }: { item: WebFormalization }) {
  const code = item.researchError || item.reason!;
  const phases: Record<string, string> = { queued: t("等待开始"), preparing: t("准备证明环境"), planning: t("理解题目与定义"),
    generating: t("生成 Lean 陈述"), compiling: t("检查 Lean 陈述"), translating: t("核对自然语言与 Lean"),
    reviewing: t("审核原题一致性"), finishing: t("整理形式化结果") };
  const stage = item.researchError ? t('启动证明研究') : phases[item.progress?.phase ?? ''] ?? t('形式化');
  const kept = item.report ? t('已保存这次生成的 Lean 陈述与检查记录，可在“原题 / Lean”中查看。') : t('没有保存可用的 Lean 陈述。');
  return <details class="chat-task-details" data-formalization-failure open>
    <summary>{t("查看详情")}</summary>
    <dl>
      <dt>{t('停止阶段')}</dt><dd>{stage}</dd>
      <dt>{t('原因')}</dt><dd>{formalizationReasonText(code)}</dd>
      <dt>{t('保留成果')}</dt><dd>{kept}</dd>
      <dt>{t('下一步')}</dt><dd>{item.researchError ? t('保留这份陈述，点击「继续证明」重新进入证明队列。') : t('修改题目后重新发送；不会自动重试。')}</dd>
      <dt>{t('诊断编号')}</dt><dd><code>{code}</code></dd>
    </dl>
  </details>;
}

function TaskMessage(props: ChatThreadProps) {
  const { run, formalization: item } = props;
  const active = run ? ['queued', 'running'].includes(run.status) : !!item && ['queued', 'running'].includes(item.status);
  const accepted = !!run && isAcceptedRun(run);
  const natural = !!(item || run?.formalization);
  const confirmation = item?.confirmation ?? run?.formalization?.confirmation;
  const failed = run ? isFaultedRun(run) || isRejectedRun(run) : !!item && (['error', 'exhausted'].includes(item.status) || !!item.researchError);
  const phaseNames: Record<string, string> = {
    queued: t("等待开始"), preparing: t("准备证明环境"),
    planning: t("理解题目与定义"), generating: t("生成 Lean 陈述"),
    compiling: t("检查 Lean 陈述"), translating: t("核对自然语言与 Lean"),
    reviewing: t("审核原题一致性"), finishing: t("整理形式化结果"),
  };
  const title = run ? accepted ? acceptedTitle(run) : active ? runProgress(run).phaseLabel
    : run.status === 'cancelled' ? t('已取消') : failed ? t('运行失败') : stoppedLabel(run)
    : failed ? t("形式化未完成") : item?.status === 'cancelled' ? t('已取消')
      : active ? phaseNames[item?.progress?.phase ?? 'queued']
        : item?.status === 'review' ? t("陈述待核对")
          : item?.status === 'confirmed' ? t("陈述已确认") : props.missingTask ? t('关联任务记录已删除') : t("正在读取任务");
  const description = props.missingTask ? t('原题和对话仍保留，可以修改题目后重新发送。') : run ? accepted && natural ? t('冻结的 Lean 陈述已通过独立验收；原文与陈述的对应关系见形式化审核。') : resultDescription(run) : failed
    ? item?.researchError ? t("Lean 陈述已生成，但证明研究未能启动。")
      : t("本次未能完成原题形式化，可查看详情后修改题目重试。")
    : item?.status === 'cancelled' ? t("任务已停止，已保存的消息仍可查看。")
      : active ? t("先把原题转成 Lean，核对一致性后继续证明。")
        : t("陈述检查不代表证明通过，最终结果以 Lean 独立验收为准。");
  const proof = run?.result?.proof || run?.artifact?.source;
  const solve = props.solve, wide = solve?.wide && solve.process.active;
  return <div class="chat-task">
    {props.sample && <p class="sample-note" data-chat-sample-note>{t('预设示例 · 附 Lean 验收记录')}</p>}
    <div class="research-conversation-status" data-active={active} data-accepted={accepted} data-failed={failed}>
      <p class="research-conversation-state" role="status" aria-atomic="true">
        <Icon name={accepted ? 'circle-check' : failed ? 'circle-alert' : active ? 'clock-3' : 'square'} /><strong>{title}</strong></p>
      {solve && <p class="research-conversation-meta">
        {solve.process.startedAt && <Elapsed from={solve.process.startedAt} to={solve.process.endedAt} />}
        {solve.process.tokens !== undefined && <span>{t('Token {0}', formatTokens(solve.process.tokens))}</span>}
        {wide && <button type="button" class="text-button" data-research-artifact="live" onClick={() => props.onArtifact('live')}>
          <Icon name="panel-right" />{t('实时工作区')}</button>}
        {active && props.onCancelTask && <button type="button" class="text-button" data-research-stop onClick={props.onCancelTask}>{t("停止解题")}</button>}
      </p>}
      <p class="research-conversation-description">{description}</p>
      {natural && (item?.report || run?.formalization) && <p class="chat-statement-verdict" data-statement-verdict>
        {statementConfirmation(confirmation)}
        {' '}{t('Lean 验收证明的是这份陈述，不能替代对自然语言原意的核对。')}
      </p>}
    </div>
    {solve && <SolveProcessView process={solve.process} wide={solve.wide} time={solve.time} onCheck={solve.onCheck}
      loading={solve.loading} failed={solve.failed} onRetry={solve.onRetry} />}
    {!run && failed && item && (item.reason || item.researchError) && <FormalizationFailure item={item} />}
    {(run || item?.report) && <div class="research-conversation-artifacts" role="group" aria-label={t('结果')}>
      {run && <button type="button" data-research-artifact="roadmap" onClick={() => props.onArtifact('roadmap')}><Icon name="network" /><span>{t('路线图')}</span><Icon name="arrow-up-right" /></button>}
      <button type="button" data-research-artifact="original" onClick={() => props.onArtifact('original')}><Icon name="languages" /><span>{t('原题')} / Lean</span><Icon name="arrow-up-right" /></button>
      {run && <button type="button" data-research-artifact="source" disabled={!proof} onClick={() => props.onArtifact('source')}><Icon name="file-code-2" /><span>{accepted ? t('验收证明') : t('候选源码')}</span><Icon name="arrow-up-right" /></button>}
    </div>}
    <div class="chat-task-actions">
      {run && !active && <>
        <button type="button" class="button" data-research-artifact="result" onClick={() => props.onArtifact('result')}>
          <Icon name="shield-check" />{accepted ? t('查看验收报告') : t('查看原因与报告')}</button>
        {accepted && <>
          <a class="button" data-chat-explain href={`explain.html?${new URLSearchParams({ run: run.id })}`} target="_blank" rel="noopener">{t('Lean → 自然语言')}</a>
          <a class="button" data-chat-download-kit href={`/api/runs/${encodeURIComponent(run.id)}/verification-kit`} download>{t('下载本地复核包')}</a>
          {props.onShare && <button type="button" class="button" data-chat-share onClick={props.onShare}><Icon name="share-2" />{t('分享研究成果')}</button>}
        </>}
        {!accepted && <a class="text-button" href={`/api/runs/${encodeURIComponent(run.id)}/download`} download>{t('下载运行档案')}</a>}
        {props.recovery?.steps.map(step => <button key={step.id} type="button" class="button" data-chat-recovery={step.id}
          onClick={event => props.recovery!.onAction(step.id, event.currentTarget)}>{step.label}</button>)}
      </>}
      {props.onStartResearch && <button type="button" class="button button-primary" data-research-continue disabled={props.startingResearch} onClick={props.onStartResearch}>
        {props.startingResearch ? t('正在进入证明队列…') : t('继续证明')}</button>}
      {active && run && props.onGuidance && <button type="button" class="text-button" data-research-guidance onClick={() => props.onGuidance?.()}>{t('补充证明要求')}</button>}
      {!active && props.onEditProblem && <button type="button" class="text-button" onClick={props.onEditProblem}>{t("修改题目")}</button>}
    </div>
  </div>;
}

function MessageTaskLinks({ message, ...props }: ChatThreadProps & { message: WebConversationMessage }) {
  const tasks = props.run?.observation?.inspection.tasks.filter(task => task.theorem && message.text.includes(task.theorem) || message.guidance?.input.taskRef?.id === task.id) ?? [];
  return tasks.length > 0 ? <div class="chat-task-links" aria-label={t('相关引理与任务')}>{tasks.map(task => <button type="button" class="text-button" data-chat-task-link={task.id}
    onClick={() => props.onArtifact('roadmap', { taskId: task.id, messageId: message.id })}><Icon name="network" />{task.theorem || task.objective || task.id}</button>)}</div> : null;
}

function GuidanceReceipt({ message, onGuidanceReceipt }: { message: WebConversationMessage; onGuidanceReceipt?: ChatThreadProps['onGuidanceReceipt'] }) {
  const guidance = message.guidance!;
  const labels: Record<string, string> = { queued: t('排队中'), deferred: t('暂缓'), delivered: t('已送达'), failed: t('失败'), rejected: t('已拒绝'), unknown: t('结果尚未确认') };
  const receipt = guidance.receipt;
  return <div class="chat-guidance-receipt" data-chat-guidance-receipt={guidance.input.id} data-guidance-status={receipt?.status ?? 'pending'} role="status">
    <p><strong>{t('证明要求')}</strong> · {guidance.input.recipient.kind === 'lead' ? t('证明任务负责人') : guidance.input.recipient.id} · {receipt ? labels[receipt.status] ?? receipt.status : t('正在核对回执…')}</p>
    {receipt?.reason && <p>{localizeText(receipt.reason)}</p>}
    {(!receipt || receipt.status === 'unknown') && onGuidanceReceipt && <button class="text-button" type="button" data-chat-guidance-recover onClick={() => onGuidanceReceipt(message)}>{t('核对并重试原提交')}</button>}
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
      <div class="chat-start-actions">
        <button type="button" class="button" data-chat-configure onClick={props.onConfigure}><Icon name="sliders-horizontal" />{t('配置模型')}</button>
        <button type="button" class="button" data-chat-first-example onClick={props.onFirstExample}><Icon name="plus" />{t('试一道简单题')}</button>
      </div>
      {props.onSample && <button type="button" class="text-button chat-start-sample" data-chat-sample title={t('无需 API Key')} onClick={props.onSample}>{t('查看完整示例')}<Icon name="arrow-up-right" /><span>{t('免费浏览')}</span></button>}
    </>}
    {errorNotice}
  </div>;
  return <div class="chat-messages" data-conversation={conversation.id}>
    {conversation.messages.map(message => <article key={message.id} class={`chat-message chat-message-${message.role}`}
      data-message-id={message.id} data-message-status={message.status} aria-label={message.role === 'user' ? t("你") : 'TheoremOS'}>
      {message.role === 'assistant' && <div class="research-conversation-byline"><img src="assets/mark.svg" alt="" width={24} height={24} /><span>TheoremOS</span></div>}
      {message.kind === 'task' ? <TaskMessage {...props} /> : <>
        {message.text && <ChatMessageContent text={message.text} />}
        {message.kind === 'guidance' && message.guidance && <GuidanceReceipt message={message} onGuidanceReceipt={props.onGuidanceReceipt} />}
        <MessageTaskLinks {...props} message={message} />
        {message.kind === 'text' && message.status === 'pending' && <p class="chat-answer-state" role="status"><span class="spinner" />{message.text ? t('正在回答…') : t("正在思考…")}</p>}
        {message.status === 'interrupted' && <p class="chat-answer-state">{t("已停止回答")}</p>}
        {message.kind === 'text' && message.status === 'error' && <div class="chat-error" role="alert"><p>{localizeText(message.error || t("回答未完成，请重试。"))}</p>
          {props.onRetry && conversation.messages.at(-1)?.id === message.id && <button class="text-button" type="button" onClick={props.onRetry}>{t("重新回答")}</button>}</div>}
        {message.truncated && <p class="chat-answer-state">{t("回答已达到长度上限，可继续追问。")}</p>}
        {message.kind === 'text' && message.role === 'user' && message.id !== conversation.messages[0]?.id && props.onGuidance
          && <button type="button" class="text-button chat-message-action" data-chat-use-guidance onClick={() => props.onGuidance?.(message.text)}>{t('作为证明要求')}</button>}
      </>}
    </article>)}
    {errorNotice}
  </div>;
}

export type ChatBudgets = { maxRunSeconds: number; maxTotalTokens: number; research: { maxRunSeconds: number; maxTotalTokens: number; maxTurns: number } };
export type ChatProvider = WebProvider & { defaultModel: string; key: 'required' | 'saved' | 'server'; keyUrl?: string };
export type ChatComposerProps = {
  input: string; onInput(value: string): void; onSubmit(): void; onStop(): void;
  pending: boolean; submitting: boolean; disabled: boolean; hasConversation: boolean; sendStatus?: string;
  environment: 'standard' | 'mathlib'; effort: 'low' | 'high' | 'max'; apiKey: string;
  onEnvironment(value: 'standard' | 'mathlib'): void; onEffort(value: 'low' | 'high' | 'max'): void; onKey(value: string): void;
  keyRequired: boolean; onExample(id: string): void; onLean(): void;
  providers: ChatProvider[]; providerId: string; model: string;
  onProvider(value: string): void; onModel(value: string): void;
  budgets: ChatBudgets; budgetLimits: ChatBudgets; onBudget(stage: 'formalization' | 'research', field: 'maxRunSeconds' | 'maxTotalTokens' | 'maxTurns', value: number): void;
  checkingConnection: boolean; connection?: { status: 'available' | 'unknown' | 'error'; message: string }; onCheckConnection(): void;
  keyManagement?: { busy: boolean; ending?: string; notice?: string; onSave(): void; onDelete(): void };
  onGuidance?(): void;
  guidance?: { target: string; targets: { id: string; label: string }[]; onTarget(id: string): void; onCancel(): void; onConfirmTarget?(): void };
};

function ChatComposer(props: ChatComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const provider = props.providers.find(item => item.id === props.providerId);
  const validLimit = (value: number, maximum: number) => Number.isInteger(value) && value > 0 && value <= maximum;
  const validBudget = validLimit(props.budgets.maxRunSeconds, props.budgetLimits.maxRunSeconds) && props.budgets.maxRunSeconds % 60 === 0
    && validLimit(props.budgets.maxTotalTokens, props.budgetLimits.maxTotalTokens)
    && props.budgets.research.maxRunSeconds % 60 === 0
    && Object.entries(props.budgets.research).every(([key, value]) => validLimit(value, props.budgetLimits.research[key as keyof ChatBudgets['research']]));
  const canSend = !!props.input.trim() && !!props.model.trim() && (props.hasConversation || validBudget)
    && !props.pending && !props.submitting && !props.disabled && (!props.keyRequired || !!props.apiKey.trim());
  useLayoutEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(Math.max(node.scrollHeight, 92), 260)}px`;
  }, [props.input]);
  return <div class="chat-composer">
    <form id="formalize-form" onSubmit={event => { event.preventDefault(); if (canSend) props.onSubmit(); }}>
      {props.guidance && <div class="chat-guidance-target" data-chat-guidance-mode>
        <label>{t('发送证明要求至')}<select data-chat-guidance-target value={props.guidance.target} disabled={props.submitting} onChange={event => props.guidance!.onTarget(event.currentTarget.value)}>
          <option value="">{t('证明任务负责人')}</option>{props.guidance.targets.map(target => <option value={target.id}>{target.label}</option>)}
        </select></label>
        {props.guidance.onConfirmTarget && <button type="button" class="text-button" onClick={props.guidance.onConfirmTarget}>{t('确认当前任务版本')}</button>}
        <button type="button" class="text-button" data-chat-guidance-cancel disabled={props.submitting} onClick={props.guidance.onCancel}>{t('返回讨论')}</button>
      </div>}
      <label class="sr-only" for="formalize-original">{props.hasConversation ? t("继续对话") : t("自然语言或 TeX 原题")}</label>
      <textarea ref={textarea} id="formalize-original" rows={3} value={props.input} spellcheck={false}
        placeholder={props.guidance ? t('补充证明方法或对当前引理的要求…') : props.hasConversation ? t("追问思路、引理或证明细节…") : t("输入你想证明的题目…")}
        onInput={event => props.onInput(event.currentTarget.value)}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || composing.current || event.keyCode === 229 || matchMedia('(pointer: coarse)').matches) return;
          event.preventDefault(); if (canSend) props.onSubmit();
        }} />
      <div class="chat-composer-toolbar">
        <details id="formalize-settings" class="chat-composer-settings" onToggle={event => {
          // On the empty home the fields open below the composer; a short screen scrolls them into view.
          const details = event.currentTarget;
          if (details.open && document.body.dataset.chatEmpty === 'true') details.querySelector('.chat-settings-fields')?.scrollIntoView({ block: 'nearest' });
        }}><summary title={t("模型设置")}><Icon name="sliders-horizontal" /><span>{t("设置")}</span></summary>
          <div class="chat-settings-fields">
            <div class="chat-settings-options"><label for="formalize-provider">{t('模型服务商')}<select id="formalize-provider" value={props.providerId}
              onChange={event => props.onProvider(event.currentTarget.value)} disabled={props.hasConversation || props.submitting}>
              {props.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label><label for="formalize-model">{t('模型')}<input id="formalize-model" type="text" value={props.model} spellcheck={false}
              onInput={event => props.onModel(event.currentTarget.value)} disabled={props.hasConversation || props.submitting} required maxlength={160}
              list="chat-model-options" /></label></div>
            <datalist id="chat-model-options">{provider?.defaultModel && <option value={provider.defaultModel} />}</datalist>
            <div class="chat-settings-options"><label for="formalize-environment">{t("证明环境")}<select id="formalize-environment" value={props.environment} onChange={event => props.onEnvironment(event.currentTarget.value as ChatComposerProps['environment'])} disabled={props.hasConversation}><option value="standard">{t("标准库")}</option><option value="mathlib">Mathlib</option></select></label>
              <label for="formalize-effort">{t("推理强度")}<select id="formalize-effort" value={props.effort} onChange={event => props.onEffort(event.currentTarget.value as ChatComposerProps['effort'])} disabled={props.hasConversation}><option value="max">{t("最高")}</option><option value="high">{t("高")}</option><option value="low">{t("低")}</option></select></label></div>
            <label for="formalize-key">API Key {props.keyRequired && <span>{t("（必填）")}</span>}</label>
            <input id="formalize-key" type="password" autocomplete="off" spellcheck={false} value={props.apiKey} onInput={event => props.onKey(event.currentTarget.value)} placeholder={t('临时使用的 API Key')} aria-describedby="chat-key-help" />
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
            <div class="chat-connection-check"><button type="button" class="button" id="check-model-connection" onClick={props.onCheckConnection}
              title={t('通过模型列表检查连接')}
              disabled={props.checkingConnection || !props.model.trim() || props.keyRequired && !props.apiKey.trim()}>{props.checkingConnection ? t('正在检查连接…') : t('检查 Key 与模型')}</button></div>
            {props.connection && <p class="field-note" id="chat-connection-result" role="status" data-status={props.connection.status}>{props.connection.message}</p>}
            {!props.hasConversation && <>
              <fieldset class="chat-budget-fields"><legend>{t('形式化预算')}</legend><div class="chat-settings-options">
                <label for="formalize-minutes">{t('最多分钟')}<input id="formalize-minutes" type="number" min={1} max={props.budgetLimits.maxRunSeconds / 60} step={1}
                  value={props.budgets.maxRunSeconds / 60} onInput={event => props.onBudget('formalization', 'maxRunSeconds', Number(event.currentTarget.value) * 60)} /></label>
                <label for="formalize-tokens">{t('最多 Token')}<input id="formalize-tokens" type="number" min={1} max={props.budgetLimits.maxTotalTokens} step={1}
                  value={props.budgets.maxTotalTokens} onInput={event => props.onBudget('formalization', 'maxTotalTokens', Number(event.currentTarget.value))} /></label>
              </div></fieldset>
              <fieldset class="chat-budget-fields"><legend>{t('随后证明的预算')}</legend><div class="chat-settings-options">
                <label for="research-minutes">{t('最多分钟')}<input id="research-minutes" type="number" min={1} max={props.budgetLimits.research.maxRunSeconds / 60} step={1}
                  value={props.budgets.research.maxRunSeconds / 60} onInput={event => props.onBudget('research', 'maxRunSeconds', Number(event.currentTarget.value) * 60)} /></label>
                <label for="research-tokens">{t('最多 Token')}<input id="research-tokens" type="number" min={1} max={props.budgetLimits.research.maxTotalTokens} step={1}
                  value={props.budgets.research.maxTotalTokens} onInput={event => props.onBudget('research', 'maxTotalTokens', Number(event.currentTarget.value))} /></label>
                <label for="research-turns">{t('最多研究轮次')}<input id="research-turns" type="number" min={1} max={props.budgetLimits.research.maxTurns} step={1}
                  value={props.budgets.research.maxTurns} onInput={event => props.onBudget('research', 'maxTurns', Number(event.currentTarget.value))} /></label>
              </div></fieldset>
              <p class="field-note">{t('按已报告用量停止，在途请求可能超额；Token 上限不代表金额封顶。')}</p>
            </>}
          </div>
        </details>
        {!props.hasConversation && <button class="text-button chat-lean-entry" type="button" onClick={props.onLean}>Lean <Icon name="chevron-right" /></button>}
        {!props.guidance && props.onGuidance && <button class="text-button" type="button" data-chat-guidance-mode-open onClick={props.onGuidance}>{t('发给证明任务')}</button>}
        <div class="chat-composer-submit">{props.pending ? <button id="chat-stop" type="button" class="chat-send" onClick={props.onStop} aria-label={t("停止回答")} title={t("停止回答")}><Icon name="square" /></button>
          : <button id="formalize-start" type="submit" class="chat-send" disabled={!canSend} aria-label={props.guidance ? t('发送证明要求') : t("发送")} title={props.guidance ? t('发送证明要求') : t("发送")}>{props.submitting ? <span class="spinner" /> : <Icon name="arrow-up" />}</button>}</div>
      </div>
    </form>
    {!props.hasConversation && <p class="chat-budget-summary" data-chat-budget>{t('形式化 {0} 分钟 / {1} Token；证明 {2} 分钟 / {3} Token。',
      props.budgets.maxRunSeconds / 60, formatTokens(props.budgets.maxTotalTokens), props.budgets.research.maxRunSeconds / 60, formatTokens(props.budgets.research.maxTotalTokens))}
      {' '}{t('模型费用由所选服务商收取。')}</p>}
    {!props.hasConversation && !validBudget && <p class="chat-send-status" role="alert">{t('请把两阶段预算设为允许范围内的正整数。')}</p>}
    {(props.sendStatus || (props.input.trim() && props.keyRequired && !props.apiKey.trim())) && <p id="formalize-send-status" class="chat-send-status" role="status">{props.sendStatus || t("请在设置中填写 API Key 后发送。")}</p>}
    {!props.hasConversation && <details class="chat-examples"><summary>{t("试试例题")}</summary><label class="sr-only" for="formalize-example">{t("选择自然语言例题")}</label><select id="formalize-example" value="" onChange={event => { props.onExample(event.currentTarget.value); event.currentTarget.value = ''; textarea.current?.focus(); }}><option value="">{t("选择一个题目")}</option>{researchExamples.map(example => <option key={example.id} value={example.id}>{locale === 'en' ? example.nameEn : example.name}</option>)}</select></details>}
  </div>;
}

export type ChatHistoryProps = {
  items: WebConversationSummary[]; selectedId?: string; onOpen(id: string): void; failed?: boolean; onRetry?(): void;
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
  return <nav class="chat-history" aria-label={t("对话历史")}>
    <p class="chat-history-heading">{t("对话")}</p>
    <label class="chat-history-search"><span class="sr-only">{t('搜索对话标题')}</span><Icon name="search" /><input type="search" data-chat-search placeholder={t('搜索对话标题')} value={query} onInput={event => setQuery(event.currentTarget.value)} /></label>
    {items.length ? matching.length ? matching.map(item => <div key={item.id} class="chat-history-row" data-chat-row={item.id}>
      <div class="chat-history-line"><a href={`?chat=${encodeURIComponent(item.id)}`} class="chat-history-item" aria-current={item.id === selectedId ? 'page' : undefined}
        onClick={event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpen(item.id); }}><span translate={false}>{item.title}</span>{item.answering && <span class="spinner" aria-label={t("正在回答")} />}</a>
        <button type="button" class="icon-button" data-chat-rename disabled={busy} aria-label={t('重命名对话')} title={t('重命名对话')} onClick={() => edit(item.id, 'rename', item.title)}><Icon name="square-pen" /></button>
        <button type="button" class="icon-button" data-chat-delete disabled={busy} aria-label={t('删除对话')} title={t('删除对话')} onClick={() => edit(item.id, 'delete', item.title)}><Icon name="trash-2" /></button></div>
      {confirmation(item.id)}
    </div>) : <p class="chat-history-empty">{t('没有匹配的对话')}</p>
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
  const original = report?.original ?? formalization?.original ?? run?.formalization?.original;
  const source = report?.statement ?? run?.source;
  const formalizationId = formalization?.id ?? run?.formalizationId;
  const relations: Record<string, string> = { direct: t("直接对应"), equivalent: t("等价表达"), unresolved: t("待核对"), mismatch: t("不一致") };
  const aspects: Record<string, string> = { domains: t("对象与类型"), assumptions: t("假设"), conclusions: t("结论"), definitions: t("定义"), quantifierScope: t("量词范围"), instanceCoherence: t("结构与实例") };
  return <div class="chat-original-content">
    <header class="chat-original-header"><h2>{t("原题与 Lean")}</h2>
      {formalizationId && <a class="text-button" href={`formalize.html?id=${encodeURIComponent(formalizationId)}`} target="_blank" rel="noreferrer">{t("完整审核")}<Icon name="arrow-up-right" /></a>}
    </header>
    {(report || run?.formalization) && <p class="chat-statement-verdict">{statementConfirmation(formalization?.confirmation ?? run?.formalization?.confirmation)}
      {' '}{t('Lean 验收证明的是这份陈述，不能替代对自然语言原意的核对。')}</p>}
    <div class="chat-original-columns">
      <section><h3>{t("自然语言原题")}</h3><div class="chat-message-text" translate={false}>{original ?? t("此题直接从 Lean 陈述开始。")}</div></section>
      <section><h3>{t("Lean 陈述")}</h3>{source ? <pre tabIndex={0} translate={false}><code>{source}</code></pre> : <p>{t("陈述尚未生成。")}</p>}</section>
    </div>
    {report && <>
      <section class="chat-backtranslation"><h3>{t("独立回译")}</h3><p class="chat-message-text" translate={false}>{report.backtranslation.mathematics}</p>
        {!!report.backtranslation.assumptions.length && <><h4>{t("假设")}</h4><ul>{report.backtranslation.assumptions.map((value, index) => <li key={index} translate={false}>{value}</li>)}</ul></>}
        {!!report.backtranslation.definitions.length && <><h4>{t("定义")}</h4><ul>{report.backtranslation.definitions.map((value, index) => <li key={index} translate={false}>{value}</li>)}</ul></>}
      </section>
      <section class="chat-correspondences"><h3>{t("具体对应关系")}</h3>
        {report.correspondences.length ? report.correspondences.map((item, index) => <article key={index} data-relation={item.relation}>
          <header><strong>{aspects[item.aspect]}</strong><span>{relations[item.relation]}</span></header>
          <div class="chat-original-columns"><blockquote translate={false}>{item.original}</blockquote><pre tabIndex={0} translate={false}><code>{item.leanText}</code></pre></div>
          {item.explanations.map((explanation, n) => <p key={n} translate={false}>{explanation}</p>)}
        </article>) : <p>{t("本次报告未记录逐项对应关系。")}</p>}
      </section>
    </>}
  </div>;
}
export function renderChatOriginal(root: HTMLElement, props: ChatOriginalProps) { render(<ChatOriginal {...props} />, root); }
