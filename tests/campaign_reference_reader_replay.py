"""Replay the installed academic reader, extraction and REF cache without network.

Only HTTP response boundaries are replaced with local HTML/metadata fixtures.
The installed reader, HTML extractor, snapshots, citation/REF code and budgets run
unchanged. Discovery and the older REF/source-policy cases have their own replay.
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


PROOF = ('Let epsilon be positive. Choose N so that the Cauchy estimate holds '
         'for every n above N. Passing to the limit proves the claimed inequality.')
ARTICLE = ('<!doctype html><html><head><title>Bounded convergence fixture</title></head>'
           '<body><nav>Navigation excluded by extraction</nav><article>'
           '<h1>Bounded convergence</h1><h2>Abstract</h2><p>A limit estimate.</p>'
           '<h2>Proof</h2><p>' + PROOF + '</p></article></body></html>').encode()
ABSTRACT = ('<!doctype html><html><head><title>Entropy fixture</title></head>'
            '<body><main><h1>Abstract</h1><p>We investigate an entropy inequality '
            'for finite probability spaces. The summary contains no proof.</p>'
            '</main></body></html>').encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    manifest = bundle / 'reference-search-manifest.json'
    assert manifest.is_file(), 'Use a separately installed reference-tools bundle'
    unexpected_network = []

    def no_network(*values, **kwargs):
        unexpected_network.append('socket-or-requests')
        raise AssertionError('network is disabled in academic reader replay')

    reports = []
    with ExitStack() as stack:
        for name in ('create_connection', 'getaddrinfo'):
            stack.enter_context(patch.object(socket, name, no_network))
        for name in ('connect', 'connect_ex'):
            stack.enter_context(patch.object(socket.socket, name, no_network))
        sys.path.insert(0, str(bundle))
        spec = importlib.util.spec_from_file_location('installed_reader_policy', bundle / 'reference-search-policy.py')
        policy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(policy)
        research = policy.load_research()
        assert Path(research.__file__).resolve().is_relative_to(bundle / 'base')
        stack.enter_context(patch.object(research.base.requests.sessions.Session, 'send', no_network))
        from campaign_reference import install
        install(research)
        policy.install_source_policy(research)
        cases = [
            {'name': 'doi-page-body', 'url': 'https://doi.org/10.1000/reader-replay',
             'scope': 'page_text', 'terms': ['Cauchy'], 'failed': 0,
             'documents': [('https://doi.org/10.1000/reader-replay', ARTICLE,
                            'https://publisher.example.org/reader-replay-paper')],
             'metadata': True},
            {'name': 'arxiv-same-version-html', 'url': 'https://arxiv.org/abs/2401.12345v2',
             'scope': 'full_text', 'terms': ['Cauchy'], 'failed': 1,
             'documents': [('https://arxiv.org/pdf/2401.12345v2', None, None),
                           ('https://arxiv.org/html/2401.12345v2', ARTICLE,
                            'https://arxiv.org/html/2401.12345v2')], 'metadata': False},
            {'name': 'arxiv-abstract-only', 'url': 'https://arxiv.org/abs/math/0301234v3',
             'scope': 'abstract', 'terms': ['entropy'], 'failed': 2,
             'documents': [('https://arxiv.org/pdf/math/0301234v3', None, None),
                           ('https://arxiv.org/html/math/0301234v3', None, None),
                           ('https://arxiv.org/abs/math/0301234v3', ABSTRACT,
                            'https://arxiv.org/abs/math/0301234v3')], 'metadata': False},
        ]
        for case in cases:
            with tempfile.TemporaryDirectory(prefix='campaign-reader-replay-') as directory, \
                    patch.dict(os.environ, {'DEEP_RESEARCH_RUN_DIR': directory, 'DRBENCH_RUN_DIR': directory,
                        'DEEP_RESEARCH_SOURCE_POLICY': 'mixed', 'DRBENCH_MAX_READ': '2'}):
                calls, unexpected_http = [], []
                documents = {url: (raw, resolved) for url, raw, resolved in case['documents']}

                def get(url):
                    policy.require_permitted(url)
                    calls.append({'kind': 'metadata', 'url': url})
                    parsed = urlsplit(url)
                    if not case['metadata'] or parsed.netloc != 'api.openalex.org' or \
                            unquote(parsed.path) != '/works/' + case['url']:
                        unexpected_http.append(url)
                        raise AssertionError('unmocked metadata request: ' + url)
                    return json.dumps({'id': 'https://openalex.org/W123456',
                        'display_name': 'Metadata abstract', 'doi': case['url'],
                        'abstract_inverted_index': {'Metadata': [0], 'alone': [1], 'is': [2],
                                                    'not': [3], 'the': [4], 'proof': [5]}}), url

                def fetch(url):
                    policy.require_permitted(url)
                    calls.append({'kind': 'document', 'url': url})
                    if url not in documents:
                        unexpected_http.append(url)
                        raise AssertionError('unmocked document request: ' + url)
                    raw, resolved = documents[url]
                    if raw is None:
                        raise RuntimeError('fixture document unavailable')
                    policy.require_permitted(resolved)
                    return raw, resolved, 'text/html; charset=utf-8'

                with patch.object(research.base, '_get', get), patch.object(research.v1, '_fetch_bytes', fetch):
                    first = research._ref_read(case['url'], case['terms'], 200)
                    assert not first['cache_hit']
                    assert first['content_scope'] == case['scope']
                    assert first['failed_attempts'] == case['failed']
                    assert first.get('full_text_unavailable', False) == (case['scope'] == 'abstract')
                    assert [row['url'] for row in calls if row['kind'] == 'document'] == [
                        url for url, _, _ in case['documents']]
                    assert len([row for row in calls if row['kind'] == 'metadata']) == int(case['metadata'])
                    ref = first['ref']
                    assert ref == research._source_ref(case['url'])
                    assert research._load_refs()[ref] == case['url']
                    metadata, body = research.workspace.load_source(ref)
                    assert metadata['snapshot_id'] == first['snapshot_id']
                    assert metadata['content_hash'] == hashlib.sha256(body.encode()).hexdigest()
                    assert Path(metadata['body_path']).read_text() == body
                    assert research.workspace.load_source(ref, metadata['snapshot_id']) == (metadata, body)
                    assert first['locators'] and all(row['start_line'] >= 1 for row in first['locators'])
                    assert '<h2>' not in body and 'Navigation excluded by extraction' not in body
                    if case['scope'] != 'abstract':
                        assert PROOF in body and PROOF in '\n'.join(first['windows'])
                        assert 'Metadata alone is not the proof' not in body
                    else:
                        assert 'entropy inequality' in body and PROOF not in body
                    before_cached = list(calls)
                    before_counts = research.base.metrics.snapshot()
                    cached = research._ref_read(ref, case['terms'], 200)
                    assert cached['cache_hit'] and cached['discovery'] == 'registered_ref'
                    assert cached['snapshot_id'] == first['snapshot_id']
                    assert cached['content_scope'] == case['scope']
                    assert cached['citation_url'] == first['citation_url'] == case['url']
                    assert calls == before_cached and research.base.metrics.snapshot() == before_counts
                    assert before_counts['read'] == 1, 'A new document uses one logical read'
                    assert not unexpected_http
                    reports.append({'name': case['name'], 'url': case['url'], 'ref': ref,
                        'content_scope': first['content_scope'], 'resolved_url': first['resolved_url'],
                        'snapshot_id': first['snapshot_id'], 'content_hash': first['content_hash'],
                        'extracted_chars': len(body), 'failed_attempts': first['failed_attempts'],
                        'first_cache_hit': first['cache_hit'], 'second_cache_hit': cached['cache_hit'],
                        'logical_reads': before_counts['read'], 'mock_http_calls': calls,
                        'original_extraction_used': True, 'snapshot_and_ref_roundtrip': 'passed',
                        'proof_passage_extracted': case['scope'] != 'abstract'})
        assert not unexpected_network
    output = {'status': 'passed', 'network': 'disabled', 'network_attempts': 0,
              'http_responses': 'local fixtures', 'models_invoked': False,
              'base_script': str(research.__file__), 'bundle': str(bundle),
              'bundle_manifest_sha256': hashlib.sha256(manifest.read_bytes()).hexdigest(),
              'cases': reports}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': output['status'], 'cases': len(reports), 'network': 'disabled',
                      'output': str(args.output)}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
