import type { Locale } from './site';

export type SnakyCell = readonly [number, number];
export type SnakyFigureStage = 'base' | 'placed' | 'fork';
export interface SnakyFigureModel {
  stage: SnakyFigureStage;
  required: readonly SnakyCell[];
  envelope: readonly SnakyCell[];
  gap: SnakyCell;
  parentMove: SnakyCell;
  height: number;
}

export const snakyFigureStages: readonly SnakyFigureStage[] = ['base', 'placed', 'fork'];
const shape: readonly SnakyCell[] = [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [4, 1]];
const origin: SnakyCell = [0, 0];
const shift: SnakyCell = [-4, -1];
const equal = (a: SnakyCell, b: SnakyCell) => a[0] === b[0] && a[1] === b[1];
const cellText = (cell: SnakyCell) => `(${cell[0]},${cell[1]})`;
const setText = (cells: readonly SnakyCell[]) => `{${cells.map(cellText).join(', ')}}`;
const text = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;
const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Base row 0 and entry_6, as defined in the accepted SnakyCertificate source. */
export function snakyFigureModel(stage: SnakyFigureStage): SnakyFigureModel {
  const envelope = stage === 'base' ? shape : shape.map(([x, y]): SnakyCell => [x + shift[0], y + shift[1]]);
  const gap = stage === 'placed' ? shift : origin;
  return { stage, envelope, required: envelope.filter(cell => !equal(cell, gap)), gap, parentMove: origin, height: stage === 'fork' ? 2 : 1 };
}

const stageTitle = (stage: SnakyFigureStage, locale: Locale) => stage === 'base'
  ? text(locale, '基础行 0', 'Base row 0') : stage === 'placed'
    ? text(locale, '平移后的子行', 'Placed child') : text(locale, '父行 6', 'Parent row 6');

function board(model: SnakyFigureModel, locale: Locale): string {
  const px = (x: number) => 150 + x * 24;
  const py = (y: number) => 112 - y * 24;
  const title = stageTitle(model.stage, locale);
  const description = text(locale,
    `所需格为 ${setText(model.required)}；包络为 ${setText(model.envelope)}；缺口为 ${cellText(model.gap)}，父行落点为 (0,0)，高度为 ${model.height}。`,
    `Required cells: ${setText(model.required)}. Envelope: ${setText(model.envelope)}. Gap: ${cellText(model.gap)}. Parent move: (0,0). Height: ${model.height}.`);
  const grid = Array.from({ length: 12 }, (_, i) => `<path d="M${18 + i * 24} 52V172"/>`).join('')
    + Array.from({ length: 6 }, (_, i) => `<path d="M18 ${52 + i * 24}H282"/>`).join('');
  const cells = model.envelope.map(cell => {
    const required = model.required.some(other => equal(other, cell));
    const current = equal(cell, model.parentMove);
    const name = `${cellText(cell)} · ${required ? text(locale, '所需格', 'Required cell') : text(locale, '缺口', 'Gap')}${current ? text(locale, ' · 父行落点 o', ' · Parent move o') : ''}`;
    return `<g data-snaky-cell="${cell.join(',')}" data-snaky-cell-role="${required ? 'required' : 'gap'}"><title>${html(name)}</title>
      <rect x="${px(cell[0]) - 10}" y="${py(cell[1]) - 10}" width="20" height="20" rx="3" fill="${required ? 'var(--green)' : 'none'}" fill-opacity=".16" stroke="${required ? 'var(--green)' : '#a36545'}" stroke-width="${required ? '1.3' : '1.8'}"${required ? '' : ' stroke-dasharray="3 2"'}/>
      ${required && !current ? `<text x="${px(cell[0])}" y="${py(cell[1]) + 3.5}" text-anchor="middle" fill="var(--green)" font-size="10">A</text>` : ''}</g>`;
  }).join('');
  return `<title>${html(text(locale, `Snaky 证书：${title}`, `Snaky certificate: ${title}`))}</title><desc>${html(description)}</desc>
    <text x="18" y="25" fill="var(--ink)" font-size="13">${html(title)}</text><text x="282" y="25" text-anchor="end" fill="var(--muted)" font-size="12">h = ${model.height}</text>
    <g stroke="var(--line)" stroke-width=".7">${grid}</g>
    <g stroke="var(--muted)" stroke-width=".8" opacity=".6"><path d="M18 112H282"/><path d="M150 52V172"/></g>
    ${[-4, -2, 0, 2, 4].map(x => `<text x="${px(x)}" y="188" text-anchor="middle" fill="var(--muted)" font-size="10">${x}</text>`).join('')}
    ${[-2, -1, 0, 1, 2].map(y => `<text x="13" y="${py(y) + 3.5}" text-anchor="end" fill="var(--muted)" font-size="10">${y}</text>`).join('')}
    <text x="289" y="116" fill="var(--muted)" font-size="11">x</text><text x="147" y="45" fill="var(--muted)" font-size="11">y</text>
    ${cells}
    <g data-snaky-parent-move="0,0"><title>${html(text(locale, '父行落点 o=(0,0)', 'Parent move o=(0,0)'))}</title><circle cx="150" cy="112" r="5" fill="#a36545"/><circle cx="150" cy="112" r="8" fill="none" stroke="#a36545" stroke-width="1"/></g>
    <rect x="20" y="204" width="10" height="10" rx="2" fill="var(--green)" fill-opacity=".16" stroke="var(--green)"/><text x="36" y="213" fill="var(--muted)" font-size="11">${text(locale, '所需格', 'Required')}</text>
    <rect x="112" y="204" width="10" height="10" rx="2" fill="none" stroke="#a36545" stroke-dasharray="3 2"/><text x="128" y="213" fill="var(--muted)" font-size="11">${text(locale, '缺口', 'Gap')}</text>
    <circle cx="213" cy="209" r="4" fill="#a36545"/><text x="225" y="213" fill="var(--muted)" font-size="11">${text(locale, '落点 o', 'Move o')}</text>`;
}

