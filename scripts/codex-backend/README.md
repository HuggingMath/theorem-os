# TheoremOS Codex backend build

`upstream.json` pins the official Codex tag, commit, lockfiles and Rust toolchain.
The build applies two reviewable patches:

- `derived-lock.patch` aligns 174 local workspace package versions with the
  release's `0.172.0` workspace version. The upstream lock already includes
  `codex-rollout-trace` for `codex-app-server`. External dependencies,
  sources and checksums are unchanged.
- `agent-control.patch` adds the TheoremOS protocol adapter to the official
  AgentControl implementation. It excludes `Cargo.lock`.

These patches are changes made by TheoremOS. The upstream code shown in them
comes from [OpenAI Codex at the pinned revision](https://github.com/openai/codex/tree/3d86e43b075adeba2193ec5c22ac92f55afd82e6).
This directory includes the upstream [Apache-2.0 license](LICENSE.codex) and
[NOTICE](NOTICE.codex), including its credit to Ratatui. Both files also ship in
the Web worker at `/opt/theorem-os/scripts/codex-backend/`. For a separate
distribution of the patched binary, include these files and the applicable
notices for the dependencies included in that build.

Run from the repository root:

```bash
scripts/build-codex-backend.sh \
  --source /data/lzh/workspace/projects/theoremos-codex-backend \
  --downloads /data/lzh/downloads \
  --output /data/lzh/workspace/outputs/theoremos-codex-backend-20261117 \
  --jobs 16
```

Install the explicitly pinned toolchain with `rustup toolchain install 1.99.1
--profile minimal` if needed. The script does not change the default toolchain,
Codex configuration or model credentials. `--prepare-only` fetches and verifies
the official source without applying patches or compiling.

Native prerequisites include a C/C++ compiler, `pkg-config` and OpenSSL development
headers/libraries. When global packages are unavailable, pass `--host-tools DIR`
with Debian packages extracted into `DIR` using `dpkg-deb --extract`. This uses
the local `usr/bin/pkgconf`, multiarch headers, libraries and package metadata
only in the build subprocess. A local `manifest.json`, when present, is embedded
with its digest in the build provenance. The current Ubuntu 24.04 environment
uses `pkgconf-bin` and `libpkgconf3` version `1.8.1-2build1`, plus `libssl-dev`
and `libssl3t64` version `3.0.13-0ubuntu3.16`.

Large asynchronous core tests require `RUST_MIN_STACK=8388608`, matching the
upstream Bazel test configuration. Set it only on the test subprocess.

All Cargo targets, logs and binaries stay under `--output`. The build installs
`codex` and `codex-code-mode-host` together in `bin/` and records both digests in
`backend-build.json`. Keep the pair together when moving the backend. The local
`out/codex-backend/codex` link points to the built CLI. Existing sessions are not
restarted. Source edits beyond the checked-in patches are preserved and rejected,
so freeze the adapter patch before running a final build.

New team runs pin the executable's real path and digest and record
`agentTeam.transport: native-agent-control`. Startup failures are reported
through the native backend. Use a compatible provider profile such as the
Responses gateway. Resume native team checkpoints with their pinned backend.
Resume historical host-tool team checkpoints with the original TheoremOS build.

After the ordinary headless runtime build, exercise the real binary with fixed
loopback Responses and independent process/workspace isolation:

```bash
bun scripts/test-codex-backend.ts --executable out/codex-backend/codex \
  --output /data/lzh/workspace/outputs/theoremos-codex-backend-verification
```

This disposable fixture checks native spawn, full-history fork, attributed
messages, queue-only idle behavior, the first resumed request's mailbox order,
cold child resume, busy followup, effective task amendment, mailbox wakeup and
idle/active interruption. It confirms shutdown of every writer process. It does
not call a paid model or alter a running mathematical solve.
Mathematical nominations, source freezing, Lean checks and adoption remain host
operations; a native final answer does not create a proof delivery.

Pass `--team-capacity` to exercise eight writers with seven simultaneous member
requests. Pass `--large-fork` to verify that an oversized full-history fork
returns a tool error and Lead can retry with `fork_turns: "none"`. Pass
`--web-provider` to exercise proof delivery through the generated Web provider
profile, including metered requests before and after Lead cold resume.

The built runtime link installs this backend for new local CLI team runs.
The Web worker Dockerfile builds the same pinned source on Debian Bookworm and
installs both executables in `/opt/theoremos-codex-backend/`. Ordinary runs keep
the stock Codex binary. The worker build probes AgentControl and executes a Code
Mode call as the worker user with fixed loopback responses before labeling the image
`org.theoremos.native-agent-control=v1`. The Web service also checks
`org.theoremos.native-team-workflow=v1`, which identifies support for native
team scheduling and initial route approval. It launches the image by its
verified ID. Rebuild both Web and worker images to roll out this workflow.

The Code Mode host uses the V8 archive and Rust bindings from the matching Codex
release. The build verifies them against the pinned checkout's checksums. The
build-local Git helper fetches the exact locked submodule commits and records
their official gitlink pins in `submodule-pins.json`.

If downloads fail with `Proxy CONNECT aborted`, check the configured proxy. A
confirmed direct connection can be used for this build by invoking the script
with `env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy
-u all_proxy`; this changes only the build subprocess environment.
