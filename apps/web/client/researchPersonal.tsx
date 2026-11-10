import { useEffect, useRef, useState } from 'preact/hooks';
import type { ResearchPersonalProblem, ResearchPersonalTarget, ResearchAccountDraft } from '../researchPersonalTypes';
import type { ResearchProblem } from '../researchProblemTypes';
import type { WebApi } from './collaborationUi';
import { api, base, ErrorBox, errorText, Field, stamp, tx, type Item, type ResearchContext } from './researchShared';
import { RichProse } from './richText';
import { webDraftOwner } from './ownedDrafts';
import { mergeOrganizationEdits, organizationDraftKey, organizationValues, readOrganizationDraft, writeOrganizationDraft, type OrganizationField, type OrganizationValues } from './researchOrganizationDraft';

export const personalProblemUrl = (target: ResearchPersonalTarget) => `${base}/personal/problems?${new URLSearchParams({
  ...(target.runId ? { runId: target.runId } : {}), ...(target.projectId ? { projectId: target.projectId } : {}),
})}`;
const stateLabel = (value: ResearchPersonalProblem['status']) => value === 'active' ? tx('持续研究', 'Active research') : value === 'parked' ? tx('暂放', 'Parked') : tx('已归档', 'Archived');

export function PersonalProblemControl({ owner, target, item, onSaved, compact = false, request = api }: {
  owner: string; target: ResearchPersonalTarget; item?: ResearchPersonalProblem; onSaved?(value: ResearchPersonalProblem): void; compact?: boolean; request?: WebApi;
}) {
  const [record, setRecord] = useState<ResearchPersonalProblem>(item ?? { key: '', target, revision: 0, pinned: false, status: 'active', tags: [], nextNote: '' });
  const [values, setValues] = useState(() => organizationValues(item)), current = useRef(values);
  const [dirty, setDirty] = useState(false), [draftError, setDraftError] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [ready, setReady] = useState(Boolean(item));
  const lock = useRef(false), pending = useRef<{ signature: string; input: object }>();
  const edited = useRef(new Set<OrganizationField>()), revision = useRef(record.revision), backupFailed = useRef(false);
  const url = personalProblemUrl(target), draftKey = organizationDraftKey(owner, target);
  const persist = () => {
    try { writeOrganizationDraft(localStorage, draftKey, { baseRevision: revision.current, values: current.current, edited: [...edited.current] }); backupFailed.current = false; setDraftError(''); }
    catch { backupFailed.current = true; setDraftError(tx('本机备份未保存，请保留当前页面或复制内容。', 'The local backup could not be saved. Keep this page open or copy your work.')); }
  };
  const change = <K extends OrganizationField>(field: K, value: OrganizationValues[K]) => {
    edited.current.add(field); current.current = { ...current.current, [field]: value }; setValues(current.current); setDirty(true); setNotice(''); persist();
  };
  const applySaved = (latest: ResearchPersonalProblem) => {
    revision.current = latest.revision; setRecord(latest); setReady(true); setError('');
    current.current = mergeOrganizationEdits(organizationValues(latest), current.current, edited.current); setValues(current.current);
  };
  const load = async (keepEdits = false) => {
    try {
      const { item: latest } = await request<Item<ResearchPersonalProblem>>(url);
      if (!keepEdits) edited.current.clear(); applySaved(latest);
    } catch (cause) { setError(errorText(cause)); }
  };
  useEffect(() => { let live = true;
    try { const saved = readOrganizationDraft(localStorage, draftKey); if (saved) {
      edited.current = new Set(saved.edited); current.current = mergeOrganizationEdits(current.current, saved.values, edited.current); setValues(current.current); setDirty(true);
      setNotice(tx('已恢复本机尚未保存的整理，请核对后保存。', 'Your unsaved organization is restored from this browser. Review it before saving.'));
    } } catch { setDraftError(tx('本机备份无法读取，已保存的整理仍可读取。', 'The local backup could not be read. Your saved organization is still available.')); }
    setReady(Boolean(item)); if (item) applySaved(item);
    else request<Item<ResearchPersonalProblem>>(url).then(({ item: next }) => { if (live) {
      applySaved(next);
      if (edited.current.size) setNotice(tx('此前的整理已读入，新修改还没保存。', 'Your saved organization is loaded. Your new edits are not saved yet.'));
    } }).catch(cause => { if (live) setError(errorText(cause)); });
    return () => { live = false; };
  }, [url, request, owner]);
  useEffect(() => { if (item && item.revision !== revision.current) applySaved(item); }, [item?.revision]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (edited.current.size && backupFailed.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const save = async () => {
    if (lock.current || !ready) return; lock.current = true; setBusy(true); setError(''); setNotice('');
    const submitted = current.current;
    const value = { ...submitted, tags: submitted.tags.split(/[,，\n]/u).map(tag => tag.trim()).filter(Boolean) };
    const signature = JSON.stringify([url, record.revision, value]);
    if (pending.current?.signature !== signature) pending.current = { signature, input: { requestId: crypto.randomUUID(), expectedRevision: record.revision, ...value } };
    try {
      const { item: saved } = await request<Item<ResearchPersonalProblem>>(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending.current.input) });
      pending.current = undefined; revision.current = saved.revision; setRecord(saved);
      if (JSON.stringify(current.current) === JSON.stringify(submitted)) {
        edited.current.clear(); current.current = organizationValues(saved); setValues(current.current); setDirty(false);
        try { localStorage.removeItem(draftKey); setDraftError(''); } catch { setDraftError(tx('整理已保存，本机备份尚未清理。', 'Your organization is saved. The local backup could not be cleared.')); }
        setNotice(tx('个人整理已保存。', 'Your organization is saved.'));
      } else {
        persist(); setNotice(tx('上一版已保存，还有新修改未保存。', 'The previous version is saved. Your new edits are not saved yet.'));
      }
      onSaved?.(saved);
      window.dispatchEvent(new CustomEvent('theoremos-personal-problem-updated', { detail: saved }));
    } catch (cause) { setError(errorText(cause)); }
    finally { lock.current = false; setBusy(false); }
  };
  return <details class={`research-personal-problem${compact ? ' research-personal-problem-compact' : ''}`} data-personal-problem={record.key}>
    <summary>{tx('个人整理', 'Organize for myself')}<span>{record.pinned ? `${tx('已置顶', 'Pinned')} · ` : ''}{stateLabel(record.status)}{record.tags.length ? ` · ${record.tags.join(' / ')}` : ''}</span></summary>
    <p class="research-field-note">{tx('只保存在你的研究空间，独立于运行状态与证明验收。', 'Private to your research space, separate from run status and proof acceptance.')}</p>
    {!ready && !error && <p role="status" data-personal-loading>{tx('正在读取个人整理…', 'Loading your organization…')}</p>}
    <form class="research-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label class="research-check"><input type="checkbox" data-personal-pinned checked={values.pinned} onChange={event => change('pinned', event.currentTarget.checked)} />{tx('置顶这道题', 'Pin this problem')}</label>
      <label>{tx('整理状态', 'Organization status')}<select value={values.status} data-personal-status onChange={event => change('status', event.currentTarget.value as ResearchPersonalProblem['status'])}>
        <option value="active">{stateLabel('active')}</option><option value="parked">{stateLabel('parked')}</option><option value="archived">{stateLabel('archived')}</option></select></label>
      <Field label={tx('标签', 'Tags')} value={values.tags} onInput={value => change('tags', value)} maxLength={500} placeholder={tx('例如：数论、待补引理；用逗号分隔', 'For example: number theory, missing lemma; separate with commas')} />
      <Field label={tx('下次从这里继续', 'Next time, start here')} value={values.nextNote} onInput={value => change('nextNote', value)} multiline rows={3} maxLength={4000} />
      <button class="button" type="submit" data-save-personal-problem disabled={busy || !ready}>{busy ? tx('正在保存…', 'Saving…') : tx('保存个人整理', 'Save organization')}</button>
    </form>
    <ErrorBox message={error} />{error && <button type="button" class="text-button" onClick={() => void load(true)}>{tx('读取最新整理，保留当前输入', 'Load the latest organization and keep my edits')}</button>}
    <ErrorBox message={draftError} />
    {(dirty || notice) && <p role="status" data-personal-unsaved={dirty ? true : undefined} data-personal-notice={notice ? true : undefined}>
      {notice || tx('还有修改未保存到账号。', 'You have changes that are not saved to your account.')}</p>}
  </details>;
}

