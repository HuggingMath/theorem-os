import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ResearchTokenRate } from '../researchWorkspaceTypes';
import { locale, localizeMessage } from '../i18n';
import { estimateResearchCost, parseResearchRate, type ResearchCostStage } from './researchCostModel';

const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
export type ResearchStartCostProps = { owner: string; account: boolean; request: Request; providerId: string; model: string;
  stages: readonly ResearchCostStage[]; locked?: boolean; onSetTokenLimit?(): void };
const money = (value: number) => value.toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

export function ResearchStartCost(props: ResearchStartCostProps) {
  const [rate, setRate] = useState(''), [currency, setCurrency] = useState<'CNY' | 'USD'>('CNY');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(props.account), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  const edited = useRef(false), live = useRef(true), lock = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    let active = true; const controller = new AbortController();
    if (!props.account) { setLoading(false); return; }
    setLoading(true); setError('');
    void props.request<{ items: ResearchTokenRate[] }>('/api/research/workspace/rates', { signal: controller.signal }).then(({ items }) => {
      if (!active || edited.current) return;
      const saved = items.find(item => item.providerId === props.providerId && item.model === props.model.trim());
      if (saved) { setRate(String(saved.perMillion)); setCurrency(saved.currency); }
    }).catch(cause => { if (active && !controller.signal.aborted) setError(localizeMessage(cause instanceof Error ? cause.message : String(cause))); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [props.account, props.providerId, props.model, props.request, retry]);
  const value = parseResearchRate(rate), estimate = value === undefined ? undefined : estimateResearchCost(props.stages, { perMillion: value, currency });
  const change = () => { edited.current = true; setNotice(''); };
  const save = async () => {
    if (lock.current || value === undefined || !props.account || !props.providerId || !props.model.trim()) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await props.request('/api/research/workspace/rates', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: crypto.randomUUID(), providerId: props.providerId, model: props.model.trim(), perMillion: value, currency }) });
      if (live.current) setNotice(tx('单价已保存到账号，后续预算与账本会沿用。', 'Rate saved to your account for future budgets and usage.'));
    } catch (cause) { if (live.current) setError(localizeMessage(cause instanceof Error ? cause.message : String(cause))); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  };
  return <section class="research-start-cost" data-start-cost>
    <div class="research-start-cost-summary" aria-live="polite"><strong>{tx('按本次 Token 上限估算', 'Estimate at these token limits')}</strong>
      {estimate ? <><dl>{estimate.items.map(item => <div key={item.kind}><dt>{item.kind === 'formalization' ? tx('形式化', 'Statement') : tx('证明', 'Proof')}</dt><dd data-cost-stage={item.kind}>≈ {currency} {money(item.amount)}</dd></div>)}</dl>
        {estimate.items.length > 1 && <p data-cost-total>{tx('两阶段合计', 'Both stages')} ≈ {currency} {money(estimate.total)}</p>}</>
        : <p data-cost-unavailable>{loading ? tx('正在读取已保存单价…', 'Loading your saved rate…') : value === undefined
          ? tx('尚不能估算金额，请填写所选模型单价。', 'Cost cannot be estimated yet. Enter a rate for this model.')
          : tx('尚未设置有效的 Token 上限，暂不能估算金额。', 'Set a valid token limit to estimate the cost.')}</p>}
      {!estimate && value !== undefined && props.onSetTokenLimit && <button type="button" class="text-button" data-cost-set-limit disabled={props.locked} onClick={props.onSetTokenLimit}>{tx('设置 Token 上限', 'Set token limit')}</button>}
    </div>
    <details data-start-rate><summary>{tx('设置模型单价', 'Set a model rate')}</summary>
      <p class="research-start-cost-model">{props.providerId} · {props.model || tx('尚未选择模型', 'No model selected')}</p>
      <div class="research-start-cost-fields"><label>{tx('每百万 Token 综合单价', 'Blended price per million tokens')}<input data-start-rate-value type="number" min="0" max="1000000" step="any" value={rate} disabled={props.locked || busy}
        onInput={event => { change(); setRate(event.currentTarget.value); }} /></label>
        <label>{tx('币种', 'Currency')}<select data-start-rate-currency value={currency} disabled={props.locked || busy} onChange={event => { change(); setCurrency(event.currentTarget.value as 'CNY' | 'USD'); }}><option>CNY</option><option>USD</option></select></label></div>
      {rate.trim() && value === undefined && <p role="alert">{tx('请输入 0 到 1000000 之间的有效单价。', 'Enter a valid rate from 0 to 1000000.')}</p>}
      {props.account ? <button type="button" class="text-button" data-start-rate-save disabled={busy || props.locked || value === undefined || !props.model.trim()} onClick={() => void save()}>{busy ? tx('正在保存…', 'Saving…') : tx('保存单价到账号', 'Save rate to my account')}</button>
        : <p>{tx('登录前也可估算；登录后可以将单价保存到账号。', 'You can estimate before signing in and save the rate to your account afterwards.')}</p>}
    </details>
    <p class="research-start-cost-note">{tx('采用你填写的综合单价；实际费用以服务商账单为准，在途请求可能超过 Token 上限。', 'Uses your blended rate. Your provider bills actual usage; in-flight requests can exceed token limits.')}</p>
    {error && <p role="alert">{error} <button type="button" class="text-button" onClick={() => setRetry(value => value + 1)}>{tx('重新读取单价', 'Reload rates')}</button></p>}
    {notice && <p role="status" data-start-rate-saved>{notice}</p>}
  </section>;
}
export function renderResearchStartCost(target: HTMLElement, props?: ResearchStartCostProps) {
  target.hidden = !props;
  render(props ? <ResearchStartCost key={`${props.owner}:${props.providerId}:${props.model}`} {...props} /> : null, target);
}
