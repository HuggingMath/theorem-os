import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { locale, localizeMessage } from '../i18n';
import type { ProblemDraftValue } from '../problemDraftTypes';
import type { ResearchAccountDraft, ResearchAccountDraftResult } from '../researchPersonalTypes';
import type { TaskDraft } from './draft';
import type { ResearchReleaseRef } from '../researchAssetTypes';
import { problemDraftApi as base, readProblemDraftBinding as readBinding, rememberProblemDraftBinding as rememberBinding, resetProblemDraftBinding,
  problemDraftDeviceId as deviceId, problemDraftSignature, problemDraftSyncPending, syncProblemDraftSubmissions,
  type ProblemDraftBinding as Binding, type ProblemDraftRequest as Request } from './problemDraftLifecycle';
export { problemDraftSignature } from './problemDraftLifecycle';

const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
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
    ...(value.sharedProofOrigin ? { sharedProofOrigin: { ...value.sharedProofOrigin } } : {}),
    ...(value.classicOrigin ? { classicOrigin: { ...value.classicOrigin } } : {}),
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
  const [savedSignature, setSavedSignature] = useState(binding.savedSignature), [loaded, setLoaded] = useState(false);
  const [showArchived, setShowArchived] = useState(Boolean(props.target)), [syncPending, setSyncPending] = useState(problemDraftSyncPending(props.owner));
  const live = useRef(props); live.current = props;
  const mounted = useRef(true), lock = useRef(false), pending = useRef<{ signature: string; body: object }>();
  const notify = (cause: unknown) => setError(cause instanceof TypeError ? tx('暂时无法连接服务，请重试。', 'Could not connect to the service. Please retry.')
    : cause instanceof Error ? localizeMessage(cause.message) : tx('操作未完成，请重试。', 'The action did not finish. Please retry.'));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const receive = (event: Event) => {
      const restored = (event as CustomEvent<{ owner: string; mode: ProblemDraftValue['mode']; binding: Binding }>).detail;
      if (restored.owner !== props.owner || restored.mode !== props.value.mode) return;
      setBinding(restored.binding); setTitle(restored.binding.title); setSavedSignature(restored.binding.savedSignature); setNotice('');
    };
    window.addEventListener('theoremos-problem-draft-restored', receive);
    return () => window.removeEventListener('theoremos-problem-draft-restored', receive);
  }, [props.owner, props.value.mode]);
  const load = async () => {
    if (!props.account) return;
    try { const result = await props.request<{ items: ResearchAccountDraft[] }>(`${base}?kind=problem&status=all`);
      if (mounted.current) { setItems(result.items); setLoaded(true); setError(''); }
      const active = readBinding(props.owner, props.value.mode);
      if (active.revision && !active.savedSignature) {
        const draft = result.items.find(item => item.scope.draftKey === active.draftKey), version = draft?.versions.find(item => item.revision === active.revision);
        if (draft && version) {
          const { item } = await props.request<{ item: ResearchAccountDraftResult<ProblemDraftValue> }>(`${base}/${encodeURIComponent(draft.id)}?version=${encodeURIComponent(version.id)}`);
          const latest = readBinding(props.owner, props.value.mode);
          if (mounted.current && latest.draftKey === active.draftKey && latest.revision === active.revision && !latest.savedSignature) {
            rememberBinding(props.owner, props.value.mode, { ...latest, draftId: draft.id, versionId: version.id,
              savedSignature: problemDraftSignature(item.version.value, item.version.summary) }, true);
          }
        }
      } } catch (cause) { if (mounted.current) notify(cause); }
  };
  useEffect(() => { if (open) void load(); }, [open]);
  useEffect(() => {
    if (!props.account) return;
    if (binding.revision && !binding.savedSignature && !open) void load();
    void syncProblemDraftSubmissions(props.owner, props.request).then(synced => {
      if (mounted.current) { setSyncPending(!synced); if (open) void load(); }
    });
  }, []);
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
      const next = { ...binding, revision: item.version.revision, title: savedTitle, draftId: item.draft.id, versionId: item.version.id, savedSignature: problemDraftSignature(snapshot, savedTitle) }; setBinding(next); rememberBinding(props.owner, snapshot.mode, next);
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
      if (item.version.status === 'discarded') await props.request(`${base}/${encodeURIComponent(id)}`, { method: 'PATCH',
        body: JSON.stringify({ requestId: crypto.randomUUID(), versionId: version, action: 'restore' }) });
      if (!mounted.current) return;
      if (live.current.locked || JSON.stringify(live.current.value) !== before) throw new Error(tx('读取期间原题已修改，请重新选择恢复。', 'The problem changed while loading. Choose Restore again.'));
      const submitted = item.version.status === 'submitted';
      const next: Binding = submitted ? { draftKey: crypto.randomUUID(), revision: 0, title: item.version.summary } : {
        draftKey: item.draft.scope.draftKey, revision: item.version.revision, title: item.version.summary, draftId: item.draft.id,
        versionId: item.version.id, savedSignature: problemDraftSignature(item.version.value, item.version.summary),
      };
      await props.onRestore(item.version.value, () => {
        rememberBinding(props.owner, item.version.value.mode, next, true);
      });
      if (mounted.current && item.version.value.mode === props.value.mode) {
        setNotice(submitted ? tx('已复制为新题，原提交记录和归档版本会保留。请先保存这份新草稿。', 'Copied into a new problem. The original submission and archived version remain. Save this new draft first.') : tx('已恢复到编辑器，核对后即可提交。', 'Restored in the editor. Review it before submitting.')); void load(); }
    } catch (cause) { if (mounted.current) notify(cause); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const visible = items.map(item => ({ ...item, versions: item.versions.filter(version => showArchived || (version.status ?? 'open') === 'open') })).filter(item => item.versions.length);
  return <details class="problem-account-drafts" data-problem-account-drafts open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{tx('保存与恢复原题草稿', 'Save and restore problem drafts')}</summary>
    <p>{tx('保存到账号后可跨设备恢复；不保存 API Key。', 'Save to your account to restore on another device. API keys are excluded.')}</p>
    {!props.account ? <p>{tx('当前草稿只在此标签页保留。登录账号后可跨设备保存。', 'This draft stays in this tab. Sign in to save across devices.')}</p> : <>
      <label>{tx('草稿名称', 'Draft name')}<input data-problem-draft-title maxLength={200} value={title} onInput={event => { const title = event.currentTarget.value; setTitle(title); const next = { ...binding, title }; setBinding(next); rememberBinding(props.owner, props.value.mode, next); }} disabled={busy || props.locked} /></label>
      <div class="problem-draft-actions"><button class="button" type="button" data-save-problem-draft disabled={busy || props.locked} onClick={() => void save()}>{tx('保存到账号', 'Save to account')}</button>
        <button class="text-button" type="button" data-new-problem-draft disabled={busy || props.locked} onClick={() => { resetProblemDraftBinding(props.owner, props.value.mode); setNotice(tx('填写新名称后保存，已有账号版本会保留。', 'Choose a new name and save. Existing account versions remain.')); }}>{tx('另存为新草稿', 'Save as a new draft')}</button>
        <a class="text-button" href="workspace.html?tab=drafts">{tx('所有账号草稿', 'All account drafts')}</a></div>
      <button class="text-button" type="button" disabled={busy} onClick={() => void load()}>{tx('刷新账号版本', 'Refresh account versions')}</button>
      <label class="research-check"><input type="checkbox" data-problem-show-archived-drafts checked={showArchived} onChange={event => setShowArchived(event.currentTarget.checked)} />{tx('显示已提交或已丢弃的草稿', 'Show submitted and discarded drafts')}</label>
      {visible.map(item => <details key={item.id} data-problem-draft={item.id} open={item.id === props.target?.id}><summary>{item.versions[0]?.summary}</summary>
        {item.versions.map(version => <div class="problem-draft-version" key={version.id} data-problem-draft-version={version.id} data-requested={item.id === props.target?.id && (!props.target.version || version.id === props.target.version)}>
          <p data-draft-status={version.status ?? 'open'}>{version.status === 'submitted' ? tx('已提交并归档', 'Submitted and archived') : version.status === 'discarded' ? tx('已丢弃', 'Discarded') : tx('未提交', 'Not submitted')} · {version.summary} · {tx('版本', 'Version')} {version.revision} · {version.deviceName}{version.conflict ? ` · ${tx('并行版本已保留', 'Parallel version preserved')}` : ''}</p>
          <button class="button" type="button" data-restore-problem-draft disabled={busy || props.locked} onClick={() => void restore(item.id, version.id)}>{version.status === 'submitted' ? tx('以此原题另起一题', 'Start a new problem from this version') : version.status === 'discarded' ? tx('恢复为待处理草稿', 'Restore as an unfinished draft') : tx('恢复这个版本', 'Restore this version')}</button>
          {version.submission?.href && <a class="text-button" href={version.submission.href}>{tx('查看实际提交记录', 'Open the submitted record')}</a>}
          {version.status === 'submitted' && <p>{tx('复制为独立新题，原提交记录与归档状态保留。', 'Creates an independent problem and keeps the original submission archived.')}</p>}
          {version.status === 'discarded' && <p>{tx('恢复后会重新出现在未完成草稿中。', 'Restoring returns this version to unfinished drafts.')}</p>}</div>)}</details>)}
      {loaded && props.target && !items.some(item => item.id === props.target?.id && (!props.target?.version || item.versions.some(version => version.id === props.target?.version))) && <p role="alert">{tx('这个账号中没有找到链接指定的草稿版本。', 'The linked draft version was not found in this account.')}</p>}
      {loaded && !visible.length && <p>{tx('没有未完成的原题草稿，可切换查看归档版本。', 'No unfinished problem drafts. Show archived versions to view earlier work.')}</p>}
    </>}
    {syncPending && <p role="status" data-problem-draft-sync>{tx('任务已创建，草稿归档待同步。', 'The task was created. Draft archiving is waiting to sync.')} <button type="button" class="text-button" onClick={() => void syncProblemDraftSubmissions(props.owner, props.request).then(synced => { setSyncPending(!synced); void load(); })}>{tx('重试同步', 'Retry sync')}</button></p>}
    {busy && <p role="status">{tx('正在处理…', 'Working…')}</p>}{error && <p class="inline-error" role="alert">{error}</p>}
    {(notice || savedSignature) && <p role="status" data-problem-draft-notice>{savedSignature && savedSignature !== problemDraftSignature(props.value, title.trim())
      ? tx('新修改尚未保存到账号。', 'Your new edits are not yet saved to your account.') : notice || tx('当前内容已保存到账号。', 'The current content is saved to your account.')}</p>}
  </details>;
}
export function renderProblemDraftPanel(host: HTMLElement, props?: ProblemDraftPanelProps) {
  render(props ? <ProblemDraftPanel key={`${props.owner}:${props.value.mode}`} {...props} /> : null, host);
}
