import { z } from 'zod';
import { mathDigest } from '../../src/math/mathRuntimeIo';
import { WebStorageError } from './storage';
import type { WebJobs } from './jobs';
import type { WebResearchProjects } from './researchProjects';

const schema = z.object({ requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u), title: z.string().trim().min(1).max(200),
  confirmed: z.literal(true) }).strict();

/** Each step uses the existing durable request identity, so retrying a partial conversion resumes it. */
export function startResearchProject(jobs: WebJobs, projects: WebResearchProjects, viewer: string, runId: string, raw: unknown) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new WebStorageError(400, '请填写项目名称并核对原题。');
  const run = jobs.get(viewer, runId);
  if (!run) throw new WebStorageError(404, '运行不存在或不属于本人。');
  const input = parsed.data, request = (step: string) => `from-run-${mathDigest(`${run.id}:${input.requestId}:${step}`).slice(0, 48)}`;
  let project = projects.create(viewer, { requestId: request('project'), title: input.title, description: run.task, visibility: 'private' });
  const versionRequest = request('statement');
  // Passing the same body on every retry preserves the original operation fingerprint.
  project = projects.addVersion(viewer, project.id, { requestId: versionRequest, expectedRevision: 1, statement: run.formalization?.original || run.task,
    source: run.source, environment: run.environment, assumptions: [], confirmation: { confirmed: true },
    ...(run.formalizationId ? { formalizationId: run.formalizationId } : {}),
  }, { preserveSource: true });
  const versionId = `version-${mathDigest(`${projects.identity(viewer)}:${versionRequest}`).slice(0, 32)}`;
  project = projects.bindRun(viewer, project.id, { requestId: request('binding'), expectedRevision: 2, runId: run.id, statementVersionId: versionId,
    exposure: 'members', grants: { guidance: false, edit: false, approve: false, proof: false } });
  return project;
}
