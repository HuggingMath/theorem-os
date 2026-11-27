import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { LIBRARY_REQUEST_FILE, writeLibraryAccess } from '../src/solver/libraryAccess';
import { writeLibraryCatalog } from '../src/solver/libraryCatalog';
import { readSolverProblem } from '../src/solver/problem';

const commands = ['check-finite', 'check-lean', 'continuation', 'declarations', 'hub', 'kernel-certificate', 'knowledge', 'library',
  'checkpoint', 'plan-validate', 'search-lean'];
const fixture = path.resolve('examples/finite/old-b1-nine-constraints.json');
let directory = '';
let tools = '';
// Exercise relative paths away from the checkout; the build also rejects external runtime imports.
const run = (...args: string[]) => spawnSync('bun', [path.join(tools, 'math.mjs'), ...args], { cwd: directory, encoding: 'utf8', timeout: 20_000 });

describe('bundled Agent commands', () => {
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theorem-os-agent-tools-'));
    tools = path.join(directory, 'tools');
    const built = spawnSync('bun', ['scripts/build-agent-tools.ts', '--out', tools], { encoding: 'utf8', timeout: 60_000 });
    expect(built.status, built.stderr).toBe(0);
    expect(JSON.parse(built.stdout).files).toEqual([...commands, 'math'].map(command => `${command}.mjs`).sort());
  }, 90_000);
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('runs without the application and answers as bin/math.ts does', () => {
    for (const file of fs.readdirSync(tools)) expect(fs.readFileSync(path.join(tools, file), 'utf8')).not.toContain(process.cwd());
    fs.copyFileSync(fixture, path.join(directory, 'input.json'));
    const bundled = run('check-finite', '--input', 'input.json');
    const source = spawnSync('bun', ['bin/math.ts', 'check-finite', '--input', fixture], { encoding: 'utf8', timeout: 10_000 });
    expect(bundled.status, bundled.stderr).toBe(0);
    expect(JSON.parse(bundled.stdout)).toEqual(JSON.parse(source.stdout));
    expect(JSON.parse(bundled.stdout)).toMatchObject({ satisfyingCount: 5, trust: 'advisory', complete: true });
  });

  it('gives every command its usage and refuses names it does not have', () => {
    for (const command of commands) {
      const help = run(command, '--help');
      expect(help.status, `${command}: ${help.stderr}`).toBe(0);
      expect(help.stdout).toContain(`theorem-os ${command}`);
    }
    const unknown = run('benchmark');
    expect(unknown.status).toBe(1);
    for (const command of commands) expect(unknown.stderr + unknown.stdout).toContain(command);
    expect(run('../check-finite').status).toBe(1);
  });

  it('reads uninstalled library modules without checkout access and queues host installation requests', () => {
    const file = 'Submission/Library/Demo/Identity.lean';
    const source = 'namespace Demo\nsection\nvariable {α : Type} (a : α)\n' +
      'theorem identity : a = a := by\n  -- SOURCE_BODY_ONLY\n  rfl\n' +
      '-- Additional module context.\n'.repeat(120) + 'end\nend Demo\n';
    const catalog = writeLibraryCatalog(path.join(directory, 'release'), {
      id: 'fixture/standalone', revision: 'v1', environment: 'standard',
      packs: [{ schema: LIBRARY_PACK_SCHEMA, modules: [{ file, source,
        origin: { kind: 'upstream', repository: 'offline-fixture', commit: 'a'.repeat(40), file: 'Identity.lean' } }] }],
    });
    const receipt = bootstrapLeanTask(path.join(directory, 'worktree'), {
      source: 'theorem target : True := by sorry\n', task: 'Prove the target.',
    });
    const worktree = receipt.workspaceRoot;
    const problem = readSolverProblem(worktree, receipt.activeProblemPath);
    writeLibraryAccess(problem, worktree, { file: catalog.file, digest: catalog.digest });
    const sourceBytes = fs.readFileSync(catalog.file);
    const object = path.join(path.dirname(catalog.file), 'objects', mathDigest(source) + '.lean');
    const command = (...args: string[]) => spawnSync('node', [
      '--permission', `--allow-fs-read=${directory}`, `--allow-fs-write=${worktree}`,
      '--input-type=module', '--eval',
      'const command = await import(process.argv[1]); console.log(JSON.stringify(command.main(process.argv.slice(2))));',
      path.join(tools, 'library.mjs'), ...args, '--worktree', worktree,
    ], { cwd: directory, encoding: 'utf8', timeout: 20_000 });
    const searched = command('search', '--query', 'Demo.identity');
    expect(searched.status, searched.stderr).toBe(0);
    expect(JSON.parse(searched.stdout)).toMatchObject({ library: { catalogDigest: catalog.digest },
      hits: [expect.objectContaining({ name: 'Demo.identity', file, installation: 'not-installed' })] });
    expect(searched.stdout).not.toContain('SOURCE_BODY_ONLY');

    let text = '', offset = 0;
    do {
      const result = command('get', '--name', 'Demo.identity', '--offset', String(offset), '--max-bytes', '1600');
      expect(result.status, result.stderr).toBe(0);
      expect(Buffer.byteLength(result.stdout.trim())).toBeLessThanOrEqual(1600);
      const page = JSON.parse(result.stdout);
      expect(page).toMatchObject({ declaration: { name: 'Demo.identity', file, sourceDigest: mathDigest(source) },
        installation: 'not-installed', source: { offset } });
      text += page.source.text;
      if (page.source.nextOffset === null) { expect(page.source.complete).toBe(true); break; }
      expect(page.source.nextOffset).toBeGreaterThan(offset);
      offset = page.source.nextOffset;
    } while (offset < source.length);
    expect(offset).toBeGreaterThan(0);
    expect(text).toBe(source);

    // Node's permission model disables fchmod even within allowed paths; durable request writes use the normal Agent runtime.
    const requested = run('library', 'request', '--worktree', worktree, '--name', 'Demo.identity', '--reason', 'Use the identity theorem.');
    expect(requested.status, requested.stderr).toBe(0);
    expect(JSON.parse(requested.stdout)).toMatchObject({ status: 'queued' });
    expect(JSON.parse(fs.readFileSync(path.join(worktree, LIBRARY_REQUEST_FILE), 'utf8'))).toMatchObject({
      catalogDigest: catalog.digest, problemReceiptDigest: problem.receiptDigest, names: ['Demo.identity'],
    });
    expect(fs.readFileSync(catalog.file)).toEqual(sourceBytes);
    expect(fs.readFileSync(object, 'utf8')).toBe(source);
    expect(fs.existsSync(path.join(worktree, problem.projectRelative, file))).toBe(false);
  });

  it('searches a saved declaration index without source-tree access', () => {
    const index = path.join(directory, 'DECLARATIONS.jsonl');
    fs.writeFileSync(index, JSON.stringify({ name: 'Sample.owned', kind: 'theorem', file: 'Submission.lean', line: 3,
      sorry: false, type: 'owned : True' }) + '\n');
    const result = run('declarations', 'search', '--index', index, '--query', 'owned');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ authority: 'lexical-source-index',
      hits: [{ name: 'Sample.owned', file: 'Submission.lean', line: 3 }] });
  });
});
