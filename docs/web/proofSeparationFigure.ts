import type { Locale } from './site';

export type SeparationCase = 'shared' | 'distinct';
export function separationModel(kind: SeparationCase) {
  const radius = Math.sqrt(3) / 4;
  const upper = kind === 'shared' ? 2 * radius : 1 + 2 * radius;
  const lower = kind === 'shared' ? 1 : Math.sqrt(63) / 4;
  return { kind, radius, upper, lower, gap: lower - upper,
    segments: kind === 'shared' ? [radius, radius] : [radius, 1, radius] };
}

const word = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;
const number = (value: number) => value.toFixed(4);

function picture(kind: SeparationCase, locale: Locale): string {
  const state = separationModel(kind), max = kind === 'shared' ? 1.2 : 2.25;
  const x = (value: number) => 24 + value * 266 / max;
  let sum = 0;
  const bars = state.segments.map((length, index) => {
    const left = x(sum); sum += length;
    const unit = kind === 'distinct' && index === 1;
    return `<rect x="${left}" y="61" width="${x(sum) - left}" height="26" class="proof-distance-segment" data-segment="${unit ? 'unit' : 'cover'}"></rect><text x="${(left + x(sum)) / 2}" y="78" text-anchor="middle" class="proof-figure-node-label">${unit ? '1' : '≤r'}</text>`;
  }).join('');
  return `<title>${word(locale, kind === 'shared' ? '同一中心：距离上界小于一' : '不同中心：中心距下界超过上界', kind === 'shared' ? 'Shared center: the distance upper bound is below one' : 'Distinct centers: the center-distance lower bound exceeds its upper bound')}</title>
    <text x="24" y="29" class="proof-figure-svg-label">${word(locale, kind === 'shared' ? '两段覆盖距离给出的上界' : '沿 Cₓ → x → y → Cᵧ 的上界', kind === 'shared' ? 'Upper bound via the covering center' : 'Upper bound via Cₓ → x → y → Cᵧ')}</text>
    ${bars}<text x="24" y="108" class="proof-figure-svg-label">${kind === 'shared' ? '2r' : '1 + 2r'} ≈ ${number(state.upper)}</text>
    <text x="24" y="144" class="proof-figure-svg-label">${word(locale, kind === 'shared' ? '题设要求的距离' : '同色格点分离给出的下界', kind === 'shared' ? 'Distance required by the hypothesis' : 'Lower bound for equal-color centers')}</text>
    <line x1="${x(state.upper)}" x2="${x(state.upper)}" y1="57" y2="190" class="proof-distance-guide"></line>
    <line x1="${x(state.lower)}" x2="${x(state.lower)}" y1="57" y2="190" class="proof-distance-guide"></line>
    <rect x="${x(state.upper)}" y="157" width="${x(state.lower) - x(state.upper)}" height="23" class="proof-distance-gap"></rect>
    <line x1="24" y1="169" x2="290" y2="169" class="proof-distance-axis"></line>
    ${kind === 'shared' ? '' : `<line x1="${x(state.lower)}" y1="169" x2="290" y2="169" class="proof-distance-lower"></line>`}
    <circle cx="${x(state.lower)}" cy="169" r="5" class="proof-cover-point"></circle>
    <text x="24" y="209" class="proof-figure-svg-label">${kind === 'shared' ? 'dist(x,y) = 1' : 'dist(Cₓ,Cᵧ) ≥ 3√7/4 ≈ ' + number(state.lower)}</text>`;
}

