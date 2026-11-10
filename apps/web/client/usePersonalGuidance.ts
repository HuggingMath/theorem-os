import { useEffect, useRef, useState } from 'preact/hooks';
import type { WebCommandResult, WebObservation } from '../collaboration';
import { api, enc, errorText, ResearchHttpError, tx } from './researchShared';
import { personalGuidanceKey, personalGuidanceTargetCurrent, readPersonalGuidance, removePersonalGuidance, savePersonalGuidance, type PersonalGuidanceAttempt } from './personalGuidanceStore';

export function usePersonalGuidance(owner: string, runId: string, root: string, observation: WebObservation, running: boolean,
  enabled: boolean, refresh: () => void, onSaved: (attempt: PersonalGuidanceAttempt, receipt: WebCommandResult) => void) {
  const pending = useRef<PersonalGuidanceAttempt>(), lock = useRef(false), live = useRef(true);
  const [attempt, setAttempt] = useState<PersonalGuidanceAttempt>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [blocked, setBlocked] = useState(false), [receipt, setReceipt] = useState<WebCommandResult>();
  const latest = useRef({ observation, running, refresh, onSaved }); latest.current = { observation, running, refresh, onSaved };
  const record = (value: PersonalGuidanceAttempt | undefined) => { pending.current = value; if (live.current) setAttempt(value); };
  const resolve = async (submission: PersonalGuidanceAttempt, mode: 'send' | 'query' | 'retry') => {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try {
      let result: WebCommandResult | undefined;
      if (mode !== 'send') {
        try { result = (await api<{ receipt: WebCommandResult }>(`${root}/commands/${enc(submission.body.id)}`)).receipt; }
        catch (cause) { if (!(cause instanceof ResearchHttpError && cause.status === 404)) throw cause; }
      }
      if (!live.current) return;
      if (!result && mode === 'query') return;
      if (!result && mode === 'retry' && !personalGuidanceTargetCurrent(submission, latest.current.observation, latest.current.running)) {
        setError(tx('原指导对应的路线或任务版本已变化。请继续查询原回执；正在编辑的草稿会保留。', 'The original route or task version has changed. Keep checking its receipt; your current draft is preserved.')); return;
      }
      result ??= (await api<{ receipt: WebCommandResult }>(`${root}/guidance`, { method: 'POST', body: JSON.stringify(submission.body) })).receipt;
      if (result.id !== submission.body.id) throw new Error(tx('回执与原提交不一致，请重新查询。', 'The receipt does not match the original submission. Check again.'));
      if (!live.current) return;
      setReceipt(result);
      if (['queued', 'delivered', 'deferred', 'failed', 'rejected'].includes(result.status)) {
        removePersonalGuidance(localStorage, owner, runId, submission.body.id); record(readPersonalGuidance(localStorage, owner, runId));
        if (!['failed', 'rejected'].includes(result.status)) latest.current.onSaved(submission, result);
      }
      latest.current.refresh();
    } catch (cause) { if (live.current) setError(errorText(cause)); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  };
  const recover = () => {
    if (!enabled || lock.current) return;
    try { const saved = readPersonalGuidance(localStorage, owner, runId); record(saved); setBlocked(false); setError(''); if (saved) void resolve(saved, 'query'); }
    catch { setBlocked(true); setError(tx('无法读取待确认指导。恢复浏览器存储后重试，以免重复提交。', 'Pending guidance could not be read. Restore browser storage and check again before sending.')); }
  };
  useEffect(() => {
    live.current = true; recover();
    const changed = (event: StorageEvent) => { if (event.key === personalGuidanceKey(owner, runId)) recover(); };
    window.addEventListener('storage', changed);
    return () => { live.current = false; window.removeEventListener('storage', changed); };
  }, []);
  const send = (submission: PersonalGuidanceAttempt) => {
    if (lock.current || pending.current || blocked || !enabled) return;
    try {
      const existing = readPersonalGuidance(localStorage, owner, runId); if (existing) { record(existing); void resolve(existing, 'query'); return; }
      savePersonalGuidance(localStorage, owner, runId, submission); record(submission); setReceipt(undefined); void resolve(submission, 'send');
    } catch { setBlocked(true); setError(tx('待确认记录未能保存在本机，指导尚未发送。恢复浏览器存储后重试。', 'The pending record could not be saved locally, so guidance was not sent. Restore browser storage and try again.')); }
  };
  return { busy, error, receipt, attempt, blocked, recover, send,
    canRetry: Boolean(attempt && personalGuidanceTargetCurrent(attempt, observation, running)),
    query: () => pending.current && resolve(pending.current, 'query'), retry: () => pending.current && resolve(pending.current, 'retry') };
}
