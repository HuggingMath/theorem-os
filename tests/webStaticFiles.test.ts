import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptedEncoding, sendStatic } from '../apps/web/staticFiles';

let directory = '', server: http.Server, origin = '';
const script = 'console.log("workbench");\n'.repeat(400);
beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.homedir(), '.theoremos-static-test-'));
  fs.writeFileSync(path.join(directory, 'app.js'), script);
  fs.writeFileSync(path.join(directory, 'font.woff2'), Buffer.alloc(4096, 7));
  fs.writeFileSync(path.join(directory, 'tiny.svg'), '<svg/>');
  server = http.createServer((request, response) => {
    const name = new URL(request.url!, 'http://x').pathname.slice(1), extension = path.extname(name);
    sendStatic(request, response, path.join(directory, name), extension, extension === '.js' ? 'text/javascript' : 'application/octet-stream');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
const get = (name: string, headers: Record<string, string> = {}, method = 'GET') => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
  http.request(`${origin}/${name}`, { method, headers }, response => {
    const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject).end();
});

describe('static workbench files', () => {
  it('picks br before gzip and honours q=0', () => {
    expect(acceptedEncoding('gzip, deflate, br')).toBe('br');
    expect(acceptedEncoding('gzip;q=1.0, br;q=0')).toBe('gzip');
    expect(acceptedEncoding('identity')).toBeUndefined();
    expect(acceptedEncoding('*')).toBe('br');
    expect(acceptedEncoding('*;q=0, gzip')).toBe('gzip');
    expect(acceptedEncoding(undefined)).toBeUndefined();
  });

  it('compresses text, revalidates with a per-encoding ETag and answers 304', async () => {
    const br = await get('app.js', { 'Accept-Encoding': 'br, gzip' });
    expect(br.status).toBe(200);
    expect(br.headers['content-encoding']).toBe('br'); expect(br.headers.vary).toBe('Accept-Encoding');
    expect(br.headers['cache-control']).toBe('no-cache, no-transform');
    expect(zlib.brotliDecompressSync(br.body).toString()).toBe(script);
    expect(Number(br.headers['content-length'])).toBe(br.body.length);
    const gzip = await get('app.js', { 'Accept-Encoding': 'gzip' });
    expect(zlib.gunzipSync(gzip.body).toString()).toBe(script);
    const plain = await get('app.js');
    expect(plain.headers['content-encoding']).toBeUndefined(); expect(plain.body.toString()).toBe(script);
    expect(new Set([br.headers.etag, gzip.headers.etag, plain.headers.etag]).size).toBe(3);
    const again = await get('app.js', { 'Accept-Encoding': 'br', 'If-None-Match': `W/${br.headers.etag}` });
    expect(again.status).toBe(304); expect(again.body.length).toBe(0);
    // A validator for another encoding does not stand in for this one.
    expect((await get('app.js', { 'Accept-Encoding': 'br', 'If-None-Match': plain.headers.etag! })).status).toBe(200);
  });

  it('leaves binary and tiny files unencoded, and HEAD has no body', async () => {
    const font = await get('font.woff2', { 'Accept-Encoding': 'br' });
    expect(font.headers['content-encoding']).toBeUndefined(); expect(font.headers.vary).toBeUndefined(); expect(font.body.length).toBe(4096);
    expect((await get('tiny.svg', { 'Accept-Encoding': 'br' })).headers['content-encoding']).toBeUndefined();
    const head = await get('app.js', { 'Accept-Encoding': 'br' }, 'HEAD');
    expect(head.status).toBe(200); expect(head.body.length).toBe(0); expect(Number(head.headers['content-length'])).toBeGreaterThan(0);
  });

  it('sends the build\'s Brotli file only while it still matches', async () => {
    const name = 'built.js', file = path.join(directory, name), body = 'console.log("built");\n'.repeat(300);
    fs.writeFileSync(file, body);
    // Any valid encoding of the same bytes works; quality 1 makes it recognisably different from the server's own.
    const built = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 } });
    fs.writeFileSync(`${file}.br`, built);
    expect((await get(name, { 'Accept-Encoding': 'br' })).body.equals(built)).toBe(true);
    // The file changed after the build: the old .br is ignored and the server compresses the new bytes itself.
    const changed = body.replace('built', 'edited');
    fs.writeFileSync(file, changed); fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const fresh = await get(name, { 'Accept-Encoding': 'br' });
    expect(fresh.body.equals(built)).toBe(false); expect(zlib.brotliDecompressSync(fresh.body).toString()).toBe(changed);
  });

  it('serves a rebuilt file on the next request', async () => {
    const before = await get('app.js');
    fs.writeFileSync(path.join(directory, 'app.js'), 'console.log("rebuilt");');
    fs.utimesSync(path.join(directory, 'app.js'), new Date(), new Date(Date.now() + 5000));
    const after = await get('app.js', { 'If-None-Match': before.headers.etag! });
    expect(after.status).toBe(200); expect(after.body.toString()).toBe('console.log("rebuilt");');
    fs.writeFileSync(path.join(directory, 'app.js'), script);
  });
});
