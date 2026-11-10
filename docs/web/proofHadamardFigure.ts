import type { Locale } from './site';

export type FiberCase = 'a' | 'b';
export type FiberStage = 'unit' | 'select' | 'sum';
export const fiberStages: readonly FiberStage[] = ['unit', 'select', 'sum'];
const word = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;
const name = (stage: FiberStage, locale: Locale) => word(locale,
  stage === 'unit' ? '单位模长' : stage === 'select' ? '代入两个分支' : '求和并消去',
  stage === 'unit' ? 'Unit modulus' : stage === 'select' ? 'Substitute each case' : 'Sum and cancel');

/** Symbolic cases of hpoint; a and b remain arbitrary distinct complex numbers. */
export function fiberModel(stage: FiberStage, branch: FiberCase) {
  return { stage, branch, inFiber: branch === 'a',
    cubeIdentity: branch + '·conj(v)² = v',
    selectedTerm: branch === 'a' ? '(a−b)v' : '0',
    indicator: branch === 'a' ? 1 : 0 };
}

function picture(stage: FiberStage, branch: FiberCase, locale: Locale): string {
  if (stage === 'sum') return `<title>${word(locale, '两个消失矩汇合为纤维和', 'Two vanishing moments yield the fiber sum')}</title>
    <g class="proof-fiber-connector"><path d="M82 75V96H160V116M238 75V96H160"/><path d="M160 160V186"/></g>
    <rect class="proof-fiber-box" x="16" y="20" width="132" height="55" rx="3"/>
    <text x="82" y="43" text-anchor="middle" class="proof-figure-node-label">aΣvₖ</text><text x="82" y="63" text-anchor="middle" class="proof-figure-svg-label">= a · 0</text>
    <rect class="proof-fiber-box" x="172" y="20" width="132" height="55" rx="3"/>
    <text x="238" y="43" text-anchor="middle" class="proof-figure-node-label">−abΣconj(vₖ)²</text><text x="238" y="63" text-anchor="middle" class="proof-figure-svg-label">= −ab · 0</text>
    <rect class="proof-fiber-box" x="46" y="116" width="228" height="44" rx="3" data-selected="true"/>
    <text x="160" y="143" text-anchor="middle" class="proof-figure-node-label">(a−b) Sₐ = 0</text>
    <rect class="proof-fiber-box" x="46" y="186" width="228" height="44" rx="3" data-selected="true"/>
    <text x="160" y="213" text-anchor="middle" class="proof-figure-node-label">a≠b ⇒ Sₐ = 0</text>`;
  const selected = stage === 'select';
  return `<title>${word(locale, `v³=${branch} 时的逐点代入`, `Pointwise substitution when v³=${branch}`)}</title>
    <text x="160" y="23" text-anchor="middle" class="proof-figure-node-label">v·conj(v) = 1</text>
    <path d="M160 32V49" class="proof-fiber-connector"/>
    <text x="160" y="69" text-anchor="middle" class="proof-figure-node-label">v³·conj(v)² = v</text>
    <g class="proof-fiber-connector"><path d="M160 80V94H82V109M160 94H238V109"/><path d="M82 174V192M238 174V192"/></g>
    ${(['a', 'b'] as const).map((item, index) => {
      const x = index ? 172 : 16, center = x + 66;
      return `<g data-fiber-lane="${item}" data-active="${item === branch}">
        <rect class="proof-fiber-box" x="${x}" y="109" width="132" height="65" rx="3" data-selected="${item === branch}"/>
        <text x="${center}" y="133" text-anchor="middle" class="proof-figure-node-label">v³ = ${item}</text>
        <text x="${center}" y="157" text-anchor="middle" class="proof-figure-svg-label">${item}·conj(v)² = v</text>
        <rect class="proof-fiber-box" x="${x}" y="192" width="132" height="38" rx="3" data-selected="${selected && item === branch}"/>
        <text x="${center}" y="216" text-anchor="middle" class="proof-figure-node-label">${selected ? item === 'a' ? '(a−b)v' : '0' : word(locale, '代入筛选式 ↓', 'Substitute ↓')}</text>
      </g>`;
    }).join('')}`;
}

