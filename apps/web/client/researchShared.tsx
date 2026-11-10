import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useId, useRef, useState } from 'preact/hooks';
import { researchContextHref, type WebSession } from '../shared';
import type { ResearcherProfile } from '../researchProjectTypes';
import { locale, localeTag, localizeMessage } from '../i18n';
import { webDraftOwner } from './ownedDrafts';

export const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
export const enc = encodeURIComponent;
export const base = '/api/research';
export type ResearchSession = { researcherId: string | null; profile: ResearcherProfile | null; authenticated: boolean };
export type ResearchContext = { session: ResearchSession; web: WebSession };
export type Item<T> = { item: T };
export type Items<T> = { items: T[]; total?: number; nextOffset?: number };
export class ResearchHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export class ResearchSessionChangedError extends ResearchHttpError {
  constructor() { super(tx('会话已更新，正在重新读取研究空间。', 'Your session changed. Reloading the research space.'), 401); }
}
type SessionBinding = { owner: string; csrfToken: string; changed: () => void; controller: AbortController };
let sessionBinding: SessionBinding | undefined;
export function bindResearchSession(web: WebSession, changed: () => void) {
  const owner = webDraftOwner(web);
  if (sessionBinding?.owner === owner && sessionBinding.csrfToken === web.csrfToken) sessionBinding.changed = changed;
  else { clearResearchSession(); sessionBinding = { owner, csrfToken: web.csrfToken, changed, controller: new AbortController() }; }
}
export function clearResearchSession() {
  // Stop old responses before they can update the next session's view.
  const previous = sessionBinding; sessionBinding = undefined; previous?.controller.abort();
}
function currentSession(binding: SessionBinding) {
  if (sessionBinding !== binding) {
    binding.controller.signal.throwIfAborted();
    throw new ResearchSessionChangedError();
  }
}
function sessionChanged(binding: SessionBinding): never {
  if (sessionBinding === binding) { clearResearchSession(); binding.changed(); }
  throw new ResearchSessionChangedError();
}
async function responseBody<T>(response: Response): Promise<T> {
  let payload: unknown;
  try { payload = response.status === 204 ? undefined : await response.json(); }
  catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    if (response.ok) throw new Error(tx('服务器响应未能完整读取，请重试。当前输入已保留。',
      'The server response could not be read completely. Please retry. Your input is preserved.'));
  }
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload ? String(payload.error) : tx('请求失败', 'Request failed');
    throw new ResearchHttpError(localizeMessage(error), response.status);
  }
  return payload as T;
}
/** Bootstrap reads do not borrow the previous page's owner or CSRF token. */
export async function readResearchWebSession(signal?: AbortSignal): Promise<WebSession> {
  const bound = sessionBinding?.controller.signal;
  const readSignal = bound ? signal ? AbortSignal.any([bound, signal]) : bound : signal;
  return responseBody(await fetch('/api/session', { headers: { Accept: 'application/json' }, signal: readSignal, credentials: 'same-origin', cache: 'no-store' }));
}
export async function readResearchSession(web: WebSession, signal?: AbortSignal): Promise<ResearchSession> {
  const response = await fetch(`${base}/session`, { headers: { Accept: 'application/json' }, signal, credentials: 'same-origin', cache: 'no-store' });
  if (response.headers.get('X-Theoremos-Owner') !== webDraftOwner(web)) throw new ResearchSessionChangedError();
  return responseBody(response);
}
async function confirmSession(binding: SessionBinding, signal?: AbortSignal) {
  const web = await readResearchWebSession(signal);
  currentSession(binding);
  if (webDraftOwner(web) !== binding.owner) sessionChanged(binding);
  if (web.csrfToken !== binding.csrfToken) {
    // Reauthentication keeps the person's draft, but its old session must stop delivering responses.
    bindResearchSession(web, binding.changed);
    throw new Error(tx('登录状态已更新，请重试。当前输入已保留。', 'Your sign-in was renewed. Please retry. Your input is preserved.'));
  }
}
export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const binding = sessionBinding;
  if (!binding) throw new ResearchSessionChangedError();
  const signal = init.signal ? AbortSignal.any([binding.controller.signal, init.signal]) : binding.controller.signal;
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (method !== 'GET' && method !== 'HEAD') {
    // The cookie may have changed in another tab. Never pair a new owner's token with an old form.
    await confirmSession(binding, signal);
    headers.set('X-CSRF-Token', binding.csrfToken);
  }
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  currentSession(binding);
  const response = await fetch(url, { ...init, method, headers, signal, credentials: 'same-origin', cache: 'no-store' });
  currentSession(binding);
  const owner = response.headers.get('X-Theoremos-Owner');
  if (owner && owner !== binding.owner) sessionChanged(binding);
  // A signed-out public read has no owner header. Confirm it before displaying its data in a private page.
  if (!owner && (response.ok || response.status === 401 || response.status === 403)) await confirmSession(binding, signal);
  const result = await responseBody<T>(response);
  currentSession(binding);
  return result;
}
export const errorText = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
  ? tx('登录状态已更新，请重试。当前输入已保留。', 'Your sign-in was renewed. Please retry. Your input is preserved.')
  : error instanceof Error ? error.message : tx('请求失败，请重试。', 'Request failed. Please retry.');

