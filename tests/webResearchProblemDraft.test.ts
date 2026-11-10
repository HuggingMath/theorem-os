import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { campaignRecords } from '../docs/web/campaignCatalog';
import { archiveIndex } from '../docs/web/catalog';
import type { ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import {
  archiveProblemDraftHref, clearResearchProblemDraft, loadResearchProblemDraft, projectProblemDraftHref,
  readResearchProblemDraft, researchProblemDraftHref,
} from '../apps/web/client/researchProblemDraft';

const root = path.resolve(import.meta.dirname, '..');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const currentHref = 'https://workbench.example/?archiveProblem=example';

describe('explicit problem-to-draft handoff', () => {
  it('pins archive and project links to source identities and clears only handoff parameters', () => {
    const archive = { kind: 'archive' as const, id: 'openai_triangle_face', sourceDigest: 'a'.repeat(64) };
    expect(readResearchProblemDraft(new URL(researchProblemDraftHref(archive), currentHref).searchParams)).toEqual(archive);
    const project = { kind: 'project' as const, id: 'project-1', version: 'statement-1', sourceDigest: 'b'.repeat(64) };
    expect(projectProblemDraftHref(project.id, { id: project.version, sourceDigest: project.sourceDigest })).toBe(researchProblemDraftHref(project));
    expect(readResearchProblemDraft(new URL(researchProblemDraftHref(project), currentHref).searchParams)).toEqual(project);
    const parameters = new URLSearchParams({ chat: 'preserved-chat', libraryModule: 'preserved-reference', archiveProblem: archive.id, archiveSource: archive.sourceDigest });
    clearResearchProblemDraft(parameters);
    expect([...parameters]).toEqual([['chat', 'preserved-chat'], ['libraryModule', 'preserved-reference']]);
    expect(readResearchProblemDraft(parameters)).toBeUndefined();
    expect(archiveProblemDraftHref({ id: archive.id, sources: [] }, '../')).toBeUndefined();
  });

  it('reads all 18 original statements from fixed archive files and never reuses the accepted proof as a new input', async () => {
    const records = campaignRecords(root).records;
    const index = archiveIndex({ schema: 'theoremos.public-archive.v1', repository: '', archiveRevision: '', snapshotAt: '', records });
    const requests: string[] = [];
    const json = async <T,>(url: string) => { requests.push(url); expect(url).toBe('/classics/data/index.json'); return index as T; };
    const text = async (url: string) => {
      requests.push(url);
      const match = url.match(/^\/classics\/data\/proofs\/([a-z0-9_]+)\/Challenge\.lean$/u); expect(match).not.toBeNull();
      return records.find(record => record.id === match![1])!.sources.find(source => source.name === 'Challenge.lean')!.code;
    };
    for (const record of records) for (const locale of ['zh', 'en'] as const) {
      const original = record.sources.find(source => source.name === 'Challenge.lean')!;
      const href = archiveProblemDraftHref(record, locale === 'en' ? '../../' : '../')!;
      const reference = readResearchProblemDraft(new URL(href, `https://workbench.example/classics/${locale === 'en' ? 'en/' : ''}archive.html`).searchParams)!;
      const candidate = await loadResearchProblemDraft(reference, { json, text, currentHref, locale });
      expect(candidate.source).toBe(original.code); expect(candidate.sourceDigest).toBe(hash(original.code));
      expect(candidate.title).toBe(locale === 'en' ? record.en!.subtitle : record.subtitle);
      expect(candidate.statement).toBe(locale === 'en' ? record.en!.summary : record.summary);
      expect(candidate.text).toContain(candidate.sourceUrl); expect(candidate.text).toContain(original.sha256);
      expect(candidate.text).toContain(`/classics/data/proofs/${record.id}/Challenge.lean`);
      for (const target of record.campaign!.targets) expect(candidate.text).toContain(target);
      if (candidate.sourceIncluded) expect(candidate.text).toContain(original.code);
      else {
        expect(candidate.source).toHaveLength(original.code.length);
        expect(candidate.text).toContain(locale === 'zh' ? '完整 Lean 原题较长，保留在上述来源中' : 'The full Lean statement is long');
      }
      expect(Buffer.byteLength(candidate.text)).toBeLessThanOrEqual(32_768);
    }
    expect(records).toHaveLength(18);
    expect(requests).not.toEqual(expect.arrayContaining([expect.stringContaining('Submission.lean')]));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'research/openai-math/manifest.json'), 'utf8'));
    for (const record of manifest.records) expect(hash(records.find(item => item.id === record.id)!.sources.find(source => source.name === 'Challenge.lean')!.code)).toBe(record.files['Challenge.lean']);
  });

  it('rejects a stale archive identity before reading source, and rejects changed source bytes', async () => {
    const source = 'theorem source_goal : True := by sorry\n';
    const record = { id: 'openai_goal', status: 'locally_verified', campaign: { targets: ['source_goal'] }, sources: [{ name: 'Challenge.lean', sha256: hash(source) }] };
    let sourceReads = 0;
    const reader = { json: async <T,>() => ({ records: [record] }) as T, text: async () => { sourceReads++; return source; }, currentHref, locale: 'en' as const };
    await expect(loadResearchProblemDraft({ kind: 'archive', id: record.id, sourceDigest: 'f'.repeat(64) }, reader)).rejects.toThrow('version changed');
    expect(sourceReads).toBe(0);
    await expect(loadResearchProblemDraft({ kind: 'archive', id: record.id, sourceDigest: hash(source) }, { ...reader, text: async () => source + '-- changed' })).rejects.toThrow('does not match');
    await expect(loadResearchProblemDraft({ kind: 'archive', id: '../outside', sourceDigest: hash(source) }, reader)).rejects.toThrow('incomplete');
  });

  it('uses a permission-checked immutable project version and preserves its full source and environment', async () => {
    const source = 'theorem project_goal : True := by sorry';
    const version = { id: 'version-1', statement: 'Prove the project goal.', source, sourceDigest: hash(source), environment: 'standard', targets: [{ theoremName: 'project_goal', proofPath: 'Main.lean' }] };
    const project = { id: 'project-1', title: 'Project goal', versions: [version] } as unknown as ResearchProjectDetail;
    const reference = readResearchProblemDraft(new URL(projectProblemDraftHref(project.id, version), currentHref).searchParams)!;
    const reader = { json: async <T,>(url: string) => { expect(url).toBe('/api/research/theorems/project-1'); return { item: project } as T; }, text: async () => { throw new Error('Project source is already in its authorized response'); }, currentHref, locale: 'en' as const };
    const candidate = await loadResearchProblemDraft(reference, reader);
    expect(candidate).toMatchObject({ source, statement: version.statement, environment: 'standard', sourceDigest: version.sourceDigest, sourceIncluded: true });
    expect(candidate.text).toContain('project_goal'); expect(candidate.sourceUrl).toContain('id=project-1&version=version-1#statement-versions');
    await expect(loadResearchProblemDraft(reference, { ...reader, json: async () => { throw new Error('403 project permission denied'); } })).rejects.toThrow('403');
    await expect(loadResearchProblemDraft({ ...reference, sourceDigest: 'a'.repeat(64) }, reader)).rejects.toThrow('version is unavailable');
    const changed = structuredClone(project); changed.versions[0].source += '\n-- changed';
    await expect(loadResearchProblemDraft(reference, { ...reader, json: async <T,>() => ({ item: changed }) as T })).rejects.toThrow('does not match');
  });
});
