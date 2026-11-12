"""Replay discovery efficiency through a real installed bundle, without network.

The long Brenier query was observed in a campaign worker on 2026-11-12. Every
result card, paper identifier and response body below is synthetic; they test
discovery behavior and do not claim that any paper proves the requested bound.
Run with the bundle's dependency-complete Python, --bundle and --output.
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
from urllib.parse import parse_qs, urlsplit


BRENIER_QUERY = ('stability of optimal transport maps L2 norm exponent one third '
                 'Wasserstein quantitative stability Brenier')
MIXED_QUERY = '"heat kernel" Gaussian lower bounds'
EMPTY_FEED = '<feed xmlns="http://www.w3.org/2005/Atom" />'


def synthetic_cards(topic):
    titles = ({'transport': [
        'Quantitative stability of optimal transport maps',
        'Stability estimates for optimal transport via Wasserstein bounds',
    ], 'kernel': [
        'Heat kernel estimates on compact manifolds',
        'Heat kernel expansions for geometric operators',
    ], 'variance': [
        'Variance estimates for random SAT hitting times',
        'Random SAT hitting time variance bounds',
    ]})[topic]
    return [
        {'url': f'https://arxiv.org/abs/2401.1234{index}v1', 'title': title,
         'snippet': 'Synthetic discovery fixture; proof text has not been read.',
         'engine': 'anysearch', 'source_type': 'primary_or_academic'}
        for index, title in enumerate(titles)
    ]


def atom_feed(cards):
    entries = ''.join(
        '<entry><id>' + escape(card['url']) + '</id><title>' + escape(card['title'])
        + '</title><summary>' + escape(card['snippet']) + '</summary></entry>'
        for card in cards)
    return '<feed xmlns="http://www.w3.org/2005/Atom">' + entries + '</feed>'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    sys.path.insert(0, str(bundle))
    spec = importlib.util.spec_from_file_location('efficiency_replay_policy',
                                                bundle / 'reference-search-policy.py')
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    unexpected_network = []

    def no_network(*args, **kwargs):
        unexpected_network.append('network attempted')
        raise AssertionError('network is disabled in discovery efficiency replay')

    socket.create_connection = no_network
    socket.socket.connect = no_network
    research = policy.load_research()
    research.base.requests.sessions.Session.send = no_network
    from campaign_reference import install
    install(research)
    policy.install_source_policy(research)
    provenance = json.loads((bundle / 'reference-source-provenance.json').read_text())
    held_cards = [dict(record['metadata'], url=record['identifiers'][0],
                       engine='anysearch', source_type='primary_or_academic')
                  for record in provenance['records'] if record['status'] == 'unverified'][:2]
    assert len(held_cards) == 2, 'replay needs the two observed held metadata records'

    cases = [
        {'name': 'brenier_direct_academic_first', 'query': BRENIER_QUERY,
         'provider': 'direct', 'topic': 'transport', 'academic_results': True},
        {'name': 'brenier_auto_anysearch_sufficient', 'query': BRENIER_QUERY,
         'provider': 'auto', 'topic': 'transport', 'anysearch_results': True},
        {'name': 'mixed_quoted_query_preserved', 'query': MIXED_QUERY,
         'provider': 'direct', 'topic': 'kernel', 'academic_results': True},
        {'name': 'unavailable_academic_web_fallback_and_error_recovery',
         'query': BRENIER_QUERY, 'provider': 'direct', 'topic': 'transport',
         'web_recovery': True},
        {'name': 'held_metadata_cannot_close_discovery',
         'query': 'variance of random SAT hitting time concentration bounds',
         'provider': 'auto', 'topic': 'variance', 'held_anysearch': True,
         'academic_results': True},
    ]
    reports = []
    for case in cases:
        with tempfile.TemporaryDirectory() as directory:
            os.environ.update(DEEP_RESEARCH_RUN_DIR=directory,
                              DEEP_RESEARCH_SOURCE_POLICY='mixed',
                              DRBENCH_ACADEMIC_SEARCH='1',
                              DRBENCH_PRACTITIONER_SEARCH='0')
            os.environ.pop('DRBENCH_RUN_DIR', None)
            cards = synthetic_cards(case['topic'])
            recovered_academic = [dict(card, url=f'https://arxiv.org/abs/2401.1234{index + 2}v1')
                                  for index, card in enumerate(cards)]
            recovered_web = [dict(card, url=f'https://arxiv.org/abs/2401.1234{index + 4}v1',
                                  engine='duckduckgo-html') for index, card in enumerate(cards)]
            calls = Counter()
            urls = []
            unexpected_providers = []
            recovering = {'enabled': False}

            def unexpected(name):
                unexpected_providers.append(name)
                raise AssertionError('unneeded provider: ' + name)

            def get(url):
                parsed = urlsplit(url)
                calls[parsed.netloc] += 1
                urls.append(url)
                if case.get('anysearch_results'):
                    return unexpected(parsed.netloc)
                if parsed.netloc == 'export.arxiv.org':
                    if case.get('web_recovery'):
                        if recovering['enabled']:
                            return atom_feed(recovered_academic), url
                        if calls[parsed.netloc] == 1:
                            raise TimeoutError('synthetic recorded primary arXiv timeout')
                    return atom_feed(cards) if case.get('academic_results') else EMPTY_FEED, url
                if parsed.netloc == 'api.openalex.org':
                    return json.dumps({'results': []}), url
                return unexpected(parsed.netloc)

            def anysearch(*args):
                calls['anysearch'] += 1
                if case.get('held_anysearch'):
                    return held_cards
                return cards if case.get('anysearch_results') else unexpected('anysearch')

            def duckduckgo(*args, **kwargs):
                calls['duckduckgo'] += 1
                if not case.get('web_recovery'):
                    return unexpected('duckduckgo')
                if not recovering['enabled']:
                    raise TimeoutError('synthetic recorded DuckDuckGo timeout')
                return recovered_web

            def bing(*args, **kwargs):
                calls['bing'] += 1
                if not case.get('web_recovery'):
                    return unexpected('bing')
                return [dict(card, engine='bing') for card in cards]

            research.base._get = get
            research._search_anysearch = anysearch
            research._duckduckgo = duckduckgo
            research.base._bing = bing
            research.base._so360 = lambda *args, **kwargs: unexpected('360')
            arguments = (case['query'], 6, None, None, None, case['provider'])
            first = research._ref_search(*arguments)
            assert not first['cache_hit'], case['name']
            assert len(first['results']) == 2, first
            assert len({row['ref'] for row in first['results']}) == 2, first
            assert all(row['relevance'] == 'matching' and not row['citable']
                       and row['evidence_status'] == 'unread_lead'
                       for row in first['results']), first
            assert not first['recall_checks']['remaining_gaps'], first
            assert first['recall_checks']['unmatched_query_terms'], first
            if case['topic'] == 'transport':
                assert 'exponent' in first['recall_checks']['unmatched_query_terms'], first
                assert 'brenier' in first['recall_checks']['unmatched_query_terms'], first

            if case.get('anysearch_results'):
                assert calls == Counter({'anysearch': 1}), calls
                assert not urls, urls
            elif case.get('academic_results'):
                expected_calls = Counter({'export.arxiv.org': 1, 'api.openalex.org': 1})
                if case.get('held_anysearch'):
                    expected_calls['anysearch'] = 1
                    assert first['unverified_source_count'] == 2, first
                    held_refs = {research._source_ref(card['url']) for card in held_cards}
                    assert held_refs.isdisjoint(research._load_refs()), first
                assert calls == expected_calls, calls
                assert first['discovery_diagnostics']['academic_recall']['fallback_requests'] == 0, first
                arxiv_url = next(url for url in urls if urlsplit(url).netloc == 'export.arxiv.org')
                openalex_url = next(url for url in urls if urlsplit(url).netloc == 'api.openalex.org')
                sent_arxiv = parse_qs(urlsplit(arxiv_url).query)['search_query'][0]
                sent_openalex = parse_qs(urlsplit(openalex_url).query)['q'][0]
                if case['query'] == BRENIER_QUERY:
                    expected_arxiv = ' AND '.join('all:' + term.casefold()
                                                  for term in BRENIER_QUERY.split())
                elif case['query'] == MIXED_QUERY:
                    expected_arxiv = 'all:"heat kernel" AND all:gaussian AND all:lower AND all:bounds'
                else:
                    expected_arxiv = ' AND '.join('all:' + term.casefold()
                                                  for term in case['query'].split())
                assert sent_arxiv == expected_arxiv, (sent_arxiv, expected_arxiv)
                assert sent_openalex == case['query'].casefold().replace('"', ''), sent_openalex
            else:
                assert calls['export.arxiv.org'] >= 1 and calls['api.openalex.org'] >= 1, calls
                assert calls['duckduckgo'] == 1 and calls['bing'] == 1, calls
                assert first['status'] == 'partial', first
                assert any(row['provider'] == 'duckduckgo' and row['status'] == 'error'
                           for row in first['provider_results']), first

            before_cache = calls.copy()
            cached = research._ref_search(*arguments)
            assert cached['cache_hit'] and calls == before_cache, (cached, calls)
            report = {'name': case['name'], 'query': case['query'], 'provider': case['provider'],
                      'first_calls': dict(calls), 'provider_urls': list(urls),
                      'candidate_count': len(first['results']), 'cache_reused_without_requests': True,
                      'unmatched_query_terms': first['recall_checks']['unmatched_query_terms'],
                      'all_candidates_unread_and_non_citable': True}
            if case.get('web_recovery'):
                recovering['enabled'] = True
                recovered = research._ref_search(*arguments, retry_failed=True)
                assert calls['duckduckgo'] == before_cache['duckduckgo'] + 1, calls
                assert calls['export.arxiv.org'] == before_cache['export.arxiv.org'] + 1, calls
                assert all(calls[name] == before_cache[name]
                           for name in ('api.openalex.org', 'bing')), calls
                assert recovered['recovery']['retried_requests'] == 2, recovered
                assert recovered['recovery']['deferred_new_requests'] == 0, recovered
                assert not recovered.get('provider_errors'), recovered
                expected_refs = {research._source_ref(card['url'])
                                 for card in cards + recovered_academic + recovered_web}
                assert {row['ref'] for row in recovered['results']} == expected_refs, recovered
                report.update(recovery=recovered['recovery'], after_recovery_calls=dict(calls))
            assert not unexpected_providers, unexpected_providers
            assert not unexpected_network, unexpected_network
            reports.append(report)

    result = {'network': 'disabled', 'models_invoked': False, 'base_script': str(policy.RESEARCH_SCRIPT),
              'fixture_provenance': {'query': 'Brenier worker query observed on 2026-11-12',
                                     'responses': 'synthetic cards and response bodies; not mathematical evidence',
                                     'held_records': 'metadata only from the installed provenance registry; bodies never read'},
              'cases': reports}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'output': str(args.output), 'cases': len(reports), 'network': 'disabled'}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
