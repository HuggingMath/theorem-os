import type { ResearchAssetRelease } from './researchAssetTypes';

export type ResearchReleaseChange = { name: string; kind: 'added' | 'removed' | 'changed'; before?: string; after?: string };
export type ResearchReleaseUsageField = 'conditions' | 'result' | 'title' | 'declaration' | 'type' | 'proof' | 'argumentNotes';
export type ResearchReleaseUsageChange = ResearchReleaseChange & { field: ResearchReleaseUsageField; exampleId?: string; exampleTitle?: string };
export type ResearchReleaseComparison = {
  assetId: string; from: string; to: string; name: string; releaseNotes?: string;
  declarations: ResearchReleaseChange[]; dependencies: ResearchReleaseChange[]; content: ResearchReleaseChange[];
  environment: { before?: string; after?: string; changed: boolean }; metadata: ResearchReleaseChange[];
  usage: ResearchReleaseUsageChange[];
};
function changes(before: Map<string, string>, after: Map<string, string>): ResearchReleaseChange[] {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(name => {
    const a = before.get(name), b = after.get(name);
    return a === b ? [] : [{ name, kind: a === undefined ? 'added' as const : b === undefined ? 'removed' as const : 'changed' as const,
      ...(a === undefined ? {} : { before: a }), ...(b === undefined ? {} : { after: b }) }];
  });
}
function usageFields(release: ResearchAssetRelease) {
  const fields = new Map<string, { value: string; field: ResearchReleaseUsageField; exampleId?: string; exampleTitle?: string }>();
  const usage = release.mathematics?.usage;
  for (const field of ['conditions', 'result'] as const) if (usage?.[field]) fields.set(field, { value: usage[field], field });
  for (const example of usage?.examples ?? []) for (const field of ['title', 'declaration', 'type', 'proof', 'argumentNotes'] as const)
    if (example[field]) fields.set(`examples.${example.id}.${field}`, { value: example[field], field, exampleId: example.id, exampleTitle: example.title });
  return fields;
}
/** Compare published records only; a different file path alone does not change a declaration's mathematical type. */
export function compareResearchReleases(before: ResearchAssetRelease, after: ResearchAssetRelease): ResearchReleaseComparison {
  if (before.assetId !== after.assetId || before.type !== after.type) throw new Error('Release comparison requires the same asset and type.');
  const declarations = (release: ResearchAssetRelease) => new Map((release.mathematics?.declarations ?? []).map(item => [item.name, item.type]));
  const dependencies = (release: ResearchAssetRelease) => {
    const counts = new Map<string, number>();
    for (const item of release.dependencies) counts.set(item.assetId, (counts.get(item.assetId) ?? 0) + 1);
    return new Map([
      ...release.dependencies.map(item => [counts.get(item.assetId) === 1 ? item.assetId : `${item.assetId}@${item.version}`,
        `${item.version}${item.digest ? '\n' + item.digest : ''}`] as const),
      ...(release.mathematics?.pack.requires ?? []).map(item => [`module: ${item.file}`, item.digest] as const),
    ]);
  };
  const environment = (release: ResearchAssetRelease) => release.mathematics ? `${release.mathematics.environment}\n${release.mathematics.environmentDigest}`
    : 'environment' in release.content ? release.content.environment : undefined;
  const content = (release: ResearchAssetRelease): Map<string, string> => {
    if (!release.mathematics) return new Map(Object.entries(release.content).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value, null, 2)]));
    const modules = release.mathematics.pack.modules;
    const counts = new Map<string, number>();
    for (const module of modules) counts.set(module.origin.file, (counts.get(module.origin.file) ?? 0) + 1);
    return new Map(modules.map(module => [counts.get(module.origin.file) === 1 ? module.origin.file
      : `${module.origin.file} (${module.file})`, module.source]));
  };
  const metadata = (release: ResearchAssetRelease) => new Map(['name', 'description', 'area', 'license', 'visibility'].map(key => [key, String(release[key as keyof ResearchAssetRelease] ?? '')]));
  const a = environment(before), b = environment(after), oldUsage = usageFields(before), newUsage = usageFields(after);
  const usage = changes(new Map([...oldUsage].map(([key, item]) => [key, item.value])), new Map([...newUsage].map(([key, item]) => [key, item.value])))
    .map(change => { const { value: _value, ...identity } = newUsage.get(change.name) ?? oldUsage.get(change.name)!; return { ...change, ...identity }; });
  return { assetId: before.assetId, from: before.version, to: after.version, name: after.name, releaseNotes: after.releaseNotes,
    declarations: changes(declarations(before), declarations(after)), dependencies: changes(dependencies(before), dependencies(after)),
    content: changes(content(before), content(after)), environment: { before: a, after: b, changed: a !== b },
    metadata: changes(metadata(before), metadata(after)), usage };
}
