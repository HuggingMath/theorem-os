import { describe, expect, it } from 'vitest';
import { anchorSpan, coversAll, explanationEstimate, leanGutter, leanLines, linkedProse, proseAt, proseSegments, quotePieces, quoteRange, refLines, stepAtLine, wholeQuotes } from '../apps/web/client/explainText';
import type { WebExplanationDocument, WebExplanationSection } from '../apps/web/shared';

// The explanation page's pure helpers: Lean lines, step mapping, estimates and source-preserving prose segments.
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

  it('reads complete legacy integral and braced-script expressions without changing their source', () => {
    const integral = '∫_{Bₙ}F≥c(5rₙ/4)⁻²·π(rₙ/4)²=cπ/25>0';
    expect(proseSegments(`${integral}；故 ∫_D F≥Σₙcπ/25=∞。`)).toEqual([
      { kind: 'math', text: integral }, { kind: 'text', text: '；故 ' },
      { kind: 'math', text: '∫_D F≥Σₙcπ/25=∞' }, { kind: 'text', text: '。' },
    ]);
    expect(proseSegments('We use M_{n+1}=F_n/(b*lam)^n, then stop.')).toEqual([
      { kind: 'text', text: 'We use ' }, { kind: 'math', text: 'M_{n+1}=F_n/(b*lam)^n' }, { kind: 'text', text: ', then stop.' },
    ]);
    expect(proseSegments('∑_{vₖ³=a}vₖ=0。')).toEqual([{ kind: 'math', text: '∑_{vₖ³=a}vₖ=0' }, { kind: 'text', text: '。' }]);
    const cauchySchwarz = '(EₚX−E_qX)²≤[Σᵧ|p−q|]·[Σᵧ|p−q|(X−c)²]≤2TV(p,q)·[Eₚ(X−c)²+E_q(X−c)²]';
    expect(proseSegments(`${cauchySchwarz}。`)).toEqual([{ kind: 'math', text: cauchySchwarz }, { kind: 'text', text: '。' }]);
  });

  it('recognizes bare TeX commands, keeping following prose out of the formula', () => {
    expect(proseSegments('先用 \\frac{a}{b} 得到 x≤y，再用 \\sum_{k=0}^{n} a_k。')).toEqual([
      { kind: 'text', text: '先用 ' }, { kind: 'math', text: '\\frac{a}{b}' }, { kind: 'text', text: ' 得到 ' },
      { kind: 'math', text: 'x≤y' }, { kind: 'text', text: '，再用 ' }, { kind: 'math', text: '\\sum_{k=0}^{n} a_k' },
      { kind: 'text', text: '。' },
    ]);
    expect(proseSegments('Use \\left(\\frac{a}{b}\\right)^2 and \\text{对任意 n} x^{2}.')).toEqual([
      { kind: 'text', text: 'Use ' }, { kind: 'math', text: '\\left(\\frac{a}{b}\\right)^2' }, { kind: 'text', text: ' and ' },
      { kind: 'math', text: '\\text{对任意 n} x^{2}' }, { kind: 'text', text: '.' },
    ]);
  });

  it.each([
    'initial_goal_3 OAI.ThreeState.regular_supercritical source_digest',
    'apps/web/source_digest.ts results/openai-math/abc123/Submission.lean',
    '/tmp/M_{n+1}.lean M_{n+1}.lean a_{n}/proof.lean https://example.com/x^{2}',
    'C:\\frac{a}{b} \\Users\\math\\proof.lean',
    'commit a4c1fbf 7a6a6b5211777352a3945870e66a68c5276e23c5',
    'Sₙ₊₁=Σ_children(Nₙ−Tₙ/3)=Σ_children Sₙ。',
    'x^{2}+Σ_children x_i and e^(s/2)',
    'x∈{0,1} and 1{i=1}−1/3',
    'Normal English prose, sin and cos, files and commit messages.',
  ])('leaves identifiers, paths and ambiguous notation as text: %s', text => {
    expect(proseSegments(text)).toEqual([{ kind: 'text', text }]);
  });

  it.each(['$x^{2}', '$$\\frac{1}{2}', '$$x$', '\\(x^{2}', '\\[\\sum_{k=0}^{n}a_k'])('keeps an unfinished explicit formula entirely as source: %s', text => {
    expect(proseSegments(text)).toEqual([{ kind: 'text', text }]);
  });

  it('preserves escaped dollars, code and bold before considering bare expressions', () => {
    expect(proseSegments('价格 \\$5，$x^{2}$；`∫_{Bₙ}F` 与 ``\\frac{a}{b} $x$`` **x^{2}**。')).toEqual([
      { kind: 'text', text: '价格 $5，' }, { kind: 'math', text: 'x^{2}' }, { kind: 'text', text: '；' },
      { kind: 'code', text: '∫_{Bₙ}F' }, { kind: 'text', text: ' 与 ' }, { kind: 'code', text: '\\frac{a}{b} $x$' },
      { kind: 'text', text: ' ' }, { kind: 'strong', text: 'x^{2}' }, { kind: 'text', text: '。' },
    ]);
    expect(proseSegments('$x^{2} `still code` \\frac{a}{b}')).toEqual([
      { kind: 'text', text: '$x^{2} ' }, { kind: 'code', text: 'still code' }, { kind: 'text', text: ' \\frac{a}{b}' },
    ]);
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
    for (const links of [[], [at('自然数')], [at('+ 0', 3), at('\\$5'), at('不变')], [{ start: 0, end: PROSE.length }]]) {
      expect(flatten(linkedProse(PROSE, links))).toEqual(proseSegments(PROSE));
      expect(flatten(linkedProse(PROSE, links, [at('是自然'), at('$5 与')]))).toEqual(proseSegments(PROSE));
    }
    expect(linkedProse('', [{ start: 0, end: 1 }])).toEqual([]);
  });

  it('splits runs where marks begin and end, inside a link too, and marks a formula a mark touches whole', () => {
    const runs = linkedProse(PROSE, [at('自然数')], [at('是自然'), at('+ 0', 3)]);
    expect(runs.filter(run => run.marked)).toEqual([
      { segments: [{ kind: 'text', text: '是' }], marked: true },
      { segments: [{ kind: 'text', text: '自然' }], link: 0, marked: true },
      { segments: [{ kind: 'math', text: 'n + 0 = n' }], marked: true }]);
    expect(runs.filter(run => run.link === 0).map(run => run.segments[0]!.text)).toEqual(['自然', '数']);
  });

  it('keeps raw UTF-16 link and mark ranges when a legacy expression follows a non-BMP character', () => {
    const integral = '∫_{Bₙ}F≥cπ/25', recurrence = 'M_{n+1}=F_n/(b*lam)^n';
    const text = `🧠 由 ${integral} 得到 ${recurrence}。`;
    const inside = text.indexOf('Bₙ'), marked = text.indexOf('π'), recurrenceAt = text.indexOf(recurrence);
    expect(text.indexOf(integral)).toBe(5);
    const runs = linkedProse(text, [{ start: inside, end: inside + 1 }, { start: recurrenceAt + 4, end: recurrenceAt + 5 }],
      [{ start: marked, end: marked + 1 }]);
    expect(runs.filter(run => run.link !== undefined)).toEqual([
      { segments: [{ kind: 'math', text: integral }], link: 0, marked: true },
      { segments: [{ kind: 'math', text: recurrence }], link: 1 },
    ]);
    expect(flatten(runs)).toEqual(proseSegments(text));
    expect(quoteRange(text, inside, inside + 1)).toEqual({ start: 5, end: 5 + integral.length });
  });

  it('keeps a phrase and its bare formula in one link and still splits plain identifier marks precisely', () => {
    const formula = 'M_{n+1}=F_n/(b*lam)^n', text = `由 ${formula} 得到 source_digest`;
    const identifier = text.indexOf('source_digest');
    const runs = linkedProse(text, [{ start: 0, end: text.indexOf('n+1') + 1 }, { start: identifier, end: text.length }],
      [{ start: identifier + 7, end: identifier + 10 }]);
    expect(runs[0]).toEqual({ segments: [{ kind: 'text', text: '由 ' }, { kind: 'math', text: formula }], link: 0 });
    expect(runs.filter(run => run.link === 1)).toEqual([
      { segments: [{ kind: 'text', text: 'source_' }], link: 1 },
      { segments: [{ kind: 'text', text: 'dig' }], link: 1, marked: true },
      { segments: [{ kind: 'text', text: 'est' }], link: 1 },
    ]);
    expect(flatten(runs)).toEqual(proseSegments(text));
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

describe('quote pieces', () => {
  const at = (text: string, quote: string, placed = true, from = 0) => {
    const start = text.indexOf(quote, from);
    return { start, end: start + quote.length, placed };
  };
  // Each piece as `quotes:text`, the drawn quote first and the others of the same text after `+`.
  const shown = (text: string, quotes: Parameters<typeof quotePieces>[1]) =>
    quotePieces(text, quotes).map(piece => `${piece.quotes.join('+')}:${text.slice(piece.start, piece.end)}`);

  it('gives a quote inside another its own words and the outer one the rest, without edge spaces or periods', () => {
    const text = 'For a natural number n, let S(n) = 0 + ... + n be the sum.';
    expect(shown(text, [at(text, text), at(text, 'S(n) = 0 + ... + n be the sum')]))
      .toEqual(['0:For a natural number n, let', '1:S(n) = 0 + ... + n be the sum']);
    // Three deep: each level keeps only what the levels inside it leave.
    expect(shown(text, [at(text, 'For a natural number n, let S(n)'), at(text, 'natural number n'), at(text, 'natural')]))
      .toEqual(['0:For a', '2:natural', '1:number n', '0:let S(n)']);
  });

  it('gives each word to the shortest quote around it, also where quotes cross, merges quotes that differ only at their ends, and prefers placed ones', () => {
    const text = 'Prove that x = y, for all x.';
    // 'x = y, for all' crosses 'that x = y' and keeps the words only it covers.
    expect(shown(text, [at(text, 'that x = y'), at(text, 'x = y, for all'), at(text, 'x = y'), at(text, 'x = y,')]))
      .toEqual(['0:that', '2+3:x = y', '1:for all']);
    // An unplaced quote inside a placed one goes with it, so a click on its text finds both; of two copies the placed one is drawn.
    expect(shown(text, [at(text, 'x = y', false), at(text, 'that x = y'), at(text, 'for all x', false), at(text, 'for all x.')]))
      .toEqual(['1+0:that x = y', '3+2:for all x']);
    // A remainder of only spaces and punctuation is not underlined.
    expect(shown(text, [at(text, 'x = y, for'), at(text, 'x = y'), at(text, 'for')])).toEqual(['1:x = y', '2:for']);
    expect(shown(text, [null, at(text, ', '), at(text, 'Prove that', false)])).toEqual(['2:Prove that']);
    const chinese = '设 n 是自然数，证明 n + 0 = n。';
    expect(shown(chinese, [at(chinese, '设 n 是自然数，'), at(chinese, 'n + 0 = n。')])).toEqual(['0:设 n 是自然数', '1:n + 0 = n']);
  });

  it('takes a whole formula when a quote cuts into one, and leaves a period after it out', () => {
    const text = 'Show $x + 1 = 2$. Then stop.';
    expect(shown(text, [at(text, '1 = 2'), at(text, '$x + 1 = 2$.'), at(text, 'Show $x')]))
      .toEqual(['2:Show', '0+1:$x + 1 = 2$']);
    expect(shown(text, [at(text, 'x + 1'), at(text, 'Then')])).toEqual(['0:$x + 1 = 2$', '1:Then']);
  });

  it('gives every quote of one text to its pieces, also when another quote splits it', () => {
    // Several reviewers' aspects quoting the same words: one click finds all of them.
    const text = 'For every natural number n, n + 0 = n.';
    expect(shown(text, [at(text, 'n + 0 = n'), at(text, 'For every natural number n'), at(text, 'n + 0 = n.'), at(text, 'natural number n'),
      at(text, 'For every natural number n,', false)])).toEqual(['1+4:For every', '3:natural number n', '0+2:n + 0 = n']);
  });

  // Each piece as `quotes:text`, then each longer quote around it after `>`, shortest first.
  const stepped = (text: string, quotes: Parameters<typeof quotePieces>[1]) => quotePieces(text, quotes)
    .map(piece => [`${piece.quotes.join('+')}:${text.slice(piece.start, piece.end)}`, ...piece.wider.map(level => level.join('+'))].join('>'));

  it('lists the other quotes around each piece, shortest first, also those left with no words or crossing another', () => {
    const text = 'For a natural number n, let S(n) = 0 + ... + n be the sum.';
    expect(stepped(text, [at(text, 'For a natural number n, let S(n)'), at(text, 'natural number n'), at(text, 'natural')]))
      .toEqual(['0:For a', '2:natural>1>0', '1:number n>0', '0:let S(n)']);
    // 'For every natural number n' has no words of its own left; 'x = y, for all' crosses 'that x = y'.
    const scope = 'For every natural number n, n + 0 = n.';
    expect(stepped(scope, [at(scope, 'For every natural number n'), at(scope, 'For every'), at(scope, 'natural number n'),
      at(scope, 'For every natural number n,')])).toEqual(['1:For every>0+3', '2:natural number n>0+3']);
    const crossing = 'Prove that x = y, for all x.';
    expect(stepped(crossing, [at(crossing, 'that x = y'), at(crossing, 'x = y, for all'), at(crossing, 'x = y')]))
      .toEqual(['0:that', '2:x = y>0>1', '1:for all']);
    // Every quote is reached: an unplaced one inside a placed one by a click on its words, a crossing one past the other.
    const nested = 'Show that if $R$ is an integral domain, then $R[x]$ is one.';
    const reached = (pieces: ReturnType<typeof quotePieces>) => new Set(pieces.flatMap(piece => [...piece.quotes, ...piece.wider.flat()]));
    const nestedPieces = quotePieces(nested, [at(nested, 'if $R$ is an integral domain'), at(nested, '$R$ is an integral domain', false)]);
    expect(stepped(nested, [at(nested, 'if $R$ is an integral domain'), at(nested, '$R$ is an integral domain', false)]))
      .toEqual(['0+1:if $R$ is an integral domain']);
    expect(reached(nestedPieces)).toEqual(new Set([0, 1]));
    const order = 'Prove that no group of order $p^2 q$, where $p$ and $q$ are prime, is simple.';
    const fragments = ['no group of order $p^2 q$, where $p$ and $q$ are prime, is simple', 'group of order $p^2 q$',
      '$p^2 q$, where $p$ and $q$ are prime', 'of order $p^2 q$, where $p$ and $q$ are prime'].map(quote => at(order, quote));
    expect(stepped(order, fragments)).toEqual(['1:group of order $p^2 q$>0', '2:where $p$ and $q$ are prime>3>0', '0:is simple']);
    expect(reached(quotePieces(order, fragments))).toEqual(new Set([0, 1, 2, 3]));
  });

  it('leaves a word of one or two letters between finer quotes out, reached by clicking a finer quote again', () => {
    const text = 'Prove that if a prime integer p has the form 2^r + 1, then r is a power of 2.';
    expect(stepped(text, [at(text, 'if a prime integer p has the form'), at(text, 'a prime integer p'), at(text, 'prime integer p')]))
      .toEqual(['2:prime integer p>1>0', '0:has the form']);
    // A short quote of its own is kept; an East Asian character counts twice.
    expect(shown(text, [at(text, 'if')])).toEqual(['0:if']);
    const chinese = '证明若 p 是素数，则 p 是奇数或 2。';
    expect(shown(chinese, [at(chinese, '若 p 是素数'), at(chinese, 'p 是素数')])).toEqual(['1:p 是素数']);
    expect(shown(chinese, [at(chinese, '则 p 是奇数'), at(chinese, '奇数')])).toEqual(['0:则 p 是', '1:奇数']);
  });

  it('never draws a hidden quote but counts it around the quotes inside it', () => {
    const text = 'Prove that x = y for all x.';
    expect(stepped(text, [{ ...at(text, text), hidden: true }, at(text, 'x = y')])).toEqual(['1:x = y>0']);
    expect(stepped(text, [{ ...at(text, text), hidden: true }])).toEqual([]);
    expect(stepped(text, [at(text, text), at(text, 'x = y')])).toEqual(['0:Prove that', '1:x = y>0', '0:for all x']);
  });

  it('gives the text a quote covers as pieces count it', () => {
    const text = 'Show $x + 1 = 2$. Then stop.';
    const formula = text.indexOf('$x');
    expect(quoteRange(text, text.indexOf('1 = 2'), text.indexOf('1 = 2') + 5)).toEqual({ start: formula, end: formula + 11 });
    expect(quoteRange(text, text.indexOf('. Then'), text.indexOf('. Then') + 7)).toEqual({ start: text.indexOf('Then'), end: text.indexOf('Then') + 4 });
    expect(quoteRange(text, 4, 5)).toBeUndefined();
  });
});

describe('whole quotes', () => {
  it('is the whole text up to spacing and outer punctuation', () => {
    expect(coversAll('Prove that\n x = y.', 'Prove that x = y')).toBe(true);
    expect(coversAll('Prove that x = y.', 'that x = y')).toBe(false);
    expect(coversAll('Prove that x = y.', 'Prove that x = z')).toBe(false);
  });
});
