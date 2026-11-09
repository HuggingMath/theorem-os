import fs from 'node:fs';
import path from 'node:path';
import { mathDigest, readMathJson, readMathText, writeMathJsonDurable } from '../../src/math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../../src/math/paths';
import { readSolverRunState, type SolverRunState, type SolverWorkerState } from '../../src/solver/archive';
import { readContinuationInput, type ContinuationAttachmentKind } from '../../src/solver/continuationInput';
import { requestedLibraryPack, type LibraryAccess, type LibraryRequest } from '../../src/solver/libraryAccess';
import type { LibrarySelection } from '../../src/solver/libraryCatalog';
import { git, readSolverProblem } from '../../src/solver/problem';
import { aggregateUsage, buildTokenBudget } from '../../src/solver/usageBudget';
import { prepareWebProblem } from './formalizationSeed';
import { summarizeWebLibraryUsage } from './libraryUsage';
import type { WorkerInput } from './shared';

type Seed = ReturnType<typeof prepareWebProblem>;
type Limits = { maxTurns: number; maxRunSeconds: number; maxTotalTokens: number };
export type WebLibraryRound = {
  round: number; seed: Seed; output: string; continuationFile?: string; limits: Limits;
  libraryCatalog?: LibraryAccess; previousSolverRunId?: string; requestedNames?: string[];
};
type Material = { kind: ContinuationAttachmentKind; text: string;
  provenance: { source?: string; evidence: 'unverified' | 'recorded-not-replayed'; runId?: string; commit?: string } };

/** Library changes create new receipts. Prior proof work is carried only as advisory reading material. */
function writeResearchContinuation(directory: string, seed: Seed, materials: Map<string, Material>) {
  let entries = [...materials.entries()];
  if (entries.length > 32) {
    const grouped: [string, Material][] = [];
    for (const kind of new Set(entries.map(([, item]) => item.kind))) {
      let text = '';
      const flush = () => {
        if (text) grouped.push([mathDigest(text), { kind, text, provenance: {
          evidence: 'unverified', source: 'Saved library research archive; each entry retains its own provenance and original content digest.' } }]);
        text = '';
      };
      for (const [digest, item] of entries.filter(([, item]) => item.kind === kind)) {
        const part = `\n--- Saved material ${digest} ---\nProvenance: ${JSON.stringify(item.provenance)}\n${item.text}\n`;
        if (Buffer.byteLength(text) + Buffer.byteLength(part) > 16_000_000) flush();
        text += part;
      }
      flush();
    }
    entries = grouped;
  }
  const attachments = entries.map(([sha256, item], index) => {
    const file = `research-${index}.txt`, bytes = Buffer.byteLength(item.text);
    fs.writeFileSync(path.join(directory, file), item.text, { mode: 0o600, flag: 'wx' });
    return { id: `research-${index}`, kind: item.kind, path: file, sha256, bytes, provenance: item.provenance };
  });
  const file = path.join(directory, 'continuation-input.json');
  const identity = { taskDigest: mathDigest(readMathText(seed.taskFile)),
    problemReceiptDigest: readSolverProblem(seed.workspaceRoot, seed.activeProblemPath).receiptDigest };
  writeMathJsonDurable(file, { schema: 'theorem-os.continuation-input.v1', ...identity, attachments });
  // Apply the same attachment limits and byte checks as the next solver before publishing the transition.
  readContinuationInput(file, identity);
  return file;
}

