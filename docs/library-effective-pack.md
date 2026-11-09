# Host-selected Library releases

`src/math/libraryRelease.ts` consumes the five-file `theorem-os-library-metadata-v1`
release. `validateLibraryRelease(artifacts, expectedManifestSha256)` requires a
publisher digest selected by the host, checks exact artifact bytes and source/import
bindings, and validates explicit declaration coverage. Historical counts alone leave
proof status unknown. Human review remains unknown. Input sizes and JSON depth are
bounded; duplicate JSON keys are rejected. Canonical set digests use Unicode code
point ordering, including integer-shaped object keys.

`resolveEffectiveLibraryPack(artifacts, policy)` applies a host-owned
`theorem-os.library-task-policy.v1` policy. The policy supplies a task identity,
trusted manifest SHA-256, expected release environment and destination runtime
environment digest. Its selection is either `mapped` with explicit exclusion keys
or explicitly `unrestricted`. An absent selection or unknown exclusion key fails.
The host is responsible for mapping campaign identities to the appropriate keys;
this API must not receive policy choices or trust pins from an Agent request.
The release's exact Lake manifest hash and the destination environment digest are
separate identities: the host must approve that environment mapping, including the
locked dependency set, before supplying the policy.

Directly excluded modules and every reverse dependent are removed before code
installation. Independent background modules and their dependencies remain. The
returned pack, module catalogue and declaration metadata describe only the allowed
set. An empty allowed set has `pack: null`; the result still binds the policy. Full
release bytes and metadata must remain in host storage outside Agent-visible task
files. This is integrity and policy normalization, not fresh Lean execution.

The ordinary task bootstrap supports a separate third host argument:

```ts
bootstrapLeanTask(workspace, input, { artifacts, policy });
```

It rejects simultaneous raw-pack input and host release input, verifies the task ID,
destination environment digest, Lean toolchain and Mathlib revision, and installs only
the effective pack. `libraryBinding` is frozen in the Git seed and receipt; resume
cross-checks it against the seed, destination environment and installed module set.
The binding records the manifest, original pack, policy, effective pack, module set
and declaration set digests. No companion metadata is copied into the task project.
The task ID is the existing `lean-task-<hash prefix>` derived from the canonical
formal statement payload; it is independent of the free-text task description.

This is an M1 implementation slice. Raw code-pack compatibility remains available;
it does not acquire release evidence or task authorization through this change.
Explicit legacy bindings, held-out bootstrap, CLI/Web host selection, Auto-library
composition/resume, and knowledge catalogue integration still need migration to the
same contract before M1 is complete. Search/inspect/probe are not enabled here.

Tests use a Python-generated **synthetic** release under
`tests/fixtures/library-release`, with fabricated replay records. They cover byte and
evidence tampering, unknown coverage, transitive exclusion, explicit unrestricted
selection, empty allowed sets, and bootstrap/receipt identity. Real release-format
compatibility is checked separately by the Library remote validation wrapper against
saved replay evidence; it does not publish or claim a new kernel replay.
