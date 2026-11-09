# Host-selected library releases

Set `THEOREMOS_LIBRARY_HOST_CONFIG` to an absolute host-owned JSON path in the process that bootstraps or resumes tasks. Do not put this setting in task JSON, `math.env`, an agent profile, or a receipt. The configuration, release files and source lock must be canonical regular files outside solver workspaces. The host must keep them outside agent filesystem access. The Codex child process does not inherit this setting.

```json
{
  "schema": "theorem-os.library-host-config.v1",
  "releaseDirectory": "/srv/theoremos/releases/approved",
  "manifestSha256": "<trusted 64-character lowercase SHA256>",
  "sourceLakeManifest": "/srv/theoremos/releases/approved/lake-manifest.json",
  "tasks": [
    {
      "taskId": "lean-task-<statement identity>",
      "selection": { "mode": "mapped", "exclusionKeys": ["TriangleFace"] }
    },
    {
      "taskId": "TriangleFace",
      "benchmarkCommit": "<pinned 40-character benchmark commit>",
      "selection": { "mode": "mapped", "exclusionKeys": ["TriangleFace"] }
    }
  ]
}
```

`releaseDirectory` contains the five release metadata files. `sourceLakeManifest` is the exact source lock whose raw SHA256 is bound by the release environment. The trusted manifest pin must come from host release approval. Deriving a pin from arbitrary input does not approve a release.

Task mappings are exact and unique. Ordinary tasks use the `lean-task-…` statement identity already used in their contracts; Lean-Eval tasks additionally require the pinned benchmark commit. An unlisted task fails. A host can explicitly select `{ "mode": "unrestricted" }` for one listed identity. Campaign orchestration must supply reviewed mappings for its concrete tasks; automatic external campaign discovery is pending.

The reader checks bounded artifact bytes, the trusted release pin, Lean 4.34.1, and every pinned Git dependency's name, URL, commit, subdirectory, config file and manifest file. It rejects local path dependencies and unsupported lock shapes. Package ordering, root package name, scope labels, input branch names and inherited flags are excluded from the compatibility digest because resolved Git identities determine dependency code. The source lock's exact bytes remain bound separately. No Lean/Lake process runs during configuration parsing.

The ordinary task bootstrap (including its CLI and ordinary Web callers) and held-out bootstrap share this resolver. When configured, raw `libraryPack`, `--library-pack`, and direct in-memory policy overrides fail. Only the effective pack is installed. Full release metadata stays in host storage. For CLI bootstrap, set the environment variable before invoking `bootstrap-lean-eval`; there is no task-controlled configuration flag.

The initial Git commit and receipt bind the release, policy, effective set, complete dependency identity, and configuration file's raw SHA256. Resume and the held-out official gate re-resolve from the current host setting. Removing the setting, changing configuration bytes (even whitespace or unrelated task mappings), changing release artifacts, or changing the destination dependency identity invalidates the old binding. Recreate tasks after an intentional policy update. Receipt fields cannot choose an alternative configuration.

Without this host setting, existing legacy flows remain available. Old receipts cannot claim a host-approved release, and enabling host policy rejects unbound old tasks. Campaign integration and production Web container mounts remain deployment work. The ordinary Web function uses the shared resolver, but configuring the supervisor alone does not configure a container: its trusted bootstrap process needs its own protected, read-only host files and setting.

## Installed knowledge authorization

With host configuration enabled, `prepareLibraryKnowledge` reconstructs a catalogue
from the verified task receipt, current EffectivePack and exact installed module
bytes. Ordinary and held-out tasks (including an explicit `--receipt-file`) use the
same authorization. Only installed library modules and their frozen Lean project
configuration enter source contexts. Task proof bodies and full-release catalogues
remain absent. An empty allowed set produces an authorized empty catalogue.

```bash
bun scripts/mathematics/prepareLibraryKnowledge.ts --workspace /absolute/task \
  --output /absolute/fresh/catalog.json
bun bin/math.ts knowledge stats --catalog /absolute/fresh/catalog.json \
  --workspace /absolute/task
```

Packed catalogues retain `libraryAuthorization`: generator version, complete
EffectivePack binding, task receipt digest and installed-file-set digest. Entries
carry `libraryMetadata` only when matched to the authorized release declarations;
legacy statuses remain `unknown`, and Auto declarations acquire no base-release
replay claim. The catalogue remains lexical, recorded evidence requiring fresh
checking. Existing declaration-discovery limitations are unchanged.

`readAuthorizedKnowledgeCatalog` reconstructs the expected catalogue before
returning any counts, search metadata or source objects. It compares all metadata,
contexts and blobs, including unreferenced blobs. A recomputed catalogue hash or
copied authorization field cannot approve additional text, provenance or sources.
Changed policy, configuration, receipt, module bytes or dependency identity rejects
reuse. Source objects are re-read even after prior searches populated caches.

The run entry point validates `--knowledge-base` before startup and completed-run
resume, again before worker copies, and before each worker context is built.
Worker copies retain the exact manifest and authorization, with the pinned digest
used by their knowledge commands. Host configuration is not passed to model
children. Keep the full release and host registry outside their filesystem view.
Host CLI search/get/source/finding/dependencies/consumers/stats require `--workspace`
under host configuration and share this authorization before returning results.

