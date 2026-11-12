"""Replay recovery across an academic-only background-discovery branch.

All result cards and response bodies are synthetic. No paper or model is read.
The actual installed bundle owns provider recovery, REF registration and cache.
"""
import argparse
from collections import Counter
from html import escape
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from urllib.parse import urlsplit


QUERY = 'quantitative stability Brenier optimal transport Wasserstein'


def cards(start, engine):
    return [{'url': f'https://arxiv.org/abs/2401.2500{index}v1',
             'title': f'Quantitative stability of optimal transport, synthetic note {index}',
             'snippet': 'Synthetic discovery metadata; omitted qualifiers require reading.',
             'engine': engine, 'source_type': 'primary_or_academic'}
            for index in range(start, start + 2)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    sys.path.insert(0, str(bundle))
    spec = importlib.util.spec_from_file_location('topic_recovery_replay_policy',
                                                bundle / 'reference-search-policy.py')
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    unexpected_network, unexpected_providers = [], []

    def no_network(*args, **kwargs):
        unexpected_network.append('network attempted')
        raise AssertionError('network disabled in topic recovery replay')

    socket.create_connection = no_network
    socket.socket.connect = no_network
    research = policy.load_research()
    research.base.requests.sessions.Session.send = no_network
    # Synthetic identifiers do not need DNS resolution to establish URL validity.
    research.base._url_ok = lambda url: url.startswith(('https://', 'http://'))
    from campaign_reference import install
    install(research)
    policy.install_source_policy(research)
    old_openalex, recovered_anysearch, recovered_arxiv = (
        cards(0, 'openalex'), cards(2, 'anysearch'), cards(4, 'arxiv'))
    calls = Counter()
    phase = {'recovering': False}

    def anysearch(*args):
        calls['anysearch'] += 1
        if not phase['recovering']:
            raise TimeoutError('synthetic initial AnySearch timeout')
        return recovered_anysearch

    def get(url):
        host = urlsplit(url).hostname
        calls[host] += 1
        if host == 'export.arxiv.org':
            if not phase['recovering']:
                raise TimeoutError('synthetic initial arXiv timeout')
            entries = ''.join('<entry><id>' + escape(card['url']) + '</id><title>'
                              + escape(card['title']) + '</title><summary>'
                              + escape(card['snippet']) + '</summary></entry>'
                              for card in recovered_arxiv)
            return '<feed xmlns="http://www.w3.org/2005/Atom">' + entries + '</feed>', url
        if host == 'api.openalex.org':
            return json.dumps({'results': [{'external_id': card['url'],
                                            'display_name': card['title'],
                                            'hint': card['snippet']}
                                           for card in old_openalex]}), url
        unexpected_providers.append(host)
        raise AssertionError('unexpected provider: ' + str(host))

    def no_web(name):
        def operation(*args, **kwargs):
            unexpected_providers.append(name)
            raise AssertionError('background reading should avoid ' + name)
        return operation

    research._search_anysearch = anysearch
    research.base._get = get
    research._duckduckgo = no_web('duckduckgo')
    research.base._bing = no_web('bing')
    research.base._so360 = no_web('360')
    with tempfile.TemporaryDirectory() as directory:
        os.environ.update(DEEP_RESEARCH_RUN_DIR=directory,
                          DEEP_RESEARCH_SOURCE_POLICY='mixed',
                          DRBENCH_ACADEMIC_SEARCH='1', DRBENCH_PRACTITIONER_SEARCH='0')
        os.environ.pop('DRBENCH_RUN_DIR', None)
        arguments = (QUERY, 6, None, None, None, 'auto')
        first = research._ref_search(*arguments)
        before_cache = calls.copy()
        first_cached = research._ref_search(*arguments)
        cached_without_requests = first_cached['cache_hit'] and calls == before_cache
        phase['recovering'] = True
        recovered = research._ref_search(*arguments, retry_failed=True)
        recovery_calls = calls - before_cache
        after_recovery = calls.copy()
        second_cached = research._ref_search(*arguments)
        recovered_cache_without_requests = second_cached['cache_hit'] and calls == after_recovery
        expected_refs = {research._source_ref(card['url'])
                         for card in old_openalex + recovered_anysearch + recovered_arxiv}
        actual_refs = {card['ref'] for card in recovered['results']}
        request = {'query': QUERY, 'limit': 6, 'target': None, 'artifact': None,
                   'proof': None, 'provider': 'auto'}
        saved = research.workspace.load_search(request)['result']
        academic_records = [row for row in saved['provider_execution']['records']
                            if row['provider'] in ('arxiv', 'openalex')]
        checks = {
            'first_branch_has_no_web_requests': not unexpected_providers,
            'first_branch_uses_only_anysearch_and_two_academic_requests':
                before_cache == Counter({'anysearch': 1, 'export.arxiv.org': 1, 'api.openalex.org': 1}),
            'first_result_keeps_two_background_sources':
                len(first['results']) == 2 and all(card['relevance'] == 'background'
                                                  for card in first['results']),
            'initial_cache_reused_without_requests': cached_without_requests,
            'only_old_two_failed_requests_retried':
                recovery_calls == Counter({'anysearch': 1, 'export.arxiv.org': 1}) and
                recovered['recovery']['retried_requests'] == 2,
            'no_new_requests_deferred': recovered['recovery']['deferred_new_requests'] == 0,
            'all_six_old_and_recovered_sources_are_public': actual_refs == expected_refs,
            'recovery_has_no_remaining_provider_errors': not recovered.get('provider_errors'),
            'recovered_cache_reused_without_requests': recovered_cache_without_requests,
            'all_candidates_remain_unread_and_non_citable': all(
                card['evidence_status'] == 'unread_lead' and not card['citable']
                for card in recovered['results']),
            'network_not_attempted': not unexpected_network,
        }
        report = {
            'status': 'passed' if all(checks.values()) else 'failed',
            'network': 'disabled', 'models_invoked': False,
            'base_script': str(policy.RESEARCH_SCRIPT), 'query': QUERY,
            'fixture_provenance': 'Synthetic provider failures, result cards and response bodies.',
            'checks': checks, 'first_calls': dict(before_cache),
            'recovery_calls': dict(recovery_calls), 'recovery': recovered['recovery'],
            'first_provider_outcomes': first['provider_results'],
            'recovered_source_count': len(actual_refs),
            'expected_source_count': len(expected_refs),
            'missing_refs': sorted(expected_refs - actual_refs),
            'recovered_academic_records': academic_records,
            'unexpected_providers': unexpected_providers,
        }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'output': str(args.output),
                      'source_count': report['recovered_source_count'],
                      'failed_checks': [name for name, ok in checks.items() if not ok]}))
    return 0 if all(checks.values()) else 1


if __name__ == '__main__':
    raise SystemExit(main())
