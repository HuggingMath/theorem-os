#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { readMathText } from '../../src/math/mathRuntimeIo';
import { ResearchAdmissionError } from '../../src/solver/researchAdmission';
import { queueResearchObservation } from '../../src/solver/researchObservation';

const example = `mkdir -p .scratch
printf '%s\\n' '{"conclusion":"inconclusive","summary":"The construction remains unresolved.","remainingObligations":["Establish the missing bound."]}' > .scratch/finding.json
theorem-os research-observe --worktree "$PWD" --finding .scratch/finding.json`;

function readFinding(file: string): unknown {
  const reject = (code: string, message: string): never => {
    throw new ResearchAdmissionError({ status: 'rejected', code, issues: [{ path: '--finding', message }],
      recovery: 'correct-and-resubmit' });
  };
  if (/^\s*[\[{]/u.test(file)) reject('math_observation_finding_file_required',
    '--finding expects a JSON file path. Save the finding in .scratch/finding.json, then pass --finding .scratch/finding.json. Run --help for a complete example.');
  let text: string;
  try { text = readMathText(file, 1_000_000); }
  catch (error) {
    reject('math_observation_finding_file_unreadable',
      'Cannot read the --finding JSON file. Use an existing regular file path relative to the current directory or an absolute path. ' +
      (error instanceof Error ? error.message : 'File read failed.'));
  }
  try { return JSON.parse(text); }
  catch { return reject('math_observation_finding_json_invalid',
    'The --finding file must contain one JSON object, without Markdown fences or surrounding notes. Correct the file and resubmit.'); }
}

export function main(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: {
    worktree: { type: 'string' }, finding: { type: 'string' }, probe: { type: 'string', multiple: true },
    'snapshot-sources': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) return { usage: 'theorem-os research-observe --worktree DIR --finding FILE [--probe FILE ...] [--snapshot-sources]',
    description: 'Validate and queue one advisory finding from a JSON file. Replace the example content with your actual finding and run it from your worktree. Retain complete Lean probes before restoring scratch files. The host binds the event and independently checks formal proofs.',
    example };
  if (!values.worktree || !values.finding) throw new Error('--worktree and --finding are required');
  return queueResearchObservation({ worktree: values.worktree, finding: readFinding(values.finding),
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