/** Retain the last successful view during refreshes; forms keep their own local draft. */
export function useResource<T>(url: string | undefined, interval = 0) {
  const [value, setValue] = useState<{ url?: string; data?: T; error?: string; errorStatus?: number; loading: boolean }>({ loading: Boolean(url) });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!url) { setValue({ loading: false }); return; }
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const read = async () => {
      setValue(previous => ({ ...previous, loading: previous.url !== url || !previous.data }));
      try {
        const data = await api<T>(url, { signal: controller.signal });
        if (live) setValue({ url, data, loading: false });
      } catch (error) {
        if (live && !controller.signal.aborted && sessionBinding && (error instanceof ResearchSessionChangedError ||
          error instanceof DOMException && error.name === 'AbortError')) {
          // Same-owner reauthentication keeps this component; restore reads cancelled with its old session.
          void read(); return;
        }
        const unavailable = error instanceof ResearchHttpError && [401, 403, 404].includes(error.status);
        if (live) setValue(previous => ({ url, data: previous.url === url && !unavailable ? previous.data : undefined,
          error: errorText(error), errorStatus: error instanceof ResearchHttpError ? error.status : undefined, loading: false }));
      }
      if (live && interval) timer = setTimeout(() => void read(), interval);
    };
    void read();
    return () => { live = false; controller.abort(); clearTimeout(timer); };
  }, [url, revision, interval]);
  return { data: value.url === url ? value.data : undefined, error: value.url === url ? value.error : undefined, errorStatus: value.url === url ? value.errorStatus : undefined,
    loading: value.url !== url ? Boolean(url) : value.loading, refresh };
}

