# HuggingMath transfer

`theorem-os hub` is an optional host-side tool for transferring finished, frozen
TheoremOS results into private HuggingMath drafts. It is available in the standalone
agent tools as well as `bun bin/math.ts hub`. The research Skill loads its short
Hub reference only when a transfer is requested. Ordinary solving performs no upload.

This adapter targets `hm-problem-bundle/0` and the import API at HuggingMath commit
`23f0bd289934949e63dc08a8219262ee43498064`. That pinned feature contract does not
establish which version a production deployment serves. `/v1` problem retrieval,
Native Pack installation, and Hub verification are outside this adapter.

## Export a finished run

Prepare a UTF-8 metadata file. Only attribution is required:

```json
{
  "attribution": "Author or source attribution for the transferred proof",
  "title": "A descriptive problem title",
  "language": "en",
  "provider": "theoremos",
  "external_id": "stable-problem-identifier",
  "sources": "Source description and references",
  "rights": {
    "statement/original.md": {
      "status": "unknown",
      "license": "",
      "notice": "No publication permission asserted."
    }
  }
}
```

Omit optional fields when their defaults are suitable. `provider` defaults to
`theoremos`; `external_id` and title default to the frozen problem ID. Keep
provider/external ID stable: Hub maps imports by provider, external ID, and owner.
Rights are keyed by the exact attachment path. Every unspecified file remains
`unknown`. `declared` requires a nonempty license or permission description; neither
attribution nor a declaration of rights publishes an object.

```bash
bun bin/math.ts hub export --state /path/to/runtime/state.json \
  --result /path/to/result.json --metadata /path/to/metadata.json \
  --output /path/to/new-export-directory
bun bin/math.ts hub validate --bundle /path/to/new-export-directory/bundle.zip
```

Export requires a finished run with matching `evaluated_passed` final result, source
check, complete original target coverage, and S3 evaluation. It reads committed
bytes, including the original formalization, checked proof, frozen support and
environment configuration. It does not execute Lean or a model or edit the run.
The output contains `bundle/` and `bundle.zip`; the output directory must be new.
`validate` checks manifest identities, raw attachment hashes, limits and transport
structure. Preview also runs the deployed Hub's own validator.

Repeat `--declaration ARTIFACT_ID` to include selected independent helper records
from the run's v1/v2 artifact archive. These full records remain historical
provenance, including types, premises, source and checked commits, receipts and
references. They are not additional original problem proofs. Select only needed
records; the exporter rejects oversized selections without truncation.

The adapter enforces 8 formalizations/proofs, 512 attachments, 4 MiB per attachment,
1 MiB manifest, 32 MiB total including manifest, and 40 MiB ZIP. It also checks Hub's
256 KiB projected Lean and 64 KiB statement limits. `environment.complete` is false:
export preserves frozen configuration but does not establish a replayable dependency
closure. Source receipts stay external evidence; Hub proof verification is `not_run`.

## Login and import

Use an active maintainer account on a deployment exposing the pinned import routes.
Authentication uses ordinary Django form login at `/accounts/login/`, session
cookies, and the CSRF cookie rotated at login. Bearer tokens are not supported.
An SSO-only deployment needs an operator-provided compatible session profile or
a separately supported authentication flow. HTTPS origin, trusted origin, cookie
and proxy configuration must agree with the supplied base URL.

Store profiles and import journals outside the source, solver worktree and export
directory. A profile is a credential file, written with mode 0600; it must not be
attached to the bundle or placed in model context. The CLI reads a password from a
named environment variable and does not print passwords or cookies. For example:

```bash
read -r -s -p 'HuggingMath password: ' HM_PASSWORD
export HM_PASSWORD
bun bin/math.ts hub login --url https://your-hub.example --username maintainer \
  --password-env HM_PASSWORD --profile /private/path/new-session.json
unset HM_PASSWORD
bun bin/math.ts hub preview --bundle /path/to/new-export-directory/bundle.zip \
  --profile /private/path/new-session.json --owner destination-user \
  --output /private/path/new-import.json
bun bin/math.ts hub apply --import /private/path/new-import.json \
  --profile /private/path/new-session.json
bun bin/math.ts hub record --import /private/path/new-import.json \
  --profile /private/path/new-session.json
```

Omit `--owner` to use the server's default owner. Preview stages the bundle and
saves its batch, bundle digest, plan digest, destination, attachment identities
and one idempotency key. Apply uses that saved tuple, persists the returned
problem/record mapping before readback, and compares the record and every file
identity with the original bundle. A successful identical import may return
`noop` and an older record ID.

After a network failure or lost apply response, repeat **apply with the same import
file**. The client never automatically repeats mutations. Successful server writes
can replay with the original key. If the plan is stale or expired before apply,
create a new preview and new journal; do not edit a journal or reuse its key for
another batch. Before a successful result is saved, `record` only reads the staging
batch. Use `apply` with the saved key to reconcile an uncertain write.

An expired session or HTML CSRF denial requires refreshing credentials. The saved
journal remains bound to its original server. No background refresh or password
storage is installed.

Imported statements and proofs are private drafts. Historical Lean success,
Hub verification, canonical selection, publication authorization and library
admission are separate states. This adapter performs no publication or canonical
action and does not start or change mathematical research.
