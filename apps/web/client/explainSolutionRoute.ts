import { translator } from '../i18n';
import type { WebExplanationDocument, WebExplanationLines } from '../shared';
import type { SolutionRoute, SolutionRouteEdge, SolutionRouteNode, SolutionRouteSection } from '../solutionRoute';

/** The explanation must already be approved and bound to `proof` by the reader. No text is generated here. */
export function explanationSolutionRoute(document: Pick<WebExplanationDocument, 'target' | 'language' | 'overview' | 'sections' | 'metrics'> & {
  problem?: Pick<NonNullable<WebExplanationDocument['problem']>, 'original'> }, proof: string, id = `explanation:${document.target}`): SolutionRoute {
  const t = translator(document.language);
  const code = proof.replace(/\r\n?/gu, '\n').split('\n');
  const excerpt = (lines: readonly WebExplanationLines[]) => lines.map(range => code.slice(range.start - 1, range.end).join('\n')).filter(Boolean).join('\n\n');
  const section = (title: string, text: string | undefined, literal = false): SolutionRouteSection[] => text?.trim()
    ? [{ title, text, ...(literal ? { code: true } : {}) }] : [];
  const declaration = (index: number) => `declaration:${document.sections[index]!.name}`;
  const nodes: SolutionRouteNode[] = [{ id: 'problem', kind: 'problem', title: document.target, status: 'recorded', summary: document.problem?.original ?? document.overview,
    sections: [...section(t('原题'), document.problem?.original), ...section(t('证明思路'), document.overview)] }];
  const edges: SolutionRouteEdge[] = [];
  const connect = (from: string, to: string, kind: SolutionRouteEdge['kind']) => {
    if (from !== to && !edges.some(edge => edge.from === from && edge.to === to && edge.kind === kind)) edges.push({ from, to, kind });
  };
  const names = new Map(document.sections.map((section, index) => [section.name, index]));
  const owner = (name: string) => {
    const exact = names.get(name);
    if (exact !== undefined) return exact;
    const matches = document.sections.flatMap((section, index) => section.name.endsWith(`.${name}`) || name.endsWith(`.${section.name}`) ? [index] : []);
    return matches.length === 1 ? matches[0] : undefined;
  };
  document.sections.forEach((item, index) => {
    const id = declaration(index), uses = [...new Set(item.steps.flatMap(step => step.uses.map(use => use.name)))];
    nodes.push({ id, kind: item.target ? 'proof' : 'declaration', title: item.title || item.name, status: 'recorded', summary: item.statement,
      sections: [...section(t('数学陈述'), item.statement),
        ...section(t('Lean 声明'), excerpt([item.signature]), true),
        ...section(t('引用的结论'), uses.join('\n'), true),
        ...section(t('陈述审阅'), item.statementReviews.join('\n\n'))],
      source: { name: 'Submission.lean', line: item.lines.start, endLine: item.lines.end },
      action: { label: t('定位到证明'), target: `section:${index}` },
    });
    let dependencies = 0;
    for (const use of uses) {
      const input = owner(use);
      if (input === undefined || input === index) continue;
      connect(declaration(input), id, 'dependency'); dependencies++;
    }
    if (!dependencies) connect('problem', id, 'sequence');
    item.steps.forEach((step, stepIndex) => {
      const childId = `derivation:${item.name}:${stepIndex}`, goals = step.goals;
      nodes.push({ id: childId, parentId: id, kind: 'derivation', title: t('第 {0} 步', stepIndex + 1), status: 'recorded', summary: step.text,
        sections: [
          ...section(t('怎样推出来'), step.text),
          ...section(t('这一步之前'), goals?.before.join('\n\n'), true),
          ...(goals ? section(t('这一步之后'), goals.afterCount === 0 ? t('这个目标已经证完。')
            : goals.after.join('\n\n') + (goals.afterCount > goals.after.length ? '\n' + t('另有 {0} 个目标', goals.afterCount - goals.after.length) : ''), true) : []),
          ...section(t('这一步使用的结论'), step.uses.map(use => use.name).join('\n'), true),
          ...section(t('对应源码'), excerpt(step.lines), true),
          ...section(t('逐步审阅'), step.reviews.join('\n\n')),
        ],
        source: { name: 'Submission.lean', line: step.lines[0]?.start ?? item.lines.start, endLine: step.lines.at(-1)?.end ?? item.lines.end },
        action: { label: t('定位到这一步'), target: `step:${index}:${stepIndex}` },
      });
      connect(id, childId, 'evidence');
      if (stepIndex) connect(`derivation:${item.name}:${stepIndex - 1}`, childId, 'sequence');
      for (const use of step.uses) { const input = owner(use.name); if (input !== undefined && input !== index) connect(declaration(input), childId, 'reference'); }
    });
  });
  return { schema: 'theoremos.solution-route.v1', id, title: t('证明路线'), locale: document.language, basis: 'explanation', nodes, edges,
    initial: document.sections.some(section => section.target) ? declaration(document.sections.findIndex(section => section.target)) : 'problem',
    ...(document.metrics.proofLines > document.metrics.explainedLines ? { partial: true } : {}) };
}
