import type { MathAgentSession } from '../runtime/agentSession';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { DEEPSEEK_PROVIDER } from '../runtime/deepseek';
import { WESTLAKE_PROVIDER } from '../runtime/westlake';

/** Replay and the portable harnesses retain their file handoff contract. */
export function usesNativeWorkflowOutput(config: { agentHarness?: { id?: string }; execution?: string; profile?: string }, execution: string,
  delivery?: 'native-schema' | 'file'): boolean {
  if (delivery !== 'native-schema' || execution !== 'model' || (config.agentHarness?.id ?? 'codex') !== 'codex') return false;
  const file = config.profile && path.join(config.profile, 'config.toml');
  const profile = file && fs.existsSync(file) ? parseToml(fs.readFileSync(file, 'utf8')) : {};
  // These providers use a Chat bridge whose Responses request contract accepts only text output.
  return profile.model_provider !== DEEPSEEK_PROVIDER.id && profile.model_provider !== WESTLAKE_PROVIDER.id;
}

/** Set the transport explicitly without rewriting mathematical text or feedback. */
export function nativeWorkflowOutputInstructions(text: string): string {
  const delivery = 'Codex native JSON delivery: return only the complete JSON in your final response, matching the native output schema. In the role contract below, requirements to write or submit OUTPUT.json mean returning that complete final JSON response; file-writing, temporary-file and rename instructions do not apply to this session. Do not write OUTPUT.json or use a shell call to submit it. Other role requirements are unchanged. The host closes this session, validates the final response and saves OUTPUT.json; this response does not establish a proof.';
  return text.startsWith(delivery) ? text : delivery + '\n\n' + text;
}

/** Never accept an earlier turn, commentary or a file in place of the completed final response. */
export function completedWorkflowOutput(session: MathAgentSession, turnId: string, maxBytes: number): string {
  const response = session.lastCompletedResponse;
  if (!response || response.turnId !== turnId) throw new Error('math_workflow_final_response_missing');
  if (Buffer.byteLength(response.text) > maxBytes) throw new Error('math_workflow_final_response_too_large');
  return response.text;
}
