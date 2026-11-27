#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { queuePlanApproval } from '../../src/solver/humanEdit';
import { readRunInspection } from '../../src/solver/inspection';
import { assertActiveResearchState, legacyCollaborationRetired } from '../../src/solver/researchRetirement';

try {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    run: { type: 'string' }, plan: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
    'approve-plan': { type: 'string' },
  } });
  if (values.help) console.log('Usage: theorem-os edit --run RESULT_OR_STATE --approve-plan VERSION\n' +
    'Inspect the exact route version before approving it. Use the historical release for legacy plan edits.');
  else {
    if (values.plan !== undefined || values['dry-run']) throw new Error(legacyCollaborationRetired);
    if (!values.run || !values['approve-plan']) throw new Error('--run and --approve-plan are required');
    assertActiveResearchState(readRunInspection(values.run).state);
    console.log(JSON.stringify(await queuePlanApproval(values.run, { id: randomUUID(), planVersion: values['approve-plan'] })));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}
