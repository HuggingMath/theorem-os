# Kernel statement context

New formalization requests freeze `contextProtocol: "kernel-v3"`. New v2 model-review CLI runs freeze the same field inside their configuration. The host passes `structureContext: true` and `boundedLibraryContext: true` to the existing Lean exporter, which also enables semantic and detailed binder context. Saved `kernel-v1` and `kernel-v2` requests retain their original query and instruction bytes. No additional model, service or external process framework is required.

Each observed target retains its readable type, imported constants, references and binder dependencies. Its optional `context.semantic` has this structure:

```json
{
  "schema": "theorem-os.lean-statement-semantic.v1",
  "rawType": "<Lean pp.raw expression>",
  "kernelType": ["const", ["str", null, "True"], []],
  "localMeaningClosure": []
}
```

`rawType` uses Lean's raw expression printer rather than the ordinary delaborator. `kernelType` serializes the elaborated closed expression, preserving constant names, universe arguments, implicit applications, binder kinds, lets, projections and literals. Binder display names and metadata are omitted. Universe parameter names are replaced by their positions in each declaration's parameter list. These rules provide a stable structural encoding; they do not reduce expressions to a mathematical normal form or prove equivalence.

Names preserve their structure: `null` is anonymous, `["str", parent, component]` is a string component, and `["num", parent, decimalString]` is a numeric component. Natural literals and indices use decimal strings so values above JavaScript's safe integer range remain exact. Expression tags are `bvar`, `sort`, `const`, `nat`, `string`, `app`, `lam`, `forall`, `let` and `projection`. Universe tags are `zero`, `succ`, `max`, `imax` and `param`. Free variables or unresolved expression/universe metavariables cause export failure.

The local closure follows constants from the target type, then local declaration types and non-proof definition values. An entry records `name`, `kind`, `rawType` and kernel `type`. A non-proof definition additionally records raw `rawValue` and kernel `value`. Local predicates therefore retain their defining expressions. Theorem proof bodies and values whose type is a proposition are excluded; unused local definitions are not added. Imported constants remain exact named references to the pinned environment and retain the existing imported-definition context.

Generated declarations reached from definition values are recorded by their actual Lean names and constant information. The exporter does not infer generated relationships from name spelling or fold distinct declarations into one identity. Unsupported local declaration kinds fail explicitly rather than publishing a partial closure. This increment does not expand candidate source admission: custom structures, inductives, opaque declarations, notation and metaprogramming remain excluded by the existing formalization admission checks.

`kernel-v2` also includes `context.structures`:

```json
{
  "schema": "theorem-os.lean-statement-structures.v1",
  "entries": [
    {
      "name": "ConnectedSpace",
      "class": true,
      "fields": [
        { "name": "ConnectedSpace.toPreconnectedSpace", "type": "<Lean projection type>" },
        { "name": "ConnectedSpace.toNonempty", "type": "<Lean projection type>" }
      ]
    }
  ]
}
```

These entries describe only imported structures among the constants actually exported for that target. Entry names are bound to `context.constants`; each direct field records its real projection name and readable type from the same Lean environment as the candidate. Parent projections are included as direct fields. The exporter does not recursively expand parent structures, follow unrelated imports, or export proof bodies. For example, a `ConnectedSpace` observation can expose its `toNonempty` projection without treating every imported class as part of the target. An explicit `entries: []` is a valid observation when no exported imported constant is a structure.

This is additional statement evidence, not the complete semantics of every import. A reviewer may need to inspect a field's referenced definitions or relationships in the pinned environment. The exporter does not infer equivalence to the informal statement from a structure name or field type. Generation retrieval hints remain generator-only; reviewers and blind backtranslators receive these fields through their own host-observed candidate snapshot.

The extensions use the existing statement-context declaration and byte bounds. Every `kernel-v1` target requires valid semantic context; every `kernel-v2` target requires both semantic and structure context, including an explicit empty structure observation when appropriate. Exceeding a bound or lacking the required extension does not produce an approved partial observation. Evaluation records failed observation as unavailable/unknown. Generation stops the affected round before blind translation or semantic comparison. Neither failure establishes that the candidate differs mathematically from the original.

`kernel-v3` is the default for new requests. It keeps every `kernel-v2` field and gives optional imported-library expansion its own 240000-byte quota: an imported definition over 12000 bytes, a constant past the 256-constant or byte bound, an imported structure whose fields would exceed that quota, and an unfinished depth-2 traversal are recorded in `context.omitted` instead of stopping the round. Complete raw/kernel semantics and the local meaning closure use the existing 4 MB total report bound, independently of that library quota. The statement type, bindings and every local definition are exported exactly or rejected, so omission never hides local meaning. Generation, evidence restore and the role instructions accept a non-empty `omitted` list only under `kernel-v3`; reviewers are told to read an omitted name as that exact pinned-library declaration. On the ProofNet# validation references, `kernel-v2` rejected 5 of the first 16 official formalizations for this reason alone (for example `LinearMap.smulRight`, `QuotientGroup.Quotient.group` proof terms, wide Mathlib structures). `kernel-v2` query bytes are unchanged.

The review reading view preserves these omissions. A direct imported name already listed in `context.omitted` is repeated in `importedLibrary.unavailableDirectNames` without disabling the reading view or inventing an observation. Reviewers must inspect the exact pinned-library declaration when its meaning is needed, or leave the comparison unresolved. Unexplained missing direct names still use the complete-input path. Complete target and local semantics remain inline in either case.

The backtranslator and reviewers receive the same host-observed fields through the existing frozen inputs. Version-selected instructions explain how to read them in pages. Fragment checks also accept exact substrings of raw types/values, local entry names and compact JSON for kernel expression fields. Under `kernel-v2`, a correspondence can additionally quote an actual structure entry name, field projection name or field type. Fragments absent from the saved structure observation cannot satisfy fragment checks. All evidence remains bound to the full snapshot, actual input, source, compiler query and environment. There is no new approval cache or permission to reuse approval across different environments.

For compatibility, the protocol field is optional and has no schema default. Earlier generation v1/v2/v3 requests and structured-review v2 configurations without it keep their original query and instruction bytes. Saved `kernel-v1` configurations also keep their existing bytes and require no new structure export. Every target must meet its frozen protocol during artifact import and restore. A saved configuration's absence, `kernel-v1` or `kernel-v2` value is preserved on resume; completed review receipts restore without another observation or role call. First Proof imports preserve the complete generic evidence. No model round, time or token limits are added.

The encoder and closure algorithm were adapted from [AutoformBot skeleton_probe.lean](https://github.com/facebookresearch/autoform-bot/blob/53f84a05a77e3f0780e0735e0b618d3abee60554/autoform_cli/probes/skeleton_probe.lean). The source attribution and MIT terms are in [third_party/autoform-bot-LICENSE.txt](../third_party/autoform-bot-LICENSE.txt). TheoremOS retains its own source admission, isolation, evidence identities and proof acceptance workflow.

The exporter supports the pinned Lean 4.8.0, Lean 4.33.0 Mathlib and standard-library environments. Regression tests cover binder/universe renaming, theorem-proof changes, local definition changes, implicit instance implementations, recursive definition dependencies, exact large literals and structure-field observations. These tests measure extraction and protocol behavior. They do not measure model fidelity or benchmark accuracy.
