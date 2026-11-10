#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { queueProofImport } from '../../src/solver/proofImport';

try {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    run: { type: 'string' }, task: { type: 'string' }, fragment: { type: 'string' }, sha256: { type: 'string' },
    'base-version': { type: 'string' }, id: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
    'before-theorem': { type: 'string' },
  } });
  if (values.help) console.log('Usage: theorem-os import-proof --run RESULT_OR_STATE --task TASK --fragment FILE --sha256 SHA256 --base-version VERSION [--id ID] [--before-theorem NAME] [--dry-run]\nQueues pure theorem/lemma declarations for a pending lemma task. --before-theorem places the fragment before an existing declaration in the same namespace so earlier consumers can use it. The assigned worker imports them before opening a model; the host independently checks the frozen proof and canonical merge. Existing source context and declarations are preserved.');
  else {
    if (!values.run || !values.task || !values.fragment || !values.sha256 || !values['base-version'])
      throw new Error('--run, --task, --fragment, --sha256 and --base-version are required');
    console.log(JSON.stringify(await queueProofImport(values.run, { taskId: values.task, fragmentFile: values.fragment,
      sha256: values.sha256, baseVersion: values['base-version'], id: values.id,
      beforeTheorem: values['before-theorem'] }, values['dry-run'])));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}
