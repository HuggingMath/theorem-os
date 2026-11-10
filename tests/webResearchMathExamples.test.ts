import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebStorage } from '../apps/web/storage';
import { WebResearchAssets, type ResolvedResearchMathematics } from '../apps/web/researchAssets';
import { researchMathExampleSource, researchMathExampleValidator } from '../apps/web/researchMathExamples';
import type { ResearchMathExample, ResearchMathUsage } from '../apps/web/researchAssetTypes';
import type { WebRunner } from '../apps/web/runner';
import type { WebPrecheckOutput, WebPrecheckRunner } from '../apps/web/precheck';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { libraryPackDigest } from '../src/math/libraryPacks';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';

const owner = 'account:math-examples', commit = 'a'.repeat(40);
const material: ResolvedResearchMathematics = { environment: 'standard', environmentDigest: getLeanTaskEnvironment('standard').dependencyDigest,
  declarations: [{ name: 'Shared.zero', type: '(n : Nat) : n + 0 = n', file: 'Submission/Library/Shared.lean' }],
  pack: { schema: 'theorem-os.library-pack.v1', modules: [{ file: 'Submission/Library/Shared.lean',
    source: 'namespace Shared\ntheorem zero (n : Nat) : n + 0 = n := by simp\nend Shared\n',
    origin: { kind: 'run', runId: 'publication-fixture', commit, file: 'Main.lean' } }] } };
const example: ResearchMathExample = { id: 'addition', title: 'Quantified addition identity', declaration: 'Shared.zero',
  type: '∀ n : Nat, n + 0 = n', proof: 'by\n  intro n\n  exact Shared.zero n', argumentNotes: 'n is an arbitrary natural number.' };
const usage: ResearchMathUsage = { conditions: 'For $n \\in \\mathbb{N}$.', result: 'Conclude $n + 0 = n$.', examples: [example] };
const services: WebResearchAssets[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); });
function setup() {
  const storage = new WebStorage(), calls: Parameters<WebPrecheckRunner>[0][] = [];
  let outcome = async (input: Parameters<WebPrecheckRunner>[0]): Promise<WebPrecheckOutput> => ({ output: '', exitCode: 0, timedOut: false, checkedTarget: input.candidateTarget?.name });
  const runner: WebRunner = { readiness: vi.fn(), run: vi.fn(), command: vi.fn(), check: async input => {
    calls.push(structuredClone(input)); return outcome(input);
  } };
  const validate = researchMathExampleValidator(storage, runner);
  const assets = new WebResearchAssets(storage, { async resolveMathematics() { return structuredClone(material); },
    async validateMathematics() { return { passed: true, receiptRefs: ['main-publication-check'] }; }, validateMathematicsExample: validate });
  services.push(assets);
  return { storage, assets, runner, calls, validate, outcome: (value: typeof outcome) => { outcome = value; } };
}
function create(fixture: ReturnType<typeof setup>, value = usage, requestId = 'create') {
  return fixture.assets.create(owner, { requestId, type: 'mathematics', name: 'Addition identity',
    content: { source: { kind: 'run', runId: 'publication-fixture', commit }, usage: value } });
}
async function publish(fixture: ReturnType<typeof setup>, asset: ReturnType<typeof create>, version = 'v1') {
  const preview = await fixture.assets.preview(owner, asset.id), queued = await fixture.assets.publish(owner, asset.id, {
    requestId: `publish-${version}`, expectedRevision: asset.revision, previewDigest: preview.previewDigest, version, license: 'MIT', visibility: 'public',
  });
  return fixture.assets.waitForPublication(owner, queued.id);
}

