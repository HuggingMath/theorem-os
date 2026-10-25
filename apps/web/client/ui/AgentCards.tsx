import { render } from 'preact';
import { jsonText } from '../collaborationUi';

export type AgentCard = { id: string; role: string; scheduling: string; schedulingStatus: string; phase: string; turns: string; task?: string;
  details: { title: string; value: unknown; id: string }[] };

// Same markup as collaborationUi.detailBlock; Preact leaves the user's open/closed state alone.
const Detail = ({ title, value, id }: AgentCard['details'][number]) => <details class="collab-detail" data-detail-key={id}>
  <summary>{title}</summary><pre class="collab-code" tabIndex={0}>{typeof value === 'string' ? value : jsonText(value)}</pre></details>;

function Agent({ agent }: { agent: AgentCard }) {
  return <article class="collab-agent" data-worker-id={agent.id} data-agent-state={agent.schedulingStatus}>
    <div class="collab-section-heading"><strong><span class="collab-agent-dot" aria-hidden="true" />{agent.id}</strong><span class="collab-agent-actions">
      <button type="button" class="text-button" data-collab-deliveries-worker={agent.id} data-focus-key={`deliveries-worker-${agent.id}`}>交付</button>
      <button type="button" class="text-button" data-collab-guide-worker={agent.id} data-focus-key={`guide-worker-${agent.id}`}>指导</button></span></div>
    <span class="collab-eyebrow" data-worker-role>{agent.role}</span>
    <dl class="collab-facts" data-worker-facts>
      <div><dt>调度</dt><dd data-worker-fact="scheduling">{agent.scheduling}</dd></div>
      <div><dt>会话阶段</dt><dd data-worker-fact="phase">{agent.phase}</dd></div>
      <div><dt>轮次</dt><dd data-worker-fact="turns">{agent.turns}</dd></div>
    </dl>
    <div class="collab-agent-assignment"><span>当前任务</span>
      {agent.task
        ? <button type="button" class="text-button" data-worker-task data-collab-task={agent.task} data-focus-key={`agent-task-${agent.id}`} aria-label={`查看任务 ${agent.task}`}>{agent.task} →</button>
        : <span class="collab-agent-idle">未分配</span>}
    </div>
    {agent.details.map(detail => <Detail key={detail.id} {...detail} />)}
  </article>;
}

export function renderAgentCards(root: HTMLElement, agents: readonly AgentCard[]) {
  render(agents.length ? <>{agents.map(agent => <Agent key={agent.id} agent={agent} />)}</> : <p class="collab-help">尚无 Agent 调度记录</p>, root);
}
