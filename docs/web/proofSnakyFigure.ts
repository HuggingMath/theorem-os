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

export type SnakyForkStage = 'child4' | 'child6' | 'combine' | 'fork';
export interface SnakyForkRow {
  required: readonly SnakyCell[];
  envelope: readonly SnakyCell[];
  height: number;
}
export interface SnakyPlacedChild extends SnakyForkRow {
  child: 4 | 6;
  shift: SnakyCell;
  source: SnakyForkRow;
}
export interface SnakyForkModel {
  stage: SnakyForkStage;
  child4: SnakyPlacedChild;
  child6: SnakyPlacedChild;
  unionRequired: readonly SnakyCell[];
  unionEnvelope: readonly SnakyCell[];
  commonEnvelope: readonly SnakyCell[];
  parent: SnakyForkRow;
  addedRequired: readonly SnakyCell[];
  removedRequired: readonly SnakyCell[];
}

export const snakyForkStages: readonly SnakyForkStage[] = ['child4', 'child6', 'combine', 'fork'];
const hasCell = (cells: readonly SnakyCell[], cell: SnakyCell) => cells.some(other => equal(cell, other));
const translate = (cells: readonly SnakyCell[], [dx, dy]: SnakyCell): SnakyCell[] => cells.map(([x, y]) => [x + dx, y + dy]);
const mergeCells = (...sets: readonly (readonly SnakyCell[])[]): SnakyCell[] => sets.flat()
  .filter((cell, index, all) => all.findIndex(other => equal(cell, other)) === index)
  .sort(([ax, ay], [bx, by]) => ax - bx || ay - by);

/** entry_7 = [(4,0,3,4),(6,0,5,4)]; RowData and forkRow in the accepted source. */
export function snakyForkModel(stage: SnakyForkStage): SnakyForkModel {
  const envelope4 = translate(shape, [-3, -1]);
  const source4: SnakyForkRow = { required: envelope4.filter(cell => !equal(cell, origin)), envelope: envelope4, height: 1 };
  const source6 = snakyFigureModel('fork');
  const place = (child: 4 | 6, source: SnakyForkRow, shift: SnakyCell): SnakyPlacedChild => ({
    child, source, shift, required: translate(source.required, shift), envelope: translate(source.envelope, shift), height: source.height,
  });
  const child4 = place(4, source4, [-1, 0]), child6 = place(6, source6, [1, 0]);
  const unionRequired = mergeCells(child4.required, child6.required);
  const unionEnvelope = mergeCells(child4.envelope, child6.envelope);
  const commonEnvelope = child4.envelope.filter(cell => hasCell(child6.envelope, cell));
  const parent: SnakyForkRow = {
    required: mergeCells(unionRequired, commonEnvelope).filter(cell => !equal(cell, origin)),
    envelope: mergeCells([origin], unionEnvelope),
    height: 1 + Math.max(child4.height, child6.height),
  };
  return { stage, child4, child6, unionRequired, unionEnvelope, commonEnvelope, parent,
    addedRequired: parent.required.filter(cell => !hasCell(unionRequired, cell)),
    removedRequired: unionRequired.filter(cell => !hasCell(parent.required, cell)),
  };
}

const forkTitle = (stage: SnakyForkStage, locale: Locale) => stage === 'child4'
  ? text(locale, '放置第 4 行', 'Place row 4') : stage === 'child6'
    ? text(locale, '放置第 6 行', 'Place row 6') : stage === 'combine'
      ? text(locale, '合并 A，对照 H', 'Combine A, compare H') : text(locale, '算出第 7 行', 'Compute row 7');