function readout(model: SnakyFigureModel, locale: Locale): string {
  const requiredName = model.stage === 'base' ? 'A₀' : model.stage === 'placed' ? 'A′' : 'A₆';
  const envelopeName = model.stage === 'base' ? 'H₀' : model.stage === 'placed' ? 'H′' : 'H₆';
  const formula = model.stage === 'base' ? 'H₀=S, A₀=S∖{o}, h₀=1'
    : model.stage === 'placed' ? 'P(x,y)=(x−4,y−1), A′=P(A₀), H′=P(H₀)'
      : 'A₆=(A′∪H′)∖{o}=H′∖{o}, H₆=H′, h₆=1+1=2';
  const explanation = model.stage === 'base'
    ? text(locale, '从原六格 S 去掉 o，得到基础行 0 的五个所需格。缺口与父行落点此时都在 (0,0)。', 'Remove o from the six-cell shape S to obtain the five required cells of base row 0. Its gap and the parent move both lie at (0,0).')
    : model.stage === 'placed'
      ? text(locale, 'entry₆ 的字段为 child=0、方向=0、数字=(0,3)，因此平移为 (−4,−1)。子行缺口移到 (−4,−1)；原点 o 此时属于 A′。', 'The fields of entry₆ are child=0, orientation=0 and digits=(0,3), giving translation (−4,−1). The child gap moves to (−4,−1); the origin o now belongs to A′.')
      : text(locale, '只有一个 child，共同包络就是 H′。分叉先把子行缺口 (−4,−1) 加入所需集，再删去父行落点 o；高度从 1 变成 2。', 'With one child, the common envelope is H′. Forking adds the child gap (−4,−1) to the required set, then removes the parent move o. Height increases from 1 to 2.');
  return `<p><strong>${html(formula)}</strong></p><p>${html(explanation)}</p>
    <dl class="proof-figure-coordinates"><div><dt>${requiredName}</dt><dd data-snaky-required>${html(setText(model.required))}</dd></div>
    <div><dt>${envelopeName}</dt><dd data-snaky-envelope>${html(setText(model.envelope))}</dd></div>
    <div><dt>${text(locale, '缺口', 'Gap')}</dt><dd data-snaky-gap>${html(cellText(model.gap))}</dd></div>
    <div><dt>${text(locale, '高度', 'Height')}</dt><dd data-snaky-height>${model.height}</dd></div></dl>`;
}

export function renderSnakyFigure(locale: Locale): string {
  const initial = snakyFigureModel('base');
  return `<figure class="proof-figure" data-proof-figure="snaky" data-locale="${locale}" data-snaky-current="base">
    <div class="proof-figure-heading"><h6>${text(locale, '从六格形状算出父行 6', 'Build parent row 6 from six cells')}</h6><span>entry₆ · child 0</span></div>
    <div class="proof-figure-controls" role="group" aria-label="${text(locale, 'Snaky 重建阶段', 'Snaky reconstruction stage')}">${snakyFigureStages.map((stage, index) => `<button type="button" data-snaky-stage="${stage}" aria-pressed="${stage === 'base'}">${index + 1} · ${stageTitle(stage, locale)}</button>`).join('')}</div>
    <div class="proof-figure-body"><svg class="proof-figure-svg" data-snaky-board viewBox="0 0 300 224" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${text(locale, 'Snaky 所需格、缺口与父行落点', 'Snaky required cells, gap and parent move')}">${board(initial, locale)}</svg>
    <div class="proof-figure-readout" data-snaky-readout aria-live="polite" aria-atomic="true">${readout(initial, locale)}</div></div>
    <figcaption class="proof-figure-caption">${text(locale, '平移保留高度 1；分叉把缺口从 (−4,−1) 换到 o，高度增为 2。绿色表示所需格，虚线框表示缺口，圆点始终标记父行落点 o。', 'Placement preserves height 1. Forking changes the gap from (−4,−1) to o and increases height to 2. Green cells are required; a dashed square marks the gap; the dot always marks the parent move o.')}</figcaption>
  </figure>`;
}

export function mountSnakyFigure(root: HTMLElement, signal: AbortSignal): void {
  const selector = '[data-proof-figure="snaky"]';
  const figures = root.matches(selector) ? [root] : [...root.querySelectorAll<HTMLElement>(selector)];
  for (const figure of figures) {
    const locale: Locale = figure.dataset.locale === 'en' ? 'en' : 'zh';
    const svg = figure.querySelector<SVGSVGElement>('[data-snaky-board]')!;
    const output = figure.querySelector<HTMLElement>('[data-snaky-readout]')!;
    const buttons = [...figure.querySelectorAll<HTMLButtonElement>('button[data-snaky-stage]')];
    for (const button of buttons) button.addEventListener('click', () => {
      const stage = button.dataset.snakyStage as SnakyFigureStage;
      const model = snakyFigureModel(stage);
      svg.innerHTML = board(model, locale);
      output.innerHTML = readout(model, locale);
      figure.dataset.snakyCurrent = stage;
      for (const item of buttons) item.setAttribute('aria-pressed', String(item === button));
    }, { signal });
  }
}
