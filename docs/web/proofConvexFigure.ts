import type { Locale } from './site';

/** Group the nonnegative weights of a convex combination by cut mass, for 0 ≤ μ ≤ 1. */
export function convexMassModel(mu: number) {
  const oneWeight = 1 - mu, threeWeight = mu, excess = 2 * mu;
  return { mu, oneWeight, threeWeight, mass: 1 + excess, excess, onSection: mu === 0 };
}

const word = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;
const fixed = (value: number) => value.toFixed(2);
const initialMu = 0.25;

function picture(mu: number, locale: Locale): string {
  const state = convexMassModel(mu), left = 24, width = 272, massX = left + width * mu;
  const pointColor = state.onSection ? '#4b5c2f' : '#a36545';
  return `<title>${word(locale,
    `质量一组权重 ${fixed(state.oneWeight)}，质量三组权重 ${fixed(state.threeWeight)}；割质量 ${fixed(state.mass)}，超出下界 ${fixed(state.excess)}`,
    `Mass-one weight ${fixed(state.oneWeight)}, mass-three weight ${fixed(state.threeWeight)}; cut mass ${fixed(state.mass)}, excess ${fixed(state.excess)}`)}</title>
    <text x="24" y="19" class="proof-figure-svg-label">${word(locale, '按生成元的割质量分组', 'Weights grouped by generator mass')}</text>
    <g data-convex-group="one">
      <text x="24" y="47" class="proof-figure-node-label">L(sⱼ) = 1</text>
      <text x="296" y="47" text-anchor="end" class="proof-figure-svg-label">1 − μ = ${fixed(state.oneWeight)}</text>
      <rect x="24" y="58" width="272" height="15" rx="2" fill="#eeeee5"></rect>
      <rect x="24" y="58" width="${width * state.oneWeight}" height="15" rx="2" fill="#4b5c2f" data-convex-weight="one"></rect>
    </g>
    <g data-convex-group="three">
      <text x="24" y="102" class="proof-figure-node-label">L(sⱼ) = 3</text>
      <text x="296" y="102" text-anchor="end" class="proof-figure-svg-label">μ = ${fixed(state.threeWeight)}</text>
      <rect x="24" y="113" width="272" height="15" rx="2" fill="#eeeee5"></rect>
      <rect x="24" y="113" width="${width * state.threeWeight}" height="15" rx="2" fill="#a36545" data-convex-weight="three"></rect>
    </g>
    <text x="24" y="160" class="proof-figure-svg-label">${word(locale, '割质量轴', 'Cut-mass axis')}</text>
    <line x1="24" y1="217" x2="296" y2="217" stroke="#c8cbbc" stroke-width="2"></line>
    <line x1="24" y1="175" x2="24" y2="230" stroke="#4b5c2f" stroke-width="1.5" stroke-dasharray="4 4" data-convex-lower-bound></line>
    <line x1="24" y1="198" x2="${massX}" y2="198" stroke="#a36545" stroke-width="3" stroke-linecap="round" data-convex-excess-segment></line>
    ${[1, 2, 3].map(mass => {
      const x = left + width * (mass - 1) / 2;
      return `<line x1="${x}" y1="212" x2="${x}" y2="223" stroke="#c8cbbc" stroke-width="1.5"></line><text x="${x}" y="245" text-anchor="middle" class="proof-figure-svg-label">${mass}</text>`;
    }).join('')}
    <circle cx="${massX}" cy="217" r="6" fill="${pointColor}" stroke="#fffefa" stroke-width="2" data-convex-mass-point></circle>
    <text x="${massX}" y="185" text-anchor="${mu < 0.2 ? 'start' : mu > 0.8 ? 'end' : 'middle'}" class="proof-figure-node-label">L(y) = ${fixed(state.mass)}</text>
    <text x="24" y="275" class="proof-figure-svg-label">${word(locale, '下界 1', 'Lower bound 1')}</text>
    <text x="296" y="275" text-anchor="end" class="proof-figure-svg-label">2μ = ${fixed(state.excess)}</text>`;
}

