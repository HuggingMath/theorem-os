"""Replay known OA document fallbacks through an installed bundle, without network.

Only synthetic metadata and HTTP document responses are supplied. The installed
reader/extractor, REF registry, snapshots, citation handling and budgets run.
"""
import argparse
from contextlib import ExitStack
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from unittest.mock import patch
from urllib.parse import unquote, urlsplit


DOI = 'https://doi.org/10.1000/synthetic-oa-record'
ABS = 'https://arxiv.org/abs/2401.12345v2'
PDF = 'https://arxiv.org/pdf/2401.12345v2'
HTML = 'https://arxiv.org/html/2401.12345v2'
PROOF_MARKER = 'ACCEPTED_SAME_VERSION_PROOF'
REJECTED_MARKER = 'REJECTED_OTHER_SOURCE_TEXT'
PAGE_MARKER = 'UNSELECTED_PUBLISHER_PAGE'


def article(marker):
    return ('<!doctype html><html><head><title>Synthetic proof fixture</title></head>'
            '<body><article><h1>Synthetic theorem</h1><h2>Proof</h2><p>' + marker
            + '. Let epsilon be positive. Choose N so that the Cauchy estimate '
            'holds for every n above N. Passing to the limit proves the inequality.'
            '</p></article></body></html>').encode()


