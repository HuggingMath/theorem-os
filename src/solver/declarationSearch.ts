import path from 'node:path';
import { z } from 'zod';
import { assertMathCanonicalPath } from '../math/paths';
import { readMathText } from '../math/mathRuntimeIo';
import { type OwnedDeclaration } from './declarationIndex';
import { splitsSurrogate } from './textPage';

const declaration = z.object({ name: z.string(), kind: z.enum(['theorem', 'definition', 'instance']),
  file: z.string(), line: z.number().int().positive(), sorry: z.boolean(), type: z.string(), truncated: z.literal(true).optional() });
const omissions = z.object({ declarations: z.number().int().nonnegative(), unreadableFiles: z.array(z.string()) });
const previewLength = 180;
export type DeclarationSearchOptions = {
  queries?: readonly string[]; name?: string; file?: string; limit?: number; maxBytes?: number; fullTypes?: boolean;
};

/** Search the saved lexical index. A match never establishes elaboration, applicability or proof acceptance. */
export function searchOwnedDeclarations(indexFile: string, options: DeclarationSearchOptions = {}) {
  const { queries = [], name, file, limit = 12, maxBytes = 4096, fullTypes = false } = options;
  const invalidText = (value: unknown) => typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 4000;
  if (!Array.isArray(queries) || queries.length > 8 || queries.some(invalidText) ||
      name !== undefined && invalidText(name) || file !== undefined && invalidText(file) ||
      !queries.length && name === undefined && file === undefined ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 32 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16000)
    throw new Error('math_declaration_search_options_invalid');
  indexFile = path.resolve(indexFile);
  assertMathCanonicalPath(indexFile);
  const text = readMathText(indexFile, 16 * 1024 * 1024);
  let entries: OwnedDeclaration[];
  let indexOmissions: z.infer<typeof omissions> | undefined;
  try {
    entries = text.split('\n').filter(line => line.trim()).flatMap(line => {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && 'omitted' in value) { indexOmissions = omissions.parse(value.omitted); return []; }
      return [declaration.parse(value) as OwnedDeclaration];
    });
  } catch { throw new Error('math_declaration_index_invalid'); }
  const terms: string[][] = queries.map((query: string) => [...new Set<string>(query.toLowerCase().trim().split(/\s+/u))]);
  const matches = entries.flatMap((entry, position) => {
    if (name !== undefined && entry.name !== name || file !== undefined && entry.file !== file) return [];
    const lowerName = entry.name.toLowerCase(), lowerType = entry.type.toLowerCase();
    const scores = terms.flatMap(words => words.every(word => lowerName.includes(word) || lowerType.includes(word))
      ? [words.reduce((score, word) => score + (lowerName === word ? 100 : lowerName.endsWith('.' + word) ? 50 :
        lowerName.includes(word) ? 8 : 1), 0)] : []);
    if (terms.length && !scores.length) return [];
    return [{ entry, position, score: scores.length ? Math.max(...scores) : 0 }];
  }).sort((left, right) => right.score - left.score || left.position - right.position);
  const hits = matches.slice(0, limit).map(({ entry }) => {
    let end = Math.min(previewLength, entry.type.length);
    if (splitsSurrogate(entry.type, end)) end--;
    return fullTypes || end === entry.type.length ? { ...entry } :
      { ...entry, type: entry.type.slice(0, end), typePreview: true as const };
  });
  const packet = (count: number) => ({ schema: 'theorem-os.declaration-search.v1' as const,
    authority: 'lexical-source-index' as const, proofAcceptance: 'not-assessed' as const,
    index: path.resolve(indexFile), queries: [...queries], ...(name !== undefined ? { name } : {}),
    ...(file !== undefined ? { file } : {}), fullTypes, totalMatches: matches.length,
    hits: hits.slice(0, count), ...(count < matches.length ? { omittedMatches: matches.length - count } : {}),
    ...(indexOmissions ? { indexOmissions } : {}) });
  for (let count = hits.length; count >= 0; count--) {
    const value = packet(count);
    if (Buffer.byteLength(JSON.stringify(value)) + 1 <= maxBytes) return value;
  }
  throw new Error('math_declaration_search_budget_too_small');
}
