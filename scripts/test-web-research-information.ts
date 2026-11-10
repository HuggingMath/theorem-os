#!/usr/bin/env bun
// Purely local UI fixtures. This script starts no backend, model, Lean process or research run.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import type { WebSession } from '../apps/web/shared';
import type { ResearchProjectDetail, ResearchProjectSummary, ResearcherProfile, ResearchStatementVersion } from '../apps/web/researchProjectTypes';
import type { ResearchAgentDraft, ResearchAsset, ResearchAssetKind, ResearchAssetRelease, ResearchSkillDraft } from '../apps/web/researchAssetTypes';
import type { InstalledLibraryDirectory } from '../apps/web/installedLibraryTypes';
import { audit } from './web-a11y';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), staticRoot = path.join(root, 'out/web');
const libraryOnly = process.argv.includes('--library-only');
const output = path.join(root, libraryOnly ? 'out/web-research-information-library' : 'out/web-research-information');
const owner = 'synthetic-research-owner', createdAt = '2026-11-09T09:00:00.000Z';
const profile = (id: string, displayName: string, fields: string[], bio: string): ResearcherProfile => ({
  id, displayName, fields, bio, links: [], visibility: 'public', revision: 1, createdAt, updatedAt: createdAt,
});
const self = profile('researcher-self', '周以宁', ['Algebra', 'Formalization'], '研究有限群与形式化证明，整理可复用的代数引理。');
const people = [profile('researcher-lin', '林若水', ['Algebra', 'Galois theory'], '研究域扩张、伽罗瓦群和根式可解性，关注证明中单位根与正规闭包的作用。'),
  profile('researcher-ada', 'Ada Fernández', ['Algebra', 'Number theory'], 'Studies field extensions and number theory, with an interest in reusable formal proofs.'), self];
const web: WebSession = {
  csrfToken: 'synthetic-csrf-token', draftOwner: owner, auth: 'email', account: { email: 'fixture@example.invalid' },
  providers: [], environments: [], templates: [],
  defaults: { model: 'synthetic-only', effort: 'max', maxTurns: 0, maxRunSeconds: 0, workers: 1, coordination: 'cooperative', environment: 'mathlib' },
  limits: { maxTurns: 0, maxRunSeconds: 0, maxWorkers: 1, maxTotalTokens: 0, maxSourceBytes: 0, maxTaskBytes: 0, maxRuns: 0 },
  runtime: { ready: false, message: 'Local UI fixture only' },
};
const versions: ResearchStatementVersion[] = [1, 2].map(index => ({
  id: `statement-v${index}`, author: people[0], createdAt, sourceDigest: `synthetic-source-digest-v${index}`,
  statement: index === 1 ? '设 K 为特征零域，证明多项式根式可解当且仅当其伽罗瓦群可解。' : '给定特征零域上的多项式，分别证明根式可解性的必要性与充分性，并处理非正规扩张。',
  source: `-- Synthetic UI source fixture v${index}; never compiled.\nexample (n : Nat) : n = n := by rfl\n`,
  environment: 'mathlib', confirmation: { confirmed: true }, assumptions: ['K is a field of characteristic zero.'],
}));
const theorem: ResearchProjectDetail = {
  id: 'galois-criterion', title: '伽罗瓦根式可解性判别定理', description: '严格处理两个方向、单位根与正规闭包，保留原题陈述和每次研究的固定版本。',
  fields: ['Algebra', 'Galois theory'], visibility: 'public', owner: people[0], members: [], currentStatementVersionId: versions[1].id,
  revision: 2, createdAt, updatedAt: createdAt, permissions: { manage: false, edit: false, discuss: false, member: false },
  versions, runs: [], feedback: [], activity: [], contributions: [], assignments: [],
};
const statementNeeded: ResearchProjectSummary = { ...theorem, id: 'quadratic-extensions', title: '二次扩张与判别式',
  description: '比较二次域扩张的表示与判别式，准备补充完整的研究陈述。', currentStatementVersionId: undefined };
const managedTheorem: ResearchProjectDetail = { ...theorem, id: 'my-field-theorem', title: '我管理的域扩张题目', owner: self,
  visibility: 'private', permissions: { manage: true, edit: true, discuss: true, member: true } };
const laterManagedTheorem: ResearchProjectDetail = { ...managedTheorem, id: 'my-later-theorem', title: '另一项可管理题目' };
const agentContent: ResearchAgentDraft = { environment: 'mathlib', workers: 1, coordination: 'cooperative',
  modulePlan: { scheduler: 'plan', context: 'essential', custom: [{ id: 'field-tower', name: 'Field tower strategy', slot: 'M1', mode: 'append', enabled: true,
    instructions: 'Fix the base field and prove the extension lemmas before using the solvability argument.' }] }, skills: [], libraries: [] };