export function ProblemOrganization({ problem, context }: { problem: Pick<ResearchProblem, 'key' | 'brief' | 'project'>; context?: ResearchContext }) {
  if (context && !context.session.authenticated) return null;
  if (!context) return null;
  const owner = webDraftOwner(context.web), target = { runId: problem.brief.selectedRunId, ...(problem.project ? { projectId: problem.project.id } : {}) };
  return <PersonalProblemControl key={`${owner}:${personalProblemUrl(target)}`} owner={owner} target={target} />;
}

export function accountDraftHref(draft: ResearchAccountDraft, versionId?: string) {
  const scope = draft.scope, parameters = new URLSearchParams({ ...(scope.projectId ? { id: scope.projectId } : {}), accountDraft: draft.id });
  if (versionId) parameters.set('draftVersion', versionId);
  if (scope.kind === 'problem') return `./?${parameters}`;
  if (scope.statementVersionId) parameters.set('version', scope.statementVersionId);
  if (scope.runId) parameters.set('run', scope.runId);
  if (scope.taskId) parameters.set('task', scope.taskId);
  if (scope.taskVersion) parameters.set('taskVersion', scope.taskVersion);
  if (scope.commit) parameters.set('commit', scope.commit);
  if (['guidance', 'annotation', 'annotation-reply', 'review'].includes(scope.kind) && scope.runId) {
    parameters.delete('id'); if (scope.projectId) parameters.set('project', scope.projectId); parameters.set('tab', 'route');
    if (scope.threadId) parameters.set('annotation', scope.threadId);
    if (scope.sourceFeedbackId) parameters.set('feedback', scope.sourceFeedbackId);
    return `problem.html?${parameters}`;
  }
  if (scope.kind === 'review' && scope.sourceFeedbackId) parameters.set('feedback', scope.sourceFeedbackId);
  if (scope.kind === 'candidate' && scope.sourceFeedbackId) parameters.set('revise', scope.sourceFeedbackId);
  return `theorems.html?${parameters}#${scope.kind === 'candidate' ? 'candidate-composer' : scope.issueId ? `issue-${scope.issueId}` : scope.kind === 'issue' ? 'collaboration-issues' : 'project-feedback'}`;
}

