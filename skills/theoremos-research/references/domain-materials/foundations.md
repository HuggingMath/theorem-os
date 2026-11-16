# Foundations: collected reading

These are original summaries of passages read for the first collection. Read the identified source for its full statements and conventions. PDF pages count from the first page of the downloaded file and can differ from printed pages. This file retains links and original summaries only. Reuse notes report explicit statements read in the sources; other source licences remain unverified.

## set-theory

**集合论 / Set Theory Expert** (D091)

Reading: [Open Logic Project — Open Logic Text, release a216aa6 (14 November 2026)](https://builds.openlogicproject.org/open-logic-complete.pdf)

Reuse: PDF p. 1 states Creative Commons Attribution 4.0 International (CC BY 4.0).

Locator: §4.9, Definitions 4.22–4.23 and Theorem 4.24; printed pp. 70–71, PDF pp. 71–72.

Knowledge: An injection from A to B expresses that A is no larger than B, while a bijection expresses equal size. Cantor's theorem states that every set A has strictly smaller cardinality than its power set. In particular, no map from A to its power set is surjective.

Scope: Cardinal comparison by maps and Cantor's theorem; ordinals, forcing and choice principles are outside these passages.

### Further reading

Reading: [Open Logic Project — Open Logic Text, release a216aa6 (14 November 2026)](https://builds.openlogicproject.org/open-logic-complete.pdf)

Locator: §66.3, Theorem 66.12, printed p. 875 / PDF p. 876; §66.4, Definition 66.13, printed p. 876 / PDF p. 877, and Theorems 66.16–66.17, printed p. 877 / PDF p. 878.

Knowledge: Any two well-orderings are comparable: one is order-isomorphic to an initial segment, possibly the whole set, of the other. A von Neumann ordinal is a transitive set well-ordered by membership. For ordinals α and β, exactly one of α ∈ β, α = β or β ∈ α holds. Transfinite induction is a scheme for formulas: if a property holds of each ordinal whenever it holds of every smaller ordinal, it holds of every ordinal.

Scope: Comparison applies to already well-ordered sets; this reading does not assert that every set can be well-ordered. Ordinal induction is a formula scheme rather than a set of all ordinals. Choice-equivalence results, cardinal arithmetic and forcing remain outside these passages.

## mathematical-logic

**数理逻辑 / Mathematical Logic Expert** (D092)

Reading: [Open Logic Project — Open Logic Text, release a216aa6 (14 November 2026)](https://builds.openlogicproject.org/open-logic-complete.pdf)

Reuse: PDF p. 1 states Creative Commons Attribution 4.0 International (CC BY 4.0).

Locator: §§23.8–23.9, Theorem 23.20, Corollary 23.21 and Theorem 23.23; printed pp. 360–361, PDF pp. 361–362.

Knowledge: In classical first-order logic, consistency of a set of sentences gives satisfiability by the completeness theorem. Its consequence formulation says that semantic consequence implies derivability in the stated proof system. Compactness identifies satisfiability with satisfiability of every finite subset, and makes every semantic consequence depend on a finite subset of the premises.

Scope: First-order completeness and compactness in the text's setting; completeness does not supply a decision procedure for arbitrary first-order theories.

### Further reading

Reading: [Open Logic Project — Open Logic Text, release a216aa6 (14 November 2026)](https://builds.openlogicproject.org/open-logic-complete.pdf)

Locator: Definition 33.5 (Robinson’s Q), printed p. 524 / PDF p. 525; Lemma 37.2 and §37.3 setup, printed p. 583 / PDF p. 584; Theorems 37.6–37.7, printed p. 585 / PDF p. 586.

Knowledge: For each arithmetic formula ψ(x) with one free variable, the diagonal lemma supplies a sentence φ such that Robinson’s Q proves φ ↔ ψ(⌜φ⌝). Rosser’s theorem states that every consistent computably axiomatized theory extending Q is incomplete: some sentence and its negation are both unprovable in that theory. The preceding Gödel construction in the source uses ω-consistency to obtain the unprovability of the negated Gödel sentence; Rosser’s theorem needs consistency alone.

Scope: The incompleteness claim retains effective axiomatization and arithmetic strength. It concerns particular arithmetic theories and is compatible with completeness of first-order logical consequence. Second incompleteness and undefinability of truth are outside this addition.

## model-theory

**模型论 / Model Theory Expert** (D093)

Reading: [Open Logic Project — Open Logic Text, release a216aa6 (14 November 2026)](https://builds.openlogicproject.org/open-logic-complete.pdf)

Reuse: PDF p. 1 states Creative Commons Attribution 4.0 International (CC BY 4.0).

Locator: §23.11, Theorem 23.32 and Example 23.34; printed pp. 363–364, PDF pp. 364–365.

Knowledge: In a countable first-order language, a consistent theory has a model whose domain is finite or countably infinite. Thus a theory with an infinite model cannot force all of its models to have uncountable domains. If ZFC is consistent, its externally countable models can nevertheless satisfy internal assertions that particular sets are uncountable, as illustrated by Skolem's paradox.

Scope: The countable-language Löwenheim–Skolem consequence and internal versus external cardinality; arbitrary-language cardinal bounds, saturation and classification theory are outside this reading.

### Further reading

Reading: [David Marker — Introduction to Model Theory, MSRI Publications 39 (2000)](https://library.slmath.org/books/Book39/files/marker.pdf)

Locator: §5, definitions of types, Propositions 5.1 and 5.3; §6, Definition 6.1 and Lemma 6.2; printed pp. 27–30 / PDF pp. 13–16.

Knowledge: An n-type over A is a set of formulas with parameters from A consistent with the theory of the ambient structure with those parameters named. A complete type decides every formula in the given free variables. Compactness gives a realization of each type in an elementary extension; it need not be realized in the original structure. The Stone space Sₙ(A) of complete types is compact and totally disconnected, with a clopen basic set for each formula. A structure is κ-saturated when every complete 1-type over each parameter set of size less than κ is realized internally; this also yields realization of finite-tuple types. In a saturated M, finite tuples have the same type over A with |A| < |M| exactly when an automorphism of M fixing A carries one tuple to the other.

Scope: “Saturated” here means |M|-saturated, and the parameter-size restriction belongs to the homogeneity statement. No unconditional existence theorem for saturated models of every desired size or general stability classification is claimed. The source's redistribution licence was not verified.

## proof-theory

**证明论 / Proof Theory Expert** (D094)

Reading: [Open Logic Project — Open Logic Text, release a216aa6 (14 November 2026)](https://builds.openlogicproject.org/open-logic-complete.pdf)

Reuse: PDF p. 1 states Creative Commons Attribution 4.0 International (CC BY 4.0).

Locator: §9.1, Definitions 9.1–9.2, printed pp. 123–124 / PDF pp. 124–125; Propositions 9.13–9.14, printed p. 132 / PDF p. 133.

Knowledge: In classical LK, a sequent Γ ⇒ Δ expresses that truth of all antecedent sentences entails truth of at least one succedent sentence. Derivations are trees of sequents built from initial sequents using logical and structural rules. Derivability is monotone in the premises, and the cut rule supplies the stated transitivity of derivability.

Scope: Sequent meaning, derivation structure and basic metaproperties; these passages do not establish cut elimination, normalization or ordinal analysis.

### Further reading

Reading: [Frank Pfenning, with edits by André Platzer — Lecture Notes on Cut Elimination, 15-317 Constructive Logic, Lecture 10 (5 October 2017)](https://www.cs.cmu.edu/~crary/317-f26/lectures/10-cutelim.pdf)

Locator: §2, Theorem 1 (Cut), L10.2 / PDF p. 2; §4, Theorem 3 (Cut Elimination), L10.8 / PDF p. 8; §5, Theorem 4 (Identity), L10.9 / PDF p. 9. The pure-intuitionistic, single-conclusion setup is on PDF p. 1.

Knowledge: In the lecture's cut-free intuitionistic calculus, cut is admissible: derivations of Γ ⇒ A and Γ, A ⇒ C entail a derivation of Γ ⇒ C without adding a new inference rule. If cut is instead included as an explicit rule, every derivable sequent still has a cut-free derivation. Thus adding cut changes the allowed proof trees without enlarging the set of derivable sequents in this calculus. The identity theorem also shows that initial sequents restricted to atomic propositions suffice to derive A ⇒ A for arbitrary propositions.

Scope: This addition concerns the source's single-conclusion intuitionistic calculus, distinct from the classical multiple-conclusion LK setup above. Existence of a cut-free derivation does not by itself state strong normalization of every reduction sequence. Ordinal analysis and cut elimination for additional axioms or other calculi are outside these passages; the source's redistribution licence was not verified.

## computability-theory

**可计算性理论 / Computability Theory Expert** (D095)

Reading: [Open Logic Project — Open Logic Text, release a216aa6 (14 November 2026)](https://builds.openlogicproject.org/open-logic-complete.pdf)

Reuse: PDF p. 1 states Creative Commons Attribution 4.0 International (CC BY 4.0).

Locator: §30.20, Theorem 30.23 and the discussion of index sets; printed pp. 465–466, PDF pp. 466–467.

Knowledge: Under the standard effective indexing of partial computable functions, an index set contains either every index of a particular function or none of them. Rice's theorem says that a nontrivial such set is undecidable. The property must concern the function computed, so syntactic properties such as program length are not covered by that conclusion.

Scope: Nontrivial extensional properties of partial computable functions; no complexity bound or undecidability claim for every syntactic program property is intended.

### Further reading

Reading: [Open Logic Project — Open Logic Text, release a216aa6 (14 November 2026)](https://builds.openlogicproject.org/open-logic-complete.pdf)

Locator: §30.4, Theorem 30.3, printed p. 450 / PDF p. 451; §30.21, Lemma 30.25 and Theorem 30.26, printed p. 468 / PDF p. 469.

Knowledge: The s-m-n theorem gives a primitive recursive operation on program indices that fixes the first m arguments of a partial computable function and returns an index for the resulting n-argument function. The fixed-point theorem says that every partial computable g(x, y) has an index e satisfying φ_e(y) ≃ g(e, y) for all y. Equivalently, every total computable transformation f of indices has some e with φ_e(y) ≃ φ_f(e)(y) for every y.

Scope: The source fixes an effective enumeration of partial computable functions. Equality ≃ includes agreement on undefinedness. The fixed point identifies computed partial functions and need not satisfy the numerical equation e = f(e); it provides no general termination guarantee or halting decision.

## type-theory

**类型论 / Type Theory Expert** (D096)

Reading: [The Univalent Foundations Program — Homotopy Type Theory: Univalent Foundations of Mathematics](https://hott.github.io/book/hott-online-82-g578b85c.pdf)

Reuse: PDF p. 4 states Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0).

Locator: §1.12, printed pp. 47–48 / PDF pp. 59–60; §2.10, Lemma 2.10.1 and Axiom 2.10.3, printed pp. 89–90 / PDF pp. 101–102.

Knowledge: Identity types form a family depending on two terms of a type, and their inhabitants witness propositional equality. The text distinguishes this equality from judgmental equality, which already yields an identity witness by reflexivity. Univalence is an additional axiom asserting that the canonical map from identity of types in a universe to equivalence of those types is itself an equivalence.

Scope: Identity types and the univalence axiom in this HoTT foundation; these passages do not assert that Lean or every dependent type theory adopts univalence.

### Further reading

Reading: [The Univalent Foundations Program — Homotopy Type Theory: Univalent Foundations of Mathematics](https://hott.github.io/book/hott-online-82-g578b85c.pdf)

Locator: §3.7, propositional truncation constructors, recursor and additional-rule qualification, printed p. 117 / PDF p. 129; existential interpretation and Definition 3.7.1, printed p. 118 / PDF p. 130.

Knowledge: Propositional truncation adds a type ||A|| with a map a ↦ |a| from A and an equality between every pair of inhabitants of ||A||, making it a mere proposition. For a mere proposition B, each map f : A → B induces a map g : ||A|| → B with g(|a|) ≡ f(a). Truncating a sum gives disjunction without a retained branch, while truncating a dependent sum expresses existence without retaining a chosen witness.

Scope: The recursor described here has a mere proposition as codomain; it does not allow unrestricted extraction of a witness into an arbitrary type. The book assumes truncation as an additional rule at this point. Choice principles and their relation to other type theories require separate statements.

## category-theory

**范畴论 / Category Theory Expert** (D097)

Reading: [Tom Leinster — Basic Category Theory, author arXiv edition](https://arxiv.org/pdf/1612.09375)

Reuse: PDF p. 2 explicitly licenses this arXiv version under CC BY-NC-SA 4.0.

Locator: §2.1, Definition 2.1.1 and its naturality equations, printed pp. 41–42 / PDF pp. 49–50; §2.2, Lemma 2.2.2 and Theorem 2.2.5, printed pp. 52–53 / PDF pp. 60–61.

Knowledge: An adjunction F ⊣ G is a family of hom-set bijections B(F(A), B) ≅ A(A, G(B)) natural in both objects. Naturality requires compatibility with composition in each argument, beyond the existence of separate bijections. Equivalently, an adjunction consists of a unit and counit satisfying the two triangle identities.

Scope: Ordinary category adjunctions and their equivalent data; enriched or higher adjunctions require additional structures not supplied by these passages.

### Further reading

Reading: [Tom Leinster — Basic Category Theory, author arXiv edition](https://arxiv.org/pdf/1612.09375)

Locator: §4.2, Theorem 4.2.1, printed p. 94 / PDF p. 102, and its two explicit maps, printed p. 96 / PDF p. 104; §4.3, Corollary 4.3.2, printed p. 99 / PDF p. 107.

Knowledge: For a locally small category C and a presheaf X : C^op → Set, Yoneda gives a bijection Nat(C(−, A), X) ≅ X(A), natural in A and X. It sends a natural transformation α to α_A(id_A); an element x ∈ X(A) gives the transformation whose component sends f : B → A to X(f)(x). A representation of X is equivalently an object A with a universal element u ∈ X(A): every x ∈ X(B) has a unique f : B → A for which X(f)(u) = x.

Scope: Set-valued presheaves on a locally small category, with the contravariant direction shown explicitly. The universal-element condition characterizes representability and does not assert that every presheaf is representable. Enriched and higher categorical versions are outside these passages.

## higher-category-theory

**高阶范畴论 / Higher Category Theory Expert** (D098)

Reading: [Jacob Lurie — Higher Topos Theory](https://www.math.ias.edu/~lurie/papers/HTT.pdf)

Reuse: PDF p. 4 credits Princeton University Press and states “All Rights Reserved”; redistribution permission was not established.

Locator: §1.1.2, Definition 1.1.2.4 and Examples 1.1.2.5–1.1.2.6; printed p. 14, PDF p. 32.

Knowledge: In the quasicategory model, an ∞-category is a simplicial set in which every inner horn admits a filler. The condition requires existence rather than uniqueness of these fillers, retaining coherent higher composition data. Kan complexes and nerves of ordinary categories are examples, but the definition does not require fillers for every outer horn.

Scope: The quasicategory model and its first examples; comparison of higher-category models, higher topoi and strictification results are outside this reading.

### Further reading

Reading: [Jacob Lurie — Higher Topos Theory](https://www.math.ias.edu/~lurie/papers/HTT.pdf)

Locator: §1.2.2, Proposition 1.2.2.3, printed pp. 26–27 / PDF pp. 44–45; §1.2.12, Definition 1.2.12.1 and Proposition 1.2.12.9, printed pp. 44–46 / PDF pp. 62–64; §1.2.13, Examples 1.2.13.1–1.2.13.2 and Definition 1.2.13.4, printed pp. 46–47 / PDF pp. 64–65.

Knowledge: Mapping objects in an ∞-category carry homotopy types rather than only sets of arrows; the right mapping simplicial set is a Kan complex. A final object t is characterized by weak contractibility of every incoming mapping space Map(x, t). Products have a mapping-space universal property: maps into a product recover the product of the mapping spaces. In a homotopy fiber product, the data include two points together with a path between their images, so requiring strict equality of those images would give a different construction in general. A colimit of a diagram is an initial object of its ∞-category of cones under the diagram, and a limit is a final object of the corresponding cone category over it. If the space of such universal cones is nonempty, it is contractible.

Scope: These are homotopy-coherent universal properties in the quasicategory setting. Passing to an ordinary homotopy category can lose the mapping-space information, so its ordinary limits need not describe these limits. Model comparisons, higher topoi and general strictification remain outside the cited passages; the source's All Rights Reserved notice still applies.

## order-theory

**序理论 / Order Theory Expert** (D099)

Reading: [Samson Abramsky and Achim Jung — Domain Theory](https://achimjungbham.github.io/pub/papers/handy1.pdf)

Locator: §2.1.2, Definition 2.1.3, PDF p. 12; §§2.1.5–2.1.6, Definitions 2.1.13 and 2.1.17 and Theorem 2.1.19, PDF pp. 15–16.

Knowledge: A directed-complete partial order has a supremum for every nonempty directed subset, whereas a complete lattice has suprema and infima for all subsets. A Scott-continuous map is monotone and preserves directed suprema. On a pointed dcpo, a Scott-continuous endomap f has least fixed point supₙ fⁿ(⊥).

Scope: Directed completeness, Scott continuity and the stated least-fixed-point theorem; this reading does not identify monotonicity alone with Scott continuity.

### Further reading

Reading: [Samson Abramsky and Achim Jung — Domain Theory](https://achimjungbham.github.io/pub/papers/handy1.pdf)

Locator: §2.2.1, Definition 2.2.1, PDF p. 18; §2.2.3, Definition 2.2.6 and Proposition 2.2.7, PDF p. 19; algebraic and continuous examples, PDF p. 20.

Knowledge: In a dcpo, x ≪ y means that every directed set S with y ≤ sup S contains an s with x ≤ s. An element c is compact when c ≪ c. A dcpo is continuous exactly when each x is the directed supremum of elements way below x; it is algebraic exactly when each x is the directed supremum of compact elements below it. Every algebraic dcpo is continuous. For partial functions ordered by graph inclusion, the compact elements are the functions with finite domain.

Scope: Continuity and algebraicity are additional approximation properties. A countable basis is a further assumption, expressed by ω-continuity or ω-algebraicity under the source’s definitions. General lattice completeness, cartesian closure and classifications of all dcpos are outside this reading.

## program-semantics

**程序语义与逻辑 / Program Semantics and Logic Expert** (D100)

Reading: [Benjamin C. Pierce et al., Software Foundations project — Programming Language Foundations, “Hoare Logic, Part I”](https://softwarefoundations.cis.upenn.edu/plf-current/Hoare.html)

Locator: “Hoare Triples, Informally,” “Hoare Triples, Formally,” definition valid_hoare_triple, and the partial-versus-total correctness discussion following the while-loop rules.

Knowledge: A valid Hoare triple {P} c {Q} requires every terminating execution of c from a state satisfying P to end in a state satisfying Q. This partial-correctness assertion does not itself require termination, so it can hold vacuously when no such execution terminates. Total correctness additionally requires termination.

Scope: The textbook's Imp commands and Hoare partial correctness; nondeterministic, concurrent and exceptional semantics require their own definitions.

### Further reading

Reading: [Benjamin C. Pierce et al., Software Foundations project — Programming Language Foundations, “Hoare Logic, Part I”](https://softwarefoundations.cis.upenn.edu/plf-current/Hoare.html)

Locator: “Additional Exercises,” exercises “Havoc” (module Himp, E_Havoc and valid_hoare_triple) and “Assert and Assume” (module HoareAssertAssume, result, E_AssertTrue, E_AssertFalse, E_Assume and valid_hoare_triple).

Knowledge: The nondeterministic command havoc x may assign any natural number to x. Its Hoare validity definition quantifies over every terminating outcome, so existence of one outcome satisfying the postcondition is insufficient. The assert/assume extension distinguishes normal states from an explicit error result. A false assertion produces that error, whereas a false assumption has no evaluation result. Its modified valid triple requires every evaluation from a state satisfying the precondition to produce a normal state satisfying the postcondition. Consequently an assertion error violates this validity condition, while an execution blocked by a false assumption can satisfy the partial-correctness triple vacuously.

Scope: These are the explicit semantics and validity definitions in two textbook exercise modules; incomplete exercise proofs are not being cited as established mechanized theorems. Partial correctness still supplies no termination or progress guarantee. Concurrency, fairness, and general exception-handler semantics are outside these extensions; source redistribution permission was not established.
