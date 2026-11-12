"""Replay installed reader identity and provider recovery with network disabled.

All HTTP responses below are synthetic fixtures. The actual installed extraction,
REF, snapshot, citation, provider cache and recovery code runs unchanged.
"""
import argparse
from collections import Counter
from contextlib import ExitStack
from html import escape
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from unittest.mock import patch
from urllib.parse import urlsplit


REQUESTED = 'https://arxiv.org/abs/2401.12345v1'
ACCEPTED_MARKER = 'ACCEPTED_SAME_DOCUMENT_PROOF'
REJECTED_MARKER = 'REJECTED_DIFFERENT_SOURCE_TEXT'
ERROR_FEED = ('<feed xmlns="http://www.w3.org/2005/Atom"><entry>'
              '<id>http://arxiv.org/api/errors#incorrect_id_format_for_x</id>'
              '<title>Error</title><summary>incorrect id format for x</summary>'
              '</entry></feed>')


def article(marker):
    return ('<!doctype html><html><head><title>Synthetic proof fixture</title></head>'
            '<body><article><h1>Synthetic proof</h1><h2>Proof</h2><p>' + marker
            + '. Let epsilon be positive. The Cauchy estimate holds for every n '
            'above N. Passing to the limit proves the claimed inequality.'
            '</p></article></body></html>').encode()


