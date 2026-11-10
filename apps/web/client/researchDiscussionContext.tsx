import type { ResearchDiscussionContext } from '../researchProjectTypes';
import { tx } from './researchShared';
import { Rich } from './richText';

export function discussionContextHref(projectId: string, context: ResearchDiscussionContext) {
  return `problem.html?${new URLSearchParams({ project: projectId, run: context.runId, tab: 'route', task: context.taskRef.id,
    taskVersion: context.taskRef.version, at: String(context.observationRef.sequence), atState: context.observationRef.stateDigest,
    ...(context.commit ? { commit: context.commit } : {}) })}`;
}
export function DiscussionContext({ projectId, value }: { projectId: string; value: ResearchDiscussionContext }) {
  return <div class="research-inline-context" data-discussion-context><p>{tx('讨论引用的保存步骤', 'Saved step referenced by this discussion')}: <strong><Rich text={value.taskTitle || value.taskRef.id} /></strong> · <code>{value.taskRef.version.slice(0, 12)}</code></p>
    <p>{tx('保存时点', 'Saved moment')} #{value.observationRef.sequence}{value.commit && <> · Commit <code>{value.commit.slice(0, 12)}</code></>}</p>
    <a class="text-button" data-discussion-return-context href={discussionContextHref(projectId, value)}>{tx('回到这一时点的步骤', 'Return to this step at the saved moment')} →</a></div>;
}
