import fs from 'node:fs';
import path from 'node:path';
import { autoLibraryFile, autoLibraryModule, parseAutoLibraryRecord } from '../math/autoLibrary';
import type { LeanTaskReceipt } from '../math/leanTask';
import { canonicalMathJson, mathDigest, readMathText } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import { readAutoLibraryRequest, readAutoLibraryState } from './autoLibrary';
import { knowledgeApplicationHintSchema, type KnowledgeApplicationHint } from './theoremKnowledgeApplicationHints';

type InputIdentity = { directory: string; files: Record<string, string> };
const error = (reason: string): never => { throw new Error('math_library_application_' + reason); };
const reason = (cause: unknown) => {
  if (cause instanceof Error) {
    if (cause.message.startsWith('math_library_application_')) return cause.message;
    if (cause.message.startsWith('auto_library_')) return 'math_library_application_' + cause.message.slice('auto_library_'.length).split(':')[0];
    if (cause.name === 'ZodError' || cause instanceof SyntaxError) return 'math_library_application_input_invalid';
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return 'math_library_application_input_missing';
  }
  return 'math_library_application_input_unavailable';
};

/** Read only explicitly supplied, settled builds. A partial legacy record cannot hide the remaining knowledge. */
export function readLibraryApplicationHints(directories: readonly string[], receipt: LeanTaskReceipt,
  frozenFiles: Record<string, string>, environmentDigest: string) {
  const hints: KnowledgeApplicationHint[] = [], inputs: InputIdentity[] = [];
  const skipped: { source: string; name?: string; reason: string }[] = [];
  for (const directory of [...new Set(directories.map(value => path.resolve(value)))].sort()) {
    const identity: InputIdentity = { directory, files: {} }; inputs.push(identity);
    const selected: KnowledgeApplicationHint[] = [];
    const read = (file: string, limit = 64 * 1024 * 1024) => {
      const source = path.join(directory, file); assertMathCanonicalPath(source);
      const text = readMathText(source, limit); identity.files[file] = mathDigest(text); return text;
    };
    try {
      assertMathCanonicalPath(directory);
      read('request.json'); read('state.json');
      if (fs.existsSync(path.join(directory, 'base-pack.json'))) read('base-pack.json');
      const { request } = readAutoLibraryRequest(directory), state = readAutoLibraryState(directory);
      if (!state || !['built', 'none', 'exhausted'].includes(state.status)) error('build_not_settled');
      if (state.requestDigest !== mathDigest(canonicalMathJson(request))) error('request_changed');
      if (request.environmentDigest !== environmentDigest) error('environment_mismatch');
      if (request.challengeSource !== receipt.contract.formalStatement) error('challenge_mismatch');
      for (const module of state.modules) for (const round of module.rounds) {
        if (module.status !== 'published' || !module.published || round.outcome !== 'published' || round.phase !== 'done') continue;
        const source = path.join(directory, 'modules', String(module.index), `round-${round.round}`, 'record.json');
        try {
          if (!round.applicationCheck) error('check_not_recorded');
          const name = module.published;
          if (round.name !== name) error('module_mismatch');
          const recordText = read(path.relative(directory, source), 4 * 1024 * 1024);
          const record = parseAutoLibraryRecord(JSON.parse(recordText));
          if (record.name !== name || record.file !== autoLibraryFile(name) || record.buildId !== request.buildId ||
              record.buildDigest !== request.buildDigest || record.environment.id !== request.environment ||
              record.environment.digest !== environmentDigest || record.trigger.challengeId !== request.challengeId ||
              record.trigger.challengeDigest !== mathDigest(request.challengeSource) || record.trigger.taskDigest !== mathDigest(request.task))
            error('record_identity_mismatch');
          if (receipt.libraryPack?.files[record.file] !== record.sourceDigest ||
              mathDigest(frozenFiles[record.file] ?? '') !== record.sourceDigest ||
              record.requires.some(item => receipt.libraryPack?.files[item.file] !== item.digest)) error('module_not_installed');
          const selectedApplication = round.plan?.consumerApplication, recorded = round.applicationCheck!;
          if (!selectedApplication || canonicalMathJson(selectedApplication) !== canonicalMathJson({
            declaration: recorded.declaration, application: recorded.application })) error('selection_mismatch');
          const application = recorded.application, check = recorded.check;
          if (!record.theorems.includes(recorded.declaration) || round.plan?.target !== application.context.declaration ||
              application.context.file !== 'Submission.lean' ||
              !receipt.publicObligations.some(item => item.name === application.context.declaration)) error('target_mismatch');
          const challengeSource = `import ${autoLibraryModule(name)}\n${request.challengeSource}`;
          if (check.environmentDigest !== environmentDigest || !check.commit || !check.sourceSnapshotDigest ||
              !check.files?.some(item => item.file === record.file && item.digest === record.sourceDigest) ||
              !check.files.some(item => item.file === 'Submission.lean' && item.digest === mathDigest(challengeSource)) ||
              check.files.some(item => Object.hasOwn(frozenFiles, item.file) && mathDigest(frozenFiles[item.file]!) !== item.digest))
            error('check_source_unbound');
          selected.push(knowledgeApplicationHintSchema.parse({
            schema: 'theorem-os.knowledge-application-hint.v1', evidence: 'recorded-not-replayed', requiresFreshCheck: true,
            proofAcceptance: 'not-assessed', consumerCoverage: 'not-assessed',
            scope: { challengeDigest: record.trigger.challengeDigest, originalTaskDigest: record.trigger.taskDigest,
              environmentDigest, problemReceiptDigest: mathDigest(canonicalMathJson(receipt)) },
            origin: { kind: 'auto-library-build', directory, buildId: request.buildId, requestDigest: state.requestDigest,
              stateDigest: identity.files['state.json'], recordDigest: mathDigest(recordText) },
            declaration: { name: recorded.declaration, file: record.file, sourceDigest: record.sourceDigest },
            application, historicalCheck: check,
          }));
        } catch (cause) { skipped.push({ source, name: round.name, reason: reason(cause) }); }
      }
      // A caller can freeze these few files without copying prover worktrees or following their saved absolute paths.
      for (const [file, digest] of Object.entries(identity.files))
        if (mathDigest(readMathText(path.join(directory, file), 64 * 1024 * 1024)) !== digest) error('input_changed');
      hints.push(...selected);
    } catch (cause) { skipped.push({ source: directory, reason: reason(cause) }); }
  }
  return { hints, inputs, skipped };
}