Historical state files, free-text findings, Auto build application hints and
continuation attachments do not yet have independent authorization of their full
content and visibility history. Configured preparation rejects these inputs before
reading or exporting them; configured runs reject continuation imports. Host CLI
archive build/enrich/pack paths are also rejected. Matching a declaration name,
module hash or parent policy alone cannot authenticate arbitrary historical prose.
Already authorized Auto modules themselves remain searchable. Supporting historical
advice requires a separate authenticated content/provenance contract; it is not
silently admitted by this migration. Unconfigured legacy workflows remain unchanged.

## Historical three-file releases

Set `"format": "legacy"` to select an approved `legacy-library-binding.json` alongside the original `pack.json`, `library.json` and `verification.json`. In this mode `manifestSha256` pins the mapping's exact bytes; `sourceLakeManifest` remains the exact historical source lock. Omitting `format` or selecting `"release"` keeps the five-file path. Unsupported formats fail.

Generate the mapping with Library's `scripts/legacy_binding.py OLD_DIRECTORY --repository GIT_REPO --out NEW_FILE`. The generator compares the retained artifacts to their recorded Git tree, toolchain, lock and exclusion policy, with Git replacements disabled. It never treats the current working tree as historical evidence. Review the provenance and approve the resulting mapping hash independently. No real retained historical release is enabled by the synthetic test fixture.

Runtime authenticates the three original byte streams, source inventory, committed policy and normalized metadata before using the shared EffectivePack filter. Legacy v1 requires successful aggregate replay/control/Sanity summaries but accepts no declaration coverage: every declaration remains `unknown`. It does not convert aggregate counts into proof claims. New coverage-bearing releases use the five-file format. `legacyBindingSha256` is preserved in the receipt and Auto parent bindings; all existing dependency, policy, installed-file and recovery checks still apply. Changing or removing the mapping invalidates recovery. Raw task packs and in-memory overrides remain forbidden under host configuration.


## Auto composition and recovery

To enable Auto, add `"autoLibraryDirectory": "/srv/theoremos/auto-authorizations"` before preparing builds. This directory is host-owned writable storage; keep it, the pool, build state, full release and config outside all agent filesystem access. It must neither contain nor be contained by a task/build workspace. Do not mount it into a worker container. Changing this setting changes the config binding, so existing tasks must be recreated.

An Auto `prepare --challenge-id ID` resolves the explicitly mapped parent ID and freezes its EffectivePack; `--base-pack` is rejected with host policy enabled. New registry entries are staged, fsynced and published by atomic directory rename; interrupted writes cannot occupy the final name. Valid pre-atomic entries remain readable, and conflicting old/new entries fail closed. The request is also recorded in the external registry, so rewriting request and state digests together cannot select a different parent or base. Old unbound builds cannot be resumed under host policy.

Each published record carries the exact parent binding and hashes of **all** library sources its planner/prover could see, including earlier rounds and unused files. Configured selection requires an independently registered verified record, identical parent binding, matching visible hashes, compatible environment/dependencies, valid Auto namespace/imports and no declaration conflict. Old records with only filenames are skipped as `provenance`; evidence is never fabricated. Cross-task reuse is intentionally conservative: even equivalent allowed sets with different parent bindings do not share records in this version.

Each round saves complete record digests, not just names. Every phase rechecks the request, current policy and its selected snapshot. Completed recovery also checks snapshots. Publication compares cached source/visibility to the verified child receipt before registering the record. New pool entries do not alter a round already in progress.

Generated statement, installation-check and application-check tasks receive immutable external authorizations keyed by their canonical workspace. The record binds their formal task ID, exact composed pack, parent binding and provenance digest. Bootstrap accepts no raw override; resume resolves the current parent and external authorization again. The destination may share its directly mapped parent task ID; parent policy resolution always ignores derived entries to prevent recursive authorization. A generated child cannot override a different directly mapped task. Removing the host setting, changing the parent/config or replacing an authorization invalidates recovery.

Configured `auto-library --phase pack` requires `--challenge-id ID --workspace NEW_WORKSPACE` in addition to pool, challenge file and output. It writes a `theorem-os.auto-library-selection.v1` envelope (binding plus pack) and authorizes that exact future workspace. Bootstrap that workspace with the same source/environment and **without** `--library-pack`. The envelope is an inspection/export artifact, not a raw-pack bypass. Without host configuration, the existing raw-pack CLI and records remain supported.

`autoComposition` bindings use a deterministic declaration-name/module inventory from the installed composed sources. They do not certify Auto declarations as part of the base release's kernel replay. The separate prover and frozen-install checks remain required; the registry is authorization storage, not new proof evidence.

Run `bun scripts/mathematics/autoLibraryHostReplay.ts /absolute/fresh/directory` under monitored validation with a manifest-compatible `DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS` and the pinned toolchain. Optionally set `THEOREMOS_AUTO_REPLAY_PROOF_CACHE` to a dedicated existing sealed cache (otherwise the replay uses its own directory) for a preset-output replay with real Lean 4.34.1. Its release metadata is explicitly synthetic; it validates Auto interruption/recovery, publication, application elaboration and destination evaluation without model calls, and is not a formal Library release.
