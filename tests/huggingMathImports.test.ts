import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readHuggingMathBundle } from '../src/math/huggingMathBundle';
import { writeHubSessionProfile } from '../src/math/huggingMathClient';
import { applyHuggingMathImport, previewHuggingMathImport, readbackHuggingMathImport, readHuggingMathImport } from '../src/math/huggingMathImports';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { temporaryDirectory } from './helpers/files';

const planDigest = 'a'.repeat(64);
const result = { outcome: 'create', record_id: 'record-1', problem: 'problem-1', replayed: false };
type Seen = { url: string; method: string; body: string };

/** Synthetic transport fixture: no claim of a checked mathematical result. */
function bundle(directory: string) {
  fs.mkdirSync(directory);
  const sources = {
    'statement.md': { role: 'statement', source: 'Synthetic transport fixture.' },
    'Original.lean': { role: 'formalization', source: 'theorem fixture : True := by sorry\n' },
    'Proof.lean': { role: 'proof', source: 'theorem fixture : True := by trivial\n' },
  };
  const files = Object.entries(sources).map(([file, value]) => {
    const bytes = Buffer.from(value.source); fs.writeFileSync(path.join(directory, file), bytes);
    return { path: file, role: value.role, sha256: mathDigest(bytes), bytes: bytes.length };
  });
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    schema: 'hm-problem-bundle/0', provider: 'theoremos.fixture', external_id: 'fixture-1',
    export: { revision: 'synthetic' }, historical: false,
    problem: { title: 'Fixture', statement: 'statement.md', language: 'en', sources: 'Synthetic fixture', statement_review: 'unreviewed_draft' },
    formalizations: [{ key: 'original', entry: 'Original.lean', targets: ['fixture'], context: [], note: '' }],
    proofs: [{ key: 'candidate', formalization: 'original', entry: 'Proof.lean', support: [], summary: 'Fixture', attribution: 'Test fixture' }],
    environment: { files: [], complete: false }, external_verification: [],
    rights: [{ files: files.map(file => file.path), status: 'unknown', license: '', notice: '' }], files,
  }));
  return readHuggingMathBundle(directory);
}