function readout(kind: SeparationCase, locale: Locale): string {
  const state = separationModel(kind);
  const shared = kind === 'shared';
  return `<p>${word(locale, shared ? '两点沿同一个中心相接，每段都不超过 r。' : '两点同色，所以各自中心也同色；不同同色中心满足 Q≥7。', shared ? 'Join the points through their shared center. Each segment is at most r.' : 'The two points have the same color, so their centers do too. Distinct equal-color centers have Q≥7.')}</p>
    <p class="proof-figure-equation" data-separation-inequality>${shared ? '1 = dist(x,y) ≤ 2r < 1' : 'dist(Cₓ,Cᵧ) ≥ 3√7/4 > 1+2r<br>dist(Cₓ,Cᵧ) ≤ r+1+r = 1+2r'}</p>
    <dl class="proof-figure-values"><div><dt>${word(locale, '距离上界', 'Upper bound')}</dt><dd data-separation-upper>${number(state.upper)}</dd></div><div><dt>${word(locale, shared ? '题设距离' : '距离下界', shared ? 'Required distance' : 'Lower bound')}</dt><dd data-separation-lower>${number(state.lower)}</dd></div><div><dt>${word(locale, '两者相差', 'Gap')}</dt><dd data-separation-gap>${number(state.gap)} > 0</dd></div></dl>
    <p>${word(locale, shared ? '上界已经小于题设的 1，同一中心的情形被排除。' : '同一中心距被要求同时不超过上界、又不小于更大的下界，两者无法同时成立。', shared ? 'The upper bound is already below the required distance one, excluding a shared center.' : 'The same center distance would have to lie below the upper bound and above the larger lower bound. These requirements are incompatible.')}</p>
    <button type="button" class="proof-figure-reference" data-global-scroll="proof-derivation-${shared ? 'exclude-a-shared-center' : 'separate-equal-color-centers'}">${word(locale, shared ? '对照同一中心的推导 ↑' : '对照第 2 步的分离下界 ↑', shared ? 'Read the shared-center argument ↑' : 'Read the separation bound in step 2 ↑')}</button>`;
}

export function renderSeparationFigure(locale: Locale): string {
  return `<figure class="proof-figure" data-proof-figure="color-separation" data-locale="${locale}" data-separation-current="shared">
    <figcaption class="proof-figure-heading">${word(locale, '把覆盖界接到最后的两种矛盾', 'Connect the covering bound to both final contradictions')}</figcaption>
    <p class="proof-figure-premise">${word(locale, '假设 dist(x,y)=1 且两点同色。按所选中心是否相同分成两种情形。', 'Assume dist(x,y)=1 and both points have the same color. Split according to whether their chosen centers agree.')}</p>
    <div class="proof-figure-controls" role="group" aria-label="${word(locale, '选择中心关系', 'Choose the relation between centers')}">${(['shared', 'distinct'] as const).map(kind => `<button type="button" data-separation-case="${kind}" aria-pressed="${kind === 'shared'}">${word(locale, kind === 'shared' ? '同一个中心' : '不同的同色中心', kind === 'shared' ? 'Shared center' : 'Distinct equal-color centers')}</button>`).join('')}</div>
    <div class="proof-figure-body"><svg class="proof-figure-svg" data-separation-picture viewBox="0 0 320 232" role="img" aria-label="${word(locale, '距离界与矛盾之间的间隔', 'Distance bounds and the gap giving a contradiction')}">${picture('shared', locale)}</svg><div class="proof-figure-readout" data-separation-readout aria-live="polite" aria-atomic="true">${readout('shared', locale)}</div></div>
    <p class="proof-figure-caption">${word(locale, '两行按同一尺度比较距离界。陶土色的间隔说明两条要求不相容；两种中心关系都被排除，单位距离点因此必异色。', 'Both rows compare bounds on the same scale. The terracotta gap shows why the requirements are incompatible. Excluding both center cases makes every unit-distance pair differently colored.')}</p>
  </figure>`;
}

export function mountSeparationFigure(root: HTMLElement, signal: AbortSignal): void {
  const locale: Locale = root.dataset.locale === 'en' ? 'en' : 'zh';
  root.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-separation-case]');
    if (!button) return;
    const kind = button.dataset.separationCase as SeparationCase;
    root.dataset.separationCurrent = kind;
    root.querySelector('[data-separation-picture]')!.innerHTML = picture(kind, locale);
    root.querySelector('[data-separation-readout]')!.innerHTML = readout(kind, locale);
    root.querySelectorAll<HTMLButtonElement>('[data-separation-case]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }, { signal });
}