const skillContent: ResearchSkillDraft = { instructions: 'When proving a field-extension result, record the base field and check normality explicitly.',
  steps: ['State the independent lemma.', 'Check each field embedding and hypothesis.'], inputs: ['Field tower'], outputs: ['Reusable lemma'],
  slots: ['M1'], roles: ['researcher'], mode: 'append', dependencies: [], examples: ['Adjoin the required roots of unity before taking a normal closure.'] };
function released(id: string, type: ResearchAssetKind, name: string, editable = false): ResearchAsset {
  const release: ResearchAssetRelease = { schema: 'theorem-os.research-asset-release.v1', assetId: id, type,
    authorId: editable ? self.id : people[0].id, version: 'v1', digest: `synthetic-${id}-v1`, name,
    description: `Published ${type} resource for field-extension research.`, area: 'Algebra', license: 'MIT', visibility: 'public',
    content: type === 'agent' ? agentContent : type === 'skill' ? skillContent : { source: { kind: 'knowledge', catalogDigest: 'synthetic-catalog', entryIds: ['field-lemma'] } },
    dependencies: [], createdAt };
  if (type === 'mathematics') release.mathematics = { environment: 'mathlib', environmentDigest: 'synthetic-environment', packDigest: 'synthetic-pack',
    pack: { schema: 'theorem-os.library-pack.v1', modules: [{ file: 'FieldLemma.lean', source: '-- Synthetic UI fixture only.\nexample (n : Nat) : n = n := by rfl\n',
      origin: { kind: 'run', runId: 'synthetic-run', commit: 'synthetic-commit', file: 'FieldLemma.lean' } }] },
    declarations: [{ name: 'Synthetic.field_lemma', type: '∀ n : Nat, n = n', file: 'FieldLemma.lean' }], receiptRefs: [],
    source: { kind: 'knowledge', catalogDigest: 'synthetic-catalog', entryIds: ['field-lemma'] } };
  return { id, type, authorId: release.authorId, name: editable ? `${name} · 草稿修订` : name,
    description: editable ? 'Personal draft: changed instructions are not part of the published version.' : release.description,
    area: 'Algebra', visibility: editable ? 'private' : 'public', revision: 2, editable, draft: release.content, release,
    releases: [{ version: release.version, digest: release.digest, createdAt, license: release.license, visibility: release.visibility, withdrawn: false }],
    createdAt, updatedAt: createdAt };
}
const mathematics = released('field-lemma', 'mathematics', 'Field extension declarations');
const mathematicsTwo = released('tower-lemma', 'mathematics', 'Tower lemma source pack');
const agent = released('field-agent', 'agent', 'Field Theory Research Agent v1', true);
const skill = released('extension-skill', 'skill', 'Field extension proof checklist');
const unpublished: ResearchAsset = { ...agent, id: 'unpublished-agent', name: 'Unpublished field-theory draft', release: undefined, releases: [] };
const withdrawn: ResearchAsset = { ...released('withdrawn-agent', 'agent', 'Withdrawn research agent', true),
  releases: [{ ...agent.releases[0], withdrawn: true }] };
