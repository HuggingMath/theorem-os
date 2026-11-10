import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { inspectScopedLeanDeclarations } from '../../src/math/leanSource';
import { libraryForbiddenToken, libraryPackDigest, parseLibraryPack } from '../../src/math/libraryPacks';
import { maskLeanCommentsAndStrings } from '../../src/math/leanSyntax';
import type { ResolvedResearchMathematics } from './researchAssets';
import type { ResearchCheckedMathExample, ResearchMathExample, ResearchMathExampleReceipt } from './researchAssetTypes';
import type { WebRunner } from './runner';
import { leanDiagnostics } from './precheck';
import { WebStorage, WebStorageError } from './storage';

/** A host-owned standalone goal; author input cannot replace imports or introduce extra declarations. */
export function researchMathExampleSource(material: ResolvedResearchMathematics, example: ResearchMathExample) {
  if (!material.declarations.some(item => item.name === example.declaration)) throw new WebStorageError(400, '调用示例必须选择本成果中的数学声明。');
  const name = `TheoremOSLibraryExample_${mathDigest(example.id).slice(0, 20)}`;
  const imports = material.pack.modules.map(item => `import ${item.file.slice(0, -5).replaceAll('/', '.')}`).join('\n');
  const source = `${imports}\n\ntheorem ${name} : ${example.type.trim()} := ${example.proof.trim()}\n`;
  const declarations = inspectScopedLeanDeclarations(source);
  const declaration = declarations.length === 1 ? declarations[0] : undefined;
  if (!declaration || declaration.qualifiedName !== name || declaration.kind !== 'theorem'
      || libraryForbiddenToken(maskLeanCommentsAndStrings(source)))
    throw new WebStorageError(400, '调用示例只能包含完整目标类型和证明体，不能加入其他声明、未完成证明或信任扩展。');
  const references = maskLeanCommentsAndStrings(example.proof).match(/[\p{L}_][\p{L}\p{M}\p{N}_'?!]*(?:\.[\p{L}_][\p{L}\p{M}\p{N}_'?!]*)*/gu) ?? [];
  if (!references.some(token => token.replace(/^_root_\./u, '') === example.declaration.replace(/^_root_\./u, '')))
    throw new WebStorageError(400, '调用示例的证明体需要使用所选声明的完整 Lean 名称。');
  return { source, name };
}
export function researchMathExampleValidator(storage: WebStorage, runner: WebRunner) {
  return async (material: ResolvedResearchMathematics, example: ResearchMathExample, signal: AbortSignal): Promise<ResearchCheckedMathExample> => {
    if (!runner.check) throw new WebStorageError(503, '当前服务暂不提供数学调用示例的独立检查。');
    signal.throwIfAborted();
    const pack = parseLibraryPack(material.pack), { source, name } = researchMathExampleSource(material, example);
    const result = await runner.check({ environment: material.environment, source, libraryPack: pack,
      candidateTarget: { name, expectedType: example.type.trim() } }, signal);
    signal.throwIfAborted();
    const diagnostics = leanDiagnostics(result.output);
    const passed = result.exitCode === 0 && !result.timedOut && !diagnostics.errors && !diagnostics.sorries && result.checkedTarget === name;
    const receipt: ResearchMathExampleReceipt = { schema: 'theorem-os.research-library-example-check.v1', exampleId: example.id,
      declaration: example.declaration, sourceDigest: mathDigest(source), libraryPackDigest: libraryPackDigest(pack),
      environment: material.environment, environmentDigest: material.environmentDigest, checkedDeclaration: name, passed,
      exitCode: result.exitCode, timedOut: result.timedOut, diagnostics: diagnostics.diagnostics, checkedAt: new Date().toISOString() };
    const receiptId = mathDigest(canonicalMathJson(receipt));
    storage.saveRecord(['research', 'checks', `${receiptId}.json`], receipt, true);
    if (!passed) throw new WebStorageError(400, result.timedOut ? '数学调用示例检查超时，尚未发布。'
      : diagnostics.diagnostics.find(item => item.severity === 'error')?.message ?? '数学调用示例未通过目标及证明依赖的独立检查，尚未发布。');
    return { ...example, source, sourceDigest: receipt.sourceDigest, check: { receiptId, receipt } };
  };
}
