import type { Locale } from './site';

export type TruffetStage = 'initial' | 'first' | 'second' | 'compare';
export const truffetStages: readonly TruffetStage[] = ['initial', 'first', 'second', 'compare'];
export interface TruffetPoint {
  coordinates: readonly [number, number, number];
  cost: number;
  row0: { rhs: number; lhs: number; holds: boolean };
  row1: { rhs: number; lhs: number; holds: boolean };
  feasible: boolean;
}
export interface TruffetModel {
  stage: TruffetStage;
  state: 'initial' | 'middle' | 'finalState';
  remaining: readonly (0 | 1)[];
  executedStep: readonly [0 | 1, 0 | 1] | null;
  fixedW1: number | null;
  fixedW0: number | null;
  objective: 'w₀' | '1+w₂';
  normalizedObjective: 'w₀' | '1';
  output: TruffetPoint;
  better: TruffetPoint;
  showOutput: boolean;
  showBetter: boolean;
  costGap: number;
}

/** Evaluate the original rows and original objective, before either substitution. */
export function truffetPoint(w0: number, w1: number, w2 = 0): TruffetPoint {
  const row0 = { rhs: w2, lhs: Math.max(w0, w1), holds: w2 <= Math.max(w0, w1) };
  const row1 = { rhs: Math.max(1 + w1, -2 + w2), lhs: w0, holds: Math.max(1 + w1, -2 + w2) <= w0 };
  return { coordinates: [w0, w1, w2], cost: w0, row0, row1, feasible: row0.holds && row1.holds };
}

/** The two ForcedSingletonStep witnesses and explicit comparison points in the accepted source. */
export function truffetModel(stage: TruffetStage): TruffetModel {
  const afterFirst = stage !== 'initial', afterSecond = stage === 'second' || stage === 'compare';
  const output = truffetPoint(1, 0), better = truffetPoint(0, -1);
  return { stage, state: afterSecond ? 'finalState' : afterFirst ? 'middle' : 'initial',
    remaining: afterSecond ? [] : afterFirst ? [0] : [0, 1],
    executedStep: stage === 'first' ? [0, 1] : stage === 'second' ? [1, 0] : null,
    fixedW1: afterFirst ? 0 : null, fixedW0: afterSecond ? 1 : null,
    objective: afterSecond ? '1+w₂' : 'w₀', normalizedObjective: afterSecond ? '1' : 'w₀',
    output, better, showOutput: afterSecond, showBetter: stage === 'compare', costGap: output.cost - better.cost,
  };
}

const word = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;
const html = (value: string) => value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const stageTitle = (stage: TruffetStage, locale: Locale) => stage === 'initial'
  ? word(locale, '原可行域', 'Original feasible region') : stage === 'first'
    ? word(locale, '第一次：固定 w₁', 'First: fix w₁') : stage === 'second'
      ? word(locale, '第二次：固定 w₀', 'Second: fix w₀') : word(locale, '比较两个可行点', 'Compare feasible points');
const plot = (w0: number, w1: number) => [180 + 64 * w1, 214 - 64 * w0] as const;

