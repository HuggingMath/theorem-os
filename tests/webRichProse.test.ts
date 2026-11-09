import { toChildArray, type VNode } from 'preact';
import { describe, expect, it } from 'vitest';
import { proseSegments, type ProseSegment } from '../apps/web/client/explainText';
import { RichProse } from '../apps/web/client/richText';

// Inspect the paragraph boundary before the existing Segments/MathFormula renderer runs; no DOM or math mocks.
const paragraphs = (text: string) => {
  const prose = RichProse({ text });
  expect(prose.type).toBe('div');
  expect(prose.props.class).toBe('solution-route-prose');
  return toChildArray(prose.props.children).map(child => {
    const paragraph = child as VNode<{ children: VNode<{ segments: readonly ProseSegment[] }> }>;
    expect(paragraph.type).toBe('p');
    return paragraph.props.children.props.segments;
  });
};

describe('route prose paragraphs', () => {
  it('uses explicit blank lines while retaining every character and single line break inside a paragraph', () => {
    expect(paragraphs('  由前一步得到结果。\n再代入原式。\n\n  故结论成立。  ')).toEqual([
      [{ kind: 'text', text: '  由前一步得到结果。\n再代入原式。' }],
      [{ kind: 'text', text: '  故结论成立。  ' }],
    ]);
  });

  it('handles CRLF, whitespace-only blank lines and repeated separators without empty paragraphs', () => {
    expect(paragraphs('\r\n \r\n首行\r\n续行\r\n\t\r\n\r\n末行\r\n\r\n')).toEqual([
      [{ kind: 'text', text: '首行\r\n续行' }], [{ kind: 'text', text: '末行' }],
    ]);
    expect(paragraphs(' \n\n\t\n')).toEqual([]);
    expect(paragraphs('')).toEqual([]);
  });

  it.each([
    '$$\\begin{aligned}a&=b\\\\\n\nc&=d\\end{aligned}$$',
    '\\[f(x)=\\begin{cases}x&x>0\\\\\n\n0&x\\le0\\end{cases}\\]',
    '$a\n\n+b$', '\\(a\n\n+b\\)',
    '`line one\n\nline two`', '``line ` one\n\nline two``',
    '**前半段\n\n后半段 $x$**',
  ])('keeps a protected span whole when it contains blank lines: %s', protectedText => {
    expect(paragraphs(`先说明 ${protectedText} 再使用。\n\n最后一步。`)).toEqual([
      proseSegments(`先说明 ${protectedText} 再使用。`), proseSegments('最后一步。'),
    ]);
  });

  it('retains inline punctuation and complete display math next to paragraph boundaries', () => {
    const first = '由 $x^{2}$，得到 $y$。', second = '$$\\frac{a}{b}$$', third = '**故** `exact h` 完成。';
    expect(paragraphs(`${first}\n\n${second}\n\n${third}`)).toEqual([
      proseSegments(first), proseSegments(second), proseSegments(third),
    ]);
  });

  it('does not invent sentence boundaries or interpret additional markup', () => {
    const text = '第一步。第二步！\n- 原始条目\n# 原始标题\n<script>raw</script>\n价格 \\$5。';
    expect(paragraphs(text)).toEqual([proseSegments(text)]);
  });
});
