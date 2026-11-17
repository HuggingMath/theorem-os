#!/usr/bin/env python3
"""Fetch locked V8 submodules without their unrelated Chromium branch history."""
import json
import os
import sys

git = os.environ["THEOREMOS_BUILD_REAL_GIT"]
arguments = sys.argv[1:]
if arguments and arguments[0] == "fetch":
    with open(os.environ["THEOREMOS_BUILD_SUBMODULE_PINS"], encoding="utf-8") as stream:
        pins = json.load(stream)
    for argument in arguments[1:]:
        if argument in pins:
            revision = pins[argument]
            print(f"Fetching pinned submodule {argument} at {revision}", file=sys.stderr)
            os.execv(git, [git, "fetch", "--force", "--update-head-ok", "--depth", "1", argument, revision])
os.execv(git, [git, *arguments])
