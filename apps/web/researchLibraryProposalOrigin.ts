import { z } from 'zod';

/** A reference to reviewed evidence, never approval of the new attempt's edited source. */
export type ResearchLibraryProposalOrigin = { projectId: string; feedbackId: string; trialDigest: string };
const key = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
export const researchLibraryProposalOriginSchema = z.object({ projectId: key, feedbackId: key,
  trialDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict() as z.ZodType<ResearchLibraryProposalOrigin>;
