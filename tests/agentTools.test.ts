import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const commands = ['check-finite', 'check-lean', 'continuation', 'kernel-certificate', 'knowledge', 'search-lean'];
const fixture = path.resolve('examples/finite/old-b1-nine-constraints.json');
let directory = '';
let tools = '';
// Away from the checkout, so a command that still reached for node_modules or the source tree would fail here.
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
});