export function PersonalDraftsPanel({ context, projectId }: { context?: ResearchContext; projectId?: string }) {
  const [items, setItems] = useState<ResearchAccountDraft[]>([]), [account, setAccount] = useState(true), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const reload = async () => {
    setLoading(true);
    try { const result = await api<{ account: boolean; items: ResearchAccountDraft[] }>(`${base}/personal/drafts?${new URLSearchParams({ status: 'all', ...(projectId ? { projectId } : {}) })}`);
      setItems(result.items); setAccount(result.account); setError(''); } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); }
  };
  const visible = items.map(item => ({ ...item, versions: item.versions.filter(version => showArchived || (version.status ?? 'open') === 'open') })).filter(item => item.versions.length);
  const discard = async (id: string, versionId: string) => {
    setLoading(true); setError('');
    try { await api(`${base}/personal/drafts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ requestId: crypto.randomUUID(), versionId, action: 'discard' }) }); await reload(); }
    catch (cause) { setError(errorText(cause)); } finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, [context?.session.researcherId, projectId]);
  return <section class="research-personal-drafts" data-personal-drafts-panel><div class="research-section-head"><h3>{tx('账号草稿', 'Account drafts')}</h3>
    <button class="text-button" type="button" disabled={loading} onClick={() => void reload()}>{tx('刷新版本', 'Refresh versions')}</button></div>
    <ErrorBox message={error} />{loading && <p role="status">{tx('正在读取账号草稿…', 'Loading account drafts…')}</p>}
    {account && <label class="research-check"><input type="checkbox" data-personal-show-archived-drafts checked={showArchived} onChange={event => setShowArchived(event.currentTarget.checked)} />{tx('显示已提交或已丢弃的草稿', 'Show submitted and discarded drafts')}</label>}
    {!account && <p>{tx('登录账号后，可以把编辑中的内容保存到账号，在其他设备继续。', 'Sign in to save work in progress to your account and continue on another device.')}</p>}
    {visible.map(item => <details key={item.id} data-personal-draft={item.id}><summary>{item.versions[0]?.summary}</summary>
      {item.versions.map(version => <article class="collaboration-draft" key={version.id}><p>{version.deviceName} · {stamp(version.savedAt)} · {tx('版本', 'Version')} {version.revision}</p>
        {version.conflict && <p>{tx('与另一台设备的编辑同时保存，两份内容均保留。', 'Saved alongside another device’s work. Both versions are preserved.')}</p>}
        {version.status && version.status !== 'open' && <p data-draft-status={version.status}>{version.status === 'submitted' ? tx('已提交并归档', 'Submitted and archived') : tx('已丢弃', 'Discarded')}{version.submission?.href && <> · <a href={version.submission.href}>{tx('查看实际提交记录', 'Open the submitted record')}</a></>}</p>}
        <a class="button" href={accountDraftHref(item, version.id)}>{item.scope.kind === 'problem' && version.status === 'submitted' ? tx('以此原题另起一题', 'Start a new problem from this version') : tx('回到编辑器恢复', 'Open the editor to restore')}</a>
        {(version.status ?? 'open') === 'open' && <button class="text-button" type="button" data-personal-discard-account-draft disabled={loading} onClick={() => void discard(item.id, version.id)}>{tx('丢弃这个账号版本', 'Discard this account version')}</button>}</article>)}</details>)}
    {account && !visible.length && !loading && !error && <p>{tx('没有未完成的账号草稿。编辑器中可保存工作，也可查看已归档版本。', 'No unfinished account drafts. Save work from an editor or show archived versions.')}</p>}
  </section>;
}

export function PersonalNextNote({ item }: { item?: ResearchPersonalProblem }) {
  return item?.nextNote ? <div class="research-personal-next-note"><span>{tx('下次继续', 'Continue next time')}</span><RichProse text={item.nextNote} /></div> : null;
}
