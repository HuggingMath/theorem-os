import { render } from 'preact';
import { useState } from 'preact/hooks';
import { Icon } from './Icon';
import { t } from '../../i18n';
import { formatDateTime } from '../../presentation';
import { accountLogin, type WebAdminOverview } from '../../shared';

export type AdminPanelProps = {
  overview?: WebAdminOverview; error?: string; busy?: string;
  onAdd(email: string): Promise<boolean>; onRemove(email: string): void;
  onSuspend?(login: string, suspended: boolean): void;
};
const sourceLabels = { admin: t('管理员'), config: t('部署配置'), file: t('白名单文件') };
const stepLabels: Record<string, string> = { allowlisted: t('白名单内'), logged_in: t('首次登录'), submitted: t('首次提交运行'), accepted: t('首次通过验收') };
const date = (value?: string) => value ? formatDateTime(value) : '—';

function Funnel({ steps }: { steps: WebAdminOverview['funnel'] }) {
  return <dl class="admin-funnel">{steps.map(step => <div key={step.step}><dt>{stepLabels[step.step] ?? step.step}</dt>
    <dd><span class="mono">{step.count}</span>{step.ofPrevious !== undefined && <span class="admin-share mono">{`${step.ofPrevious}%`}</span>}</dd></div>)}</dl>;
}

function Allowlist({ overview, busy, onAdd, onRemove }: Required<Pick<AdminPanelProps, 'overview'>> & AdminPanelProps) {
  const [email, setEmail] = useState(''), [confirming, setConfirming] = useState<string>();
  const submit = async (event: Event) => {
    event.preventDefault();
    if (email.trim() && await onAdd(email.trim())) setEmail('');
  };
  return <>
    {overview.editable
      ? <form class="admin-add" onSubmit={submit}><label for="admin-email" class="sr-only">{t('要加入白名单的邮箱')}</label>
        <input id="admin-email" type="email" autocomplete="off" spellcheck={false} placeholder="name@example.org" value={email}
          onInput={event => setEmail((event.currentTarget as HTMLInputElement).value)} disabled={Boolean(busy)} />
        <button type="submit" class="button button-primary" disabled={Boolean(busy) || !email.trim()}><Icon name="plus" />{t('加入白名单')}</button></form>
      : <p class="field-note">{t('服务没有配置白名单文件，只能在部署配置里修改。')}</p>}
    <ul class="admin-list" aria-label={t('白名单')}>{overview.allowlist.map(entry => <li key={entry.email}>
      <span class="admin-email" translate={false}>{entry.email}</span>
      <span class="badge" data-source={entry.source}>{sourceLabels[entry.source]}</span>
      <span class="admin-state">{entry.account ? t('已登录过') : t('未登录')}</span>
      {entry.source === 'file' && overview.editable && (confirming === entry.email
        ? <span class="admin-confirm"><button type="button" class="button button-destructive" disabled={Boolean(busy)} onClick={() => { setConfirming(undefined); onRemove(entry.email); }}>{t('确认移除')}</button>
          <button type="button" class="text-button" onClick={() => setConfirming(undefined)}>{t('取消')}</button></span>
        : <button type="button" class="text-button admin-remove" disabled={Boolean(busy)} aria-label={t('移除 {0}', entry.email)} onClick={() => setConfirming(entry.email)}>{t('移除')}</button>)}
    </li>)}</ul>
  </>;
}

function Accounts({ accounts, busy, onSuspend }: { accounts: WebAdminOverview['accounts'] } & Pick<AdminPanelProps, 'busy' | 'onSuspend'>) {
  const [confirming, setConfirming] = useState<string>();
  if (!accounts.length) return <p class="field-note">{t('还没有账号登录过。')}</p>;
  // Counts for the current allowance window, in the same order as the allowance sentence above the table.
  const usage = (account: WebAdminOverview['accounts'][number]) => account.usage
    ? t('研究 {0} · 形式化 {1} · 讲解 {2}', account.usage.research, account.usage.formalizations, account.usage.explanations) : '—';
  return <div class="admin-table-scroll" tabindex={0} aria-label={t('账号列表')}><table class="admin-table">
    <thead><tr><th scope="col">{t('用户名或邮箱')}</th><th scope="col">{t('账号创建')}</th><th scope="col">{t('首次提交运行')}</th><th scope="col">{t('首次通过验收')}</th><th scope="col">{t('本窗口用量')}</th>{onSuspend && <th scope="col">{t('账号状态')}</th>}</tr></thead>
    <tbody>{accounts.map(account => {
      const login = accountLogin(account);
      return <tr key={login}>
      <th scope="row"><span translate={false}>{login}</span>{account.admin && <span class="badge" data-source="admin">{t('管理员')}</span>}
        {account.suspended ? <span class="badge warning">{t('已暂停')}</span> : !account.allowed && <span class="badge warning">{t('已移出白名单')}</span>}</th>
      <td>{date(account.createdAt)}</td><td>{date(account.firstRunAt)}</td><td>{date(account.firstAcceptedAt)}</td>
      <td class="admin-usage">{usage(account)}</td>{onSuspend && <td>{!account.admin && (confirming === login
        ? <span class="admin-confirm"><button type="button" class="button button-destructive" disabled={Boolean(busy)}
          onClick={() => { setConfirming(undefined); onSuspend(login, !account.suspended); }}>{account.suspended ? t('确认恢复') : t('确认暂停')}</button>
          <button type="button" class="text-button" onClick={() => setConfirming(undefined)}>{t('取消')}</button></span>
        : <button type="button" class="text-button" disabled={Boolean(busy)} aria-label={account.suspended ? t('恢复 {0}', login) : t('暂停 {0}', login)}
          onClick={() => setConfirming(login)}>{account.suspended ? t('恢复账号') : t('暂停账号')}</button>)}</td>}</tr>;
    })}</tbody>
  </table></div>;
}

function AdminPanel(props: AdminPanelProps) {
  const { overview, error } = props;
  return <>
    {error && <div class="inline-error" role="alert">{error}</div>}
    {!overview ? !error && <p class="field-note" role="status">{t('正在读取…')}</p> : <>
      <section aria-labelledby="admin-funnel-heading"><h3 id="admin-funnel-heading">{t('内测漏斗')}</h3><Funnel steps={overview.funnel} /></section>
      <section aria-labelledby="admin-allowlist-heading"><h3 id="admin-allowlist-heading">{t('白名单')}</h3>
        <p class="field-note">{overview.signup === 'open'
          ? t('目前开放注册，白名单只记录邀请来源。需要限制某个账号时，请在账号列表中暂停。')
          : t('白名单里的邮箱才能收到登录验证码。移出后对方会立即退出登录，账号和运行记录保留。')}</p>
        <Allowlist {...props} overview={overview} /></section>
      <section aria-labelledby="admin-accounts-heading"><h3 id="admin-accounts-heading">{t('账号')}</h3><Accounts accounts={overview.accounts} busy={props.busy} onSuspend={props.onSuspend} />
        {props.onSuspend && <p class="field-note">{t('暂停会阻止登录并停止正在进行的任务，已有记录保留；恢复后可重新登录。管理员账号不能暂停。')}</p>}
        <p class="field-note admin-scope">{t('管理员可查看用户名或邮箱、账号状态、用量和使用时间，看不到其他账号的题目、证明和运行记录。')}</p></section>
    </>}
  </>;
}

export function renderAdminPanel(root: HTMLElement, props: AdminPanelProps) { render(<AdminPanel {...props} />, root); }