/** Reuse the request identity if a failed or uncertain request is retried unchanged. */
export function useMutation() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const pending = useRef<{ signature: string; method: string; url: string; body: Record<string, unknown> }>();
  const lock = useRef(false);
  async function run<T>(method: string, url: string, input: Record<string, unknown>, completed?: (result: T) => void) {
    if (lock.current) return;
    const { expectedRevision: _revision, ...intent } = input;
    const signature = JSON.stringify([method, url, intent]);
    if (pending.current?.signature !== signature) pending.current = { signature, method, url, body: { ...input, requestId: crypto.randomUUID() } };
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = await api<T>(url, { method, body: JSON.stringify(pending.current.body) });
      pending.current = undefined;
      setMessage(tx('已保存。', 'Saved.')); completed?.(result);
      return result;
    } catch (cause) { if (cause instanceof ResearchHttpError && cause.status < 500) pending.current = undefined; setError(errorText(cause)); return undefined; }
    finally { lock.current = false; setBusy(false); }
  }
  function retry<T>(completed?: (result: T) => void) {
    if (!pending.current) return;
    const { method, url, body } = pending.current, { requestId: _requestId, ...input } = body;
    return run<T>(method, url, input, completed);
  }
  function reset() { pending.current = undefined; setError(''); setMessage(''); }
  return { busy, error, message, run, retry, reset, canRetry: Boolean(pending.current) && !busy, setMessage, setError };
}
export function MutationState({ action }: { action: ReturnType<typeof useMutation> }) {
  return <>{action.error && <ErrorBox message={action.error} />}{action.message && <p class="research-status" role="status">{action.message}</p>}</>;
}
export function ErrorBox({ message }: { message?: string }) { return message ? <p class="research-error" role="alert">{message}</p> : null; }
export function Empty({ children }: { children: ComponentChildren }) { return <p class="research-empty">{children}</p>; }
export function Panel({ title, note, actions, children, id }: { title: string; note?: string; actions?: ComponentChildren; children: ComponentChildren; id?: string }) {
  return <section class="research-panel" id={id}><div class="research-section-head"><div><h2>{title}</h2>{note && <p>{note}</p>}</div>{actions}</div>{children}</section>;
}
export function Field({ label, value, onInput, multiline, code, rows, required, placeholder, note, maxLength, type = 'text' }: {
  label: string; value: string; onInput: (value: string) => void; multiline?: boolean; code?: boolean; rows?: number;
  required?: boolean; placeholder?: string; note?: string; maxLength?: number; type?: string;
}) {
  const id = useId(), titleId = `${id}-title`, noteId = note ? `${id}-note` : undefined;
  return <label class="research-field"><span id={titleId}>{label}</span>{multiline
    ? <textarea value={value} onInput={event => onInput(event.currentTarget.value)} rows={rows ?? 4} required={required}
      aria-labelledby={titleId} aria-describedby={noteId} class={code ? 'research-code' : undefined} spellcheck={!code} placeholder={placeholder} maxLength={maxLength} />
    : <input type={type} value={value} onInput={event => onInput(event.currentTarget.value)} aria-labelledby={titleId} aria-describedby={noteId}
      required={required} placeholder={placeholder} maxLength={maxLength} />}
    {note && <span id={noteId} class="research-field-note">{note}</span>}</label>;
}
export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label class="research-check"><input type="checkbox" checked={checked} onChange={event => onChange(event.currentTarget.checked)} />{label}</label>;
}
export function Search({ label, initial = '', value, onInput, onSearch }: {
  label: string; initial?: string; value?: string; onInput?: (value: string) => void; onSearch: (value: string) => void;
}) {
  const [draft, setDraft] = useState(initial), id = useId(), query = value ?? draft;
  return <div class="research-search" role="search"><label class="sr-only" htmlFor={id}>{label}</label><input id={id} type="search" value={query}
      placeholder={label} onInput={event => { setDraft(event.currentTarget.value); onInput?.(event.currentTarget.value); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onSearch(query.trim()); } }} maxLength={128} />
    <button class="button" type="button" onClick={() => onSearch(query.trim())}>{tx('搜索', 'Search')}</button></div>;
}
const statusNames: Record<string, [string, string]> = {
  private: ['仅自己', 'Private'], public: ['公开', 'Public'], members: ['成员可见', 'Members'],
  queued: ['排队中', 'Queued'], running: ['进行中', 'Running'], completed: ['已完成', 'Completed'],
  validating: ['正在校验', 'Validating'], failed: ['失败', 'Failed'], cancelled: ['已取消', 'Cancelled'],
  'not-sent': ['未投递', 'Not sent'], delivered: ['已送达', 'Delivered'], deferred: ['暂缓投递', 'Deferred'],
  unknown: ['待核对', 'Unknown'], pending: ['待判断', 'Pending'], accepted: ['已采纳', 'Accepted'], declined: ['未采纳', 'Declined'],
  'needs-info': ['需补充信息', 'Needs information'], 'not-recorded': ['尚无采纳记录', 'No decision recorded'],
  'not-started': ['尚未执行', 'Not started'], superseded: ['已被新版本替代', 'Superseded'],
  mathematics: ['数学成果', 'Mathematics'], agent: ['Agent', 'Agent'], skill: ['Skill', 'Skill'],
  discussion: ['讨论', 'Discussion'], guidance: ['数学指导', 'Guidance'], 'plan-edit': ['计划修改', 'Plan edit'],
  'route-control': ['路线调整', 'Route change'], 'plan-approval': ['计划批准', 'Plan approval'], 'proof-submission': ['候选证明', 'Proof submission'],
};
export const nameOf = (value: string) => statusNames[value] ? tx(...statusNames[value]!) : localizeMessage(value);
export const stamp = (value: string) => new Date(value).toLocaleString(localeTag, { dateStyle: 'medium', timeStyle: 'short' });
export const words = (value: string) => value.split(/[,，\n]/u).map(item => item.trim()).filter(Boolean);
export const lines = (value: string) => value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean);
export function State({ value }: { value: string }) { return <span class="research-state" data-state={value}>{nameOf(value)}</span>; }
export function Tags({ values }: { values: string[] }) { return <div class="research-chips">{values.map(value => <span class="research-chip" key={value}>{value}</span>)}</div>; }
export const theoremHref = (id: string, runId?: string, target?: { statementVersionId?: string; taskRef?: { id: string; version: string }; feedbackId?: string }) =>
  researchContextHref(`theorems.html?id=${enc(id)}${runId ? `&run=${enc(runId)}` : ''}${target?.statementVersionId ? `&version=${enc(target.statementVersionId)}` : ''}`
  + `${target?.taskRef ? `&task=${enc(target.taskRef.id)}&taskVersion=${enc(target.taskRef.version)}` : ''}${target?.feedbackId ? `#feedback-${enc(target.feedbackId)}` : ''}`, location.search);
export const personHref = (id: string) => researchContextHref(`people.html?id=${enc(id)}`, location.search);
export const libraryHref = (id: string, version?: string) => researchContextHref(`library.html?entry=${enc(id)}${version ? `&version=${enc(version)}` : ''}`, location.search);
export function FollowButton({ kind, id, initial = false }: { kind: 'person' | 'theorem'; id: string; initial?: boolean }) {
  const [followed, setFollowed] = useState(initial), action = useMutation();
  useEffect(() => setFollowed(initial), [id, initial]);
  return <div><button type="button" class="button" disabled={action.busy} aria-pressed={followed}
    onClick={() => void action.run(followed ? 'DELETE' : 'POST', `${base}/follows/${kind}/${enc(id)}`, { following: !followed }, () => setFollowed(value => !value))}>
    {action.busy ? tx('正在保存…', 'Saving…') : followed ? tx('已关注', 'Following') : tx('关注', 'Follow')}</button><ErrorBox message={action.error} /></div>;
}
