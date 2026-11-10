import type { ResearchAsset } from '../researchAssetTypes';
import type { ResearchLibraryDiscovery } from '../researchLibraryDiscoveryTypes';

const generic = new Set(['theorem', 'lemma', 'proof', 'prove', 'show', 'have', 'true', 'false', 'forall', 'exists', 'prop', 'type', 'by', 'the', 'for', 'and', 'with', 'that', 'this', 'from', 'using', 'sorry', 'mathbb', 'operatorname', 'in']);
export function libraryDiscoveryTerms(value: string): string[] {
  const terms = value.match(/[A-Za-z_][A-Za-z0-9_'.]*|[\p{Script=Han}]{2,}/gu) ?? [];
  const seen = new Set<string>();
  return terms.filter(term => term.length > 1 && term.length <= 60 && !generic.has(term.toLocaleLowerCase())
    && !seen.has(term.toLocaleLowerCase()) && Boolean(seen.add(term.toLocaleLowerCase()))).slice(0, 10);
}
export function discoverySuggestedTerms(target: ResearchLibraryDiscovery): string[] {
  return libraryDiscoveryTerms([target.type, target.title, target.objective, ...target.premises].join(' '));
}
export type LibraryDiscoveryMatch = { asset: ResearchAsset; terms: string[]; declarations: string[]; sameEnvironment: boolean; score: number };
/** Rank literal matches only; independent candidate checks remain the authority for applicability. */
export function matchLibraryDiscovery(asset: ResearchAsset, target: ResearchLibraryDiscovery, terms: readonly string[]): LibraryDiscoveryMatch {
  const declarations = asset.release?.mathematics?.declarations ?? [];
  const text = [asset.name, asset.description, asset.area, asset.release?.mathematics?.usage?.conditions,
    asset.release?.mathematics?.usage?.result, ...declarations.map(item => `${item.name} ${item.type}`)].join(' ').toLocaleLowerCase();
  const matched = terms.filter(term => text.includes(term.toLocaleLowerCase()));
  const names = declarations.filter(item => matched.some(term => `${item.name} ${item.type}`.toLocaleLowerCase().includes(term.toLocaleLowerCase()))).map(item => item.name);
  const sameEnvironment = asset.release?.mathematics?.environment === target.environment;
  return { asset, terms: matched, declarations: names, sameEnvironment, score: matched.length * 2 + Math.min(names.length, 3) };
}
