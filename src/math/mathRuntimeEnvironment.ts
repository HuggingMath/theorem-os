/**
 * @license
 * Copyright 2026 DeepScientist contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET_KEY = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY)/iu;
const RESOLVED_ENVIRONMENT = Symbol('resolved mathematics environment');
const withoutSecrets = (source: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(source).filter(([key]) => !SECRET_KEY.test(key)));
const ENV_FILE_KEYS = new Set([
  'DEEPSCIENTIST_LEAN_EVAL_ROOT',
  'DEEPSCIENTIST_LEAN_EVAL_TOOLS_ROOT',
  'DEEPSCIENTIST_LEAN_EVAL_TOOL_MANIFEST',
  'DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS',
  'DEEPSCIENTIST_MATH_TRUSTED_ELAN_ROOTS',
  'DEEPSCIENTIST_MATH_SANDBOX_BACKEND',
  'DEEPSCIENTIST_MATH_SANDBOX_IMAGE',
  'DEEPSCIENTIST_MATH_ENV_FILE',
  'ELAN_HOME',
  'LAKE_HOME',
  'LEAN_PATH',
  'LEAN_SYSROOT',
  'PATH',
]);
const OPTIONAL_ENV_FILE_KEYS = new Set([
  'DEEPSCIENTIST_MATH_LEAN_LOCK',
  'DEEPSCIENTIST_MATH_VERIFIER_CONCURRENCY',
  'DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT',
  'DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT_SEED',
  'DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT_SOURCE_SEED',
  'DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS',
  'DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256',
  'DEEPSCIENTIST_MATH_TOOLS_ROOT',
  'DEEPSCIENTIST_MATH_TOOLS_SHA256',
  'DEEPSCIENTIST_MATH_PANTOGRAPH_MANIFEST',
  'DEEPSCIENTIST_MATH_PANTOGRAPH_SHA256',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
]);

export const DEFAULT_MATHEMATICS_ENV_FILE = path.join(os.homedir(), '.config', 'deepscientist-math', 'math.env');

function parseValue(raw: string): string {
  const value = raw.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readEnvFile(file: string, base: NodeJS.ProcessEnv): Record<string, string> {
  if (!file) return {};
  let source: string;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !file.endsWith('.json')) return {};
    throw error;
  }
  if (file.endsWith('.json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error('Invalid mathematics environment projection');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid mathematics environment projection');
    }
    const values = Object.entries(parsed);
    if (
      [...ENV_FILE_KEYS].some((key) => !Object.hasOwn(parsed, key)) ||
      values.some(
        ([key, value]) =>
          (!ENV_FILE_KEYS.has(key) && !OPTIONAL_ENV_FILE_KEYS.has(key)) ||
          typeof value !== 'string' ||
          (key === 'DEEPSCIENTIST_MATH_ENV_FILE' && value !== file)
      )
    ) {
      throw new Error('Invalid mathematics environment projection');
    }
    return Object.fromEntries(values) as Record<string, string>;
  }
  const values: Record<string, string> = {};
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match || (!ENV_FILE_KEYS.has(match[1]!) && !OPTIONAL_ENV_FILE_KEYS.has(match[1]!))) continue;
    let value = parseValue(match[2]!);
    value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_all, braced, plain) => {
      const key = String(braced || plain);
      return values[key] ?? base[key] ?? '';
    });
    values[match[1]!] = value;
  }
  return values;
}

/** Only mathematics tool settings may enter a solver-visible environment file. */
export function projectMathematicsRuntimeEnvironment(source: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries([
      ...[...ENV_FILE_KEYS].toSorted().map((key) => [key, source[key] ?? '']),
      ...[...OPTIONAL_ENV_FILE_KEYS]
        .filter((key) => source[key] !== undefined)
        .toSorted()
        .map((key) => [key, source[key]!]),
    ])
  );
}

