import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchOwnedDeclarations } from '../src/solver/declarationSearch';
import { writeOwnedDeclarationIndex } from '../src/solver/declarationIndex';
import { temporaryDirectory } from './helpers/files';

describe('bounded owned declaration lookup', () => {
  let directory: string, index: string;
  const fullType = 'target : ' + 'True ∧ '.repeat(150) + 'True';
  beforeEach(() => {
    directory = temporaryDirectory('declaration-search-'); index = path.join(directory, 'DECLARATIONS.jsonl');
    const project = path.join(directory, 'generated/p'); fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'Submission.lean'), 'namespace Sample\n' +
      `theorem ${fullType} := by sorry\nlemma target_helper : True := by trivial\nend Sample\n`);
    fs.writeFileSync(path.join(project, 'Other.lean'), 'namespace Other\ntheorem target : True := by trivial\nend Other\n');
    writeOwnedDeclarationIndex({ projectRelative: 'generated/p', ownedFiles: ['Submission.lean', 'Other.lean', 'Missing.lean'] }, directory);
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('ranks literal names, previews long types and filters exact files', () => {
    const result = searchOwnedDeclarations(index, { queries: ['Sample.target'] });
    expect(result).toMatchObject({ authority: 'lexical-source-index', proofAcceptance: 'not-assessed',
      totalMatches: 2, indexOmissions: { declarations: 0, unreadableFiles: ['Missing.lean'] } });
    expect(result.hits[0]).toMatchObject({ name: 'Sample.target', file: 'Submission.lean', line: 2, sorry: true, typePreview: true });
    expect(result.hits[0]!.type.length).toBeLessThanOrEqual(180);
    const exact = searchOwnedDeclarations(index, { queries: ['target'], file: 'Other.lean' });
    expect(exact.hits.map(hit => hit.name)).toEqual(['Other.target']);
    expect(searchOwnedDeclarations(index, { file: 'Submission.lean' }).hits).toHaveLength(2);
    expect(searchOwnedDeclarations(index, { queries: ['not_found'] }).hits).toEqual([]);
  });

  it('reads an exact qualified name without confusing it with helpers or other namespaces', () => {
    const result = searchOwnedDeclarations(index, { name: 'Sample.target', fullTypes: true, maxBytes: 8192 });
    expect(result.hits).toEqual([{ name: 'Sample.target', kind: 'theorem', file: 'Submission.lean', line: 2,
      sorry: true, type: fullType }]);
    expect(searchOwnedDeclarations(index, { name: 'target', fullTypes: true }).hits).toEqual([]);
    expect(searchOwnedDeclarations(index, { queries: ['Sample target_helper', 'Other.target'] }).hits.map(hit => hit.name))
      .toEqual(['Other.target', 'Sample.target_helper']);
  });

  it('bounds the entire output and reports all matches hidden by the count or byte limit', () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ name: `Sample.target_${i}`, kind: 'theorem', file: 'Submission.lean',
      line: i + 1, sorry: false, type: 'target : ' + 'True ∧ '.repeat(200) + 'True' }));
    fs.writeFileSync(index, rows.map(row => JSON.stringify(row)).join('\n'));
    const result = searchOwnedDeclarations(index, { queries: ['target'], limit: 32, maxBytes: 1024 });
    expect(Buffer.byteLength(JSON.stringify(result)) + 1).toBeLessThanOrEqual(1024);
    expect(result.hits.length).toBeGreaterThan(0); expect(result.hits.length).toBeLessThan(32);
    expect(result.omittedMatches).toBe(80 - result.hits.length);
    expect(result.hits.map(hit => hit.name)).toEqual(rows.slice(0, result.hits.length).map(row => row.name));
    expect(() => searchOwnedDeclarations(index, { queries: ['x'.repeat(2000)], maxBytes: 1024 }))
      .toThrow('math_declaration_search_budget_too_small');
  });

  it('rejects invalid options and malformed indexes rather than inventing an empty search', () => {
    for (const options of [{}, { queries: [''] }, { queries: Array(9).fill('target') },
      { queries: ['target'], limit: 33 }, { queries: ['target'], maxBytes: 1023 }, { file: '' }])
      expect(() => searchOwnedDeclarations(index, options)).toThrow('math_declaration_search_options_invalid');
    fs.appendFileSync(index, '\n{"name":"broken"}\n');
    expect(() => searchOwnedDeclarations(index, { queries: ['target'] })).toThrow('math_declaration_index_invalid');
  });

  it('offers search and exact type lookup through the public CLI', () => {
    const cli = (...args: string[]) => spawnSync('bun', ['bin/math.ts', 'declarations', ...args], { encoding: 'utf8', timeout: 10_000 });
    const result = cli('search', '--index', index, '--query', 'Sample.target_helper', '--query', 'Other.target', '--max-bytes', '2048');
    expect(result.status, result.stderr).toBe(0); expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(2048);
    expect(JSON.parse(result.stdout).hits.map((hit: { name: string }) => hit.name)).toEqual(['Sample.target_helper', 'Other.target']);
    const full = cli('get', '--index', index, '--name', 'Sample.target', '--max-bytes', '8192');
    expect(full.status, full.stderr).toBe(0); expect(JSON.parse(full.stdout).hits[0].type).toBe(fullType);
    const invalid = cli('get', '--index', index, '--query', 'target');
    expect(invalid.status).toBe(1); expect(invalid.stdout).toBe('');
  });
});
