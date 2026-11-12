"""Provider errors must remain retryable failures, not empty or successful leads."""
import unittest

from campaign_reference_test import adapter, research_double


ERROR_FEED = '''<feed xmlns="http://www.w3.org/2005/Atom"><entry>
<id>http://arxiv.org/api/errors#incorrect_id_format_for_x</id><title>Error</title>
<summary>incorrect id format for x</summary></entry></feed>'''


class AcademicProviderErrorsTests(unittest.TestCase):
    def test_arxiv_service_error_feed_is_a_provider_error(self):
        research = research_double()
        research.base._get = lambda url: (ERROR_FEED, url)
        adapter.install(research)
        outcomes = []
        cards = research._call_provider('arxiv', lambda: research._arxiv('heat kernel', 2),
                                        outcomes, request={'query': 'heat kernel', 'limit': 2})
        self.assertEqual(cards, [])
        self.assertEqual(outcomes[0]['status'], 'error')
        self.assertIn('incorrect id format', outcomes[0]['error'])

    def test_empty_feed_stays_empty_and_a_paper_titled_error_stays_a_paper(self):
        research = research_double()
        adapter.install(research)
        for feed, status in [('<feed xmlns="http://www.w3.org/2005/Atom"/>', 'empty'),
                             (ERROR_FEED.replace('http://arxiv.org/api/errors#incorrect_id_format_for_x',
                                                 'https://arxiv.org/abs/2401.12345v1'), 'ok')]:
            with self.subTest(status=status):
                research.base._get = lambda url, feed=feed: (feed, url)
                outcomes = []
                research._call_provider('arxiv', lambda: research._arxiv('heat kernel', 2),
                                        outcomes, request={'query': 'heat kernel', 'limit': 2})
                self.assertEqual(outcomes[0]['status'], status)


if __name__ == '__main__':
    unittest.main()
