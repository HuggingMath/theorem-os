import { describe, expect, it } from 'vitest';
import { archiveStudyDestination } from '../docs/web/archiveDestination';
import { finishShareLoginReturn, shareLoginDestination, shareLoginLink } from '../apps/web/client/shareContinuation';

const token = 'a'.repeat(32);
function storage() {
  const values = new Map<string, string>();
  return { setItem: (key: string, value: string) => { values.set(key, value); }, getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => { values.delete(key); }, values };
}
describe('share login continuation', () => {
  it('keeps the capability in tab storage and restores only a fixed local share destination', () => {
    const tab = storage(), link = shareLoginLink({ token, action: 'bookmark', language: 'zh' }, tab), url = new URL(link, 'https://workbench.invalid');
    expect(url.pathname).toBe('/login.html'); expect(link).not.toContain(token); expect(url.hash).toBe('');
    expect([...tab.values.values()][0]).toContain(token);
    const destination = new URL(shareLoginDestination(url.search, tab)!, url);
    expect(destination.pathname).toBe('/share.html'); expect(destination.searchParams.get('action')).toBe('bookmark');
    expect(destination.search).not.toContain(token); expect(destination.hash).toBe(`#${token}`);
    expect(shareLoginDestination(url.search, tab)).toBe(destination.pathname.slice(1) + destination.search + destination.hash);
  });
  it('retains the pending action through login reload and a locale switch, and clears it only on return', () => {
    const tab = storage(), url = new URL(shareLoginLink({ token, action: 'prepare', language: 'zh' }, tab), 'https://workbench.invalid');
    url.searchParams.set('lang', 'en');
    const destination = shareLoginDestination(url.search, tab)!;
    expect(destination).toContain('action=prepare&lang=en'); expect(shareLoginDestination(url.search, tab)).toBe(destination);
    finishShareLoginReturn(new URL(destination, url).search, tab);
    expect(shareLoginDestination(url.search, tab)).toBeUndefined(); expect(tab.values.size).toBe(0);
  });
  it('restores a recipient-owned bookmark without a capability', () => {
    const tab = storage(), url = new URL(shareLoginLink({ readingId: 'shared_reader_id', action: 'prepare', language: 'en' }, tab), 'https://workbench.invalid');
    const destination = new URL(shareLoginDestination(url.search, tab)!, url);
    expect(destination.searchParams.get('reading')).toBe('shared_reader_id'); expect(destination.hash).toBe('');
  });
  it('ignores malformed, cleared and externally directed return payloads', () => {
    const tab = storage(), nonce = '12345678-1234-4321-8123-123456789abc', search = `?shareReturn=${nonce}`;
    for (const raw of ['{', JSON.stringify({ token, action: 'delete', language: 'en' }),
      JSON.stringify({ readingId: 'https://evil.invalid', action: 'bookmark', language: 'en' }),
      JSON.stringify({ token: `${token}#bad`, action: 'bookmark', language: 'en' })]) {
      tab.setItem(`theorem-os.share-return.${nonce}`, raw); expect(shareLoginDestination(search, tab)).toBeUndefined();
    }
    expect(shareLoginDestination('?shareReturn=../../private', tab)).toBeUndefined();
    tab.setItem(`theorem-os.share-return.${nonce}`, JSON.stringify({ token, action: 'bookmark', language: 'en', url: 'https://evil.invalid' }));
    expect(shareLoginDestination(search, tab)).toMatch(/^share\.html\?/u);
    const blocked = { ...tab, getItem() { throw new Error('disabled storage'); } };
    expect(shareLoginDestination(search, blocked)).toBeUndefined();
  });
});

describe('classic archive study destinations', () => {
  it.each([['zh', '../', '/'], ['en', '../../', '/']] as const)('opens the workbench from the bundled %s archive', (locale, workbenchRoot, expectedPath) => {
    const destination = archiveStudyDestination(locale, 'case with spaces & symbols', workbenchRoot);
    const page = `https://workbench.invalid/classics/${locale === 'en' ? 'en/' : ''}archive.html`;
    const url = new URL(destination.href, page);
    expect(url.pathname).toBe(expectedPath); expect(url.searchParams.get('lang')).toBe(locale);
    expect(url.searchParams.get('fromClassic')).toBe('case with spaces & symbols');
    expect(destination.label).toBe(locale === 'zh' ? '准备自己的研究' : 'Prepare my own research');
  });
  it.each(['zh', 'en'] as const)('preserves the public %s archive access destination', locale => {
    expect(archiveStudyDestination(locale, 'classic')).toEqual({ href: 'index.html#start', label: locale === 'zh' ? '申请内测' : 'Request access' });
  });
  it('does not accept an arbitrary destination from a data attribute', () => {
    expect(archiveStudyDestination('zh', 'classic', 'https://evil.invalid/').href).toBe('index.html#start');
  });
});
