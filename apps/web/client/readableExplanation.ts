import type { WebExplanationLanguage, WebExplanationSection } from '../shared';

// Saved explanations sometimes print an explicitly typed scalar coefficient as Lean does. Only the ordinary
// rational, real and complex numeral casts have an unambiguous reading here. Keep grouping on composite operands.
const numericScalar = /(`+)[\s\S]*?\1|\(\s*(\d+)\s*:\s*(?:[ℚℝℂ]|\\mathbb\s*(?:\{\s*[QRC]\s*\}|[QRC]))\s*\)\s*(?:\\bullet\b|•)\s*(?=\()(?:\(([A-Z]+)\)(?!\s*[\^_′'²³⁰-⁹₀-₉]))?/gu;

export function normalizeExplanationNotation(text: string): string {
  return text.replace(numericScalar, (source, code: string | undefined, number: string, factors?: string) =>
    code ? source : number + (factors ?? ''));
}

// An older writer may alternate between a description and its Lean name. Reuse the description the same section
// already gives rather than trying to infer what a bare Lean variable means.
const literal = /(`+)[\s\S]*?\1|(?<!\\)\$\$[\s\S]*?\$\$|(?<!\\)\$(?:\\.|[^$\\\n])*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/u;
const namedCondition = String.raw`[ \t]+(\x60?)(h[A-Za-z\d_']*)\3(?![A-Za-z\d_'\x60])`;
const chineseLabel = new RegExp(literal.source + '|(迹条件|维数条件|交换条件|交换性|假设|条件|等式|不等式|结论)'
  + namedCondition + String.raw`(?![ \t]*(?:是|为|表示|代表))([ \t]+说)?`, 'gu');
// Unquoted English aliases are limited to common Lean spellings: ordinary phrases such as "the condition holds" stay intact.
const englishAlias = String.raw`[ \t]+(\x60?)(h(?:[A-Z\d_'][A-Za-z\d_']*|trace|dim|finrank)?)\3(?![A-Za-z\d_'\x60])`;
const englishLabel = new RegExp(literal.source
  + String.raw`|\b([Tt]race condition|[Dd]imension condition|[Cc]ommutation condition|[Aa]ssumption|[Cc]ondition|[Ii]nequality|[Ii]dentity|[Ee]quality|[Cc]onclusion)`
  + englishAlias + String.raw`(?![ \t]+(?:is|represents)\b)`, 'gu');
const savedProseAlias = new RegExp(literal.source + String.raw`|(?<![A-Za-z\d_'.])(h[A-Za-z\d_']+)(?![A-Za-z\d_'])`, 'gu');
const dimensionEquality = /^(h[A-Za-z\d_']*) : Module\.finrank [^\n]+ = [^\n]+$/gmu;

export function readableExplanationSteps(section: Pick<WebExplanationSection, 'statement' | 'steps'>,
  language: WebExplanationLanguage): string[] {
  const label = language === 'zh' ? chineseLabel : englishLabel;
  const descriptions = new Map<string, string>();
  for (const text of [section.statement, ...section.steps.map(step => step.text)]) {
    for (const [, , description, , name] of text.matchAll(label)) {
      if (!name || !description) continue;
      const previous = descriptions.get(name);
      if (!previous || description.length > previous.length) descriptions.set(name, description);
    }
  }
  // Lean also records which local names stand for a dimension equality, even when the prose only gives its name.
  for (const { goals } of section.steps) for (const goal of goals?.before ?? []) {
    for (const [, name] of goal.matchAll(dimensionEquality))
      if (name && !descriptions.has(name)) descriptions.set(name, language === 'zh' ? '维数等式' : 'dimension equality');
  }
  return section.steps.map(step => {
    const text = normalizeExplanationNotation(step.text).replace(label, (raw, _code, description?: string) => {
      if (!description) return raw;
      if (language === 'zh' && description === '假设' && /[ \t]说$/u.test(raw)) return '由题设可知，';
      return description;
    });
    return text.replace(savedProseAlias, (raw, _code, name: string | undefined) => name ? descriptions.get(name) ?? raw : raw);
  });
}
