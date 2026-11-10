import { mathDigest } from '../../src/math/mathRuntimeIo';
import type { ResearchAssetRelease, ResearchLibraryProvenance, ResearchMathSource } from './researchAssetTypes';
import type { WebJobs } from './jobs';
import type { WebRun } from './shared';
import type { WebStorage } from './storage';
import { WebStorageError } from './storage';
import type { WebResearchProjects } from './researchProjects';
import { shareSnapshot } from './share';

type RunSource = Extract<ResearchMathSource, { kind: 'run' }>;
type Dependencies = { storage: WebStorage; jobs: WebJobs; projects: WebResearchProjects };

export function librarySourceHref(source: RunSource, project?: { id: string; version: string }) {
  const parameters = new URLSearchParams({ run: source.runId });
  if (project) { parameters.set('id', project.id); parameters.set('version', project.version); }
  if (source.taskId && source.taskVersion && source.commit) {
    parameters.set('task', source.taskId); parameters.set('taskVersion', source.taskVersion); parameters.set('commit', source.commit);
    if (!project) parameters.set('view', 'route');
  } else if (!project) parameters.set('view', 'source');
  return `${project ? 'theorems.html' : './'}?${parameters}`;
}

/** A public release does not grant access to its author's private run or unlisted share token. */
export function researchLibraryProvenance(deps: Dependencies, viewer: string, release: ResearchAssetRelease): ResearchLibraryProvenance {
  const source = release.mathematics?.source;
  if (!source || source.kind !== 'run') return { kind: 'published' };
  const matches = (run: WebRun, owner: string) => {
    if (source.taskId) return Boolean(source.taskVersion && source.commit
      && deps.storage.getTaskSource(owner, run.id, source.taskId, source.taskVersion, source.commit));
    return Boolean(run.result?.proof && (source.proofDigest ? mathDigest(run.result.proof) === source.proofDigest
      : source.commit ? run.result.report.solution_commit === source.commit : false));
  };
  const owned = viewer !== 'public' && deps.jobs.get(viewer, source.runId);
  if (owned && matches(owned, viewer)) return { kind: 'owner', href: librarySourceHref(source) };
  let publicResult: ResearchLibraryProvenance | undefined;
  for (let offset = 0;; offset += 100) {
    const page = deps.projects.list(viewer, { offset, limit: 100 });
    for (const project of page.items) {
      try {
        const detail = deps.projects.detail(viewer, project.id), binding = detail.runs.find(item => item.runId === source.runId);
        if (!binding) continue;
        const resolved = deps.projects.resolveBinding(viewer, project.id, source.runId);
        if (!matches(resolved.run, resolved.runOwner)) continue;
        if (detail.permissions.member) return { kind: 'project', href: librarySourceHref(source, { id: project.id, version: binding.statementVersionId }) };
        // Public project exposure already authorizes this accepted result. Never disclose intermediate task context.
        if (!source.taskId && binding.exposure === 'public' && shareSnapshot(resolved.run))
          publicResult = { kind: 'public-result', href: librarySourceHref(source, { id: project.id, version: binding.statementVersionId }) };
      } catch (error) { if (!(error instanceof WebStorageError && [403, 404].includes(error.status))) throw error; }
    }
    if (page.items.length < 100) break;
  }
  return publicResult ?? { kind: 'published' };
}
