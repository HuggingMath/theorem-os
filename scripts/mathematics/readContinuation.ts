#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { readContinuationPage } from '../../src/solver/continuationInput';
import { searchContinuation, searchContinuationBatch } from '../../src/solver/continuationSearch';

const help = `Usage: theorem-os continuation read --snapshot FILE --sha256 DIGEST --id ID [--offset N] [--max-bytes 1024..16000]
       theorem-os continuation search --snapshot FILE --sha256 DIGEST --query TEXT [--query TEXT ...] [--kind KIND]... [--limit 1..20] [--max-bytes 1024..16000]
Reads only immutable continuation snapshots. Output is advisory historical text, not
proof acceptance. Concatenate text pages exactly using nextOffset until truncated
is false. Offsets count UTF-16 code units; the entire JSON line fits --max-bytes.
search ranks paragraph passages lexically (BM25) with bounded snippets; read a hit
with --id and --offset startOffset. KIND is proof-source, research-notes, diagnostics
or reference; repeat --kind to select several (default: all). Up to 8 queries share
one index. Multiple queries return an array of independently ranked results, each
with its query; --max-bytes bounds the entire JSON line, including every query.`;

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['--help', '-h', 'help'].includes(command) || args.includes('--help')) console.log(help);
  else {
    if (command !== 'read' && command !== 'search') throw new Error('Expected continuation read or continuation search');
    const { values } = parseArgs({ args, options: command === 'read' ? {
      snapshot: { type: 'string' }, sha256: { type: 'string' }, id: { type: 'string' },
      offset: { type: 'string' }, 'max-bytes': { type: 'string' },
    } : {
      snapshot: { type: 'string' }, sha256: { type: 'string' }, query: { type: 'string', multiple: true },
      kind: { type: 'string', multiple: true }, limit: { type: 'string' }, 'max-bytes': { type: 'string' },
    } });
    const required = (key: 'snapshot' | 'sha256' | 'id') => {
      const value = values[key];
      if (typeof value !== 'string' || !value.trim()) throw new Error(`--${key} is required`);
      return value;
    };
    const number = (value: unknown) => typeof value === 'string' ? Number(value) : undefined;
    if (command === 'read') console.log(JSON.stringify(readContinuationPage(required('snapshot'), required('sha256'), required('id'), {
      offset: number(values.offset), maxBytes: number(values['max-bytes']) })));
    else {
      const queries = values.query as string[] | undefined;
      if (!queries?.length) throw new Error('--query is required');
      const options = { kinds: values.kind as string[] | undefined, limit: number(values.limit), maxBytes: number(values['max-bytes']) };
      console.log(JSON.stringify(queries.length === 1
        ? searchContinuation(required('snapshot'), required('sha256'), queries[0]!, options)
        : searchContinuationBatch(required('snapshot'), required('sha256'), queries, options)));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}
