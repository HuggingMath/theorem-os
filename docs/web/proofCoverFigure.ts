import type { Locale } from './site';

type Point = readonly [number, number];
export type CoverCorner = '00' | '10' | '01' | '11';

/** The same four cases used by planeEis_corners, in fractional lattice coordinates. */
export function coveringCase(p: number, q: number) {
  const corner: CoverCorner = 2 * p + q <= 1 && p + 2 * q <= 1 ? '00'
    : 2 * p + q >= 2 && p + 2 * q >= 2 ? '11' : q <= p ? '10' : '01';
  const a = Number(corner[0]), b = Number(corner[1]);
  const u = p - a, v = q - b, quadratic = u * u + u * v + v * v;
  return { p, q, corner, a, b, u, v, quadratic, distanceSquared: 9 * quadratic / 16,
    distance: 3 * Math.sqrt(quadratic) / 4, radius: Math.sqrt(3) / 4 };
}

const word = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;
const fixed = (value: number, places = 2) => (Math.abs(value) < 0.000001 ? 0 : value).toFixed(places).replace('-', '−');
const corners: Record<CoverCorner, Point> = { '00': [0, 0], '10': [1, 0], '01': [0, 1], '11': [1, 1] };
const lower: Point[] = [[0, 0], [0.5, 0], [1 / 3, 1 / 3], [0, 0.5]];
const right: Point[] = [[0.5, 0], [1, 0], [1, 0.5], [2 / 3, 2 / 3], [1 / 3, 1 / 3]];
export const coveringRegions: Record<CoverCorner, Point[]> = {
  '00': lower, '10': right, '01': right.map(([p, q]) => [q, p]), '11': lower.map(([p, q]) => [1 - p, 1 - q]),
};
// This affine map preserves the Euclidean geometry of P(p,q)=(3p/4+3q/8,3√3q/8).
export function coveringPlotPoint(p: number, q: number): Point { return [34 + 148 * p + 74 * q, 196 - 74 * Math.sqrt(3) * q]; }
const coords = (p: number, q: number) => coveringPlotPoint(p, q).join(',');

function picture(p: number, q: number, locale: Locale): string {
  const state = coveringCase(p, q), [x, y] = coveringPlotPoint(p, q), [cx, cy] = coveringPlotPoint(state.a, state.b);
  return `<title>${word(locale, `点 (${fixed(p)},${fixed(q)}) 由整数角 (${state.a},${state.b}) 覆盖`, `Point (${fixed(p)},${fixed(q)}) is covered by corner (${state.a},${state.b})`)}</title>
    ${(Object.entries(coveringRegions) as [CoverCorner, Point[]][]).map(([corner, points]) => `<polygon points="${points.map(([a, b]) => coords(a, b)).join(' ')}" class="proof-cover-region" data-cover-region="${corner}" data-selected="${corner === state.corner}"></polygon>`).join('')}
    <line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="proof-cover-distance"></line>
    ${(Object.entries(corners) as [CoverCorner, Point][]).map(([corner, [a, b]]) => {
      const [px, py] = coveringPlotPoint(a, b);
      return `<circle cx="${px}" cy="${py}" r="${corner === state.corner ? 7 : 4}" class="proof-cover-corner" data-selected="${corner === state.corner}"></circle><text x="${px + (a ? 7 : -7)}" y="${py + (b ? -11 : 19)}" text-anchor="${a ? 'start' : 'end'}" class="proof-figure-svg-label">${corner}</text>`;
    }).join('')}
    <circle cx="${x}" cy="${y}" r="6" class="proof-cover-point" data-cover-point></circle><text x="${x + (p > 0.85 ? -10 : 10)}" y="${y - 10}" text-anchor="${p > 0.85 ? 'end' : 'start'}" class="proof-figure-node-label">x</text>`;
}

