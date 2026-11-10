#!/usr/bin/env bun
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { searchOwnedDeclarations } from '../../src/solver/declarationSearch';

const help = `Usage: theorem-os declarations search --index FILE [--query KEYWORDS ...] [--file PROJECT_RELATIVE_PATH]
       theorem-os declarations get --index FILE --name QUALIFIED_NAME [--file PROJECT_RELATIVE_PATH]
       [--limit 1..32] [--max-bytes 1024..16000]
Search saved owned declarations using up to 8 literal keyword queries (all keywords
within a query, any query). Search returns names, locations and short type previews;
get matches the exact qualified name and returns its indexed type (up to 4000
characters). Read the Lean source at file:line if truncated. At least a query or
file is required for search. --file is an exact project-relative path.
The whole JSON line fits --max-bytes (default 4096); omittedMatches counts hidden
results. This lexical index is refreshed each turn, omits structures and inductives,
and cannot establish Lean applicability or proof acceptance.`;

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command) || args.includes('--help')) console.log(help);
  else {
    if (!['search', 'get'].includes(command)) throw new Error('Expected declarations search or declarations get');
    const options: ParseArgsOptionsConfig = {
      index: { type: 'string' }, file: { type: 'string' }, limit: { type: 'string' }, 'max-bytes': { type: 'string' },
      ...(command === 'search' ? { query: { type: 'string', multiple: true as const } } : { name: { type: 'string' } }),
    };
    const { values } = parseArgs({ args, options });
    if (typeof values.index !== 'string' || !values.index.trim()) throw new Error('--index is required');
    if (command === 'get' && (typeof values.name !== 'string' || !values.name.trim())) throw new Error('--name is required');
    console.log(JSON.stringify(searchOwnedDeclarations(values.index, { queries: values.query as string[] | undefined,
      name: values.name as string | undefined, file: values.file as string | undefined, fullTypes: command === 'get',
      limit: values.limit === undefined ? undefined : Number(values.limit),
      maxBytes: values['max-bytes'] === undefined ? undefined : Number(values['max-bytes']) })));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}
