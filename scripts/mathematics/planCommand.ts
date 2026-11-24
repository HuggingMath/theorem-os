import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { MAX_RESEARCH_NOTES_BYTES } from '../../src/solver/deliveries';
import { applyCooperationPlanFile, validateCooperationPlanFile } from '../../src/solver/planTool';

function readStandardInput(): string {
  const bytes = Buffer.alloc(MAX_RESEARCH_NOTES_BYTES + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = fs.readSync(0, bytes, length, bytes.length - length, null);
    if (!count) break;
    length += count;
  }
  if (length > MAX_RESEARCH_NOTES_BYTES) throw new Error('Keep the plan JSON at or below 1 MB.');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
}

export function runPlanCommand(command: 'plan-validate' | 'plan-apply', args: string[]): void {
  const usage = `theorem-os ${command} [--file FILE] [--workspace DIR]`;
  let field = 'arguments';
  try {
    const { values } = parseArgs({ args, options: {
      file: { type: 'string' }, workspace: { type: 'string' }, worktree: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) {
      console.log(JSON.stringify({ usage, description: 'Read a complete plan or revision from --file or stdin. ' +
        'Use the Lead workspace with COOPERATION.json, or a prepared workspace with active-problem.json. ' +
        (command === 'plan-apply' ? 'Save a validated draft in RESEARCH.md for host intake.' : 'Report validation issues.') }));
      return;
    }
    if (values.worktree && values.workspace) throw new Error('Choose --workspace or --worktree.');
    const workspace = values.workspace ?? values.worktree ?? process.cwd();
    let input: { workspace: string; text: string } | { workspace: string; file: string };
    if (!values.file || values.file === '-') {
      field = 'stdin';
      input = { workspace, text: readStandardInput() };
    } else input = { workspace, file: values.file };
    const result = command === 'plan-apply' ? applyCooperationPlanFile(input) : validateCooperationPlanFile(input);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: 'math_plan_cli_input_invalid',
      issues: [{ path: field, message: error instanceof Error ? error.message : usage }] }));
    process.exitCode = 1;
  }
}
