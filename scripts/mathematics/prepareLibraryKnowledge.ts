#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { prepareLibraryKnowledge } from '../../src/solver/theoremKnowledgeLibrary';

export function main(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { workspace: { type: 'string' }, output: { type: 'string' },
    state: { type: 'string', multiple: true }, 'auto-library-build': { type: 'string', multiple: true } } });
  if (!values.workspace?.trim() || !values.output?.trim()) throw new Error('--workspace and --output are required');
  return prepareLibraryKnowledge(values.workspace, values.output, {
    stateFiles: values.state, autoLibraryBuilds: values['auto-library-build'],
  });
}

if (import.meta.main) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'math_library_knowledge_failed');
    process.exitCode = 1;
  }
}
