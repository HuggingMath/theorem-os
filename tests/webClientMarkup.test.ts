import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const client = path.resolve(import.meta.dirname, '../apps/web/client');
const sources = fs.readdirSync(client, { recursive: true, encoding: 'utf8' })
  .filter(name => /\.tsx?$/u.test(name) && !/\.test\./u.test(name));
const parsesHtml = (source: string) => /\b(?:innerHTML|outerHTML)\s*(?:=(?!=)|\+=|\|\|=|&&=|\?\?=)|\b(?:insertAdjacentHTML|dangerouslySetInnerHTML)\b/u.test(source);

describe('workbench client markup', () => {
  // Interface text and run data reach the DOM through Preact or textContent, never through parsed HTML strings.
  // Reading DOM markup for a downloaded HTML export does not parse or insert it.
  it('never parses HTML strings', () => {
    const offenders = sources.filter(name => parsesHtml(fs.readFileSync(path.join(client, name), 'utf8')));
    expect(offenders).toEqual([]);
  });
  it.each([
    'element.innerHTML = markup',
    'element.innerHTML += markup',
    'element.outerHTML = markup',
    "element.insertAdjacentHTML('beforeend', markup)",
    'dangerouslySetInnerHTML={{ __html: markup }}',
  ])('detects HTML parsing through %s', source => { expect(parsesHtml(source)).toBe(true); });
  it('allows reading the DOM for an HTML download', () => {
    expect(parsesHtml('download(documentCopy.documentElement.outerHTML)')).toBe(false);
  });
});
