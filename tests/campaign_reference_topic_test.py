"""Keep academic topic leads readable without treating modifiers as verified."""
import unittest

from campaign_reference_test import adapter, research_double


QUERY = 'Euclidean Ramsey quadratic independence spherical configuration monomials'
PAPERS = [
    {'url': 'https://www.cs.umd.edu/~gasarch/TOPICS/ERT/GrahamTopics.pdf',
     'title': 'Topics in Euclidean Ramsey Theory - Ronald L. Graham',
     'snippet': 'A configuration C will then be called sphere-Ramsey.',
     'engine': 'anysearch', 'source_type': 'primary_or_academic'},
    {'url': 'https://fanchung.ucsd.edu/ron/papers/73_02_euclidean_ramsey_i.pdf',
     'title': 'Euclidean Ramsey Theorems. I',
     'snippet': 'We say that a configuration is sphere-Ramsey.',
     'engine': 'anysearch', 'source_type': 'primary_or_academic'},
]


class TopicTests(unittest.TestCase):
    def test_observed_foundational_papers_are_background_not_exact_or_irrelevant(self):
        for row in PAPERS:
            card = adapter.relevance(row, QUERY)
            self.assertEqual(card['relevance'], 'background')
            self.assertIn('concept_not_matched', card['relevance_reasons'])
            self.assertIn('partial_topic_only', card['relevance_reasons'])
        unrelated = {**PAPERS[0], 'title': 'Ramsey theory of graphs', 'snippet': ''}
        self.assertEqual(adapter.relevance(unrelated, QUERY)['relevance'], 'low')
        ordinary_web = {**PAPERS[0], 'source_type': 'web'}
        self.assertEqual(adapter.relevance(ordinary_web, QUERY)['relevance'], 'low')

    def test_no_head_last_fallback_keeps_original_topic(self):
        plan = adapter.query_plan(QUERY)
        self.assertEqual(plan[0]['query'], QUERY.casefold())
        self.assertEqual(plan[-1], {'stage': 'topic-only', 'query': 'euclidean ramsey'})
        self.assertNotIn('independence spherical configuration', [row['query'] for row in plan])

    def test_two_background_sources_pause_automatic_search_but_remain_partial(self):
        research = research_double()
        research._academic_search_enabled = lambda: False
        research.mock_web = PAPERS
        adapter.install(research)
        result = research._search_base_execute(QUERY, 6, 'direct', None, None)
        public = research._public_leads(result)
        self.assertEqual(len(public['results']), 2)
        self.assertEqual(public['status'], 'partial')
        self.assertEqual({row['relevance'] for row in public['results']}, {'background'})
        self.assertIn('no_research_subject_match', public['recall_checks']['remaining_gaps'])
        self.assertIn('quadratic', public['recall_checks']['unmatched_query_terms'])
        self.assertTrue(public['recall_checks']['automatic_discovery_paused_for_reading'])
        self.assertEqual(research._recall_gaps(PAPERS, QUERY, 6), [])

    def test_one_document_aliases_and_explicit_objects_do_not_pause_discovery(self):
        research = research_double()
        adapter.install(research)
        self.assertTrue(research._recall_gaps(PAPERS[:1], QUERY, 6))
        self.assertTrue(research._recall_gaps([PAPERS[0], dict(PAPERS[0])], QUERY, 6))
        for query, target in [('"Euclidean Ramsey quadratic" spherical configuration', None),
                              (QUERY, 'quadratic independence')]:
            with self.subTest(query=query, target=target):
                self.assertTrue(research._recall_gaps(PAPERS, query, 6, target))
                self.assertTrue(all(adapter.relevance(row, query, target)['relevance'] != 'matching'
                                    for row in PAPERS))

    def test_held_topic_candidates_do_not_count_toward_reading_pause(self):
        research = research_double()
        research._campaign_reference_candidate_permitted = lambda row: row['url'] != PAPERS[1]['url']
        adapter.install(research)
        self.assertTrue(research._recall_gaps(PAPERS, QUERY, 6))


if __name__ == '__main__':
    unittest.main()
