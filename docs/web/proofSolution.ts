import type { ArchiveIndexRecord, ArchiveProcess } from './types';
import type { Locale } from './site';
import { renderProofWalkthrough, selectedProofWalkthrough } from './proofWalkthrough';
import { archiveProblemDraftHref } from '../../apps/web/client/researchProblemDraft';

const html = (value: string) => value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const text = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;

/** Only the originating workbench directory may be a proof's return destination. */
export function theoremDirectoryReturn(value: string | null, currentHref: string): string | undefined {
  if (!value) return undefined;
  try {
    const current = new URL(currentHref), destination = new URL(value, current);
    const directory = new URL(current.pathname.endsWith('/en/archive.html') ? '../../theorems.html' : '../theorems.html', current);
    if (destination.origin !== current.origin || destination.pathname !== directory.pathname
      || destination.username || destination.password || destination.searchParams.get('collection') !== 'solved') return undefined;
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch { return undefined; }
}

type ProofRecord = Pick<ArchiveIndexRecord, 'id' | 'campaign' | 'sources'>;
function acceptedReadingProof(record: ProofRecord, process: ArchiveProcess) {
  const campaign = record.campaign;
  const run = campaign && process.runs.find(candidate => candidate.runId === campaign.runId && candidate.resultStatus === 'evaluated_passed');
  const source = campaign && process.sources?.[campaign.proofSha256];
  const checked = run?.checks?.some(check => check.scope === 'original' && check.status === 'kernel_verified' && check.sourceDigest === campaign?.proofSha256);
  if (!campaign || !run || !source || source.sha256 !== campaign.proofSha256 || !checked
    || !record.sources.some(file => file.name === 'Submission.lean' && file.sha256 === campaign.proofSha256)) return undefined;
  return { campaign, run, source };
}

/** A small directory label, derived from the same accepted identity as the full reader. */
export function proofSolutionMode(record: ProofRecord, process: ArchiveProcess): ArchiveIndexRecord['readingMode'] {
  const proof = acceptedReadingProof(record, process);
  return proof ? selectedProofWalkthrough(record, process, proof.run) ? 'derivation' : 'source' : undefined;
}

export function proofSolutionTitle(record: ArchiveIndexRecord, locale: Locale): string {
  return record.campaign ? (locale === 'en' ? record.en?.subtitle : record.subtitle) || record.title : record.title;
}

/** Read only the campaign's accepted proof; historical selections belong to the process view. */
export function renderProofSolution(record: ArchiveIndexRecord, process: ArchiveProcess, locale: Locale, options: { workbenchHref?: string } = {}): string {
  const proof = acceptedReadingProof(record, process);
  const links = `<div class="process-detail-actions"><button type="button" class="button" data-tab="source">${text(locale, '完整 Lean 证明', 'Complete Lean proof')}</button><button type="button" class="button" data-tab="evidence">${text(locale, '验收记录', 'Acceptance records')}</button><button type="button" class="button" data-tab="process">${text(locale, '历史轮次与路线图', 'Recorded runs and route maps')}</button></div>`;
  if (!proof)
    return `<p role="status">${text(locale, '此题暂未提供可绑定到接受证明的阅读内容。', 'Reading content bound to the accepted proof is not available for this problem.')}</p>${links}`;
  const { campaign, run, source } = proof;
  const researchHref = options.workbenchHref && archiveProblemDraftHref(record, options.workbenchHref);
  const startResearch = researchHref ? `<a class="button proof-research-start" data-proof-start-research href="${html(researchHref)}">${text(locale, '以此题开始研究', 'Research this problem')}</a>` : '';

  const walkthrough = selectedProofWalkthrough(record, process, run);
  const summary = locale === 'en' ? record.en?.summary ?? record.summary : record.summary;
  let body: string;
  if (walkthrough) body = renderProofWalkthrough(walkthrough, process, run, locale, { linear: true });
  else {
    const file = process.sourceRoute?.files.find(file => file.sha256 === campaign.proofSha256);
    const targets = file?.declarations.filter(declaration => campaign.targets.includes(declaration.name)) ?? [];
    const lines = source.code.split('\n');
    const declaration = (item: NonNullable<typeof file>['declarations'][number]) => `<p class="process-code-meta">Submission.lean:${item.line}–${item.endLine}</p><pre class="process-code" tabindex="0"><code data-proof-source-code>${html(lines.slice(item.line - 1, item.endLine).join('\n'))}</code></pre><div class="process-targets"><code>${html(item.name)}</code></div>`;
    const helpers = file?.declarations.filter(item => !campaign.targets.includes(item.name)) ?? [];
    const targetId = (index: number) => `proof-source-target-${index + 1}`, helperId = (index: number) => `proof-source-helper-${index + 1}`;
    const shortName = (name: string) => html(name.split('.').at(-1)!);
    const indexLinks = (items: typeof targets, id: (index: number) => string) => `<ul>${items.map((item, index) => `<li><button type="button" data-global-scroll="${id(index)}"><code>${shortName(item.name)}</code><span>${item.line}–${item.endLine}</span></button></li>`).join('')}</ul>`;
    body = `<section class="proof-reading-content" data-proof-source-reading><p class="workflow-prose">${text(locale, '以下直接阅读已验收 Lean 源码中的目标声明及证明，按源码顺序排列；此题尚无逐步数学讲解。', 'Read the target declarations and proofs from the accepted Lean source, in source order. A step-by-step mathematical explanation is not yet available.')}</p>
      ${targets.length || helpers.length ? `<details class="proof-source-index"><summary>${text(locale, '目标与辅助定义索引', 'Target and definition index')} <span>${targets.length} / ${helpers.length}</span></summary><nav aria-label="${text(locale, '已验收源码声明', 'Accepted source declarations')}"><h5>${text(locale, '证明目标', 'Proof targets')}</h5>${indexLinks(targets, targetId)}${helpers.length ? `<h5>${text(locale, '辅助声明与定义', 'Supporting declarations and definitions')}</h5>${indexLinks(helpers, helperId)}` : ''}</nav></details>` : ''}
      ${targets.length ? `<ol class="proof-walkthrough-steps">${targets.map((item, index) => `<li class="proof-walkthrough-step" id="${targetId(index)}" data-proof-source-declaration="${html(item.name)}" data-proof-source-lines="${item.line}:${item.endLine}"><header><span>${String(index + 1).padStart(2, '0')}</span><h5 tabindex="-1">${shortName(item.name)}</h5></header>${declaration(item)}</li>`).join('')}</ol>`
        : `<pre class="process-code" tabindex="0"><code data-proof-source-code>${html(source.code)}</code></pre>`}
      ${helpers.length ? `<details class="workflow-full-text"><summary>${text(locale, `辅助声明与定义（${helpers.length}）`, `Supporting declarations and definitions (${helpers.length})`)}</summary>${helpers.map((item, index) => `<details class="proof-walkthrough-source" id="${helperId(index)}"><summary><code>${shortName(item.name)}</code><span>Submission.lean:${item.line}–${item.endLine}</span></summary>${declaration(item)}</details>`).join('')}</details>` : ''}
    </section>`;
  }
  return `<article class="archive-process" data-proof-solution="${html(record.id)}" data-proof-solution-run="${html(run.runId)}" data-proof-solution-sha="${html(source.sha256)}" data-proof-solution-mode="${walkthrough ? 'derivation' : 'source'}">
    <section class="workflow-section proof-solution-summary"><div class="proof-solution-summary-heading"><h4>${text(locale, '问题与结论', 'Problem and result')}</h4>${startResearch}</div><p class="workflow-prose" data-proof-solution-summary>${html(summary)}</p></section>
    ${body}
    <section class="workflow-section" id="global-review"><h4>${text(locale, '证明与验收', 'Proof and acceptance')}</h4><p class="workflow-prose">${text(locale, '以上内容对应当前归档的本地验收通过证明。', 'This reading corresponds to the locally accepted proof in this archive.')}</p>${links}</section>
  </article>`;
}
