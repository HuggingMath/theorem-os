# License for the 44 upstream Lean modules

SPDX-License-Identifier: AGPL-3.0-only

Effective 2026-11-23, the copyright holder of the 44 Lean modules identified in
[upstream-grant.json](upstream-grant.json), acting through its authorized
representative, grants the public permission to use, copy, modify and redistribute
those modules under the [GNU Affero General Public License, version 3 only](../../LICENSES/AGPL-3.0-only.txt).
The grant includes both the identified upstream sources and their TheoremOS
adaptations. The hashes identify the licensed inputs; recipients may make and
redistribute their own modified versions under the license.

The upstream paths refer to `theorem-os-library` commit
`2902dec1e973bd70dad0444a8dc2320cf81d90fd`. The TheoremOS release is
`theorem-os/core` revision `2902dec1e973bd70dad0444a8dc2320cf81d90fd-lean4.33.0-r4`.
Each entry names the original path and SHA-256 and the installed Lean source
SHA-256. The installed path is `Submission/Library/<upstreamPath>`; its bytes
are stored in `release/objects/<snapshotSha256>.lean`. Where renaming imports
alone produces bytes different from both endpoints, the entry also gives
`importRenamedSha256`. The [compatibility record](compatibility.json) and
[patch](lean4.33.0.patch) document the additional Lean 4.33 adaptations.

The grant covers identical copies of these sources wherever they occur,
including research archives. It grants no rights in unrelated archive content,
other upstream files or versions, research logs, or third-party papers or
problem statements cited by these modules. Preserve the existing attributions,
source references and notices; third-party material retains its own terms.
Earlier grants remain in effect for their recipients.

The nine locally authored modules with `origin.kind = run` are separate project
work covered by the project license. Their provenance is recorded in
[authoring.json](authoring.json); they are not counted among the 44 upstream modules.
