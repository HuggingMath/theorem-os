import type { WebQuotaView } from '../../shared';
import { locale } from '../../i18n';
import { formatDateTime, formatTokens } from '../../presentation';
import { firstResearchBudget, firstResearchRemaining, type FirstResearchBudget } from '../firstResearchModel';
import { ResearchStartCost, type ResearchStartCostProps } from '../researchStartCost';

const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
export function FirstResearchStart(props: { participation: 'guided' | 'automatic'; budgets: FirstResearchBudget;
  limits: FirstResearchBudget; locked: boolean; quota?: WebQuotaView; cost?: Omit<ResearchStartCostProps, 'stages'>; onBudget(value: FirstResearchBudget): void }) {
  const remaining = firstResearchRemaining(props.quota);
  const minutes = (seconds: number) => seconds ? `${seconds / 60} ${tx('分钟', 'min')}` : tx('不限', 'Unlimited');
  const tokens = (value: number) => value ? `${formatTokens(value)} Token` : tx('不限', 'Unlimited');
  const turns = (value: number) => value ? `${value} ${tx('轮', 'turns')}` : tx('不限', 'Unlimited');
  return <section class="first-research-start" data-first-research-start aria-label={tx('开始前看一眼', 'Before you start')}>
    <p class="first-research-stages" data-first-research-stages>{props.participation === 'guided'
      ? tx('生成 Lean 陈述 → 你确认题意 → 拟定计划 → 你批准后证明', 'Lean statement → your statement review → plan → proof after your approval')
      : tx('生成并核对 Lean 陈述 → 自动开始证明', 'Generate and check the Lean statement → start proving automatically')}</p>
    <div class="first-research-budget-top"><span>{tx('本次上限', 'Limits for this run')}</span><div>
      <button type="button" class="text-button" data-first-budget="trial" disabled={props.locked}
        onClick={() => props.onBudget(firstResearchBudget('trial', props.limits))}>{tx('先小试一次', 'Small trial')}</button>
      <button type="button" class="text-button" data-first-budget="standard" disabled={props.locked}
        onClick={() => props.onBudget(firstResearchBudget('standard', props.limits))}>{tx('常规研究', 'Standard run')}</button>
    </div></div>
    <dl class="first-research-budgets" data-chat-budget>
      <div><dt>{tx('形式化', 'Statement')}</dt><dd>{minutes(props.budgets.maxRunSeconds)} · {tokens(props.budgets.maxTotalTokens)}</dd></div>
      <div><dt>{tx('证明', 'Proof')}</dt><dd>{minutes(props.budgets.research.maxRunSeconds)} · {tokens(props.budgets.research.maxTotalTokens)} · {turns(props.budgets.research.maxTurns)}</dd></div>
    </dl>
    {remaining && <p class="first-research-quota" data-first-research-quota>{tx('当前还可开始', 'Remaining in this window:')}{' '}
      {remaining.formalizations} {tx('次形式化', 'statement runs')} · {remaining.research} {tx('次证明研究', 'proof runs')}
      <span title={formatDateTime(remaining.endsAt)}>{tx(' · 额度恢复时间 ', ' · resets ')}{formatDateTime(remaining.endsAt)}</span></p>}
    {props.cost ? <ResearchStartCost key={`${props.cost.owner}:${props.cost.providerId}:${props.cost.model}`} {...props.cost} locked={props.locked}
      stages={[{ kind: 'formalization', tokens: props.budgets.maxTotalTokens }, { kind: 'proof', tokens: props.budgets.research.maxTotalTokens }]} />
      : <p class="first-research-cost">{tx('预算留空表示不限。模型服务商按实际用量计费。可在设置中调整上限；在途请求可能超额。',
        'Blank budgets mean unlimited. Your model provider bills actual usage. Adjust limits in settings; in-flight requests can exceed them.')}</p>}
  </section>;
}