function collectResearch(state: SolverRunState, directory: string, materials: Map<string, Material>) {
  const trees = [...new Set([state.worktree, ...(state.workers ?? []).map(worker => worker.worktree)])];
  for (const [index, tree] of trees.entries()) {
    if (!isMathPathWithin(directory, tree)) throw new Error('math_library_request_worktree_outside_run');
    assertMathCanonicalPath(tree);
    const commit = git(tree, ['rev-parse', 'HEAD']);
    const provenance: Material['provenance'] = { source: `Library continuation, worker ${index}; saved draft, not proof evidence`,
      evidence: 'recorded-not-replayed', runId: state.runId, commit };
    // Writers have all stopped. Keep saved drafts as well as committed work, without copying frozen library modules.
    const files = state.problem.ownedFiles.filter(file => !state.problem.frozenFiles?.[file]);
    const text = files.map(file => {
      const full = path.join(tree, state.problem.projectRelative, file);
      assertMathCanonicalPath(full);
      return `-- Saved file: ${file}\n${readMathText(full, 16_000_000)}`;
    }).join('\n\n');
    if (text) materials.set(mathDigest(text), { kind: 'proof-source', text, provenance });
    const notesFile = path.join(tree, 'RESEARCH.md');
    if (fs.existsSync(notesFile)) {
      assertMathCanonicalPath(notesFile);
      const notes = readMathText(notesFile, 16_000_000);
      if (notes) materials.set(mathDigest(notes), { kind: 'research-notes', text: notes, provenance });
    }
  }
}

