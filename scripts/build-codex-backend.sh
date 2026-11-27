#!/usr/bin/env bash
set -euo pipefail

# Use host build tools ahead of optional user wrappers (for example a Python
# launcher that executes in a container without this source checkout).
export PATH="/usr/bin:/bin:$PATH"

usage() {
  cat <<'USAGE'
Usage: scripts/build-codex-backend.sh --source DIR --downloads DIR --output DIR [--jobs N] [--host-tools DIR] [--prepare-only]

Fetch the pinned official Codex release, apply the checked-in build patches,
and build codex-cli with its locked dependencies and an explicitly selected Rust.
All target files, logs, the executable and its provenance stay under --output.
--prepare-only verifies the upstream identity without applying the patch.
--host-tools uses an extracted Debian sysroot for build-only native dependencies.
No global Codex profile or default Rust toolchain is changed.
USAGE
}

source_dir= downloads_dir= output_dir= host_tools= jobs=16 prepare_only=0
while (($#)); do
  case "$1" in
    --source|--downloads|--output|--jobs|--host-tools)
      if (($# < 2)); then usage >&2; exit 2; fi
      case "$1" in
        --source) source_dir=$2 ;;
        --downloads) downloads_dir=$2 ;;
        --output) output_dir=$2 ;;
        --jobs) jobs=$2 ;;
        --host-tools) host_tools=$2 ;;
      esac
      shift 2 ;;
    --prepare-only) prepare_only=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
if [[ -z $source_dir || -z $downloads_dir || -z $output_dir || ! $jobs =~ ^[1-9][0-9]*$ ]]; then
  usage >&2; exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
pin_file=$script_dir/codex-backend/upstream.json
pin() {
  python3 - "$pin_file" "$1" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    print(json.load(stream)[sys.argv[2]])
PY
}
repository=$(pin repository)
tag=$(pin tag)
revision=$(pin revision)
tag_object=$(pin tagObject)
toolchain=$(pin toolchain)
lock_digest=$(pin cargoLockSha256)
derived_lock_digest=$(pin derivedCargoLockSha256)
lock_patch_file=$script_dir/codex-backend/$(pin lockPatch)
lock_patch_digest=$(pin lockPatchSha256)
patch_file=$script_dir/codex-backend/$(pin patch)
package=$(pin package)
binary=$(pin binary)
profile=$(pin profile)

mkdir -p -- "$downloads_dir" "$output_dir" "$(dirname -- "$source_dir")"
downloads_dir=$(cd -- "$downloads_dir" && pwd)
output_dir=$(cd -- "$output_dir" && pwd)
download=$downloads_dir/codex-$tag
if [[ ! -e $download ]]; then
  git clone --depth 1 --single-branch --branch "$tag" "$repository" "$download"
fi
if [[ $(git -C "$download" rev-parse "refs/tags/$tag") != "$tag_object" ||
      $(git -C "$download" rev-parse "refs/tags/$tag^{commit}") != "$revision" ]]; then
  echo 'Official Codex tag does not match the pinned release.' >&2; exit 1
fi
if [[ ! -e $source_dir ]]; then
  git -C "$download" worktree add --detach "$source_dir" "$revision"
fi
source_dir=$(cd -- "$source_dir" && pwd)
if [[ $(git -C "$source_dir" rev-parse HEAD) != "$revision" ]]; then
  echo 'Source checkout HEAD differs from the pinned Codex revision.' >&2; exit 1
fi
actual_lock=$(sha256sum "$source_dir/codex-rs/Cargo.lock")
if [[ ${actual_lock%% *} != "$lock_digest" && ${actual_lock%% *} != "$derived_lock_digest" ]]; then
  echo 'Codex Cargo.lock differs from the pinned upstream and derived lockfiles.' >&2; exit 1
fi
rustup run "$toolchain" rustc --version
if ((prepare_only)); then
  echo "Pinned upstream source ready: $source_dir"
  exit 0
fi

if [[ ! -s $patch_file ]]; then
  echo "AgentControl patch is missing: $patch_file" >&2; exit 1
fi
actual_lock_patch=$(sha256sum "$lock_patch_file")
if [[ ${actual_lock_patch%% *} != "$lock_patch_digest" ]]; then
  echo 'Derived lock patch differs from its frozen digest.' >&2; exit 1
