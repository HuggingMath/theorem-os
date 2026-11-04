import { locale } from '../i18n';

/** The same read-only library is available to every account, without a model key or a personal run. */
export const classicLibraryUrl = `classics/${locale === 'en' ? 'en/' : ''}archive.html#status=verified`;
