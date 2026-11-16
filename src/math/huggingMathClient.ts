import fs from 'node:fs';
import path from 'node:path';
import { mathDigest, readMathText, writeMathJsonDurable } from './mathRuntimeIo';
import { assertMathCanonicalPath } from './paths';

export type HubSessionProfile = {
  schema: 'theorem-os.huggingmath-session.v1';
  baseUrl: string;
  cookies: Record<string, string>;
};
export type HubJson = Record<string, unknown>;
export type HubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type HubAttachment = { bytes: Uint8Array; sha256: string; contentType: string };
type HubErrorBody = { error?: string; detail?: string; problems?: string[] };

/** A failed mutation may have committed. The caller owns its saved batch/plan/key. */
export class HuggingMathHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: HubErrorBody) {
    super(message);
    this.name = 'HuggingMathHttpError';
  }
}

const profileSchema = 'theorem-os.huggingmath-session.v1';
const cookieName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const cookieValue = /^[^\x00-\x20\x7f;]*$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const attachmentPath = /^[A-Za-z0-9_][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._+-]*)*$/u;
const hash = /^[a-f0-9]{64}$/u;
const maxArchiveBytes = 40 * 1024 * 1024;
const maxAttachmentBytes = 4 * 1024 * 1024;

function baseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('huggingmath_base_url_invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error('huggingmath_base_url_invalid');
  return parsed.href.replace(/\/+$/u, '');
}

function profile(value: unknown): HubSessionProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('huggingmath_session_profile_invalid');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['schema', 'baseUrl', 'cookies'].includes(key)) ||
      record.schema !== profileSchema || typeof record.baseUrl !== 'string' ||
      !record.cookies || typeof record.cookies !== 'object' || Array.isArray(record.cookies))
    throw new Error('huggingmath_session_profile_invalid');
  const cookies = Object.fromEntries(Object.entries(record.cookies));
  if (Object.entries(cookies).some(([key, value]) => !cookieName.test(key) || typeof value !== 'string' || !cookieValue.test(value)) ||
      !cookies.sessionid || !cookies.csrftoken)
    throw new Error('huggingmath_session_profile_invalid');
  return { schema: profileSchema, baseUrl: baseUrl(record.baseUrl), cookies: cookies as Record<string, string> };
}

/** Profiles are operator-owned credentials, kept outside Skill and research artifacts. */
export function readHubSessionProfile(file: string): HubSessionProfile {
  const absolute = path.resolve(file);
  assertMathCanonicalPath(absolute);
  if ((fs.lstatSync(absolute).mode & 0o077) !== 0) throw new Error('huggingmath_session_profile_permissions');
  const text = readMathText(absolute, 64 * 1024);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('huggingmath_session_profile_invalid'); }
  return profile(value);
}

export function writeHubSessionProfile(file: string, value: HubSessionProfile): void {
  const absolute = path.resolve(file), normalized = profile(value);
  assertMathCanonicalPath(absolute);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  writeMathJsonDurable(absolute, normalized, 0o600);
}

function applyCookies(cookies: Record<string, string>, response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0]!, at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at), value = pair.slice(at + 1);
    if (!cookieName.test(name) || !cookieValue.test(value)) continue;
    if (!value || /;\s*max-age=0(?:;|$)/iu.test(header)) delete cookies[name];
    else cookies[name] = value;
  }
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ');
}

