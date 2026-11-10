import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formalizationCandidateSchema, prepareFormalization, readFormalizationArtifact } from '../src/math/formalization';
import { readMathText } from '../src/math/mathRuntimeIo';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { readFormalizationState, runFormalization } from '../src/solver/formalization';
import { buildFixture, candidateFixture, fixtureStatement, syntheticElaboration } from './helpers/formalizationFixture';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture(candidates: ReturnType<typeof candidateFixture>[] = []) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'direct-formalization-workflow-')));
  temporary.push(parent);
  const { root, manifest } = buildFixture(parent), directory = path.join(parent, 'run');
  prepareFormalization(directory, { problemId: 'direct_identity', statement: fixtureStatement,
    environment: 'standard', execution: 'replay', model: 'preset-direct', effort: 'none',
    profile: '/no-provider', executable: '/no-model', reviewMode: 'direct', buildManifestRef: manifest,
    maxRounds: 0, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0 });
  const seen: { input: any; message: string; instructions: string }[] = [];
  const openSession = async (options: MathAgentOptions): Promise<MathAgentSession> => ({
    threadId: 'direct-generator-' + (seen.length + 1), close: async () => {}, interrupt: async () => {},
    run: async (message, _id, workspace, started) => {
      expect(path.basename(workspace)).toBe('generate');
      expect(options.turnTimeoutMs).toBeUndefined();
      const input = JSON.parse(readMathText(path.join(workspace, 'INPUT.json')));
      seen.push({ input, message, instructions: options.instructions });
      started('direct-turn-' + seen.length); options.onUsage({ totalTokens: 1 });
      fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), JSON.stringify(candidates[input.round - 1] ?? candidateFixture(input.statement)));
      return 'completed';
    },
  });
  return { root, directory, seen, openSession };
}

// Isolated scheduling and evidence tests use synthetic compiler receipts; no model or Lean process runs here.
describe('direct formalization workflow', () => {
  it('uses one generation and compilation, preserves the original, and restores without adding reviews', async () => {
    const f = fixture(); let compilations = 0;
    const options = { openSession: f.openSession, elaborate: async (_directory, source, environment, limits) => {
      compilations++; expect(limits.timeoutMs).toBe(0);
      return syntheticElaboration(source, environment, limits);
    } } satisfies NonNullable<Parameters<typeof runFormalization>[2]>;
    const result = await runFormalization(f.directory, f.root, options);
    expect(result).toMatchObject({ status: 'approved', rounds: 1, candidatesTried: 1, roleTurns: { generate: 1 } });
    expect(f.seen).toHaveLength(1); expect(compilations).toBe(1);
    expect(f.seen[0].input.statement).toBe(fixtureStatement);
    expect(f.seen[0].message).toContain('BEGIN INPUT.json');
    expect(f.seen[0].instructions).toContain('No separate planning document, backtranslation or reviewer report is needed.');
    expect(f.seen[0].instructions).toContain('Structure and inductive declarations, custom notation and metaprogramming are unsupported');
    expect(f.seen[0].instructions).toContain('necessity and sufficiency belong to one iff target');
    expect(f.seen[0].instructions).toContain('they do not require additional formalization targets');
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence).toMatchObject({ authority: 'compiler', semanticReview: 'not-performed', proofVerified: false });
    expect(evidence.sessions.map(session => session.role)).toEqual(['generate']);
    expect(evidence).not.toHaveProperty('translation'); expect(evidence).not.toHaveProperty('review');
    expect(readMathText(path.join(f.directory, 'task.md'))).toContain('Original problem (verbatim):\n\n' + fixtureStatement);
    expect(await runFormalization(f.directory, f.root, options)).toMatchObject({ status: 'approved' });
    expect(f.seen).toHaveLength(1); expect(compilations).toBe(1);
  });

  it('repairs compiler feedback using generation only and retains the failed attempt', async () => {
    const f = fixture(); let compilations = 0;
    const result = await runFormalization(f.directory, f.root, { openSession: f.openSession,
      elaborate: async (_directory, source, environment, limits) => {
        if (++compilations === 1) throw new Error('formalization_elaboration_failed: unknown constant in statement');
        return syntheticElaboration(source, environment, limits);
      } });
    expect(result).toMatchObject({ status: 'approved', rounds: 2, candidatesTried: 2, roleTurns: { generate: 2 } });
    expect(f.seen[1].input.feedback).toContain('unknown constant in statement');
    expect(f.seen[1].input.previousCandidate.source).toBe(candidateFixture().source);
    expect(readFormalizationState(f.directory).sessions.map(session => session.role)).toEqual(['generate', 'generate']);
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.round).toBe(2); expect(evidence.sessions).toHaveLength(1);
  });

  it('repairs an unsupported structure from its original candidate before invoking the host compiler', async () => {
    const unsupported = formalizationCandidateSchema.parse({ ...candidateFixture(),
      source: 'structure RadicalTower where\n  level : Nat\n\n' + candidateFixture().source });
    const f = fixture([unsupported]); let compilations = 0;
    const result = await runFormalization(f.directory, f.root, { openSession: f.openSession,
      elaborate: async (_directory, source, environment, limits) => {
        compilations++; expect(source).toBe(candidateFixture().source); expect(limits.timeoutMs).toBe(0);
        return syntheticElaboration(source, environment, limits);
      } });
    expect(result).toMatchObject({ status: 'approved', rounds: 2, candidatesTried: 2, roleTurns: { generate: 2 } });
    expect(compilations).toBe(1); expect(f.seen).toHaveLength(2);
    expect(f.seen[1].input.previousCandidate).toEqual(unsupported);
    expect(f.seen[1].input.feedback).toContain('formalization_unsupported_declaration');
    expect(f.seen[1].input.feedback).toContain('ordinary named def/abbrev/instance/theorem/lemma');
    expect(f.seen[1].input.feedback).toContain('Replace structure or inductive declarations with ordinary predicates or existential quantifiers');
    expect(readFormalizationState(f.directory).sessions.map(session => session.role)).toEqual(['generate', 'generate']);
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.round).toBe(2); expect(evidence.candidate.source).toBe(candidateFixture().source);
    expect(evidence.sessions).toHaveLength(1);
  });
});
