import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations, repeatedLeanLocalNames } from '../../src/math/leanSource';
import { maskLeanComments, maskLeanCommentsAndStrings } from '../../src/math/leanSyntax';
import { mathConstructionHeader, mathConstructionImports } from '../../src/math/mathConstructionSources';
import { libraryForbiddenToken } from '../../src/math/libraryPacks';
import { solverMathlibImports, solverSourceContext } from '../../src/solver/sourceContext';

export type ResearchCandidateScopeInput = Readonly<{
  originalSource: string; baselineSource: string; candidateSource: string; targetName: string;
}>;

/** Add the trial's imports after any Lean module/prelude directives. */
export function withResearchLibraryImports(source: string, imports: readonly string[]): string {
  if (!imports.length) return source;
  const added = imports.map(name => `import ${name}\n`).join('');
  const { directivesEnd } = mathConstructionHeader(source);
  if (!directivesEnd) return added + source;
  const lineBreak = /^\r?\n/u.exec(source.slice(directivesEnd))?.[0];
  const offset = directivesEnd + (lineBreak?.length ?? 0);
  return source.slice(0, offset) + (lineBreak ? '' : '\n') + added + source.slice(offset);
}

const declarations = (source: string) => {
  const regions = new Map(inspectLeanDeclarationRegions(source).map(item => [item.startOffset, item]));
  return inspectScopedLeanDeclarations(source).map(item => ({ ...item, ...regions.get(item.startOffset)! }));
};
const declarationText = (source: string, region: ReturnType<typeof declarations>[number]) =>
  source.slice(source.lastIndexOf('\n', region.startOffset - 1) + 1, region.endOffset).trimEnd() + '\n';
const normalizedContext = (context: string) => maskLeanComments(context).split('\n').map(line => line.trim()
  .replace(/"(?:\\.|[^"\\])*"|[ \t]+/gu, token => token.startsWith('"') ? token : ' ')).filter(Boolean).join('\n');

/** Source-scope preflight only. A separate Lean check must establish the exact target's type and axiom safety. */
export function researchCandidateScopeReason({ originalSource, baselineSource, candidateSource, targetName }: ResearchCandidateScopeInput): string | undefined {
  const original = declarations(originalSource), baseline = declarations(baselineSource), candidate = declarations(candidateSource);
  const names = new Set(candidate.map(item => item.qualifiedName));
  if (names.size !== candidate.length || repeatedLeanLocalNames(candidate.map(item => item.qualifiedName)) !==
      repeatedLeanLocalNames(baseline.map(item => item.qualifiedName)))
    return '候选证明含重复或有歧义的声明名称，请保留基础声明的完整名称。';
  const requested = targetName.replace(/^_root_\./u, '');
  const targets = candidate.filter(item => item.qualifiedName === requested || !requested.includes('.') && item.name === requested);
  if (targets.length !== 1) return '候选证明缺少唯一的指定目标声明，请保留任务要求的名称与命名空间。';
  const target = targets[0]!;
  const originals = new Set(original.map(item => item.qualifiedName));
  const updated = new Map(candidate.map(item => [item.qualifiedName, item]));
  const inheritedAdmits: { start: number; end: number }[] = [];
  for (const before of baseline) {
    const after = updated.get(before.qualifiedName);
    if (!after || before.kind !== after.kind || before.declarationType !== after.declarationType)
      return `候选证明改变或删除了基础声明 ${before.qualifiedName} 的名称、参数或类型，请仅补充证明。`;
    if (before.qualifiedName === target.qualifiedName) continue;
    const unchanged = declarationText(baselineSource, before) === declarationText(candidateSource, after);
    if (originals.has(before.qualifiedName)) {
      if (!unchanged) return `候选证明改变了非目标原始声明 ${before.qualifiedName} 的证明，请保留基础源码中的完整声明。`;
      inheritedAdmits.push({ start: after.bodyOffset, end: after.endOffset });
    } else if (!unchanged && (!/^(?:theorem|lemma)\s/u.test(baselineSource.slice(before.startOffset, before.bodyOffset)) ||
        !/^(?:theorem|lemma)\s/u.test(candidateSource.slice(after.startOffset, after.bodyOffset))))
      return `候选证明改变了已有定义 ${before.qualifiedName} 的内容；仅可修补新增定理或引理的证明。`;
  }
  const imports = mathConstructionImports(baselineSource);
  const context = (source: string, anchors = original, prefix?: number) => normalizedContext(solverSourceContext(
    prefix === undefined ? source : source.slice(0, prefix), anchors, imports, solverMathlibImports(source)));
  if (context(baselineSource) !== context(candidateSource) || baseline.some(before => {
    const after = updated.get(before.qualifiedName)!;
    return context(baselineSource, [], before.startOffset) !== context(candidateSource, [], after.startOffset);
  })) return '候选证明改变了原有命名空间、section、变量、open、选项或导入上下文，请保留基础源码的作用域。';

  // Only inherited admissions in unchanged non-target original proof bodies are exempted.
  // All trust escapes and every admission in the target or solver-created declarations stay forbidden.
  const masked = maskLeanCommentsAndStrings(candidateSource).replace(
    /(?<![\p{L}\p{M}\p{N}_'])(sorry|admit)(?![\p{L}\p{M}\p{N}_'])/gu,
    (token: string, _name: string, offset: number) => inheritedAdmits.some(region => offset >= region.start && offset < region.end)
      ? ' '.repeat(token.length) : token);
  const forbidden = libraryForbiddenToken(masked);
  if (forbidden) return `候选证明含未完成证明或不允许的信任扩展：${forbidden.token}`;
  return undefined;
}
