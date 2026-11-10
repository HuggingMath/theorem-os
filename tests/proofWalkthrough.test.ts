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
import { withArchiveSourceRoute } from '../docs/web/archiveSourceRoute';
import { proofSolutionTitle, renderProofSolution, theoremDirectoryReturn } from '../docs/web/proofSolution';
import { localizeRecord } from '../docs/web/site';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const escaped = (value: string) => value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const explainedRecords = () => campaignRecords(root).records.filter(record => record.process?.walkthrough);

describe('mathematical walkthroughs of accepted classic proofs', () => {
  it('binds every step to the accepted proof and existing record identities without altering native archives', () => {
    const records = campaignRecords(root).records;
    expect(proofWalkthroughs).toHaveLength(16);
    expect(new Set(proofWalkthroughs.map(item => item.recordId)).size).toBe(16);
    expect(records.filter(record => record.process?.walkthrough).map(record => record.id).sort()).toEqual(proofWalkthroughs.map(item => item.recordId).sort());
    let steps = 0;
    for (const record of records) {
      const native = JSON.parse(fs.readFileSync(path.join(root, 'research/openai-math', record.campaign!.target, 'process.json'), 'utf8'));
      expect(native).not.toHaveProperty('walkthrough');
      expect(record.process!.runs).toEqual(native.runs);
      expect(record.process!.sources).toEqual(native.sources);
      const walkthrough = record.process!.walkthrough;
      if (!walkthrough) continue;
      expect(walkthrough.recordId).toBe(record.id);
      expect(walkthrough.proofSha256).toBe(record.campaign!.proofSha256);
      const final = record.process!.runs.find(run => run.runId === walkthrough.runId)!;
      const source = record.sources.find(source => source.name === 'Submission.lean')!;
      expect(hash(source.code)).toBe(walkthrough.proofSha256);
      expect(final.checks!.some(check => check.scope === 'original' && check.sourceDigest === source.sha256 && check.status === 'kernel_verified')).toBe(true);
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
    for (const record of explainedRecords()) for (const locale of ['zh', 'en'] as const) {
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
    const record = explainedRecords()[0];
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
    const record = explainedRecords()[0];
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
    const record = explainedRecords()[0];
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
    const record = explainedRecords()[0];
    const catalog = { schema: 'theoremos.public-archive.v1' as const, repository: '', archiveRevision: '', snapshotAt: '', records: [record] };
    const before = archiveIndex(catalog).records[0].processSummary!.version;
    expect(before).toBe(hash(archiveProcessScript(record)).slice(0, 16));
    const next = structuredClone(catalog);
    next.records[0].process!.walkthrough!.steps[0].derivation[0].statement.zh += ' 补充推导。';
    expect(archiveIndex(next).records[0].processSummary!.version).not.toBe(before);
  });
});

describe('direct reading of the current accepted proof', () => {
  it('offers a new editable research draft pinned to the original statement in the workbench reader', () => {
    for (const record of campaignRecords(root).records) {
      const original = record.sources.find(source => source.name === 'Challenge.lean')!;
      const output = renderProofSolution(record, record.process!, 'zh', { workbenchHref: '../' });
      expect(output).toContain('data-proof-start-research');
      expect(output).toContain('以此题开始研究');
      const href = output.match(/data-proof-start-research href="([^"]+)"/u)![1].replaceAll('&amp;', '&');
      const destination = new URL(href, 'https://workbench.example/classics/archive.html');
      expect(destination.pathname).toBe('/');
      expect(destination.searchParams.get('archiveProblem')).toBe(record.id);
      expect(destination.searchParams.get('archiveSource')).toBe(original.sha256);
      expect(destination.searchParams.has('run')).toBe(false);
      expect(destination.searchParams.has('source')).toBe(false);
      expect(renderProofSolution(record, record.process!, 'zh')).not.toContain('data-proof-start-research');
    }
  });
  it('puts the real accepted reading format in the lightweight index without loading any process or proof text', () => {
    const records = campaignRecords(root).records;
    const catalog = { schema: 'theoremos.public-archive.v1' as const, repository: '', archiveRevision: '', snapshotAt: '', records };
    const index = archiveIndex(catalog);
    expect(index.records.filter(record => record.readingMode === 'derivation')).toHaveLength(16);
    expect(index.records.filter(record => record.readingMode === 'source').map(record => record.campaign!.target).sort())
      .toEqual(['CharacterVarietiesAllSeamsSupport', 'ThreeStateTreeClauses']);
    for (const record of index.records) {
      expect(record).not.toHaveProperty('process');
      for (const source of record.sources) expect(source).not.toHaveProperty('code');
    }
    const record = structuredClone(records.find(record => record.process?.walkthrough)!);
    record.process!.walkthrough!.runId = 'historical-run';
    expect(archiveIndex({ ...catalog, records: [record] }).records[0].readingMode).toBe('source');
    record.process!.runs.find(run => run.runId === record.campaign!.runId)!.checks = [];
    expect(archiveIndex({ ...catalog, records: [record] }).records[0].readingMode).toBeUndefined();
  });

  it('returns only to the same workbench theorem directory and preserves its query, sort, page and problem anchor', () => {
    const path = '/workbench/theorems.html?collection=solved&q=a%26b&field=%E5%87%A0%E4%BD%95&sort=title&offset=14#problem-openai-triangle';
    for (const archive of ['archive.html', 'en/archive.html']) {
      const current = `https://example.test/workbench/classics/${archive}`;
      expect(theoremDirectoryReturn(path, current)).toBe(path);
      expect(theoremDirectoryReturn(`https://example.test${path}`, current)).toBe(path);
      for (const destination of [null, '', `https://outside.test${path}`, `//outside.test${path}`,
        '/theorems.html?collection=solved', '/workbench/admin.html?collection=solved', '/workbench/theorems.html?collection=research',
        '/workbench/classics/%2e%2e/%2e%2e/theorems.html?collection=solved', 'javascript:alert(1)', 'https://[invalid']) {
        expect(theoremDirectoryReturn(destination, current), String(destination)).toBeUndefined();
      }
    }
  });

  it('opens every existing mathematical walkthrough linearly before offering the research history', () => {
    for (const record of explainedRecords()) for (const locale of ['zh', 'en'] as const) {
      const process = record.process!, walkthrough = process.walkthrough!;
      const output = renderProofSolution(record, process, locale);
      expect(output).toContain(`data-proof-solution-run="${record.campaign!.runId}"`);
      expect(output).toContain(`data-proof-solution-sha="${record.campaign!.proofSha256}"`);
      expect(output).toContain('data-proof-solution-mode="derivation"');
      expect(output).toContain('data-proof-reading="linear"');
      expect(output).toContain('<details class="proof-reading-intro"><summary>');
      expect(output).not.toContain('<details class="proof-reading-intro" open>');
      expect(output).toContain(escaped(walkthrough.strategy[locale]));
      expect(output).toContain(escaped(walkthrough.steps[0].given[locale]));
      expect(output).toContain(escaped(walkthrough.steps[0].derivation[0].statement[locale]));
      expect(output).toContain('<details class="proof-route-panel">');
      expect(output).not.toContain('<details class="proof-route-panel" open>');
      expect(output).not.toContain('data-solution-route-record=');
      expect(output).not.toContain('global-history-panel');
      expect(output.indexOf('data-proof-derivation=')).toBeLessThan(output.indexOf('data-tab="process"'));
      expect(output).toContain('id="global-review"');
      const summary = locale === 'en' ? record.en!.summary : record.summary;
      expect(output).toContain(escaped(summary));
      for (const step of walkthrough.steps) {
        for (const line of step.derivation) {
          expect(output).toContain(escaped(line.statement[locale]));
          expect(output).toContain(escaped(line.reason[locale]));
        }
        if (step.figureHtml) expect(output).toContain(`<summary>${locale === 'en' ? 'View figure' : '查看图示'}</summary>${step.figureHtml[locale]}`);
      }
    }
  });

  it('reads the two newly archived proofs from their actual accepted target declarations without inventing derivations', () => {
    const records = campaignRecords(root).records.filter(record => !record.process?.walkthrough).map(withArchiveSourceRoute);
    expect(records.map(record => record.campaign!.target).sort()).toEqual(['CharacterVarietiesAllSeamsSupport', 'ThreeStateTreeClauses']);
    for (const record of records) for (const locale of ['zh', 'en'] as const) {
      const process = record.process!, accepted = record.campaign!;
      const output = renderProofSolution(record, process, locale);
      expect(output).toContain(`data-proof-solution-run="${accepted.runId}"`);
      expect(output).toContain(`data-proof-solution-sha="${accepted.proofSha256}"`);
      expect(output).toContain('data-proof-solution-mode="source"');
      expect(output).not.toContain('data-proof-derivation=');
      expect(output).not.toContain('data-proof-walkthrough=');
      expect(output).not.toContain('data-solution-route-record=');
      expect(output).not.toContain('global-history-panel');
      const source = record.sources.find(source => source.name === 'Submission.lean')!;
      expect(hash(source.code)).toBe(accepted.proofSha256);
      const declarations = process.sourceRoute!.files.find(file => file.sha256 === source.sha256)!.declarations
        .filter(declaration => accepted.targets.includes(declaration.name));
      expect(declarations.map(declaration => declaration.name)).toEqual(accepted.targets);
      expect([...output.matchAll(/data-proof-source-declaration="([^"]+)"/gu)].map(match => match[1])).toEqual(accepted.targets);
      for (const declaration of declarations) {
        expect(output).toContain(`data-proof-source-lines="${declaration.line}:${declaration.endLine}"`);
        expect(output).toContain(`<h5 tabindex="-1">${escaped(declaration.name.split('.').at(-1)!)}</h5>`);
        expect(output).toContain(escaped(source.code.split('\n').slice(declaration.line - 1, declaration.endLine).join('\n')));
      }
      expect(output).toContain('class="proof-source-index"');
      expect(output).toContain('data-global-scroll="proof-source-target-1"');
      expect(output).toContain('id="proof-source-target-1"');
      const helpers = process.sourceRoute!.files.find(file => file.sha256 === source.sha256)!.declarations
        .filter(declaration => !accepted.targets.includes(declaration.name));
      if (helpers.length) {
        expect(output).toContain('data-global-scroll="proof-source-helper-1"');
        expect(output).toContain('id="proof-source-helper-1"');
      }
      expect(output).not.toMatch(/<h5[^>]*>(?:证明目标|Proof target) \d/u);
      expect(output).toContain(locale === 'en' ? 'A step-by-step mathematical explanation is not yet available.' : '此题尚无逐步数学讲解。');
      expect(output).toContain('data-tab="process"');
      expect(output).toContain('data-tab="source"');
      expect(output).toContain('data-tab="evidence"');
    }
  });

  it('keeps later unsolved runs out of accepted reading and requires the matching original check and proof bytes', () => {
    const record = withArchiveSourceRoute(campaignRecords(root).records.find(record => record.campaign!.target === 'CharacterVarietiesAllSeamsSupport')!);
    const process = record.process!, accepted = record.campaign!;
    process.runs.push({ runId: 'later-unsolved-run', phase: 'prepared', turns: 0, workers: 0, tasks: [], events: [] });
    const output = renderProofSolution(record, process, 'zh');
    expect(output).toContain(`data-proof-solution-run="${accepted.runId}"`);
    expect(output).not.toContain('later-unsolved-run');
    const run = process.runs.find(run => run.runId === accepted.runId)!;
    for (const change of ['run', 'check', 'source'] as const) {
      const changed = structuredClone(process);
      if (change === 'run') changed.runs = changed.runs.filter(candidate => candidate.runId !== accepted.runId);
      if (change === 'check') changed.runs.find(candidate => candidate.runId === run.runId)!.checks = [];
      if (change === 'source') changed.sources![accepted.proofSha256].sha256 = 'another-proof';
      expect(renderProofSolution(record, changed, 'zh')).not.toContain('data-proof-solution=');
    }
  });

  it('uses the Chinese problem title in Chinese reading and the English title in English reading', () => {
    for (const record of campaignRecords(root).records) {
      expect(proofSolutionTitle(localizeRecord(record, 'zh'), 'zh')).toBe(record.subtitle);
      expect(proofSolutionTitle(localizeRecord(record, 'en'), 'en')).toBe(record.en!.subtitle);
    }
  });
});
