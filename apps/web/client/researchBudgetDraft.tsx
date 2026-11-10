import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ResearchBudgetView } from '../researchBudgetTypes';
import { ResearchBudgetFacts } from './researchBudget';
import { ResearchBudgetContinuity } from './researchBudgetContinuity';
import { ErrorBox, tx } from './researchShared';

type Api = <T>(url: string, init?: RequestInit) => Promise<T>;
export type ResearchBudgetDraft = { runId: string; projectId?: string; tokens: number; providerId: string; model: string };
function BudgetDraft({ value, api }: { value: ResearchBudgetDraft; api: Api }) {
  const [data, setData] = useState<ResearchBudgetView>(), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const parameters = new URLSearchParams({ tokens: String(value.tokens), provider: value.providerId, model: value.model,
    ...(value.projectId ? { project: value.projectId } : {}) });
  const endpoint = `/api/research/workspace/problem/${encodeURIComponent(value.runId)}/budget?${parameters}`;
  const budgetPage = `problem.html?${new URLSearchParams({ run: value.runId, tab: 'outcomes', ...(value.projectId ? { project: value.projectId } : {}) })}`;
  useEffect(() => {
    let active = true; setError(''); setData(undefined);
    const timer = setTimeout(() => { void api<{ item: ResearchBudgetView }>(endpoint).then(result => { if (active) setData(result.item); },
      reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }); }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [endpoint, retry]);
  return <aside class="research-budget-draft" data-research-budget-draft>
    <h4>{value.projectId ? tx('项目累计投入与本次个人尝试', 'Project totals and this personal attempt') : tx('这道题的累计投入与本次规划', 'Problem totals and this attempt’s plan')}</h4>
    {value.projectId && <p data-budget-project-scope>{tx('此处按项目内已关联的运行累计。本次先作为个人运行开始；提交后核对共享范围并确认关联，才会计入项目。', 'These totals cover runs attached to the project. This attempt starts as a personal run. After submission, review sharing and confirm attachment to include it in the project.')}</p>}
    <ErrorBox message={error} />{error && <button type="button" class="text-button" onClick={() => setRetry(retry + 1)}>{tx('重新读取预算', 'Reload budget')}</button>}
    {data && <><ResearchBudgetFacts value={data} /><ResearchBudgetContinuity value={data} endpoint={endpoint} request={api} onResolved={() => setRetry(value => value + 1)} /></>}
    <a href={budgetPage}>{data?.continuity?.status === 'conflict' ? tx('返回项目核对预算来源', 'Return to the project to review budget sources') : tx('调整整题预算与模型单价', 'Edit the problem budget and model rates')}</a>
  </aside>;
}
export function renderResearchBudgetDraft(target: HTMLElement, value: ResearchBudgetDraft | undefined, api: Api) {
  target.hidden = !value;
  render(value ? <BudgetDraft value={value} api={api} /> : null, target);
}
