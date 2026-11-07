#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { readMathText } from '../../src/math/mathRuntimeIo';
import { runProofSearchTool } from '../../src/solver/proofSearchTool';
import { currentWorkerProject } from '../../src/solver/workerProject';

async function main() {
  const args = process.argv.slice(2); if (args[0] === 'proof-search') args.shift();
  const { values } = parseArgs({ args, options: { workspace: { type: 'string' }, worktree: { type: 'string' }, file: { type: 'string' },
    theorem: { type: 'string' }, 'request-file': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: theorem-os proof-search (--workspace PROJECT | --worktree ROOT) --request-file JSON [--file FILE --theorem NAME]\n'
      + 'Requires a host-assigned closed helper lemma in COOPERATION.json and an explicitly pinned compatible Pantograph backend.\n'
      + 'Request: {"branches":[{"tactics":["intro n","simp"]}],"limits":{"timeoutMs":30000,"maxTransitions":64}}\n'
      + 'To continue, add resume:{path,digest} and optionally branches[].from (the logical node digest).\n'
      + 'Each call replays required prefixes and releases its backend. Checkpoints and candidates are advisory; existing ready/freeze/checker/S3 acceptance is required.\n'
      + 'Partial Aesop candidate: "aesop (config := { terminal := false })". No model calls or package installation.');
    return;
  }
  if (Boolean(values.workspace) === Boolean(values.worktree) || !values['request-file'])
    throw new Error('Exactly one of --workspace/--worktree, and --request-file, are required');
  const controller = new AbortController(), abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = await runProofSearchTool({ projectRoot: values.workspace ?? currentWorkerProject(values.worktree!), file: values.file, theoremName: values.theorem,
      request: JSON.parse(readMathText(values['request-file'], 256_000)), signal: controller.signal });
    console.log(JSON.stringify(result));
    process.exitCode = ['candidate', 'exhausted', 'budget-exhausted'].includes(result.status) ? 0 : result.status === 'cancelled' ? 130 : 1;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
void main().catch(error => {
  console.error(JSON.stringify({ authority: 'advisory-proof-search', proofAcceptance: 'not-accepted',
    status: 'unavailable', reason: error instanceof Error ? error.message : 'proof_search_failed' }));
  process.exitCode = 1;
});
