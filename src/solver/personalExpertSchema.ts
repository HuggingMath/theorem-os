import { z } from 'zod';

export const personalExpertDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const personalExpertSchema = z.object({
  assetId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u),
  version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u), digest: personalExpertDigestSchema,
  name: z.string().trim().min(1).max(120), summary: z.string().max(4000),
  knowledge: z.string().min(1).refine(text => Boolean(text.trim()) && !text.includes('\0')),
}).strict();
export type FrozenPersonalExpert = z.infer<typeof personalExpertSchema>;
