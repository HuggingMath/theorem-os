#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { readMathText } from '../../src/math/mathRuntimeIo';
import { queueRunEdit } from '../../src/solver/humanEdit';

try {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    run: { type: 'string' }, plan: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) console.log('Usage: theorem-os edit --run RESULT_OR_STATE --plan FILE [--dry-run]\nValidates and queues a versioned plan edit. The running or resumed solver applies it and separately rechecks affected proofs.');
  else {
    if (!values.run || !values.plan) throw new Error('--run and --plan are required');
    const { id, status, baseVersion } = await queueRunEdit(values.run, JSON.parse(readMathText(values.plan, 1024 * 1024)), values['dry-run']);
    console.log(JSON.stringify({ id, status, baseVersion }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}