describe('HuggingMath durable import mapping', () => {
  const servers: http.Server[] = [], directories: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    })));
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  async function setup() {
    const directory = temporaryDirectory('huggingmath-import-'); directories.push(directory);
    const bundleFile = path.join(directory, 'bundle'), selected = bundle(bundleFile), seen: Seen[] = [];
    const preview = { batch_id: 'batch-1', bundle_digest: selected.bundleDigest, plan_digest: planDigest,
      provider: selected.manifest.provider, external_id: selected.manifest.external_id, owner: 'fixture-owner', plan: { visibility: 'private' } };
    const record = { record_id: result.record_id, problem: result.problem, bundle_digest: selected.bundleDigest,
      provider: preview.provider, external_id: preview.external_id, owner: preview.owner,
      batch_id: 'batch-1', files: selected.manifest.files };
    let handler = (_request: Seen, _req: http.IncomingMessage, _res: http.ServerResponse): unknown => undefined;
    const server = http.createServer((req, res) => {
      void (async () => {
        let body = ''; for await (const chunk of req) body += String(chunk);
        const request = { url: req.url!, method: req.method!, body }; seen.push(request);
        const override = handler(request, req, res);
        if (res.destroyed || res.writableEnded) return;
        const response = override ?? (request.url === '/api/imports/preview' ? preview :
          request.url.endsWith('/apply') ? result : request.url.includes('/records/') ? record : preview);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response));
      })().catch(() => { res.writeHead(500); res.end(); });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const baseUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const profileFile = path.join(directory, 'profile.json'), outputFile = path.join(directory, 'import.json');
    writeHubSessionProfile(profileFile, { schema: 'theorem-os.huggingmath-session.v1', baseUrl,
      cookies: { sessionid: 'fixture-session', csrftoken: 'fixture-csrf' } });
    return { directory, selected, preview, record, seen, profileFile, outputFile, baseUrl,
      options: { bundleFile, profileFile, owner: 'fixture-owner', outputFile },
      intercept: (next: typeof handler) => { handler = next; } };
  }

  it('saves one private journal and retry tuple, then binds the returned mapping and files', async () => {
    const fixture = await setup(), journal = await previewHuggingMathImport(fixture.options);
    expect(readHuggingMathImport(fixture.outputFile)).toEqual(journal);
    expect(fs.statSync(fixture.outputFile).mode & 0o777).toBe(0o600);
    expect(journal.idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{8,128}$/u);
    expect(JSON.stringify(journal)).not.toContain('fixture-session');
    await expect(previewHuggingMathImport(fixture.options)).rejects.toThrow('output_exists');
    expect(fixture.seen).toHaveLength(1);
    const applied = await applyHuggingMathImport(fixture.outputFile, fixture.profileFile);
    expect(applied.result).toEqual(result); expect(applied.record).toEqual(fixture.record);
    expect(JSON.parse(fixture.seen[1].body)).toEqual({ plan_digest: planDigest, idempotency_key: journal.idempotencyKey });
    expect(await readbackHuggingMathImport(fixture.outputFile, fixture.profileFile)).toEqual(applied);
  });

  it.each(['bundle_digest', 'provider', 'external_id', 'owner'] as const)('rejects a preview with different %s before saving a journal', async field => {
    const fixture = await setup();
    fixture.intercept(() => ({ ...fixture.preview, [field]: field === 'bundle_digest' ? 'b'.repeat(64) : 'different' }));
    await expect(previewHuggingMathImport(fixture.options)).rejects.toThrow('preview_binding_mismatch');
    expect(fs.existsSync(fixture.outputFile)).toBe(false);
  });

  it('persists a successful apply before failed record readback, then reconciles with the same tuple', async () => {
    const fixture = await setup(), journal = await previewHuggingMathImport(fixture.options);
    fixture.intercept(request => {
      if (request.url.includes('/records/')) throw new Error('synthetic readback outage');
    });
    await expect(applyHuggingMathImport(fixture.outputFile, fixture.profileFile)).rejects.toThrow('huggingmath_http_500');
    expect(readHuggingMathImport(fixture.outputFile)).toMatchObject({ result });
    expect(readHuggingMathImport(fixture.outputFile).record).toBeUndefined();
    fixture.intercept(request => request.url.endsWith('/apply') ? { ...result, replayed: true } : undefined);
    const recovered = await applyHuggingMathImport(fixture.outputFile, fixture.profileFile);
    expect(recovered.result?.replayed).toBe(true); expect(recovered.record).toEqual(fixture.record);
    const writes = fixture.seen.filter(value => value.url.endsWith('/apply'));
    expect(writes).toHaveLength(2);
    expect(writes.map(value => JSON.parse(value.body))).toEqual(Array(2).fill({ plan_digest: planDigest, idempotency_key: journal.idempotencyKey }));
  });

  it('does not retry an uncertain mutation and lets the saved key recover its committed result', async () => {
    const fixture = await setup(), journal = await previewHuggingMathImport(fixture.options);
    let applied = false;
    fixture.intercept((request, req) => {
      if (request.url.endsWith('/apply')) {
        if (!applied) { applied = true; req.socket.destroy(); }
        return { ...result, replayed: true };
      }
    });
    await expect(applyHuggingMathImport(fixture.outputFile, fixture.profileFile)).rejects.toThrow('request outcome may be unknown');
    expect(readHuggingMathImport(fixture.outputFile)).toEqual(journal);
    expect(fixture.seen.filter(value => value.url.endsWith('/apply'))).toHaveLength(1);
    const recovered = await applyHuggingMathImport(fixture.outputFile, fixture.profileFile);
    expect(recovered.result?.replayed).toBe(true);
    expect(new Set(fixture.seen.filter(value => value.url.endsWith('/apply')).map(value => value.body)).size).toBe(1);
  });

  it('keeps a stale plan unchanged so a new preview is an explicit next command', async () => {
    const fixture = await setup(), journal = await previewHuggingMathImport(fixture.options);
    fixture.intercept((request, _req, res) => {
      if (request.url.endsWith('/apply')) {
        res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'stale_plan' }));
      }
    });
    await expect(applyHuggingMathImport(fixture.outputFile, fixture.profileFile)).rejects.toThrow('stale_plan');
    expect(readHuggingMathImport(fixture.outputFile)).toEqual(journal);
    expect(fixture.seen.filter(value => value.url.endsWith('/apply'))).toHaveLength(1);
  });

  it.each(['owner', 'problem', 'bundle_digest', 'files'] as const)('rejects record readback with changed %s and preserves the apply result', async field => {
    const fixture = await setup(); await previewHuggingMathImport(fixture.options);
    fixture.intercept(request => request.url.includes('/records/') ? { ...fixture.record,
      [field]: field === 'files' ? [] : field === 'bundle_digest' ? 'b'.repeat(64) : 'different' } : undefined);
    await expect(applyHuggingMathImport(fixture.outputFile, fixture.profileFile)).rejects.toThrow(field === 'files' ? 'record_files_changed' : 'record_binding_mismatch');
    expect(readHuggingMathImport(fixture.outputFile).result).toEqual(result);
    expect(readHuggingMathImport(fixture.outputFile).record).toBeUndefined();
  });

  it('accepts a minimal noop response pointing to a record created by an earlier batch', async () => {
    const fixture = await setup(); await previewHuggingMathImport(fixture.options);
    fixture.intercept(request => request.url.endsWith('/apply') ? { ...result, outcome: 'noop', created: {} } :
      request.url.includes('/records/') ? { ...fixture.record, batch_id: 'older-batch' } : undefined);
    const applied = await applyHuggingMathImport(fixture.outputFile, fixture.profileFile);
    expect(applied.result?.outcome).toBe('noop'); expect(applied.record?.batch_id).toBe('older-batch');
  });

  it('binds the journal to the original server before performing any subsequent request', async () => {
    const fixture = await setup(); await previewHuggingMathImport(fixture.options);
    writeHubSessionProfile(fixture.profileFile, { schema: 'theorem-os.huggingmath-session.v1', baseUrl: 'http://127.0.0.1:1',
      cookies: { sessionid: 'fixture-session', csrftoken: 'fixture-csrf' } });
    await expect(applyHuggingMathImport(fixture.outputFile, fixture.profileFile)).rejects.toThrow('server_changed');
    expect(fixture.seen).toHaveLength(1);
  });

  it('reads only the staging batch before a saved successful apply exists', async () => {
    const fixture = await setup(), journal = await previewHuggingMathImport(fixture.options);
    expect(await readbackHuggingMathImport(fixture.outputFile, fixture.profileFile)).toEqual(journal);
    expect(fixture.seen.map(value => value.url)).toEqual(['/api/imports/preview', '/api/imports/batch-1']);
    fixture.intercept(() => ({ ...fixture.preview, plan_digest: 'b'.repeat(64) }));
    await expect(readbackHuggingMathImport(fixture.outputFile, fixture.profileFile)).rejects.toThrow('batch_binding_mismatch');
  });
});
