import type { MathProcessStopReceipt } from '../math/mathProcess';
import type { LeanTaskEnvironment } from '../math/leanTaskEnvironment';
import type { MathAgentSkill } from './agentSkills';
import type { MathAgentFailureDiagnostic } from './failureDiagnostic';
export type { MathAgentFailureDiagnostic } from './failureDiagnostic';
import type { ModelRequestGate } from './modelRequest';
import type { NativeDelegationOptions, NativeResearchAgent } from './nativeDelegation';

type Json = Record<string, unknown>;

/** Harness events describe execution; none of them grants mathematical acceptance. */
export type MathAgentActivity = {
  event: 'item_started' | 'item_completed' | 'reasoning' | 'message' | 'command_output' | 'lean_lock_waiting' | 'lean_lock_acquired'
    | 'shell_argument_rejected';
  itemType?: string;
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
  environment?: NodeJS.ProcessEnv;
  proofProjectRoot?: string;
  threadId?: string;
  turnTimeoutMs?: number;
  outputSchema?: Record<string, unknown>;
  onUsage: (usage: Json, context?: { turnId?: string }) => void;
  onUsageIncomplete?: () => void;
  requestGate?: ModelRequestGate;
  onActivity?: (activity: MathAgentActivity) => void;
  onItem?: (phase: 'started' | 'completed', item: Json, context?: { turnId?: string }) => void;
  onItemUpdate?: (item: Json, context?: { turnId?: string }) => void;
  hiddenRoots?: readonly string[];
  readIsolation?: { environment: LeanTaskEnvironment; packages?: 'none' | 'sources'; library?: { file: string; digest: string } };
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
  readonly isolationReceipt?: Record<string, unknown>;
  /** Selected execution contracts, not a claim of mathematical acceptance or complete usage. */
  readonly executionPlan?: MathAgentSessionPlan;
  run: (message: string, messageId: string, workspace: string, onStarted: (turnId: string) => void) => Promise<string>;
  notify?: (message: string, options?: { waitForRequest?: boolean }) => Promise<void>;
  compact?: () => Promise<void>;
  interrupt: () => Promise<void>;
  close: () => Promise<void>;
  stopForFreeze?: () => Promise<MathProcessStopReceipt | Readonly<{ status: 'unconfirmed';
    reason: 'turn-not-settled' | 'shutdown-failed' }>>;
};

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
