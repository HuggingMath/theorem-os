import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { selectWebLibraryPack, webLibraryCatalog, webLibraryRelease } from '../apps/web/frozenLibrary';
import { prepareWebProblem } from '../apps/web/formalizationSeed';
import { webDefaults } from '../apps/web/config';
import type { WebRunInput } from '../apps/web/shared';
import { bootstrapFormalizedProblem, formalizationDigest, readFormalizationArtifact } from '../src/math/formalization';
import { LIBRARY_PACK_SCHEMA, libraryPackDigest } from '../src/math/libraryPacks';
import { readLeanTaskReceipt } from '../src/math/leanTask';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { localModuleFile, mathConstructionImports } from '../src/math/mathConstructionSources';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { leanReferenceCommands, parseLeanReferenceReport } from '../src/math/leanReferences';
import { committedSource, git, readSolverProblem, withSolverWorktree } from '../src/solver/problem';
import { installedLibraryRetrievals, readInstalledLibrarySnapshot } from '../src/solver/installedLibraryContext';
import { prepareLibraryApplication } from '../src/solver/libraryApplication';
import { writeLibraryCatalog } from '../src/solver/libraryCatalog';
import { approvedFormalization } from './helpers/approvedFormalizationFixture';
import { newestLeanBinary } from './helpers/lean';

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); });
function directory() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-frozen-library-')));
  roots.push(root); return root;
}
const prefix = 'Submission/Library/TheoremOS/';
const fourier = prefix + 'BooleanCube/Fourier.lean';
const source = 'import Mathlib\n\ntheorem web_sign_sq (b : Bool) : (if b then (-1 : ℝ) else 1) ^ 2 = 1 := by sorry\n';
const task = 'Use Boolean cube Fourier sign_sq and preserve the statement.';
const lean = newestLeanBinary();
const input = (): WebRunInput => ({ ...webDefaults, providerId: 'sub2api', apiKey: 'sk-offline-fixture',
  environment: 'mathlib', source, task });

