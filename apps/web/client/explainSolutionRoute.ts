import { translator } from '../i18n';
import type { WebExplanationDocument, WebExplanationLines, WebExplanationSection } from '../shared';
import type { SolutionRoute, SolutionRouteEdge, SolutionRouteNode, SolutionRouteOrigin, SolutionRouteSection } from '../solutionRoute';
import { maskLeanCommentsAndStrings } from '../../../src/math/leanSyntax';

const STANDARD_AXIOMS = new Set(['propext', 'Classical.choice', 'Quot.sound']);
// For explanations saved without Lean's terms: a decision tactic written in the proof body, not what Lean elaborated.
const COMPUTED = /(?<![\p{L}\p{N}_.'])(?:native_decide|bv_decide|decide)(?![\p{L}\p{N}_.'])/u;
const MAX_STAGES = 5, MAX_LIBRARY = 60;

/** The explanation must already be approved and bound to `proof` by the reader. No text is generated here. */
export function explanationSolutionRoute(document: Pick<WebExplanationDocument, 'target' | 'language' | 'overview' | 'sections' | 'metrics'> & {
  axioms?: readonly string[]; route?: WebExplanationDocument['route']; library?: WebExplanationDocument['library'];
  problem?: Pick<NonNullable<WebExplanationDocument['problem']>, 'original'> & Partial<Pick<NonNullable<WebExplanationDocument['problem']>, 'correspondences'>> },
  proof: string, id = `explanation:${document.target}`): SolutionRoute {
  const t = translator(document.language);
  const code = proof.replace(/\r\n?/gu, '\n').split('\n');
  const excerpt = (lines: readonly WebExplanationLines[]) => lines.map(range => code.slice(range.start - 1, range.end).join('\n')).filter(Boolean).join('\n\n');
  const section = (title: string, text: string | undefined, literal = false, detail = false): SolutionRouteSection[] => text?.trim()
    ? [{ title, text, ...(literal ? { code: true } : {}), ...(detail ? { detail: true } : {}) }] : [];
  const declaration = (index: number) => `declaration:${document.sections[index]!.name}`;
  // With `library` the page read Lean's terms, and a section's `computed` says how Lean decided it.
  const elaborated = document.library !== undefined;
  const written = (item: WebExplanationSection) => {
    if (item.kind !== 'theorem') return false;
    const text = maskLeanCommentsAndStrings(excerpt([item.lines])), body = text.indexOf(':=');
    return COMPUTED.test(body < 0 ? text : text.slice(body));
  };
  const computed = (item: WebExplanationSection) => elaborated ? item.computed !== undefined : written(item);
  const origin = (item: WebExplanationSection): SolutionRouteOrigin => item.target ? 'target' : item.kind === 'axiom' ? 'given'
    : item.kind !== 'theorem' ? 'definition' : computed(item) ? 'computation' : 'lemma';
  const how = (item: WebExplanationSection) => item.computed === 'compiled' ? t('Lean 用编译后的程序求值判定（native_decide），内核信任编译器的结果。')
    : item.computed === 'kernel' ? t('Lean 内核直接求值判定（decide）。') : computed(item) ? t('证明里写了判定策略（按源码文字识别）。') : undefined;
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
  const inputs = document.sections.map(() => new Set<number>());
  // Library results a step cites by name, with the declarations citing each.
  const cited = new Map<string, number[]>();
  document.sections.forEach((item, index) => {
    const id = declaration(index), uses = [...new Set(item.steps.flatMap(step => step.uses.map(use => use.name)))];
    const own = uses.filter(use => owner(use) !== undefined), library = uses.filter(use => owner(use) === undefined);
    for (const name of library) cited.set(name, [...cited.get(name) ?? [], index]);
    nodes.push({ id, kind: item.target ? 'proof' : 'declaration', origin: origin(item), title: item.title || item.name, status: 'recorded', summary: item.summary ?? item.statement,
      sections: [...section(t('一句话概要'), item.summary), ...section(t('数学陈述'), item.statement),
        ...section(t('Lean 声明'), excerpt([item.signature]), true),
        ...section(t('由计算判定'), how(item)),
        ...section(t('引用的结论'), own.join('\n'), true),
        ...section(t('引用的库结论'), library.join('\n'), true),
        ...section(t('陈述审阅'), item.statementReviews.join('\n\n'), false, true)],
      source: { name: 'Submission.lean', line: item.lines.start, endLine: item.lines.end },
      action: { label: t('定位到证明'), target: `section:${index}` },
    });
    for (const use of own) {
      const input = owner(use)!;
      if (input === index) continue;
      connect(declaration(input), id, 'dependency'); inputs[index]!.add(input);
    }
    if (!inputs[index]!.size) connect('problem', id, 'sequence');
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
          ...section(t('逐步审阅'), step.reviews.join('\n\n'), false, true),
        ],
        source: { name: 'Submission.lean', line: step.lines[0]?.start ?? item.lines.start, endLine: step.lines.at(-1)?.end ?? item.lines.end },
        action: { label: t('定位到这一步'), target: `step:${index}:${stepIndex}` },
      });
      connect(id, childId, 'evidence');
      if (stepIndex) connect(`derivation:${item.name}:${stepIndex - 1}`, childId, 'sequence');
      for (const use of step.uses) { const input = owner(use.name); if (input !== undefined && input !== index) connect(declaration(input), childId, 'reference'); }
    });
  });
  // Cited library results become nodes of their own, the most cited first; the view keeps them hidden until asked for.
  const elaboratedUsers = new Map((document.library ?? []).map(item => [item.name, item.usedBy]));
  for (const [name, users] of [...cited].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_LIBRARY)) {
    const others = (elaboratedUsers.get(name) ?? []).filter(user => !users.some(index => document.sections[index]!.name === user));
    nodes.push({ id: `library:${name}`, kind: 'declaration', origin: 'library', title: name, status: 'recorded',
      summary: t('{0} 个声明的讲解引用了它', users.length),
      sections: [...section(t('引用它的声明'), users.map(index => document.sections[index]!.name).join('\n'), true),
        ...section(t('Lean 的证明项里还用到它的声明'), others.join('\n'), true)] });
    for (const index of users) connect(`library:${name}`, declaration(index), 'reference');
  }
  const target = document.sections.findIndex(section => section.target);
  // The main line: the route the writer gave and the auditors checked, or else the longest chain of own declarations
  // that ends at the target, read from the cited names.
  const depth = new Map<number, number>(), visiting = new Set<number>();
  const measure = (index: number): number => {
    const known = depth.get(index);
    if (known !== undefined) return known;
    if (visiting.has(index)) return 0;
    visiting.add(index);
    const value = 1 + Math.max(0, ...[...inputs[index]!].map(measure));
    visiting.delete(index); depth.set(index, value);
    return value;
  };
  const line: number[] = [];
  let at: number | undefined = target >= 0 ? target : undefined;
  while (at !== undefined) {
    line.unshift(at);
    at = [...inputs[at]!].filter(index => !line.includes(index)).sort((a, b) => measure(b) - measure(a) || a - b)[0];
  }
  const audited = document.route?.flatMap(step => {
    const members = step.declarations.flatMap(name => names.has(name) ? [names.get(name)!] : []);
    return members.length ? [{ title: members.slice(0, 3).map(index => document.sections[index]!.name).join(', ') + (members.length > 3 ? ' …' : ''),
      summary: step.claim, nodeIds: members.map(declaration) }] : [];
  });
  const stages = audited?.length ? audited : line.length >= 2 ? line.slice(-MAX_STAGES).map(index => {
    const item = document.sections[index]!;
    return { title: item.title || item.name, summary: item.summary ?? item.statement, nodeIds: [declaration(index)] };
  }) : undefined;
  const axioms = document.axioms;
  const checked = axioms === undefined ? undefined : !axioms.length ? t('目标定理已通过 Lean 检查，不依赖 sorry，也不依赖任何公理。')
    : axioms.every(name => STANDARD_AXIOMS.has(name)) ? t('目标定理已通过 Lean 检查，不依赖 sorry。依赖的公理：{0}（均为 Lean 标准公理）。', axioms.join(', '))
      : t('目标定理已通过 Lean 检查，不依赖 sorry。依赖的公理：{0}。', axioms.join(', '));
  const decided = document.sections.filter(item => computed(item)).map(item => item.computed === 'compiled' ? `${item.name}  (native_decide)`
    : item.computed === 'kernel' ? `${item.name}  (decide)` : item.name);
  // How the reviewers of the formalization matched the original problem to the Lean statement, when the proof has one.
  const matched = document.problem?.correspondences ?? [], tally = (relation: typeof matched[number]['relation']) => matched.filter(item => item.relation === relation).length;
  const bridge = !matched.length ? undefined : t('形式化的审核模型逐项对照了原题和 Lean 陈述：{0}。', [
    ...(tally('direct') ? [t('{0} 处直接对应', tally('direct'))] : []), ...(tally('equivalent') ? [t('{0} 处是等价的改写', tally('equivalent'))] : []),
    ...(tally('unresolved') ? [t('{0} 处未能确认', tally('unresolved'))] : []), ...(tally('mismatch') ? [t('{0} 处不一致', tally('mismatch'))] : []),
  ].join(t('，')));
  return { schema: 'theoremos.solution-route.v1', id, title: t('证明路线'), locale: document.language, basis: 'explanation', nodes, edges,
    overview: [...section(t('要证明什么'), document.problem?.original ?? document.sections[target]?.statement),
      ...section(t('Lean 陈述'), target >= 0 ? excerpt([document.sections[target]!.signature]) : undefined, true),
      ...section(t('原题与 Lean 陈述的对应'), bridge),
      ...section(t('证明思路'), document.overview),
      ...section(elaborated ? t('由计算判定的声明（依据 Lean 的证明项）') : t('由计算判定的声明'), decided.join('\n'), true),
      ...section(t('验证状态'), checked)],
    ...(stages ? { stages } : {}),
    initial: target >= 0 ? document.sections[target]!.steps.length ? `derivation:${document.sections[target]!.name}:0` : declaration(target) : 'problem',
    ...(document.metrics.proofLines > document.metrics.explainedLines ? { partial: true } : {}) };
}
