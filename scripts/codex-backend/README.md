# TheoremOS Codex backend build

`upstream.json` pins the official Codex tag, commit, lockfiles and Rust toolchain.
The build applies two reviewable patches:

- `derived-lock.patch` aligns 173 local workspace package versions with the
  release's `0.169.0` workspace version, and records the adapter's internal
  `codex-app-server` dependency on `codex-rollout-trace`. External dependencies,
  sources and checksums are unchanged.
- `agent-control.patch` adds the TheoremOS protocol adapter to the official
  AgentControl implementation. It excludes `Cargo.lock`.

Run from the repository root:

```bash
scripts/build-codex-backend.sh \
  --source /data/lzh/workspace/projects/theoremos-codex-backend \
  --downloads /data/lzh/downloads \
  --output /data/lzh/workspace/outputs/theoremos-codex-backend-20261117 \
  --jobs 16
```

Install the explicitly pinned toolchain with `rustup toolchain install 1.95.0
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

All Cargo targets, logs and binaries stay under `--output`. On success,
`backend-build.json` records the source, patch, lockfile and executable digests;
`out/codex-backend/codex` points to the built executable. Existing sessions are
not restarted. Source edits beyond the checked-in patches are preserved and
rejected, so freeze the adapter patch before running a final build.

New team runs pin this executable and freeze the native transport in their run
record. Saved runs without that transport keep their historical host-tool team.
An incompatible binary fails the capability handshake before a model turn.

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

The built runtime link installs this backend for new local CLI team runs.
The Web worker Dockerfile builds the same pinned source on Debian Bookworm
and installs a separate binary at `/opt/theoremos-codex-backend/codex`.
Ordinary runs keep the stock Codex binary. The worker build probes the native
app-server's capabilities as the worker user before labeling the image
`org.theoremos.native-agent-control=v1`. The Web service uses this label to
offer native teams only with a compatible worker; existing deployments are
unchanged until their images are rebuilt and selected. A host output symlink
is not a portable installation.

Cargo resolves V8 host manifests even though the CLI does not link that runtime.
The build-local Git helper fetches the exact locked submodule commits without
downloading unrelated Chromium branch histories. Their official gitlink pins
are recorded in `submodule-pins.json`.

If downloads fail with `Proxy CONNECT aborted`, check the configured proxy. A
confirmed direct connection can be used for this build by invoking the script
with `env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy
-u all_proxy`; this changes only the build subprocess environment.
