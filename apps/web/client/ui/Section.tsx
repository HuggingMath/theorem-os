import { render, type ComponentChildren, type VNode } from 'preact';
import type { SourceDiffRow } from '../sourceDiff';
import { jsonText } from '../collaborationUi';
import { t } from '../../i18n';

const mounted = new WeakSet<HTMLElement>();

/** Renders a section in place: replaced nodes keep scroll, data-focus-key focus and open data-detail-key details. */
export function renderSection(root: HTMLElement, view: VNode | null) {
  if (!mounted.has(root)) { root.textContent = ''; delete root.dataset.markup; mounted.add(root); }
  const top = root.scrollTop, left = root.scrollLeft;
  const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : undefined;
  const focusKey = focused?.dataset.focusKey;
  const expanded = new Set([...root.querySelectorAll<HTMLDetailsElement>('details[open][data-detail-key]')].map(item => item.dataset.detailKey));
  render(view, root);
  for (const item of root.querySelectorAll<HTMLDetailsElement>('details[data-detail-key]')) if (expanded.has(item.dataset.detailKey)) item.open = true;
  if (focusKey && focused && !focused.isConnected) root.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  root.scrollTop = top; root.scrollLeft = left;
}

export const Code = (props: { value: unknown; label?: string; [attribute: `data-${string}`]: string | boolean | undefined }) => {
  const { value, label, ...rest } = props;
  return <pre class="collab-code" tabIndex={0} aria-label={label} {...rest}>{typeof value === 'string' ? value : jsonText(value)}</pre>;
};

export const Detail = (props: { title: string; value: unknown; detailKey?: string }) =>
  <details class="collab-detail" data-detail-key={props.detailKey ?? props.title}><summary>{props.title}</summary><Code value={props.value} /></details>;

/** Places elements into translated text: fill(t('{0}下载报告'), <Icon name="download" />). */
export function fill(text: string, ...values: ComponentChildren[]) {
  return <>{text.split(/(\{\d+\})/u).map(part => /^\{\d+\}$/u.test(part) ? values[Number(part.slice(1, -1))] : part)}</>;
}

const factValue = (value: unknown) => value === undefined || value === null ? t('未记录') : String(value);
export const Facts = (props: { facts: ReadonlyArray<readonly [string, unknown]> }) =>
  <dl class="collab-facts">{props.facts.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{factValue(value)}</dd></div>)}</dl>;

export const Empty = (props: { children: ComponentChildren; [attribute: `data-${string}`]: string | boolean | undefined }) => {
  const { children, ...rest } = props;
  return <div class="collab-empty" {...rest}>{children}</div>;
};

/** Hosts an element owned by an imperative component (e.g. TaskSourceComparison) inside a Preact tree. */
export function Host(props: { node: HTMLElement; [attribute: `data-${string}`]: string | boolean | undefined }) {
  const { node, ...rest } = props;
  return <div {...rest} ref={container => { if (container && container.firstChild !== node) container.replaceChildren(node); }} />;
}

const pickers = new WeakSet<HTMLSelectElement>();
/** Options for an imperatively managed select; the value is applied after the options exist. */
export function renderOptions(picker: HTMLSelectElement, options: ReadonlyArray<readonly [value: string, label: string]>, value: string) {
  if (!pickers.has(picker)) { picker.textContent = ''; pickers.add(picker); }
  render(<>{options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</>, picker);
  picker.value = value;
}

const marker = (kind: string) => kind === 'added' ? '+' : kind === 'removed' ? '-' : ' ';
const eofSide = (kind: string) => kind === 'removed' ? 'old' : kind === 'added' ? 'new' : 'both';

/** Fills a table body owned by an imperative view, such as the editor's review step, with comparison rows. */
export function renderDiffRows(body: HTMLElement, rows: readonly SourceDiffRow[]) { render(<DiffRows rows={rows} />, body); }

/** Table rows for both source comparisons; original text and line identities stay intact, including blank lines. */
export function DiffRows(props: { rows: readonly SourceDiffRow[] }) {
  const seen = new Set<number>();
  return <>{props.rows.map((row, index) => {
    if (row.kind === 'gap') return <tr key={`gap-${index}`} class="diff-gap"><td colSpan={3}>{t('{0} 行未改动', row.count)}</td></tr>;
    const firstChange = row.changeId !== undefined && !seen.has(row.changeId);
    if (row.changeId !== undefined) seen.add(row.changeId);
    return <tr key={`${row.oldLine ?? ''}:${row.newLine ?? ''}:${row.kind}`} class={`diff-${row.kind}`} data-old-line={row.oldLine} data-new-line={row.newLine} data-change-start={firstChange ? row.changeId : undefined}>
      <td class="diff-line-no">{row.oldLine ?? ''}</td><td class="diff-line-no">{row.newLine ?? ''}</td>
      <td class="diff-code"><span class="diff-marker" aria-hidden="true">{marker(row.kind)}</span><code data-diff-text>{row.text}</code>{row.noNewline && <span class="diff-no-newline" data-eof-side={eofSide(row.kind)}>{t('文件末尾无换行')}</span>}</td>
    </tr>;
  })}</>;
}