function redact(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text;
}

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HuggingMathHttpError(response.status, 'response_too_large', 'huggingmath_response_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function httpError(response: Response, secrets: readonly string[]): Promise<HuggingMathHttpError> {
  const isJson = /^application\/json(?:;|$)/iu.test(response.headers.get('Content-Type') ?? '');
  if (!isJson) {
    await response.body?.cancel();
    return new HuggingMathHttpError(response.status, response.status === 403 ? 'csrf_or_access_denied' : 'http_error',
      response.status === 403 ? 'huggingmath_http_403: CSRF or access denied (HTML response); refresh the session and CSRF token' :
        `huggingmath_http_${response.status}: non-JSON response`);
  }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 16 * 1024))); }
  catch { return new HuggingMathHttpError(response.status, 'http_error', `huggingmath_http_${response.status}: invalid or oversized error response`); }
  const details: HubErrorBody = {};
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const object = body as Record<string, unknown>;
    if (typeof object.error === 'string') details.error = redact(object.error, secrets).slice(0, 400);
    if (typeof object.detail === 'string') details.detail = redact(object.detail, secrets).slice(0, 1600);
    if (Array.isArray(object.problems)) details.problems = object.problems.filter((v): v is string => typeof v === 'string')
      .slice(0, 16).map(value => redact(value, secrets).slice(0, 400));
  }
  return new HuggingMathHttpError(response.status, 'http_error',
    `huggingmath_http_${response.status}` + (details.error ? `: ${details.error}` : '') + (details.detail ? `: ${details.detail}` : ''), details);
}

async function request(fetcher: HubFetch, url: string, cookies: Record<string, string>, init: RequestInit,
  extraSecrets: readonly string[] = []): Promise<Response> {
  const headers = new Headers(init.headers);
  if (Object.keys(cookies).length) headers.set('Cookie', cookieHeader(cookies));
  let response: Response;
  try { response = await fetcher(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) }); }
  catch { throw new HuggingMathHttpError(0, 'network_error', 'huggingmath_network_error: request outcome may be unknown; retain the original batch, plan and key'); }
  const secrets = [...Object.values(cookies), ...extraSecrets];
  applyCookies(cookies, response);
  if (response.status >= 300 && response.status < 400) return response;
  if (!response.ok) throw await httpError(response, [...secrets, ...Object.values(cookies)]);
  return response;
}

/** Ordinary Django form login, including the CSRF rotation at successful authentication. */
export async function loginHuggingMath(url: string, username: string, password: string,
  fetcher: HubFetch = globalThis.fetch): Promise<HubSessionProfile> {
  const base = baseUrl(url), login = base + '/accounts/login/', cookies: Record<string, string> = {};
  if (!username.trim() || !password) throw new Error('huggingmath_login_credentials_required');
  const form = await request(fetcher, login, cookies, { method: 'GET' });
  if (!form.ok) throw new HuggingMathHttpError(form.status, 'unexpected_redirect', 'huggingmath_login_unexpected_redirect');
  await form.body?.cancel();
  if (!cookies.csrftoken) throw new Error('huggingmath_login_csrf_cookie_missing');
  const response = await request(fetcher, login, cookies, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: new URL(base).origin, Referer: login },
    body: new URLSearchParams({ username, password, csrfmiddlewaretoken: cookies.csrftoken }) }, [password]);
  const location = response.headers.get('Location');
  await response.body?.cancel();
  if (![302, 303].includes(response.status) || !cookies.sessionid || !cookies.csrftoken)
    throw new HuggingMathHttpError(response.status, 'login_failed', 'huggingmath_login_failed: check the supplied account credentials');
  let redirect: URL | undefined;
  try { if (location) redirect = new URL(location, login); } catch { /* Reject malformed redirects without exposing their value. */ }
  if (!redirect || redirect.origin !== new URL(base).origin)
    throw new HuggingMathHttpError(response.status, 'unexpected_redirect', 'huggingmath_login_unexpected_redirect');
  return profile({ schema: profileSchema, baseUrl: base, cookies });
}

export class HuggingMathClient {
  readonly profile: HubSessionProfile;
  constructor(value: HubSessionProfile, private readonly fetcher: HubFetch = globalThis.fetch) { this.profile = profile(value); }

