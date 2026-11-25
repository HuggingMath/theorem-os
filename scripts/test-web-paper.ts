import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { WebStorage } from '../apps/web/storage';
import type { WebRun } from '../apps/web/shared';
import type { WebRunner } from '../apps/web/runner';
import { keyMemoryStorageKey } from '../apps/web/client/keyMemory';
import { draftOwnerStorageKey } from '../apps/web/client/ownedDrafts';
import { paperStructureIssues, paperTemplate } from '../src/math/paperDraft';
import { freePort, startBrowser } from './web-scenario';

declare const Bun: { serve(options: { hostname: string; port: number; fetch(request: Request): Promise<Response> }): { port: number; stop(force?: boolean): void } };

const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-paper-'));
const owner = crypto.randomUUID(), csrf = crypto.randomUUID().replaceAll('-', '').repeat(2), id = crypto.randomUUID();
const source = 'theorem zero_add (n : Nat) : 0 + n = n := by\n  exact Nat.zero_add n\n';
const at = new Date().toISOString();
const run: WebRun = { id, title: 'Paper draft test', status: 'completed', phase: 'finished', createdAt: at, updatedAt: at, finishedAt: at,
  providerId: 'custom', model: 'my-model/v1', effort: 'max', environment: 'standard', source, task: 'Keep the accepted Lean statement.',
  maxTurns: 0, maxRunSeconds: 0, maxTotalTokens: 0, workers: 1, coordination: 'cooperative', events: [],
  result: { status: 'evaluated_passed', proof: source, report: {} } };
const storage = new WebStorage(temporary);
storage.saveSession({ id: owner, csrf, touchedAt: Date.now() });
storage.saveRun(owner, run);

const first = '\\begin{theorem}\nFor every natural number $n$, $0+n=n$.\n\\end{theorem}\n\\begin{proof}\nBy recursion.\n\\end{proof}';
const revised = first.replace('By recursion.', 'Induct on $n$. The base case follows from $0+0=0$. The recursive definition gives $0+(n+1)=(0+n)+1=n+1$.');
const calls: Array<{ instructions: string; model: string; reasoning?: { effort: string }; input: Array<{ content: string }> }> = [];
const review = JSON.stringify({ findings: [{ line: 5, message: 'Spell out the base case and inductive step.' }] });
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (new URL(request.url).pathname !== '/custom/v1/responses') return new Response(null, { status: 404 });
  if (request.headers.get('authorization') !== 'Bearer fixture-paper-key') return new Response(null, { status: 401 });
  const call = await request.json() as typeof calls[number];
  calls.push(call);
  const answer = [first, review, revised, '{"findings":[]}'][calls.length - 1];
  return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: answer }] }] });
} });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: temporary });
config.providers = [
  { id: 'sub2api', name: 'Sub2API', baseUrl: `http://127.0.0.1:${provider.port}/v1` },
  { id: 'custom', name: 'Custom Responses provider', baseUrl: `http://127.0.0.1:${provider.port}/custom/v1` },
];
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Local test' }; }, async run() { throw new Error('Unexpected new proof run'); },
  async compilePaper(input) {
    assert.equal(input.template, paperTemplate.source);
    assert.equal(input.main, revised + '\n');
    return { pdf: Buffer.from('%PDF-1.7 fixture paper') };
  } };
