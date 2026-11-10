import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { campaignRecords } from '../docs/web/campaignCatalog';
import { archiveIndex, archiveProcessScript } from '../docs/web/catalog';
import { proofWalkthroughs, withProofWalkthrough } from '../docs/web/proofWalkthroughCatalog';
import { renderGlobalTrajectory } from '../docs/web/globalTrajectory';
import { renderProofRoute } from '../docs/web/proofRoute';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const escaped = (value: string) => value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('mathematical walkthroughs of accepted classic proofs', () => {
  it('binds every step to the accepted proof and existing record identities without altering native archives', () => {
    const records = campaignRecords(root).records;
    expect(proofWalkthroughs).toHaveLength(16);
    expect(new Set(proofWalkthroughs.map(item => item.recordId)).size).toBe(16);
    let steps = 0;
    for (const record of records) {
      const walkthrough = record.process!.walkthrough!;
      expect(walkthrough.recordId).toBe(record.id);
      expect(walkthrough.proofSha256).toBe(record.campaign!.proofSha256);
      const final = record.process!.runs.find(run => run.runId === walkthrough.runId)!;
      const source = record.sources.find(source => source.name === 'Submission.lean')!;
      expect(hash(source.code)).toBe(walkthrough.proofSha256);
      expect(final.checks!.some(check => check.scope === 'original' && check.sourceDigest === source.sha256 && check.status === 'kernel_verified')).toBe(true);
      const native = JSON.parse(fs.readFileSync(path.join(root, 'research/openai-math', record.campaign!.target, 'process.json'), 'utf8'));
      expect(native).not.toHaveProperty('walkthrough');
      expect(record.process!.runs).toEqual(native.runs);
      expect(record.process!.sources).toEqual(native.sources);
      expect(walkthrough.stages.flatMap(stage => stage.stepIds)).toEqual(walkthrough.steps.map(step => step.id));
      for (const locale of ['zh', 'en'] as const) {
        expect(walkthrough.strategy[locale].trim()).not.toBe('');
        for (const stage of walkthrough.stages) {
          expect(stage.title[locale].trim()).not.toBe('');
          expect(stage.summary[locale].trim()).not.toBe('');
          expect(stage.stepIds.length).toBeGreaterThan(0);
        }
      }
      for (const step of walkthrough.steps) {
        expect(step.evidence.source.name).toBe('Submission.lean');
        expect(step.evidence.source.endLine).toBeGreaterThanOrEqual(step.evidence.source.line);
        expect(source.code.split('\n').slice(step.evidence.source.line - 1, step.evidence.source.endLine).join('\n').trim()).not.toBe('');
        for (const locale of ['zh', 'en'] as const) for (const field of ['title', 'given', 'claim', 'because', 'next'] as const) {
          expect(step[field][locale].trim(), record.id + '/' + step.id + '/' + field).not.toBe('');
        }
        expect(step.derivation.length).toBeGreaterThanOrEqual(2);
        for (const line of step.derivation) for (const locale of ['zh', 'en'] as const) {
          expect(line.statement[locale].trim(), record.id + '/' + step.id + '/statement').not.toBe('');
          expect(line.reason[locale].trim(), record.id + '/' + step.id + '/reason').not.toBe('');
        }
        steps++;
      }
    }
    expect(steps).toBeGreaterThanOrEqual(60);
  });

  it('renders the complete derivation before the task map, including exact source excerpts and links', () => {
    for (const record of campaignRecords(root).records) for (const locale of ['zh', 'en'] as const) {
      const process = record.process!, walkthrough = process.walkthrough!;
      const index = archiveIndex({ schema: 'theoremos.public-archive.v1', repository: '', archiveRevision: '', snapshotAt: '', records: [record] }).records[0];
      const output = renderGlobalTrajectory(index, process, locale, value => value ?? '');
      expect(output.indexOf('data-workflow-stage="research"')).toBeLessThan(output.indexOf('data-workflow-stage="plan"'));
      expect((output.match(/data-proof-derivation=/gu) ?? []).length).toBe(walkthrough.steps.length);
      expect(output).toContain(escaped(walkthrough.strategy[locale]));
      expect(output.indexOf('class="proof-overview"')).toBeLessThan(output.indexOf('class="proof-reading-layout"'));
      for (const [index, stage] of walkthrough.stages.entries()) {
        expect(output).toContain(`data-proof-overview-stage="${index}" data-proof-overview-steps="${stage.stepIds.join(' ')}" data-global-scroll="proof-derivation-${stage.stepIds[0]}"`);
        expect(output).toContain(escaped(stage.summary[locale]));
      }
      const source = process.sources![walkthrough.proofSha256];
      for (const step of walkthrough.steps) {
        for (const field of ['given', 'claim', 'because', 'next'] as const) expect(output).toContain(escaped(step[field][locale]));
        for (const [index, line] of step.derivation.entries()) {
          expect(output).toContain('data-proof-calculation="' + step.id + ':' + (index + 1) + '"');
          expect(output).toContain(escaped(line.statement[locale]));
          expect(output).toContain(escaped(line.reason[locale]));
        }
        for (const dependency of step.dependsOn) expect(output).toContain('data-proof-dependency="' + dependency + '" data-global-scroll="proof-derivation-' + dependency + '"');
        const excerpt = step.evidence.source;
        for (const line of source.code.split('\n').slice(excerpt.line - 1, excerpt.endLine)) if (line) expect(output).toContain(escaped(line));
        expect(output).toContain('data-proof-source-lines="' + excerpt.line + ':' + excerpt.endLine + '"');
        expect(output).toContain('data-global-scroll="proof-derivation-' + step.id + '"');
      }
      expect(output).toContain('data-global-code="source"');
      for (const run of process.runs.filter(run => run.runId !== walkthrough.runId)) {
        const historical = renderGlobalTrajectory(index, process, locale, value => value ?? '', { run: run.runId });
        expect(historical).not.toContain('data-proof-walkthrough=');
        expect(historical).not.toContain('data-global-code="source"');
      }
    }
  });

  it('refuses a walkthrough attached to another run or changed proof bytes', () => {
    const record = campaignRecords(root).records[0];
    expect(() => withProofWalkthrough({ ...record, campaign: { ...record.campaign!, runId: 'another-run' } }, record.process!)).toThrow('accepted identity');
    const changed = structuredClone(record.process!);
    changed.sources![record.campaign!.proofSha256].code += '\n-- changed after checking\n';
    expect(() => withProofWalkthrough(record, changed)).toThrow('checked source');
  });

  it('renders a branched route without inventing reading-order edges and safely links its native reading controls', () => {
    const walkthrough = structuredClone(proofWalkthroughs[0]);
    walkthrough.steps = walkthrough.steps.slice(0, 3);
    const [first, branch, last] = walkthrough.steps;
    first.dependsOn = []; branch.dependsOn = []; last.dependsOn = [first.id];
    first.title = { zh: '起点 <a & "b">', en: 'Start <a & "b">' };
    for (const locale of ['zh', 'en'] as const) {
      const output = renderProofRoute(walkthrough, locale);
      expect([...output.matchAll(/data-proof-edge data-from="([^"]+)" data-to="([^"]+)"/gu)].map(match => [match[1], match[2]]))
        .toEqual([[first.id, last.id]]);
      expect(output).not.toMatch(/<path[^>]*\sd=/u);
      expect((output.match(/aria-current="step"/gu) ?? []).length).toBe(1);
      expect((output.match(/class="proof-route-finish"/gu) ?? []).length).toBe(1);
      expect(output).toContain('data-proof-route-title="' + escaped(first.title[locale]) + '"');
      expect(output).toContain('data-proof-reading-title>' + escaped(first.title[locale]) + '</span>');
      expect(output).toContain('data-proof-reading-count>01 / 03</span>');
      expect(output).toContain('<summary aria-controls="proof-route-map">');
      expect(output).toContain('class="proof-route-map" id="proof-route-map"');
      expect(output).toContain('aria-controls="proof-derivation-' + last.id + '"');
    }
  });

  it('rejects dependencies that cannot lead back to an earlier result', () => {
    const record = campaignRecords(root).records[0];
    const walkthrough = proofWalkthroughs.find(item => item.recordId === record.id)!;
    const first = walkthrough.steps[0], dependencies = first.dependsOn;
    try {
      for (const dependency of [first.id, walkthrough.steps[1].id, 'missing-result']) {
        first.dependsOn = [dependency];
        expect(() => withProofWalkthrough(record, record.process!)).toThrow('dependency ' + dependency);
      }
    } finally {
      first.dependsOn = dependencies;
    }
  });

  it('rejects a reading outline that omits, repeats or reorders proof steps', () => {
    const record = campaignRecords(root).records[0];
    const walkthrough = proofWalkthroughs.find(item => item.recordId === record.id)!;
    const stages = walkthrough.stages;
    try {
      for (const stepIds of [[], walkthrough.steps.slice(1).map(step => step.id),
        walkthrough.steps.map(step => step.id).reverse(), [...walkthrough.steps.map(step => step.id), walkthrough.steps[0].id]]) {
        walkthrough.stages = [{ title: { zh: '分组', en: 'Part' }, summary: { zh: '说明', en: 'Explanation' }, stepIds }];
        expect(() => withProofWalkthrough(record, record.process!)).toThrow('reading stages');
      }
    } finally {
      walkthrough.stages = stages;
    }
  });

  it('versions the exact lazy process script and changes its URL when the derivation changes', () => {
    const record = campaignRecords(root).records[0];
    const catalog = { schema: 'theoremos.public-archive.v1' as const, repository: '', archiveRevision: '', snapshotAt: '', records: [record] };
    const before = archiveIndex(catalog).records[0].processSummary!.version;
    expect(before).toBe(hash(archiveProcessScript(record)).slice(0, 16));
    const next = structuredClone(catalog);
    next.records[0].process!.walkthrough!.steps[0].derivation[0].statement.zh += ' 补充推导。';
    expect(archiveIndex(next).records[0].processSummary!.version).not.toBe(before);
  });
});
