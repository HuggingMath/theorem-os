# Campaign reference discovery

This versioned adapter preserves short mathematical phrases and the research
object in arXiv / OpenAlex requests. If recall gaps remain, it issues at most four
additional academic requests (concept-only and subject-only queries). Explicit
quotes and `--target` help when an unquoted phrase boundary is ambiguous.

Cards are labelled `matching`, `background`, or `low`. Low-relevance web cards
are exposed under `low_relevance_results`, separately from literature results.
Background papers do not necessarily concern the research object. Search gaps,
provider errors, and unread/non-citable status stay visible. A hit is not a
validated theorem, and an empty bounded search does not establish absence.

arXiv versions, DOI aliases, and preprint/journal entries with identical long
titles and explicit matching author lists share a result slot. Alternate source
identities remain attached; title coincidence alone does not merge documents.

The existing campaign answer-source ban surrounds discovery and reading,
including encoded URLs, redirect destinations, and source-cache metadata.
The versioned `reference-source-provenance.json` registry separately holds public
identities whose permitted provenance remains unresolved. URI/DOI aliases are
compared before search cards receive REFs, before requests (including redirects),
and before cached bodies are opened. These records are `unverified`, not confirmed
answer sources. Their observed metadata is sufficient to hold those identities;
it does not justify banning all papers by the same author or institution. Update
the registry only from source metadata and install a new frozen bundle. An
installer `--source-provenance` file can supply another registry of the same schema.
The installed helper still owns provider budgets/recovery, source snapshots,
REF registration, and reading. The adapter's and base helper's content identities
separate search caches, leaving earlier searches and source/REF caches readable.
`--retry-failed` retries only the old execution's failed requests; `--refresh`
starts a new bounded discovery.

Install to an explicitly chosen directory using the dependency-complete Python
environment used by the existing helper:

```sh
/usr/bin/python3 -B scripts/mathematics/reference-search/install.py \
  --dest /path/to/new/reference-tools \
  --research-script /path/to/deep-research/scripts/research.py \
  --python /path/to/dependency-complete/python
/path/to/new/reference-tools/reference-search --help
/path/to/new/reference-tools/reference-search \
  --run-dir /absolute/worker-worktree/.scratch/reference-search search \
  '"heat kernel" estimates' --target 'compact Riemannian manifold' --limit 6
/path/to/new/reference-tools/reference-search \
  --run-dir /absolute/worker-worktree/.scratch/reference-search read REF-0123456789ABCDEF
```

Installation copies the helper's 15 imported Python files into `base/`, plus the
adapter, policy, source registry and launcher; it never edits the source skill. The manifest records
every copied source hash. Point campaign invocations at the generated
`reference-search` launcher. Installing a staging bundle does not switch live
workers; the campaign owner controls activation.

Use the same absolute worker-local `--run-dir` for subsequent search/read calls so
the REF store and cache remain available even when cwd changes. An explicitly set
absolute `DEEP_RESEARCH_RUN_DIR` or `DRBENCH_RUN_DIR` is also supported; `--run-dir`
takes precedence. Commands that access run state require this anchor and fail
with a usage message when it is missing; `--help` needs no writable directory.
The launcher no longer chooses `$PWD`, so a read-only campaign root cannot become
the accidental output directory.

Offline verification uses repository fixtures copied from the public audit13
responses, with provenance in `tests/fixtures/campaign-reference/provenance.json`:

```sh
/usr/bin/python3 -B -m unittest discover -s tests -p campaign_reference_test.py -v
bunx vitest run tests/campaignReference.test.ts
/path/to/dependency-complete/python -B tests/campaign_reference_replay.py \
  --bundle /path/to/new/reference-tools --output /path/to/reference-replay.json
```

The final replay disables sockets and supplies saved XML / mock provider results.
It exercises the actual frozen helper, search cache isolation and reuse, bounded
failed-request recovery, old REF reading, and the generated CLI's `--help`.
