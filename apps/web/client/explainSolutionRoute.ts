import type { WebExplanationDocument, WebExplanationLines } from '../shared';
import type { SolutionRoute, SolutionRouteEdge, SolutionRouteNode, SolutionRouteSection } from '../solutionRoute';

/** The explanation must already be approved and bound to `proof` by the reader. No text is generated here. */
export function explanationSolutionRoute(document: WebExplanationDocument, proof: string, id = `explanation:${document.target}`): SolutionRoute {
  const label = (zh: string, en: string) => document.language === 'en' ? en : zh;
  const code = proof.replace(/\r\n?/gu, '\n').split('\n');
  const excerpt = (lines: readonly WebExplanationLines[]) => lines.map(range => code.slice(range.start - 1, range.end).join('\n')).filter(Boolean).join('\n\n');
  const section = (title: string, text: string | undefined, literal = false): SolutionRouteSection[] => text?.trim()
    ? [{ title, text, ...(literal ? { code: true } : {}) }] : [];
  const declaration = (index: number) => `declaration:${document.sections[index]!.name}`;
  const nodes: SolutionRouteNode[] = [{ id: 'problem', kind: 'problem', title: document.target, status: 'recorded', summary: document.problem?.original ?? document.overview,
    sections: [...section(label('原题', 'Problem'), document.problem?.original), ...section(label('证明思路', 'Proof overview'), document.overview)] }];
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
      sections: [...section(label('数学陈述', 'Mathematical statement'), item.statement),
        ...section(label('Lean 声明', 'Lean declaration'), excerpt([item.signature]), true),
        ...section(label('引用的结论', 'Cited results'), uses.join('\n'), true),
        ...section(label('陈述审阅', 'Statement review'), item.statementReviews.join('\n\n'))],
      source: { name: 'Submission.lean', line: item.lines.start, endLine: item.lines.end },
      action: { label: label('定位到证明', 'Locate in proof'), target: `section:${index}` },
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
      nodes.push({ id: childId, parentId: id, kind: 'derivation', title: label(`第 ${stepIndex + 1} 步`, `Step ${stepIndex + 1}`), status: 'recorded', summary: step.text,
        sections: [
          ...section(label('怎样推出来', 'Derivation'), step.text),
          ...section(label('这一步之前', 'Goals before'), goals?.before.join('\n\n'), true),
          ...(goals ? section(label('这一步之后', 'Goals after'), goals.afterCount === 0 ? label('这个目标已经证完。', 'This goal is closed.')
            : goals.after.join('\n\n') + (goals.afterCount > goals.after.length ? label(`\n另有 ${goals.afterCount - goals.after.length} 个目标`, `\n${goals.afterCount - goals.after.length} more goals`) : ''), true) : []),
          ...section(label('这一步使用的结论', 'Results used in this step'), step.uses.map(use => use.name).join('\n'), true),
          ...section(label('对应源码', 'Source for this step'), excerpt(step.lines), true),
          ...section(label('逐步审阅', 'Step review'), step.reviews.join('\n\n')),
        ],
        source: { name: 'Submission.lean', line: step.lines[0]?.start ?? item.lines.start, endLine: step.lines.at(-1)?.end ?? item.lines.end },
        action: { label: label('定位到这一步', 'Locate this step'), target: `step:${index}:${stepIndex}` },
      });
      connect(id, childId, 'evidence');
      if (stepIndex) connect(`derivation:${item.name}:${stepIndex - 1}`, childId, 'sequence');
      for (const use of step.uses) { const input = owner(use.name); if (input !== undefined && input !== index) connect(declaration(input), childId, 'reference'); }
    });
  });
  return { schema: 'theoremos.solution-route.v1', id, title: label('证明路线', 'Proof route'), locale: document.language, basis: 'explanation', nodes, edges,
    initial: document.sections.some(section => section.target) ? declaration(document.sections.findIndex(section => section.target)) : 'problem',
    ...(document.metrics.proofLines > document.metrics.explainedLines ? { partial: true } : {}) };
}