describe('published mathematical invocation examples', () => {
  it('keeps save and preview free of compilation, then checks each host-owned example in the fixed environment', async () => {
    const fixture = setup(), second = { ...example, id: 'specific', title: 'A specific number', type: '7 + 0 = 7', proof: 'by\n  exact Shared.zero 7' };
    const asset = create(fixture, { ...usage, examples: [example, second] }), preview = await fixture.assets.preview(owner, asset.id);
    expect(preview.mathematicsUsage?.examples).toEqual([example, second]); expect(preview.validation).toBe('not-run'); expect(fixture.calls).toEqual([]);
    expect((await publish(fixture, asset)).status).toBe('completed'); expect(fixture.calls).toHaveLength(2);
    const release = fixture.assets.release(owner, asset.id, 'v1'), checked = release.mathematics!.usage!;
    expect(checked.conditions).toBe(usage.conditions); expect(checked.result).toBe(usage.result);
    for (const [index, item] of checked.examples.entries()) {
      const authored = [example, second][index], host = researchMathExampleSource(material, authored);
      expect(fixture.calls[index]).toMatchObject({ source: host.source, environment: 'standard', libraryPack: material.pack,
        candidateTarget: { name: host.name, expectedType: authored.type } });
      expect(item.sourceDigest).toBe(mathDigest(host.source));
      expect(item.check.receiptId).toBe(mathDigest(canonicalMathJson(item.check.receipt)));
      expect(item.check.receipt).toMatchObject({ exampleId: authored.id, declaration: authored.declaration,
        checkedDeclaration: host.name, environmentDigest: material.environmentDigest, libraryPackDigest: libraryPackDigest(material.pack), passed: true });
      expect(fixture.storage.getRecord(['research', 'checks', `${item.check.receiptId}.json`])).toEqual(item.check.receipt);
    }
    expect(fixture.runner.run).not.toHaveBeenCalled(); expect(fixture.runner.command).not.toHaveBeenCalled();
  });

  it('binds preview identity to usage and keeps published descriptions, examples and receipts immutable after edits', async () => {
    const fixture = setup(), asset = create(fixture), first = await fixture.assets.preview(owner, asset.id);
    expect((await publish(fixture, asset)).status).toBe('completed');
    const release = fixture.assets.release(owner, asset.id, 'v1');
    const changed = fixture.assets.update(owner, asset.id, { requestId: 'edit', expectedRevision: fixture.assets.get(owner, asset.id).revision,
      content: { source: { kind: 'run', runId: 'publication-fixture', commit }, usage: { ...usage, result: 'Edited result', examples: [{ ...example, argumentNotes: 'Edited mapping' }] } } });
    const next = await fixture.assets.preview(owner, changed.id); expect(next.previewDigest).not.toBe(first.previewDigest);
    expect(fixture.calls).toHaveLength(1); expect(fixture.assets.release(owner, asset.id, 'v1')).toEqual(release);
    expect((await publish(fixture, changed, 'v2')).status).toBe('completed'); expect(fixture.calls).toHaveLength(2);
    expect(fixture.assets.release(owner, asset.id, 'v2').mathematics!.usage!.result).toBe('Edited result');
    const fork = fixture.assets.fork(owner, asset.id, { requestId: 'fork', version: 'v1' });
    expect((await publish(fixture, fork)).status).toBe('completed'); expect(fixture.calls).toHaveLength(3);
    expect(fixture.assets.release(owner, fork.id, 'v1').mathematics!.usage!.examples[0].proof).toBe(example.proof);
  });

  it.each([
    { output: '', exitCode: 0, timedOut: false },
    { output: '', exitCode: 0, timedOut: true, checkedTarget: 'fixed' },
    { output: '', exitCode: 1, timedOut: false, checkedTarget: 'fixed' },
    { output: JSON.stringify({ severity: 'error', pos: { line: 5, column: 2 }, data: 'Wrong argument type' }), exitCode: 0, timedOut: false, checkedTarget: 'fixed' },
    { output: JSON.stringify({ severity: 'warning', pos: { line: 5, column: 2 }, kind: 'hasSorry', data: "declaration uses 'sorry'" }), exitCode: 0, timedOut: false, checkedTarget: 'fixed' },
  ] as WebPrecheckOutput[])('does not create a release from incomplete or failing check evidence (%j)', async result => {
    const fixture = setup(), asset = create(fixture);
    fixture.outcome(async input => ({ ...result, ...(result.checkedTarget ? { checkedTarget: input.candidateTarget?.name } : {}) }));
    expect((await publish(fixture, asset)).status).toBe('failed'); expect(fixture.assets.get(owner, asset.id).releases).toEqual([]);
    expect(() => fixture.assets.release(owner, asset.id, 'v1')).toThrow();
  });

  it.each([
    { proof: 'by sorry' }, { proof: 'by admit' }, { proof: 'by trivial\naxiom extra : False' },
    { proof: 'by trivial\ntheorem extra : True := by trivial' },
    { proof: 'by\n  -- Shared.zero\n  simp' }, { proof: 'by simp' }, { declaration: 'Other.zero' },
  ])('rejects added trust, incomplete proofs and examples that do not name the chosen declaration (%j)', async patch => {
    const fixture = setup(), asset = create(fixture, { ...usage, examples: [{ ...example, ...patch }] });
    expect((await publish(fixture, asset)).status).toBe('failed'); expect(fixture.calls).toEqual([]);
    expect(fixture.assets.get(owner, asset.id).releases).toEqual([]);
  });

  it('rejects duplicate example identities and requires an independent example checker', async () => {
    const fixture = setup(), asset = create(fixture, { ...usage, examples: [example, { ...example, title: 'Another' }] });
    expect((await publish(fixture, asset)).status).toBe('failed'); expect(fixture.assets.get(owner, asset.id).releases).toEqual([]);
    const unavailable = new WebResearchAssets(new WebStorage(), { async resolveMathematics() { return material; },
      async validateMathematics() { return { passed: true, receiptRefs: ['main-check'] }; } });
    services.push(unavailable);
    const asset2 = unavailable.create(owner, { requestId: 'missing-validator', type: 'mathematics', name: 'Addition',
      content: { source: { kind: 'run', runId: 'publication-fixture', commit }, usage } });
    const preview = await unavailable.preview(owner, asset2.id), queued = await unavailable.publish(owner, asset2.id, {
      requestId: 'publish-missing', expectedRevision: asset2.revision, previewDigest: preview.previewDigest, license: 'MIT', visibility: 'public' });
    expect(await unavailable.waitForPublication(owner, queued.id)).toMatchObject({ status: 'failed', reason: expect.stringContaining('独立检查') });
  });
});
