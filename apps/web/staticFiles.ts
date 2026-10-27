import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import zlib from 'node:zlib';

/**
 * Built workbench files, read once per change and kept in memory with their compressed forms. Text is sent as Brotli or
 * gzip when the browser accepts it; every response carries an ETag and `no-cache`, so a repeat visit revalidates with a
 * 304 instead of downloading again, and a rebuilt file is picked up on the next request without a restart.
 */
type Entry = { mtimeMs: number; size: number; etag: string; identity: Buffer; br?: Buffer; gzip?: Buffer };
const compressible = new Set(['.html', '.js', '.css', '.svg', '.txt']);
// Quality 9 is within 10% of the maximum here at a fraction of its time; the first request after a rebuild pays it once.
const brotli = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } };
const cache = new Map<string, Entry>();

function entry(file: string, extension: string): Entry {
  const stat = fs.statSync(file), cached = cache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  const identity = fs.readFileSync(file);
  const fresh: Entry = { mtimeMs: stat.mtimeMs, size: stat.size, identity, etag: `"${crypto.createHash('sha256').update(identity).digest('base64url').slice(0, 27)}"` };
  // Tiny files gain nothing from an encoding header.
  if (compressible.has(extension) && identity.length > 1024) { fresh.br = zlib.brotliCompressSync(identity, brotli); fresh.gzip = zlib.gzipSync(identity, { level: 9 }); }
  cache.set(file, fresh);
  return fresh;
}

/** Choose `br`, then `gzip`, among codings the request accepts with a non-zero q. */
export function acceptedEncoding(header: string | undefined): 'br' | 'gzip' | undefined {
  const accepted = new Map((header ?? '').split(',').map(part => {
    const [name, ...parameters] = part.trim().toLowerCase().split(';');
    const q = parameters.map(item => item.trim()).find(item => item.startsWith('q='));
    return [name!.trim(), q ? Number(q.slice(2)) : 1] as const;
  }));
  const allowed = (name: string) => (accepted.get(name) ?? accepted.get('*') ?? 0) > 0;
  return allowed('br') ? 'br' : allowed('gzip') ? 'gzip' : undefined;
}

/** `file` has already passed the static root and type checks. */
export function sendStatic(request: http.IncomingMessage, response: http.ServerResponse, file: string, extension: string, contentType: string) {
  const item = entry(file, extension);
  const encoding = item.br ? acceptedEncoding(request.headers['accept-encoding']) : undefined;
  // Each encoding is its own representation, so it gets its own validator.
  const etag = encoding ? `${item.etag.slice(0, -1)}-${encoding}"` : item.etag;
  const headers: http.OutgoingHttpHeaders = { 'Content-Type': contentType, ETag: etag, 'Cache-Control': 'no-cache' };
  if (item.br) headers.Vary = 'Accept-Encoding';
  // Proxies that re-encode weaken the tag; the bytes it names are still the same file.
  const matches = String(request.headers['if-none-match'] ?? '').split(',').some(tag => tag.trim().replace(/^W\//u, '') === etag);
  if (matches) { response.writeHead(304, headers); response.end(); return; }
  const body = encoding === 'br' ? item.br! : encoding === 'gzip' ? item.gzip! : item.identity;
  if (encoding) headers['Content-Encoding'] = encoding;
  headers['Content-Length'] = body.length;
  response.writeHead(200, headers);
  response.end(request.method === 'HEAD' ? undefined : body);
}
