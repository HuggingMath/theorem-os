export type PaperLanguage = 'en' | 'zh';

export type PaperFinding = { message: string; line?: number };
export type PaperDraft = {
  main: string;
  template: string;
  templateVersion: string;
  review: 'pending' | 'reviewed';
  findings: PaperFinding[];
};

export const paperTemplate = {
  version: 'article-v2',
  source: [
    '\\documentclass{article}',
    '\\usepackage{amsmath,amssymb,amsthm}',
    '',
    '\\newtheorem{theorem}{Theorem}',
    '\\newtheorem{lemma}[theorem]{Lemma}',
    '',
    '\\begin{document}',
    '\\input{main}',
    '\\end{document}',
    '',
  ].join('\n'),
};

export function paperStructureIssues(main: string): PaperFinding[] {
  const labels = new Set<string>();
  const references: { label: string; line: number }[] = [];
  const findings: PaperFinding[] = [];
  const stack: { name: string; line: number }[] = [];
  for (const [index, row] of main.split('\n').entries()) {
    const line = index + 1;
    // Read commands and escaped characters together, stopping at an unescaped comment.
    const code = /^(?:\\[^\n]|[^%\\])*/u.exec(row)?.[0] ?? '';
    for (const match of code.matchAll(/\\([a-zA-Z]+)(?![a-zA-Z])(?:\*?\s*\{([^{}\n]*)\})?|\\[^a-zA-Z]/gu)) {
      const [, command, arg] = match;
      if (!command) continue;
      if (/^(?:documentclass|usepackage|RequirePackage|PassOptionsToPackage|input|include|includeonly|includegraphics|bibliography|addbibresource|openin|openout|read|write|immediate|catcode|csname|directlua)$/u.test(command)
          || ((command === 'begin' || command === 'end') && arg === 'document')) {
        findings.push({ line, message: `Remove \\${command} from the document body.` });
      } else if (command === 'begin' && arg) {
        stack.push({ name: arg, line });
      } else if (command === 'end' && arg && stack.pop()?.name !== arg) {
        findings.push({ line, message: `Unmatched end of environment "${arg}".` });
      } else if (command === 'label' && arg) {
        if (labels.has(arg)) findings.push({ line, message: `Duplicate label "${arg}".` });
        labels.add(arg);
      } else if (arg && ['ref', 'eqref', 'pageref', 'autoref'].includes(command)) {
        references.push({ label: arg, line });
      }
    }
  }
  for (const entry of stack) findings.push({ line: entry.line, message: `Unclosed environment "${entry.name}".` });
  for (const { label, line } of references) if (!labels.has(label)) findings.push({ line, message: `Undefined reference "${label}".` });
  if (!main.trim() || /^\s*```/mu.test(main)) findings.push({ message: 'Return the LaTeX document body without Markdown fences.' });
  return findings;
}