def feed(cards):
    return '<feed xmlns="http://www.w3.org/2005/Atom">' + ''.join(
        '<entry><id>' + escape(card['url']) + '</id><title>' + escape(card['title'])
        + '</title><summary>' + escape(card['snippet']) + '</summary></entry>'
        for card in cards) + '</feed>'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    network_attempts = []

    def no_network(*args, **kwargs):
        network_attempts.append('attempted')
        raise AssertionError('network is disabled in source identity replay')

    def fixture_dns(host, port, *args, **kwargs):
        # The installed URL-policy check resolves candidate hosts. Keep that
        # check active with a synthetic public address and no external DNS.
        if host not in {'arxiv.org', 'www.arxiv.org', 'export.arxiv.org'}:
            return no_network(host, port)
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '',
                 ('93.184.216.34', port or 0))]

    reports = []
    with ExitStack() as stack:
        stack.enter_context(patch.object(socket, 'create_connection', no_network))
        stack.enter_context(patch.object(socket, 'getaddrinfo', fixture_dns))
        for name in ('connect', 'connect_ex'):
            stack.enter_context(patch.object(socket.socket, name, no_network))
        sys.path.insert(0, str(bundle))
        spec = importlib.util.spec_from_file_location('version_replay_policy',
                                                    bundle / 'reference-search-policy.py')
        policy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(policy)
        research = policy.load_research()
        assert Path(research.__file__).resolve().is_relative_to(bundle / 'base')
        stack.enter_context(patch.object(research.base.requests.sessions.Session, 'send', no_network))
        from campaign_reference import install
        install(research)
        policy.install_source_policy(research)

        for case in ('explicit_version_uses_same_version_fallback',
                     'different_document_does_not_replace_existing_snapshot',
                     'unversioned_request_may_resolve_to_a_version'):
            with tempfile.TemporaryDirectory(prefix='reference-version-replay-') as directory, \
                    patch.dict(os.environ, {'DEEP_RESEARCH_RUN_DIR': directory,
                        'DRBENCH_RUN_DIR': directory, 'DEEP_RESEARCH_SOURCE_POLICY': 'mixed'}):
                calls = []
                reject_refresh = {'enabled': False}
                requested = 'https://arxiv.org/abs/2401.12345' if case.startswith('unversioned') else REQUESTED
                wrong_url = 'https://arxiv.org/html/2401.54321v1'

                def fetch(url):
                    policy.require_permitted(url)
                    calls.append(url)
                    if reject_refresh['enabled']:
                        return article(REJECTED_MARKER), wrong_url, 'text/html'
                    if case.startswith('explicit') and len(calls) == 1:
                        return article(REJECTED_MARKER), 'https://arxiv.org/html/2401.12345v3', 'text/html'
                    version = 'v3' if case.startswith('unversioned') else 'v1'
                    return article(ACCEPTED_MARKER), 'https://arxiv.org/html/2401.12345' + version, 'text/html'

                with patch.object(research.v1, '_fetch_bytes', fetch):
                    first = research._ref_read(requested, [ACCEPTED_MARKER], 200)
                    ref = research._source_ref(requested)
                    assert first['ref'] == ref and not first['cache_hit'], first
                    assert first['content_scope'] == 'full_text', first
                    assert first['citation_url'] == requested, first
                    assert first['allowed_citation_urls'] == [requested], first
                    metadata, body = research.workspace.load_source(ref)
                    assert ACCEPTED_MARKER in body and REJECTED_MARKER not in body, body
                    assert research.workspace.load_source(ref, metadata['snapshot_id']) == (metadata, body)
                    assert first['snapshot_id'] == metadata['snapshot_id'], first
                    assert research._load_refs() == {ref: requested}, first
                    assert not first.get('full_text_unavailable'), first
                    if case.startswith('explicit'):
                        assert first['failed_attempts'] == 1, first
                        assert calls == ['https://arxiv.org/pdf/2401.12345v1',
                                         'https://arxiv.org/html/2401.12345v1'], calls
                        assert first['academic_read_attempts'][0]['status'] == 'error', first
                        assert 'arxiv_source_identity_mismatch' in first['academic_read_attempts'][0]['error'], first
                        assert 'https://arxiv.org/html/2401.12345v3' not in research._load_citations()
                    elif case.startswith('different'):
                        before_failed_refresh = list(calls)
                        citations_before = research._load_citations()
                        reject_refresh['enabled'] = True
                        try:
                            research._ref_read(ref, [REJECTED_MARKER], 200, refresh=True)
                        except RuntimeError as error:
                            assert 'arxiv_source_identity_mismatch' in str(error), error
                        else:
                            raise AssertionError('a different document replaced the existing source')
                        assert len(calls) == len(before_failed_refresh) + 3, calls
                        assert research.workspace.load_source(ref) == (metadata, body)
                        assert research.workspace.load_source(ref, metadata['snapshot_id']) == (metadata, body)
                        assert research._load_citations() == citations_before
                        assert wrong_url not in citations_before
                        for saved_text in Path(directory).rglob('*.txt'):
                            assert REJECTED_MARKER not in saved_text.read_text(), saved_text
                    else:
                        assert first['resolved_url'] == 'https://arxiv.org/html/2401.12345v3', first
                        assert first['failed_attempts'] == 0 and len(calls) == 1, first
                    before_cache = list(calls)
                    cached = research._ref_read(ref, [ACCEPTED_MARKER], 200)
                    assert cached['cache_hit'] and calls == before_cache, cached
                    assert cached['snapshot_id'] == metadata['snapshot_id'], cached
                    assert REJECTED_MARKER not in '\n'.join(cached['windows']), cached
                    reports.append({'name': case, 'requested_url': requested, 'ref': ref,
                        'resolved_url': first['resolved_url'], 'content_scope': first['content_scope'],
                        'snapshot_id': metadata['snapshot_id'], 'content_hash': metadata['content_hash'],
                        'rejected_text_absent_from_saved_body': True,
                        'rejected_source_absent_from_allowed_citations': True,
                        'cache_reused_without_requests': True, 'mock_document_calls': calls})

        with tempfile.TemporaryDirectory(prefix='reference-provider-recovery-') as directory, \
                patch.dict(os.environ, {'DEEP_RESEARCH_RUN_DIR': directory,
                    'DRBENCH_RUN_DIR': directory, 'DEEP_RESEARCH_SOURCE_POLICY': 'mixed',
                    'DRBENCH_ACADEMIC_SEARCH': '1', 'DRBENCH_PRACTITIONER_SEARCH': '0'}):
            calls = Counter()
            recovering = {'enabled': False}
            unexpected_providers = []
            new_cards = [{'url': f'https://arxiv.org/abs/2401.1234{index}v1',
                          'title': f'Heat kernel estimates {index}',
                          'snippet': 'Synthetic discovery fixture; not proof evidence.'}
                         for index in range(2)]
            old_cards = [dict(card, url=f'https://arxiv.org/abs/2401.1234{index + 2}v1',
                              engine='duckduckgo-html', source_type='primary_or_academic')
                         for index, card in enumerate(new_cards)]

            def get(url):
                host = urlsplit(url).netloc
                calls[host] += 1
                if host == 'export.arxiv.org':
                    return feed(new_cards) if recovering['enabled'] else ERROR_FEED, url
                if host == 'api.openalex.org':
                    return json.dumps({'results': []}), url
                unexpected_providers.append(host)
                raise AssertionError('unexpected provider: ' + host)

            def duckduckgo(*args, **kwargs):
                calls['duckduckgo'] += 1
                return old_cards

            def unexpected(name):
                unexpected_providers.append(name)
                raise AssertionError('unexpected provider: ' + name)

            with patch.object(research.base, '_get', get), \
                    patch.object(research, '_duckduckgo', duckduckgo), \
                    patch.object(research.base, '_bing', lambda *args, **kwargs: unexpected('bing')), \
                    patch.object(research, '_search_anysearch', lambda *args: unexpected('anysearch')):
                arguments = ('"heat kernel"', 6, None, None, None, 'direct')
                first = research._ref_search(*arguments)
                assert calls == Counter({'export.arxiv.org': 1, 'api.openalex.org': 1,
                                         'duckduckgo': 1}), calls
                arxiv_outcome = next(row for row in first['provider_results'] if row['provider'] == 'arxiv')
                assert arxiv_outcome['status'] == 'error' and 'incorrect id format' in arxiv_outcome['error'], first
                assert next(row for row in first['provider_results'] if row['provider'] == 'openalex')['status'] == 'empty'
                assert first['status'] == 'partial' and len(first['results']) == 2, first
                before_cache = calls.copy()
                assert research._ref_search(*arguments)['cache_hit'] and calls == before_cache
                recovering['enabled'] = True
                recovered = research._ref_search(*arguments, retry_failed=True)
                assert calls == Counter({'export.arxiv.org': 2, 'api.openalex.org': 1,
                                         'duckduckgo': 1}), calls
                assert recovered['recovery']['retried_requests'] == 1, recovered
                assert recovered['recovery']['deferred_new_requests'] == 0, recovered
                assert {row['ref'] for row in recovered['results']} == {
                    research._source_ref(card['url']) for card in old_cards + new_cards}, recovered
                assert not recovered.get('provider_errors'), recovered
                empty = next(row for row in recovered['provider_results'] if row['provider'] == 'openalex')
                assert empty['status'] == 'empty' and empty['cache_reused'] and not empty['retried'], empty
                assert all(not row['citable'] and row['evidence_status'] == 'unread_lead'
                           for row in recovered['results']), recovered
                assert not research._load_citations(), 'search candidates must not authorize citations'
                assert not unexpected_providers, unexpected_providers
                reports.append({'name': 'arxiv_error_feed_recovers_only_failed_request',
                    'calls': dict(calls), 'initial_arxiv_status': arxiv_outcome['status'],
                    'recovery': recovered['recovery'], 'preserved_empty_provider': empty,
                    'new_candidates_visible': True, 'search_did_not_authorize_citations': True})
        assert not network_attempts, network_attempts
    output = {'status': 'passed', 'network': 'disabled', 'models_invoked': False,
              'bundle': str(bundle), 'base_script': str(research.__file__),
              'fixtures': 'Synthetic metadata/HTML/Atom responses; no real document bodies or answers.',
              'cases': reports}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': 'passed', 'cases': len(reports), 'output': str(args.output)}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
