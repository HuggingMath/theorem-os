import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ResearchBudgetView } from '../researchBudgetTypes';
import { localeTag } from '../i18n';
import { ResearchBudgetFacts } from './researchBudget';
import { ResearchBudgetContinuity } from './researchBudgetContinuity';
import { ErrorBox, tx } from './researchShared';

type Api = <T>(url: string, init?: RequestInit) => Promise<T>;
export type ResearchBudgetDraft = { runId: string; projectId?: string; tokens: number; providerId: string; model: string };
type BudgetRead = { endpoint?: string; data?: ResearchBudgetView; updatedAt?: string; error?: string; loading: boolean };
function BudgetDraft({ value, api }: { value: ResearchBudgetDraft; api: Api }) {
  const [result, setResult] = useState<BudgetRead>({ loading: true }), [retry, setRetry] = useState(0);
  const parameters = new URLSearchParams({ tokens: String(value.tokens), provider: value.providerId, model: value.model,
    ...(value.projectId ? { project: value.projectId } : {}) });
  const endpoint = `/api/research/workspace/problem/${encodeURIComponent(value.runId)}/budget?${parameters}`;
  const budgetPage = `problem.html?${new URLSearchParams({ run: value.runId, tab: 'outcomes', ...(value.projectId ? { project: value.projectId } : {}) })}`;
  const current: BudgetRead = result.endpoint === endpoint ? result : { loading: true };
  const refresh = () => setRetry(value => value + 1);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const read = async () => {
      setResult(previous => ({ ...(previous.endpoint === endpoint ? previous : {}), endpoint, error: undefined, loading: true }));
      try {
        const result = await api<{ item: ResearchBudgetView }>(endpoint, { signal: controller.signal });
        if (active) setResult({ endpoint, data: result.item, updatedAt: new Date().toISOString(), loading: false });
      } catch (reason) {
        const unavailable = reason && typeof reason === 'object' && 'status' in reason && [401, 403, 404].includes(Number(reason.status));
        if (active && !controller.signal.aborted) setResult(previous => ({ ...(previous.endpoint === endpoint && !unavailable ? previous : {}),
          endpoint, error: reason instanceof Error ? reason.message : String(reason), loading: false }));
      }
      if (active) timer = setTimeout(() => void read(), 15_000);
    };
    timer = setTimeout(() => void read(), 200);
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [endpoint, retry, api]);
  return <aside class="research-budget-draft" data-research-budget-draft aria-busy={current.loading}>
    <h4>{value.projectId ? tx('项目累计投入与本次个人尝试', 'Project totals and this personal attempt') : tx('这道题的累计投入与本次规划', 'Problem totals and this attempt’s plan')}</h4>
    {value.projectId && <p data-budget-project-scope>{tx('此处按项目内已关联的运行累计。本次先作为个人运行开始；提交后核对共享范围并确认关联，才会计入项目。', 'These totals cover runs attached to the project. This attempt starts as a personal run. After submission, review sharing and confirm attachment to include it in the project.')}</p>}
    <div class="research-budget-refresh">
      {current.updatedAt && <span class="research-status">{tx('预算更新于', 'Budget updated at')} <time data-budget-updated-at dateTime={current.updatedAt}>{new Date(current.updatedAt).toLocaleTimeString(localeTag, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></span>}
      <button type="button" class="text-button" data-refresh-budget disabled={current.loading} onClick={refresh}>{current.loading ? tx('正在更新预算…', 'Updating budget…') : tx('刷新预算', 'Refresh budget')}</button>
    </div>
    <ErrorBox message={current.error} />
    {current.data && <><ResearchBudgetFacts value={current.data} /><ResearchBudgetContinuity value={current.data} endpoint={endpoint} request={api} onResolved={refresh} /></>}
    <a href={budgetPage}>{current.data?.continuity?.status === 'conflict' ? tx('返回项目核对预算来源', 'Return to the project to review budget sources') : tx('调整整题预算与模型单价', 'Edit the problem budget and model rates')}</a>
  </aside>;
}
export function renderResearchBudgetDraft(target: HTMLElement, value: ResearchBudgetDraft | undefined, api: Api) {
  target.hidden = !value;
  render(value ? <BudgetDraft value={value} api={api} /> : null, target);
}
