export type NativeDelegationOptions = { mode: 'read-only'; maxAgents: number };
/** Saved observations from experimental runs remain readable after disabling dispatch. */
export type NativeResearchAgent = {
  threadId: string; parentThreadId: string; startedAt: number; updatedAt: number;
  status: 'running' | 'completed' | 'errored' | 'interrupted' | 'stopped' | 'unknown';
  usage?: Record<string, unknown>; message?: string; stoppedAt?: number;
  permissionProfile?: 'math-investigator';
};

/** Native V1 currently inherits the parent's write permissions, overriding role profiles.
 * Keep the public request explicit and fail before any provider or native session starts.
 * The old host cooperative engine remains available; no writable substitute is selected.
 */
export function assertNativeDelegationAvailable(): never {
  throw new Error('math_native_read_only_delegation_unsupported');
}
