import { describe, expect, it } from 'vitest';
import { admin } from '../apps/web/i18n/admin';
import { app } from '../apps/web/i18n/app';
import { collaboration } from '../apps/web/i18n/collaboration';
import { common } from '../apps/web/i18n/common';
import { editor } from '../apps/web/i18n/editor';
import { en } from '../apps/web/i18n/en';
import { explain } from '../apps/web/i18n/explain';
import { guide } from '../apps/web/i18n/guide';
import { modules } from '../apps/web/i18n/modules';
import { pages } from '../apps/web/i18n/pages';
import { server } from '../apps/web/i18n/server';
import { localizeText, t } from '../apps/web/i18n';
import { han, requiredKeys } from '../scripts/web-i18n';

describe('workbench English dictionary', () => {
  const parts = { server, pages, common, app, collaboration, modules, editor, guide, admin, explain };
  const { keys, stray } = requiredKeys();
  const placeholders = (text: string) => [...text.matchAll(/\{(\d+)\}/gu)].map(match => match[1]).sort().join(',');

  it('covers every Chinese interface string, with no Chinese text outside t()', () => {
    expect(stray).toEqual([]);
    expect([...keys].filter(([key]) => !Object.hasOwn(en, key)).map(([key, where]) => `${where} ${key}`)).toEqual([]);
  });

  it('has English values with the same placeholders as their keys', () => {
    expect(Object.entries(en).filter(([, value]) => han.test(value) || !value.trim())).toEqual([]);
    expect(Object.entries(en).filter(([key, value]) => placeholders(key) !== placeholders(value))).toEqual([]);
  });

  it('keeps each key in one part and drops entries nothing uses', () => {
    const seen = new Map<string, string>(), duplicates: string[] = [];
    for (const [name, part] of Object.entries(parts)) for (const key of Object.keys(part)) {
      if (seen.has(key)) duplicates.push(`${key} (${seen.get(key)}, ${name})`);
      seen.set(key, name);
    }
    expect(duplicates).toEqual([]);
    expect(Object.keys(en).filter(key => !keys.has(key))).toEqual([]);
  });

  it('stays Chinese outside the browser so the server keeps its stored text', () => {
    expect(t('运行 {0} 次', 3)).toBe('运行 3 次');
    expect(localizeText('独立验收')).toBe('独立验收');
  });
});
