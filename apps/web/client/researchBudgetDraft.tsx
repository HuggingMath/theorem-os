import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ResearchBudgetView } from '../researchBudgetTypes';
import { ResearchBudgetFacts } from './researchBudget';
import { ErrorBox, tx } from './researchShared';

type Api = <T>(url: string) => Promise<T>;
export type ResearchBudgetDraft = { runId: string; projectId?: string; tokens: number; providerId: string; model: string };
function BudgetDraft({ value, api }: { value: ResearchBudgetDraft; api: Api }) {
  const [data, setData] = useState<ResearchBudgetView>(), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const parameters = new URLSearchParams({ tokens: String(value.tokens), provider: value.providerId, model: value.model,
    ...(value.projectId ? { project: value.projectId } : {}) });
  const endpoint = `/api/research/workspace/problem/${encodeURIComponent(value.runId)}/budget?${parameters}`;
  useEffect(() => {
    let active = true; setError(''); setData(undefined);
    const timer = setTimeout(() => { void api<{ item: ResearchBudgetView }>(endpoint).then(result => { if (active) setData(result.item); },
      reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }); }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [endpoint, retry]);
  return <aside class="research-budget-draft" data-research-budget-draft>
    <h4>{tx('这道题的累计投入与本次规划', 'Problem totals and this attempt’s plan')}</h4>
    <ErrorBox message={error} />{error && <button type="button" class="text-button" onClick={() => setRetry(retry + 1)}>{tx('重新读取预算', 'Reload budget')}</button>}
    {data && <ResearchBudgetFacts value={data} />}
    <a href={`problem.html?${new URLSearchParams({ run: value.runId, tab: 'outcomes', ...(value.projectId ? { project: value.projectId } : {}) })}`}>{tx('调整整题预算与模型单价', 'Edit the problem budget and model rates')}</a>
  </aside>;
}
export function renderResearchBudgetDraft(target: HTMLElement, value: ResearchBudgetDraft | undefined, api: Api) {
  target.hidden = !value;
  render(value ? <BudgetDraft value={value} api={api} /> : null, target);
}
