# Portfolio exploration

Use this stage when the host assigns bounded scouting before formal proof work. Read the frozen statement and record a route that makes its hardest inference smaller. Save a short blueprint, key transformations, and exact candidate interfaces for small shared lemmas. Keep Lean sources unchanged. Use scratch files for reproducible calculations and small Lean API probes.

- `structural-symmetry` looks for invariant quantities, coordinate changes, symmetries, convexity, and monotone reductions.
- `explicit-constructive` looks for formulas, rational bounds, witnesses, and direct constructions.
- `falsification-obstruction` tests fragile intermediate claims, aiming for explicit counterexamples, degeneracy, or combinatorial blowup. Use a focused Python, PARI/GP, SymPy, or finite constraint probe when it can decide a step.

Report `proposed` for a viable blueprint, `refuted` when you can name the exact failed claim and provide a concrete witness or obstruction, and `inconclusive` when an experiment or search has not settled it. Include the assumptions, reproduction command, result, and saved probe references. State which route ID the evidence concerns. Numerical approximations may motivate a test. Give exact bounds or a reproducible witness before retiring a route.

The gate selects a primary route and may keep one backup. Start proof work with the primary route's shared foundation lemmas and mark the consumer of each. Keep the persisted reasons and evidence for retired routes available to the team. Reconsider a dead end only when new evidence addresses its recorded obstruction. All scout reports and gate decisions are advisory. The host verifies every proof against the frozen Lean problem.
