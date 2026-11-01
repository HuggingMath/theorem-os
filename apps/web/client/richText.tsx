import { Fragment } from 'preact';
import { linkedProse, mathPieces, parseMath, proseSegments, type MathNode, type ProseRun, type ProseSegment } from './explainText';

/**
 * A linked phrase of model prose: UTF-16 offsets into its text and what the page needs to find its Lean again. The
 * attributes go on a focusable span; explain.ts and formalization.ts handle its data-action.
 */
export type RichLink = { start: number; end: number; attributes: Record<`data-${string}`, string | number>; className?: string; title: string };

/** A Lean name that may wrap only after a `.` or `_`, so a narrow screen never splits a word of it. */
export const LeanName = ({ name }: { name: string }) => <>{name.split(/(?<=[._])/u).map((part, index) =>
  <Fragment key={index}>{index > 0 && <wbr />}{part}</Fragment>)}</>;

/**
 * Model prose as text nodes: inline code, bold and `$…$` mathematics; a formula that does not parse is shown as written.
 * Text in `marks` (UTF-16 ranges, linked or not) is drawn in a <mark>.
 */
export function Rich(props: { text: string; links?: readonly RichLink[]; marks?: readonly { start: number; end: number }[] }) {
  const { links = [], marks = [] } = props;
  if (!links.length && !marks.length) return <Segments segments={proseSegments(props.text)} />;
  // A link split by a mark is still one focusable span.
  const groups: ProseRun[][] = [];
  for (const run of linkedProse(props.text, links, marks)) {
    const last = groups.at(-1);
    if (last && run.link !== undefined && last[0]!.link === run.link) last.push(run); else groups.push([run]);
  }
  const content = (runs: readonly ProseRun[]) => runs.map((run, index) => run.marked
    ? <mark key={index} class="explain-chosen"><Segments segments={run.segments} /></mark> : <Segments key={index} segments={run.segments} />);
  return <>{groups.map((runs, index) => {
    const at = runs[0]!.link;
    if (at === undefined) return <Fragment key={index}>{content(runs)}</Fragment>;
    const link = links[at]!;
    return <span key={index} class={`explain-link${link.className ? ` ${link.className}` : ''}`} role="button" tabIndex={0}
      title={link.title} {...link.attributes}>{content(runs)}</span>;
  })}</>;
}
function Segments({ segments }: { segments: readonly ProseSegment[] }) {
  return <>{segments.map((segment, index) => {
    if (segment.kind === 'code') return <code key={index} class="explain-code" translate={false}>{segment.text}</code>;
    if (segment.kind === 'strong') return <strong key={index}><Rich text={segment.text} /></strong>;
    if (segment.kind === 'text') return <Fragment key={index}>{segment.text}</Fragment>;
    return <Formula key={index} source={segment.text} display={segment.kind === 'display'} />;
  })}</>;
}
function Formula(props: { source: string; display: boolean }) {
  const node = parseMath(props.source), kind = props.display ? 'math math-display' : 'math';
  if (!node) return <span class={`${kind} math-source`} translate={false}>{props.source}</span>;
  // An inline formula wraps only where TeX would break it, so a long one stays inside a phone's width.
  const pieces = props.display ? [] : mathPieces(node);
  if (pieces.length > 1) return <span class="math math-wraps" title={props.source} translate={false}>{pieces.map((piece, index) =>
    <Fragment key={index}>{index > 0 && <wbr />}<span class="math-piece">{piece.map((child, at) => <MathView key={at} node={child} />)}</span></Fragment>)}</span>;
  return <span class={kind} title={props.source} translate={false}><MathView node={node} /></span>;
}
const textClass = (node: Extract<MathNode, { type: 'text' }>) => [node.style ? `math-${node.style}` : '', node.role ? `math-${node.role}` : ''].filter(Boolean).join(' ') || undefined;
function MathView({ node }: { node: MathNode }): preact.JSX.Element {
  switch (node.type) {
    case 'text': return node.style === 'italic' ? <var class="math-italic">{node.text}</var> : <span class={textClass(node)}>{node.text}</span>;
    case 'row': return <span class={node.style ? `math-${node.style}` : undefined}>{node.children.map((child, index) => <MathView key={index} node={child} />)}</span>;
    case 'script': {
      const scripts = node.sup && node.sub ? <span class="math-scripts"><sup><MathView node={node.sup} /></sup><sub><MathView node={node.sub} /></sub></span>
        : node.sup ? <sup><MathView node={node.sup} /></sup> : node.sub ? <sub><MathView node={node.sub} /></sub> : null;
      const operator = node.base.type === 'text' && (node.base.role === 'big' || node.base.role === 'fn');
      return <span class={operator ? 'math-script math-operator-script' : 'math-script'}><MathView node={node.base} />{scripts}</span>;
    }
    case 'frac': return <span class={node.bar ? 'math-frac' : 'math-frac math-frac-plain'}><span><MathView node={node.top} /></span><span><MathView node={node.bottom} /></span></span>;
    case 'sqrt': return <span class="math-sqrt">{node.index && <sup class="math-root-index"><MathView node={node.index} /></sup>}<span class="math-radical">√</span><span class="math-radicand"><MathView node={node.body} /></span></span>;
    case 'accent': return <span class="math-accent" data-mark={node.mark}><MathView node={node.body} /></span>;
    case 'line': return <span class={`math-${node.position}line`}><MathView node={node.body} /></span>;
    case 'stack': return <span class={`math-stack math-stack-${node.position}`}><span class="math-stack-note"><MathView node={node.note} /></span><span><MathView node={node.base} /></span></span>;
    case 'table': return <span class={`math-table-wrap${node.open || node.close ? ' math-fenced' : ''}`}>
      {node.open && <span class="math-fence">{node.open}</span>}
      <span class={`math-table math-table-${node.align}`}>{node.rows.map((row, index) => <span key={index} class="math-table-row">
        {row.map((cell, column) => <span key={column} class="math-table-cell"><MathView node={cell} /></span>)}</span>)}</span>
      {node.close && <span class="math-fence">{node.close}</span>}</span>;
  }
}
