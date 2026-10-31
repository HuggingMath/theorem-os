import { describe, expect, it } from 'vitest';
import { anchorSpan, explanationEstimate, leanGutter, leanLines, linkedProse, parseMath, proseAt, proseSegments, refLines, stepAtLine, wholeQuotes, type MathNode } from '../apps/web/client/explainText';
import type { WebExplanationDocument, WebExplanationSection } from '../apps/web/shared';

// The explanation page's pure helpers: Lean line split, line ↔ step mapping, estimate, prose and TeX reading.
const section = (name: string, start: number, end: number, steps: Omit<WebExplanationSection['steps'][number], 'reviews'>[],
  extra: { target?: boolean; signatureEnd?: number; unexplained?: number[] } = {}): WebExplanationSection =>
  ({ name, kind: extra.target ? 'theorem' : 'definition', target: extra.target ?? false, title: name, statement: '', lines: { start, end },
    signature: { start, end: extra.signatureEnd ?? end }, unexplained: extra.unexplained ?? [], statementReviews: [],
    steps: steps.map(step => ({ ...step, reviews: [] })) });
const use = (name: string) => ({ name, place: 'step' as const, spans: [] });
const DOCUMENT: WebExplanationDocument = {
  schema: 'theorem-os.web-explanation.v1', target: 'main', language: 'zh', toolchain: 'leanprover/lean4:v4.28.0',
  mathlibRevision: null, overview: '', axioms: [],
  sections: [
    section('double', 1, 3, []),
    // A theorem: signature line 5, proof lines 6-14 of which 14 is quoted by no step.
    section('main', 5, 14, [
      { text: 'outer', uses: [], lines: [{ start: 7, end: 12 }] },
      { text: 'inner', uses: [use('double')], lines: [{ start: 9, end: 10 }] },
      { text: 'none', uses: [], lines: [] },
      // Quoted lines arrive sorted and merged (apps/web/explanation.ts placedLines).
      { text: 'split', uses: [], lines: [{ start: 6, end: 6 }, { start: 13, end: 13 }] },
    ], { target: true, signatureEnd: 5, unexplained: [14] }),
  ],
  metrics: { declarations: 2, steps: 4, citations: 1, excerptCoverage: 1, proofLines: 9, explainedLines: 8, ambiguousExcerpts: 0 },
  model: 'gpt', effort: 'high', auditors: 2, rounds: 1, tokens: null,
};