fi
if [[ ${actual_lock%% *} == "$lock_digest" ]]; then
  git -C "$source_dir" apply --check "$lock_patch_file"
  git -C "$source_dir" apply "$lock_patch_file"
fi
if ! git -C "$source_dir" apply --reverse --check "$patch_file" 2>/dev/null; then
  git -C "$source_dir" apply --check --index "$patch_file"
  git -C "$source_dir" apply --index "$patch_file"
fi
# Build precisely the reviewable patch. Extra edits are preserved and rejected,
# so re-running this script never resets a developer's source worktree.
# Match the checked-in patch's Git index abbreviation width so shallow clones
# (--depth 1 in CI/Docker) do not differ from fuller clones under core.abbrev=auto.
patch_abbrev() {
  python3 - "$1" <<'PY'
import re, sys
lengths = set()
with open(sys.argv[1], encoding="utf-8", errors="surrogateescape") as stream:
    for line in stream:
        match = re.match(r"^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: [0-7]+)?\r?$", line)
        if match:
            lengths.add(len(match.group(1)))
            lengths.add(len(match.group(2)))
if not lengths:
    raise SystemExit("Checked-in patch is missing a Git index header.")
print(min(lengths))
PY
}
agent_patch_abbrev=$(patch_abbrev "$patch_file")
lock_patch_abbrev=$(patch_abbrev "$lock_patch_file")
git -C "$source_dir" diff --binary --no-ext-diff --abbrev="$agent_patch_abbrev" HEAD -- . ':(exclude)codex-rs/Cargo.lock' > "$output_dir/agent-control-source.patch"
git -C "$source_dir" diff --binary --no-ext-diff --abbrev="$lock_patch_abbrev" HEAD -- codex-rs/Cargo.lock > "$output_dir/derived-lock-source.patch"
if ! cmp -s "$patch_file" "$output_dir/agent-control-source.patch" ||
   ! cmp -s "$lock_patch_file" "$output_dir/derived-lock-source.patch" ||
   [[ -n $(git -C "$source_dir" ls-files --others --exclude-standard) ]]; then
  echo 'Source worktree differs from the checked-in build patches.' >&2; exit 1
fi
git -C "$source_dir" diff --binary --no-ext-diff --abbrev="$agent_patch_abbrev" HEAD > "$output_dir/source.patch"

