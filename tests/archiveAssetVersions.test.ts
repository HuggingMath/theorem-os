import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveAssetVersions, versionArchivePage } from '../scripts/site-archive';

describe('archive asset versions', () => {
  let output: string;
  beforeEach(() => {
    output = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-archive-assets-'));
    fs.writeFileSync(path.join(output, 'site.js'), 'window.archive = 1;');
    fs.writeFileSync(path.join(output, 'process.css'), '.process { color: green; }');
  });
  afterEach(() => fs.rmSync(output, { recursive: true, force: true }));

  it('uses stable versions of the final bytes and changes only the modified asset version', () => {
    const initial = archiveAssetVersions(output);
    expect(archiveAssetVersions(output)).toEqual(initial);

    fs.writeFileSync(path.join(output, 'site.js'), 'window.archive = 2;');
    const changedScript = archiveAssetVersions(output);
    expect(changedScript['site.js']).not.toBe(initial['site.js']);
    expect(changedScript['process.css']).toBe(initial['process.css']);

    fs.writeFileSync(path.join(output, 'process.css'), '.process { color: blue; }');
    const changedStyle = archiveAssetVersions(output);
    expect(changedStyle['site.js']).toBe(changedScript['site.js']);
    expect(changedStyle['process.css']).not.toBe(changedScript['process.css']);
  });

  it('keeps the relative archive asset paths in both locales', () => {
    const versions = archiveAssetVersions(output);
    for (const prefix of ['', '../', './']) {
      const page = `<link rel="stylesheet" href="${prefix}process.css"><script src="${prefix}site.js" defer></script>`;
      expect(versionArchivePage(page, versions)).toBe(
        `<link rel="stylesheet" href="${prefix}process.css?v=${versions['process.css']}"><script src="${prefix}site.js?v=${versions['site.js']}" defer></script>`);
    }
  });

  it('replaces existing versions without duplicates and preserves other query parameters and fragments', () => {
    const versions = archiveAssetVersions(output);
    const page = '<script src="../site.js?lang=zh&amp;v=old&amp;v=older#archive" defer></script>';
    const versioned = versionArchivePage(page, versions);
    expect(versioned).toBe(`<script src="../site.js?lang=zh&amp;v=${versions['site.js']}#archive" defer></script>`);
    expect(versionArchivePage(versioned, versions)).toBe(versioned);
    expect(versionArchivePage(versioned, { ...versions, 'site.js': 'updated' })).toBe(
      '<script src="../site.js?lang=zh&amp;v=updated#archive" defer></script>');
  });

  it('leaves unrelated assets and external or absolute URLs unchanged', () => {
    const page = '<link href="site.css"><script src="landing.js"></script><script src="https://example.com/site.js"></script>'
      + '<script src="/site.js"></script><link href="assets/process.css"><div data-src="site.js"></div>';
    expect(versionArchivePage(page, archiveAssetVersions(output))).toBe(page);
  });
});
