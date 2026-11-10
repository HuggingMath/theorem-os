import type { WebResearchProjects } from './researchProjects';

/** Called inside the research router's existing session, CSRF and bounded JSON boundary. */
export async function handleResearchCollaboration(url: URL, method: string, viewer: string, readBody: () => Promise<unknown>, projects: WebResearchProjects):
Promise<{ status: number; body: unknown } | undefined> {
  const parts = url.pathname.replace(/^\/api\/research\//u, '').split('/').map(decodeURIComponent);
  const [section, projectId, action, recordId, operation] = parts;
  const item = (value: unknown, status = 200) => ({ status, body: { item: value } });
  if (section === 'invitation-links' && projectId) {
    if (parts.length === 2 && method === 'GET') return item(projects.invitationLinkPreview(viewer, projectId));
    if (parts.length === 3 && action === 'accept' && method === 'POST') return item(projects.acceptInvitationLink(viewer, projectId, await readBody()));
  }
  if (section === 'collaboration' && projectId === 'inbox') {
    if (!action && method === 'GET') return { status: 200, body: projects.collaborationInbox(viewer) };
    if (action === 'read-all' && method === 'POST') return { status: 200, body: projects.readCollaborationInbox(viewer, await readBody()) };
    if (action && method === 'POST') return { status: 200, body: projects.markCollaborationItem(viewer, action, await readBody()) };
  }
  if (section !== 'theorems' || !projectId) return;
  if (action === 'collaboration' && method === 'GET') return item(projects.collaboration(viewer, projectId));
  if (action === 'runs' && recordId && operation === 'work-impact' && method === 'GET') return { status: 200, body:
    projects.workImpact(viewer, projectId, recordId, (url.searchParams.get('taskIds') ?? '').split(',').filter(Boolean)) };
  if (method !== 'POST') return;
  if (action === 'invitation-links' && !recordId) return item(projects.createInvitationLink(viewer, projectId, await readBody()), 201);
  if (action === 'invitation-links' && recordId && operation === 'revoke') return item(projects.revokeInvitationLink(viewer, projectId, recordId, await readBody()));
  if (action === 'feedback' && recordId && operation === 'review') return item(projects.reviewFeedback(viewer, projectId, recordId, await readBody()));
  if (action === 'feedback' && recordId && operation === 'review-comments') return item(projects.addReviewComment(viewer, projectId, recordId, await readBody()));
  if (action === 'invitations' && !recordId) return item(projects.invite(viewer, projectId, await readBody()), 201);
  if (action === 'invitations' && recordId && operation === 'respond') return item(projects.respondInvitation(viewer, projectId, recordId, await readBody()));
  if (action === 'join-requests' && !recordId) return item(projects.requestJoin(viewer, projectId, await readBody()), 201);
  if (action === 'handoffs' && !recordId) return item(projects.createHandoff(viewer, projectId, await readBody()), 201);
  if (action === 'handoffs' && recordId && operation === 'respond') return item(projects.respondHandoff(viewer, projectId, recordId, await readBody()));
  if (action === 'issues' && !recordId) return item(projects.createIssue(viewer, projectId, await readBody()), 201);
  if (action === 'issues' && recordId && operation === 'replies') return item(projects.replyIssue(viewer, projectId, recordId, await readBody()));
  if (action === 'issues' && recordId && operation === 'resolution') return item(projects.resolveIssue(viewer, projectId, recordId, await readBody()));
}
