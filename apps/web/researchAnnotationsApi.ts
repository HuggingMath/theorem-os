import type { WebResearchProjects } from './researchProjects';

/** Uses the research router's existing session, CSRF and bounded JSON handling. */
export async function handleResearchAnnotations(url: URL, method: string, viewer: string, readBody: () => Promise<unknown>, projects: WebResearchProjects):
Promise<{ status: number; body: unknown } | undefined> {
  const path = url.pathname.replace(/^\/api\/research\//u, ''), project = /^theorems\/([^/]+)\/runs\/([^/]+)\/annotations(?:\/([^/]+))?$/u.exec(path);
  const personal = /^runs\/([^/]+)\/annotations(?:\/([^/]+))?$/u.exec(path);
  if (!project && !personal) return;
  const projectId = project ? decodeURIComponent(project[1]!) : undefined, runId = decodeURIComponent(project?.[2] ?? personal![1]!);
  const annotationId = project?.[3] ?? personal?.[2];
  if (method === 'GET' && !annotationId) return { status: 200, body: projects.annotations(viewer, projectId, runId, {
    taskId: url.searchParams.get('task') ?? '', taskVersion: url.searchParams.get('taskVersion') ?? '',
    ...(url.searchParams.get('feedback') ? { feedbackId: url.searchParams.get('feedback')! } : {}),
    ...(url.searchParams.get('commit') ? { commit: url.searchParams.get('commit')! } : {}),
  }) };
  if (method === 'POST') return { status: annotationId ? 200 : 201, body: { item: annotationId
    ? projects.updateAnnotation(viewer, projectId, runId, decodeURIComponent(annotationId), await readBody())
    : projects.createAnnotation(viewer, projectId, runId, await readBody()) } };
}
