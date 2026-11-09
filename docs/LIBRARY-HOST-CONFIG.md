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

Without this host setting, existing legacy flows remain available. Old receipts cannot claim a host-approved release, and enabling host policy rejects unbound old tasks. Auto composition, legacy migration, knowledge-index filtering, campaign integration and production Web container mounts are separate migration work. The ordinary Web function uses the shared resolver, but configuring the supervisor alone does not configure a container: its trusted bootstrap process needs its own protected, read-only host files and setting.
