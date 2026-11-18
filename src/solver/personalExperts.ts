import fs from 'node:fs';
import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
export const personalExpertSchema = z.object({
  assetId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u),
  version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u), digest: sha256,
  name: z.string().trim().min(1).max(120), summary: z.string().max(4000),
  knowledge: z.string().min(1).refine(text => Boolean(text.trim()) && !text.includes('\0')),
}).strict();
export type FrozenPersonalExpert = z.infer<typeof personalExpertSchema>;
const cards = z.array(personalExpertSchema).max(32).refine(items =>
  new Set(items.map(item => item.assetId)).size === items.length, 'duplicate expert asset ID');
const byAsset = (a: FrozenPersonalExpert, b: FrozenPersonalExpert) => a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0;
export const personalExpertCardsDigest = (items: readonly FrozenPersonalExpert[]) =>
  mathDigest(canonicalMathJson([...items].sort(byAsset)));
export const personalExpertSetSchema = z.object({ cards, digest: sha256 }).strict().refine(
  set => set.digest === personalExpertCardsDigest(set.cards), 'personal expert snapshot digest mismatch');
export type PersonalExpertSet = z.infer<typeof personalExpertSetSchema>;

export function readPersonalExperts(file: string): PersonalExpertSet | undefined {
  const parsed = cards.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(byAsset);
  return parsed.length ? { cards: parsed, digest: personalExpertCardsDigest(parsed) } : undefined;
}
