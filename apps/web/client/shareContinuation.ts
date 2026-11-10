import { webShareToken } from '../shareTypes';

const returnPrefix = 'theorem-os.share-return.';
const key = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
export type ShareReturnContext = { token?: string; readingId?: string; action: 'bookmark' | 'prepare'; language: 'zh' | 'en' };
type ReturnStorage = Pick<Storage, 'setItem' | 'getItem' | 'removeItem'>;

/** Only a tab-local nonce travels through login. The share capability stays out of request URLs. */
export function shareLoginLink(context: ShareReturnContext, storage: ReturnStorage = sessionStorage) {
  if ((!context.token || !webShareToken.test(context.token)) && (!context.readingId || !key.test(context.readingId))) throw new Error('share_return_invalid');
  const nonce = crypto.randomUUID();
  storage.setItem(`${returnPrefix}${nonce}`, JSON.stringify(context));
  return `login.html?${new URLSearchParams({ shareReturn: nonce, lang: context.language })}`;
}
/** Called by login before its normal workbench destination. No stored URL can become an open redirect. */
export function shareLoginDestination(search: string, storage: ReturnStorage = sessionStorage): string | undefined {
  const incoming = new URLSearchParams(search), nonce = incoming.get('shareReturn');
  if (!nonce || !/^[a-f0-9-]{36}$/u.test(nonce)) return;
  try {
    const raw = storage.getItem(`${returnPrefix}${nonce}`);
    if (!raw) return;
    const context = JSON.parse(raw) as ShareReturnContext;
    if (!['bookmark', 'prepare'].includes(context.action) || !['zh', 'en'].includes(context.language)) return;
    const requestedLanguage = incoming.get('lang');
    const params = new URLSearchParams({ action: context.action,
      lang: requestedLanguage === 'zh' || requestedLanguage === 'en' ? requestedLanguage : context.language, shareReturn: nonce });
    if (context.token && webShareToken.test(context.token)) return `share.html?${params}#${context.token}`;
    if (context.readingId && key.test(context.readingId)) { params.set('reading', context.readingId); return `share.html?${params}`; }
  } catch { /* A blocked or cleared tab store leaves the normal login destination available. */ }
}
/** Clear only after the return page is reached, so a language switch during login can still restore context. */
export function finishShareLoginReturn(search: string, storage: ReturnStorage = sessionStorage) {
  const nonce = new URLSearchParams(search).get('shareReturn');
  if (nonce && /^[a-f0-9-]{36}$/u.test(nonce)) try { storage.removeItem(`${returnPrefix}${nonce}`); } catch { /* Tab storage may be unavailable. */ }
}
