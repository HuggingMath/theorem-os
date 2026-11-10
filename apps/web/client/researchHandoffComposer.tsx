import { useEffect, useRef, useState } from 'preact/hooks';
import type { ResearchFeedbackTarget, ResearchProjectDetail } from '../researchProjectTypes';
import { base, enc, ErrorBox, errorText, Field, MutationState, tx, useMutation } from './researchShared';
import { projectPeople, projectPersonLabel } from './researchMembers';
import { handoffDraftNeedsReview, readHandoffDraft, removeHandoffDraft, saveHandoffDraft, type HandoffDraft } from './researchHandoffDraft';

export function ResearchHandoffComposer({ project, selfId, target, feedbackIds, refresh }: { project: ResearchProjectDetail; selfId: string; target: ResearchFeedbackTarget; feedbackIds: string[]; refresh(): void }) {
  const scope = { owner: selfId, projectId: project.id, runId: target.runId, taskId: target.taskRef!.id };
  const people = projectPeople(project).filter(person => person.role !== 'reader' && person.id !== selfId);
  const members = JSON.stringify(people.map(person => [person.id, person.role]).sort());
  const [error, setError] = useState(''), [restored, setRestored] = useState(false), action = useMutation();
  const [draft, setDraft] = useState<HandoffDraft>({ target, recipientId: '', note: '', members, revision: crypto.randomUUID() });
  const current = useRef(draft), alive = useRef(true); current.current = draft;
  useEffect(() => {
    alive.current = true;
    try { const saved = readHandoffDraft(localStorage, scope); if (saved) { current.current = saved; setDraft(saved); setRestored(true); } }
    catch { setError(tx('无法读取本机交接草稿，请检查浏览器存储。', 'The local handoff draft could not be read. Check browser storage.')); }
    return () => { alive.current = false; };
  }, []);
  const update = (value: HandoffDraft) => {
    const next = { ...value, revision: crypto.randomUUID() }; current.current = next; setDraft(next);
    try { saveHandoffDraft(localStorage, scope, next); setError(''); }
    catch { setError(tx('交接草稿尚未保存在本机，请保留页面或复制内容。', 'The handoff draft could not be saved locally. Keep this page open or copy its contents.')); }
  };
  const review = handoffDraftNeedsReview(draft, target, members), available = people.some(person => person.id === draft.recipientId);
  return <details data-handoff-composer open={restored || undefined}><summary>{tx('正式交接给同行', 'Hand off to a colleague')}</summary>
    <form class="research-form" onSubmit={event => {
      event.preventDefault(); if (review || !available) return; const submitted = current.current;
      void action.run('POST', `${base}/theorems/${enc(project.id)}/handoffs`, { recipientId: submitted.recipientId, target, note: submitted.note, feedbackIds: feedbackIds.slice(0, 20), expectedRevision: project.revision }, () => {
        try { removeHandoffDraft(localStorage, scope, submitted); }
        catch (cause) { if (alive.current) setError(errorText(cause)); }
        if (alive.current) {
          if (current.current.revision === submitted.revision) { const empty = { target, recipientId: '', note: '', members, revision: crypto.randomUUID() }; current.current = empty; setDraft(empty); setRestored(false); }
          refresh();
        }
      });
    }}>
      {restored && <p role="status" data-handoff-restored>{tx('已恢复这一步的本机交接草稿。', 'The local handoff draft for this step has been restored.')}</p>}
      {review && <div role="status" data-handoff-review><p>{tx('任务版本或协作者权限已变化。原交接说明已保留，请核对后再发送。', 'The task version or collaborator permissions have changed. Your note is preserved; review it before sending.')}</p><p>{tx('草稿任务版本', 'Draft task version')}: <code>{draft.target.taskRef?.version}</code> → <code>{target.taskRef?.version}</code></p>
        <button type="button" class="button" data-handoff-confirm-context disabled={!available} onClick={() => update({ ...current.current, target, members })}>{tx('已核对当前任务与接手人', 'I reviewed the current task and recipient')}</button></div>}
      <label>{tx('接手人', 'Next researcher')}<select data-handoff-recipient value={draft.recipientId} required onChange={event => update({ ...current.current, recipientId: event.currentTarget.value })}><option value="">{tx('选择协作者', 'Choose a collaborator')}</option>
        {draft.recipientId && !available && <option value={draft.recipientId} disabled>{tx('原接手人已无交接权限，请重新选择', 'The previous recipient is no longer eligible. Choose another.')}</option>}
        {people.map(person => <option key={person.id} value={person.id}>{projectPersonLabel(person)}</option>)}</select></label>
      <Field label={tx('已有结果、未解问题与下一步', 'Current results, open questions and next steps')} value={draft.note} onInput={note => update({ ...current.current, note })} required multiline maxLength={4000} />
      <button class="button" type="submit" data-handoff-submit disabled={action.busy || review || !available}>{tx('发起交接，等待确认', 'Request handoff')}</button><ErrorBox message={error} /><MutationState action={action} />
    </form></details>;
}