function picture(model: TruffetModel, locale: Locale): string {
  const [outputX, outputY] = plot(model.output.coordinates[0], model.output.coordinates[1]);
  const [betterX, betterY] = plot(model.better.coordinates[0], model.better.coordinates[1]);
  const afterFirst = model.fixedW1 !== null;
  const description = word(locale,
    `固定 w₂=0；横轴 w₁，纵轴 w₀。绿色区域为 w₀≥max(0,1+w₁)。${afterFirst ? '第一次代换固定 w₁=0，沿此线只剩 w₀≥1。' : ''}${model.showOutput ? '输出点为 (w₀,w₁)=(1,0)，成本为 1。' : ''}${model.showBetter ? '另一原可行点 (0,−1) 的成本为 0。' : ''}`,
    `Fix w₂=0. Horizontal axis: w₁; vertical axis: w₀. The green region is w₀≥max(0,1+w₁). ${afterFirst ? 'The first substitution fixes w₁=0, leaving w₀≥1 on that line. ' : ''}${model.showOutput ? 'The output has (w₀,w₁)=(1,0) and cost 1. ' : ''}${model.showBetter ? 'Another originally feasible point (0,−1) has cost 0.' : ''}`);
  const grid = [-2, -1, 0, 1].map(w1 => `<line x1="${plot(0, w1)[0]}" x2="${plot(0, w1)[0]}" y1="54" y2="246"/>`).join('')
    + [0, 1, 2].map(w0 => `<line x1="52" x2="276" y1="${plot(w0, 0)[1]}" y2="${plot(w0, 0)[1]}"/>`).join('');
  return `<title>${html(stageTitle(model.stage, locale))}</title><desc>${html(description)}</desc>
    <text x="20" y="20" class="proof-figure-svg-label">w₂ = 0 · ${word(locale, '原可行域', 'original feasible region')}</text>
    <g stroke="var(--line)" stroke-width=".8">${grid}</g>
    <polygon points="52,214 116,214 276,54 52,54" fill="#dce5cd" fill-opacity=".7" data-truffet-region><title>w₀ ≥ max(0, 1+w₁)</title></polygon>
    <polyline points="52,214 116,214 276,54" fill="none" stroke="var(--green)" stroke-width="2" data-truffet-boundary/>
    <g stroke="var(--muted)" stroke-width="1"><path d="M44 214H288M180 246V37"/><path d="M284 211L288 214 284 217M177 41L180 37 183 41" fill="none"/></g>
    ${[-2, -1, 0, 1].map(w1 => `<text x="${plot(0, w1)[0]}" y="233" text-anchor="middle" class="proof-figure-svg-label">${w1}</text>`).join('')}
    ${[0, 1, 2].map(w0 => `<text x="170" y="${plot(w0, 0)[1] + 4}" text-anchor="end" class="proof-figure-svg-label">${w0}</text>`).join('')}
    <text x="296" y="218" class="proof-figure-node-label">w₁</text><text x="184" y="38" class="proof-figure-node-label">w₀</text>
    <text x="69" y="79" fill="var(--green)" font-size="12">w₀≥0</text><text x="69" y="95" fill="var(--green)" font-size="12">w₀≥1+w₁</text>
    ${afterFirst ? `<line x1="180" x2="180" y1="54" y2="246" stroke="#a36545" stroke-width="1.5" stroke-dasharray="4 4" data-truffet-first-line/>
      <line x1="180" x2="180" y1="54" y2="150" stroke="#a36545" stroke-width="3" data-truffet-first-feasible/>
      <text x="191" y="110" fill="#a36545" font-size="12">w₁=0</text><text x="191" y="126" fill="#a36545" font-size="11">w₀≥1</text>` : ''}
    ${model.showOutput ? `<circle cx="${outputX}" cy="${outputY}" r="6" fill="#a36545" stroke="#fffefa" stroke-width="2" data-truffet-point="output" data-w0="1" data-w1="0" data-cost="1"><title>${word(locale, '输出 (1,0,0)，原目标为 1', 'Output (1,0,0), original objective 1')}</title></circle>
      <text x="194" y="154" fill="#a36545" font-size="12">${word(locale, '输出 · 成本 1', 'output · cost 1')}</text>` : ''}
    ${model.showBetter ? `<circle cx="${betterX}" cy="${betterY}" r="6" fill="var(--green)" stroke="#fffefa" stroke-width="2" data-truffet-point="better" data-w0="0" data-w1="-1" data-cost="0"><title>${word(locale, '另一原可行点 (0,−1,0)，原目标为 0', 'Another originally feasible point (0,−1,0), original objective 0')}</title></circle>
      <text x="107" y="193" text-anchor="end" fill="var(--green)" font-size="12">${word(locale, '更优点', 'better')}</text><text x="107" y="208" text-anchor="end" fill="var(--green)" font-size="11">${word(locale, '成本 0', 'cost 0')}</text>` : ''}
    <rect x="20" y="262" width="10" height="10" rx="2" fill="#dce5cd" stroke="var(--green)"/><text x="36" y="271" class="proof-figure-svg-label">${word(locale, '原可行域', 'feasible')}</text>
    ${afterFirst ? `<line x1="151" x2="169" y1="267" y2="267" stroke="#a36545" stroke-width="3"/><text x="176" y="271" class="proof-figure-svg-label">${word(locale, '保存的 w₁=0', 'saved w₁=0')}</text>` : ''}`;
}

