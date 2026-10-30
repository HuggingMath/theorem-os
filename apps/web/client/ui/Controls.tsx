import { render, type ComponentChildren } from 'preact';
import { Icon, Spinner } from './Icon';
import { t } from '../../i18n';

const painted = new WeakSet<Element>();
/** Renders into an element from the static page; the first render replaces the markup Preact did not create. */
export function paint(root: Element, view: ComponentChildren) {
  if (!painted.has(root)) { root.textContent = ''; painted.add(root); }
  render(<>{view}</>, root);
}

const glyph = (name: string) => name === 'spinner' ? <Spinner /> : <Icon name={name} />;
/** An icon button's content: the named icon, or a spinner while it is busy. */
export function renderGlyph(root: Element, name: string) { paint(root, glyph(name)); }
/** A labelled button's content: icon (or spinner) followed by the label. */
export function renderGlyphLabel(root: Element, name: string, label: string) { paint(root, <>{glyph(name)}<span>{label}</span></>); }

export function renderFacts(root: Element, facts: ReadonlyArray<readonly [label: string, value: unknown, mono?: boolean]>) {
  paint(root, facts.map(([label, value, mono]) => <div key={label}><dt>{label}</dt><dd class={mono ? 'mono' : undefined}>{String(value ?? '')}</dd></div>));
}

/** `tabbable` marks the one row Tab stops on; the arrow keys move between rows (app.ts), so twenty records are one stop. */
export type HistoryRowProps = { id: string; title: string; model: string; environment: string; selected: boolean; tabbable: boolean;
  tone: string; symbol: string; label: string; createdAt: string; time: string };
export function renderHistoryRow(row: HTMLElement, props: HistoryRowProps) {
  paint(row, <button type="button" class={props.selected ? 'run-row selected' : 'run-row'} data-run-id={props.id} aria-pressed={props.selected} title={props.title}
    tabIndex={props.tabbable ? 0 : -1}>
    <span class="run-row-title" translate={false}>{props.title}</span>
    <span class="run-row-meta"><span class="run-row-model">{props.model}</span><span class="run-environment">{props.environment}</span></span>
    <span class="run-row-bottom"><span class={`badge ${props.tone}`}><Icon name={props.symbol} />{props.label}</span><time dateTime={props.createdAt}>{props.time}</time></span>
  </button>);
}
/** A group heading in the history list; the count is shown only for the group that asks the owner to act. */
export function renderHistoryGroup(root: HTMLElement, label: string, count?: number) {
  paint(root, <><span>{label}</span>{count !== undefined && <span class="count">{count}</span>}</>);
}
export function renderHistoryEmpty(root: HTMLElement, filtered: boolean) {
  paint(root, <><Icon name={filtered ? 'search' : 'clock-3'} /><p>{filtered ? t('没有匹配的运行') : t('暂无运行记录')}</p>
    {filtered && <button type="button" class="text-button" data-clear-filters>{t('清除筛选')}</button>}</>);
}
