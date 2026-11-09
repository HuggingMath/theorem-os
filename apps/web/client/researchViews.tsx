import { useEffect, useRef, useState } from 'preact/hooks';
import type { WebSession } from '../shared';
import { locale, mountLocaleSwitch } from '../i18n';
import { PeoplePage } from './researchPeople';
import { TheoremsPage } from './researchTheorems';
import { LibraryPage } from './researchLibrary';
import { api, base, errorText, ErrorBox, setResearchCsrf, tx, type ResearchContext, type ResearchSession } from './researchShared';

const page = document.body.dataset.researchPage ?? 'people';
const pageNames = { people: ['数学家', 'Mathematicians'], theorems: ['定理', 'Theorems'], library: ['Library', 'Library'] } as const;
function Header() {
  const language = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (language.current) mountLocaleSwitch(language.current); }, []);
  return <header class="topbar"><a class="brand" href="./" aria-label="TheoremOS"><img src="assets/mark.svg" alt="" width="26" height="26" />
    <span>Theorem<span class="brand-os">OS</span></span></a><nav class="research-nav" aria-label={tx('研究空间', 'Research space')}>
    {Object.entries(pageNames).map(([id, label]) => <a key={id} href={`${id}.html`} aria-current={page === id ? 'page' : undefined}>{tx(label[0], label[1])}</a>)}
    <a href="./">{tx('工作台', 'Workbench')}</a></nav><button ref={language} type="button" class="text-button locale-switch" /></header>;
}
export function ResearchApp() {
  const [context, setContext] = useState<ResearchContext>(), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
    const label = pageNames[page as keyof typeof pageNames] ?? pageNames.people;
    document.title = `${tx(label[0], label[1])} · TheoremOS`;
    const skip = document.querySelector('.skip-link'); if (skip) skip.textContent = tx('跳到主要内容', 'Skip to main content');
    let live = true;
    void (async () => {
      try {
        const web = await api<WebSession>('/api/session');
        setResearchCsrf(web.csrfToken);
        const session = await api<ResearchSession>(`${base}/session`);
        if (!live) return;
        setResearchCsrf(web.csrfToken); setContext({ web, session }); setError('');
      } catch (cause) { if (live) setError(errorText(cause)); }
    })();
    return () => { live = false; };
  }, [attempt]);
  return <><Header />{context ? <main id="main" class="research-shell" tabIndex={-1}>
    {page === 'theorems' ? <TheoremsPage context={context} /> : page === 'library' ? <LibraryPage context={context} /> : <PeoplePage context={context} />}
  </main> : <main id="main" class="research-loading" tabIndex={-1}>{error ? <><ErrorBox message={error} /><div class="research-actions">
    <button class="button" type="button" onClick={() => setAttempt(value => value + 1)}>{tx('重新连接', 'Reconnect')}</button>
    <a class="button" href="login.html">{tx('登录', 'Sign in')}</a></div></> : <p role="status">{tx('正在读取研究空间…', 'Loading the research space…')}</p>}</main>}</>;
}