describe('Web workbench frozen hand-written library', () => {
  it('pins the compatible private snapshot to the exact workbench environment', () => {
    const release = webLibraryRelease();
    expect(release.environmentDigest).toBe(getLeanTaskEnvironment('mathlib').dependencyDigest);
    const authoring = JSON.parse(fs.readFileSync(new URL('../resources/theorem-os-library/authoring.json', import.meta.url), 'utf8'));
    expect(release.pack.modules).toHaveLength(53);
    expect(webLibraryCatalog().identity).toMatchObject(authoring.library);
    expect(webLibraryCatalog().identity.revision).toBe('2902dec1e973bd70dad0444a8dc2320cf81d90fd-lean4.33.0-r4');
    expect(release.digest).toBe(libraryPackDigest(release.pack));
    const upstream = release.pack.modules.filter(module => module.origin.kind === 'upstream');
    expect(upstream).toHaveLength(44);
    for (const module of upstream) {
      expect(module.source).toContain('Sources:');
      expect(module.origin).toMatchObject({ kind: 'upstream', repository: 'theorem-os-library',
        commit: '2902dec1e973bd70dad0444a8dc2320cf81d90fd' });
    }
    const authored = release.pack.modules.filter(module => module.origin.kind === 'run');
    expect(authored.map(module => module.file).sort()).toEqual([
      prefix + 'Algebra/FiniteSums.lean', prefix + 'Algebra/PolynomialRoots.lean',
      prefix + 'Analysis/FiniteConvexity.lean', prefix + 'Analysis/FiniteInequalities.lean',
      prefix + 'Combinatorics/FiniteCounting.lean', prefix + 'LinearAlgebra/GramMatrix.lean',
      prefix + 'NumberTheory/Congruences.lean', prefix + 'NumberTheory/Divisibility.lean', prefix + 'Probability/FiniteMoments.lean',
    ]);
    for (const module of authored) {
      const record = authoring.modules.find((record: { file: string }) => record.file === module.file)!;
      expect(module.source).toMatch(/Sources(?: and provenance)?:/u);
      expect(module.origin).toEqual(record.origin);
      expect(module.origin).toMatchObject({ kind: 'run', commit: expect.stringMatching(/^[a-f0-9]{40}$/u),
        receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), environmentDigest: release.environmentDigest });
      expect(mathDigest(module.source)).toBe(record.sourceSha256);
      expect(fs.readFileSync(new URL('../resources/theorem-os-library/' + record.sourceFile, import.meta.url), 'utf8')).toBe(module.source);
    }
  });

  it.each([
    ['Analysis/LittlewoodPolynomial', 'TheoremOS.Analysis.norm_littlewoodPoly_le'],
    ['BooleanCube/Hypercontractivity', 'TheoremOS.BooleanCube.bonami'],
    ['LinearAlgebra/PiTensor', 'TheoremOS.LinearAlgebra.piTensor_mul'],
    ['LinearAlgebra/Pauli', 'TheoremOS.LinearAlgebra.pauliString_expansion'],
    ['InformationTheory/Shearer', 'TheoremOS.InformationTheory.card_pow_le_prod_card_shearer'],
    ['InformationTheory/Divergence', 'TheoremOS.InformationTheory.pinsker'],
    ['Probability/BiasedProduct', 'TheoremOS.Probability.biasedMass_nonneg'],
    ['Probability/Concentration', 'TheoremOS.Probability.sum_biasedMass_hoeffding'],
    ['Probability/LocalLemma', 'TheoremOS.Probability.exists_forall_not_mem_of_lll'],
    ['Probability/SphereLaw', 'TheoremOS.Probability.integral_inner_sq_stdGaussian'],
    ['Probability/GaussianIBP', 'TheoremOS.Probability.integral_sub_pow_even_gaussianReal'],
    ['Probability/TreeReconstruction', 'TheoremOS.Probability.hasSum_poissonWeight_mul'],
    ['Combinatorics/RamseyLower', 'TheoremOS.Combinatorics.ramseyNumber_gt_of_sq_le'],
    ['Analysis/FiniteInequalities', 'TheoremOS.Analysis.FiniteInequalities.weighted_engel_sq'],
    ['Probability/FiniteMoments', 'TheoremOS.Probability.FiniteMoments.variance_affine'],
    ['NumberTheory/Divisibility', 'TheoremOS.NumberTheory.Divisibility.coprime_pow_cancel_pow_left'],
    ['Algebra/PolynomialRoots', 'TheoremOS.Algebra.PolynomialRoots.card_eval_eq_zero_le_natDegree'],
    ['Combinatorics/FiniteCounting', 'TheoremOS.Combinatorics.FiniteCounting.card_le_sum_fiber_capacity'],
    ['Algebra/FiniteSums', 'TheoremOS.Algebra.FiniteSums.sum_by_parts'],
    ['NumberTheory/Congruences', 'TheoremOS.NumberTheory.Congruences.nat_crt_family_existsUnique'],
    ['Analysis/FiniteConvexity', 'TheoremOS.Analysis.FiniteConvexity.normalized_jensen'],
    ['LinearAlgebra/GramMatrix', 'TheoremOS.LinearAlgebra.GramMatrix.normal_solution_minimizes'],
  ])('finds and installs a public theorem from added module %s', (module, name) => {
    const file = prefix + module + '.lean', catalog = webLibraryCatalog();
    expect(catalog.search([{ query: name }], { limit: 1 })[0]!.hits[0]).toMatchObject({ name, file });
    const pack = selectWebLibraryPack({ environment: 'mathlib', task: `Use ${name}.`,
      source: 'import Mathlib\ntheorem target : True := by sorry\n' })!;
    expect(pack.modules.map(module => module.file)).toContain(file);
    const files = new Set(pack.modules.map(module => module.file));
    for (const module of pack.modules) for (const name of mathConstructionImports(module.source))
      if (name.startsWith('Submission.')) expect(files).toContain(localModuleFile(name));
  });

  it('selects relevant modules through the shared theorem search', () => {
    const pack = selectWebLibraryPack({ environment: 'mathlib', source, task });
    expect(pack?.modules.map(module => module.file)).toContain(fourier);
    expect(pack!.modules.length).toBeLessThan(webLibraryRelease().pack.modules.length);
    expect(libraryPackDigest(selectWebLibraryPack({ environment: 'mathlib', source, task })!)).toBe(libraryPackDigest(pack!));
  });

  it('selects from the frozen goal even when the task text has no matching words', () => {
    const pack = selectWebLibraryPack({ environment: 'mathlib', source, task: 'zxqv' });
    expect(pack?.modules.map(module => module.file)).toContain(fourier);
  });

  it('keeps every explicit module and its transitive local import closure', () => {
    const pack = selectWebLibraryPack({ environment: 'mathlib', task: 'zxqv',
      source: 'import Submission.Library.TheoremOS.Probability.MixingLowerBound\ntheorem t : True := by sorry\n' });
    const files = new Set(pack!.modules.map(module => module.file));
    expect(files).toContain(prefix + 'Probability/MixingLowerBound.lean');
    expect(files).toContain(prefix + 'Probability/FiniteProbability.lean');
    expect(files).toContain(prefix + 'InformationTheory/Entropy.lean');
    for (const module of pack!.modules) for (const name of mathConstructionImports(module.source))
      if (name.startsWith('Submission.')) expect(files).toContain(localModuleFile(name));
  });

  it('does not attach a Mathlib library to standard Lean or unrelated tasks', () => {
    expect(selectWebLibraryPack({ environment: 'standard', source, task })).toBeUndefined();
    expect(selectWebLibraryPack({ environment: 'mathlib',
      source: 'theorem t (zxqv : Prop) (h : zxqv) : zxqv := by sorry\n', task: 'zxqv' })).toBeUndefined();
  });

  it('excludes declarations colliding with the original and their dependent modules', () => {
    const pack = selectWebLibraryPack({ environment: 'mathlib', task: 'Boolean cube Fourier influence',
      source: 'import Mathlib\nnamespace TheoremOS.BooleanCube\ntheorem sign_sq : True := by sorry\nend TheoremOS.BooleanCube\n' });
    expect(pack?.modules.some(module => module.file.includes('/BooleanCube/')) ?? false).toBe(false);
  });

  it('rejects explicit imports that conflict with types from the bundled catalog', () => {
    expect(() => selectWebLibraryPack({ environment: 'mathlib', task: '',
      source: 'import Submission.Library.TheoremOS.InformationTheory.Entropy\n' +
        'def TheoremOS.InformationTheory.IsDistribution : Prop := True\n' }))
      .toThrow('web_library_declaration_conflict');
    expect(() => selectWebLibraryPack({ environment: 'mathlib', task: '',
      source: 'import Submission.Library.TheoremOS.BooleanCube.Fourier\n' +
        'namespace TheoremOS.BooleanCube\nstructure sign_sq where\n  value : Nat\nend TheoremOS.BooleanCube\n' }))
      .toThrow('web_library_declaration_conflict');
  });

  it('reports unavailable explicit imports instead of installing unverified modules', () => {
    expect(() => selectWebLibraryPack({ environment: 'mathlib', task: 'zxqv',
      source: 'import Submission.Library.TheoremOS.Analysis.MissingModule\ntheorem t : True := by sorry\n' }))
      .toThrow('web_library_module_unavailable');
  });

  it('installs selected frozen bytes in the ordinary Web entry while preserving the source', () => {
    const request = input(), seed = prepareWebProblem(directory(), { input: request });
    const receipt = readLeanTaskReceipt(seed.activeProblemPath), expected = selectWebLibraryPack(request)!;
    expect(receipt.libraryPack?.digest).toBe(libraryPackDigest(expected));
    expect(receipt.contract.formalStatement).toBe(source);
    expect(fs.readFileSync(path.join(receipt.projectRoot, 'Submission.lean'), 'utf8')).toBe(source);
    for (const module of expected.modules) {
      expect(receipt.libraryPack?.files[module.file]).toBe(mathDigest(module.source));
      expect(fs.readFileSync(path.join(receipt.projectRoot, module.file), 'utf8')).toBe(module.source);
    }
    const problem = readSolverProblem(seed.workspaceRoot, seed.activeProblemPath);
    expect(problem.frozenFiles[fourier]).toBe(mathDigest(expected.modules.find(module => module.file === fourier)!.source));
  });

  it('retrieves a main theorem and premise constructor through a fresh unnamed Web problem', async () => {
    const source = 'import Mathlib\nimport Submission.Library.TheoremOS.Probability.FiniteProbability\nnamespace Current\n' +
      'theorem target {Ω : Type*} [Fintype Ω] [DecidableEq Ω] (P : Matrix Ω Ω ℝ)\n' +
      '    (hP : P ∈ Matrix.rowStochastic ℝ Ω) (x : Ω) :\n' +
      '    TheoremOS.Probability.prob (P x) Finset.univ = 1 := by sorry\nend Current\n';
    const taskText = 'Prove that the total probability of any row of a row stochastic matrix is one.';
    const seed = prepareWebProblem(directory(), { input: { ...input(), source, task: taskText } });
    const problem = readSolverProblem(seed.workspaceRoot, seed.activeProblemPath);
    const environmentDigest = getLeanTaskEnvironment('mathlib').dependencyDigest;
    const library = readInstalledLibrarySnapshot(problem, environmentDigest)!;
    const task = { ...problem.targets[0]!, id: 'original_goal_1', kind: 'goal' as const, revision: 0, dependsOn: [],
      objective: `Prove ${problem.targets[0]!.theoremName}` };
    const application = await prepareLibraryApplication({ problem, task, library, environmentDigest,
      worktree: seed.workspaceRoot, seedCommit: problem.baseCommit, taskText });
    expect(application.status).toBe('candidate');
    expect(application.candidates.length).toBeLessThanOrEqual(12);
    expect(application.candidates[0]?.name).toBe('TheoremOS.Probability.prob_univ');
    expect(application.candidates.map(candidate => candidate.name)).toContain('TheoremOS.Probability.isDistribution_row');
    expect(committedSource(problem.workspace, application.commit!, problem.projectRelative + '/Submission.lean'))
      .toContain('apply _root_.TheoremOS.Probability.isDistribution_row');
    expect(fs.readFileSync(path.join(problem.workspace, problem.projectRelative, 'Submission.lean'), 'utf8')).toBe(source);
    expect(git(problem.workspace, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
  });

  it('automatically installs and recalls the new polynomial bound in an unnamed Web problem', async () => {
    const source = 'import Mathlib\nnamespace Current\n' +
      'theorem target {N : ℕ} (a : Fin N → ℝ) (ha : ∀ k, |a k| ≤ 1)\n' +
      '    {z : ℂ} (hz : ‖z‖ = 1) :\n' +
      '    ‖TheoremOS.Analysis.littlewoodPoly a z‖ ≤ N := by sorry\nend Current\n';
    const taskText = 'Bound a polynomial on the unit circle when each coefficient has absolute value at most one.';
    const seed = prepareWebProblem(directory(), { input: { ...input(), source, task: taskText } });
    const problem = readSolverProblem(seed.workspaceRoot, seed.activeProblemPath);
    const file = prefix + 'Analysis/LittlewoodPolynomial.lean', environmentDigest = getLeanTaskEnvironment('mathlib').dependencyDigest;
    expect(problem.frozenFiles?.[file]).toBe(mathDigest(webLibraryCatalog().readModule(file).source));
    const library = readInstalledLibrarySnapshot(problem, environmentDigest)!;
    const task = { ...problem.targets[0]!, id: 'original_goal_1', kind: 'goal' as const, revision: 0, dependsOn: [],
      objective: `Prove ${problem.targets[0]!.theoremName}` };
    const application = await prepareLibraryApplication({ problem, task, library, environmentDigest,
      worktree: seed.workspaceRoot, seedCommit: problem.baseCommit, taskText });
    expect(application.status).toBe('candidate');
    expect(application.candidates).toContainEqual({ file, name: 'TheoremOS.Analysis.norm_littlewoodPoly_le' });
    const candidate = committedSource(problem.workspace, application.commit!, problem.projectRelative + '/Submission.lean');
    expect(candidate).toContain('import Submission.Library.TheoremOS.Analysis.LittlewoodPolynomial');
    expect(fs.readFileSync(path.join(problem.workspace, problem.projectRelative, 'Submission.lean'), 'utf8')).toBe(source);
    expect(git(problem.workspace, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
  });

  it.each([
    {
      module: 'Analysis/FiniteInequalities', name: 'TheoremOS.Analysis.FiniteInequalities.weighted_engel_sq',
      source: 'import Mathlib\nopen scoped BigOperators\nnamespace Current\n' +
        'theorem target {ι : Type*} (s : Finset ι) (w x d : ι → ℝ)\n' +
        '    (hw : ∀ i ∈ s, 0 ≤ w i) (hd : ∀ i ∈ s, 0 < d i) :\n' +
        '    (∑ i ∈ s, w i * x i) ^ 2 ≤\n' +
        '      (∑ i ∈ s, w i * d i) * ∑ i ∈ s, w i * x i ^ 2 / d i := by sorry\nend Current\n',
      taskText: 'Bound the square of a weighted sum using positive denominators and nonnegative weights.',
    },
    {
      module: 'NumberTheory/Divisibility', name: 'TheoremOS.NumberTheory.Divisibility.coprime_pow_cancel_pow_left',
      source: 'import Mathlib\nnamespace Current\n' +
        'theorem target (a b n r s : ℕ) (hab : Nat.Coprime a b) (h : a ^ r ∣ b ^ s * n) :\n' +
        '    a ^ r ∣ n := by sorry\nend Current\n',
      taskText: 'Cancel the power of a coprime factor from divisibility by a power of the other factor.',
    },
    {
      "module": "Algebra/PolynomialRoots",
      "name": "TheoremOS.Algebra.PolynomialRoots.card_eval_eq_zero_le_natDegree",
      "source": "import Mathlib\nnamespace Current\ntheorem target (p : Polynomial ℝ) (S : Finset ℝ) (hp : p ≠ 0) :\n    (S.filter fun x => p.eval x = 0).card ≤ p.natDegree := by sorry\nend Current\n",
      "taskText": "Bound the number of roots of a nonzero real polynomial inside an arbitrary finite set of test points by the degree of the polynomial."
    },
    {
      "module": "Combinatorics/FiniteCounting",
      "name": "TheoremOS.Combinatorics.FiniteCounting.card_le_sum_fiber_capacity",
      "source": "import Mathlib\nopen scoped BigOperators\nnamespace Current\ntheorem target {α β : Type*} [DecidableEq β] (s : Finset α) (t : Finset β)\n    (f : α → β) (capacity : β → ℕ)\n    (hf : ∀ a ∈ s, f a ∈ t)\n    (hc : ∀ b ∈ t, (s.filter (fun a => f a = b)).card ≤ capacity b) :\n    s.card ≤ ∑ b ∈ t, capacity b := by sorry\nend Current\n",
      "taskText": "A finite collection of objects is assigned to a finite collection of bins. Each bin has its own nonnegative integer capacity, and the number of objects assigned to it is at most that capacity. Show that the number of objects is at most the sum of the bin capacities."
    },
    {
      "module": "Algebra/FiniteSums",
      "name": "TheoremOS.Algebra.FiniteSums.sum_by_parts",
      "source": "import Mathlib\nopen scoped BigOperators\nnamespace Current\ntheorem target (f g : ℕ → ℝ) (n : ℕ) :\n    (∑ k ∈ Finset.range n, f k * g k) =\n      f n * (∑ k ∈ Finset.range n, g k) -\n        ∑ k ∈ Finset.range n, (f (k + 1) - f k) * (∑ j ∈ Finset.range (k + 1), g j) := by sorry\nend Current\n",
      "taskText": "Use finite summation by parts to express a weighted sum through partial sums and forward differences of its weights, including the empty range."
    },
    {
      "module": "NumberTheory/Congruences",
      "name": "TheoremOS.NumberTheory.Congruences.nat_crt_existsUnique",
      "source": "import Mathlib\nnamespace Current\ntheorem target {m n : ℕ} (hm : 0 < m) (hn : 0 < n)\n    (hcop : Nat.Coprime m n) (a b : ℕ) :\n    ∃! x : ℕ, x < m * n ∧ Nat.ModEq m x a ∧ Nat.ModEq n x b := by sorry\nend Current\n",
      "taskText": "Given two positive coprime natural moduli and two arbitrary natural residues, prove that there is exactly one simultaneous residue representative strictly below the product of the moduli."
    },
    {
      "module": "Analysis/FiniteConvexity",
      "name": "TheoremOS.Analysis.FiniteConvexity.normalized_jensen",
      "source": "import Mathlib\nopen scoped BigOperators\nnamespace Current\ntheorem target {ι : Type*} (s : Finset ι) (w x : ι → ℝ) (f : ℝ → ℝ) (C : Set ℝ)\n    (hf : ConvexOn ℝ C f) (hw : ∀ i ∈ s, 0 ≤ w i) (hW : 0 < ∑ i ∈ s, w i)\n    (hx : ∀ i ∈ s, x i ∈ C) :\n    f ((∑ i ∈ s, w i * x i) / (∑ i ∈ s, w i)) ≤\n      (∑ i ∈ s, w i * f (x i)) / (∑ i ∈ s, w i) := by sorry\nend Current\n",
      "taskText": "Given a convex real-valued function on a convex domain, a finite family of points in that domain, and nonnegative real weights of positive total mass, show that the function at the normalized weighted average is at most the normalized weighted average of the function values. The weights are not assumed to sum to one."
    },
    {
      "module": "LinearAlgebra/GramMatrix",
      "name": "TheoremOS.LinearAlgebra.GramMatrix.normal_solution_minimizes",
      "source": "import Mathlib\nopen Matrix\nopen scoped BigOperators\nnamespace Current\ntheorem target {m n : Type*} [Fintype m] [Fintype n]\n    (B : Matrix m n ℝ) (b : m → ℝ) (x y : n → ℝ)\n    (hx : (Bᵀ * B) *ᵥ x = Bᵀ *ᵥ b) :\n    (∑ i, ((B *ᵥ x) i - b i) ^ 2) ≤ ∑ i, ((B *ᵥ y) i - b i) ^ 2 := by sorry\nend Current\n",
      "taskText": "Show that a solution of the normal equations globally minimizes the finite sum of squared residuals in a real least squares problem."
    },
  ])('automatically installs and retains a direct theorem from $module without naming it', async item => {
    const file = prefix + item.module + '.lean';
    const seed = prepareWebProblem(directory(), { input: { ...input(), source: item.source, task: item.taskText } });
    const problem = readSolverProblem(seed.workspaceRoot, seed.activeProblemPath);
    const selected = webLibraryCatalog().readModule(file);
    expect(problem.frozenFiles[file]).toBe(mathDigest(selected.source));
    const environmentDigest = getLeanTaskEnvironment('mathlib').dependencyDigest;
    const library = readInstalledLibrarySnapshot(problem, environmentDigest)!;
    const task = { ...problem.targets[0]!, id: 'original_goal_1', kind: 'goal' as const, revision: 0, dependsOn: [],
      objective: `Prove ${problem.targets[0]!.theoremName}` };
    const application = await prepareLibraryApplication({ problem, task, library, environmentDigest,
      worktree: seed.workspaceRoot, seedCommit: problem.baseCommit, taskText: item.taskText });
    expect(application.status).toBe('candidate');
    expect(application.candidates).toContainEqual({ file, name: item.name });
    expect(application.candidates.length).toBeLessThanOrEqual(12);
    const candidate = committedSource(problem.workspace, application.commit!, problem.projectRelative + '/Submission.lean');
    expect(candidate).toContain('import ' + file.slice(0, -5).replaceAll('/', '.'));
    expect(candidate).toContain('apply _root_.' + item.name);
    expect(fs.readFileSync(path.join(problem.workspace, problem.projectRelative, file), 'utf8')).toBe(selected.source);
    expect(fs.readFileSync(path.join(problem.workspace, problem.projectRelative, 'Submission.lean'), 'utf8')).toBe(item.source);
    expect(git(problem.workspace, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
  });

  it('shares auxiliary slots across distinct premises in a fresh Web catalog application', async () => {
    const root = directory(), file = 'Submission/Library/Crowded/Case.lean';
    const librarySource = 'namespace Crowded\nstructure Tag (n : Nat) : Prop where\n  marker : True\n' +
      'structure IsZero (n : Nat) : Prop where\n  eq_zero : n = 0\n' +
      'theorem succ_eq_one (n : Nat) (tag : Tag n) (h : IsZero n) : Nat.succ n = 1 := congrArg Nat.succ h.eq_zero\n' +
      Array.from({ length: 11 }, (_, index) =>
        `theorem blocked_${String.fromCharCode(97 + index)} (n : Nat) (h : False) : Nat.succ n = 1 := h.elim\n`).join('') +
      ['a', 'b', 'c'].map(suffix => `theorem tag_of_false_${suffix} (n : Nat) (h : False) : Tag n := h.elim\n`).join('') +
      'theorem isZero_of_eq (n : Nat) (h : n = 0) : IsZero n := ⟨h⟩\nend Crowded\n';
    const built = writeLibraryCatalog(path.join(root, 'release'), { id: 'example/web-crowded-premises', revision: 'v1', environment: 'mathlib',
      packs: [{ schema: LIBRARY_PACK_SCHEMA, modules: [{ file, source: librarySource,
        origin: { kind: 'upstream', repository: 'offline-coverage-fixture', commit: 'a'.repeat(40), file: 'Case.lean' } }] }] });
    vi.stubEnv('THEOREMOS_LIBRARY_CATALOG', built.file);
    vi.stubEnv('THEOREMOS_LIBRARY_CATALOG_SHA256', built.digest);
    const source = 'import Submission.Library.Crowded.Case\nnamespace Current\n' +
      'theorem target (n : Nat) (tag : Crowded.Tag n) (h : n = 0) : Nat.succ n = 1 := by sorry\nend Current\n';
    const taskText = 'Prove the successor identity from the given equality and keep the original statement.';
    const seed = prepareWebProblem(path.join(root, 'run'), { input: { ...input(), source, task: taskText } });
    const receipt = readLeanTaskReceipt(seed.activeProblemPath), problem = readSolverProblem(seed.workspaceRoot, seed.activeProblemPath);
    expect(receipt.libraryPack?.files).toEqual({ [file]: mathDigest(librarySource) });
    const environmentDigest = getLeanTaskEnvironment('mathlib').dependencyDigest;
    const library = readInstalledLibrarySnapshot(problem, environmentDigest)!;
    const task = { ...problem.targets[0]!, id: 'original_goal_1', kind: 'goal' as const, revision: 0, dependsOn: [],
      objective: `Prove ${problem.targets[0]!.theoremName}` };
    const ordinary = installedLibraryRetrievals({ problem, library, environmentDigest, taskText, action: { kind: 'task', task } });
    const primary = ordinary[0]!.searchCandidateIds!.map(id => library.base.entries.find(entry => entry.id === id)!.name);
    expect(primary).toHaveLength(12);
    expect(primary[0]).toBe('Crowded.succ_eq_one');
    expect(primary).not.toContain('Crowded.isZero_of_eq');
    const application = await prepareLibraryApplication({ problem, task, library, environmentDigest, taskText,
      worktree: seed.workspaceRoot, seedCommit: problem.baseCommit });
    expect(application.status).toBe('candidate');
    const names = application.candidates.map(candidate => candidate.name);
    expect(names).toHaveLength(12);
    expect(names.slice(0, 3)).toEqual(primary.slice(0, 3));
    expect(names).toContain('Crowded.isZero_of_eq');
    expect(names.filter(name => name.startsWith('Crowded.tag_of_false_'))).toHaveLength(2);
    const candidate = committedSource(problem.workspace, application.commit!, problem.projectRelative + '/Submission.lean');
    expect(candidate).toContain('apply _root_.Crowded.succ_eq_one');
    expect(candidate).toContain('apply _root_.Crowded.isZero_of_eq');
    expect(fs.readFileSync(path.join(receipt.projectRoot, 'Submission.lean'), 'utf8')).toBe(source);
    expect(git(problem.workspace, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
  });

  it.skipIf(!lean)('applies an unnamed Web library theorem in reverse using a recalled premise constructor', async () => {
    const root = directory(), file = 'Submission/Library/Composed/Symm.lean';
    const librarySource = 'namespace Composed\nstructure IsZero (n : Nat) : Prop where\n  eq_zero : n = 0\n' +
      'theorem one_eq_succ (n : Nat) (h : IsZero n) : 1 = Nat.succ n := Eq.symm (congrArg Nat.succ h.eq_zero)\n' +
      'theorem isZero_of_eq (n : Nat) (h : n = 0) : IsZero n := ⟨h⟩\nend Composed\n';
    const built = writeLibraryCatalog(path.join(root, 'release'), { id: 'example/web-composed-symm', revision: 'v1', environment: 'mathlib',
      packs: [{ schema: LIBRARY_PACK_SCHEMA, modules: [{ file, source: librarySource,
        origin: { kind: 'upstream', repository: 'offline-composed-fixture', commit: 'a'.repeat(40), file: 'Symm.lean' } }] }] });
    vi.stubEnv('THEOREMOS_LIBRARY_CATALOG', built.file);
    vi.stubEnv('THEOREMOS_LIBRARY_CATALOG_SHA256', built.digest);
    const source = 'namespace Current\ntheorem target (n : Nat) (h : n = 0) : Nat.succ n = 1 := by sorry\nend Current\n';
    const taskText = 'Prove the successor identity from the given equality and keep the original statement.';
    const seed = prepareWebProblem(path.join(root, 'run'), { input: { ...input(), source, task: taskText } });
    const receipt = readLeanTaskReceipt(seed.activeProblemPath), problem = readSolverProblem(seed.workspaceRoot, seed.activeProblemPath);
    expect(receipt.libraryPack?.files).toEqual({ [file]: mathDigest(librarySource) });
    const environmentDigest = getLeanTaskEnvironment('mathlib').dependencyDigest;
    const library = readInstalledLibrarySnapshot(problem, environmentDigest)!;
    const task = { ...problem.targets[0]!, id: 'original_goal_1', kind: 'goal' as const, revision: 0, dependsOn: [],
      objective: `Prove ${problem.targets[0]!.theoremName}` };
    const application = await prepareLibraryApplication({ problem, task, library, environmentDigest, taskText,
      worktree: seed.workspaceRoot, seedCommit: problem.baseCommit });
    const names = ['Composed.one_eq_succ', 'Composed.isZero_of_eq'];
    expect(application.status).toBe('candidate');
    expect(application.candidates).toEqual(names.map(name => ({ file, name })));
    await withSolverWorktree(problem.workspace, application.commit!, async checkout => {
      const project = path.join(checkout, problem.projectRelative), build = path.join(project, '.lake/build/lib/lean');
      const run = (file: string, output?: string) => {
        if (output) fs.mkdirSync(path.dirname(output), { recursive: true });
        return spawnSync(lean!, [...(output ? ['-R', project, '-o', output] : []), file], {
          cwd: project, env: { ...process.env, LEAN_PATH: build }, encoding: 'utf8', timeout: 30_000,
        });
      };
      const module = run(file, path.join(build, file.replace(/\.lean$/u, '.olean')));
      expect(module.status, module.stdout + module.stderr).toBe(0);
      const consumer = run('Submission.lean', path.join(build, 'Submission.olean'));
      expect(consumer.status, consumer.stdout + consumer.stderr).toBe(0);
      const modules = [{ file, module: file.replace(/\.lean$/u, '').replaceAll('/', '.') }];
      const options = { expectedTheoremName: 'Current.target', expectedModules: modules }, marker = 'WEB_COMPOSED_LIBRARY:';
      fs.writeFileSync(path.join(project, 'Probe.lean'), ['import Lean', 'import Submission',
        ...leanReferenceCommands('Current.target', modules, marker, options), '#print axioms Current.target'].join('\n') + '\n');
      const probe = run('Probe.lean');
      expect(probe.status, probe.stdout + probe.stderr).toBe(0);
      expect(probe.stdout).not.toContain('sorryAx');
      expect(parseLeanReferenceReport(probe.stdout, marker, [file], options)).toMatchObject({ status: 'complete',
        references: { proof: expect.arrayContaining(names.map(name => ({ file, name }))) } });
      expect(fs.readFileSync(path.join(project, file), 'utf8')).toBe(librarySource);
    });
    expect(fs.readFileSync(path.join(receipt.projectRoot, 'Submission.lean'), 'utf8')).toBe(source);
    expect(git(problem.workspace, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
  });

  it.each([
    ['Named', 'Explicit.named_hint', 'namespace Explicit\ntheorem named_hint : True := True.intro\nend Explicit\n'],
    ['Types', 'Explicit.Box', 'namespace Explicit\nstructure Box where\n  value : Nat\nend Explicit\n'],
  ])('installs the task-named %s module before four goal matches in the actual Web receipt', (name, reference, body) => {
    const root = directory(), file = `Submission/Library/Mentioned/${name}.lean`;
    const files = Object.fromEntries(['Nat', 'Bool', 'Int', 'String'].map(type => [
      `Submission/Library/Mentioned/${type}Case.lean`,
      `namespace Mentioned.${type}Case\ntheorem reflexivity (x : ${type}) : x = x := rfl\nend\n`,
    ]));
    const built = writeLibraryCatalog(path.join(root, 'release'), { id: 'example/web-names', revision: 'v1', environment: 'mathlib',
      packs: [{ schema: LIBRARY_PACK_SCHEMA, modules: Object.entries({ ...files, [file]: body }).map(([file, source]) => ({
        file, source, origin: { kind: 'upstream', repository: 'offline-library', commit: 'a'.repeat(40), file: file.split('/').at(-1)! },
      })) }] });
    vi.stubEnv('THEOREMOS_LIBRARY_CATALOG', built.file);
    vi.stubEnv('THEOREMOS_LIBRARY_CATALOG_SHA256', built.digest);
    const source = 'import Mathlib\n' + ['Nat', 'Bool', 'Int', 'String'].map((type, i) =>
      `theorem target_${i} (x : ${type}) : x = x := by sorry\n`).join('');
    const request = { ...input(), source, task: `Use ${reference}.` };
    const expected = selectWebLibraryPack(request)!;
    expect(expected.modules.map(module => module.file)).toContain(file);
    expect(expected.modules).toHaveLength(4);
    const seed = prepareWebProblem(path.join(root, 'run'), { input: request }), receipt = readLeanTaskReceipt(seed.activeProblemPath);
    expect(receipt.libraryPack?.digest).toBe(libraryPackDigest(expected));
    expect(receipt.libraryPack?.files[file]).toBe(mathDigest(body));
    expect(fs.readFileSync(path.join(receipt.projectRoot, file), 'utf8')).toBe(body);
    expect(receipt.contract.formalStatement).toBe(source);
    expect(fs.readFileSync(path.join(receipt.projectRoot, 'Submission.lean'))).toEqual(Buffer.from(source));
  });

  it('installs the same frozen library after approved formalization and pins it on restore', async () => {
    const original = await approvedFormalization(roots, 'web_library_formalized', 'mathlib');
    const evidence = readFormalizationArtifact(path.join(original, 'artifact'));
    const request = { ...input(), source: evidence.candidate.source, formalizationId: evidence.request.problemId };
    const root = directory(), seed = prepareWebProblem(root, { input: request, formalization: evidence });
    const receipt = readLeanTaskReceipt(seed.activeProblemPath), pack = selectWebLibraryPack(request)!;
    expect(receipt.libraryPack?.digest).toBe(libraryPackDigest(pack));
    expect(receipt.contract.formalStatement).toBe(evidence.candidate.source);
    expect(formalizationDigest(readFormalizationArtifact(path.join(root, 'formalized/artifact')))).toBe(formalizationDigest(evidence));
    expect(bootstrapFormalizedProblem(path.join(root, 'formalized'), { libraryPack: pack }).receiptFile).toBe(seed.activeProblemPath);
    expect(() => bootstrapFormalizedProblem(path.join(root, 'formalized'))).toThrow('formalization_solver_seed_changed');
    const changed = structuredClone(pack); changed.modules[0]!.source += '\n-- changed snapshot\n';
    expect(() => bootstrapFormalizedProblem(path.join(root, 'formalized'), { libraryPack: changed }))
      .toThrow('formalization_solver_seed_changed');
  });
});