const service = createWebService(config, runner, { sample: null });
const browser = await startBrowser(service.server, port);
try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 900 } });
  await context.addCookies([{ name: 'theoremos_session', value: owner, url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const session = await (await context.request.get(`${origin}/api/session`)).json();
  await context.addInitScript(({ ownerKey, owner, keyName, provider }) => {
    sessionStorage.setItem(ownerKey, owner);
    sessionStorage.setItem(keyName, JSON.stringify({ providerId: provider.id, baseUrl: provider.baseUrl, apiKey: 'fixture-paper-key' }));
  }, { ownerKey: draftOwnerStorageKey, owner: session.draftOwner, keyName: keyMemoryStorageKey, provider: config.providers[1] });
  await page.goto(`${origin}/paper.html?run=${id}&lang=zh`);
  await page.getByRole('heading', { name: '尚无论文初稿' }).waitFor();
  assert.equal(await page.getByLabel('正文语言', { exact: true }).count(), 0);
  const downloadPath = `${origin}/api/runs/${id}/paper/download?target=zero_add`;
  assert.equal((await context.request.get(downloadPath)).status(), 404);
  await page.getByRole('button', { name: '生成初稿', exact: true }).click();
  const dialog = page.getByRole('dialog'), name = dialog.getByLabel('模型', { exact: true });
  await dialog.getByText('将使用此标签页已记住的 API Key。').waitFor();
  assert.equal(await dialog.getByLabel('API Key').count(), 0);
  assert.equal(await dialog.locator('details').getAttribute('open'), null);
  await dialog.getByText('更改模型', { exact: true }).click();
  assert.equal(await dialog.getByLabel('模型服务商', { exact: true }).inputValue(), 'custom');
  assert.equal(await name.inputValue(), 'my-model/v1');
  await dialog.getByLabel('模型服务商', { exact: true }).selectOption('sub2api');
  assert.equal(await name.inputValue(), 'deepseek-flash');
  await dialog.getByLabel('API Key').waitFor();
  await dialog.getByLabel('模型服务商', { exact: true }).selectOption('custom');
  assert.equal(await name.inputValue(), 'my-model/v1');
  assert.equal(await dialog.getByLabel('API Key').count(), 0);
  assert.equal(calls.length, 0);
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await page.getByRole('link', { name: '下载 LaTeX 源稿' }).waitFor().catch(async () => {
    assert.fail(`Draft did not complete after ${calls.length} provider calls. ${await page.locator('main').innerText()}`);
  });
  await page.reload();
  await page.getByText('模型审阅完成', { exact: true }).waitFor();
  assert.match(await page.getByLabel('main.tex', { exact: true }).innerText(), /Induct on/);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(item => item.model), Array(4).fill('my-model/v1'));
  assert.ok(calls.every(item => item.reasoning?.effort === 'max'));
  assert.equal(JSON.parse(calls[0].input[0].content).proof, source);
  assert.equal(JSON.parse(calls[0].input[0].content).target, 'zero_add');
  assert.match(JSON.parse(calls[2].input[0].content).findings[0].message, /base case/);
  const zipPath = path.join(temporary, 'paper.zip');
  const download = await context.request.get(downloadPath);
  assert.equal(download.status(), 200);
  await fs.writeFile(zipPath, await download.body());
  assert.equal(execFileSync('unzip', ['-p', zipPath, 'main.tex'], { encoding: 'utf8' }), revised + '\n');
  assert.equal(execFileSync('unzip', ['-p', zipPath, 'template.tex'], { encoding: 'utf8' }), paperTemplate.source);
  const pdfDownload = await context.request.get(origin + '/api/runs/' + id + '/paper/pdf?target=zero_add');
  assert.equal(pdfDownload.status(), 200);
  assert.equal(pdfDownload.headers()['content-type'], 'application/pdf');
  assert.equal(pdfDownload.headers()['content-disposition'], 'attachment; filename="paper-' + id.slice(0, 8) + '-en.pdf"');
  assert.equal((await pdfDownload.body()).toString('utf8'), '%PDF-1.7 fixture paper');
  await page.getByRole('button', { name: '重新生成', exact: true }).click();
  assert.equal(await dialog.getByLabel('模型服务商', { exact: true }).inputValue(), 'custom');
  assert.equal(await name.inputValue(), 'my-model/v1');
  assert.equal(paperStructureIssues('\\ref{missing}\n\\usepackage{x}\n\\begin{proof}').length, 3);
  console.log('Paper draft inherits the research model and effort, reuses the tab key for the same provider, and persists the draft.');
} finally {
  await browser.close();
  await service.close();
  provider.stop(true);
  await fs.rm(temporary, { recursive: true, force: true });
}
