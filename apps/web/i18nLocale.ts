export type Locale = 'zh' | 'en';
export const localeStorageKey = 'theorem-os.web-locale.v1';
const browser = typeof window !== 'undefined' && typeof document !== 'undefined';

function detect(): Locale {
  if (!browser) return 'zh';
  const linked = new URLSearchParams(window.location?.search ?? '').get('lang');
  if (linked === 'zh' || linked === 'en') {
    try { localStorage.setItem(localeStorageKey, linked); } catch { /* The address still selects this page's language. */ }
    return linked;
  }
  try {
    const saved = localStorage.getItem(localeStorageKey);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch { /* Storage may be blocked; fall back to the browser language. */ }
  return (navigator.languages?.[0] ?? navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export const locale: Locale = detect();
/** The tag Intl formatters and the html lang attribute use. */
export const localeTag = locale === 'en' ? 'en-US' : 'zh-CN';

