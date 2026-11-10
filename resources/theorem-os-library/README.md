# Private Web library snapshot

`release/catalog.json` freezes a private release containing 44 upstream modules
from commit `2902dec1e973bd70dad0444a8dc2320cf81d90fd` and nine locally authored
modules. The upstream repository is closed source and has no separate license
grant. Keep this snapshot private; do not include it in the public site export
or publish it to a public remote.

The upstream library targets Lean 4.34.1. The current release,
`2902dec1e973bd70dad0444a8dc2320cf81d90fd-lean4.33.0-r4`, includes 53 modules
under the Web workbench's Lean 4.33.0 and Mathlib
`db584cd6d46c92f209a44c0f1c829460d327499d`, with 1,964 searchable theorem and
definition interfaces. All 50 modules from r3 retain their source bytes and
complete module metadata, including their upstream or library-spec run origins.
The compatible r1 release added the 13 previously excluded upstream modules
(484 interfaces):
Littlewood polynomials, hypercontractivity, tensor and Pauli matrices, Shearer
entropy inequalities, biased products, concentration, divergence, Ramsey lower
bounds, the local lemma, sphere laws, Gaussian integration by parts and tree
reconstruction.

Every upstream module preserves upstream declaration statements, definitions and
`Sources:` documentation. Local imports are renamed from `TheoremOS.*` to
`Submission.Library.TheoremOS.*`; declaration namespaces stay unchanged.
`lean4.33.0.patch` records the additional proof compatibility changes, applied
after import renaming. `compatibility.json` binds each of those 13 modules to its
upstream, import-renamed and final source SHA-256, and compiled output SHA-256.
The original 31 module sources are unchanged; their verified compiled outputs
were reused, and all 13 additions were independently compiled in the pinned
environment. No modules remain excluded at this upstream revision.

The three r2 additions are `Analysis/FiniteInequalities` (25 theorems),
`Probability/FiniteMoments` (29 theorems and one covariance definition), and
`NumberTheory/Divisibility` (21 theorems): 75 theorems and one definition in total.

The three r3 additions are `Algebra/PolynomialRoots` (20 theorems),
`Combinatorics/FiniteCounting` (23 theorems), and `Algebra/FiniteSums`
(22 theorems): 65 further theorems, with no new definitions. They cover finite
root counting, polynomial determination and interpolation; fiber capacities,
double counting and finite covers; and telescoping, summation by parts,
geometric sums and affine recurrences. Only these three modules require new
compilation for r3; the verified compiled outputs of the 47 prior modules are
reused after checking their source and output hashes.

The three r4 additions are `NumberTheory/Congruences` (23 theorems),
`Analysis/FiniteConvexity` (22 theorems), and `LinearAlgebra/GramMatrix`
(22 theorems): 67 further theorems, with no new definitions. They cover
coprime affine cancellation, finite and compatible Chinese remainders, signed
interval representatives and exponent periods; normalized and subprobability
convex combinations, affine images and Jensen inequalities; and Gram quadratic
forms, regularization, column independence and least-squares optimality.
Only these three modules require new compilation for r4; the verified compiled
outputs of the 50 prior modules are reused after checking their source and
output hashes.

All nine local modules were verified through host-authored library-spec runs and
extracted with `keepOriginals`, preserving the complete submitted modules. Their
`origin.kind` is `run`, with the actual run ID, source commit and receipt digest.
`authoring.json` retains all nine origins, source and compiled output SHA-256 values,
and successful axiom checks; source copies and their provenance notes are
under `authored/TheoremOS/`. These verification runs invoked no solver model.

Each catalog module records its source SHA-256 and either its upstream origin or
its library-spec run origin. The catalog contains searchable public interfaces;
full sources live separately under `release/objects/<sha256>.lean` and are read
only when selected.

Web proof bootstrap searches these interfaces and installs at most four matched
module roots plus their dependencies. Explicit imports always include their full
dependency closure. The frozen task receipt pins the selected pack and source
hashes; the solver verifies it in the destination environment. Standard Lean
tasks do not install Mathlib-dependent modules.

`bun scripts/prepare-web-library.ts` compiles the complete compatible snapshot
into the worker image for statement prechecks. Proof workers still install and
check their selected frozen pack independently.

The shared consumer supports named releases (`owner/name`, revision and exact
catalog SHA-256). See [the library catalog workflow](../../docs/library-catalog.md)
for indexing additional packs and generating a selected pack with a version lock.
