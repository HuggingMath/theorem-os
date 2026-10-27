import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const client = path.resolve(import.meta.dirname, '../apps/web/client');
const sources = fs.readdirSync(client, { recursive: true, encoding: 'utf8' })
  .filter(name => /\.tsx?$/u.test(name) && !/\.test\./u.test(name));

describe('workbench client markup', () => {
  // Interface text and run data reach the DOM through Preact or textContent, never through parsed HTML strings.
  it('never parses HTML strings', () => {
    const offenders = sources.filter(name => /\b(?:innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML)\b/u.test(fs.readFileSync(path.join(client, name), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
