import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { usesNativeWorkflowOutput, completedWorkflowOutput } from '../src/solver/workflowOutput';
import type { MathAgentSession } from '../src/runtime/agentSession';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('frozen workflow output delivery', () => {
  it.each(['westlake', 'deepseek', 'sub2api', 'openai'])('selects the supported output transport for provider %s', provider => {
    const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-output-profile-'))); roots.push(profile);
    fs.writeFileSync(path.join(profile, 'config.toml'), `model_provider = "${provider}"\n`);
    const native = provider !== 'westlake' && provider !== 'deepseek';
    expect(usesNativeWorkflowOutput({ profile }, 'model', 'native-schema')).toBe(native);
    expect(usesNativeWorkflowOutput({ profile }, 'model')).toBe(false);
    expect(usesNativeWorkflowOutput({ profile }, 'replay', 'native-schema')).toBe(false);
    for (const id of ['cli', 'claude-code', 'opencode'])
      expect(usesNativeWorkflowOutput({ profile, agentHarness: { id } }, 'model', 'native-schema')).toBe(false);
  });

  it('requires the completed response of the submitted turn rather than a prior final response', () => {
    const session: MathAgentSession = { threadId: 'workflow-thread', lastCompletedResponse: { turnId: 'previous-turn', text: '{}' },
      run: async () => 'completed', interrupt: async () => {}, close: async () => {} };
    expect(() => completedWorkflowOutput(session, 'current-turn', 100)).toThrow('math_workflow_final_response_missing');
    expect(completedWorkflowOutput(session, 'previous-turn', 100)).toBe('{}');
  });
});
