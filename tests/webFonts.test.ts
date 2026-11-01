import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { han, requiredKeys } from '../scripts/web-i18n';

// The Chinese faces are split by unicode-range: interface text must come from the small -ui and -ui-extra files,
// or the first page a reader opens also downloads the 760 KB -common file for one tab label.
const css = fs.readFileSync(path.join(import.meta.dirname, '../apps/web/client/app.css'), 'utf8');
function range(family: string, file: string) {
  const face = new RegExp(`@font-face\\{font-family:"${family}";src:url\\("assets/fonts/${file}"\\)[^}]*unicode-range:([^;}]*)\\}`, 'u').exec(css);
  const codes = new Set<number>();
  for (const part of face![1]!.split(',')) {
    const [from, to] = part.trim().slice(2).split('-');
    for (let code = parseInt(from!, 16); code <= parseInt(to ?? from!, 16); code++) codes.add(code);
  }
  return codes;
}

describe('workbench Chinese font subsets', () => {
  const faces = [['TheoremOS Sans SC', 'NotoSansSC'], ['TheoremOS Serif SC', 'NotoSerifSC']] as const;

  it.each(faces)('%s draws every interface character from the -ui files', (family, file) => {
    const ui = range(family, `${file}-ui.woff2`), extra = range(family, `${file}-ui-extra.woff2`);
    const characters = new Set([...requiredKeys().keys.keys()].flatMap(key => [...key].filter(character => han.test(character))));
    // Add missing characters to -ui-extra as docs/website.md describes (视觉素材), then move them out of -common here.
    expect([...characters].filter(character => !ui.has(character.codePointAt(0)!) && !extra.has(character.codePointAt(0)!)).join('')).toBe('');
  });

  it.each(faces)('%s ranges do not overlap, so each character has one file', (family, file) => {
    const [ui, extra, common] = ['ui', 'ui-extra', 'common'].map(part => range(family, `${file}-${part}.woff2`));
    expect([...extra!].filter(code => ui!.has(code) || common!.has(code))).toEqual([]);
    expect([...ui!].filter(code => common!.has(code))).toEqual([]);
  });

  it('keeps the English page off the 217 KB sans -ui file: its one Chinese label, 中文, is in -ui-extra', () => {
    const extra = range('TheoremOS Sans SC', 'NotoSansSC-ui-extra.woff2');
    expect([...'中文'].filter(character => !extra.has(character.codePointAt(0)!))).toEqual([]);
  });

  it('ships the -ui-extra files the stylesheet names', () => {
    for (const [, file] of faces) expect(fs.existsSync(path.join(import.meta.dirname, `../docs/assets/fonts/${file}-ui-extra.woff2`))).toBe(true);
    expect(fs.readFileSync(path.join(import.meta.dirname, '../scripts/build-web.ts'), 'utf8')).toContain('NotoSansSC-ui-extra.woff2');
  });
});
