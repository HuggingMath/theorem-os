import { Fragment } from 'preact';
import { linkedProse, proseSegments, type ProseRun, type ProseSegment } from './explainText';
import { MathFormula, inlineMathPunctuation } from './ui/MathFormula';

/**
 * A linked phrase of model prose: UTF-16 offsets into its text and what the page needs to find its Lean again. The
 * attributes go on a focusable span; explain.ts and formalization.ts handle its data-action.
 */
export type RichLink = { start: number; end: number; attributes: Record<`data-${string}`, string | number>; className?: string; title: string };

/** A Lean name that may wrap only after a `.` or `_`, so a narrow screen never splits a word of it. */
export const LeanName = ({ name }: { name: string }) => <>{name.split(/(?<=[._])/u).map((part, index) =>
  <Fragment key={index}>{index > 0 && <wbr />}{part}</Fragment>)}</>;

/**
 * Prose as text nodes with code, bold and KaTeX mathematics; an unsupported formula stays readable as written.
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
    if (segment.kind === 'text') {
      const consumed = segments[index - 1]?.kind === 'math' ? inlineMathPunctuation(segment.text).length : 0;
      return <Fragment key={index}>{segment.text.slice(consumed)}</Fragment>;
    }
    const next = segments[index + 1], suffix = segment.kind === 'math' && next?.kind === 'text' ? inlineMathPunctuation(next.text) : '';
    return <MathFormula key={index} source={segment.text} display={segment.kind === 'display'} suffix={suffix} />;
  })}</>;
}