function readout(stage: FiberStage, branch: FiberCase, locale: Locale): string {
  const state = fiberModel(stage, branch);
  if (stage === 'unit') return `<p>${word(locale, '先固定一个指标 k，暂写 v=vₖ。模长一的作用，是把共轭变成乘法中的逆元。', 'Fix one index k and write v=vₖ. Unit modulus makes the conjugate a multiplicative inverse.')}</p>
    <ol class="proof-algebra-lines"><li>|v|=1 ⇒ v·conj(v)=1</li><li>v³·conj(v)²<br>= v(v·conj(v))²<br>= v</li><li data-fiber-local>v³=${branch} ⇒ ${state.cubeIdentity}</li></ol>
    <p>${word(locale, '下一层只需把这个等式代入同一个表达式。', 'The next stage substitutes this identity into one common expression.')}</p>`;
  if (stage === 'select') return `<p>${word(locale, '对每个 v 都计算 F(v)=a(v−b·conj(v)²)。', 'For every v compute F(v)=a(v−b·conj(v)²).')}</p>
    <ol class="proof-algebra-lines" data-fiber-local>${branch === 'a'
      ? '<li>a·conj(v)²=v</li><li>F(v)=av−ab·conj(v)²<br>= av−b(a·conj(v)²)<br>= av−bv<br>= (a−b)v</li>'
      : '<li>b·conj(v)²=v</li><li>F(v)=a(v−v)<br>= 0</li>'}</ol>
    <p>${word(locale, branch === 'a' ? '这一项位于 a 纤维，留下系数 (a−b)。' : '这一项位于 b 纤维；a≠b 保证它不属于 a 纤维，因而被消去。', branch === 'a' ? 'This term belongs to the a-fiber and retains the factor (a−b).' : 'This term belongs to the b-fiber. Since a≠b, it lies outside the a-fiber and is eliminated.')}</p>
    <p class="proof-figure-equation" data-fiber-selected>F(v) = ${state.selectedTerm}</p>
    <p>${word(locale, '合看两种情形，F(vₖ) 就是：在 a 纤维中取 (a−b)vₖ，在其余项取零。', 'Together the cases say that F(vₖ) equals (a−b)vₖ on the a-fiber and zero elsewhere.')}</p>`;
  return `<p>${word(locale, '记 Sₐ=Σ_{vₖ³=a}vₖ。逐项筛选后，对全部 k 求和：', 'Write Sₐ=Σ_{vₖ³=a}vₖ. Sum the pointwise selection over every k:')}</p>
    <ol class="proof-algebra-lines" data-fiber-total><li>(a−b)Sₐ = Σₖ F(vₖ)</li><li>= aΣₖvₖ − abΣₖconj(vₖ)²</li><li>= a·0 − ab·0 = 0</li><li>a−b≠0 ⇒ Sₐ=0</li></ol>
    <p>${word(locale, '第一项用第 1 步的行正交；第二项用第 2 步平方矩的共轭。两个矩各自为零，才使筛选后的纤维和为零。', 'The first term uses row orthogonality from step 1. The second uses the conjugated square moment from step 2. Each vanishes separately, forcing the selected fiber sum to vanish.')}</p>
    <div class="proof-fiber-references"><button type="button" class="proof-figure-reference" data-global-scroll="proof-derivation-derive-the-first-moment">${word(locale, '第一矩从哪里来 ↑', 'Source of the first moment ↑')}</button><button type="button" class="proof-figure-reference" data-global-scroll="proof-derivation-derive-the-second-moment">${word(locale, '共轭平方矩从哪里来 ↑', 'Source of the conjugate-square moment ↑')}</button><button type="button" class="proof-figure-reference" data-global-scroll="proof-derivation-sum-and-cancel">${word(locale, '接到第 5 步的完整求和 →', 'Continue to the full sum in step 5 →')}</button></div>`;
}

export function renderHadamardFigure(locale: Locale): string {
  return `<figure class="proof-figure" data-proof-figure="hadamard-fiber" data-locale="${locale}" data-fiber-current="unit" data-fiber-case="a">
    <figcaption class="proof-figure-heading">${word(locale, '同一个表达式怎样留下 a 纤维', 'How one expression retains the a-fiber')}</figcaption>
    <p class="proof-figure-premise">${word(locale, '保留一般的 a≠b。每项 vₖ 的模长为一，立方只能取 a 或 b。', 'Keep arbitrary distinct values a,b. Each vₖ has unit modulus and cube equal to a or b.')}</p>
    <div class="proof-figure-controls" role="group" aria-label="${word(locale, '选择推导阶段', 'Choose a derivation stage')}">${fiberStages.map((stage, index) => `<button type="button" data-fiber-stage="${stage}" aria-pressed="${stage === 'unit'}">${index + 1} · ${name(stage, locale)}</button>`).join('')}</div>
    <div class="proof-figure-controls" data-fiber-cases role="group" aria-label="${word(locale, '选择当前项的立方', 'Choose the current term’s cube')}">${(['a', 'b'] as const).map(branch => `<button type="button" data-fiber-branch="${branch}" aria-pressed="${branch === 'a'}">v³ = ${branch}</button>`).join('')}</div>
    <div class="proof-figure-body"><svg class="proof-figure-svg" data-fiber-picture viewBox="0 0 320 250" role="img" aria-label="${word(locale, '单位模长、两个立方分支与求和的推导关系', 'Derivation from unit modulus through the two cube cases to summation')}">${picture('unit', 'a', locale)}</svg><div class="proof-figure-readout" data-fiber-readout aria-live="polite" aria-atomic="true">${readout('unit', 'a', locale)}</div></div>
    <p class="proof-figure-caption">${word(locale, '图中是已验收证明里的恒等式：先逐项筛选，再用两个消失矩求和。a、b 始终保留为题设中的一般复数。', 'These are the identities in the accepted proof: select term by term, then sum using the two vanishing moments. The values a,b remain the general complex parameters in the statement.')}</p>
  </figure>`;
}

export function mountHadamardFigure(root: HTMLElement, signal: AbortSignal): void {
  const locale: Locale = root.dataset.locale === 'en' ? 'en' : 'zh';
  function update(stage: FiberStage, branch: FiberCase) {
    root.dataset.fiberCurrent = stage; root.dataset.fiberCase = branch;
    root.querySelector('[data-fiber-picture]')!.innerHTML = picture(stage, branch, locale);
    root.querySelector('[data-fiber-readout]')!.innerHTML = readout(stage, branch, locale);
    root.querySelector<HTMLElement>('[data-fiber-cases]')!.hidden = stage === 'sum';
    root.querySelectorAll<HTMLButtonElement>('[data-fiber-stage]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fiberStage === stage)));
    root.querySelectorAll<HTMLButtonElement>('[data-fiber-branch]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fiberBranch === branch)));
  }
  root.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-fiber-stage], [data-fiber-branch]');
    if (!button) return;
    update((button.dataset.fiberStage ?? root.dataset.fiberCurrent) as FiberStage,
      (button.dataset.fiberBranch ?? root.dataset.fiberCase) as FiberCase);
  }, { signal });
}
