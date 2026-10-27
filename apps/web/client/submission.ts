import type { WebSession } from '../shared';
import type { TaskDraft } from './draft';
import { researchModulePlanSchema } from '../../../src/solver/modules/policy';
import { localeTag, t } from '../i18n';

export const submissionFields = ['provider', 'environment', 'source', 'task', 'model', 'api-key', 'max-turns', 'max-seconds', 'workers', 'max-tokens'] as const;
export type SubmissionField = typeof submissionFields[number] | 'module-plan';
/** `check` marks the source issue that comes from compiling the statement, not from the field's own rules. */
export type SubmissionIssue = { field: SubmissionField; message: string; check?: boolean };

/** The field is in units of 10,000 tokens (万), the unit providers bill in Chinese consoles. */
export function tokenCap(raw: string, maximum: number): number | undefined {
  const value = Number(raw.trim());
  return raw.trim() && Number.isSafeInteger(value) && value >= 1 && value * 10_000 <= maximum ? value * 10_000 : undefined;
}

// This checks input only. Provider authentication happens when a run is submitted.
export function submissionIssues(draft: TaskDraft, apiKey: string, session: WebSession): SubmissionIssue[] {
  const issues: SubmissionIssue[] = [];
  const add = (field: SubmissionField, message: string) => issues.push({ field, message });
  if (!session.providers.some(provider => provider.id === draft.providerId)) add('provider', t('请选择可用的服务商'));
  if (!session.environments.some(environment => environment.id === draft.environment)) add('environment', t('请选择可用的证明环境'));
  for (const [field, value, label, limit] of [
    ['source', draft.source, t('Lean 源码'), session.limits.maxSourceBytes],
    ['task', draft.task, t('研究任务'), session.limits.maxTaskBytes],
  ] as const) {
    if (!value.trim()) add(field, t('请填写{0}', label));
    else if (value.includes('\0')) add(field, t('{0}包含无效字符', label));
    else if (new TextEncoder().encode(value).length > limit) add(field, t('{0}超出允许大小（最多 {1} 字节）', label, limit.toLocaleString(localeTag)));
  }
  const model = draft.model.trim();
  if (!model) add('model', t('请填写模型名称'));
  else if (model.length > 128) add('model', t('模型名称最多 128 个字符'));
  else if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) add('model', t('模型名称须以字母或数字开头，只能包含字母、数字及 . _ : / -'));
  const key = apiKey.trim();
  if (!key) add('api-key', t('请填写 API Key'));
  else if (key.length < 8 || key.length > 4096) add('api-key', t('API Key 长度须为 8–4096 个字符'));
  else if (!/^[\x21-\x7e]+$/.test(key)) add('api-key', t('API Key 只能包含英文可见字符，不能包含空格或换行'));
  for (const [field, raw, label, min, max] of [
    ['max-turns', draft.maxTurns, t('轮次上限'), 1, session.limits.maxTurns],
    ['max-seconds', draft.maxRunSeconds, t('解题预算'), 30, session.limits.maxRunSeconds],
    ['workers', draft.workers, t('Agent 数量'), 1, session.limits.maxWorkers],
  ] as const) {
    const value = Number(raw);
    if (!raw.trim() || !Number.isSafeInteger(value) || value < min || value > max) add(field, t('{0}须为 {1}–{2} 的整数', label, min, max));
  }
  const tokens = draft.maxTotalTokens?.trim() ?? '';
  if (tokens && tokenCap(tokens, session.limits.maxTotalTokens) === undefined)
    add('max-tokens', t('用量上限须为 1–{0} 万 Token 的整数，留空表示不限', session.limits.maxTotalTokens / 10_000));
  if (draft.modulePlan) {
    const plan = researchModulePlanSchema.safeParse(draft.modulePlan);
    if (!plan.success) add('module-plan', t('请检查自定义模块的名称、规则及替换冲突'));
  }
  return issues;
}
