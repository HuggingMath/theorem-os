#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DockerWebRunner, type WebRunner } from '../apps/web/runner';
import { WebStorage } from '../apps/web/storage';
import { WebKnowledgeService } from '../apps/web/knowledgeService';
import { WebJobs } from '../apps/web/jobs';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { researchMathematics } from '../apps/web/researchMathematics';
import { buildTheoremKnowledge } from '../src/solver/theoremKnowledge';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { leanReferenceCommands, parseLeanReferenceReport } from '../src/math/leanReferences';

const output = path.resolve(process.env.THEOREMOS_RESEARCH_LEAN_OUTPUT ?? '/tmp/theoremos-research-lean');
fs.mkdirSync(output, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-research-lean-data-'));
const runner = new DockerWebRunner({ workerImage: process.env.THEOREMOS_RESEARCH_LEAN_IMAGE
  ?? 'theorem-os-worker:8a67c59654133c96e07886dc922d11d9b2e2d88e' });
const storage = new WebStorage(data), knowledge = new WebKnowledgeService(storage);
const noModels: WebRunner = { readiness: async () => ({ ready: false, message: 'Offline fixture' }),
  run: async () => { throw new Error('This verification must never call a model.'); } };
const jobs = new WebJobs(noModels, { concurrency: 1, queueLimit: 2 }, { storage, knowledge });
const mathematics = researchMathematics(storage, knowledge, jobs, runner);
const assets = new WebResearchAssets(storage, { resolveMathematics: mathematics.resolve, validateMathematics: mathematics.validate });
try {
  const source = 'import Lean\n\ntheorem shared_zero (n : Nat) : n + 0 = n := by exact Nat.add_zero n\n';
  const originalCheck = await runner.check({ environment: 'standard', source }, AbortSignal.timeout(60_000));
  assert.equal(originalCheck.exitCode, 0, originalCheck.output);
  const environmentDigest = getLeanTaskEnvironment('standard').dependencyDigest;
  const base = buildTheoremKnowledge([{ name: 'shared_zero', file: 'Evidence.lean', type: '(n : Nat) : n + 0 = n',
    typeKind: 'source-header', kind: 'lemma', description: 'Reusable zero-addition lemma', premises: [],
    dependencies: { statement: [], proof: [], tasks: [], coverage: 'recorded' }, files: { 'Evidence.lean': source },
    provenance: { kind: 'solver-check', problemId: 'disposable-library-smoke', source: 'Evidence.lean',
      sourceDigest: mathDigest(source), sourceCommit: 'a'.repeat(40), environmentDigest, receiptIds: [mathDigest(JSON.stringify(originalCheck))] } }]);
  const catalog = knowledge.importCatalog('alice-fixture', base);
  const draft = assets.create('alice-fixture', { requestId: 'create-library', type: 'mathematics', name: 'Zero addition',
    content: { source: { kind: 'knowledge', catalogDigest: catalog.digest, entryIds: [base.entries[0].id] } } });
  const publication = await assets.publish('alice-fixture', draft.id, { requestId: 'publish-library', expectedRevision: draft.revision,
    version: '1.0.0', license: 'MIT', visibility: 'public' });
  const completed = await assets.waitForPublication('alice-fixture', publication.id);
  assert.equal(completed.status, 'completed', completed.reason);
  const release = assets.release('charlie-fixture', draft.id, '1.0.0');
  const frozen = assets.freeze('charlie-fixture', { libraries: [{ assetId: draft.id, version: '1.0.0' }] }, 'standard');
  assert(frozen.libraryPack && release.mathematics);
  const modules = frozen.libraryPack.modules.map(module => ({ module: module.file.slice(0, -5).replaceAll('/', '.'), file: module.file }));
  const consumer = 'import Lean\n' + modules.map(module => `import ${module.module}`).join('\n')
    + '\n\ntheorem consumer (n : Nat) : n + 0 = n := by exact shared_zero n\n';
  const marker = 'THEOREMOS_RESEARCH_REFERENCES:';
  const commands = leanReferenceCommands('consumer', modules, marker, {});
  const checked = await runner.check({ environment: 'standard', libraryPack: frozen.libraryPack,
    source: consumer + '\n' + commands.join('\n') + '\n' }, AbortSignal.timeout(60_000));
  assert.equal(checked.exitCode, 0, checked.output);
  const references = parseLeanReferenceReport(checked.output, marker, modules.map(module => module.file));
  assert.equal(references.status, 'complete', JSON.stringify(references));
  assert(references.status === 'complete' && references.references.proof.some(item => item.name === 'shared_zero'));
  const missing = await runner.check({ environment: 'standard', source: consumer }, AbortSignal.timeout(60_000));
  assert.notEqual(missing.exitCode, 0, 'Consumer must fail without the fixed library.');
  const candidate = 'import Local.Helper\n\ntheorem candidate_target : True := by exact local_helper\n';
  const candidateContext = { environment: 'standard' as const, sourceFile: 'Tasks/Target.lean', source: candidate,
    dependencySources: [{ file: 'Local/Helper.lean', source: 'theorem local_helper : True := by trivial\n' },
      { file: 'Unrelated.lean', source: 'theorem unrelated : False := by sorry\n' }] };
  const candidateCheck = await runner.check(candidateContext, AbortSignal.timeout(60_000));
  assert.equal(candidateCheck.exitCode, 0, candidateCheck.output);
  assert(!candidateCheck.output.includes('sorry'), 'Unrelated unfinished files must not enter the candidate dependency closure.');
  const missingCandidateDependency = await runner.check({ ...candidateContext, dependencySources: [] }, AbortSignal.timeout(60_000));
  assert.notEqual(missingCandidateDependency.exitCode, 0, 'Candidate must fail without its exact local dependency.');
  fs.writeFileSync(path.join(output, 'library-release.json'), JSON.stringify(release, null, 2));
  fs.writeFileSync(path.join(output, 'consumer.lean'), consumer);
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ passed: true, modelCalls: 0,
    environmentDigest, configurationDigest: frozen.digest, publication: completed, originalCheck, checked,
    actualReferences: references, missingLibraryRejected: missing.exitCode !== 0,
    candidateContext, candidateCheck, missingCandidateDependencyRejected: missingCandidateDependency.exitCode !== 0,
    scope: 'Independent Lean compilation and actual proof references; no solver S3 acceptance claimed.' }, null, 2));
  console.log(`Real Lean publication and cross-user reference passed: ${output}`);
} finally { await assets.close(); await jobs.close(); fs.rmSync(data, { recursive: true, force: true }); }
