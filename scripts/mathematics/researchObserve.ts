#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { readMathText } from '../../src/math/mathRuntimeIo';
import { ResearchAdmissionError } from '../../src/solver/researchAdmission';
import { queueResearchObservation } from '../../src/solver/researchObservation';

export function main(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: {
    worktree: { type: 'string' }, finding: { type: 'string' }, probe: { type: 'string', multiple: true },
    'snapshot-sources': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) return { usage: 'theorem-os research-observe --worktree DIR --finding FILE [--probe FILE ...] [--snapshot-sources]',
    description: 'Validate and queue one advisory finding immediately. Retain complete Lean probes before restoring scratch files. The host binds the event and independently checks formal proofs.' };
  if (!values.worktree || !values.finding) throw new Error('--worktree and --finding are required');
  return queueResearchObservation({ worktree: values.worktree, finding: JSON.parse(readMathText(values.finding, 1_000_000)),
    probes: values.probe, snapshotSources: values['snapshot-sources'] });
}

if (import.meta.main) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) {
    console.error(JSON.stringify(error instanceof ResearchAdmissionError ? error.admission : {
      status: 'rejected', code: error instanceof Error ? error.message : 'math_observation_failed', recovery: 'correct-and-resubmit' }));
    process.exitCode = 1;
  }
}