  private async json(pathname: string, init: RequestInit = {}): Promise<HubJson> {
    const headers = new Headers(init.headers), method = init.method ?? 'GET';
    headers.set('Accept', 'application/json');
    if (method !== 'GET') {
      const csrf = this.profile.cookies.csrftoken;
      if (!csrf) throw new Error('huggingmath_session_csrf_missing');
      headers.set('X-CSRFToken', csrf);
      headers.set('Origin', new URL(this.profile.baseUrl).origin);
      headers.set('Referer', this.profile.baseUrl + '/');
    }
    const response = await request(this.fetcher, this.profile.baseUrl + pathname, this.profile.cookies, { ...init, headers });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HuggingMathHttpError(response.status, 'unexpected_redirect', 'huggingmath_unexpected_redirect: renew the session or check the base URL');
    }
    if (!/^application\/json(?:;|$)/iu.test(response.headers.get('Content-Type') ?? '')) {
      await response.body?.cancel();
      throw new HuggingMathHttpError(response.status, 'invalid_response', 'huggingmath_expected_json_response');
    }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(response, 8 * 1024 * 1024))); }
    catch (error) {
      if (error instanceof HuggingMathHttpError) throw error;
      throw new HuggingMathHttpError(response.status, 'invalid_response', 'huggingmath_invalid_json_response');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new HuggingMathHttpError(response.status, 'invalid_response', 'huggingmath_expected_json_object');
    return body as HubJson;
  }

  async preview(zip: Uint8Array, owner?: string): Promise<HubJson> {
    if (zip.byteLength > maxArchiveBytes) throw new Error('huggingmath_archive_too_large');
    const body = new FormData();
    body.set('bundle', new Blob([Uint8Array.from(zip)], { type: 'application/zip' }), 'bundle.zip');
    if (owner !== undefined) body.set('owner', owner);
    return this.json('/api/imports/preview', { method: 'POST', body });
  }

  batch(id: string): Promise<HubJson> {
    if (!identifier.test(id)) throw new Error('huggingmath_batch_id_invalid');
    return this.json(`/api/imports/${encodeURIComponent(id)}`);
  }

  apply(id: string, planDigest: string, key: string): Promise<HubJson> {
    if (!identifier.test(id) || !hash.test(planDigest) || !/^[A-Za-z0-9._:-]{8,128}$/u.test(key))
      throw new Error('huggingmath_apply_identity_invalid');
    return this.json(`/api/imports/${encodeURIComponent(id)}/apply`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan_digest: planDigest, idempotency_key: key }) });
  }

  record(id: string): Promise<HubJson> {
    if (!identifier.test(id)) throw new Error('huggingmath_record_id_invalid');
    return this.json(`/api/imports/records/${encodeURIComponent(id)}`);
  }

  async attachment(recordId: string, file: string): Promise<HubAttachment> {
    if (!identifier.test(recordId) || !attachmentPath.test(file) || file.length > 255)
      throw new Error('huggingmath_attachment_identity_invalid');
    const encoded = file.split('/').map(encodeURIComponent).join('/');
    const response = await request(this.fetcher,
      `${this.profile.baseUrl}/api/imports/records/${encodeURIComponent(recordId)}/files/${encoded}`, this.profile.cookies, { method: 'GET' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HuggingMathHttpError(response.status, 'unexpected_redirect', 'huggingmath_unexpected_redirect');
    }
    const contentType = response.headers.get('Content-Type') ?? '', expected = response.headers.get('X-HM-Content-SHA256') ?? '';
    if (!/^text\/plain(?:;|$)/iu.test(contentType) || !hash.test(expected)) {
      await response.body?.cancel();
      throw new HuggingMathHttpError(response.status, 'invalid_attachment', 'huggingmath_attachment_headers_invalid');
    }
    const bytes = await boundedBytes(response, maxAttachmentBytes);
    if (mathDigest(bytes) !== expected)
      throw new HuggingMathHttpError(response.status, 'invalid_attachment', 'huggingmath_attachment_sha256_mismatch');
    return { bytes, sha256: expected, contentType };
  }
}