function forkBoard(model: SnakyForkModel, locale: Locale): string {
  const child = model.stage === 'child4' ? model.child4 : model.stage === 'child6' ? model.child6 : undefined;
  const required = child?.required ?? (model.stage === 'combine' ? model.unionRequired : model.parent.required);
  const envelope = child?.envelope ?? model.parent.envelope;
  const px = (x: number) => 150 + x * 24, py = (y: number) => 112 - y * 24;
  const title = forkTitle(model.stage, locale);
  const nameA = child ? `A${child.child === 4 ? '₄' : '₆'}′` : model.stage === 'combine' ? 'U' : 'A₇';
  const nameH = child ? `H${child.child === 4 ? '₄' : '₆'}′` : model.stage === 'combine' ? 'H₄′∪H₆′' : 'H₇';
  const description = `${nameA}=${setText(required)}; ${nameH}=${setText(envelope)}${model.stage === 'combine' ? `; C=${setText(model.commonEnvelope)}` : ''}.`;
  const grid = Array.from({ length: 12 }, (_, i) => `<path d="M${18 + i * 24} 52V172"/>`).join('')
    + Array.from({ length: 6 }, (_, i) => `<path d="M18 ${52 + i * 24}H282"/>`).join('');
  const cells = envelope.map(cell => {
    const inA = hasCell(required, cell), inCommon = hasCell(model.commonEnvelope, cell);
    const in4 = hasCell(model.child4.required, cell), in6 = hasCell(model.child6.required, cell);
    const common = model.stage === 'combine' && inCommon;
    const removed = model.stage === 'fork' && hasCell(model.removedRequired, cell);
    const label = model.stage === 'combine' ? in4 && in6 ? '4+6' : in4 ? '4' : in6 ? '6' : 'H' : inA ? 'A' : 'H';
    const cellDescription = `${cellText(cell)} · ${inA ? nameA : `${nameH}∖${nameA}`}${common ? ' · C' : ''}${removed ? text(locale, ' · 从所需集中删去 o', ' · o removed from the required set') : ''}`;
    return `<g data-snaky-fork-cell="${cell.join(',')}" data-snaky-fork-required="${inA}" data-snaky-fork-common="${common}" data-snaky-fork-removed="${removed}"><title>${html(cellDescription)}</title>
      <rect x="${px(cell[0]) - 10}" y="${py(cell[1]) - 10}" width="20" height="20" rx="3" fill="${inA ? 'var(--green)' : 'none'}" fill-opacity=".16" stroke="${inA ? 'var(--green)' : '#a36545'}" stroke-width="${inA ? '1.3' : '1.8'}"${inA ? '' : ' stroke-dasharray="3 2"'}/>
      ${common ? `<rect x="${px(cell[0]) - 7}" y="${py(cell[1]) - 7}" width="14" height="14" rx="2" fill="none" stroke="var(--green)" stroke-width=".8"/>` : ''}
      ${!equal(cell, origin) ? `<text x="${px(cell[0])}" y="${py(cell[1]) + 3.5}" text-anchor="middle" fill="${inA ? 'var(--green)' : '#a36545'}" font-size="9">${label}</text>` : ''}</g>`;
  }).join('');
  const value = child ? `h = ${child.height}` : model.stage === 'combine' ? `|U| = ${model.unionRequired.length}, |C| = ${model.commonEnvelope.length}` : `h = ${model.parent.height}`;
  return `<title>${html(text(locale, `Snaky 证书 entry₇：${title}`, `Snaky certificate entry₇: ${title}`))}</title><desc>${html(description)}</desc>
    <text x="18" y="25" fill="var(--ink)" font-size="13">${html(title)}</text><text x="282" y="25" text-anchor="end" fill="var(--muted)" font-size="11">${value}</text>
    <g stroke="var(--line)" stroke-width=".7">${grid}</g><g stroke="var(--muted)" stroke-width=".8" opacity=".6"><path d="M18 112H282"/><path d="M150 52V172"/></g>
    ${[-4, -2, 0, 2, 4].map(x => `<text x="${px(x)}" y="188" text-anchor="middle" fill="var(--muted)" font-size="10">${x}</text>`).join('')}
    ${[-2, -1, 0, 1, 2].map(y => `<text x="13" y="${py(y) + 3.5}" text-anchor="end" fill="var(--muted)" font-size="10">${y}</text>`).join('')}
    <text x="289" y="116" fill="var(--muted)" font-size="11">x</text><text x="147" y="45" fill="var(--muted)" font-size="11">y</text>${cells}
    <g data-snaky-fork-origin><title>${html(text(locale, '原点 o：fork 从 A 中删去它，H 仍保留它', 'Origin o: fork removes it from A and retains it in H'))}</title><circle cx="150" cy="112" r="5" fill="#a36545"/><circle cx="150" cy="112" r="8" fill="none" stroke="#a36545" stroke-width="1"/></g>
    <rect x="20" y="204" width="10" height="10" rx="2" fill="var(--green)" fill-opacity=".16" stroke="var(--green)"/><text x="36" y="213" fill="var(--muted)" font-size="11">${nameA}</text>
    ${model.stage === 'combine' ? '<rect x="84" y="204" width="10" height="10" rx="2" fill="none" stroke="var(--green)"/><rect x="86" y="206" width="6" height="6" rx="1" fill="none" stroke="var(--green)"/><text x="100" y="213" fill="var(--muted)" font-size="11">C</text>' : ''}
    <rect x="128" y="204" width="10" height="10" rx="2" fill="none" stroke="#a36545" stroke-dasharray="3 2"/><text x="144" y="213" fill="var(--muted)" font-size="11">${text(locale, 'H 中其余格', 'Other H cells')}</text>
    <circle cx="259" cy="209" r="4" fill="#a36545"/><text x="271" y="213" fill="var(--muted)" font-size="11">o</text>`;
}

