import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanBundle } from '../scripts/web-i18n';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function scan(source: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-i18n-scan-')); directories.push(directory);
  const file = path.join(directory, 'fixture.tsx'); fs.writeFileSync(file, source);
  return scanBundle([file]);
}

describe('inline research translations', () => {
  it('accepts complete literal and interpolated pairs while collecting dictionary keys inside them', () => {
    const result = scan("tx('研究空间', 'Research space'); tx(`中文 ${t('嵌套标签')}`, `English ${count}`);");
    expect(result.stray).toEqual([]); expect([...result.keys.keys()]).toEqual(['嵌套标签']);
  });

  it('still rejects unpaired text, untranslated English and untranslated interpolations', () => {
    const result = scan("const label = '遗漏'; tx('中文'); tx('中文', ''); tx('中文', '仍是中文'); tx(`中文 ${'遗漏插值'}`, `English ${count}`);");
    expect(result.stray).toHaveLength(5);
    expect(result.stray.some(line => line.includes('both language values'))).toBe(true);
    expect(result.stray.some(line => line.includes('nonempty English'))).toBe(true);
    expect(result.stray.some(line => line.includes('遗漏插值'))).toBe(true);
  });
});
