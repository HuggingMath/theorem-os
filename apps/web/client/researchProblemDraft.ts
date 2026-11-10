import type { ArchiveIndex, ArchiveIndexRecord } from '../../../docs/web/types';
import type { Locale } from '../../../docs/web/site';
import type { ResearchProjectDetail, ResearchStatementVersion } from '../researchProjectTypes';
import type { WebEnvironment } from '../shared';
import { archiveReadingReturn } from '../../../docs/web/proofReadingLocation';

export const researchProblemDraftKeys = ['archiveProblem', 'archiveSource', 'archiveReading', 'researchProject', 'statementVersion', 'statementSource'] as const;
export type ResearchProblemDraftReference =
  | { kind: 'archive'; id: string; sourceDigest: string; readingUrl?: string }
  | { kind: 'project'; id: string; version: string; sourceDigest: string };
export type ResearchProblemDraft = {
  title: string; text: string; statement: string; source: string; sourceDigest: string; environment: WebEnvironment;
  sourceUrl: string; sourceIncluded: boolean;
};
type Reader = {
  json: <T>(url: string) => Promise<T>; text: (url: string) => Promise<string>;
  currentHref: string; locale: Locale;
};
const identifier = /^[A-Za-z0-9_-]{1,128}$/u, digest = /^[a-f0-9]{64}$/u;

/** The URL names a fixed source; it never supplies the text that will enter a draft. */
export function readResearchProblemDraft(parameters: URLSearchParams): ResearchProblemDraftReference | undefined {
  if (!researchProblemDraftKeys.some(key => parameters.has(key))) return undefined;
  if (parameters.has('archiveProblem') || parameters.has('archiveSource'))
    return { kind: 'archive', id: parameters.get('archiveProblem') ?? '', sourceDigest: parameters.get('archiveSource') ?? '',
      ...(parameters.get('archiveReading') ? { readingUrl: parameters.get('archiveReading')! } : {}) };
  return { kind: 'project', id: parameters.get('researchProject') ?? '', version: parameters.get('statementVersion') ?? '', sourceDigest: parameters.get('statementSource') ?? '' };
}

export function clearResearchProblemDraft(parameters: URLSearchParams): void {
  for (const key of researchProblemDraftKeys) parameters.delete(key);
}

export function researchProblemDraftHref(reference: ResearchProblemDraftReference, workbench = './'): string {
  const parameters = reference.kind === 'archive'
    ? new URLSearchParams({ archiveProblem: reference.id, archiveSource: reference.sourceDigest })
    : new URLSearchParams({ researchProject: reference.id, statementVersion: reference.version, statementSource: reference.sourceDigest });
  if (reference.kind === 'archive' && reference.readingUrl) parameters.set('archiveReading', reference.readingUrl);
  return `${workbench}?${parameters}`;
}

export function archiveProblemDraftHref(record: Pick<ArchiveIndexRecord, 'id' | 'sources'>, workbench: string): string | undefined {
  const original = record.sources.find(source => source.name === 'Challenge.lean');
  return original && researchProblemDraftHref({ kind: 'archive', id: record.id, sourceDigest: original.sha256 }, workbench);
}

export function projectProblemDraftHref(projectId: string, version: Pick<ResearchStatementVersion, 'id' | 'sourceDigest'>): string {
  return researchProblemDraftHref({ kind: 'project', id: projectId, version: version.id, sourceDigest: version.sourceDigest });
}

