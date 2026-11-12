"""Academic document reading with local fixtures and no network or models."""
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/mathematics/reference-search'))
import academic_read


def reader_double():
    base = SimpleNamespace(_reserve=Mock(), _record_event=Mock(),
        _clean=lambda text, limit: ' '.join(text.split())[:limit], _get=Mock(return_value=('{}', 'https://api.openalex.org/works/W123')))
    reader = SimpleNamespace(base=base, read_page=Mock(return_value={'original': True}), MAX_TEXT_CHARS=20_000,
        _openalex_id_from_url=lambda url: 'W123' if url == 'https://openalex.org/W123' else None,
        _doi_from_url=lambda url: '10.1000/fixture' if url.startswith('https://doi.org/') else None,
        _abstract=lambda row: row.get('abstract', ''), _normalise_text=lambda text: text,
        _fetch_bytes=Mock(), _pdf_text=lambda raw, details: ('Paper', 'Full PDF proof'),
        _document_text=lambda text: text, _html_text=lambda raw, encoding, **kwargs: ('Paper', raw.decode()),
        _soft_error_page=lambda title, text: False, _content_shell=lambda title, text: False,
        _source_type=lambda url: 'primary_or_academic', _windows=lambda text, *args: [text])
    research = SimpleNamespace(v1=reader)
    academic_read.install(research)
    return research, reader


class AcademicReaderTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {'DEEP_RESEARCH_SOURCE_POLICY': 'mixed'})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_doi_metadata_abstract_no_longer_short_circuits_available_proof(self):
        _, reader = reader_double()
        reader.base._get.return_value = (json.dumps({'display_name': 'Paper', 'abstract': 'Only a summary'}), 'https://api.openalex.org/works/W123')
        reader._fetch_bytes.return_value = (b'Full publisher proof', 'https://publisher.example/paper', 'text/html')
        result = reader.read_page('https://doi.org/10.1000/fixture', ['proof'], include_body=True)
        reader._fetch_bytes.assert_called_once_with('https://doi.org/10.1000/fixture')
        self.assertEqual(result['content_scope'], 'page_text')
        self.assertEqual(result['_body'], 'Full publisher proof')
        reader.base._reserve.assert_called_once_with('read')

    def test_arxiv_failed_pdf_tries_same_version_html_before_abstract(self):
        _, reader = reader_double()
        reader._fetch_bytes.side_effect = [RuntimeError('PDF timeout'), (b'HTML proof', 'https://arxiv.org/html/2401.12345v2', 'text/html')]
        result = reader.read_page('https://arxiv.org/abs/2401.12345v2', ['proof'])
        self.assertEqual([call.args[0] for call in reader._fetch_bytes.call_args_list],
            ['https://arxiv.org/pdf/2401.12345v2', 'https://arxiv.org/html/2401.12345v2'])
        self.assertEqual(result['content_scope'], 'full_text')
        self.assertEqual(result['failed_attempts'], 1)
        self.assertEqual(result['fallback'], 'arxiv_html')
        self.assertNotIn('_body', result)
        reader.base._reserve.assert_called_once_with('read')

    def test_explicit_arxiv_html_is_fetched_first(self):
        _, reader = reader_double()
        reader._fetch_bytes.return_value = (b'HTML proof', 'https://arxiv.org/html/2401.12345v3', 'text/html')
        result = reader.read_page('https://arxiv.org/html/2401.12345v3', ['proof'])
        reader._fetch_bytes.assert_called_once_with('https://arxiv.org/html/2401.12345v3')
        self.assertEqual(result['content_scope'], 'full_text')
        reader.base._get.assert_not_called()

    def test_arxiv_doi_alias_preserves_explicit_version_without_metadata_lookup(self):
        _, reader = reader_double()
        reader._fetch_bytes.return_value = (b'%PDF fixture', 'https://arxiv.org/pdf/2401.12345v1', 'application/pdf')
        result = reader.read_page('https://doi.org/10.48550/arXiv.2401.12345v1', [])
        reader._fetch_bytes.assert_called_once_with('https://arxiv.org/pdf/2401.12345v1')
        reader.base._get.assert_not_called()
        self.assertEqual(result['content_scope'], 'full_text')

    def test_abs_fallback_is_abstract_and_retains_failed_attempts(self):
        _, reader = reader_double()
        reader._fetch_bytes.side_effect = [RuntimeError('PDF unavailable'), RuntimeError('HTML unavailable'),
            (b'Abstract summary', 'https://arxiv.org/abs/math/0301234v2', 'text/html')]
        result = reader.read_page('https://arxiv.org/abs/math/0301234v2', [], include_body=True)
        self.assertEqual(result['content_scope'], 'abstract')
        self.assertTrue(result['full_text_unavailable'])
        self.assertEqual(result['failed_attempts'], 2)
        self.assertEqual(len(result['academic_read_attempts']), 3)
        self.assertEqual(result['_body'], 'Abstract summary')

    def test_redirected_html_abstract_is_not_reported_as_full_text(self):
        _, reader = reader_double()
        reader._fetch_bytes.side_effect = [(b'Abstract summary', 'https://arxiv.org/abs/2401.12345v1', 'text/html'),
            RuntimeError('PDF unavailable'), RuntimeError('abs unavailable')]
        result = reader.read_page('https://arxiv.org/html/2401.12345v1', [])
        self.assertEqual(result['content_scope'], 'abstract')

    def test_openalex_uses_explicit_oa_document_without_guessing_urls(self):
        _, reader = reader_double()
        reader.base._get.return_value = (json.dumps({'abstract': 'Summary', 'best_oa_location': {
            'is_oa': True, 'pdf_url': 'https://author.example/preprint.pdf'}}), 'https://api.openalex.org/works/W123')
        reader._fetch_bytes.return_value = (b'%PDF fixture', 'https://author.example/preprint.pdf', 'application/pdf')
        result = reader.read_page('https://openalex.org/W123', [], include_body=True)
        reader._fetch_bytes.assert_called_once_with('https://author.example/preprint.pdf')
        self.assertEqual(result['content_scope'], 'full_text')
        self.assertEqual(result['_body'], 'Full PDF proof')

    def test_openalex_without_oa_uses_its_recorded_doi_and_retains_requested_identity(self):
        _, reader = reader_double()
        reader.base._get.return_value = (json.dumps({'abstract': 'Metadata summary',
            'doi': 'https://doi.org/10.1000/fixture'}), 'https://api.openalex.org/works/W123')
        reader._fetch_bytes.return_value = (b'Publisher page text', 'https://publisher.example/article', 'text/html')
        result = reader.read_page('https://openalex.org/W123', [], include_body=True)
        reader._fetch_bytes.assert_called_once_with('https://doi.org/10.1000/fixture')
        self.assertEqual(result['url'], 'https://openalex.org/W123')
        self.assertEqual(result['resolved_url'], 'https://publisher.example/article')
        self.assertEqual(result['content_scope'], 'page_text')
        self.assertEqual(result['_body'], 'Publisher page text')
        reader.base._reserve.assert_called_once_with('read')

    def test_publisher_page_does_not_hide_a_later_explicit_oa_pdf(self):
        _, reader = reader_double()
        reader.base._get.return_value = (json.dumps({'abstract': 'Metadata summary', 'best_oa_location': {
            'is_oa': True, 'landing_page_url': 'https://author.example/article'}, 'locations': [{
            'is_oa': True, 'pdf_url': 'https://repository.example/paper.pdf'}]}), 'https://api.openalex.org/works/W123')
        reader._fetch_bytes.side_effect = [(b'Publisher abstract page', 'https://author.example/article', 'text/html'),
            (b'%PDF fixture', 'https://repository.example/paper.pdf', 'application/pdf')]
        result = reader.read_page('https://openalex.org/W123', [])
        self.assertEqual(result['content_scope'], 'full_text')
        self.assertEqual(result['content_type'], 'pdf')
        self.assertEqual(result['academic_read_attempts'][1]['status'], 'page_text')

    def test_oa_attempts_are_bounded_and_preserve_abstract_when_full_text_fails(self):
        _, reader = reader_double()
        reader.base._get.return_value = (json.dumps({'abstract': 'Metadata summary', 'locations': [
            {'is_oa': True, 'pdf_url': 'https://author.example/' + str(i) + '.pdf'} for i in range(20)]}), 'https://api.openalex.org/works/W123')
        reader._fetch_bytes.side_effect = RuntimeError('no body available')
        result = reader.read_page('https://doi.org/10.1000/fixture', [], include_body=True)
        self.assertEqual(reader._fetch_bytes.call_count, academic_read.MAX_OPEN_ACCESS_CANDIDATES + 1)
        self.assertEqual(result['content_scope'], 'abstract')
        self.assertEqual(result['_body'], 'Metadata summary')
        self.assertEqual(result['failed_attempts'], 3)
        reader.base._reserve.assert_called_once_with('read')

    def test_metadata_failure_does_not_block_direct_doi_read(self):
        for malformed in (False, True):
            with self.subTest(malformed_response=malformed):
                _, reader = reader_double()
                if malformed:
                    reader.base._get.return_value = ('[]', 'https://api.openalex.org/works/W123')
                else:
                    reader.base._get.side_effect = RuntimeError('metadata provider unavailable')
                reader._fetch_bytes.return_value = (b'Proof body', 'https://publisher.example/article', 'text/html')
                result = reader.read_page('https://doi.org/10.1000/fixture', [])
                self.assertEqual(result['content_scope'], 'page_text')
                self.assertEqual(result['failed_attempts'], 1)

    def test_nonacademic_url_delegates_without_spending_another_read(self):
        _, reader = reader_double()
        self.assertEqual(reader.read_page('https://example.org/reference', ['proof'], 200, 3, include_body=True), {'original': True})
        reader.base._reserve.assert_not_called()
        reader.base._get.assert_not_called()
        reader._fetch_bytes.assert_not_called()

    def test_local_only_rejects_before_read_budget_or_request(self):
        _, reader = reader_double()
        with patch.dict(os.environ, {'DEEP_RESEARCH_SOURCE_POLICY': 'local_only'}):
            with self.assertRaisesRegex(RuntimeError, 'local_only'):
                reader.read_page('https://arxiv.org/abs/2401.12345', [])
        reader.base._reserve.assert_not_called()
        reader._fetch_bytes.assert_not_called()

    def test_entire_failure_keeps_provider_and_document_diagnostics(self):
        _, reader = reader_double()
        reader.base._get.side_effect = RuntimeError('metadata timeout')
        reader._fetch_bytes.side_effect = RuntimeError('document timeout')
        with self.assertRaisesRegex(RuntimeError, 'metadata timeout.*document timeout'):
            reader.read_page('https://doi.org/10.1000/fixture', [])
        reader.base._reserve.assert_called_once_with('read')

    def test_pdf_extraction_and_truncation_metadata_are_preserved(self):
        _, reader = reader_double()
        def pdf(raw, details):
            details.update(pages=[{'page': 1}], truncated=True)
            return 'Paper', 'Full PDF proof'
        reader._pdf_text = pdf
        reader._fetch_bytes.return_value = (b'%PDF fixture', 'https://arxiv.org/pdf/2401.12345v4', 'application/pdf')
        result = reader.read_page('https://arxiv.org/pdf/2401.12345v4', [])
        self.assertEqual(result['pages'], [{'page': 1}])
        self.assertTrue(result['truncated'])
        self.assertEqual(result['content_type'], 'pdf')


if __name__ == '__main__':
    unittest.main()
