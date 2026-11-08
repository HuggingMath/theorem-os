#!/usr/bin/env bun
// Copy the built site and the public proof archive into a checkout of LikC1606/theorem-os-site.
// Only the allowed paths are copied, and the result is scanned for private data. Nothing is committed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] && path.resolve(process.argv[2]);
if (!target) throw new Error('Usage: bun scripts/export-site-repo.ts <theorem-os-site checkout>');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const origin = git(target, 'remote', 'get-url', 'origin');
if (!/github\.com[/:]LikC1606\/theorem-os-site(\.git)?$/.test(origin)) throw new Error(`Refusing to export: ${target} has origin ${origin}`);
if (git(target, 'status', '--porcelain')) throw new Error(`Refusing to export: ${target} has uncommitted changes`);
const site = path.join(root, 'out/site');
if (!fs.existsSync(path.join(site, 'index.html')) || !fs.existsSync(path.join(site, 'en/index.html'))) throw new Error('Run bun run build:site first');

for (const entry of fs.readdirSync(target)) if (entry !== '.git') fs.rmSync(path.join(target, entry), { recursive: true, force: true });
fs.cpSync(site, target, { recursive: true });
fs.cpSync(path.join(root, 'docs/site-repo'), target, { recursive: true });
const copy = (file: string) => {
  fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
  fs.copyFileSync(path.join(root, file), path.join(target, file));
};
const proofArchiveFiles = new Set([
  ...git(root, 'ls-files', 'accepted', 'submitted').split('\n').filter(Boolean),
  'submitted/official-results.json',
]);
for (const file of proofArchiveFiles) copy(file);
// Of the research snapshots, publish only the Lean files the archive shows; never runtime state.
const catalog = JSON.parse(fs.readFileSync(path.join(site, 'data/catalog.json'), 'utf8')) as { records: { sources: { path: string }[] }[] };
const snapshots = [...new Set(catalog.records.flatMap(record => record.sources.map(source => source.path)))].filter(file => file.startsWith('in-progress/'));
for (const file of snapshots) {
  if (!file.endsWith('.lean')) throw new Error(`Refusing to publish a non-Lean snapshot file: ${file}`);
  copy(file);
}

const files = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.name === '.git' ? [] : entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const published = files(target).map(file => path.relative(target, file));
const forbiddenFiles = published.filter(file => /(^|\/)(src|apps|scripts)\/|\.(ts|tsx|gz|env)$|(^|\/)(state\.json|task\.md|\.env.*)$/.test(file));
const forbiddenText: [string, RegExp][] = [
  ['local path', /\/(home|data)\/lzh\b/], ['private repository', /LikC1606\/theorem-os(?!-site)\b/],
  ['API key', /\bsk-[A-Za-z0-9_-]{20,}/], ['internal address', /\b(47\.114\.62\.223|127\.0\.0\.1:18181)\b/],
];
const leaks = published.filter(file => /\.(html|js|css|json|md|lean|yml|txt|svg)$/.test(file)).flatMap(file => {
  const text = fs.readFileSync(path.join(target, file), 'utf8');
  return forbiddenText.filter(([, pattern]) => pattern.test(text)).map(([label]) => `${file}: ${label}`);
});
if (forbiddenFiles.length || leaks.length) {
  throw new Error(`Export stopped; the checkout now contains files that must not be published. Restore it with git checkout -- . && git clean -fd\n${[...forbiddenFiles, ...leaks].join('\n')}`);
}
console.log(`Exported ${published.length} files to ${target} (${snapshots.length} snapshot sources). Leak scan passed.`);
console.log(git(target, 'status', '--short') || 'No changes.');
