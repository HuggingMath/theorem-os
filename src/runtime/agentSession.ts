import type { MathProcessStopReceipt } from '../math/mathProcess';
import type { LeanTaskEnvironment } from '../math/leanTaskEnvironment';
import type { MathAgentSkill } from './agentSkills';
import type { MathAgentFailureDiagnostic } from './failureDiagnostic';
export type { MathAgentFailureDiagnostic } from './failureDiagnostic';
import type { ModelRequestGate } from './modelRequest';
import type { NativeDelegationOptions, NativeResearchAgent } from './nativeDelegation';
import type { MathAgentTools } from './agentTeamTools';
export type { MathAgentTools, MathAgentToolDefinition, MathAgentToolContext } from './agentTeamTools';
import type { HarnessProcessIdentity } from './harnessProcess';
import type { LeanEnvironmentHealth } from '../math/leanEnvironmentHealth';
import type { NativeAgentControlOptions, NativeAgentControlConnection } from './nativeAgentControl';
export type { NativeAgentControlOptions, NativeAgentControlConnection } from './nativeAgentControl';

type Json = Record<string, unknown>;

/** Harness events describe execution; none of them grants mathematical acceptance. */
export type MathAgentActivity = {
  event: 'item_started' | 'item_completed' | 'reasoning' | 'message' | 'command_output' | 'lean_lock_waiting' | 'lean_lock_acquired'
    | 'lean_environment_ready';
  itemType?: string;
  /** Present on the host's pre-model lean_environment_ready event. */
  health?: LeanEnvironmentHealth;
};

/** The solver owns this contract; each harness translates its native protocol. */
export type MathAgentOptions = {
  executable: string;
  profile: string;
  workspace: string;
  model: string;
  effort: string;
  instructions: string;
  skills?: readonly MathAgentSkill[];
  delegation?: NativeDelegationOptions;
  onNativeAgent?: (agent: NativeResearchAgent) => void;
  tools?: MathAgentTools;
  /** Host backend for Codex's built-in collaboration tools, with isolated native children. */
  nativeAgentControl?: NativeAgentControlOptions;
  /** Tie the complete native writer tree to this host with a dedicated PID namespace. */
  isolateProcess?: boolean;
  environment?: NodeJS.ProcessEnv;
  proofProjectRoot?: string;
  /** Host-owned environment probe, run in the same isolated namespace before native/model startup. */
  leanHealthCheck?: Readonly<{ executable: string; arguments: readonly string[] }>;
  threadId?: string;
  /** Hard native-turn deadline; may interrupt an in-flight paid request. */
  turnTimeoutMs?: number;
  /** Earlier Codex checkpoint: close paid admission at the next request boundary,
   * after the current response and its tools. The hard deadline still applies. */
  turnCheckpointMs?: number;
  outputSchema?: Record<string, unknown>;
  onUsage: (usage: Json, context?: { turnId?: string }) => void;
  onUsageIncomplete?: () => void;
  requestGate?: ModelRequestGate;
  onActivity?: (activity: MathAgentActivity) => void;
  onItem?: (phase: 'started' | 'completed', item: Json, context?: { turnId?: string }) => void;
  onItemUpdate?: (item: Json, context?: { turnId?: string }) => void;
  hiddenRoots?: readonly string[];
  /** Hide present and future peer directories, then expose only this workspace below its direct parent. */
  isolatedWorkspaceParent?: string;
  readIsolation?: {
    environment: LeanTaskEnvironment; packages?: 'none' | 'sources'; library?: { file: string; digest: string };
    upstreamIdleTimeoutMs?: number;
  };
  completedOutput?: {
    file: string;
    validate: (value: unknown) => void;
    validationFeedback?: (error: unknown, output: { text: string; turnId: string }) => string;
  };
  signal?: AbortSignal;
};

export type MathAgentSession = {
  /** Reported native IDs may be empty until run starts; onStarted requires the exact bound ID. */
  threadId: string;
  readonly lastError?: string;
  readonly lastFailureDiagnostic?: MathAgentFailureDiagnostic;
  readonly lastInputTokens?: number;
  readonly lastCompletedResponse?: Readonly<{ turnId: string; text: string }>;
  /** Turn totals must be emitted once for that turn, rather than passed off as thread totals. */
  readonly usageSource?: 'upstream-requests' | 'native-thread-totals' | 'native-turn-totals';
  /** The adapter can queue advisory history without steering or starting a turn. */
  readonly advisoryNotifications?: 'native-history';
  readonly isolationReceipt?: Record<string, unknown>;
  readonly processIdentity?: HarnessProcessIdentity;
  readonly nativeAgentControl?: NativeAgentControlConnection;
  /** Safe startup overrides acknowledged by thread creation, not an effective-config readback. */
  readonly nativeConfiguration?: MathNativeConfiguration;
  /** Selected execution contracts, not a claim of mathematical acceptance or complete usage. */
  readonly executionPlan?: MathAgentSessionPlan;
  run: (message: string, messageId: string, workspace: string, onStarted: (turnId: string) => void) => Promise<string>;
  /** Advisory updates can enter native history without interrupting or starting work.
   * The default remains turn-bound steering for effective instructions. */
  notify?: (message: string, options?: { waitForRequest?: boolean; mode?: 'advisory' }) => Promise<void>;
  compact?: () => Promise<void>;
  interrupt: () => Promise<void>;
  close: () => Promise<void>;
  stopForFreeze?: () => Promise<MathProcessStopReceipt | Readonly<{ status: 'unconfirmed';
    reason: 'turn-not-settled' | 'shutdown-failed' }>>;
};

export type MathNativeConfiguration = Readonly<{
  source: 'thread-start-overrides';
  overrides: Readonly<{
    includeSkillInstructions: false;
    deferMailboxPreemption?: true;
    rootAgentUsageHintText?: '';
    subagentUsageHintText?: '';
    multiAgentModeHintText?: string;
  }>;
}>;

export type MathAgentHarnessId = 'codex' | 'claude-code' | 'opencode' | 'cli';

/** Only contracts consumed by current workflows belong here. Native accounting and
 * optional notify/compact remain the actual session's observations and methods. */
export type MathAgentSessionPlan = Readonly<{
  schema: 'theorem-os.agent-session-plan.v1';
  harness: MathAgentHarnessId;
  skillLoading: 'none' | 'file' | 'native' | 'mixed';
  roleIsolation: 'run-workspace' | 'sealed-role';
  structuredOutput: 'none' | 'native-schema' | 'validated-output-file';
  continuation: 'native-session' | 'source-context';
}>;
