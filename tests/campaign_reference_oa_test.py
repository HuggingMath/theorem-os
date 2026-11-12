"""Known arXiv open-access locations must reach the same document's body."""
import json
import os
import unittest
from unittest.mock import Mock, patch

from campaign_reference_reader_test import reader_double


DOI = 'https://doi.org/10.1000/fixture'
ABS = 'https://arxiv.org/abs/2401.12345v2'
PDF = 'https://arxiv.org/pdf/2401.12345v2'
HTML = 'https://arxiv.org/html/2401.12345v2'


def metadata(reader, urls):
    reader.base._get.return_value = (json.dumps({'display_name': 'Synthetic paper',
        'abstract': 'Metadata summary only',
        'locations': [{'is_oa': True, 'landing_page_url': url} for url in urls]}),
        'https://api.openalex.org/works/W123')


class OpenAccessArxivTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {'DEEP_RESEARCH_SOURCE_POLICY': 'mixed'})
        environment.start()
        self.addCleanup(environment.stop)

    def test_doi_arxiv_landing_page_tries_pdf_then_same_version_html(self):
        _, reader = reader_double()
        metadata(reader, [ABS])
        reader._fetch_bytes.side_effect = [RuntimeError('PDF unavailable'),
                                          (b'Same-version proof body', HTML, 'text/html')]
        result = reader.read_page(DOI, ['proof'], include_body=True)
        self.assertEqual([call.args[0] for call in reader._fetch_bytes.call_args_list], [PDF, HTML])
        self.assertEqual(result['content_scope'], 'full_text')
        self.assertEqual(result['_body'], 'Same-version proof body')
        self.assertEqual(result['resolved_url'], HTML)
        self.assertEqual(result['url'], DOI)
        self.assertEqual(result['failed_attempts'], 1)
        reader.base._reserve.assert_called_once_with('read')

    def test_doi_arxiv_candidate_rejects_a_redirect_to_another_version(self):
        _, reader = reader_double()
        metadata(reader, [ABS])
        reader._pdf_text = Mock(return_value=('Wrong paper', 'Rejected body'))
        reader._fetch_bytes.side_effect = [
            (b'%PDF wrong version', 'https://arxiv.org/pdf/2401.12345v3', 'application/pdf'),
            (b'Version two proof only', HTML, 'text/html')]
        result = reader.read_page(DOI, ['proof'], include_body=True)
        self.assertEqual(result['_body'], 'Version two proof only')
        self.assertEqual(result['failed_attempts'], 1)
        self.assertIn('arxiv_source_identity_mismatch', result['academic_read_attempts'][1]['error'])
        reader._pdf_text.assert_not_called()

    def test_wrong_documents_are_rejected_and_original_abstract_is_still_available(self):
        _, reader = reader_double()
        metadata(reader, [ABS])
        reader._fetch_bytes.side_effect = [
            (b'%PDF wrong document', 'https://arxiv.org/pdf/2401.54321v2', 'application/pdf'),
            (b'Wrong HTML document', 'https://arxiv.org/html/2401.54321v2', 'text/html'),
            RuntimeError('Publisher unavailable'),
            (b'Correct arXiv abstract only', ABS, 'text/html')]
        result = reader.read_page(DOI, ['proof'], include_body=True)
        self.assertEqual([call.args[0] for call in reader._fetch_bytes.call_args_list], [PDF, HTML, DOI, ABS])
        self.assertEqual(result['content_scope'], 'abstract')
        self.assertTrue(result['full_text_unavailable'])
        self.assertEqual(result['_body'], 'Correct arXiv abstract only')
        self.assertEqual(result['failed_attempts'], 3)
        self.assertEqual(sum('arxiv_source_identity_mismatch' in row.get('error', '')
                             for row in result['academic_read_attempts']), 2)

    def test_second_explicit_location_precedes_abstract_and_third_is_not_used(self):
        _, reader = reader_double()
        second = 'https://repository.example/explicit-proof.pdf'
        metadata(reader, [ABS, second, 'https://ignored.example/third.pdf'])
        reader._fetch_bytes.side_effect = [RuntimeError('PDF unavailable'), RuntimeError('HTML unavailable'),
                                          (b'%PDF second source proof', second, 'application/pdf')]
        result = reader.read_page(DOI, ['proof'])
        self.assertEqual([call.args[0] for call in reader._fetch_bytes.call_args_list], [PDF, HTML, second])
        self.assertEqual(result['content_scope'], 'full_text')

    def test_two_arxiv_locations_have_a_bounded_deduplicated_fallback_order(self):
        _, reader = reader_double()
        second_abs = 'https://arxiv.org/abs/2401.54321v1'
        metadata(reader, [ABS, second_abs, 'https://ignored.example/third.pdf'])
        reader._fetch_bytes.side_effect = RuntimeError('Fixture unavailable')
        result = reader.read_page(DOI, [], include_body=True)
        calls = [call.args[0] for call in reader._fetch_bytes.call_args_list]
        self.assertEqual(calls, [PDF, HTML, 'https://arxiv.org/pdf/2401.54321v1',
                                'https://arxiv.org/html/2401.54321v1', DOI, ABS, second_abs])
        self.assertEqual(len(calls), 7)
        self.assertEqual(result['_body'], 'Metadata summary only')
        self.assertEqual(result['content_scope'], 'abstract')

    def test_abs_pdf_aliases_do_not_retry_the_same_arxiv_representation(self):
        _, reader = reader_double()
        metadata(reader, [ABS, PDF + '.pdf'])
        reader._fetch_bytes.side_effect = RuntimeError('Fixture unavailable')
        result = reader.read_page(DOI, [])
        self.assertEqual([call.args[0] for call in reader._fetch_bytes.call_args_list], [PDF, HTML, DOI, ABS])
        self.assertEqual(result['failed_attempts'], 4)

    def test_openalex_work_with_explicit_arxiv_html_uses_it_first(self):
        _, reader = reader_double()
        metadata(reader, [HTML])
        reader._fetch_bytes.return_value = (b'Explicit HTML proof', HTML, 'text/html')
        result = reader.read_page('https://openalex.org/W123', [], include_body=True)
        reader._fetch_bytes.assert_called_once_with(HTML)
        self.assertEqual(result['content_scope'], 'full_text')

    def test_unversioned_arxiv_location_can_resolve_to_a_concrete_version(self):
        _, reader = reader_double()
        metadata(reader, ['https://arxiv.org/abs/2401.12345'])
        reader._fetch_bytes.return_value = (b'%PDF known document', PDF, 'application/pdf')
        result = reader.read_page(DOI, [])
        reader._fetch_bytes.assert_called_once_with('https://arxiv.org/pdf/2401.12345')
        self.assertEqual(result['failed_attempts'], 0)
        self.assertEqual(result['content_scope'], 'full_text')

    def test_arbitrary_publisher_urls_are_not_expanded(self):
        _, reader = reader_double()
        explicit = 'https://author.example/article'
        metadata(reader, [explicit])
        reader._fetch_bytes.side_effect = RuntimeError('Fixture unavailable')
        result = reader.read_page(DOI, [])
        self.assertEqual([call.args[0] for call in reader._fetch_bytes.call_args_list], [explicit, DOI])
        self.assertEqual(result['content_scope'], 'abstract')


if __name__ == '__main__':
    unittest.main()
