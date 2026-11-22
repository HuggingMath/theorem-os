import fs from 'node:fs';
import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { personalExpertDigestSchema, personalExpertSchema, type FrozenPersonalExpert } from './personalExpertSchema';

const cards = z.array(personalExpertSchema).max(32).refine(items =>
  new Set(items.map(item => item.assetId)).size === items.length, 'duplicate expert asset ID');
const byAsset = (a: FrozenPersonalExpert, b: FrozenPersonalExpert) => a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0;
export const personalExpertCardsDigest = (items: readonly FrozenPersonalExpert[]) =>
  mathDigest(canonicalMathJson([...items].sort(byAsset)));
export const personalExpertSetSchema = z.object({ cards, digest: personalExpertDigestSchema }).strict().refine(
  set => set.digest === personalExpertCardsDigest(set.cards), 'personal expert snapshot digest mismatch');
export type PersonalExpertSet = z.infer<typeof personalExpertSetSchema>;

export function readPersonalExperts(file: string): PersonalExpertSet | undefined {
  const parsed = cards.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(byAsset);
  return parsed.length ? { cards: parsed, digest: personalExpertCardsDigest(parsed) } : undefined;
}
