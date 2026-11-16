import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HuggingMathClient, HuggingMathHttpError, loginHuggingMath, readHubSessionProfile, writeHubSessionProfile,
  type HubFetch, type HubSessionProfile,
} from '../src/math/huggingMathClient';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { temporaryDirectory } from './helpers/files';

const session = (baseUrl = 'https://hub.example'): HubSessionProfile => ({
  schema: 'theorem-os.huggingmath-session.v1', baseUrl,
  cookies: { csrftoken: 'fixture-csrf-secret', sessionid: 'fixture-session-secret' },
});
const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const planDigest = 'a'.repeat(64), stableKey = 'fixture-import-key';

describe('optional HuggingMath session client', () => {
  const servers: http.Server[] = [], directories: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    })));
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });
  const temporary = () => { const directory = temporaryDirectory('huggingmath-client-'); directories.push(directory); return directory; };
  const listen = async (handler: http.RequestListener): Promise<string> => {
    const server = http.createServer(handler); servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  };

  it('logs in over HTTP, uses rotated CSRF, and sends the exact preview/apply identity', async () => {
    const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
    const attachment = Buffer.from('theorem fixture : True := by\r\n  trivial\r\n');
    const base = await listen((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
        if (req.url === '/accounts/login/' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'csrftoken=initial-csrf; Path=/' });
          res.end('<form>Disposable login</form>');
        } else if (req.url === '/accounts/login/' && req.method === 'POST') {
          res.writeHead(302, { Location: '/', 'Set-Cookie': [
            'sessionid=logged-in-session; Path=/; HttpOnly', 'csrftoken=rotated-csrf; Path=/',
          ] }); res.end();
        } else if (req.url === '/api/imports/records/record-1/files/proofs/Fixture.lean') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-HM-Content-SHA256': mathDigest(attachment) });
          res.end(attachment);
        } else {
          const body = req.url === '/api/imports/preview' ? { batch_id: 'batch-1', plan_digest: planDigest } :
            req.url === '/api/imports/batch-1/apply' ? { status: 'applied', replay: seen.filter(v => v.url === req.url).length > 1 } :
              req.url === '/api/imports/batch-1' ? { batch_id: 'batch-1', status: 'applied' } :
                { record_id: 'record-1', verification: { status: 'not_run' } };
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
        }
      })().catch(() => { res.writeHead(500); res.end(); });
    });

    const profile = await loginHuggingMath(base + '/', 'maintainer+fixture', 'fixture p&ss=word');
    expect(profile).toEqual({ schema: session().schema, baseUrl: base,
      cookies: { sessionid: 'logged-in-session', csrftoken: 'rotated-csrf' } });
    expect(seen).toHaveLength(2);
    const login = seen[1];
    expect(new URLSearchParams(login.body.toString()).get('username')).toBe('maintainer+fixture');
    expect(new URLSearchParams(login.body.toString()).get('password')).toBe('fixture p&ss=word');
    expect(new URLSearchParams(login.body.toString()).get('csrfmiddlewaretoken')).toBe('initial-csrf');
    expect(login.headers).toMatchObject({ cookie: 'csrftoken=initial-csrf', origin: base, referer: base + '/accounts/login/' });

    const client = new HuggingMathClient(profile), zip = Buffer.from('PK\u0003\u0004fixture zip bytes');
    expect(await client.preview(zip, 'owner-fixture')).toEqual({ batch_id: 'batch-1', plan_digest: planDigest });
    const preview = seen[2];
    expect(preview.headers).toMatchObject({ 'x-csrftoken': 'rotated-csrf', origin: base, referer: base + '/', accept: 'application/json' });
    expect(preview.headers.cookie).toContain('sessionid=logged-in-session');
    expect(preview.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/u);
    expect(preview.body.includes(zip)).toBe(true);
    expect(preview.body.toString()).toContain('name="bundle"; filename="bundle.zip"');
    expect(preview.body.toString()).toContain('name="owner"\r\n\r\nowner-fixture');
    expect(await client.apply('batch-1', planDigest, stableKey)).toEqual({ status: 'applied', replay: false });
    expect(await client.apply('batch-1', planDigest, stableKey)).toEqual({ status: 'applied', replay: true });
    expect(seen.slice(3, 5).map(value => JSON.parse(value.body.toString()))).toEqual([
      { plan_digest: planDigest, idempotency_key: stableKey }, { plan_digest: planDigest, idempotency_key: stableKey },
    ]);
    expect(await client.batch('batch-1')).toEqual({ batch_id: 'batch-1', status: 'applied' });
    expect(await client.record('record-1')).toEqual({ record_id: 'record-1', verification: { status: 'not_run' } });
    const file = await client.attachment('record-1', 'proofs/Fixture.lean');
    expect(Buffer.from(file.bytes)).toEqual(attachment); expect(file.sha256).toBe(mathDigest(attachment));
    expect(seen.map(value => value.url)).toEqual(['/accounts/login/', '/accounts/login/', '/api/imports/preview',
      '/api/imports/batch-1/apply', '/api/imports/batch-1/apply', '/api/imports/batch-1',
      '/api/imports/records/record-1', '/api/imports/records/record-1/files/proofs/Fixture.lean']);
  });

  it('preserves conflict details, redacts session values and never retries an apply', async () => {
    const fetcher = vi.fn<HubFetch>(async () => json({ error: 'plan_mismatch',
      detail: 'Do not echo fixture-session-secret or fixture-csrf-secret', problems: ['Refresh preview'] }, 409));
    const error = await new HuggingMathClient(session(), fetcher).apply('batch-1', planDigest, stableKey).catch(value => value);
    expect(error).toBeInstanceOf(HuggingMathHttpError);
    expect(error).toMatchObject({ status: 409, code: 'http_error', details: { error: 'plan_mismatch',
      detail: 'Do not echo [redacted] or [redacted]', problems: ['Refresh preview'] } });
    expect(String(error)).not.toContain('secret'); expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reports an unknown transport outcome without exposing fetch errors or retrying', async () => {
    const fetcher = vi.fn<HubFetch>(async () => { throw new Error('fixture-session-secret private network detail'); });
    const error = await new HuggingMathClient(session(), fetcher).apply('batch-1', planDigest, stableKey).catch(value => value);
    expect(error).toMatchObject({ status: 0, code: 'network_error' });
    expect(String(error)).toContain('retain the original batch, plan and key');
    expect(String(error)).not.toMatch(/secret|private/u); expect(fetcher).toHaveBeenCalledOnce();
  });

  it('classifies HTML CSRF denial without returning the HTML body', async () => {
    const fetcher: HubFetch = async () => new Response('<html>Private CSRF diagnostics fixture-session-secret</html>', {
      status: 403, headers: { 'Content-Type': 'text/html' },
    });
    const error = await new HuggingMathClient(session(), fetcher).preview(new Uint8Array()).catch(value => value);
    expect(error).toMatchObject({ status: 403, code: 'csrf_or_access_denied' });
    expect(String(error)).not.toMatch(/Private|fixture-session-secret|<html>/u);
  });

  it('does not follow API redirects or send a cookie jar to another origin', async () => {
    const fetcher = vi.fn<HubFetch>(async () => new Response(null, { status: 302, headers: { Location: 'https://other.example/private' } }));
    await expect(new HuggingMathClient(session(), fetcher).batch('batch-1')).rejects.toMatchObject({ code: 'unexpected_redirect' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual');
    expect(fetcher.mock.calls[0][0]).toBe('https://hub.example/api/imports/batch-1');
  });

  it.each(['https://other.example/', 'http://[invalid'])('rejects unsafe login redirect %s without exposing it', async location => {
    const fetcher = vi.fn<HubFetch>()
      .mockResolvedValueOnce(new Response('', { headers: { 'Set-Cookie': 'csrftoken=initial-csrf' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: {
        Location: location, 'Set-Cookie': 'sessionid=logged-in-session',
      } }));
    const error = await loginHuggingMath('https://hub.example', 'fixture', 'private-password', fetcher).catch(value => value);
    expect(error).toMatchObject({ code: 'unexpected_redirect' }); expect(String(error)).not.toContain(location);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(fetcher.mock.calls.every(value => value[1]?.redirect === 'manual')).toBe(true);
  });

  it('returns a stable login failure for invalid credentials without returning form HTML', async () => {
    const fetcher = vi.fn<HubFetch>()
      .mockResolvedValueOnce(new Response('', { headers: { 'Set-Cookie': 'csrftoken=initial-csrf' } }))
      .mockResolvedValueOnce(new Response('<form>Private login form</form>', { headers: { 'Content-Type': 'text/html' } }));
    const error = await loginHuggingMath('https://hub.example', 'fixture', 'private-password', fetcher).catch(value => value);
    expect(error).toMatchObject({ status: 200, code: 'login_failed' });
    expect(String(error)).not.toMatch(/private-password|Private login form/u);
  });

  it('persists a normalized profile as a private file and rejects exposed or linked profiles', () => {
    const root = temporary(), file = path.join(root, 'credentials', 'hub.json'), profile = session('https://hub.example/');
    writeHubSessionProfile(file, profile);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readHubSessionProfile(file)).toEqual(session());
    fs.chmodSync(file, 0o644);
    expect(() => readHubSessionProfile(file)).toThrow('huggingmath_session_profile_permissions');
    fs.chmodSync(file, 0o600);
    const link = path.join(root, 'linked.json'); fs.symlinkSync(file, link);
    expect(() => readHubSessionProfile(link)).toThrow('math_path_invalid');
    expect(() => writeHubSessionProfile(link, profile)).toThrow('math_path_invalid');
    expect(readHubSessionProfile(file)).toEqual(session());
  });

  it('does not expose malformed profile contents and rejects URLs with embedded credentials', () => {
    const file = path.join(temporary(), 'hub.json');
    fs.writeFileSync(file, '{"fixture-session-secret": broken', { mode: 0o600 });
    expect(() => readHubSessionProfile(file)).toThrow(/^huggingmath_session_profile_invalid$/u);
    for (const base of ['https://private-password@hub.example', 'https://hub.example/?token=private-password', 'file:///private']) {
      expect(() => new HuggingMathClient(session(base))).toThrow('huggingmath_base_url_invalid');
    }
  });

  it('uses cookie rotation and deletion from API responses for subsequent calls', async () => {
    const first = json({ ok: true }); first.headers.append('Set-Cookie', 'csrftoken=next-csrf; Path=/');
    first.headers.append('Set-Cookie', 'sessionid=; Max-Age=0; Path=/');
    const fetcher = vi.fn<HubFetch>().mockResolvedValueOnce(first).mockResolvedValueOnce(json({ ok: true }));
    const client = new HuggingMathClient(session(), fetcher);
    await client.batch('batch-1'); await client.apply('batch-1', planDigest, stableKey);
    const headers = new Headers(fetcher.mock.calls[1][1]?.headers);
    expect(headers.get('X-CSRFToken')).toBe('next-csrf'); expect(headers.get('Cookie')).toBe('csrftoken=next-csrf');
    expect(client.profile.cookies.sessionid).toBeUndefined();
  });

  it.each([
    ['text/plain', undefined, 'huggingmath_attachment_headers_invalid'],
    ['application/json', planDigest, 'huggingmath_attachment_headers_invalid'],
    ['text/plain', planDigest, 'huggingmath_attachment_sha256_mismatch'],
  ])('rejects an attachment with content type %s and hash %s', async (contentType, digest, message) => {
    const headers = new Headers({ 'Content-Type': contentType });
    if (digest) headers.set('X-HM-Content-SHA256', digest);
    const fetcher: HubFetch = async () => new Response('bytes\r\n', { headers });
    await expect(new HuggingMathClient(session(), fetcher).attachment('record-1', 'proofs/Fixture.lean')).rejects.toThrow(message);
  });

  it.each([
    ['text/html', '<html>Private state</html>'], ['application/json', 'not JSON'], ['application/json', '[]'],
  ])('rejects invalid JSON API responses with content type %s', async (contentType, body) => {
    const fetcher: HubFetch = async () => new Response(body, { headers: { 'Content-Type': contentType } });
    const error = await new HuggingMathClient(session(), fetcher).batch('batch-1').catch(value => value);
    expect(error).toMatchObject({ code: 'invalid_response' }); expect(String(error)).not.toContain(body);
  });

  it('rejects invalid request identities and oversized archives before network access', async () => {
    const fetcher = vi.fn<HubFetch>(), client = new HuggingMathClient(session(), fetcher);
    expect(() => client.batch('../private')).toThrow('huggingmath_batch_id_invalid');
    expect(() => client.record('record/1')).toThrow('huggingmath_record_id_invalid');
    expect(() => client.apply('batch-1', 'bad-digest', stableKey)).toThrow('huggingmath_apply_identity_invalid');
    expect(() => client.apply('batch-1', planDigest, 'short')).toThrow('huggingmath_apply_identity_invalid');
    for (const file of ['../private', 'proofs/../private', '/private', 'proofs\\private', 'a//b', 'proofs/%2e%2e/private']) {
      await expect(client.attachment('record-1', file)).rejects.toThrow('huggingmath_attachment_identity_invalid');
    }
    await expect(client.preview(new Uint8Array(40 * 1024 * 1024 + 1))).rejects.toThrow('huggingmath_archive_too_large');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
