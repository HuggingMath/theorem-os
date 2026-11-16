import { z } from 'zod';

/** Optional on older workflow requests; new selections freeze the actual executable and native configuration. */
export const agentHarnessIdentitySchema = z.object({
  id: z.enum(['codex', 'claude-code', 'opencode', 'cli']),
  executable: z.string().min(1), executableDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  profile: z.string().min(1), configurationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type AgentHarnessIdentity = z.infer<typeof agentHarnessIdentitySchema>;
