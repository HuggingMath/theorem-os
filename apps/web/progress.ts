import { sanitizeWebEventDetails } from './moduleTelemetry';
import type { WebEventDetails, WorkerMessage } from './shared';

const descriptions: Record<string, string> = {
  ready: '原题与运行环境已固定', dependency_check: '正在检查 Lean 依赖',
  proof_environment: '正在准备只读数学依赖', library_index: '正在准备数学库检索',
  preparation_finished: '题目准备完成', solve_started: '开始研究', turn_started: 'Agent 正在构造候选',
  worker_activity: 'Agent 正在运行', turn_checkpoint: '当前尝试已记录检查点', turn_failed: '当前尝试未完成',
  turn_retry: '准备继续尝试', proof_check_started: '正在检查候选证明',
  proof_checked: '候选检查完成', candidate_selected: '已选出候选，准备最终验收',
  evaluation_started: '正在独立验收完整原题', evaluation_finished: '完整原题验收结束',
  lemma_checked: '辅助引理检查完成', assembly_started: '正在集成候选证明',
  source_rejected: '候选更改了原题约束，已拒绝', preparation_failed: '运行环境预检未通过',
  worker_failed: 'Agent 会话已停止', finished: '求解流程结束',
  worker_recovering: 'Agent 正在恢复会话', worker_recovered: 'Agent 已恢复，保留已检查成果',
  assignment_superseded: '当前分配已被更新', research_action: '已选择下一步研究操作',
  model_budget_stopped: '模型预算已停止后续调用', context_compiled: '本轮上下文已整理',
  planning_budget_stopped: '初始规划已达到限额，正在交接研究任务',
  context_restarted: '研究上下文已重新建立', task_assigned: '研究任务已分配',
  task_checked: '局部任务检查完成', task_check_reused: '已复用当前任务检查',
  task_failure_check_reused: '已复用当前任务的失败检查', task_recheck_started: '正在重新检查任务',
  task_recheck_finished: '任务重新检查结束', task_integrated: '任务成果已集成',
  task_tactic_battery: '宿主策略组合已尝试辅助引理', source_quarantined: '已移开工作区外的未跟踪文件',
  plan_updated: '研究计划已更新', plan_rejected: '研究计划未通过约束检查',
  initial_plan_fallback: '已建立初始研究任务', review_requested: '候选已提交审阅',
  review_assigned: '候选审阅已分配', review_completed: '候选审阅结束',
  statement_review_requested: '声明已提交审阅', statement_review_assigned: '声明审阅已分配',
  statement_review_completed: '声明审阅结束', delivery_published: '研究交付已记录',
  research_delivered: '研究结论已交付', route_parked: '当前路线已暂缓',
  route_reopened: '研究路线已重新开放', routes_idle: '当前没有可继续的路线', plan_stalled: '研究计划需要调整',
  custom_module_applied: '已将自定义策略加入本轮上下文',
  // Human input: the receipt itself is in the observation; these mark when the host acted on it.
  edit_received: '宿主已收到计划修改', edit_applied: '计划修改已应用',
  edit_rejected: '计划修改未通过校验，计划未改变', edit_recheck_updated: '计划修改后的重新检查已更新',
  human_guidance_queued: '数学指导已排队', human_guidance_delivered: '数学指导已送达 Agent',
  human_guidance_deferred: '数学指导暂缓投递，等待接收者到达检查点', human_guidance_failed: '数学指导未能投递',
  human_guidance_unavailable: '数学指导通道暂不可用',
  // Lead planning and the goal path.
  initial_plan_published: '初始研究计划已发布', plan_published: '研究计划已发布',
  initial_plan_rejected: '初始研究计划未通过校验', plan_publication_rejected: '研究计划发布未通过校验',
  initial_plan_fallback_failed: '初始研究任务未能建立',
  lead_draft_preserved: 'Lead 决策未通过校验，已保留草稿', lead_draft_restored: '已恢复 Lead 草稿',
  lead_decision_superseded: 'Lead 决策已被更新的输入取代',
  goal_path_stalled: '原题目标路径停滞，等待 Lead 决定', goal_path_stall_dispatched: '已请 Lead 处理停滞的目标路径',
  goal_path_decided: 'Lead 已决定停滞路径的候选', goal_path_stall_unanswered: 'Lead 未回答停滞路径，将再询问一次',
  goal_path_stall_ignored: 'Lead 两次未回答停滞路径，不再追问',
  blocked_tasks_reconsidered: '已重新考虑受阻任务', unattempted_frontier_resumed: '已恢复尚未尝试的研究前沿',
  route_blocker_recorded: '已记录路线阻塞',
  // Deliveries and task proofs.
  delivery_rejected: 'Agent 交付未通过宿主校验', task_delivery_superseded: '任务交付已被更新版本取代',
  task_assignment_released: '任务分配已释放', task_connection_check_assigned: '已分配引理连接检查',
  task_type_preflight: '已预检辅助引理类型', task_canonical_probe: '已在主线上试探任务证明',
  task_family_assembly: '已尝试组装任务族', task_mathematical_gap_blocked: '任务存在数学缺口，已暂停',
  task_repeated_input_blocked: '相同输入已失败过，任务暂停等待新输入', task_failed_input_recorded: '已记录失败输入',
  task_failed_input_reopened: '失败输入已有变化，任务重新开放', task_attempt_repeated_advisory: '检测到重复的证明尝试',
  task_repair_requested: '已请求修复任务', task_repair_interrupted: '任务修复已中断',
  task_checkpoint_continuation_requested: '已请求从检查点继续任务',
  task_conditional_recheck_started: '正在重新检查有条件结果', task_conditional_recheck_finished: '有条件结果重新检查结束',
  task_recheck_dependency_invalidated: '依赖变化，已撤销任务的检查结果',
  task_contract_sources_revalidated: '已重新校验任务约定的源码', task_integration_superseded: '任务集成已被更新版本取代',
  task_recheck_batch_started: '正在批量重新检查任务', task_integration_batch_started: '正在批量集成任务',
  integration_queue_started: '开始集成排队的任务成果',
  // Reviews, research records and proof lifecycle.
  final_statement_review_scope: '已确定最终声明审阅范围', statement_review_reused: '已复用声明审阅',
  feasibility_review_reassigned: '可行性审阅已改派', research_checkpoint_recorded: '研究检查点已记录',
  research_checkpoint_reopened: '研究检查点已重新开放', research_delivery_unchanged: '研究交付无变化',
  research_draft_restored: '已恢复研究草稿', research_draft_restore_failed: '研究草稿未能恢复',
  research_draft_unavailable: '研究草稿不可用', proof_ready_checked: '证明就绪检查完成',
  proof_ready_frozen: '证明快照已冻结', obligation_progress: '证明义务进展已更新',
  knowledge_retrieval_observed: '已检索知识材料', knowledge_use_observed: '已记录知识材料的使用',
  knowledge_use_rejected: '知识材料使用记录未通过校验',
  // Sessions and service health.
  context_compaction_started: '正在压缩会话上下文', context_compaction_completed: '会话上下文压缩完成',
  worker_context_recovering: '上下文超出容量，正在缩减后恢复', worker_usage_unscoped: '用量回执无法归属到会话',
  cooperation_poll_failed: '读取 Agent 交付记录失败', rejected: '运行请求被拒绝',
};
const failureDescriptions: Record<string, string> = {
  math_total_token_limit: '已达到模型用量门槛，后续调用已停止',
  math_model_usage_unavailable: '模型用量回执不完整，后续调用已停止',
  math_initial_planning_limit: '初始规划已达到限额，正在交接研究任务',
  math_model_authentication_failed: 'API Key 认证失败，请检查密钥和服务商',
  math_model_concurrency_limit: '服务商限制了当前请求，请检查配额或并发',
  math_model_request_failed: '模型服务连接失败',
  math_model_request_timeout: '模型服务请求超时',
  math_codex_transport_closed: '模型会话连接已中断',
  math_source_outside_ownership: 'Agent 修改了不属于本任务的源码，会话已停止',
  math_verifier_unavailable: 'Lean 检查器不可用，研究已停止',
  math_context_mandatory_overflow: '必需上下文超出容量，会话已停止',
  math_delivery_line_too_large: 'Agent 交付记录过大，未能读取',
};
// A recovery succeeded; naming the provider failure it recovered from would read as a new failure.
const recoveries = new Set(['worker_recovered']);
const fields: Record<string, readonly (keyof WebEventDetails)[]> = {
  turn_started: ['turn'], turn_checkpoint: ['turn', 'reason'], proof_check_started: ['turn'],
  proof_checked: ['passed', 'reused'], research_action: ['operation'],
  context_compiled: ['usedBytes', 'maxBytes'], evaluation_finished: ['status'],
  task_assigned: ['taskId'], task_checked: ['taskId', 'passed', 'conditional'],
  task_check_reused: ['taskId'], task_failure_check_reused: ['taskId'],
  task_recheck_started: ['taskId'], task_recheck_finished: ['taskId', 'passed'], task_integrated: ['taskId'],
  review_assigned: ['role'], statement_review_requested: ['taskId'],
  statement_review_assigned: ['taskId', 'role'], statement_review_completed: ['taskId', 'status'],
  delivery_published: ['taskId', 'status'], research_delivered: ['taskId'],
  route_parked: ['taskId'], route_reopened: ['taskId', 'reason'],
  custom_module_applied: ['moduleId', 'slot', 'mode'],
  worker_failed: ['reason'], worker_recovered: ['reason'], routes_idle: ['reason'], initial_plan_fallback: ['reason'],
  task_tactic_battery: ['taskId', 'reason'],
  edit_rejected: ['reason'], human_guidance_deferred: ['reason'], human_guidance_failed: ['reason'],
  human_guidance_unavailable: ['reason'], initial_plan_rejected: ['reason'], plan_publication_rejected: ['reason'],
  initial_plan_fallback_failed: ['reason'], lead_draft_preserved: ['reason'],
  route_blocker_recorded: ['taskId'], delivery_rejected: ['reason'],
  task_delivery_superseded: ['taskId'], task_assignment_released: ['taskId', 'reason'],
  task_connection_check_assigned: ['taskId'], task_type_preflight: ['taskId', 'status', 'reason'],
  task_canonical_probe: ['taskId', 'passed', 'status'], task_family_assembly: ['taskId', 'passed', 'status', 'reason'],
  task_mathematical_gap_blocked: ['taskId'], task_repeated_input_blocked: ['taskId'],
  task_failed_input_recorded: ['taskId'], task_failed_input_reopened: ['taskId'],
  task_attempt_repeated_advisory: ['taskId'], task_repair_requested: ['taskId', 'reason'],
  task_repair_interrupted: ['taskId', 'reason'], task_checkpoint_continuation_requested: ['taskId'],
  task_conditional_recheck_started: ['taskId'], task_conditional_recheck_finished: ['taskId', 'passed'],
  task_recheck_dependency_invalidated: ['taskId'], task_integration_superseded: ['taskId', 'reason'],
  statement_review_reused: ['taskId'], feasibility_review_reassigned: ['taskId', 'reason'],
  research_checkpoint_recorded: ['taskId'], research_checkpoint_reopened: ['taskId', 'reason'],
  research_delivery_unchanged: ['taskId'], research_draft_restored: ['taskId'],
  research_draft_restore_failed: ['taskId', 'reason'], research_draft_unavailable: ['taskId'],
  proof_ready_checked: ['taskId', 'passed', 'conditional'], proof_ready_frozen: ['taskId'],
  knowledge_use_observed: ['taskId'], knowledge_use_rejected: ['taskId'],
  worker_context_recovering: ['reason'], cooperation_poll_failed: ['reason'], rejected: ['reason'],
};

