#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { agentLibrary } from '../../src/solver/libraryAccess';

export function main(argv: string[]) {
  const [command, ...args] = argv;
  if (!command || ['--help', 'help', '-h'].includes(command) || args.includes('--help'))
    return { usage: 'theorem-os library search|get|request --worktree DIR [options]',
      search: '--query WORDS --goal LEAN_TYPE --limit 10',
      get: '--name QUALIFIED_NAME [--offset 0 --max-bytes 16000]',
      request: '--name QUALIFIED_NAME [--name NAME...] --reason TEXT',
      authority: 'Read-only pinned release search. Requests require host installation and independent Lean checks.' };
  const { values } = parseArgs({ args, options: { worktree: { type: 'string' }, query: { type: 'string' },
    goal: { type: 'string' }, limit: { type: 'string', default: '10' }, name: { type: 'string', multiple: true },
    offset: { type: 'string', default: '0' }, 'max-bytes': { type: 'string', default: '16000' }, reason: { type: 'string' } } });
  if (!values.worktree) throw new Error('--worktree is required');
  const library = agentLibrary(values.worktree);
  if (command === 'search') return library.search(values.query ?? '', values.goal, Number(values.limit));
  if (command === 'get' && values.name?.length === 1)
    return library.get(values.name[0], Number(values.offset), Number(values['max-bytes']));
  if (command === 'request' && values.name?.length && values.reason) return library.request(values.name, values.reason);
  throw new Error('Use search, get --name NAME, or request --name NAME --reason TEXT.');
}
if (import.meta.main) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.error(error instanceof Error ? error.message : 'math_library_failed'); process.exitCode = 1; }
}
