import type { ArchiveIndexRecord, ArchiveProcess } from './types';

export interface SourceLocation {
  recordId: string;
  tab: 'source' | 'process';
  name: string;
  sha256: string;
  line: number;
  endLine: number;
  run?: string;
  step?: string;
}
interface SourceContext {
  record: Pick<ArchiveIndexRecord, 'id' | 'sources'>;
  tab: string;
  run: string;
  step: string;
  code: string;
  process?: ArchiveProcess;
}
function validRange(location: SourceLocation) {
  return Number.isSafeInteger(location.line) && location.line > 0 && Number.isSafeInteger(location.endLine)
    && location.endLine >= location.line && /^[a-f0-9]{64}$/u.test(location.sha256);
}
function matchesContext(location: SourceLocation | undefined, context: SourceContext): location is SourceLocation {
  return !!location && validRange(location) && location.recordId === context.record.id && location.tab === context.tab
    && (location.tab === 'source' || context.code === 'source' && !!location.run && !!location.step
      && location.run === context.run && location.step === context.step);
}

/** Parse the location only; source identity and file bounds are checked after its lazy data loads. */
export function readSourceLocation(params: URLSearchParams): SourceLocation | undefined {
  const recordId = params.get('proof'), tab = params.get('tab'), name = params.get('source'), sha256 = params.get('sourceSha256');
  const line = params.get('line'), endLine = params.get('endLine') ?? line;
  if (!recordId || !name || !sha256 || !line || !endLine || !/^[0-9]+$/u.test(line) || !/^[0-9]+$/u.test(endLine)
    || tab !== 'source' && tab !== 'process') return;
  const location: SourceLocation = { recordId, tab, name, sha256, line: Number(line), endLine: Number(endLine),
    ...(tab === 'process' ? { run: params.get('run') ?? '', step: params.get('step') ?? '' } : {}) };
  if (!validRange(location) || tab === 'process' && (!location.run || !location.step?.startsWith('check:') || params.get('code') !== 'source')) return;
  return location;
}

export function verifiedSourceLocation(location: SourceLocation | undefined, context: SourceContext): SourceLocation | undefined {
  if (!matchesContext(location, context)) return;
  if (location.tab === 'source') {
    const source = context.record.sources.find(item => item.name === location.name && item.sha256 === location.sha256);
    return source && location.endLine <= source.lines ? location : undefined;
  }
  const run = context.process?.runs.find(item => item.runId === location.run);
  const check = run?.checks?.find(item => `check:${item.id}` === location.step);
  const source = check?.sourceDigest && context.process?.sources?.[check.sourceDigest];
  if (!source || check?.sourceDigest !== location.sha256 || source.sha256 !== location.sha256 || source.path !== location.name) return;
  const lines = source.code.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return location.endLine <= lines.length ? location : undefined;
}

export function writeSourceLocation(params: URLSearchParams, location: SourceLocation | undefined, context: SourceContext) {
  if (!matchesContext(location, context)) return;
  // Keep the requested location while the process script loads, then canonicalize it against that exact check.
  if ((location.tab !== 'process' || context.process) && !verifiedSourceLocation(location, context)) return;
  params.set('source', location.name); params.set('sourceSha256', location.sha256);
  params.set('line', String(location.line)); params.set('endLine', String(location.endLine));
}