const unavailable = released('unavailable-agent', 'agent', 'Unavailable fixed version', true);
const assets = [mathematics, mathematicsTwo, agent, skill, unpublished, withdrawn, unavailable];
const requests: { method: string; pathname: string; search: string }[] = [], unknown: string[] = [], external: string[] = [];
const checks: { scenario: string; assertions: string[]; screenshots: string[] }[] = [];
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'X-Theoremos-Owner': owner, 'Cache-Control': 'no-store' } });
function api(method: string, url: URL) {
  const pathname = url.pathname;
  requests.push({ method, pathname, search: url.search });
  if (method !== 'GET') { unknown.push(`${method} ${pathname}`); return reply({ error: 'Unexpected mutation in read-only UI regression' }, 405); }
  if (pathname === '/api/session') return reply(web);
  if (pathname === '/api/runs') return reply({ runs: [] });
  if (pathname === '/api/research/session') return reply({ researcherId: self.id, profile: self, authenticated: true });
  if (pathname === '/api/research/people') {
    const q = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase(), field = (url.searchParams.get('field') ?? '').trim().toLocaleLowerCase();
    const matching = people.filter(person => (!q || `${person.displayName} ${person.bio} ${person.fields.join(' ')}`.toLocaleLowerCase().includes(q))
      && (!field || person.fields.some(value => value.trim().toLocaleLowerCase() === field)));
    return reply({ items: matching.map(person => ({ ...person,
      research: { projectCount: 1, contributionCount: 0, latestProject: { id: theorem.id, title: theorem.title, updatedAt: theorem.updatedAt } } })),
      fields: [...new Set(people.flatMap(person => person.fields))].sort(), total: 27, nextOffset: 24 });
  }
  const person = /^\/api\/research\/people\/([^/]+)$/u.exec(pathname);
  if (person) { const item = people.find(item => item.id === person[1]); if (item) return reply({ item: { ...item, projects: [theorem], contributions: [] } }); }
  if (pathname === '/api/research/notifications') return reply({ items: [{ id: 'notice-statement', actor: people[0],
    projectId: theorem.id, type: 'statement', summary: 'Updated field-extension statement', createdAt, read: false }], total: 1 });
  if (pathname === '/api/research/feed') return reply({ items: [], total: 0 });
  if (pathname === '/api/research/collaboration/inbox') return reply({ items: [], unread: 0, pending: 0 });
  if (pathname === '/api/research/personal/drafts') return reply({ items: [], total: 0 });
  if (pathname === '/api/research/asset-follows') return reply({ items: [], updates: [] });
  const collaboration = /^\/api\/research\/theorems\/([^/]+)\/collaboration$/u.exec(pathname);
  if (collaboration) return reply({ item: { projectId: collaboration[1], revision: 0, invitations: [], handoffs: [], issues: [] } });
  if (pathname === '/api/research/theorems' && url.searchParams.get('author') === self.id)
    return reply(url.searchParams.get('offset') === '100' ? { items: [laterManagedTheorem], total: 3 }
      : { items: [theorem, managedTheorem], total: 3, nextOffset: 100 });
  if (pathname === '/api/research/theorems') return reply({ items: [theorem, statementNeeded], total: 2 });
  if (pathname === `/api/research/theorems/${theorem.id}`) return reply({ item: theorem });
  if (pathname === `/api/research/theorems/${managedTheorem.id}`) return reply({ item: managedTheorem });
  if (pathname === `/api/research/theorems/${laterManagedTheorem.id}`) return reply({ item: laterManagedTheorem });
  if (pathname === '/api/research/library') return reply({ items: assets.filter(asset => asset.type === url.searchParams.get('type') &&
    (url.searchParams.get('mine') === '1' ? asset.authorId === self.id : Boolean(asset.release && !asset.releases[0]?.withdrawn))), total: assets.length });
  // The real installed catalog is exercised separately by test-web-installed-library.ts through the actual HTTP service.
  if (pathname === '/api/research/library/installed') return reply({ library: { id: 'theorem-os/synthetic', revision: 'local-fixture',
    catalogDigest: '0'.repeat(64), environmentDigest: '1'.repeat(64), environment: 'mathlib', toolchain: 'synthetic-only', moduleCount: 0, declarationCount: 0 },
    items: [], areas: [], total: 0, offset: Number(url.searchParams.get('offset') ?? 0), limit: 24 } satisfies InstalledLibraryDirectory);
  const release = /^\/api\/research\/library\/([^/]+)\/releases\/([^/]+)$/u.exec(pathname);
  if (release) {
    if (release[1] === unavailable.id) return reply({ error: 'Synthetic release is unavailable.' }, 404);
    const item = assets.find(asset => asset.id === release[1])?.release;
    if (item?.version === release[2]) return reply({ item });
  }
  const asset = /^\/api\/research\/library\/([^/]+)$/u.exec(pathname);
  if (asset) { const item = assets.find(item => item.id === asset[1]); if (item) return reply({ item }); }
  unknown.push(`${method} ${pathname}${url.search}`);
  return reply({ error: 'Unknown synthetic API route' }, 404);
}
await fs.access(path.join(staticRoot, 'research.js'));
await fs.mkdir(output, { recursive: true });
const contentTypes: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    const result = api(request.method ?? 'GET', url);
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text()); return;
  }
  if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  const filename = path.join(staticRoot, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  try { const file = await fs.readFile(filename); response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filename)] ?? 'application/octet-stream' }); response.end(file); }
  catch { response.writeHead(404); response.end('Missing local static file'); }
});
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true, timeout: 0 });
let activePage: Page | undefined, activeScenario = '', failureScreenshot: string | undefined;
async function settled(page: Page) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
}
async function visible(locator: Locator) { await locator.waitFor({ state: 'visible', timeout: 0 }); }
async function visit(page: Page, href: string, ready: Locator) {
  await page.goto(`${origin}/${href}`, { waitUntil: 'domcontentloaded', timeout: 0 });
  await visible(page.locator('#main[aria-busy="false"]'));
  await visible(ready); await settled(page);
}
async function health(page: Page) {
  await settled(page);
  assert.deepEqual(await audit(page), [], `${activeScenario}: accessibility`);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${activeScenario}: no horizontal page overflow`);
  assert.deepEqual(unknown, [], 'all API requests belong to the synthetic fixture contract');
  assert.deepEqual(external, [], 'no external network requests');
}
async function directoryWidth(page: Page) {
  const { discovery, content } = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.research-shell')!, style = getComputedStyle(shell);
    return { discovery: document.querySelector<HTMLElement>('.research-discovery, .research-library-page')!.getBoundingClientRect().width,
      content: shell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
  });
  assert(Math.abs(discovery - content) < 2, `${activeScenario}: directory uses the available content width`);
  assert.equal(await page.locator('.research-sidebar:visible').count(), 0, 'directory has no sidebar');
}
async function capture(page: Page, record: typeof checks[number], name: string) {
  await health(page); await page.evaluate(() => scrollTo(0, 0)); await settled(page);
  const filename = `${record.scenario}-${name}.png`;
  await page.screenshot({ path: path.join(output, filename), fullPage: true, animations: 'disabled', timeout: 0 });
  record.screenshots.push(filename);
}
function filters(page: Page, expected: Record<string, string>) {
  const parameters = new URL(page.url()).searchParams;
  for (const [key, value] of Object.entries(expected)) assert.equal(parameters.get(key), value, `URL preserves ${key}`);
}
async function peopleFlow(page: Page, record: typeof checks[number], en: boolean) {
  const heading = page.getByRole('heading', { level: 1, name: en ? 'Discover mathematicians' : '发现同行', exact: true });
  await visit(page, 'people.html', heading);
  await visible(page.getByRole('link', { name: people[0].displayName, exact: true }));
  await directoryWidth(page);
  assert.equal(await page.locator('#profile-management').count(), 0, 'default people page is a directory');
  assert.equal(await page.locator('.research-directory-card').count(), people.length);
  for (const person of people) {
    const card = page.locator('.research-directory-card').filter({ has: page.getByRole('link', { name: person.displayName, exact: true }) });
    assert((await card.innerText()).includes(person.bio), 'card shows biography');
    assert((await card.innerText()).includes(person.fields[0]), 'card shows research field');
  }
  await capture(page, record, 'people-directory');
  assert.equal(await page.locator('[data-person-research]').count(), people.length, 'visible research previews are shown in the directory');
  assert((await page.locator('[data-person-research]').first().innerText()).includes(theorem.title), 'preview names the actual visible project');
  const fieldInput = page.getByLabel(en ? 'Filter by research field' : '按研究领域筛选', { exact: true });
  assert.deepEqual(await page.locator('#research-directory-fields option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)),
    [...new Set(people.flatMap(person => person.fields))].sort(), 'field candidates are real visible-profile values');
  const mixedCaseField = '  aLgEbRa  ';
  const normalized = page.waitForResponse(response => new URL(response.url()).pathname === '/api/research/people'
    && new URL(response.url()).searchParams.get('field') === mixedCaseField, { timeout: 0 });
  await fieldInput.fill(mixedCaseField, { timeout: 0 }); await normalized; await settled(page);
  assert.equal(await page.locator('.research-directory-card').count(), people.length, 'field whitespace and case do not hide matching researchers');
  const clickedField = page.waitForResponse(response => new URL(response.url()).pathname === '/api/research/people'
    && new URL(response.url()).searchParams.get('field') === 'Galois theory', { timeout: 0 });
  await page.locator('[data-people-field="Galois theory"]').click({ timeout: 0 }); await clickedField;
  await page.waitForFunction(() => document.querySelectorAll('.research-directory-card').length === 1, undefined, { timeout: 0 });
  assert.equal(await fieldInput.inputValue(), 'Galois theory'); filters(page, { field: 'Galois theory' });
  await capture(page, record, 'people-field-choice');
  const expected = { q: 'Algebra', field: 'Algebra', offset: '12' };
  await visit(page, 'people.html?q=Algebra&field=Algebra&offset=12', heading);
  await page.getByRole('link', { name: people[0].displayName, exact: true }).click({ timeout: 0 });
  await visible(page.getByRole('heading', { level: 1, name: people[0].displayName, exact: true }));
  filters(page, { ...expected, id: people[0].id });
  assert.equal(await page.locator('#profile-management').count(), 0, 'public profile does not mount own editor');
  await capture(page, record, 'people-detail');
  const profileUrl = page.url();
  const fieldLink = page.locator('a[data-people-field="Galois theory"]');
  const fieldHref = new URL((await fieldLink.getAttribute('href'))!, page.url());
  assert.equal(fieldHref.searchParams.get('field'), 'Galois theory'); assert.equal(fieldHref.searchParams.has('id'), false, 'profile field tags open the corresponding directory');
  await page.locator(`[data-add-researcher="${people[0].id}"]`).click({ timeout: 0 });
  const projectPicker = page.locator('[data-researcher-project-picker]');
  const projectSelect = projectPicker.getByRole('combobox', { name: en ? 'Choose a theorem I manage' : '选择我管理的题目', exact: true });
  await visible(projectSelect);
  assert.deepEqual(await projectSelect.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)),
    ['', managedTheorem.id, laterManagedTheorem.id], 'all pages are read and only projects with manage permission are selectable');
  const openMembers = projectPicker.getByRole('button', { name: en ? 'Open member form' : '前往成员表单', exact: true });
  assert.equal(await openMembers.isDisabled(), true);
  await projectSelect.selectOption(laterManagedTheorem.id, { timeout: 0 });
  await capture(page, record, 'people-project-choice');
  await openMembers.click({ timeout: 0 });
  const memberInput = page.locator('#research-members').getByLabel(en ? 'Mathematician' : '数学家', { exact: true });
  await visible(memberInput); assert.equal(await memberInput.inputValue(), people[0].id);
  assert(await memberInput.evaluate(element => element === document.activeElement), 'member form focuses the prefilled person for review');
  filters(page, { id: laterManagedTheorem.id, addResearcher: people[0].id }); assert.equal(new URL(page.url()).hash, '#research-members');
  assert.equal(requests.filter(request => request.method !== 'GET').length, 0, 'choosing a researcher and project performs no membership write');
  await capture(page, record, 'people-member-prefill');
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
  await visible(page.getByRole('heading', { level: 1, name: people[0].displayName, exact: true }));
  await page.locator('.research-breadcrumb a').click({ timeout: 0 }); await visible(heading);
  filters(page, expected);
  const mine = page.getByRole('link', { name: en ? 'My profile' : '我的主页', exact: true });
  assert.equal(new URL((await mine.getAttribute('href'))!, origin).searchParams.get('id'), self.id);
  await mine.click({ timeout: 0 }); await visible(page.getByRole('heading', { level: 1, name: self.displayName, exact: true }));
  const ownOverview = page.locator('[data-own-research-overview]');
  await visible(ownOverview);
  await visible(ownOverview.getByRole('heading', { name: en ? 'Updates for you · 1 unread' : '需要关注的更新 · 1 条未读', exact: true }));
  assert(await page.evaluate(() => Boolean(document.querySelector('[data-own-research-overview]')!.compareDocumentPosition(document.querySelector('#research-projects')!) & Node.DOCUMENT_POSITION_FOLLOWING)), 'own updates and recent projects precede profile details');
  await capture(page, record, 'people-own-overview');
  await visible(page.locator('#profile-management'));
  await page.getByText(en ? 'Edit my profile' : '编辑我的资料', { exact: true }).click({ timeout: 0 });
  await visible(page.getByLabel(en ? 'Display name' : '显示名', { exact: true }));
  await health(page);
  const signedOut = await page.context().newPage();
  await signedOut.route('**/api/session', route => route.fulfill({ status: 200, contentType: 'application/json',
    headers: { 'X-Theoremos-Owner': owner }, body: JSON.stringify({ ...web, account: undefined }) }));
  await signedOut.route('**/api/research/session', route => route.fulfill({ status: 200, contentType: 'application/json',
    headers: { 'X-Theoremos-Owner': owner }, body: JSON.stringify({ authenticated: false }) }));
  const signedOutPath = `people.html?${new URLSearchParams({ ...expected, id: people[0].id })}#research-contributions`;
  await visit(signedOut, signedOutPath, signedOut.getByRole('heading', { level: 1, name: people[0].displayName, exact: true }));
  for (const label of [en ? 'Sign in to follow' : '登录后关注', en ? 'Sign in to collaborate' : '登录参与研究']) {
    const href = new URL((await signedOut.getByRole('link', { name: label, exact: true }).getAttribute('href'))!, origin);
    assert.equal(href.pathname, '/login.html'); assert.equal(href.searchParams.get('returnTo'), `/${signedOutPath}`, 'sign-in retains the profile, directory filters and section');
  }
  await health(signedOut); await signedOut.close();
  record.assertions.push('People: real field candidates, clickable tags and trimmed/case-insensitive filters; only manageable projects across pages are offered, the member form is prefilled/focused without any write, and signed-out follow links retain their profile return address.');
  record.assertions.push('People: visible research previews, unread count and recent projects above own profile, full-width directory, names/fields/biographies, filtered detail/return navigation');
}
async function theoremFlow(page: Page, record: typeof checks[number], en: boolean) {
  const heading = page.getByRole('heading', { level: 1, name: en ? 'Theorems' : '定理', exact: true });
  await visit(page, 'theorems.html?collection=research', heading);
  const titleLink = page.getByRole('link', { name: theorem.title, exact: true }); await visible(titleLink);
  await page.locator('[data-theorem-collection="solved"]').click({ timeout: 0 });
  await visible(page.locator('[data-openai-problem]').first()); filters(page, { collection: 'solved' }); await health(page);
  await page.locator('[data-theorem-collection="research"]').click({ timeout: 0 }); await visible(titleLink);
  filters(page, { collection: 'research' });
  await directoryWidth(page);
  assert.equal(await page.getByLabel(en ? 'Theorem title' : '定理名称', { exact: true }).count(), 0, 'creator is separate from directory');
  const card = page.locator('.research-directory-card').filter({ has: titleLink });
  for (const text of [theorem.description, theorem.fields[0], theorem.owner.displayName, en ? 'Statement available' : '已有题目陈述'])
    assert((await card.innerText()).includes(text), `theorem card displays ${text}`);
  assert((await page.locator('.research-directory-card').filter({ hasText: statementNeeded.title }).innerText()).includes(en ? 'Statement needed' : '待补充题目陈述'));
  const expectedFilters = { collection: 'research', q: 'Galois', field: 'Algebra' };
  const search = page.getByRole('searchbox', { name: en ? 'Search theorems and descriptions' : '搜索定理与研究描述', exact: true });
  await search.fill(expectedFilters.q, { timeout: 0 }); await search.press('Enter', { timeout: 0 });
  await page.getByLabel(en ? 'Filter by field' : '按领域筛选', { exact: true }).fill(expectedFilters.field, { timeout: 0 });
  await settled(page); filters(page, expectedFilters);
  await capture(page, record, 'theorems-directory');
  console.log(`CHECK ${record.scenario}: theorem creation form`);
  const create = page.getByRole('button', { name: en ? 'New theorem' : '新建定理', exact: true });
  await create.click({ timeout: 0 });
  const input = page.getByLabel(en ? 'Theorem title' : '定理名称', { exact: true }); await input.fill('Retained theorem draft', { timeout: 0 });
  await page.getByLabel(en ? 'Research description' : '研究描述', { exact: true }).fill('Retain this description while browsing.', { timeout: 0 });
  await health(page);
  await page.getByRole('button', { name: en ? 'Back to theorems' : '返回定理目录', exact: true }).click({ timeout: 0 });
  filters(page, expectedFilters);
  await visible(titleLink); await create.click({ timeout: 0 });
  assert.equal(await input.inputValue(), 'Retained theorem draft');
  assert.equal(await page.getByLabel(en ? 'Research description' : '研究描述', { exact: true }).inputValue(), 'Retain this description while browsing.');
  await page.getByRole('button', { name: en ? 'Back to theorems' : '返回定理目录', exact: true }).click({ timeout: 0 });
  console.log(`CHECK ${record.scenario}: theorem detail`);
  await titleLink.click({ timeout: 0 }); await visible(page.getByRole('heading', { level: 1, name: theorem.title, exact: true }));
  filters(page, { ...expectedFilters, id: theorem.id });
  const anchors = ['statement-versions', 'research-progress', 'research-discussion', 'research-members', 'research-timeline'];
  for (const id of anchors) { assert.equal(await page.locator(`.research-section-nav a[href="#${id}"]`).count(), 1); assert.equal(await page.locator(`#${id}`).count(), 1); }
  const version = page.locator('#statement-versions select');
  console.log(`CHECK ${record.scenario}: statement version`);
  assert.equal(await version.inputValue(), theorem.currentStatementVersionId);
  await version.selectOption(versions[0].id, { timeout: 0 });
  await page.getByText(en ? 'Lean statement and source' : 'Lean 陈述与来源', { exact: true }).click({ timeout: 0 });
  assert.equal(await page.locator('#statement-versions pre').textContent(), versions[0].source);
  filters(page, { id: theorem.id, version: versions[0].id });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 0 }); await visible(version);
  assert.equal(await version.inputValue(), versions[0].id, 'selected immutable version survives reload');
  await page.getByText(en ? 'Lean statement and source' : 'Lean 陈述与来源', { exact: true }).click({ timeout: 0 });
  assert.equal(await page.locator('#statement-versions pre').textContent(), versions[0].source);
  await capture(page, record, 'theorems-detail');
  await page.locator('.research-breadcrumb a').click({ timeout: 0 }); await visible(titleLink); filters(page, expectedFilters);
  await visit(page, `theorems.html?id=${theorem.id}`, page.getByRole('heading', { level: 1, name: theorem.title, exact: true }));
  filters(page, { collection: 'research', id: theorem.id }); await health(page);
  record.assertions.push('Theorems: solved/research switching, full-width research cards, persistent creation and filtered return, real title, five anchors, fixed statement/source, direct ID infers research');
}
async function noReuse(page: Page, en: boolean) {
  for (const name of [en ? 'Use in new research' : '用于新研究', en ? 'Add to configuration' : '加入配置选择']) {
    const buttons = page.getByRole('button', { name, exact: true });
    for (const button of await buttons.all()) assert.equal(await button.isEnabled(), false, 'unavailable/withdrawn draft has no enabled reuse action');
  }
  assert.equal(await page.getByText(en ? 'Fork into my space' : '复制到个人空间并修改', { exact: true }).isVisible(), false);
}
async function libraryFlow(page: Page, record: typeof checks[number], en: boolean) {
  const heading = page.getByRole('heading', { level: 1, name: en ? 'Library' : '数学库', exact: true });
  await visit(page, 'library.html?collection=shared', heading); await visible(page.getByRole('link', { name: mathematics.release!.name, exact: true }));
  await directoryWidth(page);
  assert.equal(await page.locator('.research-directory-grid[aria-label] > button').count(), 3);
  const agentPurpose = en ? 'Choose a research setup with coordination and research rules.' : '选择一套研究配置，安排协作与研究规则。';
  for (const label of [en ? 'Math libraries' : '数学库', 'Agent', 'Skill'])
    await visible(page.locator('nav.research-directory-grid').getByText(label, { exact: true }));
  await visible(page.getByRole('heading', { name: en ? 'Shared libraries' : '共享数学库', exact: true }));
  assert.equal(await page.locator('[data-openai-problems-directory],[data-library-collection="openai"]').count(), 0);
  assert.equal(await page.locator('.research-library-collections > button').count(), 3, 'Lean, shared and personal collections share one navigation row');
  await capture(page, record, 'library-directory');
  const types = page.locator('nav.research-directory-grid');
  await types.getByRole('button', { name: en ? 'Math libraries' : '数学库', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert(await types.getByRole('button', { name: 'Agent', exact: true }).evaluate(element => element === document.activeElement), 'Tab reaches Agent category');
  await page.keyboard.press('Enter'); await visible(page.getByRole('link', { name: agent.release!.name, exact: true }));
  filters(page, { type: 'agent' });
  await page.keyboard.press('Tab');
  assert(await types.getByRole('button', { name: 'Skill', exact: true }).evaluate(element => element === document.activeElement), 'Tab reaches Skill category');
  await page.keyboard.press('Enter'); await visible(page.getByRole('link', { name: skill.release!.name, exact: true }));
  filters(page, { type: 'skill' }); await health(page);
  await visit(page, 'library.html?type=agent&collection=shared&mine=1', heading);
  await visible(page.locator('.research-directory-card').filter({ has: page.getByRole('link', { name: agent.name, exact: true }) }));
  assert.equal(await page.locator('.research-library-section-title p').innerText(), agentPurpose);
  assert.equal(await page.getByRole('button', { name: en ? 'My resources' : '我的资源', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('nav.research-directory-grid button[aria-pressed="true"]').innerText(), 'Agent');
  assert(requests.some(request => request.pathname === '/api/research/library' && new URLSearchParams(request.search).get('type') === 'agent' && new URLSearchParams(request.search).get('mine') === '1'));
  filters(page, { type: 'agent', mine: '1' });
  await page.getByRole('link', { name: agent.name, exact: true }).click({ timeout: 0 });
  await visible(page.getByRole('heading', { name: agent.release!.name, level: 2, exact: true }));
  const use = page.getByRole('button', { name: en ? 'Use in new research' : '用于新研究', exact: true }); await visible(use);
  assert.equal(await use.isEnabled(), true);
  const add = page.getByRole('button', { name: en ? 'Add to configuration' : '加入配置选择', exact: true }); assert.equal(await add.isEnabled(), true);
  const sections = await page.locator('.research-content > .research-panel').evaluateAll(elements => elements.map(element => element.querySelector('h2')?.textContent));
  assert.deepEqual(sections.slice(0, 4), [agent.release!.name, en ? 'Published versions' : '已发布版本', en ? 'Personal draft' : '个人草稿', en ? 'Publish a fixed version' : '发布固定版本']);
  assert((await page.locator('.research-content > .research-panel').nth(1).innerText()).includes('Field tower strategy'));
  const download = page.getByRole('link', { name: en ? 'Download release' : '下载版本', exact: true });
  assert.equal(await download.getAttribute('href'), `/api/research/library/${agent.id}/releases/v1?download=1`);
  filters(page, { type: 'agent', mine: '1', entry: agent.id, version: 'v1' });
  await capture(page, record, 'library-detail');
  await add.click({ timeout: 0 }); await visible(page.locator('#research-library-selection'));
  assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('theoremos.research.selection')!)), [{ assetId: agent.id, version: 'v1' }]);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('theorem-os.web-draft-owner.v1')), owner);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 0 }); await visible(page.locator('#research-library-selection'));
  assert.equal(await page.getByRole('button', { name: en ? 'In configuration selection' : '已加入配置选择', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: en ? 'Clear' : '清空', exact: true }).click({ timeout: 0 });
  await health(page);
  for (const item of [unpublished, withdrawn, unavailable]) {
    const releaseQuery = item === unpublished ? '' : '&version=v1';
    await visit(page, `library.html?type=agent&collection=shared&mine=1&entry=${item.id}${releaseQuery}`, heading);
    await visible(page.getByRole('heading', { name: en ? 'Personal draft' : '个人草稿', level: 2, exact: true }));
    if (item === unavailable) await visible(page.getByText('Synthetic release is unavailable.', { exact: true }));
    if (item === withdrawn) await visible(page.getByText(en ? 'This version is withdrawn and cannot be added to a new research configuration.' : '此版本已撤回，不能加入新的研究配置。', { exact: true }));
    await noReuse(page, en); await health(page);
  }
  record.assertions.push('Library: compact full-width categories, keyboard navigation through mathematics/Agent/Skill, URL-driven agent/mine filters, published content before own draft/publishing, fixed reuse and owner-bound selection, no enabled reuse for unpublished/withdrawn/unavailable versions');
}

