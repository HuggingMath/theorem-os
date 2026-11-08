#!/bin/sh
# Elan 4.2 uses Lean's release JSON instead of scraping GitHub's expanded_assets page.
set -eu

elan_version=4.2.4
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    elan_target=x86_64-unknown-linux-gnu
    elan_sha256=42b94d4244e8353142c456ec0e4ca6528fd898a6c604d4059f494e706e431f63 ;;
  Linux/aarch64)
    elan_target=aarch64-unknown-linux-gnu
    elan_sha256=05febd124d84ebf994b2e7479922a5650b1e950c17ae3bd1ddd776b65bb72bf9 ;;
  *) printf 'This installer supports Linux x86_64 and aarch64.\n' >&2; exit 1 ;;
esac

elan_temporary=$(mktemp -d "${TMPDIR:-/tmp}/theoremos-elan.XXXXXX")
trap 'rm -rf "$elan_temporary"' EXIT
elan_archive="$elan_temporary/elan.tar.gz"
curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
  --output "$elan_archive" \
  "https://github.com/leanprover/elan/releases/download/v$elan_version/elan-$elan_target.tar.gz"
printf '%s  %s\n' "$elan_sha256" "$elan_archive" | sha256sum --check --status
tar -xzf "$elan_archive" -C "$elan_temporary" elan-init
"$elan_temporary/elan-init" -y --no-modify-path --default-toolchain none
"${ELAN_HOME:-$HOME/.elan}/bin/elan" --version