/** Supervise child runs with one total budget and the exact original problem across all library installations. */
export async function runWebLibraryResearch(options: {
  directory: string; request: WorkerInput; seed: Seed; output: string;
  continuationFile?: string; libraryCatalog?: LibraryAccess;
  run(round: WebLibraryRound): Promise<void>;
}) {
  const allowance: Limits = { maxTurns: options.request.input.maxTurns,
    maxRunSeconds: options.request.input.maxRunSeconds, maxTotalTokens: options.request.input.maxTotalTokens ?? 0 };
  let current: WebLibraryRound = { round: 0, seed: options.seed, output: options.output,
    continuationFile: options.continuationFile, limits: allowance, libraryCatalog: options.libraryCatalog };
  const materials = new Map<string, Material>();
  if (options.continuationFile) {
    const input = readContinuationInput(options.continuationFile, {
      taskDigest: mathDigest(readMathText(options.seed.taskFile)),
      problemReceiptDigest: readSolverProblem(options.seed.workspaceRoot, options.seed.activeProblemPath).receiptDigest });
    for (const item of input.manifest.attachments) materials.set(item.sha256, {
      text: input.contents.get(item.sha256)!, kind: item.kind, provenance: item.provenance });
  }
  let turns = 0, solveWallMs = 0, solveExecutionMs = 0;
  const records: (SolverRunState | SolverWorkerState)[] = [];
  const rounds: { round: number; runId?: string; problemReceiptDigest: string; previousSolverRunId?: string;
    status: unknown; turns: number; solveWallMs: number; requestedNames?: string[]; installedModules: string[];
    libraryRequest?: LibraryRequest; librarySelection?: LibrarySelection }[] = [];
  for (;;) {
    await options.run(current);
    const raw = readMathJson(current.output) as Record<string, unknown>;
    const problem = readSolverProblem(current.seed.workspaceRoot, current.seed.activeProblemPath);
    const stateFile = `${current.output}.runtime/state.json`;
    const state = fs.existsSync(stateFile) ? readSolverRunState(stateFile) : undefined;
    if (state && (state.runId !== raw.runId || state.problem.receiptDigest !== problem.receiptDigest))
      throw new Error('math_library_request_run_identity_changed');
    const usedTurns = typeof raw.turns === 'number' && Number.isSafeInteger(raw.turns) && raw.turns >= 0 ? raw.turns : state?.turns ?? 0;
    const usedMs = typeof raw.solveWallMs === 'number' && Number.isSafeInteger(raw.solveWallMs) && raw.solveWallMs >= 0
      ? raw.solveWallMs : state?.solveStartedAt && state.solveFinishedAt ? state.solveFinishedAt - state.solveStartedAt : 0;
    const executedMs = typeof raw.solveExecutionMs === 'number' && Number.isSafeInteger(raw.solveExecutionMs) && raw.solveExecutionMs >= 0
      ? raw.solveExecutionMs : Math.max(0, usedMs - (state?.solveWaitingMs ?? 0));
    turns += usedTurns; solveWallMs += usedMs; solveExecutionMs += executedMs;
    if (state) records.push(...(state.workers?.length ? state.workers : [state]));
    rounds.push({ round: current.round, runId: state?.runId, problemReceiptDigest: problem.receiptDigest,
      previousSolverRunId: current.previousSolverRunId, status: raw.status, turns: usedTurns, solveWallMs: usedMs,
      requestedNames: current.requestedNames, installedModules: Object.keys(problem.frozenFiles ?? {}).sort() });
    const tokenBudget = buildTokenBudget(allowance.maxTotalTokens, records);
    const finish = (result = raw) => {
      const report: Record<string, unknown> = { ...result, turns, solveWallMs, solveExecutionMs, solveWaitingMs: solveWallMs - solveExecutionMs,
        ...(state ? { usage: aggregateUsage(records), tokenBudget } : {}),
        ...(options.libraryCatalog ? { libraryUsage: summarizeWebLibraryUsage(problem, options.libraryCatalog, result, current.round) } : {}),
        libraryResearch: { schema: 'theorem-os.library-research.v1', rounds } };
      writeMathJsonDurable(path.join(options.directory, 'library-research.json'), report);
      return { seed: current.seed, output: current.output, raw: report };
    };
    if (raw.status !== 'library_requested') return finish();
    if (!options.libraryCatalog || !state || !state.solveStartedAt || !state.solveFinishedAt)
      throw new Error('math_library_request_run_incomplete');
    const value = raw.libraryRequest as { request?: unknown; worktree?: unknown } | undefined;
    if (!value || typeof value.worktree !== 'string' ||
        ![state.worktree, ...(state.workers ?? []).map(worker => worker.worktree)].includes(value.worktree) ||
        !isMathPathWithin(options.directory, value.worktree)) throw new Error('math_library_request_worker_changed');
    const next = requestedLibraryPack(problem, value.request, options.libraryCatalog, value.worktree);
    Object.assign(rounds.at(-1)!, { libraryRequest: next.request, librarySelection: next.selection });
    const limits: Limits = { maxTurns: allowance.maxTurns ? Math.max(0, allowance.maxTurns - turns) : 0,
      maxRunSeconds: allowance.maxRunSeconds ? Math.max(0, Math.floor(allowance.maxRunSeconds - solveExecutionMs / 1000)) : 0,
      maxTotalTokens: allowance.maxTotalTokens ? Math.max(0, allowance.maxTotalTokens - (tokenBudget.reportedTotalTokens ?? 0)) : 0 };
    // Zero means unlimited to runSolver. Never pass an exhausted finite allowance as zero.
    const reason = allowance.maxTurns && !limits.maxTurns ? 'math_turn_limit_reached' :
      allowance.maxRunSeconds && !limits.maxRunSeconds ? 'math_run_stopped' : tokenBudget.reason;
    if (reason) return finish({ ...raw, status: 'limit_reached', run_outcome: 'limit_reached', reason });
    collectResearch(state, options.directory, materials);
    const round = current.round + 1, directory = path.join(options.directory, 'rounds', String(round));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const seed = prepareWebProblem(directory, options.request, { libraryPack: next.pack });
    const original = readSolverProblem(options.seed.workspaceRoot, options.seed.activeProblemPath);
    const continued = readSolverProblem(seed.workspaceRoot, seed.activeProblemPath);
    if (continued.contract.formalStatement !== original.contract.formalStatement ||
        continued.contract.informalStatement !== original.contract.informalStatement ||
        readMathText(seed.taskFile) !== readMathText(options.seed.taskFile)) throw new Error('math_library_request_original_changed');
    const continuationFile = writeResearchContinuation(directory, seed, materials);
    writeMathJsonDurable(path.join(options.directory, 'library-research.json'), { schema: 'theorem-os.library-research.v1',
      rounds, turns, solveWallMs, solveExecutionMs, tokenBudget, pending: { round, previousSolverRunId: state.runId,
        problemReceiptDigest: continued.receiptDigest, selection: next.selection, request: next.request } });
    current = { round, seed, output: path.join(directory, 'result.json'), limits, continuationFile,
      libraryCatalog: options.libraryCatalog, previousSolverRunId: state.runId, requestedNames: next.request.names };
  }
}
