import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { consumeResearchEntry, readResearchEntry, researchEntryQuery, resolveResearchEntry } from '../apps/web/client/researchEntry';
import type { WebTemplate } from '../apps/web/shared';

const templates: WebTemplate[] = [
  { id: 'add-zero', name: 'Addition', environment: 'standard', source: 'theorem example (n : Nat) : n + 0 = n := by sorry', task: 'Keep this original statement.' },
  { id: 'polynomial', name: 'Square expansion', environment: 'mathlib', source: 'import Mathlib\n-- fixed polynomial example', task: 'Prove the fixed polynomial.' },
];

describe('public research entry continuity', () => {
  it.each(['zh', 'en'])('resolves the %s homepage links to this deployment’s exact templates', language => {
    const html = fs.readFileSync(new URL(`../docs/${language === 'en' ? 'en/' : ''}index.html`, import.meta.url), 'utf8');
    const links = [...html.matchAll(/data-research-entry="([^"]+)" href="([^"]+)"/gu)];
    expect(links).toHaveLength(2);
    for (const [, kind, href] of links) {
      const entry = readResearchEntry(new URL(href.replaceAll('&amp;', '&')).search)!;
      expect(entry.kind).toBe(kind); expect(entry.language).toBe(language);
      const draft = resolveResearchEntry(entry, templates)!;
      const source = templates.find(item => item.id === entry.template)!;
      expect(draft.source).toBe(source.source); expect(draft.environment).toBe(source.environment);
      expect(readResearchEntry(researchEntryQuery(entry))).toEqual(entry);
    }
    expect(html).toContain(`practice.html?lang=${language}`);
  });

  it('passes only a prepared draft to the matching consumer', () => {
    const statement = vi.fn(), lean = vi.fn();
    expect(consumeResearchEntry('?entry=statement&template=add-zero&environment=standard&lang=en&text=private&key=ignored', templates, { statement, lean })).toBe(true);
    expect(statement).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ language: 'en', environment: 'standard', statement: 'For every natural number n, prove that n + 0 = n.' }));
    expect(statement.mock.calls[0]![0]).not.toHaveProperty('key');
    expect(statement.mock.calls[0]![0]).not.toHaveProperty('text');
    expect(lean).not.toHaveBeenCalled();
    expect(consumeResearchEntry('?entry=lean&template=polynomial&environment=mathlib&lang=zh', templates, { statement, lean })).toBe(true);
    expect(lean).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: templates[1]!.source, environment: 'mathlib' }));
  });

  it.each(['?entry=remote', '?entry=lean&template=../../private', '?entry=statement&environment=mathlib', '?entry=lean&lang=invalid'])('ignores an unsupported public entry: %s', search => {
    const statement = vi.fn(), lean = vi.fn();
    expect(readResearchEntry(search)).toBeUndefined();
    expect(consumeResearchEntry(search, templates, { statement, lean })).toBe(false);
    expect(statement).not.toHaveBeenCalled(); expect(lean).not.toHaveBeenCalled();
  });

  it('does not substitute another template or environment when a deployment lacks the selected example', () => {
    const entry = readResearchEntry('?entry=lean')!;
    expect(resolveResearchEntry(entry, templates.slice(0, 1))).toBeUndefined();
    expect(resolveResearchEntry(entry, [{ ...templates[1]!, environment: 'standard' }])).toBeUndefined();
  });
});
