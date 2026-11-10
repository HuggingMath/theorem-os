import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { locale, localizeMessage } from '../i18n';
import type { ProblemDraftValue } from '../problemDraftTypes';
import type { ResearchAccountDraft, ResearchAccountDraftResult } from '../researchPersonalTypes';
import type { TaskDraft } from './draft';
import type { ResearchReleaseRef } from '../researchAssetTypes';

const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
type Binding = { draftKey: string; revision: number; title: string };
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const base = '/api/research/personal/drafts';
const bindingKey = (owner: string, mode: ProblemDraftValue['mode']) => `theorem-os.problem-draft.${owner}.${mode}`;
export const problemDraftSignature = (value: ProblemDraftValue, title: string) => JSON.stringify([title, value], (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
function readBinding(owner: string, mode: ProblemDraftValue['mode']): Binding {
  try {
    const value = JSON.parse(sessionStorage.getItem(bindingKey(owner, mode)) ?? 'null') as Binding | null;
    if (value && keyPattern.test(value.draftKey) && Number.isSafeInteger(value.revision) && value.revision >= 0 && typeof value.title === 'string') return value;
  } catch { /* The editable draft still works when tab storage is disabled. */ }
  return { draftKey: crypto.randomUUID(), revision: 0, title: '' };
}
function rememberBinding(owner: string, mode: ProblemDraftValue['mode'], value: Binding) {
  try { sessionStorage.setItem(bindingKey(owner, mode), JSON.stringify(value)); } catch { /* Account saves do not require tab storage. */ }
}
export function leanProblemDraft(value: TaskDraft, libraries?: ResearchReleaseRef[]): Extract<ProblemDraftValue, { mode: 'lean' }> {
  // An unfinished editor can contain an invalid budget or an oversized source. Project safe fields here;
  // report validation on Save without interrupting typing or copying execution identities into a new problem.
  const draft: Extract<ProblemDraftValue, { mode: 'lean' }>['draft'] = {
    providerId: value.providerId, model: value.model, source: value.source, task: value.task, maxTurns: value.maxTurns,
    maxRunSeconds: value.maxRunSeconds, workers: value.workers, effort: value.effort, environment: value.environment,
    coordination: value.coordination, templateId: value.templateId,
    ...(value.maxTotalTokens !== undefined ? { maxTotalTokens: value.maxTotalTokens } : {}),
    ...(value.planApproval ? { planApproval: true } : {}), ...(value.modulePlan ? { modulePlan: structuredClone(value.modulePlan) } : {}),
    ...(value.knowledgeDigest !== undefined ? { knowledgeDigest: value.knowledgeDigest } : {}),
  };
  return { mode: 'lean', draft, ...(libraries?.length ? { libraries: libraries.map(({ assetId, version, digest }) => ({ assetId, version, ...(digest ? { digest } : {}) })) } : {}) };
}
export type ProblemDraftPanelProps = {
  owner: string; account: boolean; value: ProblemDraftValue; locked: boolean; request: Request;
  onRestore(value: ProblemDraftValue, beforeApply: () => void): Promise<void>;
  target?: { id: string; version?: string };
};

/** Uses the same private account versions, conflict preservation and lifecycle as other research drafts. */
export function ProblemDraftPanel(props: ProblemDraftPanelProps) {
  const [binding, setBinding] = useState(() => readBinding(props.owner, props.value.mode));
  const [title, setTitle] = useState(binding.title), [open, setOpen] = useState(Boolean(props.target));
  const [items, setItems] = useState<ResearchAccountDraft[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [savedSignature, setSavedSignature] = useState<string>(), [loaded, setLoaded] = useState(false);
  const live = useRef(props); live.current = props;
  const mounted = useRef(true), lock = useRef(false), pending = useRef<{ signature: string; body: object }>();
  const notify = (cause: unknown) => setError(cause instanceof TypeError ? tx('暂时无法连接服务，请重试。', 'Could not connect to the service. Please retry.')
    : cause instanceof Error ? localizeMessage(cause.message) : tx('操作未完成，请重试。', 'The action did not finish. Please retry.'));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const receive = (event: Event) => {
      const restored = (event as CustomEvent<{ owner: string; mode: ProblemDraftValue['mode']; binding: Binding; signature: string }>).detail;
      if (restored.owner !== props.owner || restored.mode !== props.value.mode) return;
      setBinding(restored.binding); setTitle(restored.binding.title); setSavedSignature(restored.signature);
    };
    window.addEventListener('theoremos-problem-draft-restored', receive);
    return () => window.removeEventListener('theoremos-problem-draft-restored', receive);
  }, [props.owner, props.value.mode]);
  const load = async () => {
    if (!props.account) return;
    try { const result = await props.request<{ items: ResearchAccountDraft[] }>(`${base}?kind=problem&status=all`);
      if (mounted.current) { setItems(result.items); setLoaded(true); setError(''); } } catch (cause) { if (mounted.current) notify(cause); }
  };
  useEffect(() => { if (open) void load(); }, [open]);
  const save = async () => {
    if (lock.current || props.locked || !props.account) return;
    if (!title.trim()) { setError(tx('请给草稿起一个名字。', 'Give this draft a name.')); return; }
    lock.current = true; setBusy(true); setError(''); setNotice('');
    const snapshot = structuredClone(props.value), savedTitle = title.trim();
    try {
      const signature = JSON.stringify([binding.draftKey, binding.revision, savedTitle, snapshot]);
      if (pending.current?.signature !== signature) pending.current = { signature, body: {
        requestId: crypto.randomUUID(), expectedRevision: binding.revision, scope: { kind: 'problem', draftKey: binding.draftKey }, value: snapshot,
        summary: savedTitle, deviceId: deviceId(), deviceName: /Mobile|Android|iPhone|iPad/u.test(navigator.userAgent) ? tx('手机 / 平板', 'Phone / tablet') : tx('电脑浏览器', 'Desktop browser'),
        clientUpdatedAt: new Date().toISOString(),
      } };
      const { item } = await props.request<{ item: ResearchAccountDraftResult<ProblemDraftValue> }>(base, { method: 'POST', body: JSON.stringify(pending.current.body) });
      pending.current = undefined; if (!mounted.current) return;
      const next = { ...binding, revision: item.version.revision, title: savedTitle }; setBinding(next); rememberBinding(props.owner, snapshot.mode, next);
      setSavedSignature(problemDraftSignature(snapshot, savedTitle));
      setNotice(item.conflict ? tx('另一台设备也有修改，两份版本都已保留。', 'Another device also made changes. Both versions are preserved.')
        : JSON.stringify(live.current.value) === JSON.stringify(snapshot) ? tx('已保存到账号，可在其他设备继续。', 'Saved to your account. Continue on another device.')
          : tx('刚才的版本已保存；新修改尚未保存到账号。', 'The earlier version was saved. Your new edits are not yet saved to your account.'));
      await load();
    } catch (cause) { if (mounted.current) notify(cause); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const restore = async (id: string, version: string) => {
    if (lock.current || props.locked) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    const before = JSON.stringify(props.value);
    try {
      const { item } = await props.request<{ item: ResearchAccountDraftResult<ProblemDraftValue> }>(`${base}/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`);
      if (!mounted.current) return;
      if (item.draft.scope.kind !== 'problem' || !item.draft.scope.draftKey) throw new Error(tx('这不是新题草稿。', 'This is not a new-problem draft.'));
      if (live.current.locked || JSON.stringify(live.current.value) !== before) throw new Error(tx('读取期间原题已修改，请重新选择恢复。', 'The problem changed while loading. Choose Restore again.'));
      if (item.version.status && item.version.status !== 'open') await props.request(`${base}/${encodeURIComponent(id)}`, { method: 'PATCH',
        body: JSON.stringify({ requestId: crypto.randomUUID(), versionId: version, action: 'restore' }) });
      if (!mounted.current) return;
      if (live.current.locked || JSON.stringify(live.current.value) !== before) throw new Error(tx('读取期间原题已修改，请重新选择恢复。', 'The problem changed while loading. Choose Restore again.'));
      const next = { draftKey: item.draft.scope.draftKey, revision: item.version.revision, title: item.version.summary };
      await props.onRestore(item.version.value, () => {
        rememberBinding(props.owner, item.version.value.mode, next);
        window.dispatchEvent(new CustomEvent('theoremos-problem-draft-restored', { detail: { owner: props.owner, mode: item.version.value.mode,
          binding: next, signature: problemDraftSignature(item.version.value, next.title) } }));
      });
      if (mounted.current && item.version.value.mode === props.value.mode) {
        setNotice(tx('已恢复到编辑器，核对后即可提交。', 'Restored in the editor. Review it before submitting.')); }
    } catch (cause) { if (mounted.current) notify(cause); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  return <details class="problem-account-drafts" data-problem-account-drafts open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{tx('保存与恢复原题草稿', 'Save and restore problem drafts')}</summary>
    <p>{tx('保存到账号后可跨设备恢复；不保存 API Key。', 'Save to your account to restore on another device. API keys are excluded.')}</p>
    {!props.account ? <p>{tx('当前草稿只在此标签页保留。登录账号后可跨设备保存。', 'This draft stays in this tab. Sign in to save across devices.')}</p> : <>
      <label>{tx('草稿名称', 'Draft name')}<input data-problem-draft-title maxLength={200} value={title} onInput={event => setTitle(event.currentTarget.value)} disabled={busy || props.locked} /></label>
      <div class="problem-draft-actions"><button class="button" type="button" data-save-problem-draft disabled={busy || props.locked} onClick={() => void save()}>{tx('保存到账号', 'Save to account')}</button>
        <button class="text-button" type="button" data-new-problem-draft disabled={busy || props.locked} onClick={() => { const next = { draftKey: crypto.randomUUID(), revision: 0, title: '' }; setBinding(next); setTitle(''); setSavedSignature(undefined); rememberBinding(props.owner, props.value.mode, next); setNotice(tx('填写新名称后保存，已有账号版本会保留。', 'Choose a new name and save. Existing account versions remain.')); }}>{tx('另存为新草稿', 'Save as a new draft')}</button>
        <a class="text-button" href="workspace.html?tab=drafts">{tx('所有账号草稿', 'All account drafts')}</a></div>
      <button class="text-button" type="button" disabled={busy} onClick={() => void load()}>{tx('刷新账号版本', 'Refresh account versions')}</button>
      {items.map(item => <details key={item.id} data-problem-draft={item.id} open={item.id === props.target?.id}><summary>{item.versions[0]?.summary}</summary>
        {item.versions.map(version => <div class="problem-draft-version" key={version.id} data-problem-draft-version={version.id} data-requested={item.id === props.target?.id && (!props.target.version || version.id === props.target.version)}>
          <p>{version.summary} · {tx('版本', 'Version')} {version.revision} · {version.deviceName}{version.conflict ? ` · ${tx('并行版本已保留', 'Parallel version preserved')}` : ''}</p>
          <button class="button" type="button" data-restore-problem-draft disabled={busy || props.locked} onClick={() => void restore(item.id, version.id)}>{tx('恢复这个版本', 'Restore this version')}</button></div>)}</details>)}
      {loaded && props.target && !items.some(item => item.id === props.target?.id && (!props.target?.version || item.versions.some(version => version.id === props.target?.version))) && <p role="alert">{tx('这个账号中没有找到链接指定的草稿版本。', 'The linked draft version was not found in this account.')}</p>}
      {loaded && !items.length && <p>{tx('还没有保存过原题草稿。', 'No problem drafts saved yet.')}</p>}
    </>}
    {busy && <p role="status">{tx('正在处理…', 'Working…')}</p>}{error && <p class="inline-error" role="alert">{error}</p>}
    {(notice || savedSignature) && <p role="status" data-problem-draft-notice>{savedSignature && savedSignature !== problemDraftSignature(props.value, title.trim())
      ? tx('新修改尚未保存到账号。', 'Your new edits are not yet saved to your account.') : notice}</p>}
  </details>;
}
function deviceId() {
  try { const key = 'theoremos:research-draft-device', id = localStorage.getItem(key) ?? crypto.randomUUID(); localStorage.setItem(key, id); return id; }
  catch { return crypto.randomUUID(); }
}
export function renderProblemDraftPanel(host: HTMLElement, props?: ProblemDraftPanelProps) {
  render(props ? <ProblemDraftPanel key={`${props.owner}:${props.value.mode}`} {...props} /> : null, host);
}
