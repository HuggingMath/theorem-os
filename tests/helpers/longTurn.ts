import path from 'node:path';
import type { MathAgentOptions, MathAgentSession } from '../../src/runtime/codexSession';

/**
 * Wraps a preset session opener so turns in workspaces matching `long` keep making requests after the preset turn,
 * each reporting one more cumulative token, until interrupted or `requests` is reached: a model turn that overruns
 * the allowance. An interrupted turn ends 'interrupted'; `stopped` lists the workspace names that were interrupted.
 */
export function longTurns(open: (options: MathAgentOptions) => Promise<MathAgentSession>,
  long: (name: string) => boolean, requests = 100) {
  const stopped: string[] = [];
  const opened = async (options: MathAgentOptions): Promise<MathAgentSession> => {
    const session = await open(options);
    let interrupted = false;
    return { threadId: session.threadId, get lastFailureDiagnostic() { return session.lastFailureDiagnostic; },
      interrupt: async () => { interrupted = true; await session.interrupt(); }, close: () => session.close(),
      run: async (message, id, workspace, onStarted) => {
        const status = await session.run(message, id, workspace, onStarted);
        if (!long(path.basename(workspace))) return status;
        for (let total = 2; total <= requests; total++) {
          await new Promise(resolve => setImmediate(resolve));
          if (interrupted) { stopped.push(path.basename(workspace)); return 'interrupted'; }
          options.onUsage({ inputTokens: total, outputTokens: 0, totalTokens: total });
        }
        return status;
      } };
  };
  return { open: opened, stopped };
}