function readout(p: number, q: number, locale: Locale): string {
  const state = coveringCase(p, q);
  const condition = state.corner === '00' ? '2p + q ≤ 1, p + 2q ≤ 1'
    : state.corner === '11' ? '2p + q ≥ 2, p + 2q ≥ 2'
      : state.corner === '10' ? word(locale, '排除 00、11，且 q ≤ p', 'Outside 00 and 11, q ≤ p')
        : word(locale, '排除 00、11，且 p < q', 'Outside 00 and 11, p < q');
  return `<p>${word(locale, '选角条件', 'Corner case')} <span class="proof-figure-formula">${condition}</span></p>
    <dl class="proof-figure-values"><div><dt>${word(locale, '选取整数角', 'Chosen corner')}</dt><dd data-cover-corner>(${state.a}, ${state.b})</dd></div><div><dt>${word(locale, '误差 (u, v)', 'Error (u, v)')}</dt><dd>(${fixed(state.u)}, ${fixed(state.v)})</dd></div></dl>
    <p class="proof-figure-equation">Q = u² + uv + v²<br><span data-cover-quadratic>≈ ${fixed(state.quadratic, 5)} ≤ 1/3</span></p>
    <p>${word(locale, '代回距离公式', 'Substitute into the distance formula')}<br><span class="proof-figure-formula">dist² = (9/16)Q ≈ ${fixed(state.distanceSquared, 5)}</span></p>
    <p class="proof-figure-equation" data-cover-distance>dist ≈ ${fixed(state.distance, 4)} ≤ r ≈ ${fixed(state.radius, 4)}</p>`;
}

export function renderCoverFigure(locale: Locale): string {
  const p = 0.42, q = 0.28;
  return `<figure class="proof-figure" data-proof-figure="four-corner-cover" data-locale="${locale}">
    <figcaption class="proof-figure-heading">${word(locale, '移动点，看四个整数角怎样覆盖这一格', 'Move the point to see how four corners cover the cell')}</figcaption>
    <div class="proof-figure-body"><div class="proof-cover-picture"><svg class="proof-figure-svg proof-cover-svg" viewBox="0 0 300 224" role="img" aria-label="${word(locale, '斜坐标格中的四个覆盖区域；可点按或拖动点', 'Four covering regions in an oblique lattice cell; click or drag to move the point')}" data-cover-picture>${picture(p, q, locale)}</svg>
    <div class="proof-cover-sliders">${(['p', 'q'] as const).map(axis => `<label><span>${axis}</span><input type="range" min="0" max="1" step="0.01" value="${axis === 'p' ? p : q}" data-cover-coordinate="${axis}" aria-label="${word(locale, `斜坐标 ${axis}`, `Oblique coordinate ${axis}`)}"><output data-cover-output="${axis}">${fixed(axis === 'p' ? p : q)}</output></label>`).join('')}</div></div>
    <div class="proof-figure-readout" data-cover-readout aria-live="polite" aria-atomic="true">${readout(p, q, locale)}</div></div>
    <p class="proof-figure-caption">${word(locale, '点按图中位置或用滑杆移动 x。深色区域对应所选整数角，连线的长度就是 dist；实际格点需加回整数部分 (⌊α⌋,⌊β⌋)。', 'Click the diagram or use the sliders to move x. The shaded region marks the chosen corner; the segment has length dist. Add back (⌊α⌋,⌊β⌋) to recover the actual lattice center.')}</p>
  </figure>`;
}

export function mountCoverFigure(root: HTMLElement, signal: AbortSignal): void {
  const locale: Locale = root.dataset.locale === 'en' ? 'en' : 'zh';
  const svg = root.querySelector<SVGSVGElement>('[data-cover-picture]')!;
  const inputs = [...root.querySelectorAll<HTMLInputElement>('[data-cover-coordinate]')];
  const readoutNode = root.querySelector<HTMLElement>('[data-cover-readout]')!;
  let p = Number(inputs[0].value), q = Number(inputs[1].value);
  function update() {
    root.dataset.coverCorner = coveringCase(p, q).corner;
    svg.innerHTML = picture(p, q, locale); readoutNode.innerHTML = readout(p, q, locale);
    inputs.forEach(input => {
      const value = input.dataset.coverCoordinate === 'p' ? p : q;
      input.value = String(value);
      root.querySelector<HTMLOutputElement>(`[data-cover-output="${input.dataset.coverCoordinate}"]`)!.value = fixed(value);
    });
  }
  inputs.forEach(input => input.addEventListener('input', () => {
    if (input.dataset.coverCoordinate === 'p') p = Number(input.value); else q = Number(input.value);
    update();
  }, { signal }));
  function move(event: PointerEvent) {
    const transform = svg.getScreenCTM(); if (!transform) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
    const round = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
    const rawQ = (196 - point.y) / (74 * Math.sqrt(3));
    p = round((point.x - 34 - 74 * rawQ) / 148); q = round(rawQ); update();
  }
  svg.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    svg.setPointerCapture(event.pointerId); move(event);
  }, { signal });
  svg.addEventListener('pointermove', event => { if (svg.hasPointerCapture(event.pointerId)) move(event); }, { signal });
  svg.addEventListener('pointerup', event => { if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId); }, { signal });
  update();
}
