# Campaign reference discovery

This versioned adapter preserves the original query, its unquoted qualifiers,
all explicitly quoted objects, and the research target in arXiv / OpenAlex
requests. Only caller-supplied quotes become exact arXiv phrases. Inferred
phrase boundaries inform explicitly broader fallbacks, never rewrite the first
request. If discovery gaps remain, it issues at most four additional academic
requests (concept-only and subject-only queries). Explicit quotes and `--target`
help when an unquoted phrase boundary is ambiguous.

Cards are labelled `matching`, `background`, or `low`. A core concept must match
all its meaningful words. Explicit quoted objects, `--target`, and noun-anchored
objects guide relevance; an arbitrary second slice of a long query is never a
required research subject. Low-relevance web cards
are exposed under `low_relevance_results`, separately from literature results.
Background papers do not necessarily concern the research object. Search gaps,
provider errors, and unread/non-citable status stay visible. A hit is not a
validated theorem, and an empty bounded search does not establish absence.

Ordinary mathematical direct searches try academic providers and bounded
broader academic queries before general web fallbacks. With at least two
distinct matching documents (one when `--limit 1`), missing unquoted snippet
modifiers alone do not trigger more searches. They remain listed under
`recall_checks.unmatched_query_terms` and must be checked in the proof text.
Missing quoted objects, explicit targets, and insufficient distinct documents
still cause discovery to continue. Cached failed-request recovery replays old
successful branches as needed without adding new requests.

For an unquoted long query without a reliable noun boundary or explicit target,
academic cards that match both leading topic words can remain `background`
with `partial_topic_only`, even when they lack the full core concept. Two
distinct readable topic documents can pause automatic discovery for reading;
the public status stays `partial`, missing coverage stays visible, and
`automatic_discovery_paused_for_reading` records the decision. Single documents,
aliases, ordinary web overlap and held sources cannot satisfy this condition.
The last broader query keeps the original two-word topic instead of an isolated
middle slice. Explicit quoted objects and targets keep their existing rules.
When restored background results skip an old direct branch, successfully
retried academic cards are still merged from the recorded execution; recovery
does not issue new provider requests.

The DuckDuckGo HTML fallback uses a four-second connect/read timeout, capped by
the base helper's existing timeout if that is shorter. This applies only to its
HTTPS `/html/` search endpoint; academic APIs and document downloads keep the
base helper's timeout. Request accounting, redirect checks, response limits and
failed-request recovery remain in the existing helpers. The limit applies to
each connection/read and redirect hop, not to the duration of a whole search.
arXiv Atom service-error entries remain provider errors eligible for recovery,
separately from successful empty feeds and ordinary paper cards.

arXiv abs/pdf/html aliases share a result slot only for the same explicit
version. Unversioned references, v1 and v3 remain distinct even when a title or
journal DOI matches. Non-arXiv DOI aliases and identical long titles with matching
explicit author lists can share a slot. Alternate identities remain attached;
title coincidence alone does not merge documents.

Academic reading attempts actual document text before returning a metadata
abstract. DOI/OpenAlex reads use at most two explicitly recorded open-access
locations and the original or recorded DOI. An explicit arXiv HTML URL is read
first; PDF failures try the same version's arXiv HTML before its abstract page.
`content_scope` distinguishes `full_text` (PDF/arXiv HTML), `page_text` (publisher
page text) and `abstract`. A readable page does not establish that the entire
paper or its proof was read. `academic_read_attempts` and failures remain in the
saved source metadata. The existing HTTP/response/read budgets still apply.
When a returned URL identifies an arXiv document, the reader rejects a different
document or a changed/missing explicitly requested version before extraction,
records the failed attempt, and tries the next same-version candidate. An
unversioned request can still resolve to a concrete version of that document.
An unrelated external CDN URL does not provide an arXiv version identity to
compare, so the adapter does not infer a version from it.

The existing campaign answer-source ban surrounds discovery and reading,
including encoded URLs, redirect destinations, and source-cache metadata.
This includes the observed `openai-math-explorer` mirror namespace. Source,
resolved/citation identities and known alternate locations use the same guard,
including before a cached body is opened; unrelated academic pages on the same
host remain available.
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
adapter, academic reader, policy, source registry and launcher; it never edits the source skill. The manifest records
every copied source hash. Point campaign invocations at the generated
`reference-search` launcher. Installing a staging bundle does not switch live
workers; the campaign owner controls activation.

Use the same absolute worker-local `--run-dir` for subsequent search/read calls so
the REF store and cache remain available even when cwd changes. An explicitly set
absolute `DEEP_RESEARCH_RUN_DIR` or `DRBENCH_RUN_DIR` is also supported; `--run-dir`
takes precedence. Commands that access run state require this anchor and fail
with a usage message when it is missing; `--help` needs no writable directory.
The launcher does not choose `$PWD`, so a read-only campaign root cannot become
the accidental output directory. Subcommand `--help` also works without an anchor.

Search and read work from the same fixed worker directory. Reuse an already read
REF with `find REF --term 'KEYWORD' --offset 0` or `open REF --start-line 1 --count 80`.
Follow returned offsets/line handles to inspect the needed proof and limitations.
`read REF --refresh` can replace a cached abstract with a newly available text
snapshot while retaining source history. For independent queries, use
`search-batch PLAN.json --workers 2`, with a short `reason` beside each `query`.
Dependent follow-up queries use actual terms from the newly read text. `follow
REF --direction references --limit 4` discovers further unread leads. Search
errors, successful empty searches and irrelevant hits are different outcomes;
use `--retry-failed` for old failed requests and `--refresh` for new discovery.

Offline verification uses repository fixtures copied from the public audit13
responses, with provenance in `tests/fixtures/campaign-reference/provenance.json`:

```sh
/usr/bin/python3 -B -m unittest discover -s tests -p 'campaign_reference*_test.py' -v
bunx vitest run tests/campaignReference.test.ts
/path/to/dependency-complete/python -B tests/campaign_reference_replay.py \
  --bundle /path/to/new/reference-tools --output /path/to/reference-replay.json
/path/to/dependency-complete/python -B tests/campaign_reference_reader_replay.py \
  --bundle /path/to/new/reference-tools --output /path/to/reader-replay.json
/path/to/dependency-complete/python -B tests/campaign_reference_efficiency_replay.py \
  --bundle /path/to/new/reference-tools --output /path/to/efficiency-replay.json
/path/to/dependency-complete/python -B tests/campaign_reference_topic_replay.py \
  --bundle /path/to/new/reference-tools --output /path/to/topic-replay.json
```

The final replay disables sockets and supplies saved XML / mock provider results.
It exercises the actual frozen helper, search cache isolation and reuse, bounded
failed-request recovery, old REF reading, and the generated CLI's `--help`.
