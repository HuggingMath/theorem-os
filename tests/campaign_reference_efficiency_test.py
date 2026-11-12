"""Regression cases for observed query loss and unnecessary discovery work."""
import json
import unittest
from urllib.parse import parse_qs, urlsplit

from campaign_reference_test import EMPTY, adapter, research_double


OBSERVED_QUERY = ('stability of optimal transport maps L2 norm exponent one third '
                  'Wasserstein quantitative stability Brenier')


def paper(identifier, title):
    return {'url': 'https://arxiv.org/abs/' + identifier, 'title': title,
            'snippet': '', 'engine': 'arxiv', 'source_type': 'primary_or_academic'}


class DiscoveryEfficiencyTests(unittest.TestCase):
    def test_initial_arxiv_request_keeps_unquoted_constraints_without_inventing_phrases(self):
        for query in (OBSERVED_QUERY, 'Brenier optimal transport regularity Monge Ampere equation',
                      'heat kernel Gaussian lower bounds'):
            with self.subTest(query=query):
                encoded = adapter.arxiv_query(query)
                for word in query.casefold().split():
                    self.assertIn('all:' + word, encoded)
                self.assertNotIn('"', encoded)
                self.assertEqual(adapter.query_plan(query)[0]['query'], query.casefold())

    def test_initial_openalex_request_keeps_mixed_quoted_and_unquoted_constraints(self):
        research = research_double()
        urls = []
        research.base._get = lambda url: (urls.append(url) or '{"results": []}', url)
        adapter.install(research)
        research._openalex_exact('"heat kernel" Gaussian lower bounds', 3)
        self.assertEqual(parse_qs(urlsplit(urls[0]).query)['q'],
                         ['heat kernel gaussian lower bounds'])

    def test_explicit_phrases_and_target_all_constrain_relevance(self):
        query = '"heat kernel" "lower bounds" "Gaussian" "compact" "manifold"'
        encoded = adapter.arxiv_query(query)
        self.assertIn('all:"manifold"', encoded)
        card = paper('2401.12345', 'Gaussian heat kernel lower bounds on compact spaces')
        self.assertNotEqual(adapter.relevance(card, query)['relevance'], 'matching')
        target = 'finite dimensional normed spaces with an unconditional basis'
        plan = adapter.query_plan('"projection constants" upper bounds', target)
        self.assertIn('upper bounds', plan[0]['query'])
        self.assertIn('"' + target + '"', plan[0]['query'])

    def test_guessed_subject_cannot_promote_unrelated_control_over_transport(self):
        research = research_double()
        adapter.install(research)
        unrelated = paper('2401.12345', 'Stability in optimal control with maps in L2 norm')
        relevant = paper('2401.12346', 'Stability of optimal transport via Wasserstein estimates for Brenier maps')
        ranked = research._rank_discovery([unrelated, relevant], OBSERVED_QUERY, 2)
        self.assertEqual(ranked[0]['url'], relevant['url'])
        self.assertEqual(ranked[0]['relevance'], 'matching')
        self.assertNotEqual(ranked[1]['relevance'], 'matching')

    def test_sufficient_candidates_prompt_reading_instead_of_more_modifier_searches(self):
        research = research_double()
        research._academic_search_enabled = lambda: False
        research.mock_web = [
            paper('2401.12345', 'Heat kernel estimates on compact manifolds'),
            paper('2401.12346', 'Heat kernel estimates for compact domains'),
        ]
        adapter.install(research)
        query = 'heat kernel estimates compact Gaussian lower bounds constants'
        public = research._public_leads(research._search_base_execute(query, 5, 'direct', None, None))
        self.assertEqual(public['recall_checks']['remaining_gaps'], [])
        self.assertIn('gaussian', public['recall_checks']['unmatched_query_terms'])
        self.assertIn('lower', public['recall_checks']['unmatched_query_terms'])

    def test_missing_explicit_target_and_single_document_still_need_discovery(self):
        research = research_double()
        adapter.install(research)
        card = paper('2401.12345v1', 'Heat kernel estimates on compact manifolds')
        alias = {**card, 'url': 'https://arxiv.org/pdf/2401.12345v1'}
        self.assertIn('too_few_distinct_documents', research._recall_gaps([card, alias], 'heat kernel estimates', 5))
        other = paper('2401.12346', 'Heat kernel estimates for compact domains')
        self.assertIn('no_research_subject_match', research._recall_gaps(
            [card, other], 'heat kernel estimates', 5, 'noncompact hyperbolic manifold'))

    def test_recovered_academic_candidates_survive_sufficient_primary_results(self):
        query = 'heat kernel gaussian lower bounds'
        primary = [paper(f'2401.1234{i}v1', f'Heat kernel estimates primary {i}') for i in range(2)]
        for recovered in (('arxiv',), ('openalex',), ('arxiv', 'openalex')):
            with self.subTest(recovered=recovered):
                research = research_double()
                calls = []
                saved = {provider: [paper(f'2401.{prefix}{i}v1', f'Heat kernel estimates recovered {provider} {i}')
                                    for i in range(2)]
                         for provider, prefix in (('arxiv', '3334'), ('openalex', '4444'))}

                def call(provider, operation, outcomes, *, request):
                    calls.append((provider, request['query']))
                    if request['query'] == query:
                        return primary if provider == 'arxiv' else []
                    self.assertEqual(request['query'], 'heat kernel')
                    self.assertIn(provider, recovered)
                    return saved[provider]

                research._call_provider = call
                research._recovery_has = lambda provider, request=None: (
                    provider in recovered and request is not None and request['query'] == 'heat kernel')
                adapter.install(research)
                result = research._search_base_execute(query, 6, 'direct', None, None)
                expected = primary + [card for provider in recovered for card in saved[provider]]
                self.assertEqual({card['url'] for card in result['results']},
                                 {card['url'] for card in expected})
                self.assertEqual(calls, [('arxiv', query), ('openalex', query)] +
                                 [(provider, 'heat kernel') for provider in recovered])


if __name__ == '__main__':
    unittest.main()
