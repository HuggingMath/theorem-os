"""HTML follow adaptation delegates validation to the existing graph parser."""
import unittest
from unittest.mock import Mock

from campaign_reference_test import adapter, research_double


class HtmlFollowTests(unittest.TestCase):
    def research(self, **parser_kwargs):
        research = research_double()
        parser = Mock(return_value='parsed', **parser_kwargs)
        research.citation_graph.paper_id = parser
        adapter.install(research)
        return research, parser

    def test_recognized_html_urls_preserve_their_explicit_version(self):
        for source, canonical in [
            ('https://arxiv.org/html/2401.27123v3#proof', 'https://arxiv.org/abs/2401.27123v3'),
            ('https://www.arxiv.org/html/2401.27123', 'https://arxiv.org/abs/2401.27123'),
            ('https://export.arxiv.org/html/math.AG/0309136v2', 'https://arxiv.org/abs/math.AG/0309136v2'),
        ]:
            with self.subTest(source=source):
                research, parser = self.research()
                self.assertEqual(research.citation_graph.paper_id(source), 'parsed')
                parser.assert_called_once_with(canonical)

    def test_existing_identifiers_and_invalid_urls_reach_the_original_parser(self):
        for source in ['https://arxiv.org/abs/2401.27123v3', 'https://arxiv.org/pdf/2401.27123v3',
                       'DOI:10.5555/general-note', 'ARXIV:2401.27123v3',
                       'https://doi.org/10.5555/general-note',
                       'https://arxiv.org/html/not-a-paper',
                       'https://arxiv.org.example/html/2401.27123v3']:
            with self.subTest(source=source):
                research, parser = self.research()
                research.citation_graph.paper_id(source)
                parser.assert_called_once_with(source)

    def test_parser_rejections_are_preserved(self):
        research, parser = self.research(side_effect=ValueError('unsupported paper identifier'))
        with self.assertRaisesRegex(ValueError, 'unsupported paper identifier'):
            research.citation_graph.paper_id('https://arxiv.org/html/not-a-paper')


if __name__ == '__main__':
    unittest.main()
