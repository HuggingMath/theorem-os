#!/bin/sh
set -eu
case "${2:-run}" in
  run) script=apps/web/worker.ts ;;
  explain|formalize)
    # Language roles compile in their own sandboxes; their scratch and the shared package image need the disk volume.
    if [ "$2" = formalize ]; then script=apps/web/formalizationWorker.ts; else script=apps/web/explanationWorker.ts; fi
    mkdir -p -m 0700 /var/tmp/explain-home /var/tmp/explain-tmp
    export HOME=/var/tmp/explain-home TMPDIR=/var/tmp/explain-tmp
    ;;
  *) exit 2 ;;
esac
case "${1:-standard}" in
  mathlib)
    # FUSE mounts need a capability scoped to this new user namespace only.
    exec bwrap --unshare-user --uid 0 --gid 0 --cap-add CAP_SYS_ADMIN --cap-add CAP_SETFCAP \
      --bind / / --dev-bind /dev /dev --proc /proc --die-with-parent \
      -- bun "$script"
    ;;
  standard) exec bun "$script" ;;
  *) exit 2 ;;
esac
