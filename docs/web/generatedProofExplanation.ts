import type { ArchiveIndexRecord, ArchiveProcess, ArchiveProofExplanation } from './types';
import type { Locale } from './site';

type Record = Pick<ArchiveIndexRecord, 'campaign' | 'sources'>;
const html = (value: string) => value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const text = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;

/** Generated CLI content is bound to the accepted run and each actual source file, including local imports. */
export function selectedGeneratedExplanations(record: Record, process: ArchiveProcess, locale: Locale): ArchiveProofExplanation[] {
  const campaign = record.campaign;
  if (!campaign) return [];
  const valid = (process.explanations ?? []).filter(item => item.runId === campaign.runId && item.proofCommit === campaign.proofCommit
    && item.proofSha256 === campaign.proofSha256 && campaign.targets.includes(item.target)
    && item.sources.every(source => record.sources.some(file => file.name === source.name && file.sha256 === source.sha256)
      && process.sources?.[source.sha256]?.sha256 === source.sha256)
    && item.sections.every(section => item.sources.some(source => source.name === section.file && source.sha256 === section.sha256)));
  return campaign.targets.flatMap(target => valid.find(item => item.target === target && item.language === locale)
    ?? valid.find(item => item.target === target) ?? []);
}

export function renderGeneratedProofExplanations(items: ArchiveProofExplanation[], process: ArchiveProcess, locale: Locale): string {
  const sectionId = (target: number, section: number) => `proof-generated-${target + 1}-${section + 1}`;
  return items.map((item, targetIndex) => {
    const anchor = (name: string) => {
      const index = item.sections.findIndex(section => section.name === name);
      return index < 0 ? `<code>${html(name)}</code>` : `<button type="button" data-global-scroll="${sectionId(targetIndex, index)}">${html(item.sections[index].title)}</button>`;
    };
    return `<section class="proof-walkthrough" data-proof-generated="${html(item.target)}" lang="${item.language}">
      <header class="proof-walkthrough-heading"><h5>${html(item.sections.find(section => section.name === item.target)?.title ?? item.target)}</h5></header>
      <p class="process-note">${text(locale, `自动生成，${item.auditors} 个审核模型对照过 Lean 证明；未经人工审核。`, `Automatically generated and checked against the Lean proof by ${item.auditors} auditors; not reviewed by a person.`)}</p>
      <p class="proof-walkthrough-strategy">${html(item.overview)}</p>
      ${item.route.length ? `<ol class="proof-overview">${item.route.map(stage => `<li><p class="workflow-prose">${html(stage.claim)}</p><div class="proof-walkthrough-links">${stage.declarations.map(anchor).join(' ')}</div></li>`).join('')}</ol>` : ''}
      <ol class="proof-walkthrough-steps">${item.sections.map((section, sectionIndex) => {
        const source = process.sources![section.sha256], lines = source.code.split('\n');
        return `<li class="proof-walkthrough-step" id="${sectionId(targetIndex, sectionIndex)}" data-proof-generated-declaration="${html(section.name)}">
          <header><span>${String(sectionIndex + 1).padStart(2, '0')}</span><h5 tabindex="-1">${html(section.title)}</h5></header>
          <p class="process-code-meta"><code>${html(section.name)}</code> · ${html(section.file)}:${section.line}–${section.endLine}</p>
          ${section.summary ? `<p class="workflow-prose">${html(section.summary)}</p>` : ''}
          <p class="proof-walkthrough-goal">${html(section.statement)}</p>
          ${section.steps.length ? `<ol class="proof-walkthrough-calculation">${section.steps.map((step, stepIndex) => `<li><span>${sectionIndex + 1}.${stepIndex + 1}</span><div><p class="proof-walkthrough-statement">${html(step.text)}</p>
            ${step.uses.length ? `<div class="proof-walkthrough-links">${text(locale, '用到', 'Uses')}: ${step.uses.map(anchor).join(' ')}</div>` : ''}
            <details class="proof-walkthrough-source"><summary>${text(locale, '对照 Lean', 'Compare with Lean')}</summary>${step.lean.map(code => `<pre class="process-code"><code>${html(code)}</code></pre>`).join('')}</details></div></li>`).join('')}</ol>` : ''}
          <details class="proof-walkthrough-source"><summary>${text(locale, '完整声明与证明', 'Complete declaration and proof')} · ${html(section.file)}:${section.line}–${section.endLine}</summary><pre class="process-code"><code>${html(lines.slice(section.line - 1, section.endLine).join('\n'))}</code></pre></details>
        </li>`;
      }).join('')}</ol>
    </section>`;
  }).join('');
}
