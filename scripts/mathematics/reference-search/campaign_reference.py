"""Bounded academic discovery for the campaign's installed research CLI.

The installed reader, REF store and provider cache remain authoritative. This
adapter only changes discovery, and never treats an unread search card as proof.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
from urllib.parse import unquote, urlencode
import xml.etree.ElementTree as ET

MAX_FALLBACK_REQUESTS = 4
MAX_QUERY_WORDS = 24
MAX_PHRASE_WORDS = 4
ATOM = {"a": "http://www.w3.org/2005/Atom"}
WORD = re.compile(r"[^\W_]+", re.UNICODE)
# Phrase boundaries, not domain-specific synonym expansion. Explicit quotes and
# --target take precedence; an unquoted query uses short groups ending at a head.
HEADS = set("rank complexity polytope matrix graph group manifold operator equation theorem space measure function metric embedding representation curve lattice algebra kernel spectrum radius gap geometry optimization spectrahedron".split())
STOP = set("a an the of for on in at to and or with without from using via does which what is are prove proof paper theorem study find search".split())


def words(text):
    return [word.casefold() for word in WORD.findall(str(text)) if word.casefold() not in STOP]


def normalized(text):
    return " ".join(WORD.findall(str(text).casefold()))


def explicit_phrases(query):
    return list(dict.fromkeys(' '.join(value.casefold().split())
                             for value in re.findall(r'"([^\"]+)"', query) if value.strip()))


def head_phrases(query):
    tokens = words(re.sub(r"\bsite:\S+", " ", query))[:MAX_QUERY_WORDS]
    groups, start = [], 0
    for index, word in enumerate(tokens):
        if word in HEADS or word.endswith("s") and word[:-1] in HEADS:
            groups.append(" ".join(tokens[max(start, index + 1 - MAX_PHRASE_WORDS):index + 1]))
            start = index + 1
    return list(dict.fromkeys(groups))[:4]


def phrases(query):
    # Quoted phrases are the caller's exact terminology. Removing connecting
    # words or cutting a long title changes the query rather than broadening it.
    explicit = explicit_phrases(query)
    if explicit:
        return explicit
    groups = head_phrases(query)
    if not groups:
        tokens = words(query)[:MAX_QUERY_WORDS]
        groups = [" ".join(tokens[:3]), " ".join(tokens[3:6])]
    return list(dict.fromkeys(filter(None, groups)))[:4]


def query_plan(query, target=None):
    # Start with the caller's question. Heuristic phrase boundaries only inform
    # explicitly broader fallbacks, never rewrite the primary provider request.
    primary = ' '.join(query.casefold().split())
    subject = ' '.join(target.casefold().split()) if target else ''
    if subject:
        primary += (' ' if primary else '') + '"' + subject + '"'
    if not primary:
        return []
    groups = phrases(query)
    concept = groups[0] if groups else " ".join(words(query)[:3])
    subject = subject or (groups[1] if len(groups) > 1 else "")
    quote = lambda value: '"' + value + '"'
    explicit = explicit_phrases(query)
    candidates = [("original", primary)]
    if concept:
        candidates.append(("concept-only", quote(concept) if explicit else concept))
    if subject:
        candidates.append(("subject-only", quote(subject) if target or explicit else subject))
    queries, seen = [], set()
    for stage, value in candidates:
        if value and value not in seen:
            queries.append({"stage": stage, "query": value})
            seen.add(value)
    return queries


def arxiv_query(query):
    # Unquoted terms remain separate. Removing connecting words and adding
    # quotes can manufacture a phrase that the caller never asked for.
    terms = re.findall(r'"([^\"]+)"|(\S+)', query.casefold())
    return " AND ".join('all:"' + phrase + '"' if phrase else 'all:' + word
                        for phrase, word in terms)


def _academic(card):
    return card.get("engine") in {"arxiv", "openalex"} or card.get("source_type") == "primary_or_academic"


def relevance(card, query, target=None):
    card = dict(card)
    groups = phrases(query)
    concept = set(words(groups[0] if groups else query))
    # A noun-anchored object can guide discovery, but an arbitrary second slice
    # of a natural-language query cannot become a required subject.
    explicit = explicit_phrases(query)
    subjects = [set(words(value)) for value in explicit[1:]]
    heads = head_phrases(query) if not explicit else []
    if not target and len(heads) > 1:
        subjects.append(set(words(heads[1])))
    if target:
        subjects.append(set(words(target)))
    # Singular/plural spelling should not hide an otherwise exact object match.
    singular = lambda values: {value[:-1] if value.endswith("s") and not value.endswith("ss") else value for value in values}
    text = singular(words(str(card.get("title", "")) + " " + str(card.get("snippet", ""))))
    concept = singular(concept)
    concept_match = bool(concept) and concept <= text
    subject_match = all(singular(subject) <= text for subject in subjects)
    level = "matching" if concept_match and subject_match else "background" if concept_match and _academic(card) else "low"
    card["relevance"] = level
    card["relevance_reasons"] = ([] if concept_match else ["concept_not_matched"]) + ([] if subject_match else ["research_subject_not_matched"])
    return card


def document_ids(card):
    ids, arxiv_ids = set(), set()
    for value in [card.get("url", ""), card.get("doi", ""), card.get("arxiv_id", ""),
                  *(row.get("url", "") for row in card.get("alternate_sources", []))]:
        value = unquote(str(value)).casefold().strip()
        match = re.search(r"(?:arxiv(?:\.org/(?:abs|pdf|html)/|:)|10\.48550/arxiv\.)(\d{4}\.\d{4,5}|[a-z][a-z.-]*/\d{7})(v\d+)?", value)
        if match:
            arxiv_ids.add("arxiv:" + match[1] + (match[2] or ""))
        doi = re.search(r"(?:doi\.org/|^)(10\.\d{4,9}/[^?#\s]+)", value)
        if doi and not doi[1].startswith("10.48550/arxiv."):
            ids.add("doi:" + doi[1].rstrip("/"))
    if arxiv_ids:
        # A journal DOI or identical title must not bridge v1, v3 and a moving
        # unversioned preprint into one slot: their proof text may differ.
        return arxiv_ids | {"url:" + str(card.get("url", "")).split("#", 1)[0]}
    if _academic(card):
        authors = card.get("authors")
        author_text = " ".join(authors) if isinstance(authors, list) else str(card.get("snippet", "")).split(" | cited by ")[0]
        title = normalized(card.get("title", ""))
        # An identical long title plus an explicit author list can connect a
        # preprint and journal DOI. Title coincidence alone never removes a lead.
        if len(title) >= 32 and (authors or " | cited by " in str(card.get("snippet", ""))):
            ids.add("title-authors:" + title + "/" + normalized(author_text))
    ids.add("url:" + str(card.get("url", "")).split("#", 1)[0])
    return ids


def install(research):
    if getattr(research, "_campaign_reference_adapter", False):
        return
    research._campaign_reference_adapter = True
    from academic_read import install as install_academic_reader
    install_academic_reader(research)
    base_identity = hashlib.sha256(b"".join(path.name.encode() + path.read_bytes()
                                  for path in sorted(Path(research.__file__).parent.glob('*.py')))).hexdigest()
    identity = hashlib.sha256(base_identity.encode() + b"".join(Path(__file__).with_name(name).read_bytes()
                              for name in ("campaign_reference.py", "academic_read.py", "reference-search-policy.py", "reference-source-provenance.json"))).hexdigest()
    original_config = research._provider_config
    research._provider_config = lambda plan: {**original_config(plan), "campaign_reference_adapter_sha256": identity,
                                             "campaign_reference_base_sha256": base_identity}
    original_search_id = research.workspace.search_id
    research.workspace.search_id = lambda request: original_search_id({**request, "campaign_reference_adapter_sha256": identity})

    def arxiv(query, limit):
        url = "https://export.arxiv.org/api/query?" + urlencode({"search_query": arxiv_query(query), "start": 0,
                                                                "max_results": limit, "sortBy": "relevance"})
        body, _ = research.base._get(url)
        root = ET.fromstring(body)
        if root.tag != "{" + ATOM["a"] + "}feed":
            raise ValueError("unexpected arXiv search response")
        cards = []
        for entry in root.findall("a:entry", ATOM)[:limit]:
            get = lambda name: entry.findtext("a:" + name, default="", namespaces=ATOM)
            url = re.sub(r"^http://", "https://", get("id").strip())
            title = research.base._clean(get("title"), 240)
            if url and title and research.base._url_ok(url):
                cards.append({"url": url, "title": title, "snippet": research.base._clean(get("published")[:10] + ". " + get("summary"), 900),
                              "authors": [node.findtext("a:name", default="", namespaces=ATOM) for node in entry.findall("a:author", ATOM)],
                              "doi": entry.findtext("{http://arxiv.org/schemas/atom}doi", default=""),
                              "engine": "arxiv", "source_type": "primary_or_academic"})
        return cards

    def openalex(query, limit):
        compact = ' '.join(query.casefold().replace('"', '').split())
        body, _ = research.base._get("https://api.openalex.org/autocomplete/works?" + urlencode({"q": compact}))
        rows = json.loads(body).get("results")
        if not isinstance(rows, list):
            raise ValueError("unexpected OpenAlex search response")
        cards = []
        for row in rows[:limit]:
            url = row.get("external_id") or row.get("id") or ""
            title = research.base._clean(row.get("display_name") or "", 240)
            if url and title and research.base._url_ok(url):
                cards.append({"url": url, "title": title, "snippet": research.base._clean(str(row.get("hint") or "") + " | cited by " + str(row.get("cited_by_count", 0)), 900),
                              "openalex_id": row.get("id", ""), "engine": "openalex", "source_type": "primary_or_academic"})
        return cards

    research._arxiv, research._openalex_exact = arxiv, openalex
    original_rank = research._rank_discovery

    def permitted(card):
        predicate = getattr(research, '_campaign_reference_candidate_permitted', None)
        return predicate(card) if predicate else True

    def rank(cards, query, limit, target=None, *, diagnostics=None):
        ranked = original_rank(cards, query, len(cards), target, diagnostics=diagnostics)
        ranked = [relevance(card, query, target) for card in ranked]
        ranked.sort(key=lambda card: (not permitted(card), {"matching": 0, "background": 1, "low": 2}[card["relevance"]]))
        groups = []
        for card in ranked:
            ids = document_ids(card)
            matching = [group for group in groups if group[0] & ids]
            if not matching:
                groups.append([ids, [card]])
            else:
                group = matching[0]
                group[0].update(ids)
                group[1].append(card)
                for other in matching[1:]:
                    group[0].update(other[0])
                    group[1].extend(other[1])
                    groups.remove(other)
        output = []
        for _, versions in groups:
            card = dict(versions[0])
            aliases = {}
            for version in versions:
                for row in [version, *version.get("alternate_sources", [])]:
                    if row["url"] != card["url"]:
                        aliases[row["url"]] = {"url": row["url"], "engine": row.get("engine")}
            if aliases:
                card["alternate_sources"] = list(aliases.values())
                card["alias_count"] = len(aliases)
            output.append(card)
        # Merging aliases can itself reveal a held source identity.
        output.sort(key=lambda card: not permitted(card))
        if diagnostics is not None:
            diagnostics.update(document_versions_merged=len(ranked) - len(groups), returned_candidates=min(limit, len(output)),
                               page_limit_omitted=max(0, len(output) - limit), relevance_policy="matching_then_background_then_labelled_low")
        return output[:limit]

    research._rank_discovery = rank
    original_gaps = research._recall_gaps

    def gaps(cards, query, limit, target=None):
        labelled = [relevance(card, query, target) for card in cards if permitted(card)]
        useful = rank([card for card in labelled if card["relevance"] != "low"], query, len(labelled), target)
        result = original_gaps(useful, query, limit, target)
        required = min(2, limit)
        if len(useful) < required:
            result.append('too_few_distinct_documents')
        if labelled and not any(card["relevance"] == "matching" for card in labelled):
            result.append("no_research_subject_match")
        if sum(card['relevance'] == 'matching' for card in useful) >= required:
            # Snippets rarely contain every requested exponent or qualifier.
            # Read these candidates before spending more requests on modifiers;
            # the omitted words remain visible in the public recall diagnostics.
            result = [gap for gap in result if gap not in (
                'need_terms_missing_from_results', 'similar_titles_require_read')]
        return list(dict.fromkeys(result))

    research._recall_gaps = gaps
    original_direct = research._search_direct

    def direct(query, limit=8, target=None):
        plan = query_plan(query, target)
        execution = research._ACTIVE_SEARCH.get()
        mathematical = (research._academic_search_enabled() and
                        not research._practitioner_search_enabled(query) and
                        (not execution or execution.artifact in (None, 'paper')))
        if mathematical:
            outcomes, rows = [], []
            request = {'query': plan[0]['query'] if plan else query, 'limit': max(2, limit // 3)}
            for provider, operation in (('arxiv', arxiv), ('openalex', openalex)):
                rows.extend(research._call_provider(provider, lambda operation=operation: operation(**request),
                                                    outcomes, request=request))
            result = {'query': query, 'results': rows, 'provider_results': outcomes, 'discovery_diagnostics': {}}
        else:
            result = original_direct(query, limit, target)
        attempts = 0
        if research._academic_search_enabled() and gaps(result.get("results", []), query, limit, target):
            variants = plan[1:]
            for variant in variants:
                for provider, operation in (("arxiv", arxiv), ("openalex", openalex)):
                    if attempts >= MAX_FALLBACK_REQUESTS:
                        break
                    request = {"query": variant["query"], "limit": min(8, max(4, limit))}
                    rows = research._call_provider(provider, lambda operation=operation, request=request: operation(**request),
                                                   result["provider_results"], request=request)
                    result["results"].extend(rows)
                    attempts += 1
                    if not gaps(result['results'], query, limit, target):
                        break
                if not gaps(result["results"], query, limit, target):
                    break
        web_request = {'query': query, 'limit': max(8, limit)}
        if mathematical and (gaps(result['results'], query, limit, target) or
                             research._recovery_has('duckduckgo', web_request)):
            # Academic candidates come first; a slow general web provider is a
            # fallback, not a prerequisite for reading useful papers.
            result['results'].extend(research._call_provider(
                'duckduckgo', lambda: research._duckduckgo(**web_request),
                result['provider_results'], request=web_request))
            if gaps(result['results'], query, limit, target) or research._recovery_has('bing', web_request):
                result['results'].extend(research._call_provider(
                    'bing', lambda: research.base._bing(**web_request, strict=True),
                    result['provider_results'], request=web_request))
            if not research.v1._is_english_query(query):
                result['results'].extend(research._call_provider(
                    '360', lambda: research.base._so360(**web_request, strict=True),
                    result['provider_results'], request=web_request))
        diagnostics = result.setdefault("discovery_diagnostics", {})
        diagnostics["academic_recall"] = {"query_plan": plan, "fallback_requests": attempts,
                                          "max_fallback_requests": MAX_FALLBACK_REQUESTS,
                                          "academic_first": mathematical}
        diagnostics["academic_ranking"] = {}
        result["results"] = rank(result["results"], query, limit, target, diagnostics=diagnostics["academic_ranking"])
        result["provider_errors"] = research._outcome_errors(result["provider_results"])
        return result

    research._search_direct = direct
    original_public = research._public_leads

    original_execute = research._search_base_execute

    def execute(query, limit, mode, artifact, target):
        return {**original_execute(query, limit, mode, artifact, target),
                "research_target": target, "research_limit": limit}

    research._search_base_execute = execute

    def public(result):
        query, target = result.get("query", ""), result.get("research_target")
        if not isinstance(query, str) or not query.strip():
            # Citation-graph follow commands also use this publisher but have no
            # search question against which to assess relevance.
            return {**original_public(result), "campaign_reference_adapter_sha256": identity}
        labelled = [relevance(card, query, target) for card in result.get("results", [])]
        output = original_public({**result, "results": labelled})
        output["low_relevance_results"] = [row for row in output["results"] if row["relevance"] == "low"]
        output["results"] = [row for row in output["results"] if row["relevance"] != "low"]
        output["relevance_summary"] = {level: sum(row["relevance"] == level for row in labelled) for level in ("matching", "background", "low")}
        covered = set(words(' '.join(str(card.get(key) or '') for card in labelled for key in ('title', 'snippet'))))
        output["recall_checks"] = {**output.get("recall_checks", {}),
                                   "remaining_gaps": gaps(labelled, query, result.get('research_limit', 2), target),
                                   "unmatched_query_terms": sorted(set(words(query)) - covered),
                                   "note": "Discovery checks guide candidate selection only. Read the proof text to verify all requested hypotheses and bounds; unmatched snippet terms remain unverified."}
        output["campaign_reference_adapter_sha256"] = identity
        if output["recall_checks"]["remaining_gaps"] and labelled:
            output["status"] = "partial"
        output["next_action"] += " Low-relevance cards are separated from literature results. Background papers may not concern the research object; failed or bounded searches do not establish absence of a theorem."
        return output

    research._public_leads = public
