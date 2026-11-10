import type { Locale } from './site';
import type { Localized, ProofWalkthrough } from './proofWalkthroughTypes';

const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The diagram uses the accepted proof's dependencies, independently of reading order. */
export function renderProofRoute(walkthrough: ProofWalkthrough, locale: Locale, expanded = true): string {
  const text = (zh: string, en: string) => locale === 'en' ? en : zh;
  const label = (value: Localized) => locale === 'en' ? value.en : value.zh;
  const numbers = new Map(walkthrough.steps.map((step, index) => [step.id, String(index + 1).padStart(2, '0')]));
  const edges = walkthrough.steps.flatMap(step => step.dependsOn.map(previous =>
    `<path class="proof-route-edge" data-proof-edge data-from="${html(previous)}" data-to="${html(step.id)}" fill="none" marker-end="url(#proof-route-arrow)"></path>`
  )).join('');
  const nodes = walkthrough.steps.map((step, index) => {
    const number = numbers.get(step.id)!;
    const title = label(step.title);
    const target = `proof-derivation-${step.id}`;
    const dependencies = step.dependsOn.length
      ? `${text('用到', 'Uses')} ${step.dependsOn.map(id => numbers.get(id)!).join(text('、', ', '))}`
      : text('起点', 'Starting point');
    return `<li data-proof-route-node="${html(step.id)}"><button type="button" data-global-scroll="${html(target)}" data-proof-route-step="${html(step.id)}" data-proof-route-number="${number}" data-proof-route-title="${html(title)}" aria-controls="${html(target)}"${index === 0 ? ' aria-current="step"' : ''}>
      <span class="proof-route-number">${number}</span><span class="proof-route-node-copy"><strong class="proof-route-title">${html(title)}</strong><small class="proof-route-dependencies">${html(dependencies)}${step.figure ? `<span class="proof-route-figure">${text('图示', 'Figure')}</span>` : ''}</small></span>${index === walkthrough.steps.length - 1 ? `<span class="proof-route-finish" role="img" aria-label="${text('证明完成', 'Proof complete')}">✓</span>` : ''}
    </button></li>`;
  }).join('');

  return `<nav class="proof-walkthrough-route" aria-label="${text('逐步阅读证明', 'Read the proof step by step')}">
    <details class="proof-route-panel"${expanded ? ' open' : ''}>
      <summary aria-controls="proof-route-map"><span class="proof-route-summary-label">${text('证明路线', 'Proof route')}</span><span class="proof-route-count">${walkthrough.steps.length} ${text('步', 'steps')}</span><span class="proof-route-current"><span data-proof-reading-count>01 / ${String(walkthrough.steps.length).padStart(2, '0')}</span><span data-proof-reading-title>${html(label(walkthrough.steps[0]!.title))}</span></span></summary>
      <div class="proof-route-map" id="proof-route-map">
        <svg class="proof-route-edges" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><defs><marker id="proof-route-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><polygon points="0,0 6,3 0,6" fill="context-stroke"></polygon></marker></defs>${edges}</svg>
        <ol class="proof-route-nodes">${nodes}</ol>
      </div>
      <p class="proof-route-legend"><span aria-hidden="true">→</span> ${text('箭头表示结论依赖', 'Arrows show which results a step uses')}</p>
    </details>
  </nav>`;
}
