import { render } from 'preact';
import { Detail as DetailBlock } from './Section';
import { t } from '../../i18n';

export type AgentCard = { id: string; role: string; scheduling: string; schedulingStatus: string; phase: string; turns: string; task?: string;
  details: { title: string; value: unknown; id: string }[] };

// Preact never touches `open`, so the reader's choice survives updates.
const Detail = ({ title, value, id }: AgentCard['details'][number]) => <DetailBlock title={title} value={value} detailKey={id} />;

function Agent({ agent }: { agent: AgentCard }) {
  return <article class="collab-agent" data-worker-id={agent.id} data-agent-state={agent.schedulingStatus}>
    <div class="collab-section-heading"><strong><span class="collab-agent-dot" aria-hidden="true" />{agent.id}</strong><span class="collab-agent-actions">
      <button type="button" class="text-button" data-collab-deliveries-worker={agent.id} data-focus-key={`deliveries-worker-${agent.id}`}>{t('交付')}</button>
      <button type="button" class="text-button" data-collab-guide-worker={agent.id} data-focus-key={`guide-worker-${agent.id}`}>{t('指导')}</button></span></div>
    <span class="collab-eyebrow" data-worker-role>{agent.role}</span>
    <dl class="collab-facts" data-worker-facts>
      <div><dt>{t('调度')}</dt><dd data-worker-fact="scheduling">{agent.scheduling}</dd></div>
      <div><dt>{t('会话阶段')}</dt><dd data-worker-fact="phase">{agent.phase}</dd></div>
      <div><dt>{t('轮次')}</dt><dd data-worker-fact="turns">{agent.turns}</dd></div>
    </dl>
    <div class="collab-agent-assignment"><span>{t('当前任务')}</span>
      {agent.task
        ? <button type="button" class="text-button" data-worker-task data-collab-task={agent.task} data-focus-key={`agent-task-${agent.id}`} aria-label={t('查看任务 {0}', agent.task)}>{agent.task} →</button>
        : <span class="collab-agent-idle">{t('未分配')}</span>}
    </div>
    {agent.details.map(detail => <Detail key={detail.id} {...detail} />)}
  </article>;
}

export function renderAgentCards(root: HTMLElement, agents: readonly AgentCard[]) {
  render(agents.length ? <>{agents.map(agent => <Agent key={agent.id} agent={agent} />)}</> : <p class="collab-help">{t('尚无 Agent 调度记录')}</p>, root);
}
