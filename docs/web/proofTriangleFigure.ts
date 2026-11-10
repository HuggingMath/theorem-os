import type { Locale } from './site';

export type TriangleChoice = 0 | 1 | 2 | 'all';

/** New edge i joins the two tips other than i. These are local matching patterns. */
export function triangleMatching(choice: TriangleChoice) {
  const oldEdges: number[] = choice === 'all' ? [0, 1, 2] : [choice];
  const newEdges: number[] = choice === 'all' ? [] : [choice];
  return { oldEdges, newEdges, k: oldEdges.length, t: newEdges.length,
    coverage: [0, 1, 2].map(tip => Number(oldEdges.includes(tip)) + newEdges.filter(edge => edge !== tip).length) };
}

const word = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;
const tips = [[150, 50], [55, 155], [245, 155]];
const outside = [[150, 12], [15, 177], [285, 177]];
const subscripts = ['₀', '₁', '₂'];

function picture(choice: TriangleChoice, locale: Locale): string {
  const state = triangleMatching(choice);
  const line = (from: number[], to: number[], selected: boolean, kind: string) =>
    `<line x1="${from[0]}" y1="${from[1]}" x2="${to[0]}" y2="${to[1]}" class="proof-figure-edge" data-selected="${selected}" data-edge-kind="${kind}"></line>`;
  const old = tips.map((point, i) => line(point, outside[i], state.oldEdges.includes(i), 'old')).join('');
  const inner = tips.map((_, i) => {
    const ends = tips.filter((_, index) => index !== i);
    return line(ends[0], ends[1], state.newEdges.includes(i), 'new');
  }).join('');
  return `<svg class="proof-figure-svg" viewBox="0 0 300 210" role="img" aria-label="${word(locale, '三角形三个顶点的局部匹配', 'A local matching covering the three triangle tips')}">
    <title>${word(locale, `跨割边 ${state.k} 条，内部边 ${state.t} 条，三个顶点各覆盖一次`, `${state.k} crossing edges and ${state.t} internal edges cover each tip once`)}</title>
    <polygon points="150,25 25,175 275,175" class="proof-triangle-cut"></polygon>${inner}${old}${tips.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="11" class="proof-figure-tip"></circle><text x="${x}" y="${y + 4}" text-anchor="middle" class="proof-figure-node-label">${i}</text>`).join('')}
    <g class="proof-figure-svg-label"><text x="164" y="22">e₀</text><text x="12" y="200">e₁</text><text x="269" y="200">e₂</text><text x="150" y="177" text-anchor="middle">${word(locale, '新边 0', 'new 0')}</text><text x="226" y="96" text-anchor="middle">${word(locale, '新边 1', 'new 1')}</text><text x="74" y="96" text-anchor="middle">${word(locale, '新边 2', 'new 2')}</text></g>
  </svg>`;
}

function readout(choice: TriangleChoice, locale: Locale): string {
  const { k, t } = triangleMatching(choice);
  const description = choice === 'all'
    ? word(locale, '三条跨割旧边分别覆盖三个顶点，内部不再选边。', 'Three crossing old edges cover the three tips separately; no internal edge is selected.')
    : word(locale, `旧边 e${subscripts[choice]} 覆盖顶点 ${choice}，新边 ${choice} 覆盖另外两个顶点。`, `Old edge e${subscripts[choice]} covers tip ${choice}; new edge ${choice} covers the other two tips.`);
  return `<p>${description}</p><dl class="proof-figure-values"><div><dt>${word(locale, '跨割旧边 k', 'Crossing old edges k')}</dt><dd>${k}</dd></div><div><dt>${word(locale, '内部边 t', 'Internal edges t')}</dt><dd>${t}</dd></div></dl><p class="proof-figure-equation" data-triangle-equation>${k} + 2 × ${t} = 3</p><p>${word(locale, `割质量 L(1ₘ)=k=${k}。`, `The cut mass is L(1ₘ)=k=${k}.`)}</p>`;
}

export function renderTriangleFigure(locale: Locale): string {
  return `<figure class="proof-figure" data-proof-figure="triangle-matchings" data-locale="${locale}" data-triangle-choice="0">
    <figcaption class="proof-figure-heading">${word(locale, '切换三角形的局部覆盖', 'Switch the local triangle covering')}</figcaption>
    <div class="proof-figure-controls" role="group" aria-label="${word(locale, '选择跨割边', 'Choose the crossing edges')}">${([0, 1, 2, 'all'] as const).map(choice => `<button type="button" data-triangle-choice="${choice}" aria-pressed="${choice === 0}">${choice === 'all' ? word(locale, '三条旧边', 'All three old edges') : word(locale, `旧边 e${subscripts[choice]}`, `Old edge e${subscripts[choice]}`)}</button>`).join('')}</div>
    <div class="proof-figure-body"><div data-triangle-picture>${picture(0, locale)}</div><div class="proof-figure-readout" data-triangle-readout aria-live="polite" aria-atomic="true">${readout(0, locale)}</div></div>
    <p class="proof-figure-caption">${word(locale, '虚线围出三角形的割。陶土色旧边跨过割、覆盖一个顶点；绿色内部边覆盖两个。每个顶点恰好覆盖一次。', 'The dashed outline marks the triangle cut. A terracotta old edge crosses the cut and covers one tip; a green internal edge covers two. Each tip is covered exactly once.')}</p>
  </figure>`;
}

export function mountTriangleFigure(root: HTMLElement, signal: AbortSignal): void {
  const locale: Locale = root.dataset.locale === 'en' ? 'en' : 'zh';
  root.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-triangle-choice]');
    if (!button) return;
    const choice = button.dataset.triangleChoice === 'all' ? 'all' : Number(button.dataset.triangleChoice) as 0 | 1 | 2;
    root.dataset.triangleChoice = String(choice);
    root.querySelector('[data-triangle-picture]')!.innerHTML = picture(choice, locale);
    root.querySelector('[data-triangle-readout]')!.innerHTML = readout(choice, locale);
    root.querySelectorAll<HTMLButtonElement>('[data-triangle-choice]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }, { signal });
}