ABSTRACT = ('<!doctype html><html><head><title>Synthetic abstract fixture</title></head>'
            '<body><main><h1>Abstract</h1><p>ARXIV_ABSTRACT_ONLY. We study geometric '
            'inequalities and their estimates. The summary contains no proof.'
            '</p></main></body></html>').encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    manifest = bundle / 'reference-search-manifest.json'
    assert manifest.is_file(), 'use an installed reference-tools bundle'
    network_attempts = []

    def no_network(*args, **kwargs):
        network_attempts.append('attempted')
        raise AssertionError('network is disabled in open-access replay')

    cases = [
        {'name': 'cached_abstract_requires_explicit_refresh_to_full_text',
         'locations': [ABS], 'seed_abstract': True, 'scope': 'full_text', 'failed': 1,
         'documents': [(PDF, None, None), (HTML, article(PROOF_MARKER), HTML)]},
        {'name': 'wrong_version_and_document_do_not_replace_original_abstract',
         'locations': [ABS], 'scope': 'abstract', 'failed': 3,
         'documents': [(PDF, article(REJECTED_MARKER), 'https://arxiv.org/html/2401.12345v3'),
                       (HTML, article(REJECTED_MARKER), 'https://arxiv.org/html/2401.54321v2'),
                       (DOI, None, None), (ABS, ABSTRACT, ABS)]},
        {'name': 'second_explicit_oa_body_precedes_abstract',
         'locations': ['https://publisher.example/explicit-record', ABS,
                       'https://ignored.example/third-location'],
         'scope': 'full_text', 'failed': 1,
         'documents': [('https://publisher.example/explicit-record', article(PAGE_MARKER),
                        'https://publisher.example/explicit-record'),
                       (PDF, None, None), (HTML, article(PROOF_MARKER), HTML)]},
        {'name': 'same_arxiv_aliases_are_deduplicated_before_abstract_fallback',
         'locations': [ABS, PDF + '.pdf'], 'scope': 'abstract', 'failed': 4,
         'documents': [(PDF, None, None), (HTML, None, None),
                       (DOI, None, None), (ABS, None, None)]},
    ]
    reports = []
    with ExitStack() as stack:
        for name in ('create_connection', 'getaddrinfo'):
            stack.enter_context(patch.object(socket, name, no_network))
        for name in ('connect', 'connect_ex'):
            stack.enter_context(patch.object(socket.socket, name, no_network))
        sys.path.insert(0, str(bundle))
        spec = importlib.util.spec_from_file_location('oa_replay_policy',
                                                    bundle / 'reference-search-policy.py')
        policy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(policy)
        research = policy.load_research()
        assert Path(research.__file__).resolve().is_relative_to(bundle / 'base')
        stack.enter_context(patch.object(research.base.requests.sessions.Session, 'send', no_network))
        from campaign_reference import install
        install(research)
        policy.install_source_policy(research)
        for case in cases:
            with tempfile.TemporaryDirectory(prefix='reference-oa-replay-') as directory, \
                    patch.dict(os.environ, {'DEEP_RESEARCH_RUN_DIR': directory,
                        'DRBENCH_RUN_DIR': directory, 'DEEP_RESEARCH_SOURCE_POLICY': 'mixed'}):
                calls, unexpected_http = [], []
                documents = {url: (raw, resolved) for url, raw, resolved in case['documents']}

                def get(url):
                    policy.require_permitted(url)
                    calls.append({'kind': 'metadata', 'url': url})
                    parsed = urlsplit(url)
                    if parsed.hostname != 'api.openalex.org' or unquote(parsed.path) != '/works/' + DOI:
                        unexpected_http.append(url)
                        raise AssertionError('unexpected metadata URL: ' + url)
                    return json.dumps({'display_name': 'Synthetic OA record',
                        'abstract_inverted_index': {'METADATA_SUMMARY_ONLY': [0]},
                        'locations': [{'is_oa': True, 'landing_page_url': value}
                                      for value in case['locations']]}), url

                def fetch(url):
                    policy.require_permitted(url)
                    calls.append({'kind': 'document', 'url': url})
                    if url not in documents:
                        unexpected_http.append(url)
                        raise AssertionError('unexpected document URL: ' + url)
                    raw, resolved = documents[url]
                    if raw is None:
                        raise RuntimeError('synthetic document unavailable')
                    policy.require_permitted(resolved)
                    return raw, resolved, 'text/html; charset=utf-8'

                with patch.object(research.base, '_get', get), patch.object(research.v1, '_fetch_bytes', fetch):
                    ref = research._source_ref(DOI)
                    previous = None
                    if case.get('seed_abstract'):
                        previous = research.workspace.save_source(ref, {
                            'url': DOI, 'title': 'Previously saved abstract',
                            'resolved_url': ABS, 'content_type': 'html',
                            'content_scope': 'abstract', 'full_text_unavailable': True,
                            'source_type': 'primary_or_academic', 'fallback': 'arxiv_abstract'},
                            'PREVIOUS_ABSTRACT_SNAPSHOT. The prior summary contains no proof.')
                        research._save_refs({ref: DOI})
                        cached_previous = research._ref_read(ref, ['summary'], 200)
                        assert cached_previous['cache_hit'] and not calls, cached_previous
                        assert cached_previous['content_scope'] == 'abstract', cached_previous
                        first = research._ref_read(ref, [PROOF_MARKER], 200, refresh=True)
                    else:
                        first = research._ref_read(DOI, [PROOF_MARKER], 200)
                    assert first['ref'] == ref and not first['cache_hit'], first
                    assert first['content_scope'] == case['scope'], first
                    assert first['failed_attempts'] == case['failed'], first
                    assert first.get('full_text_unavailable', False) == (case['scope'] == 'abstract'), first
                    assert first['citation_url'] == DOI and first['allowed_citation_urls'] == [DOI], first
                    assert research._load_refs() == {ref: DOI}, first
                    metadata, body = research.workspace.load_source(ref)
                    assert REJECTED_MARKER not in body and PAGE_MARKER not in body, body
                    assert research.workspace.load_source(ref, metadata['snapshot_id']) == (metadata, body)
                    assert metadata['snapshot_id'] == first['snapshot_id'], first
                    assert metadata['content_hash'] == hashlib.sha256(body.encode()).hexdigest()
                    if case['scope'] == 'full_text':
                        assert PROOF_MARKER in body, body
                    else:
                        assert PROOF_MARKER not in body, body
                    if previous:
                        assert first['snapshot_id'] != previous[0]['snapshot_id'], first
                        assert research.workspace.load_source(ref, previous[0]['snapshot_id']) == previous
                        assert 'PREVIOUS_ABSTRACT_SNAPSHOT' not in body, body
                    if case['name'].startswith('wrong_version'):
                        assert sum('arxiv_source_identity_mismatch' in row.get('error', '')
                                   for row in first['academic_read_attempts']) == 2, first
                        assert 'ARXIV_ABSTRACT_ONLY' in body, body
                    assert [row['url'] for row in calls if row['kind'] == 'document'] == [
                        url for url, _, _ in case['documents']], calls
                    assert sum(row['kind'] == 'metadata' for row in calls) == 1, calls
                    assert len([row for row in calls if row['kind'] == 'document']) <= 7, calls
                    assert not unexpected_http, unexpected_http
                    before_cache = list(calls)
                    before_budget = research.base.metrics.snapshot()
                    cached = research._ref_read(ref, [PROOF_MARKER], 200)
                    assert cached['cache_hit'] and cached['snapshot_id'] == first['snapshot_id'], cached
                    assert calls == before_cache and research.base.metrics.snapshot() == before_budget
                    assert before_budget['read'] == 1, before_budget
                    reports.append({'name': case['name'], 'ref': ref,
                        'content_scope': first['content_scope'], 'resolved_url': first['resolved_url'],
                        'failed_attempts': first['failed_attempts'], 'snapshot_id': first['snapshot_id'],
                        'mock_http_calls': calls, 'all_calls_within_explicit_location_or_arxiv_rules': True,
                        'rejected_or_unselected_text_absent_from_body': True,
                        'cache_reused_without_requests': True,
                        'previous_abstract_upgraded_only_on_refresh': bool(previous),
                        'previous_snapshot_preserved': bool(previous)})
        assert not network_attempts, network_attempts
    output = {'status': 'passed', 'network': 'disabled', 'models_invoked': False,
              'bundle': str(bundle), 'base_script': str(research.__file__),
              'bundle_manifest_sha256': hashlib.sha256(manifest.read_bytes()).hexdigest(),
              'fixtures': 'Synthetic metadata/HTML only; no paper bodies or answers retrieved.',
              'attempt_bound': {'explicit_oa_urls': 2, 'arxiv_representations_per_url': 3,
                                'original_or_recorded_doi': 1, 'maximum_document_attempts': 7,
                                'metadata_attempts': 1, 'maximum_total_attempts': 8,
                                'note': 'Alias deduplication and first successful body reduce this upper bound.'},
              'cases': reports}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': 'passed', 'cases': len(reports), 'output': str(args.output)}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