function readout(mu: number, locale: Locale): string {
  const state = convexMassModel(mu);
  const conclusion = state.onSection
    ? word(locale,
      'μ=0，质量三组的权重和为零。各项权重均非负，所以这一组的每个权重都是零；剩余正权项全是质量一的生成元。',
      'At μ=0 the mass-three weights sum to zero. Each weight is nonnegative, so every weight in that group is zero. Every remaining positive-weight term has mass one.')
    : word(locale,
      '当前代入结果大于一。要满足截面条件 L(y)=1，必须有 2μ=0，因此 μ=0。',
      'The current value exceeds one. The section condition L(y)=1 requires 2μ=0, hence μ=0.');
  const bridge = state.onSection
    ? `<p class="proof-figure-equation" data-convex-bridge>Q = R ∩ {L = 1}<br>= conv{f(1ₙ)} = f(P)</p><p>${word(locale,
      '前一步已把质量一生成元识别为原图完美匹配的展开 f(1ₙ)。它们的凸组合组成 Q；线性性使 f 与凸组合交换，因此得到 f(P)。',
      'The preceding step identifies mass-one generators with f(1ₙ), the expansions of old perfect matchings. Their convex combinations form Q. Linearity commutes f with these combinations, giving f(P).')}</p>`
    : `<p data-convex-bridge>${word(locale,
      '将 μ 归零，查看剩余生成元怎样组成 f(P)。',
      'Set μ to zero to see how the remaining generators form f(P).')}</p>`;
  return `<p class="proof-figure-formula">y = Σⱼ wⱼsⱼ, wⱼ ≥ 0, Σⱼwⱼ = 1<br>μ = Σ<sub>L(sⱼ)=3</sub> wⱼ ∈ [0, 1]</p>
    <dl class="proof-figure-values"><div><dt>${word(locale, '质量一组的总权重', 'Total mass-one weight')}</dt><dd data-convex-one-weight>1 − μ = ${fixed(state.oneWeight)}</dd></div><div><dt>${word(locale, '质量三组的总权重', 'Total mass-three weight')}</dt><dd data-convex-three-weight>μ = ${fixed(state.threeWeight)}</dd></div></dl>
    <p class="proof-figure-equation" data-convex-equation>L(y) = (1 − μ) + 3μ<br>= ${fixed(state.oneWeight)} + 3 × ${fixed(state.threeWeight)}<br>= ${fixed(state.mass)}</p>
    <p>${word(locale, '超出下界的质量', 'Excess above the lower bound')}<br><span class="proof-figure-formula" data-convex-excess>L(y) − 1 = 2μ = ${fixed(state.excess)} ≥ 0</span></p>
    <p data-convex-conclusion>${conclusion}</p>${bridge}`;
}

function valueText(mu: number, locale: Locale): string {
  return word(locale, `质量三组总权重 ${fixed(mu)}`, `Total mass-three weight ${fixed(mu)}`);
}

export function renderConvexFigure(locale: Locale): string {
  return `<figure class="proof-figure" data-proof-figure="convex-mass-section" data-locale="${locale}" data-convex-mu="${initialMu}" data-convex-section="false">
    <figcaption class="proof-figure-heading">${word(locale, '让凸组合落到质量一的截面', 'Bring the convex combination onto the mass-one section')}</figcaption>
    <div class="proof-figure-body"><div><svg class="proof-figure-svg proof-convex-svg" viewBox="0 0 320 290" role="img" aria-label="${word(locale, '两组生成元的总权重，以及凸组合在割质量轴上的值', 'Grouped generator weights and the convex combination’s value on the cut-mass axis')}" data-convex-picture>${picture(initialMu, locale)}</svg>
      <div class="proof-convex-sliders"><label><span>μ</span><input type="range" min="0" max="1" step="0.01" value="${initialMu}" aria-label="${word(locale, '质量三生成元的总权重 μ', 'Total weight μ of mass-three generators')}" aria-valuetext="${valueText(initialMu, locale)}" data-convex-mu><output data-convex-output>${fixed(initialMu)}</output></label></div>
      <div class="proof-figure-controls"><button type="button" data-convex-reset>${word(locale, '取质量一截面', 'Take the mass-one section')}</button></div></div>
    <div class="proof-figure-readout" data-convex-readout aria-live="polite" aria-atomic="true">${readout(initialMu, locale)}</div></div>
    <p class="proof-figure-caption">${word(locale,
      '两条色带分别表示质量一、质量三生成元的总权重；横轴只表示割质量 L。若 G 没有质量三生成元，实际凸组合的 μ 恒为零。',
      'The bars show total weights of mass-one and mass-three generators; the axis records only the cut mass L. If G has no mass-three generator, every actual convex combination has μ=0.')}</p>
  </figure>`;
}

export function mountConvexFigure(root: HTMLElement, signal: AbortSignal): void {
  const locale: Locale = root.dataset.locale === 'en' ? 'en' : 'zh';
  const input = root.querySelector<HTMLInputElement>('[data-convex-mu]')!;
  const output = root.querySelector<HTMLOutputElement>('[data-convex-output]')!;
  const svg = root.querySelector<SVGSVGElement>('[data-convex-picture]')!;
  const readoutNode = root.querySelector<HTMLElement>('[data-convex-readout]')!;
  const reset = root.querySelector<HTMLButtonElement>('[data-convex-reset]')!;
  function update(mu: number) {
    const state = convexMassModel(mu);
    root.dataset.convexMu = String(mu); root.dataset.convexSection = String(state.onSection);
    input.value = String(mu); input.setAttribute('aria-valuetext', valueText(mu, locale)); output.value = fixed(mu);
    svg.innerHTML = picture(mu, locale); readoutNode.innerHTML = readout(mu, locale);
  }
  input.addEventListener('input', () => update(Number(input.value)), { signal });
  reset.addEventListener('click', () => update(0), { signal });
  update(Number(input.value));
}