describe('Lean lines', () => {
  it('splits highlighted tokens at line breaks and drops the trailing empty line', () => {
    const lines = leanLines('theorem a : 1 = 1 := by\r\n  rfl -- done\n/- block\ncomment -/\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]![0]).toEqual({ text: 'theorem', kind: 'keyword' });
    expect(lines[1]).toEqual([{ text: '  ' }, { text: 'rfl', kind: 'tactic' }, { text: ' ' }, { text: '-- done', kind: 'comment' }]);
    expect(lines.slice(2)).toEqual([[{ text: '/- block', kind: 'comment' }], [{ text: 'comment -/', kind: 'comment' }]]);
    expect(lines.map(line => line.map(item => item.text).join(''))).toEqual(['theorem a : 1 = 1 := by', '  rfl -- done', '/- block', 'comment -/']);
  });

  it('keeps blank lines inside the file', () => {
    expect(leanLines('a\n\nb')).toEqual([[{ text: 'a' }], [], [{ text: 'b' }]]);
    expect(leanLines('')).toEqual([[]]);
  });
});

describe('line and step mapping', () => {
  it('picks the tightest quoting step, then a proof line no step quotes, then the statement, then nothing', () => {
    expect(stepAtLine(DOCUMENT, 9)).toEqual({ section: 1, step: 1 });
    expect(stepAtLine(DOCUMENT, 8)).toEqual({ section: 1, step: 0 });
    expect(stepAtLine(DOCUMENT, 6)).toEqual({ section: 1, step: 3 });
    expect(stepAtLine(DOCUMENT, 14)).toEqual({ section: 1 });
    expect(stepAtLine(DOCUMENT, 5)).toEqual({ section: 1, statement: true });
    expect(stepAtLine(DOCUMENT, 2)).toEqual({ section: 0, statement: true });
    expect(stepAtLine(DOCUMENT, 4)).toBeUndefined();
  });

  it('points a statement at the signature and a step quoting nothing at the declaration', () => {
    expect(refLines(DOCUMENT, { section: 1, step: 1 })).toEqual([{ start: 9, end: 10 }]);
    expect(refLines(DOCUMENT, { section: 1, step: 2 })).toEqual([{ start: 5, end: 14 }]);
    expect(refLines(DOCUMENT, { section: 1, statement: true })).toEqual([{ start: 5, end: 5 }]);
    expect(refLines(DOCUMENT, { section: 0, statement: true })).toEqual([{ start: 1, end: 3 }]);
    expect(refLines(DOCUMENT, { section: 0 })).toEqual([{ start: 1, end: 3 }]);
    expect(refLines(DOCUMENT, { section: 7 })).toEqual([]);
  });

  it('spans a step from its first quoted line to its last and a heading over the signature, before the first quoted step', () => {
    expect(anchorSpan(DOCUMENT, { section: 1, step: 3 })).toEqual({ start: 6, end: 13 });
    expect(anchorSpan(DOCUMENT, { section: 1, step: 2 })).toEqual({ start: 5, end: 14 });
    expect(anchorSpan(DOCUMENT, { section: 1 })).toEqual({ start: 5, end: 5 });
    expect(anchorSpan(DOCUMENT, { section: 0 })).toEqual({ start: 1, end: 3 });
  });

  it('follows a Lean line with the step quoting it, the step before an unquoted proof line, or the next declaration', () => {
    expect(proseAt(DOCUMENT, 9.5)).toEqual({ ref: { section: 1, step: 1 }, fraction: 0.25 });
    expect(proseAt(DOCUMENT, 14.2)).toEqual({ ref: { section: 1, step: 3 }, fraction: 1 });
    expect(proseAt(DOCUMENT, 5.5)).toEqual({ ref: { section: 1 }, fraction: 0.5 });
    expect(proseAt(DOCUMENT, 2)).toEqual({ ref: { section: 0 }, fraction: 1 / 3 });
    expect(proseAt(DOCUMENT, 4.5)).toEqual({ ref: { section: 1 }, fraction: 0 });
    expect(proseAt(DOCUMENT, 30)).toEqual({ ref: { section: 1 }, fraction: 1 });
  });

  it('marks each line with its step, numbered where a run begins, the statement or an unquoted proof line', () => {
    const marks = [...leanGutter(DOCUMENT)].map(([line, mark]) =>
      `${line}:${mark.kind === 'step' ? `step${mark.step + 1}` : mark.kind}${mark.first ? '*' : ''}`);
    expect(marks).toEqual(['1:statement*', '2:statement', '3:statement', '5:statement*', '6:step4*', '7:step1*', '8:step1',
      '9:step2*', '10:step2', '11:step1*', '12:step1', '13:step4*', '14:unexplained*']);
  });
});

describe('generation estimate', () => {
  const reference = { declarations: 14, seconds: 16_200, tokens: 10_750_000 };
  it('scales by declarations and stops at the limits', () => {
    expect(explanationEstimate(7, reference, { maxRunSeconds: 28_800, maxTotalTokens: 40_000_000 })).toEqual({ seconds: 8100, tokens: 5_375_000 });
    expect(explanationEstimate(0, reference, { maxRunSeconds: 28_800, maxTotalTokens: 40_000_000 })).toEqual({ seconds: 1157, tokens: 767_857 });
    expect(explanationEstimate(100, reference, { maxRunSeconds: 28_800, maxTotalTokens: 40_000_000 })).toEqual({ seconds: 28_800, tokens: 40_000_000 });
  });
});

describe('prose segments', () => {
  it('splits code, bold and the four math delimiters, keeping escaped and unclosed dollars as text', () => {
    expect(proseSegments('设 $n$ 是自然数，`double n` 等于 $$n+n$$，且 \\(a\\) 与 \\[b\\] **重点** 价格 \\$5 和 $未闭合')).toEqual([
      { kind: 'text', text: '设 ' }, { kind: 'math', text: 'n' }, { kind: 'text', text: ' 是自然数，' }, { kind: 'code', text: 'double n' },
      { kind: 'text', text: ' 等于 ' }, { kind: 'display', text: 'n+n' }, { kind: 'text', text: '，且 ' }, { kind: 'math', text: 'a' },
      { kind: 'text', text: ' 与 ' }, { kind: 'display', text: 'b' }, { kind: 'text', text: ' ' }, { kind: 'strong', text: '重点' },
      { kind: 'text', text: ' 价格 $5 和 $未闭合' }]);
  });

  it('skips escaped closers and reads double backticks', () => {
    expect(proseSegments('$a \\$ b$ ``x ` y``')).toEqual([{ kind: 'math', text: 'a \\$ b' }, { kind: 'text', text: ' ' }, { kind: 'code', text: 'x ` y' }]);
    expect(proseSegments('**')).toEqual([{ kind: 'text', text: '**' }]);
  });
});

describe('linked prose', () => {
  const PROSE = '若 $n$ 是自然数，则 $n + 0 = n$，价格 \\$5 与 `double n` 不变。';
  const at = (needle: string, length = needle.length) => ({ start: PROSE.indexOf(needle), end: PROSE.indexOf(needle) + length });
  // Runs flattened back into segments, adjacent text merged: what proseSegments gives for the whole text.
  const flatten = (runs: ReturnType<typeof linkedProse>) => runs.flatMap(run => run.segments).reduce<ReturnType<typeof proseSegments>>(
    (all, segment) => {
      const last = all.at(-1);
      if (last?.kind === 'text' && segment.kind === 'text') all[all.length - 1] = { kind: 'text', text: last.text + segment.text };
      else all.push(segment);
      return all;
    }, []);

  it('widens a link to the whole formula, code span or escape it touches', () => {
    const runs = linkedProse(PROSE, [at('+ 0', 3), at('\\$', 1), at('double')]);
    expect(runs.filter(run => run.link !== undefined)).toEqual([
      { segments: [{ kind: 'math', text: 'n + 0 = n' }], link: 0 },
      { segments: [{ kind: 'text', text: '$' }], link: 1 },
      { segments: [{ kind: 'code', text: 'double n' }], link: 2 }]);
  });

  it('keeps a link over text and formulas as one run and drops later overlapping or empty links', () => {
    const runs = linkedProse(PROSE, [at('是自然数，则 $n + 0 = n$'), at('自然数'), { start: 3, end: 3 }, { start: 500, end: 510 }, at('$n$')]);
    expect(runs.filter(run => run.link !== undefined)).toEqual([
      { segments: [{ kind: 'math', text: 'n' }], link: 4 },
      { segments: [{ kind: 'text', text: '是自然数，则 ' }, { kind: 'math', text: 'n + 0 = n' }], link: 0 }]);
  });

  it('gives back exactly the unlinked segments', () => {
    for (const links of [[], [at('自然数')], [at('+ 0', 3), at('\\$5'), at('不变')], [{ start: 0, end: PROSE.length }]])
      expect(flatten(linkedProse(PROSE, links))).toEqual(proseSegments(PROSE));
    expect(linkedProse('', [{ start: 0, end: 1 }])).toEqual([]);
  });
});

describe('whole quotes', () => {
  const PROBLEM = 'For a natural number n, let S(n) = 0 + 1 + ... + n.\nProve that 2 * S(n) = n * (n + 1).';
  const LEAN = 'import Mathlib\n\ntheorem gauss : ∀ n : ℕ, 2 * S n = n * (n + 1) := by sorry\n';

  it('finds a quote of all the text, up to spacing and punctuation, when a finer one is placed', () => {
    // Missing the final period, its lines joined by a space: still the whole problem.
    const whole = 'For a natural number n, let S(n) = 0 + 1 + ... + n. Prove that 2 * S(n) = n * (n + 1)';
    expect(wholeQuotes(PROBLEM, [whole, '2 * S(n) = n * (n + 1).', null, PROBLEM])).toEqual(new Set([0, 3]));
    expect(wholeQuotes(LEAN, ['import Mathlib theorem gauss : ∀ n : ℕ, 2 * S n = n * (n + 1) := by sorry', '∀ n : ℕ'])).toEqual(new Set([0]));
  });

  it('keeps them when nothing finer is placed, and a quote leaving any letter out is not whole', () => {
    expect(wholeQuotes(PROBLEM, [PROBLEM, null, PROBLEM])).toEqual(new Set());
    expect(wholeQuotes(PROBLEM, [PROBLEM.slice(1), 'Prove that'])).toEqual(new Set());
    expect(wholeQuotes(LEAN, ['theorem gauss : ∀ n : ℕ, 2 * S n = n * (n + 1) := by sorry', '∀ n : ℕ'])).toEqual(new Set());
    expect(wholeQuotes(PROBLEM, ['not in the problem', 'Prove that'])).toEqual(new Set());
    expect(wholeQuotes('', [])).toEqual(new Set());
  });
});

// A compact spelling of the parsed tree: [style], <role>, _{sub}, ^{sup}, frac{}{} (!bar when barless), table<open><close>.
const show = (node: MathNode | undefined): string => {
  if (!node) return '<fail>';
  switch (node.type) {
    case 'text': return `${node.text}${node.style ? `[${node.style}]` : ''}${node.role ? `<${node.role}>` : ''}`;
    case 'row': return `(${node.children.map(show).join(' ')})${node.style ? `[${node.style}]` : ''}`;
    case 'script': return `${show(node.base)}${node.sub ? `_{${show(node.sub)}}` : ''}${node.sup ? `^{${show(node.sup)}}` : ''}`;
    case 'frac': return `frac{${show(node.top)}}{${show(node.bottom)}}${node.bar ? '' : '!bar'}`;
    case 'sqrt': return `sqrt${node.index ? `[${show(node.index)}]` : ''}{${show(node.body)}}`;
    case 'accent': return `accent(${show(node.body)}${node.mark})`;
    case 'line': return `${node.position}line(${show(node.body)})`;
    case 'stack': return `stack(${show(node.base)}|${show(node.note)})`;
    case 'table': return `table${node.open}${node.close}:${node.rows.map(row => row.map(show).join(' & ')).join(' \\\\ ')}`;
  }
};

describe('TeX reader', () => {
  it.each([
    ['x^2 + y_{i,j} \\le \\frac{1}{2}', '(x[italic]^{2[roman]} +<op> y[italic]_{(i[italic] ,<punct> j[italic])} ≤[roman]<op> frac{(1[roman])}{(2[roman])})'],
    ["f'(x) = \\sum_{k=0}^{n} \\binom{n}{k}", '(f[italic]^{′[roman]} ([roman] x[italic] )[roman] =<op> ∑[roman]<big>_{(k[italic] =<op> 0[roman])}^{(n[italic])} (([roman] frac{(n[italic])}{(k[italic])}!bar )[roman]))'],
    ['\\mathbb{R}^n \\to \\mathcal{F}', '(ℝ[roman]^{n[italic]} →[roman]<op> ℱ[roman])'],
    ['\\sqrt[3]{x} \\ne \\hat{a}', '(sqrt[(3[roman])]{(x[italic])} ≠[roman]<op> a\u0302[italic])'],
    ['\\text{对所有 } n \\in \\mathbb{N}, \\ n \\ge 0', '(对所有 [text] n[italic] ∈[roman]<op> ℕ[roman] ,<punct>   n[italic] ≥[roman]<op> 0[roman])'],
    ['\\not\\in \\not= \\not\\perp', '(∉[roman]<op> ≠[roman]<op> ⊥̸[roman]<op>)'],
    ['\\begin{cases} 1 & n = 0 \\\\ n & \\text{otherwise} \\end{cases}', '(table{:1[roman] & (n[italic] =<op> 0[roman]) \\\\ n[italic] & otherwise[text])'],
    ['\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', '(table():a[italic] & b[italic] \\\\ c[italic] & d[italic])'],
    ['\\left( a \\right) \\operatorname{card} S', '(([roman] a[italic] )[roman] card[roman]<fn> S[italic])'],
    ['\\{x \\mid x > 0\\}', '({[roman] x[italic] ∣[roman]<op> x[italic] ><op> 0[roman] }[roman])'],
    ['\\overline{AB} \\cdot \\vec{v}', '(overline((AB[italic])) ⋅[roman]<op> v⃗[italic])'],
    ['\\unknown{x}', '(\\unknown[roman] (x[italic]))'],
  ])('reads %s', (source, tree) => expect(show(parseMath(source))).toBe(tree));

  it('reads ordinary nesting', () => {
    expect(parseMath(`${'\\frac{'.repeat(10)}a${'}{b}'.repeat(10)}`)).toBeDefined();
  });

  it('gives up on malformed, unbalanced or oversized input so the page shows the source', () => {
    for (const source of ['x^{', '\\frac{1}', 'a}', '\\begin{cases} 1 \\end{pmatrix}', `${'{'.repeat(60)}x${'}'.repeat(60)}`, `${'\\hat'.repeat(60)}a`, 'x'.repeat(4001)])
      expect(parseMath(source), source).toBeUndefined();
  });
});
