import fs from 'node:fs';
import path from 'node:path';
import { inspectLeanSource } from '../math/leanSource';
import { canonicalMathJson, mathDigest, writeMathJsonDurable } from '../math/mathRuntimeIo';
import { assertMathAgentSkillsCurrent, type MathAgentSkill } from '../runtime/agentSkills';
import type { SolverRunState } from './archive';
import { checkDeclarationArtifacts, readDeclarationSubmission, writeDeclarationArtifacts,
  DECLARATION_SUBMISSION_FILE, DeclarationArtifactCheckError, DeclarationSubmissionError } from './declarationArtifacts';
import type { ResearchCandidate } from './modules/execution';
import { solverSourceDigest } from './modules/evidence';
import { commitSolverSources, git } from './problem';
import { hasDeterministicLeanFailure } from './proofReuse';
import { VerificationCheckpointError } from './verificationCheckpoint';
import { VerifierFailureError } from './verifierFailure';

/** Stopped-source delivery and recovery for the single Skill writer, without task scheduling. */
export function createSkillProofLifecycle(input: {
  state: SolverRunState; worktree: string; environment: NodeJS.ProcessEnv; skill: MathAgentSkill;
  signal: AbortSignal; proofTimeoutMs?: number;
  writerStopped: () => boolean;
  sourceFeedback: () => string | undefined;
  exclusiveCheck: <T>(check: () => Promise<T>) => Promise<T>;
  checkWhole: (candidate?: ResearchCandidate) => Promise<void>;
  save: () => void;
  emit: (event: string, details?: Record<string, unknown>) => void;
}) {
  const { state, worktree, environment, skill, signal, save, emit } = input;
  const setPhase = (phase: 'running' | 'checking') => { state.phase = phase; save(); };
  const originalProofHasHoles = () => state.problem.ownedFiles.some(file => {
    const source = inspectLeanSource(fs.readFileSync(path.join(worktree, state.problem.projectRelative, file), 'utf8'));
    return source.sorryCount > 0 || source.admitCount > 0;
  });
  const rememberWholeProof = (commit: string) => {
    const pending = { commit, sourceDigest: solverSourceDigest(state.problem, worktree), problemReceiptDigest: state.problem.receiptDigest,
      environmentDigest: state.environmentDigest };
    if (state.pendingProofCheck && canonicalMathJson(state.pendingProofCheck) !== canonicalMathJson(pending))
      throw new Error('math_proof_checkpoint_identity_changed');
    state.pendingProofCheck = pending; save();
  };
  const checkFrozenWholeProof = async (candidate = state.candidate) => {
    const pending = state.pendingProofCheck;
    if (!pending || !input.writerStopped() || input.sourceFeedback() ||
        pending.problemReceiptDigest !== state.problem.receiptDigest || pending.environmentDigest !== state.environmentDigest ||
        git(worktree, ['rev-parse', 'HEAD']) !== pending.commit ||
        git(worktree, ['status', '--porcelain', '--untracked-files=no']) ||
        solverSourceDigest(state.problem, worktree) !== pending.sourceDigest)
      throw new Error('math_proof_checkpoint_identity_changed');
    assertMathAgentSkillsCurrent([skill]);
    setPhase('checking');
    try {
      await input.exclusiveCheck(() => input.checkWhole(candidate));
      // Acceptance deliberately aborts the research loop; its pending cleanup must still finish.
      state.pendingProofCheck = undefined; save();
    } finally { setPhase('running'); }
  };
  const checkDeclarations = async (commit: string) => {
    const requestFile = path.join(worktree, '.scratch', DECLARATION_SUBMISSION_FILE);
    const pending = state.pendingDeclarationCheck, requested = fs.existsSync(requestFile);
    if (pending && (pending.commit !== commit ||
        !requested && pending.phase !== 'completed' ||
        requested && pending.requestDigest !== mathDigest(fs.readFileSync(requestFile))))
      throw new Error('math_declaration_checkpoint_identity_changed');
    if (pending?.phase === 'completed') {
      // Completion is durable before removal; resume finishes cleanup without
      // repeating a check or trusting the worker-editable feedback file.
      fs.rmSync(requestFile, { force: true });
      state.pendingDeclarationCheck = undefined;
      setPhase('running');
      return;
    }
    if (requested) {
      if (!input.writerStopped()) throw new Error('math_writer_stop_unconfirmed');
      state.pendingDeclarationCheck ??= { commit, requestDigest: mathDigest(fs.readFileSync(requestFile)) };
      setPhase('checking');
      let consumed = false;
      try {
        let artifacts: Awaited<ReturnType<typeof checkDeclarationArtifacts>>;
        try {
          const submission = readDeclarationSubmission(worktree)!;
          artifacts = await input.exclusiveCheck(() => checkDeclarationArtifacts({ state,
            worktree, commit, declarations: submission.declarations, env: environment,
            signal, timeoutMs: input.proofTimeoutMs, assertWriterStopped: () => {
              if (!input.writerStopped()) throw new Error('math_writer_stop_unconfirmed');
            } }));
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof VerificationCheckpointError) throw error;
          if (error instanceof DeclarationArtifactCheckError && !hasDeterministicLeanFailure(error.verification))
            throw new VerifierFailureError({ stage: 'declaration-check', sourceCommit: commit, verification: error.verification }, error);
          if (!(error instanceof DeclarationSubmissionError) && !(error instanceof DeclarationArtifactCheckError)) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          writeMathJsonDurable(path.join(worktree, '.scratch/declaration-feedback.json'), {
            status: 'rejected', commit, reason, originalProblemAcceptance: 'not-assessed' });
          consumed = true;
          emit('declarations_checked', { commit, passed: false, reason });
          return;
        }
        // Host persistence failures retain the frozen request for recovery;
        // they are not mathematical feedback for another model turn.
        writeDeclarationArtifacts(path.dirname(worktree), state, artifacts);
        writeMathJsonDurable(path.join(worktree, '.scratch/declaration-feedback.json'), {
          status: 'checked', commit, declarations: artifacts.map(artifact => ({ id: artifact.id,
            ...artifact.declaration })), originalProblemAcceptance: 'not-assessed' });
        consumed = true;
        emit('declarations_checked', { commit, count: artifacts.length, passed: true });
      } finally {
        if (consumed) {
          state.pendingDeclarationCheck = { ...state.pendingDeclarationCheck!, phase: 'completed' };
          save();
          fs.rmSync(requestFile, { force: true });
          state.pendingDeclarationCheck = undefined;
        }
        setPhase('running');
      }
    }
  };
  const freezeSources = async () => {
    if (!input.writerStopped()) throw new Error('math_writer_stop_unconfirmed');
    if (!state.pendingResearchFreeze) {
      state.pendingResearchFreeze = { commit: git(worktree, ['rev-parse', 'HEAD']),
        sourceDigest: solverSourceDigest(state.problem, worktree),
        problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest };
      save();
    }
    const pending = state.pendingResearchFreeze;
    const head = git(worktree, ['rev-parse', 'HEAD']);
    // A crash can leave either the original HEAD or the one host checkpoint it produced.
    if (pending.problemReceiptDigest !== state.problem.receiptDigest || pending.environmentDigest !== state.environmentDigest ||
        input.sourceFeedback() || solverSourceDigest(state.problem, worktree) !== pending.sourceDigest ||
        head !== pending.commit && (git(worktree, ['rev-list', '--parents', '-n', '1', 'HEAD']) !== `${head} ${pending.commit}` ||
          git(worktree, ['status', '--porcelain', '--untracked-files=no'])))
      throw new Error('math_research_freeze_identity_changed');
    assertMathAgentSkillsCurrent([skill]);
    const commit = commitSolverSources(state.problem, worktree);
    const wholeProofReady = !originalProofHasHoles();
    if (wholeProofReady) rememberWholeProof(commit);
    await checkDeclarations(commit);
    state.pendingResearchFreeze = undefined; save();
    return { commit, wholeProofReady };
  };
  const resumePending = async () => {
    if (state.pendingResearchFreeze) await freezeSources();
    if (state.pendingDeclarationCheck) {
      const pending = state.pendingDeclarationCheck;
      if (!input.writerStopped() || input.sourceFeedback() ||
          git(worktree, ['rev-parse', 'HEAD']) !== pending.commit ||
          git(worktree, ['status', '--porcelain', '--untracked-files=no']))
        throw new Error('math_declaration_checkpoint_identity_changed');
      assertMathAgentSkillsCurrent([skill]);
      await checkDeclarations(pending.commit);
      if (!originalProofHasHoles()) rememberWholeProof(pending.commit);
    }
    if (state.pendingProofCheck) await checkFrozenWholeProof();
  };
  return { freezeSources, resumePending, checkFrozenWholeProof };
}