function forkReadout(model: SnakyForkModel, locale: Locale): string {
  const setLine = (name: string, cells: readonly SnakyCell[], attribute: string) => `<div><dt>${name}</dt><dd ${attribute}>${html(cells.length ? setText(cells) : '∅')}</dd></div>`;
  const child = model.stage === 'child4' ? model.child4 : model.stage === 'child6' ? model.child6 : undefined;
  if (child) {
    const sub = child.child === 4 ? '₄' : '₆';
    const formula = `P${sub}(x,y)=(x${child.shift[0] < 0 ? '−1' : '+1'},y), h${sub}′=h${sub}=${child.height}`;
    const explanation = child.child === 4
      ? text(locale, '第一项为 (4,0,3,4)：方向 0 不旋转，数字减 4 得到平移 (−1,0)。第 4 行的五个所需格一起左移，包络中的原缺口也从 o 移到 (−1,0)。', 'The first term is (4,0,3,4). Orientation 0 preserves direction; subtracting 4 from the digits gives translation (−1,0). The five required cells of row 4 move left together, and its envelope-only origin moves to (−1,0).')
      : text(locale, '第二项为 (6,0,5,4)：方向 0 不旋转，平移为 (1,0)。沿用上一步算出的第 6 行，五个所需格一起右移，原缺口从 o 移到 (1,0)，高度仍为 2。', 'The second term is (6,0,5,4): orientation 0 and translation (1,0). Use row 6 from the preceding step, moving its five required cells right together. Its envelope-only origin moves to (1,0), and height stays 2.');
    return `<p><strong>${formula}</strong></p><p>${explanation}</p><dl class="proof-figure-coordinates">
      ${setLine(`A${sub}′`, child.required, 'data-snaky-fork-a')}${setLine(`H${sub}′`, child.envelope, 'data-snaky-fork-h')}
      ${setLine(`H${sub}′∖A${sub}′`, child.envelope.filter(cell => !hasCell(child.required, cell)), 'data-snaky-fork-envelope-only')}
      <div><dt>${text(locale, '高度', 'Height')}</dt><dd data-snaky-fork-height>${child.height}</dd></div></dl>
      <details><summary>${text(locale, `放置前的第 ${child.child} 行`, `Row ${child.child} before placement`)}</summary><dl class="proof-figure-coordinates">${setLine(`A${sub}`, child.source.required, 'data-snaky-fork-source-a')}${setLine(`H${sub}`, child.source.envelope, 'data-snaky-fork-source-h')}</dl></details>`;
  }
  if (model.stage === 'combine') return `<p><strong>U=A₄′∪A₆′, C=H₄′∩H₆′</strong></p>
    <p>${text(locale, '绿色格组成 U，格内的 4、6 标出它来自哪个子行；双边框圈出共同包络 C。C 的四格已经全部在 U 中，因此加上 C 不会新增所需格。', 'Green cells form U; labels 4 and 6 identify the contributing child. Double outlines mark the common envelope C. All four cells of C already belong to U, so adjoining C adds no required cells.')}</p>
    <dl class="proof-figure-coordinates">${setLine('U · |U|=6', model.unionRequired, 'data-snaky-fork-union-a')}${setLine('C · |C|=4', model.commonEnvelope, 'data-snaky-fork-common-h')}${setLine('H₄′∪H₆′ · 8', model.unionEnvelope, 'data-snaky-fork-union-h')}</dl>
    <p><strong>C⊆U ⇒ U∪C=U</strong><br>h₄′=1, h₆′=2</p>
    <p>${text(locale, '接下来按 forkRow 删去 U 中的原点 o，并用子行的最大高度加 1。', 'Next, forkRow removes the origin o from U and adds 1 to the maximum child height.')}</p>`;
  const envelopeOnly = model.parent.envelope.filter(cell => !hasCell(model.parent.required, cell));
  return `<p><strong>A₇=(U∪C)∖{o}=U∖{o}<br>H₇={o}∪H₄′∪H₆′<br>h₇=1+max(1,2)=3</strong></p>
    <p>${text(locale, '所需集只删去 o：从并集的 6 格变成下方一排 5 格，没有新增格。o 已在两个包络中，所以 H 的并集仍为 8 格；它不随 A 一起删去 o。', 'The required set loses only o: the six-cell union becomes a five-cell bottom row, with no new cells. Both envelopes already contain o, so their union remains eight cells; removing o from A does not remove it from H.')}</p>
    <dl class="proof-figure-coordinates">${setLine('A₇ · |A₇|=5', model.parent.required, 'data-snaky-fork-a')}${setLine('H₇ · |H₇|=8', model.parent.envelope, 'data-snaky-fork-h')}
    ${setLine(text(locale, '从 U 新增', 'Added to U'), model.addedRequired, 'data-snaky-fork-added')}${setLine(text(locale, '从 U 删去', 'Removed from U'), model.removedRequired, 'data-snaky-fork-removed-a')}
    ${setLine('H₇∖A₇', envelopeOnly, 'data-snaky-fork-envelope-only')}<div><dt>${text(locale, '高度', 'Height')}</dt><dd data-snaky-fork-height>${model.parent.height}</dd></div></dl>
    <p>${text(locale, '虚线框现在有 3 个，表示 H₇ 中不属于 A₇ 的格，不能再理解成单个缺口。', 'The three dashed cells belong to H₇ but not A₇; the envelope no longer has a single missing required cell.')}</p>`;
}

