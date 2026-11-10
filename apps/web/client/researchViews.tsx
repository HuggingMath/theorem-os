import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { locale, mountLocaleSwitch, t } from '../i18n';
import { PeoplePage } from './researchPeople';
import { TheoremsPage } from './researchTheorems';
import { LibraryPage } from './researchLibrary';
import { WorkspacePage } from './researchWorkspace';
import { ProblemPage } from './researchProblem';
import { ResearchInvitePage } from './researchInvite';
import { bindResearchSession, clearResearchSession, errorText, ErrorBox, readResearchSession, readResearchWebSession,
  ResearchSessionChangedError, tx, type ResearchContext } from './researchShared';
import { webDraftOwner } from './ownedDrafts';
import { loginHref, researchContextHref, researchNavigation } from '../shared';

const page = document.body.dataset.researchPage ?? 'people';
const pageNames = { workspace: ['我的研究', 'My research'], theorems: ['定理', 'Theorems'], people: ['数学家', 'Mathematicians'], library: ['Library', 'Library'] } as const;
function Header() {
  const language = useRef<HTMLButtonElement>(null);
  const navigation = researchNavigation(location.search);
  useEffect(() => { if (language.current) mountLocaleSwitch(language.current); }, []);
  return <header class="topbar"><a class="brand" href={navigation.workbench} aria-label="TheoremOS"><img src="assets/mark.svg" alt="" width="26" height="26" />
    <span>Theorem<span class="brand-os">OS</span></span></a><nav class="research-nav" aria-label={tx('研究空间', 'Research space')}>
    <a href={navigation.workbench}>{tx('工作台', 'Workbench')}</a>
    {Object.entries(pageNames).map(([id, label]) => <a key={id} href={navigation[id as keyof typeof pageNames]} aria-current={page === id ? 'page' : undefined}>{tx(label[0], label[1])}</a>)}
    <a href={researchContextHref("workspace.html?tab=help", location.search)}>{tx('帮助', 'Help')}</a></nav><button ref={language} type="button" class="text-button locale-switch" /></header>;
}
export function ResearchApp() {
  const [context, setContext] = useState<ResearchContext>(), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(true), [verifyingOwner, setVerifyingOwner] = useState(false), current = useRef<ResearchContext>();
  const confirmation = useRef<AbortController>();
  const loginParameters = new URLSearchParams(location.search);
  loginParameters.set('lang', locale);
  const loginAddress = loginHref(`${location.pathname}?${loginParameters}${location.hash}`);
  current.current = context;
  const changed = useCallback(() => {
    confirmation.current?.abort(); clearResearchSession(); current.current = undefined;
    setContext(undefined); setVerifyingOwner(false); setError(''); setAttempt(value => value + 1);
  }, []);
  // Install the next owner's API binding only after the previous owner's components have unmounted.
  useLayoutEffect(() => { if (context) bindResearchSession(context.web, changed); else clearResearchSession(); }, [context, changed]);
  useEffect(() => () => clearResearchSession(), []);
  useEffect(() => {
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
    const label = pageNames[page as keyof typeof pageNames] ?? pageNames.people;
    document.title = `${page === 'problem' ? t('题目工作区') : page === 'invite' ? tx('研究邀请', 'Research invitation') : tx(label[0], label[1])} · TheoremOS`;
    const skip = document.querySelector('.skip-link'); if (skip) skip.textContent = tx('跳到主要内容', 'Skip to main content');
    let live = true, pending: Promise<void> | undefined;
    const controller = new AbortController();
    confirmation.current = controller;
    const read = () => {
      if (pending) return pending;
      setChecking(true);
      pending = (async () => {
        try {
          // A delayed bootstrap may describe an anonymous session while the browser has already signed in.
          // Verify the complete pair before replacing an owner's components, with one fresh read on mismatch.
          for (let check = 0; check < 2; check++) {
            const web = await readResearchWebSession(controller.signal);
            if (!live || controller.signal.aborted) return;
            const previous = current.current;
            if (previous && webDraftOwner(previous.web) === webDraftOwner(web)) {
              bindResearchSession(web, changed); setContext({ ...previous, web });
            } else {
              if (previous) setVerifyingOwner(true);
              let session: ResearchContext['session'];
              try { session = await readResearchSession(web, controller.signal); }
              catch (cause) { if (check === 0 && cause instanceof ResearchSessionChangedError) continue; throw cause; }
              if (!live || controller.signal.aborted) return;
              clearResearchSession(); current.current = undefined; setContext({ web, session });
            }
            setVerifyingOwner(false); setError(''); return;
          }
        } catch (cause) {
          if (live && !controller.signal.aborted) {
            if (cause instanceof DOMException && cause.name === 'AbortError') setAttempt(value => value + 1);
            else setError(errorText(cause));
          }
        } finally { if (live) { pending = undefined; setChecking(false); } }
      })();
      return pending;
    };
    const resume = () => { if (!document.hidden) void read(); };
    const restore = (event: PageTransitionEvent) => { if (event.persisted) resume(); };
    const accountLeft = (event: StorageEvent) => {
      if (event.key !== 'theorem-os.web-account-left.v1' || !event.newValue) return;
      try {
        const owner: unknown = JSON.parse(event.newValue).owner;
        if (typeof owner === 'string' && (!current.current || owner === webDraftOwner(current.current.web))) changed();
      } catch { /* Ignore invalid notifications. */ }
    };
    window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', restore); window.addEventListener('storage', accountLeft);
    const timer = setInterval(resume, 15000);
    void read();
    return () => {
      live = false; controller.abort(); clearInterval(timer);
      if (confirmation.current === controller) confirmation.current = undefined;
      window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', restore); window.removeEventListener('storage', accountLeft);
    };
  }, [attempt, changed]);
  const draftNeedsLogin = page === 'theorems' && loginParameters.has('accountDraft') && Boolean(context && !context.session.authenticated);
  const unavailable = Boolean(error) || !context || verifyingOwner || draftNeedsLogin;
  return <><Header /><main id="main" class={context ? 'research-shell' : 'research-loading'} tabIndex={-1} aria-busy={checking}>
    {context && !draftNeedsLogin && <div class={unavailable ? 'research-session-pending' : undefined} aria-hidden={unavailable} inert={unavailable} key={webDraftOwner(context.web)}>
      {page === 'invite' ? <ResearchInvitePage context={context} /> : page === 'problem' ? <ProblemPage context={context} /> : page === 'workspace' ? <WorkspacePage context={context} /> : page === 'theorems' ? <TheoremsPage context={context} /> : page === 'library' ? <LibraryPage context={context} /> : <PeoplePage context={context} />}
    </div>}
    {unavailable && <div class="research-session-notice">{error ? <><ErrorBox message={error} /><div class="research-actions">
    <button class="button" type="button" onClick={() => setAttempt(value => value + 1)}>{tx('重新连接', 'Reconnect')}</button>
    <a class="button" href={loginAddress}>{tx('登录', 'Sign in')}</a></div></> : draftNeedsLogin ? <><p>{tx('登录后恢复这份账号草稿。', 'Sign in to restore this account draft.')}</p>
      <a class="button" href={loginAddress} data-account-draft-login>{tx('登录', 'Sign in')}</a></> : <p role="status">{tx('正在读取研究空间…', 'Loading the research space…')}</p>}</div>}
  </main></>;
}