async function narrowFlow(page: Page, record: typeof checks[number], en: boolean) {
  const screens = [
    ...(!libraryOnly ? [{ name: 'people', href: 'people.html', heading: en ? 'Discover mathematicians' : '发现同行' },
      { name: 'theorems', href: 'theorems.html?collection=research', heading: en ? 'Theorems' : '定理' }] : []),
    { name: 'library', href: 'library.html?collection=shared', heading: en ? 'Library' : '数学库' },
  ];
  for (const screen of screens) {
    const heading = page.getByRole('heading', { level: 1, name: screen.heading, exact: true });
    await visit(page, screen.href, heading);
    await visible(page.locator('.research-directory-card').first()); await directoryWidth(page);
    assert(await heading.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && parseFloat(getComputedStyle(element).fontSize) >= 20;
    }), `${screen.name}: 320px title remains readable and fits the page`);
    await capture(page, record, `${screen.name}-narrow`);
  }
  const category = page.locator('nav.research-directory-grid').getByRole('button', { name: 'Agent', exact: true });
  await category.focus(); await page.keyboard.press('Enter');
  await visible(page.getByRole('link', { name: agent.release!.name, exact: true }));
  filters(page, { type: 'agent' }); await health(page);
  record.assertions.push('320px: directory headings remain readable with no horizontal page overflow; category switches work from the keyboard.');
}