/** The code before any ':' detail; runtime reasons append ids, sizes or Lean text after it. */
const reasonCode = (value: unknown) => typeof value === 'string' ? value.split(':', 1)[0].trim() : undefined;

export function translateWebProgress(value: unknown): Extract<WorkerMessage, { type: 'progress' }> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const event = value as Record<string, unknown>;
  if (typeof event.event !== 'string' || !Object.hasOwn(descriptions, event.event)) return;
  const keys: readonly (keyof WebEventDetails)[] = ['workerId', ...(fields[event.event] ?? [])];
  const code = reasonCode(event.reason);
  const details = sanitizeWebEventDetails(Object.fromEntries(keys.filter(key => Object.hasOwn(event, key))
    .map(key => [key, key === 'reason' ? code : event[key]])));
  const failure = code && !recoveries.has(event.event) && Object.hasOwn(failureDescriptions, code)
    ? failureDescriptions[code] : undefined;
  return { type: 'progress', event: event.event,
    message: (failure ?? descriptions[event.event]) + (details?.workerId ? ` · ${details.workerId}` : ''),
    ...(details ? { details } : {}) };
}

// A worker streams hundreds of activity notices per turn and the Web activity log keeps 200 events.
const heartbeats = new Set(['worker_activity']);
// The delivery poll repeats one failure every cycle until the worker writes again.
const repeats = new Set(['cooperation_poll_failed']);
export const webProgressHeartbeatMs = 30_000;

/**
 * Forwards translated progress, keeping one activity heartbeat per worker every 30 s and one repeat of the same
 * poll failure per 30 s. Any other event from a worker forwards its next activity at once, so module activity
 * intervals still open and close at real event boundaries.
 */
export function createWebProgressForwarder(send: (message: Extract<WorkerMessage, { type: 'progress' }>) => void,
  now = () => Date.now()) {
  const last = new Map<string, number>();
  return (value: unknown) => {
    const message = translateWebProgress(value);
    if (!message) return;
    const worker = message.details?.workerId ?? '';
    const key = heartbeats.has(message.event) ? `${message.event}/${worker}`
      : repeats.has(message.event) ? `${message.event}/${worker}/${message.details?.reason ?? ''}` : undefined;
    if (key) {
      const at = now(), previous = last.get(key);
      if (previous !== undefined && at - previous < webProgressHeartbeatMs) return;
      last.set(key, at);
    } else if (worker) for (const event of heartbeats) last.delete(`${event}/${worker}`);
    send(message);
  };
}