export CARGO_TARGET_DIR=$output_dir/target
export CARGO_PROFILE_DEV_DEBUG=$(pin devDebug)
export CARGO_INCREMENTAL=$(pin incremental)
if [[ -n $host_tools ]]; then
  host_tools=$(cd -- "$host_tools" && pwd)
  host_arch=$(cc -dumpmachine)
  export PKG_CONFIG=$host_tools/usr/bin/pkgconf
  export PKG_CONFIG_SYSROOT_DIR=$host_tools
  export PKG_CONFIG_LIBDIR=$host_tools/usr/lib/$host_arch/pkgconfig:$host_tools/usr/share/pkgconfig
  export LD_LIBRARY_PATH=$host_tools/usr/lib/$host_arch${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
  export CFLAGS="${CFLAGS:+$CFLAGS }-I$host_tools/usr/include/$host_arch"
  export CXXFLAGS="${CXXFLAGS:+$CXXFLAGS }-I$host_tools/usr/include/$host_arch"
  "$PKG_CONFIG" --modversion openssl
fi
# Cargo resolves all workspace manifests, including the separate V8 host. Its
# default submodule fetch downloads every Chromium branch. Keep the exact
# gitlink commits while fetching only their required history.
read -r metadata_repository metadata_revision < <(python3 - "$pin_file" <<'PY'
import json, sys
metadata = json.load(open(sys.argv[1]))["submoduleMetadata"]
print(metadata["repository"], metadata["revision"])
PY
)
metadata_dir=$downloads_dir/codex-rusty-v8-$metadata_revision
if [[ ! -d $metadata_dir/.git ]]; then
  git init --quiet "$metadata_dir"
  git -C "$metadata_dir" fetch --depth 1 "$metadata_repository" "$metadata_revision"
  git -C "$metadata_dir" checkout --detach "$metadata_revision"
fi
if [[ $(git -C "$metadata_dir" rev-parse HEAD) != "$metadata_revision" ]]; then
  echo 'V8 submodule metadata differs from the locked dependency revision.' >&2; exit 1
fi
python3 - "$metadata_dir" "$output_dir/submodule-pins.json" <<'PY'
import json, pathlib, subprocess, sys
source, output = sys.argv[1:]
git = lambda *arguments: subprocess.check_output(["git", "-C", source, *arguments], text=True).strip()
pins = {}
for line in git("config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$").splitlines():
    key, path = line.split(maxsplit=1)
    entry = git("ls-tree", "HEAD", "--", path).split()
    if entry[:2] != ["160000", "commit"]:
        raise SystemExit("V8 submodule is missing its pinned gitlink: " + path)
    pins[git("config", "-f", ".gitmodules", "--get", key.removesuffix(".path") + ".url")] = entry[2]
pathlib.Path(output).write_text(json.dumps(pins, indent=2, sort_keys=True) + "\n")
PY
build_tools=$output_dir/build-tools
mkdir -p -- "$build_tools"
export THEOREMOS_BUILD_REAL_GIT=$(command -v git)
export THEOREMOS_BUILD_SUBMODULE_PINS=$output_dir/submodule-pins.json
ln -sfn -- "$script_dir/codex-backend/git-fetch-pinned.py" "$build_tools/git"
export PATH="$build_tools:$PATH"
export CARGO_NET_GIT_FETCH_WITH_CLI=true
build_log=$output_dir/build.log
echo "Building $package/$binary; log: $build_log"
if ! (cd -- "$source_dir/codex-rs" && rustup run "$toolchain" cargo build --locked \
    --profile "$profile" -p "$package" --bin "$binary" --jobs "$jobs") > "$build_log" 2>&1; then
  tail -n 60 "$build_log" >&2
  exit 1
fi
mkdir -p -- "$output_dir/bin"
install -m 755 "$CARGO_TARGET_DIR/debug/$binary" "$output_dir/bin/$binary.new"
mv -f -- "$output_dir/bin/$binary.new" "$output_dir/bin/$binary"
runtime_link=$script_dir/../out/codex-backend/codex
mkdir -p -- "$(dirname -- "$runtime_link")"
ln -sfn -- "$output_dir/bin/$binary" "$runtime_link"
python3 - "$pin_file" "$source_dir" "$output_dir" "$patch_file" "$jobs" "$runtime_link" "$host_tools" <<'PY'
import datetime, hashlib, json, pathlib, subprocess, sys
pin_file, source, output, patch_file, jobs, runtime_link, host_tools = sys.argv[1:]
pin = json.loads(pathlib.Path(pin_file).read_text())
artifact = pathlib.Path(output, "bin", pin["binary"])
digest = lambda file: hashlib.file_digest(pathlib.Path(file).open("rb"), "sha256").hexdigest()
version = lambda command: subprocess.check_output(["rustup", "run", pin["toolchain"], *command], text=True).strip()
record = {
    "schema": "theoremos.codex-backend-build.v1",
    "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "upstream": pin, "source": source,
    "sourceRevision": subprocess.check_output(["git", "-C", source, "rev-parse", "HEAD"], text=True).strip(),
    "patchSha256": digest(patch_file), "cargoLockSha256": digest(pathlib.Path(source, "codex-rs/Cargo.lock")),
    "lockPatchSha256": digest(pathlib.Path(pin_file).parent / pin["lockPatch"]),
    "sourcePatchSha256": digest(pathlib.Path(output, "source.patch")),
    "executable": str(artifact), "executableSha256": digest(artifact),
    "rustc": version(["rustc", "--version", "--verbose"]), "cargo": version(["cargo", "--version"]),
    "jobs": int(jobs), "targetDirectory": str(pathlib.Path(output, "target")),
    "log": str(pathlib.Path(output, "build.log")),
    "runtimeLink": str(pathlib.Path(runtime_link).absolute()),
    "submodulePinsSha256": digest(pathlib.Path(output, "submodule-pins.json")),
}
if host_tools:
    host_manifest = pathlib.Path(host_tools, "manifest.json")
    record["hostTools"] = {"directory": host_tools,
                           "manifest": json.loads(host_manifest.read_text()) if host_manifest.exists() else None,
                           "manifestSha256": digest(host_manifest) if host_manifest.exists() else None}
pathlib.Path(output, "backend-build.json").write_text(json.dumps(record, indent=2) + "\n")
print(json.dumps({"executable": str(artifact), "sha256": record["executableSha256"],
                  "manifest": str(pathlib.Path(output, "backend-build.json"))}))
PY
