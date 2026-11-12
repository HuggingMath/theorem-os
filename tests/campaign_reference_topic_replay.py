"""Replay topic discovery against an installed bundle with all network disabled.

QUERY and the two PDF cards are metadata observed in the Euclidean Ramsey
worker's 2026-11-12 search event. No paper body or answer source is loaded.
Other provider responses and the test-local held classification are synthetic.
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
from urllib.parse import urlsplit


QUERY = 'Euclidean Ramsey quadratic independence spherical configuration monomials'
OBSERVED_CARDS = [
    {'title': 'Topics in Euclidean Ramsey Theory - Ronald L. Graham',
     'url': 'https://www.cs.umd.edu/~gasarch/TOPICS/ERT/GrahamTopics.pdf',
     'snippet': '- by RL Graham · Cited by 21 — A configuration C will then be called sphere-Ramsey if for any r, there is an. N = N(C,r) such that in any r-coloring of SN there is always a monochromatic.',
     'engine': 'anysearch', 'source_type': 'primary_or_academic'},
    {'title': 'Euclidean Ramsey Theorems. I',
     'url': 'https://fanchung.ucsd.edu/ron/papers/73_02_euclidean_ramsey_i.pdf',
     'snippet': '- by P MONTGOMERY · 1973 · Cited by 208 — We say that a configuration is sphere-Ramsey if for each r there is an integer IZ and a real number d such that every r-coloring of a sphere S of dimension at ...',
     'engine': 'anysearch', 'source_type': 'primary_or_academic'},
]


def synthetic_matches():
    return [
        {'url': f'https://arxiv.org/abs/2401.1234{index}v1',
         'title': f'Euclidean Ramsey quadratic independence spherical configuration monomials {index}',
         'snippet': 'Synthetic metadata fixture. Its proof text has not been read.'}
        for index in range(2)
    ]


def atom_feed(cards):
    entries = ''.join('<entry><id>' + escape(card['url']) + '</id><title>'
                      + escape(card['title']) + '</title><summary>'
                      + escape(card['snippet']) + '</summary></entry>' for card in cards)
    return '<feed xmlns="http://www.w3.org/2005/Atom">' + entries + '</feed>'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    sys.path.insert(0, str(bundle))
    spec = importlib.util.spec_from_file_location('topic_replay_policy',
                                                bundle / 'reference-search-policy.py')
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    network_attempts = []

    def no_network(*args, **kwargs):
        network_attempts.append('attempted')
        raise AssertionError('network is disabled in topic replay')

    socket.create_connection = no_network
    socket.socket.connect = no_network
    research = policy.load_research()
    research.base.requests.sessions.Session.send = no_network
    import campaign_reference as adapter
    adapter.install(research)
    policy.install_source_policy(research)
    baseline_provenance = list(policy.SOURCE_PROVENANCE)

    # Verify the plan through the actual installed adapter, not a local double.
    plan = adapter.query_plan(QUERY)
    assert plan[0]['query'] == QUERY.casefold(), plan
    assert plan[-1] == {'stage': 'topic-only', 'query': 'euclidean ramsey'}, plan
    assert all(row['query'] != 'independence spherical configuration' for row in plan), plan
    for card in OBSERVED_CARDS:
        labelled = adapter.relevance(card, QUERY)
        assert labelled['relevance'] == 'background', labelled
        assert 'partial_topic_only' in labelled['relevance_reasons'], labelled
        assert adapter.relevance(card, '"Euclidean Ramsey quadratic" independence')['relevance'] == 'low'
        assert adapter.relevance(card, QUERY, 'quadratic independence')['relevance'] != 'matching'
    # A merely overlapping web card is not promoted to academic background.
    assert adapter.relevance(dict(OBSERVED_CARDS[0], source_type='web'), QUERY)['relevance'] == 'low'

    alias_cards = [dict(OBSERVED_CARDS[0], url='https://arxiv.org/abs/2401.55555v1'),
                   dict(OBSERVED_CARDS[0], url='https://arxiv.org/pdf/2401.55555v1')]
    cases = [
        {'name': 'two_observed_backgrounds_pause_for_reading', 'query': QUERY,
         'cards': OBSERVED_CARDS, 'pause_before_academic': True},
        {'name': 'one_observed_background_continues_academic', 'query': QUERY,
         'cards': OBSERVED_CARDS[:1]},
        {'name': 'explicit_phrase_is_not_relaxed',
         'query': '"Euclidean Ramsey quadratic" independence spherical configuration monomials',
         'cards': OBSERVED_CARDS},
        {'name': 'explicit_target_is_not_relaxed', 'query': QUERY,
         'target': 'quadratic independence', 'cards': OBSERVED_CARDS},
        {'name': 'same_document_aliases_cannot_pause', 'query': QUERY,
         'cards': alias_cards},
        {'name': 'held_topic_card_cannot_pause', 'query': QUERY,
         'cards': OBSERVED_CARDS, 'synthetic_held': OBSERVED_CARDS[0]['url']},
    ]
    reports = []
    for case in cases:
        with tempfile.TemporaryDirectory() as directory:
            os.environ.update(DEEP_RESEARCH_RUN_DIR=directory,
                              DEEP_RESEARCH_SOURCE_POLICY='mixed',
                              DRBENCH_ACADEMIC_SEARCH='1', DRBENCH_PRACTITIONER_SEARCH='0')
            os.environ.pop('DRBENCH_RUN_DIR', None)
            policy.SOURCE_PROVENANCE = list(baseline_provenance)
            if case.get('synthetic_held'):
                # Test-local metadata only: this does not classify the real paper.
                policy.SOURCE_PROVENANCE.append({
                    'id': 'synthetic-topic-replay-held', 'status': 'unverified',
                    '_identifiers': policy.source_identifiers(case['synthetic_held'])})
            calls = Counter()
            urls = []
            unexpected = []

            def unexpected_provider(name):
                unexpected.append(name)
                raise AssertionError('unneeded provider: ' + name)

            def anysearch(*args):
                calls['anysearch'] += 1
                return [dict(card) for card in case['cards']]

            def get(url):
                host = urlsplit(url).netloc
                calls[host] += 1
                urls.append(url)
                if case.get('pause_before_academic'):
                    return unexpected_provider(host)
                if host == 'export.arxiv.org':
                    return atom_feed(synthetic_matches()), url
                if host == 'api.openalex.org':
                    return json.dumps({'results': []}), url
                return unexpected_provider(host)

            research._search_anysearch = anysearch
            research.base._get = get
            research._duckduckgo = lambda *args, **kwargs: unexpected_provider('duckduckgo')
            research.base._bing = lambda *args, **kwargs: unexpected_provider('bing')
            research.base._so360 = lambda *args, **kwargs: unexpected_provider('360')
            # The public CLI requires target, artifact and proof together.
            artifact = 'paper' if case.get('target') else None
            proof = 'Verify the quadratic independence hypothesis in proof text.' if artifact else None
            arguments = (case['query'], 6, case.get('target'), artifact, proof, 'auto')
            first = research._ref_search(*arguments)
            assert not first['cache_hit'], first
            assert first['results'], first
            assert all(row['evidence_status'] == 'unread_lead' and not row['citable']
                       for row in first['results']), first
            if case.get('pause_before_academic'):
                assert calls == Counter({'anysearch': 1}), calls
                assert len(first['results']) == 2, first
                assert all(row['relevance'] == 'background'
                           and 'partial_topic_only' in row['relevance_reasons']
                           for row in first['results']), first
                assert first['status'] == 'partial', first
                assert first['recall_checks']['remaining_gaps'], first
                assert first['recall_checks']['automatic_discovery_paused_for_reading'] is True, first
                assert 'quadratic' in first['recall_checks']['unmatched_query_terms'], first
                assert 'monomials' in first['recall_checks']['unmatched_query_terms'], first
            else:
                assert calls == Counter({'anysearch': 1, 'export.arxiv.org': 1,
                                         'api.openalex.org': 1}), calls
                assert sum(row['relevance'] == 'matching' for row in first['results']) == 2, first
                assert first['discovery_diagnostics']['academic_recall']['fallback_requests'] == 0, first
                if case.get('synthetic_held'):
                    held_ref = research._source_ref(case['synthetic_held'])
                    assert held_ref not in research._load_refs(), first
                    assert first['unverified_source_count'] == 1, first
            expected_readable_refs = {row['ref'] for row in first['results']
                                      + first.get('low_relevance_results', [])}
            assert set(research._load_refs()) == expected_readable_refs, first
            before_cache = calls.copy()
            cached = research._ref_search(*arguments)
            assert cached['cache_hit'] and calls == before_cache, (cached, calls)
            os.environ['DEEP_RESEARCH_SOURCE_POLICY'] = 'local_only'
            local_cached = research._ref_search(*arguments)
            assert local_cached['cache_hit'] and calls == before_cache, (local_cached, calls)
            try:
                research._ref_search(case['query'] + ' uncached', 6, case.get('target'), artifact, proof, 'auto')
            except RuntimeError as error:
                assert 'local_only' in str(error), error
            else:
                raise AssertionError('local_only permitted a new network discovery')
            assert calls == before_cache and not unexpected and not network_attempts, (calls, unexpected)
            reports.append({
                'name': case['name'], 'query': case['query'], 'target': case.get('target'),
                'calls': dict(calls), 'provider_urls': urls,
                'result_levels': [row['relevance'] for row in first['results']],
                'status': first['status'], 'recall_checks': first['recall_checks'],
                'cache_reused_without_requests': True, 'local_only_cache_and_blocking': True,
                'all_results_unread_and_non_citable': True,
                'held_source_never_registered': bool(case.get('synthetic_held')),
            })
    policy.SOURCE_PROVENANCE = baseline_provenance
    result = {'network': 'disabled', 'models_invoked': False,
              'base_script': str(policy.RESEARCH_SCRIPT), 'topic_query_plan': plan,
              'fixture_provenance': {
                  'core_cards': 'Two metadata-only PDF cards observed in the Euclidean Ramsey worker search event on 2026-11-12.',
                  'other_responses': 'Synthetic metadata/Atom feed; no body or answer text is loaded.',
                  'held_case': 'Synthetic test-local provenance status; not a claim about the real paper.'},
              'cases': reports}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'output': str(args.output), 'cases': len(reports), 'network': 'disabled'}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