async function sourceHash(source: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** Read first; the caller presents this candidate and only adds it after the user chooses to. */
export async function loadResearchProblemDraft(reference: ResearchProblemDraftReference, reader: Reader): Promise<ResearchProblemDraft> {
  const tx = (zh: string, en: string) => reader.locale === 'en' ? en : zh;
  const fail = (text: string): never => { throw new Error(text); };
  if (!identifier.test(reference.id) || !digest.test(reference.sourceDigest) || reference.kind === 'project' && !identifier.test(reference.version))
    return fail(tx('题目来源链接不完整，请返回原题重新选择。', 'The problem source link is incomplete. Return to the problem and choose it again.'));
  let title: string, statement: string, source: string, environment: WebEnvironment, sourceUrl: string, targets: string[], sourceFileUrl = '';
  if (reference.kind === 'archive') {
    const index = await reader.json<ArchiveIndex>('/classics/data/index.json');
    const record = index.records.find(record => record.id === reference.id && record.status === 'locally_verified' && record.campaign);
    const original = record?.sources.find(file => file.name === 'Challenge.lean');
    if (!record || original?.sha256 !== reference.sourceDigest)
      return fail(tx('归档原题版本已变化，请返回题目重新选择；现有草稿已保留。', 'The archived statement version changed. Choose it again from the problem; your existing draft is preserved.'));
    source = await reader.text(`/classics/data/proofs/${encodeURIComponent(record.id)}/Challenge.lean`);
    title = reader.locale === 'en' ? record.en?.subtitle || record.title : record.subtitle || record.title;
    statement = reader.locale === 'en' ? record.en?.summary ?? record.summary : record.summary;
    environment = 'mathlib'; targets = record.campaign!.targets;
    sourceUrl = archiveReadingReturn(reference.readingUrl, record.id, reader.currentHref, record.campaign!.proofSha256)
      ?? new URL(`/classics/${reader.locale === 'en' ? 'en/' : ''}archive.html#${new URLSearchParams({ proof: record.id, tab: 'reading', status: 'verified' })}`, reader.currentHref).href;
    sourceFileUrl = new URL(`/classics/data/proofs/${encodeURIComponent(record.id)}/Challenge.lean`, reader.currentHref).href;
  } else {
    const { item: project } = await reader.json<{ item: ResearchProjectDetail }>(`/api/research/theorems/${encodeURIComponent(reference.id)}`);
    const version = project.id === reference.id && project.versions.find(version => version.id === reference.version);
    if (!version || version.sourceDigest !== reference.sourceDigest)
      return fail(tx('所选陈述版本不可用，请返回项目重新选择；现有草稿已保留。', 'The selected statement version is unavailable. Choose it again from the project; your existing draft is preserved.'));
    title = project.title; statement = version.statement; source = version.source; environment = version.environment;
    targets = version.targets?.map(target => target.theoremName) ?? [];
    sourceUrl = new URL(`theorems.html?${new URLSearchParams({ id: project.id, version: version.id })}#statement-versions`, reader.currentHref).href;
  }
  if (await sourceHash(source) !== reference.sourceDigest)
    return fail(tx('原题源码与所选版本不一致，请返回原题重新选择；现有草稿已保留。', 'The statement source does not match the selected version. Choose it again from the problem; your existing draft is preserved.'));
  const fence = '`'.repeat(Math.max(3, ...[...source.matchAll(/`+/gu)].map(match => match[0].length + 1)));
  const introduction = [title, '', statement, ...(targets.length ? ['', tx('证明目标：', 'Proof targets:'), ...targets] : []), '',
    `${tx('题目来源：', 'Problem source: ')}${sourceUrl}`,
    ...(sourceFileUrl ? [`${tx('完整 Lean 原题：', 'Complete Lean statement: ')}${sourceFileUrl}`] : []), `SHA-256: ${reference.sourceDigest}`].join('\n');
  const sourceBlock = `\n\n${fence}lean\n${source}\n${fence}`;
  // Leave room for the user's own variant within the existing 32 KiB natural-language input.
  const sourceIncluded = new TextEncoder().encode(introduction + sourceBlock).length <= 28_000;
  const text = introduction + (sourceIncluded ? sourceBlock : `\n\n${tx(
    '完整 Lean 原题较长，保留在上述来源中；请在此补充你要研究的问题或变体。',
    'The full Lean statement is long and remains at the source above. Add the question or variant you want to research here.')}`);
  return { title, text, statement, source, sourceDigest: reference.sourceDigest, environment, sourceUrl, sourceIncluded };
}
