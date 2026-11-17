# Work with exact declarations

Inspect the actual Lean type and surrounding namespace, variables, instances and imports before applying a similarly named lemma. Use native shell tools such as `rg` to search source text or the host-prepared declaration index, then read the matching source. The local tool help gives the index location. Use the run's library tools when you need frozen dependency metadata or an archived declaration. A name match alone is insufficient.

When elaboration fails, isolate the failing expression in a small probe using the same environment. Check implicit arguments, coercions, notation, universe levels and instance requirements as indicated by the real diagnostic. Recompile after a meaningful change; retain the exact error rather than replacing it with a broad claim that the mathematics is impossible.

Use the generated `check-lean` command directly and inspect its JSON `classification`, `firstBlocking` and `diagnosticArtifacts`. Its exit status is part of the result. A shell pipeline ending in `head`, or a later successful `cat`/`echo`, can hide the compiler's failure. For a manual shell check, redirect output to a file, save the compiler status immediately, then preview the file and return the saved status.

Use the prepared environment and its health result for the first focused check. An unfamiliar dependency layout, a symlink's small apparent size or a missing global tool path does not establish an environment failure. Investigate dependencies when the actual check or health result reports a fault, preserving that diagnostic.

An `infrastructure-error` identifies an environment fault; `leanStarted: false` confirms compilation did not start. Report its error code, fingerprint and recovery to Lead/host, preserve source work, and retry after a repair or changed health result. Use `check-lean --health` with the same worktree to check the actual namespace's sealed mount, lease and pinned compiler. An invisible mount or host PID inside sandbox `/proc` does not establish that the host helper died. Avoid repeated compilation or assembly attempts against the same failed environment; host proof delivery and final verification retain their independent checks.

Computational examples can refute a proposed intermediate claim or guide a conjecture. A successful finite search or numerical experiment does not prove an unrestricted statement. Keep executable experiment code, parameters and output if it informs a route decision.

A reusable helper needs its full type, explicit assumptions and required source context. Prefer a declaration that can be checked independently of the still-open original target. If it depends on an unresolved hypothesis or draft axiom, preserve that dependency and do not describe it as unconditional knowledge. Use the host declaration-delivery interface shown in the generated tool help when that interface is enabled.

Before a final submission, run an appropriate real Lean check and address its actual errors. The host independently freezes and verifies candidates, including all original targets and trusted-source constraints. A locally passing file or a previous receipt does not authorize weakening the frozen problem or changing its environment.