export function renderSnakyForkFigure(locale: Locale): string {
  const initial = snakyForkModel('child4');
  return `<figure class="proof-figure" data-proof-figure="snaky-fork" data-locale="${locale}" data-snaky-fork-current="child4">
    <div class="proof-figure-heading"><h6>${text(locale, '两个子行怎样合成第 7 行', 'How two children form row 7')}</h6><span>entry₇ · children 4, 6</span></div>
    <div class="proof-figure-controls" role="group" aria-label="${text(locale, 'entry₇ 的集合计算阶段', 'Set calculations for entry₇')}">${snakyForkStages.map((stage, index) => `<button type="button" data-snaky-fork-stage="${stage}" aria-pressed="${stage === 'child4'}">${index + 1} · ${forkTitle(stage, locale)}</button>`).join('')}</div>
    <div class="proof-figure-body"><svg class="proof-figure-svg" data-snaky-fork-board viewBox="0 0 300 224" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${text(locale, '第 7 行的两个放置、共同包络与合成结果', 'The two placements, common envelope and result for row 7')}">${forkBoard(initial, locale)}</svg>
    <div class="proof-figure-readout" data-snaky-fork-readout aria-live="polite" aria-atomic="true">${forkReadout(initial, locale)}</div></div>
    <figcaption class="proof-figure-caption">${text(locale, '两次放置使用同一坐标网格。所需集取并集，共同包络取交集，再按 forkRow 删原点、合并包络并计算高度。', 'Both placements use the same coordinate grid. Union the required sets, intersect the envelopes, then apply forkRow to erase the origin, combine the envelopes and compute the height.')}</figcaption>
  </figure>`;
}

export function mountSnakyForkFigure(root: HTMLElement, signal: AbortSignal): void {
  const selector = '[data-proof-figure="snaky-fork"]';
  const figures = root.matches(selector) ? [root] : [...root.querySelectorAll<HTMLElement>(selector)];
  for (const figure of figures) {
    const locale: Locale = figure.dataset.locale === 'en' ? 'en' : 'zh';
    const svg = figure.querySelector<SVGSVGElement>('[data-snaky-fork-board]')!;
    const output = figure.querySelector<HTMLElement>('[data-snaky-fork-readout]')!;
    const buttons = [...figure.querySelectorAll<HTMLButtonElement>('button[data-snaky-fork-stage]')];
    for (const button of buttons) button.addEventListener('click', () => {
      const stage = button.dataset.snakyForkStage as SnakyForkStage;
      const model = snakyForkModel(stage);
      svg.innerHTML = forkBoard(model, locale); output.innerHTML = forkReadout(model, locale);
      figure.dataset.snakyForkCurrent = stage;
      for (const item of buttons) item.setAttribute('aria-pressed', String(item === button));
    }, { signal });
  }
}
