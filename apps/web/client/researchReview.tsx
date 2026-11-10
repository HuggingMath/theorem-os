import { useEffect, useRef, useState } from 'preact/hooks';
import type { ResearchFeedback, ResearchProjectDetail } from '../researchProjectTypes';
import { RichProse } from './richText';
import { ResearchAnnotations } from './researchAnnotations';
import { ResearchDraftPicker } from './researchDrafts';
import { useResearchInputDraft } from './researchInputDraft';
import { base, enc, Field, MutationState, stamp, tx, useMutation } from './researchShared';
import { projectPeople, projectPersonLabel } from './researchMembers';
import { reviewerMembersHref } from './researchReviewerNavigation';

export function ResearchReview({ feedback, project, selfId, canReview, refresh, focusAnnotationId }: {
  feedback: ResearchFeedback; project: ResearchProjectDetail; selfId: string; canReview: boolean; refresh(): void; focusAnnotationId?: string;
}) {
  const action = useMutation(), [reviewer, setReviewer] = useState('');
  const scope = { sourceFeedbackId: feedback.id, ...(feedback.target ? { runId: feedback.target.runId, statementVersionId: feedback.target.statementVersionId,
    ...(feedback.target.taskRef ? { taskId: feedback.target.taskRef.id, taskVersion: feedback.target.taskRef.version } : {}) } : {}) };
  const supplement = useResearchInputDraft(selfId, project.id, 'review', { ...scope, purpose: 'resubmit' }, { text: '' });
  const comment = useResearchInputDraft(selfId, project.id, 'review', { ...scope, purpose: 'comment' }, { text: '' });
  const text = supplement.value.text, commentText = comment.value.text, commentAction = useMutation();
  const [annotationsOpened, setAnnotationsOpened] = useState(false);
  const annotations = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (focusAnnotationId && annotations.current) { annotations.current.open = true; setAnnotationsOpened(true); } }, [focusAnnotationId]);
  const path = `${base}/theorems/${enc(project.id)}/feedback/${enc(feedback.id)}/review`;
  const assigned = feedback.review?.reviewer?.id !== feedback.author.id ? feedback.review?.reviewer : undefined, canAssign = canReview && (project.permissions.manage || assigned?.id === selfId);
  const canJudge = canReview && feedback.author.id !== selfId && (!assigned || assigned.id === selfId || project.permissions.manage);
  const newAttempt = feedback.payload && 'libraryTrial' in feedback.payload && feedback.payload.libraryTrial?.requiresNewAttempt;
  const canPrepareAttempt = newAttempt && canReview && feedback.proofCheck?.status === 'checked' && !feedback.supersededBy && feedback.continuation?.action !== 'end'
    && !['declined', 'needs-info'].includes(feedback.decision.status) && feedback.candidateDelivery?.status !== 'withdrawn'
    && (feedback.candidateDelivery?.approvedAt && feedback.candidateDelivery.approvedBy && ['approved', 'dispatched'].includes(feedback.candidateDelivery.status)
      || feedback.decision.status === 'accepted' && feedback.decision.actor?.kind === 'human');
  const people = projectPeople(project).filter(person => person.role !== 'reader' && person.id !== feedback.author.id && person.id !== assigned?.id);
  return <section class="collaboration-review" data-feedback-review>
    {feedback.candidateDelivery && <div class="candidate-delivery-status" data-candidate-delivery-status={feedback.candidateDelivery.status}>
      <p>{feedback.candidateDelivery.status === 'awaiting-review' ? tx('候选检查已通过，等待人工批准。', 'The candidate passed its check and is waiting for human approval.')
        : feedback.candidateDelivery.status === 'approved' && newAttempt ? tx('已评审通过，请在带入固定库的新尝试中使用。', 'Review approved. Use this candidate in a new attempt with the fixed library.')
        : feedback.candidateDelivery.status === 'approved' ? tx('候选已批准，投递回执待确认。', 'The candidate is approved; delivery is awaiting confirmation.')
        : feedback.candidateDelivery.status === 'dispatched' ? tx('候选已投递，可继续跟踪采纳和执行。', 'The candidate was sent. Follow its adoption and execution below.')
        : feedback.candidateDelivery.status === 'withdrawn' ? tx('此候选已撤回或由新修订接续。', 'This candidate was withdrawn or continued in a newer revision.')
        : feedback.proofCheck?.status === 'failed' ? tx('候选未通过检查，可修改后提交新修订。', 'The candidate check failed. Revise it and submit a new version.') : tx('候选检查中。', 'Checking the candidate.')}</p>
      {newAttempt && <p>{tx('这份候选将在新尝试中使用，评审批准后可准备完整源码与固定库。', 'This candidate will be used in a new attempt. After review, prepare its complete source and fixed library.')}</p>}
      {feedback.candidateDelivery.status === 'awaiting-review' && canJudge && !feedback.supersededBy && !['needs-info', 'declined'].includes(feedback.decision.status) && <button class="button" type="button" data-candidate-approve disabled={action.busy} onClick={() => void action.run('POST', `${base}/theorems/${enc(project.id)}/feedback/${enc(feedback.id)}/candidate-delivery`, { action: 'approve', expectedRevision: feedback.revision }, refresh)}>{newAttempt ? tx('批准在新尝试中使用', 'Approve use in a new attempt') : tx('批准并投递此候选', 'Approve and send this candidate')}</button>}
      {['checking', 'awaiting-review', 'approved'].includes(feedback.candidateDelivery.status) && (feedback.author.id === selfId || project.permissions.manage) && <button class="text-button" type="button" data-candidate-withdraw disabled={action.busy} onClick={() => void action.run('POST', `${base}/theorems/${enc(project.id)}/feedback/${enc(feedback.id)}/candidate-delivery`, { action: 'withdraw', expectedRevision: feedback.revision }, refresh)}>{tx('撤回投递', 'Withdraw delivery')}</button>}
      {canPrepareAttempt && <a class="button" data-prepare-library-attempt href={`./?libraryProposal=${enc(feedback.id)}&project=${enc(project.id)}`}>{tx('带入完整源码与固定库，准备新尝试', 'Prepare a new attempt with the complete source and fixed library')}</a>}
    </div>}
    <p>{assigned ? <>{tx('负责评审：', 'Responsible reviewer: ')}<strong>{assigned.displayName}</strong></> : tx('尚未指定评审人', 'No reviewer assigned')}
      {!assigned && canReview && feedback.author.id !== selfId && <button type="button" class="button" data-claim-review disabled={action.busy} onClick={() => void action.run('POST', path, { action: 'claim', expectedRevision: feedback.revision }, refresh)}>{tx('由我评审', 'Review this myself')}</button>}</p>
    {!assigned && !people.length && feedback.kind === 'proof-submission' && <div class="research-empty" data-reviewer-empty><p>{tx('这份候选需要由提交者之外的协作者评审。目前还没有可接下评审的成员。', 'This candidate needs a collaborator other than its author to review it. No eligible reviewer is available yet.')}</p>
      <a class="button" data-reviewer-members href={reviewerMembersHref(project.id, feedback)}>{project.permissions.manage ? tx('邀请评审人，随后回到此候选', 'Invite a reviewer, then return to this candidate') : tx('查看成员与项目发起者', 'View members and the project owner')}</a>
      {!project.permissions.manage && <p>{tx('请联系项目发起者邀请协作者；对方加入后可接下评审。', 'Ask the project owner to invite a collaborator. They can take the review after joining.')}</p>}</div>}
    {canAssign && people.length > 0 && <form class="research-form" onSubmit={event => { event.preventDefault(); if (!people.some(person => person.id === reviewer)) return; void action.run('POST', path, { action: 'assign', reviewerId: reviewer, expectedRevision: feedback.revision }, refresh); }}>
      <label>{assigned ? tx('移交评审', 'Transfer review') : tx('指定评审人', 'Assign a reviewer')}<select data-reviewer-select value={reviewer} required onChange={event => setReviewer(event.currentTarget.value)}><option value="">{tx('选择有权限的协作者', 'Choose an authorized collaborator')}</option>{people.map(person => <option key={person.id} value={person.id}>{projectPersonLabel(person)}</option>)}</select></label>
      <button class="button" type="submit" disabled={action.busy || !people.some(person => person.id === reviewer)}>{assigned ? tx('确认移交', 'Confirm transfer') : tx('确认分配', 'Confirm assignment')}</button></form>}
    {feedback.author.id === selfId && feedback.decision.status === 'needs-info' && <form class="research-form" data-resubmit-review onSubmit={event => { event.preventDefault(); const submitted = supplement.drafts.current(), value = supplement.value;
      void action.run('POST', path, { action: 'resubmit', text, expectedRevision: feedback.revision }, () => { void supplement.complete(submitted, { kind: 'review', id: feedback.id }, value); refresh(); }); }}>
      <ResearchDraftPicker drafts={supplement.drafts} filter={item => item.scope.sourceFeedbackId === feedback.id && item.scope.purpose === 'resubmit'} onRestore={supplement.restore} />
      <Field label={tx('补充推导、说明或证据', 'Additional reasoning, explanation or evidence')} value={text} onInput={text => supplement.update({ text })} multiline required maxLength={4000} />
      <button class="button" type="submit" disabled={action.busy}>{tx('补充并重新送审', 'Add information and resubmit')}</button></form>}
    {feedback.reviewComments?.filter(comment => !comment.anchor).map(comment => <div class="candidate-review-comment" key={comment.id} data-candidate-review-comment={comment.id}><p>{comment.author.displayName} · {stamp(comment.createdAt)}</p><RichProse text={comment.text} /></div>)}
    {project.permissions.member && feedback.kind === 'proof-submission' && feedback.target?.taskRef && <details ref={annotations} onToggle={event => { if (event.currentTarget.open) setAnnotationsOpened(true); }}><summary>{tx('对公式或源码作精确评审', 'Review a formula or exact source passage')}</summary>
      {annotationsOpened && <ResearchAnnotations projectId={project.id} runId={feedback.target.runId} task={feedback.target.taskRef} feedbackId={feedback.id} selfId={selfId} refresh={refresh} focusAnnotationId={focusAnnotationId} />}</details>}
    {feedback.kind === 'proof-submission' && canJudge && !feedback.supersededBy && <form class="research-form" onSubmit={event => { event.preventDefault(); const submitted = comment.drafts.current(), value = comment.value; void commentAction.run('POST', `${base}/theorems/${enc(project.id)}/feedback/${enc(feedback.id)}/review-comments`, { text: commentText, expectedRevision: feedback.revision }, () => { void comment.complete(submitted, { kind: 'review', id: feedback.id }, value); refresh(); }); }}>
      <ResearchDraftPicker drafts={comment.drafts} filter={item => item.scope.sourceFeedbackId === feedback.id && item.scope.purpose === 'comment'} onRestore={comment.restore} />
      <label>{tx('需要修改或解释的具体一步', 'The specific step to revise or explain')}<textarea data-review-comment value={commentText} required rows={2} maxLength={4000} onInput={event => comment.update({ text: event.currentTarget.value })} /></label>
      <button class="button" type="submit" data-save-review-comment disabled={commentAction.busy}>{tx('添加评审意见', 'Add a review comment')}</button><MutationState action={commentAction} /></form>}
    {Boolean(feedback.reviewHistory?.length || feedback.decisionHistory?.length) && <details data-review-history><summary>{tx('评审流转与补充记录', 'Review history and additional information')}</summary>
      {feedback.reviewHistory?.map((item, i) => <div class="collaboration-resolution" key={i}><p>{item.actor.displayName} · {item.action === 'resubmit' ? tx('补充后重新送审', 'Resubmitted with more information') : item.action === 'claim' ? tx('接下评审', 'Claimed review') : tx('分配评审', 'Assigned review')}{item.reviewer && <> → {item.reviewer.displayName}</>} · {stamp(item.createdAt)}</p>{item.text && <RichProse text={item.text} />}</div>)}
      {feedback.decisionHistory?.map((item, i) => <div class="collaboration-resolution" key={`decision-${i}`}><p>{item.actor?.displayName} · {stamp(item.decidedAt ?? '')}</p>{item.reason && <RichProse text={item.reason} />}</div>)}</details>}
    <MutationState action={action} />
  </section>;
}