function readout(model: TruffetModel, locale: Locale): string {
  let calculation: string, explanation: string;
  if (model.stage === 'initial') {
    calculation = '<p class="proof-figure-equation" data-truffet-row="0">0 ≤ max(w₀,w₁)</p><p class="proof-figure-equation" data-truffet-row="1">max(1+w₁,−2) ≤ w₀</p>';
    explanation = word(locale,
      '第二条给出 w₀≥1+w₁。若 w₀<0，第一条迫使 w₁≥0，与第二条冲突。因此两条约束等价于绿色区域 w₀≥max(0,1+w₁)，原目标为 w₀。',
      'The second row gives w₀≥1+w₁. If w₀<0, the first row forces w₁≥0, contradicting the second. Thus the original constraints describe the green region w₀≥max(0,1+w₁), with objective w₀.');
  } else if (model.stage === 'first') {
    calculation = '<p class="proof-figure-equation" data-truffet-substitution>w₁=w₂=0</p><p data-truffet-row="0">0 ≤ max(w₀,0)</p><p data-truffet-row="1">max(1+0,−2)=1 ≤ w₀</p>';
    explanation = word(locale,
      '唯一允许的 (行,变量)=(0,1) 用 lowerForm=w₂ 消去变量 1。第一条自动成立并被清理，middle 只剩 w₀≥1，目标仍为 w₀。将 middle 与这次选择保存的代回式 w₁=0 一起放回原坐标，得到陶土色半直线。',
      'The unique eligible (row,variable)=(0,1) eliminates variable 1 using lowerForm=w₂. The first row is removed as automatic; middle retains only w₀≥1, with objective w₀. Lifting middle back to the original coordinates with the saved reconstruction choice w₁=0 gives the terracotta ray.');
  } else if (model.stage === 'second') {
    calculation = '<p class="proof-figure-equation" data-truffet-substitution>w₀=1+w₂=1</p><p data-truffet-row="0">0 ≤ max(1,0)=1</p><p data-truffet-row="1">max(1+0,−2)=1 ≤ 1</p>';
    explanation = word(locale,
      '现在唯一允许的 (行,变量)=(1,0) 用 lowerForm=1+w₂ 消去变量 0。剩余约束化为 1≤1 而被清理，目标变为 1+w₂=1。两行都已清空，参考列均满足 ⊥≤⊥，所以 stop 成立。按两次代换重建得到输出 (1,0,0)，它也满足这两条原约束。',
      'The sole eligible (row,variable)=(1,0) eliminates variable 0 using lowerForm=1+w₂. The remaining row becomes 1≤1 and is removed; the objective becomes 1+w₂=1. Both rows are now null, so their reference columns satisfy ⊥≤⊥, establishing stop. Reconstructing the substitutions gives output (1,0,0), which also satisfies the two original constraints.');
  } else {
    calculation = `<p><strong>${word(locale, '执行输出', 'Execution output')} <span data-truffet-output>(1,0,0)</span></strong></p>
      <p data-truffet-output-row="0">0 ≤ max(1,0)=1</p><p data-truffet-output-row="1">max(1+0,−2)=1 ≤ 1</p>
      <p class="proof-figure-equation">c_initial(output)=<span data-truffet-output-cost>${model.output.cost}</span><br>c_final(output)=${model.output.cost}</p>
      <p><strong>${word(locale, '另一个原可行点', 'Another originally feasible point')} <span data-truffet-better>(0,−1,0)</span></strong></p>
      <p data-truffet-better-row="0">0 ≤ max(0,−1)=0</p><p data-truffet-better-row="1">max(1−1,−2)=0 ≤ 0</p>
      <p class="proof-figure-equation">c_initial(better)=<span data-truffet-better-cost>${model.better.cost}</span> &lt; ${model.output.cost}</p>`;
    explanation = word(locale,
      '两点都满足同一个原系统。原目标只读取 w₀，因此成本 0<1，差值为 1。这就证明这次合法、有限且终止的执行给出了非最优输出。',
      'Both points satisfy the same original system. Its objective reads w₀, so their costs satisfy 0<1 with a gap of one. This legal finite execution terminates with a nonoptimal output.');
  }
  const source = model.stage === 'initial' ? 'write-the-concrete-system' : model.stage === 'first' ? 'force-the-first-elimination'
    : model.stage === 'second' ? 'force-the-second-elimination' : 'exhibit-the-better-point';
  const reference = model.stage === 'initial' ? word(locale, '对照原约束的推导 ↑', 'Read the original constraints ↑')
    : model.stage === 'first' ? word(locale, '对照第一次代换 ↑', 'Read the first substitution ↑')
      : model.stage === 'second' ? word(locale, '对照第二次代换 ↑', 'Read the second substitution ↑')
        : word(locale, '对照更优点的核验 ↑', 'Read the better-point check ↑');
  return `${calculation}<p>${explanation}</p><dl class="proof-figure-values">
    <div><dt>${word(locale, '剩余变量', 'Remaining variables')}</dt><dd data-truffet-remaining>${model.remaining.length ? `{${model.remaining.join(', ')}}` : '∅'}</dd></div>
    <div><dt>${word(locale, '当前目标', 'Current objective')}</dt><dd data-truffet-objective>c(w)=${model.objective}${model.objective === '1+w₂' ? '=1' : ''}</dd></div>
    ${model.stage === 'compare' ? `<div><dt>${word(locale, '原目标成本差', 'Original cost gap')}</dt><dd data-truffet-cost-gap>${model.costGap}</dd></div>` : ''}</dl>
    <button type="button" class="proof-figure-reference" data-global-scroll="proof-derivation-${source}">${reference}</button>`;
}

