import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { informalizationDigest } from '../../src/math/informalization';
import { mathDigest, readMathText } from '../../src/math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../../src/math/paths';
import { safeFailureDiagnostic } from '../../src/runtime/failureDiagnostic';
import { readInformalizationState } from '../../src/solver/informalization';
import type { WorkerExplanationCheckpoint, WorkerExplanationInput } from './shared';

export const maxExplanationMessageBytes = 32 * 1024 * 1024;
const workspacePath = z.string().regex(
  /^batches\/[0-9]+\/round-[0-9]+\/(?:retry-[a-f0-9-]{36}\/)?(?:write|audit-[A-Za-z0-9_-]{1,80}-[0-9]+)$/u);
const files = { 'INPUT.json': 8_000_000, 'ROLE.md': 1_000_000, 'OUTPUT.schema.json': 1_000_000, 'OUTPUT.json': 4_000_000 } as const;
const roleSchema = z.object({
  'INPUT.json': z.string().max(files['INPUT.json']),
  'ROLE.md': z.string().max(files['ROLE.md']),
  'OUTPUT.schema.json': z.string().max(files['OUTPUT.schema.json']),
  'OUTPUT.json': z.string().max(files['OUTPUT.json']),
}).strict();
export const explanationCheckpointSchema = z.object({
  schema: z.literal('theorem-os.web-explanation-checkpoint.v1'),
  state: z.string().max(64_000_000), outline: z.string().max(64_000_000),
  workspaces: z.record(workspacePath, roleSchema),
}).strict();

/** The storage key also scopes the checkpoint to the owner, run, target and language. */
export function explanationCheckpointBinding(input: WorkerExplanationInput): string {
  const { id: _id, apiKey: _key, checkpoint: _checkpoint, proof, provider, ...request } = input;
  return informalizationDigest({ ...request, proofDigest: mathDigest(proof),
    provider: { id: provider.id, baseUrl: provider.baseUrl, harness: provider.harness, execution: provider.execution } });
}

export function captureExplanationCheckpoint(directory: string, apiKey: string): WorkerExplanationCheckpoint | undefined {
  const state = readInformalizationState(directory);
  if (state?.status !== 'stopped' || state.outline?.file !== 'outline.json') return undefined;
  const outline = readMathText(path.join(directory, 'outline.json'), 64_000_000);
  const batch = state.batches.find(item => item.open && item.status === 'pending');
  const workspaces: WorkerExplanationCheckpoint['workspaces'] = {};
  for (const session of state.sessions) {
    session.failureDiagnostic = safeFailureDiagnostic(session.failureDiagnostic);
    session.usage = Object.fromEntries(['totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens']
      .filter(name => Number.isSafeInteger(session.usage[name]) && (session.usage[name] as number) >= 0)
      .map(name => [name, session.usage[name]]));
    // The state already embeds approved batches and earlier rounds' revision feedback.
    if (!batch || session.batch !== batch.index || session.round !== batch.rounds ||
        !session.turnId || !session.outputDigest || !['completed', 'submitted'].includes(session.status)) continue;
    const workspace = path.join(directory, workspacePath.parse(session.workspace));
    assertMathCanonicalPath(workspace);
    const role = {} as WorkerExplanationCheckpoint['workspaces'][string];
    for (const name of Object.keys(files) as (keyof typeof files)[]) {
      role[name] = readMathText(path.join(workspace, name), files[name]);
    }
    workspaces[session.workspace] = role;
  }
  const checkpoint: WorkerExplanationCheckpoint = { schema: 'theorem-os.web-explanation-checkpoint.v1',
    state: JSON.stringify(state), outline, workspaces };
  // Serialized files can contain model prose. Only send a complete checkpoint with no copy of the key.
  const serialized = JSON.stringify(checkpoint);
  const escapedKey = JSON.stringify(apiKey).slice(1, -1);
  if (Buffer.byteLength(serialized) > maxExplanationMessageBytes - 1024 ||
      [checkpoint.state, outline, ...Object.values(workspaces).flatMap(Object.values)]
        .some(value => value.includes(apiKey) || value.includes(escapedKey)) || serialized.includes(escapedKey)) return undefined;
  return checkpoint;
}

export function restoreExplanationCheckpoint(directory: string, requestDigest: string, checkpoint: WorkerExplanationCheckpoint): boolean {
  // Checkpoints are optional on a fresh worker. The build, proof and role configuration still have to match.
  try {
    const identity = JSON.parse(checkpoint.state);
    if (identity?.requestDigest !== requestDigest || identity.status !== 'stopped') return false;
  } catch { return false; }
  for (const [relative, role] of Object.entries(checkpoint.workspaces)) {
    const workspace = path.join(directory, workspacePath.parse(relative));
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    for (const name of Object.keys(files) as (keyof typeof files)[]) {
      fs.writeFileSync(path.join(workspace, name), role[name], { mode: 0o400, flag: 'wx' });
    }
  }
  fs.writeFileSync(path.join(directory, 'outline.json'), checkpoint.outline, { mode: 0o400, flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'state.json'), checkpoint.state, { mode: 0o600, flag: 'wx' });
  return true;
}