let result: 'passed' | 'failed' = 'passed', failure: string | undefined;
try {
  for (const scenario of [{ name: 'zh-1440', width: 1440, height: 1000, en: false, narrow: false }, { name: 'en-1440', width: 1440, height: 1000, en: true, narrow: false },
    { name: 'zh-390', width: 390, height: 844, en: false, narrow: false }, { name: 'en-390', width: 390, height: 844, en: true, narrow: false },
    { name: 'zh-320', width: 320, height: 844, en: false, narrow: true }, { name: 'en-320', width: 320, height: 844, en: true, narrow: true }]) {
    activeScenario = scenario.name;
    const context: BrowserContext = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, locale: scenario.en ? 'en-US' : 'zh-CN', serviceWorkers: 'block' });
    context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
    await context.addInitScript(locale => localStorage.setItem('theorem-os.web-locale.v1', locale), scenario.en ? 'en' : 'zh');
    await context.route(/^https?:\/\//u, async route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); return; }
      await route.continue();
    });
    const page = await context.newPage(); activePage = page;
    page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && !(message.location().url.includes(`/api/research/library/${unavailable.id}/releases/v1`) && message.text().includes('404')))
        errors.push(message.text());
    });
    const record: typeof checks[number] = { scenario: scenario.name, assertions: [], screenshots: [] };
    if (scenario.narrow) await narrowFlow(page, record, scenario.en);
    else {
      if (!libraryOnly) { await peopleFlow(page, record, scenario.en); await theoremFlow(page, record, scenario.en); }
      await libraryFlow(page, record, scenario.en);
    }
    assert.deepEqual(errors, [], `${scenario.name}: browser errors`);
    checks.push(record); console.log(`PASS ${scenario.name}: ${record.screenshots.length} screenshots`);
    await context.close(); activePage = undefined;
  }
  assert.equal(checks.flatMap(check => check.screenshots).length, libraryOnly ? 10 : 46);
} catch (error) {
  result = 'failed'; failure = error instanceof Error ? error.stack ?? error.message : String(error);
  failureScreenshot = `${activeScenario}-failure.png`;
  await activePage?.screenshot({ path: path.join(output, failureScreenshot), fullPage: true, animations: 'disabled', timeout: 0 }).catch(() => {});
  console.error(failure); process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: result, mode: 'local synthetic API + built web + Chromium',
    checkedAt: new Date().toISOString(), scope: libraryOnly ? 'library' : 'people-theorems-library', realModelCalls: false, realLeanProcesses: false, timeouts: 0, checks, requests,
    unknownApiRequests: unknown, externalRequests: external, ...(failure ? { failedScenario: activeScenario, error: failure, failureScreenshot } : {}) }, null, 2) + '\n');
  await browser.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
