import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { projectMathematicsRuntimeEnvironment, resolveMathematicsRuntimeEnvironment } from '../src/math/mathRuntimeEnvironment';
import { MATH_TOOLS_SHA256_ENV } from '../src/math/mathTools';
import { PANTOGRAPH_DIGEST_ENV, PANTOGRAPH_SOURCE_COMMIT } from '../src/math/pantographSession';
import { prepareSolverRuntimeEnvironment } from '../src/solver/environment';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'solver-env-'))); directories.push(directory);
  const toolsRoot = path.join(directory, 'tools'), toolsFile = path.join(toolsRoot, 'manifest.json');
  fs.mkdirSync(path.join(toolsRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(toolsRoot, 'bin/fixture-math'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(toolsFile, JSON.stringify({ schema: 'theorem-os.math-tools.v1', tools: [{
    name: 'fixture', version: '1', purpose: 'Disposable test tool', commands: ['fixture-math'],
  }] }));
  const corpusFile = path.join(directory, 'corpus.json'); fs.writeFileSync(corpusFile, '{}\n');
  const executable = path.join(directory, 'fixture-backend'); fs.writeFileSync(executable, 'not executed');
  const backendFile = path.join(directory, 'backend.json');
  fs.writeFileSync(backendFile, JSON.stringify({ schema: 'theorem-os.pantograph-backend.v1',
    sourceCommit: PANTOGRAPH_SOURCE_COMMIT, toolchain: 'leanprover/lean4:v4.33.1',
    executable: 'fixture-backend', libraryDirectories: [],
    files: [{ path: 'fixture-backend', sha256: mathDigest(fs.readFileSync(executable)) }] }));
  const environment = { DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'absent.env'),
    DEEPSCIENTIST_MATH_TOOLS_ROOT: toolsRoot, DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS: corpusFile,
    DEEPSCIENTIST_MATH_PANTOGRAPH_MANIFEST: backendFile };
  return { environment, toolsFile, corpusFile, backendFile };
}

describe('solver runtime resource identity', () => {
  it('binds actual resource hashes before computing the shared environment identity', () => {
    const f = fixture(), prepared = prepareSolverRuntimeEnvironment(f.environment);
    expect(prepared.environment.DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256).toBe(mathDigest(fs.readFileSync(f.corpusFile)));
    expect(prepared.environment[MATH_TOOLS_SHA256_ENV]).toBe(mathDigest(fs.readFileSync(f.toolsFile)));
    expect(prepared.environment[PANTOGRAPH_DIGEST_ENV]).toBe(prepared.proofSearchBackend!.digest);
    expect(prepared.environmentDigest).toBe(mathDigest(canonicalMathJson(projectMathematicsRuntimeEnvironment(prepared.environment))));
    expect(prepared.environmentDigest).not.toBe(mathDigest(canonicalMathJson(
      projectMathematicsRuntimeEnvironment(resolveMathematicsRuntimeEnvironment(f.environment)))));
    expect(prepareSolverRuntimeEnvironment(prepared.environment).environmentDigest).toBe(prepared.environmentDigest);
  });

  it.each([
    ['toolsFile', MATH_TOOLS_SHA256_ENV, 'math_tools_identity_changed'],
    ['corpusFile', 'DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256', 'math_corpus_identity_changed'],
    ['backendFile', PANTOGRAPH_DIGEST_ENV, 'proof_search_backend_identity_changed'],
  ] as const)('rejects changed %s after its identity has been frozen', (file, key, error) => {
    const f = fixture(), prepared = prepareSolverRuntimeEnvironment(f.environment);
    fs.appendFileSync(f[file], '\n');
    expect(() => prepareSolverRuntimeEnvironment(prepared.environment)).toThrow(error);
    const fresh = prepareSolverRuntimeEnvironment(f.environment);
    expect(fresh.environment[key]).not.toBe(prepared.environment[key]);
    expect(fresh.environmentDigest).not.toBe(prepared.environmentDigest);
  });
});
