import { useState } from 'preact/hooks';
import type { ResearchIssue } from '../researchCollaborationTypes';
import type { ResearchProjectDetail } from '../researchProjectTypes';
import { RichProse } from './richText';
import { readIssueExecutionNotes } from './researchIssueExecutionDraft';
import { nameOf, tx } from './researchShared';

export function IssueExecutionHistory({ issue, project, selfId, onRevealFeedback }: {
  issue: ResearchIssue; project: ResearchProjectDetail; selfId: string; onRevealFeedback(id: string): void;
}) {
  const [notes] = useState(() => {
    if (!selfId) return [];
    try { return readIssueExecutionNotes(localStorage, { owner: selfId, projectId: project.id, issueId: issue.id }); }
    catch { return []; }
  });
  const linked = project.feedback.filter(item => item.issueSource?.issueId === issue.id);
  if (linked.length === 0 && notes.length === 0) return null;
  return <div class="collaboration-issue-execution" data-issue-execution>
    {linked.map(item => <p key={item.id}><a href={`#feedback-${item.id}`} onClick={event => { event.preventDefault(); onRevealFeedback(item.id); }}>{tx('查看此议题的执行反馈', 'View execution feedback from this issue')}</a> · {nameOf(item.delivery.status)} · {nameOf(item.execution.status)}</p>)}
    {notes.length > 0 && <details data-issue-execution-restored>
      <summary>{tx('查看旧版执行草稿', 'Read the previous action draft')}</summary>
      {notes.map(note => <RichProse key={note} text={note} />)}
    </details>}
  </div>;
}
