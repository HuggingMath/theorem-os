#!/usr/bin/env bun
/** Create one pinned public Lean-Eval solver workspace for a held-out run. */

import fs from 'node:fs';
import { leanEvalBenchmarkCommit } from '../../src/math/leanEvalBenchmark';
import { parseFlags, required } from './arguments';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapLeanEvalProblem } from "../../src/math/leanEvalBootstrap";
import { classifyLeanEvalHeldOutFamily } from "../../src/math/leanEvalHeldOutEvaluation";
import { readLibraryPack } from '../../src/math/libraryPacks';
import { libraryHostConfigPath } from '../../src/math/libraryHostConfig';
import { resolveMathematicsRuntimeEnvironment } from "../../src/math/mathRuntimeEnvironment";

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2), ['repo', 'problem', 'workspace', 'receipt', 'evaluation-mode',
    'certificate-slots', 'theory-modules', 'library-pack', 'benchmark-profile']);
  if (flags.has('help')) {
    console.log(
      'Usage: bun scripts/mathematics/bootstrapLeanEvalHeldOut.ts --repo DIR --problem ID --workspace DIR [--receipt FILE] [--certificate-slots N] [--theory-modules M] [--library-pack FILE]\n' +
      'N > 0 adds solver-owned Submission/Certificates/Kernel.lean (KernelCompute library) and N empty PartNN.lean modules for kernel-certificate.\n' +
      'M > 0 adds M solver-owned Submission/Theory/TNN.lean modules (empty namespace Submission.Theory) for a reusable theory library.\n' +
      'THEOREMOS_LIBRARY_HOST_CONFIG selects a host-owned pinned release and exact problem/benchmark policy.\n' +
      '--benchmark-profile lean-eval-4.34.1-v1 requires --evaluation-mode benchmark and uses pinned historical inputs without live leaderboard credits.\n' +
      '--library-pack is a legacy input and is rejected when host policy is configured.'
    );
    return;
  }
  const runtime = resolveMathematicsRuntimeEnvironment();
  if (libraryHostConfigPath() && flags.has('library-pack')) throw new Error('library_host_sources_conflict');
  const evaluationMode = flags.get('evaluation-mode') ?? 'official';
  if (!['official', 'benchmark'].includes(evaluationMode)) throw new Error('Invalid --evaluation-mode');
  leanEvalBenchmarkCommit(flags.get('benchmark-profile'), evaluationMode as 'official' | 'benchmark');
  const slots = flags.get('certificate-slots') ?? '0';
  if (!/^[0-9]{1,2}$/u.test(slots)) throw new Error('Invalid --certificate-slots');
  const theoryModules = flags.get('theory-modules') ?? '0';
  if (!/^[0-9]{1,2}$/u.test(theoryModules)) throw new Error('Invalid --theory-modules');
  const repositoryValue = flags.get('repo') || runtime.DEEPSCIENTIST_LEAN_EVAL_ROOT;
  if (!repositoryValue?.trim()) throw new Error('--repo is required');
  const repositoryRoot = path.resolve(repositoryValue);
  const libraryPack = flags.get('library-pack') ? readLibraryPack(flags.get('library-pack')!) : undefined;
  const workspaceRoot = path.resolve(required(flags, 'workspace'));
  if (fs.existsSync(workspaceRoot)) {
    if (!fs.statSync(workspaceRoot).isDirectory() || fs.readdirSync(workspaceRoot).length > 0) {
      throw new Error('--workspace must be a fresh empty directory');
    }
  } else fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  const result = await bootstrapLeanEvalProblem({
    repositoryRoot,
    benchmarkProfile: flags.get('benchmark-profile'),
    problemId: required(flags, 'problem'),
    evaluationMode: evaluationMode as 'official' | 'benchmark',
    workspaceRoot,
    certificateSlots: Number(slots),
    theoryModules: Number(theoryModules),
    ...(libraryPack ? { libraryPack } : {}),
  });
  const receiptPath = path.resolve(flags.get('receipt') || path.join(workspaceRoot, 'bootstrap-result.json'));
  const descriptor = fs.openSync(receiptPath, 'wx', 0o600);
  try {
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify(
        {
          schema: 'deepscientist.mathematics.lean-eval-held-out-bootstrap.v1',
          problemId: result.problem.id,
          family: classifyLeanEvalHeldOutFamily(result.problem),
          benchmarkCommit: result.catalog.benchmarkCommit,
          catalogHash: result.catalog.catalogHash,
          receipt: result.receipt,
          obligationCount: result.binding.publicObligations.length,
        },
        null,
        2
      )}\n`
    );
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  console.log(
    JSON.stringify({
      problemId: result.problem.id,
      workspaceRoot: result.receipt.workspaceRoot,
      projectRoot: result.receipt.projectRoot,
      activeProblemPath: result.receipt.activeProblemPath,
      receiptPath,
    })
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
