import { parseArgs } from 'node:util';
import { queueContextCheckpoint } from '../../src/solver/contextCheckpoint';

try {
  const { values } = parseArgs({ options: {
    worktree: { type: 'string' }, log: { type: 'string' }, 'request-id': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) console.log('Usage: theorem-os checkpoint --log FILE --request-id ID [--worktree DIR]');
  else {
    if (!values.log || !values['request-id']) throw new Error('Use the checkpoint command from the current host request.');
    console.log(JSON.stringify(queueContextCheckpoint(values.worktree ?? process.cwd(), values.log, values['request-id'])));
  }
} catch (error) {
  console.log(JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
