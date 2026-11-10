import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareFormalization } from '../../src/math/formalization';
import { defaultFormalizationWorkflow } from '../../src/math/formalizationWorkflow';
import type { StructuredReviewInput } from '../../src/math/formalizationReviewV2';
import { readMathText } from '../../src/math/mathRuntimeIo';
import type { MathAgentOptions, MathAgentSession } from '../../src/runtime/codexSession';
import { runFormalization } from '../../src/solver/formalization';
import { buildFixture, candidateFixture, fixtureStatement, semanticReviewFixture, syntheticElaboration } from './formalizationFixture';

// A replayed, preset-approved formalization of the fixture statement for contract tests only; no model or Lean runs.
/** Fragment pairs both preset reviewers give; `(n : Nat) : n + 0 = n` names the observed type's binder and conclusion. */
export const APPROVED_CORRESPONDENCES = [
  { aspect: 'domains', original: 'natural number n', lean: '(n : Nat)' },
  { aspect: 'quantifierScope', original: 'For every natural number n', lean: 'theorem addition (n : Nat)' },
  { aspect: 'conclusions', original: 'n + 0 = n', lean: 'n + 0 = n' },
  { aspect: 'assumptions', original: 'For every', lean: 'addition (n : Nat) :' },
  { aspect: 'definitions', original: '+', lean: '+' },
  // Only in the observed type, so a proof file never has it.
  { aspect: 'instanceCoherence', original: 'n + 0', lean: 'forall (n : Nat), n + 0 = n' },
] as const;
/** A proof of the formalization's `addition`, through a helper lemma with the same statement. */
export const ADDITION_PROOF = ['theorem helper (n : Nat) : n + 0 = n := rfl', '',
  'theorem addition (n : Nat) : n + 0 = n := by', '  exact helper n', ''].join('\n');
const author = { model: 'preset-author', effort: 'none', profile: '/preset-author', executable: '/no-model' };

function review(input: StructuredReviewInput) {
  const output = semanticReviewFixture(input);
  output.correspondences = APPROVED_CORRESPONDENCES.map((item, index) => ({ ...output.correspondences[index]!, aspect: item.aspect,
    originalFragment: item.original, candidateFragment: item.lean, explanation: `${item.original} is ${item.lean}.` }));
  return output;
}

/** Runs a replayed formalization to approval; returns its run directory, whose artifact/ the informalization reads. */
export async function approvedFormalization(roots: string[], problemId = 'synthetic_addition',
  environment: 'standard' | 'mathlib' = 'standard'): Promise<string> {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approved-formalization-'))); roots.push(parent);
  const { root, manifest } = buildFixture(parent), directory = path.join(parent, 'run');
  prepareFormalization(directory, { problemId, statement: fixtureStatement, environment, execution: 'replay', ...author,
    workflow: defaultFormalizationWorkflow(author), buildManifestRef: manifest, maxRounds: 1, maxRunSeconds: 60, maxTurnSeconds: 10,
    maxCompileSeconds: 10, maxTotalTokens: 0 });
  let sequence = 0;
  const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
    const number = ++sequence, role = path.basename(config.workspace);
    return { threadId: 'preset-formalization-' + number, close: async () => {}, interrupt: async () => {},
      run: async (_message, _id, workspace, onStarted) => {
        onStarted('preset-formalization-turn-' + number); config.onUsage({ totalTokens: 1 });
        const input = JSON.parse(readMathText(path.join(workspace, 'INPUT.json')));
        const output = role.startsWith('plan-') ? { schema: 'theorem-os.formalization-plan.v1', taskKind: 'prove',
          spans: [{ id: 'source', start: 0, end: input.statement.length, text: input.statement }],
          objects: [{ id: 'natural-number', spanIds: ['source'], description: 'Every natural number n.', leanType: 'Nat' }],
          assumptions: [], definitions: [], unresolved: [], conclusions: [{ id: 'zero-identity', spanIds: ['source'],
            mathematics: 'For every natural n, n + 0 = n.', targetNames: ['addition'], assumptionIds: [] }] }
          : role === 'generate' ? candidateFixture(input.statement)
          : role === 'backtranslate' ? { snapshotDigest: input.snapshotDigest, mathematics: 'The natural zero identity.', assumptions: [],
            definitions: [], targets: input.targets.map((target: { name: string }) => ({ name: target.name, mathematics: 'For every n, n + 0 = n.' })) }
          : review(input);
        fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), JSON.stringify(output));
        return 'completed';
      } };
  };
  const result = await runFormalization(directory, root, { openSession: open,
    elaborate: async (_directory, source, environment, options) => syntheticElaboration(source, environment, options) });
  if (result.status !== 'approved') throw new Error('approved_formalization_fixture_failed: ' + JSON.stringify(result));
  return directory;
}