export function renderTruffetFigure(locale: Locale): string {
  const initial = truffetModel('initial');
  return `<figure class="proof-figure" data-proof-figure="truffet-elimination" data-locale="${locale}" data-truffet-current="initial" data-truffet-state="initial">
    <figcaption class="proof-figure-heading">${word(locale, '跟随两次代换，再核对输出是否最优', 'Follow two substitutions, then test the output')}</figcaption>
    <p class="proof-figure-premise">${word(locale, '固定 w₂=0；横轴是 w₁，纵轴是 w₀。原目标 c(w)=w₀，点越低，成本越小。', 'Fix w₂=0. The horizontal axis is w₁ and the vertical axis is w₀. A lower point has lower original cost c(w)=w₀.')}</p>
    <div class="proof-figure-controls" role="group" aria-label="${word(locale, '消元执行与可行点对照', 'Elimination steps and feasible-point comparison')}">${truffetStages.map((stage, index) => `<button type="button" data-truffet-stage="${stage}" aria-pressed="${stage === 'initial'}">${index + 1} · ${stageTitle(stage, locale)}</button>`).join('')}</div>
    <div class="proof-figure-body"><svg class="proof-figure-svg" data-truffet-board viewBox="0 0 320 286" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${word(locale, '原可行域、固定 w₁=0 的直线及两个可行点', 'Original feasible region, the line w₁=0 and two feasible points')}">${picture(initial, locale)}</svg>
    <div class="proof-figure-readout" data-truffet-readout aria-live="polite" aria-atomic="true">${readout(initial, locale)}</div></div>
    <p class="proof-figure-caption">${word(locale, '绿色区域始终是原系统的可行域。陶土色半直线把 middle 与保存的代回式 w₁=0 放回原坐标，第二次代换确定执行输出；最后单独比较另一个原可行点。', 'The green region always represents the original system. The terracotta ray lifts middle with the saved reconstruction choice w₁=0; the second substitution fixes the execution output. The final view compares another originally feasible point.')}</p>
  </figure>`;
}

export function mountTruffetFigure(root: HTMLElement, signal: AbortSignal): void {
  const selector = '[data-proof-figure="truffet-elimination"]';
  const figures = root.matches(selector) ? [root] : [...root.querySelectorAll<HTMLElement>(selector)];
  for (const figure of figures) {
    const locale: Locale = figure.dataset.locale === 'en' ? 'en' : 'zh';
    const svg = figure.querySelector<SVGSVGElement>('[data-truffet-board]')!;
    const output = figure.querySelector<HTMLElement>('[data-truffet-readout]')!;
    const buttons = [...figure.querySelectorAll<HTMLButtonElement>('button[data-truffet-stage]')];
    for (const button of buttons) button.addEventListener('click', () => {
      const stage = button.dataset.truffetStage as TruffetStage, model = truffetModel(stage);
      svg.innerHTML = picture(model, locale); output.innerHTML = readout(model, locale);
      figure.dataset.truffetCurrent = stage; figure.dataset.truffetState = model.state;
      for (const item of buttons) item.setAttribute('aria-pressed', String(item === button));
    }, { signal });
  }
}
