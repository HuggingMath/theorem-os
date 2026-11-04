import { render } from 'preact';
import type { WebRun } from '../../shared';
import { isAcceptedRun, isFaultedRun, isRejectedRun, resultDescription, runProgress, stoppedLabel } from '../../presentation';
import { localizeText, t } from '../../i18n';
import { Icon } from './Icon';

export type ResearchConversationProps = {
  run: WebRun;
  onRoadmap(): void;
  /** Opens the original/Lean comparison when formalization exists, otherwise the original Lean source. */
  onOriginal(): void;
  onSource(): void;
  /** The parent supplies this only when the existing guidance workflow is available. */
  onGuidance?: () => void;
};

/** A concise view of the recorded problem and live state, alongside the existing result workspace. */
export function ResearchConversation({ run, onRoadmap, onOriginal, onSource, onGuidance }: ResearchConversationProps) {
  const active = run.status === 'queued' || run.status === 'running';
  const accepted = isAcceptedRun(run), failed = isFaultedRun(run) || isRejectedRun(run);
  const natural = run.formalization?.original;
  const proof = run.result?.proof || run.artifact?.source;
  const title = accepted ? t('完整原题通过') : active ? runProgress(run).phaseLabel
    : run.status === 'cancelled' ? t('已取消') : failed ? t('运行失败') : stoppedLabel(run);
  const latest = active ? run.events.at(-1) : undefined;
  return <div class="research-conversation" data-research-conversation={run.id}>
    <section class="research-conversation-original" aria-label={t('原始题目')}>
      <p class="research-conversation-label">{natural !== undefined ? t('自然语言原题') : t('原始题目')}</p>
      {natural !== undefined ? <p class="research-conversation-problem" translate={false}>{natural}</p>
        : <pre class="research-conversation-lean" tabIndex={0} aria-label={t('Lean 源码')} translate={false}><code>{run.source}</code></pre>}
    </section>
    <section class="research-conversation-response" aria-label={t('当前研究')}>
      <div class="research-conversation-byline"><img src="assets/mark.svg" alt="" width={24} height={24} /><span>TheoremOS</span></div>
      <div class="research-conversation-status" role="status" aria-atomic="true" data-active={active} data-accepted={accepted} data-failed={failed}>
        <p class="research-conversation-state"><Icon name={accepted ? 'circle-check' : failed ? 'circle-alert' : active ? 'clock-3' : 'square'} /><strong>{title}</strong></p>
        <p class="research-conversation-description">{resultDescription(run)}</p>
      </div>
      {latest?.message && <p class="research-conversation-latest">{localizeText(latest.message)}</p>}
      <div class="research-conversation-artifacts" role="group" aria-label={t('结果')}>
        <button type="button" data-research-artifact="roadmap" onClick={onRoadmap}><Icon name="network" /><span>{t('路线图')}</span><Icon name="arrow-up-right" /></button>
        <button type="button" data-research-artifact="original" onClick={onOriginal}
          title={run.formalizationId ? t('数学原意、Lean 声明与独立回译') : undefined}>
          <Icon name="languages" /><span>{t('原题')} / Lean</span><Icon name="arrow-up-right" /></button>
        <button type="button" data-research-artifact="source" onClick={onSource} disabled={!proof}>
          <Icon name="file-code-2" /><span>{accepted ? t('验收证明') : t('候选源码')}</span><Icon name="arrow-up-right" /></button>
      </div>
      {active && onGuidance && <button type="button" class="text-button research-conversation-guidance" data-research-guidance onClick={onGuidance}>
        <Icon name="message-square" />{t('补充证明要求')}</button>}
    </section>
  </div>;
}

/** Keep the component mounted across polling updates so focused artifact buttons retain their DOM nodes. */
export function renderResearchConversation(root: HTMLElement, props: ResearchConversationProps) {
  render(<ResearchConversation key={props.run.id} {...props} />, root);
}

export function unmountResearchConversation(root: HTMLElement) { render(null, root); }