function systemCommandsBeforeUserScripts(entries: string[], source: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'linux') return entries;
  const userBins = new Set([source.HOME, process.env.HOME, os.homedir()]
    .filter((home): home is string => Boolean(home))
    .map(home => path.resolve(home, '.local/bin')));
  const isUserBin = (entry: string) => path.isAbsolute(entry) && userBins.has(path.normalize(entry));
  const isSystemBin = (entry: string) => ['/usr/local/bin', '/usr/bin', '/bin'].includes(path.normalize(entry));
  const lastSystemBin = entries.findLastIndex(isSystemBin);
  const displaced = (entry: string, index: number) => index < lastSystemBin && isUserBin(entry);
  const scripts = entries.filter(displaced);
  if (!scripts.length) return entries;
  const remaining = entries.filter((entry, index) => !displaced(entry, index));
  const insertAt = remaining.findLastIndex(isSystemBin) + 1;
  // Keep explicit tool/venv prefixes and restricted PATHs. User-installed scripts
  // stay available. Only move those shadowing system commands; a user bin already
  // after them must not jump ahead of a later explicit tool/venv directory.
  return [...remaining.slice(0, insertAt), ...scripts, ...remaining.slice(insertAt)];
}

/** Merge the local mathematics env file into subprocesses without importing secrets. */
export function resolveMathematicsRuntimeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  envFile = source.DEEPSCIENTIST_MATH_ENV_FILE?.trim() || DEFAULT_MATHEMATICS_ENV_FILE
): NodeJS.ProcessEnv {
  // The symbol survives host-side spreads but never enters subprocess env strings.
  if ((source as NodeJS.ProcessEnv & { [RESOLVED_ENVIRONMENT]?: string })[RESOLVED_ENVIRONMENT] === envFile)
    return Object.freeze({ ...withoutSecrets(source), [RESOLVED_ENVIRONMENT]: envFile });
  // Apply system defaults before a local file expands an unset PATH.
  const defaultPath = process.platform === 'linux' ? '/usr/bin:/bin' : '';
  const values = readEnvFile(envFile, { ...source, PATH: source.PATH ?? defaultPath });
  // The checked-in/local env file supplies defaults. Explicit values passed by
  // a runner or test remain authoritative, while the file's PATH still
  // contributes its pinned tool directories (it was expanded against source).
  const merged: NodeJS.ProcessEnv = envFile.endsWith('.json')
    ? { ...source, ...values, DEEPSCIENTIST_MATH_ENV_FILE: envFile }
    : { ...values, ...source };
  // A frozen legacy projection must not inherit a caller's new policy overrides.
  if (envFile.endsWith('.json')) {
    for (const key of OPTIONAL_ENV_FILE_KEYS) if (!Object.hasOwn(values, key)) delete merged[key];
  }
  if (values.PATH) merged.PATH = values.PATH;
  const pathEntries = [
    merged.DEEPSCIENTIST_LEAN_EVAL_TOOLS_ROOT && path.join(merged.DEEPSCIENTIST_LEAN_EVAL_TOOLS_ROOT, 'bin'),
    merged.DEEPSCIENTIST_LEAN_EVAL_TOOLS_ROOT,
    merged.ELAN_HOME && path.join(merged.ELAN_HOME, 'bin'),
  ].filter((entry): entry is string => Boolean(entry));
  if (pathEntries.length || process.platform === 'linux') {
    // Missing PATH keeps the system search defaults; an explicit empty PATH stays restricted.
    const basePath = merged.PATH ?? defaultPath;
    merged.PATH = [...pathEntries, ...systemCommandsBeforeUserScripts(basePath.split(path.delimiter), source),
      ...(process.platform === 'linux' ? ['/usr/sbin'] : [])]
      .filter(Boolean)
      .filter((entry, index, entries) => entries.indexOf(entry) === index)
      .join(path.delimiter);
  }
  // Optional computation tools come last, so they never shadow pinned Lean or system commands.
  const toolsBin = merged.DEEPSCIENTIST_MATH_TOOLS_ROOT && path.join(merged.DEEPSCIENTIST_MATH_TOOLS_ROOT, 'bin');
  if (toolsBin && merged.PATH !== undefined && !merged.PATH.split(path.delimiter).includes(toolsBin))
    merged.PATH = [merged.PATH, toolsBin].filter(Boolean).join(path.delimiter);
  return Object.freeze({ ...withoutSecrets(merged), [RESOLVED_ENVIRONMENT]: envFile });
}

export function mathematicsRuntimeInstruction(envFile?: string): string {
  const file = envFile || DEFAULT_MATHEMATICS_ENV_FILE;
  if (file.endsWith('.json')) {
    return `Pinned environment settings: ${file}. These settings are already injected; do not source JSON as a shell script or reload a local env file. Do not install packages or replace the pinned toolchain.`;
  }
  return `Before running Lean, source ${file} when it exists, or use the absolute tools from that file. Do not install packages or replace the pinned toolchain.`;
}
