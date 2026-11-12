"""Frozen arXiv document identities with synthetic responses and no network."""
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/mathematics/reference-search'))
import academic_read


def reader_fixture(responses):
    base = SimpleNamespace(_reserve=Mock(), _record_event=Mock(), _get=Mock(),
                           _clean=lambda text, limit: text[:limit])
    reader = SimpleNamespace(
        base=base, read_page=Mock(), MAX_TEXT_CHARS=20_000,
        _openalex_id_from_url=lambda url: None, _doi_from_url=lambda url: None,
        _fetch_bytes=Mock(side_effect=responses),
        _pdf_text=Mock(side_effect=lambda raw, details: ('Synthetic proof', raw.decode())),
        _html_text=Mock(side_effect=lambda raw, encoding, **kwargs: ('Synthetic proof', raw.decode())),
        _document_text=Mock(side_effect=lambda text: text),
        _soft_error_page=lambda *args: False, _content_shell=lambda *args: False,
        _source_type=lambda url: 'primary_or_academic', _windows=lambda text, *args: [text])
    academic_read.install(SimpleNamespace(v1=reader))
    return reader


class AcademicVersionIdentityTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {'DEEP_RESEARCH_SOURCE_POLICY': 'mixed'})
        environment.start()
        self.addCleanup(environment.stop)

    def assert_rejected_then_same_version(self, requested, rejected_url):
        reader = reader_fixture([
            (b'%PDF rejected document text', rejected_url, 'application/pdf'),
            (b'Accepted same-version proof text', 'https://arxiv.org/html/2401.12345v1', 'text/html'),
        ])
        result = reader.read_page(requested, ['proof'], include_body=True)
        self.assertEqual(result['_body'], 'Accepted same-version proof text')
        self.assertEqual(result['resolved_url'], 'https://arxiv.org/html/2401.12345v1')
        self.assertEqual(result['url'], requested)
        self.assertEqual(result['content_scope'], 'full_text')
        self.assertEqual(result['fallback'], 'arxiv_html')
        self.assertEqual(result['failed_attempts'], 1)
        self.assertEqual(result['academic_read_attempts'][0]['status'], 'error')
        self.assertIn('arxiv_source_identity_mismatch', result['academic_read_attempts'][0]['error'])
        self.assertIn(rejected_url, result['academic_read_attempts'][0]['error'])
        self.assertEqual([call.args[0] for call in reader._fetch_bytes.call_args_list],
                         ['https://arxiv.org/pdf/2401.12345v1',
                          'https://arxiv.org/html/2401.12345v1'])
        reader._pdf_text.assert_not_called()
        reader._html_text.assert_called_once()
        reader.base._reserve.assert_called_once_with('read')
        reader.base._record_event.assert_called_once()

    def test_explicit_version_cannot_read_newer_pdf_and_tries_same_version_html(self):
        self.assert_rejected_then_same_version('https://arxiv.org/abs/2401.12345v1',
                                               'https://arxiv.org/pdf/2401.12345v3')

    def test_explicit_version_cannot_follow_an_identifiable_unversioned_url(self):
        self.assert_rejected_then_same_version('https://arxiv.org/abs/2401.12345v1',
                                               'https://arxiv.org/pdf/2401.12345')

    def test_different_arxiv_document_is_rejected_for_abs_and_doi_inputs(self):
        for requested in ('https://arxiv.org/abs/2401.12345v1',
                          'https://doi.org/10.48550/arXiv.2401.12345v1'):
            with self.subTest(requested=requested):
                self.assert_rejected_then_same_version(requested, 'https://arxiv.org/pdf/2401.54321v1')

    def test_all_mismatched_candidates_fail_without_extraction_or_success_event(self):
        reader = reader_fixture([
            (b'%PDF wrong version', 'https://arxiv.org/pdf/2401.12345v3', 'application/pdf'),
            (b'Wrong HTML version', 'https://arxiv.org/html/2401.12345v2', 'text/html'),
            (b'Wrong abstract version', 'https://arxiv.org/abs/2401.12345', 'text/html'),
        ])
        with self.assertRaisesRegex(RuntimeError, 'arxiv_source_identity_mismatch'):
            reader.read_page('https://arxiv.org/abs/2401.12345v1', ['proof'], include_body=True)
        self.assertEqual(reader._fetch_bytes.call_count, 3)
        reader._pdf_text.assert_not_called()
        reader._html_text.assert_not_called()
        reader._document_text.assert_not_called()
        reader.base._record_event.assert_not_called()
        reader.base._reserve.assert_called_once_with('read')

    def test_unversioned_request_may_resolve_to_same_document_with_version(self):
        reader = reader_fixture([(b'%PDF resolved version', 'https://arxiv.org/pdf/2401.12345v3', 'application/pdf')])
        result = reader.read_page('https://arxiv.org/abs/2401.12345', [], include_body=True)
        self.assertEqual(result['_body'], '%PDF resolved version')
        self.assertEqual(result['resolved_url'], 'https://arxiv.org/pdf/2401.12345v3')
        self.assertEqual(result['failed_attempts'], 0)
        self.assertEqual(reader._fetch_bytes.call_count, 1)

    def test_unversioned_request_still_rejects_a_different_document(self):
        reader = reader_fixture([
            (b'%PDF different document', 'https://arxiv.org/pdf/2401.54321v3', 'application/pdf'),
            (b'Correct document proof', 'https://arxiv.org/html/2401.12345v3', 'text/html'),
        ])
        result = reader.read_page('https://arxiv.org/abs/2401.12345', [], include_body=True)
        self.assertEqual(result['_body'], 'Correct document proof')
        self.assertEqual(result['failed_attempts'], 1)
        reader._pdf_text.assert_not_called()

    def test_same_version_with_another_arxiv_representation_is_valid(self):
        reader = reader_fixture([(b'%PDF same-version proof', 'https://export.arxiv.org/pdf/math.GT/0301234v2.pdf', 'application/pdf')])
        result = reader.read_page('https://arxiv.org/abs/math.GT/0301234v2', [], include_body=True)
        self.assertEqual(result['failed_attempts'], 0)
        self.assertEqual(result['content_scope'], 'full_text')
        self.assertEqual(reader._fetch_bytes.call_count, 1)

    def test_unknown_external_document_url_does_not_invent_an_arxiv_mismatch(self):
        reader = reader_fixture([(b'%PDF externally hosted proof', 'https://cdn.example/document.pdf', 'application/pdf')])
        result = reader.read_page('https://arxiv.org/abs/2401.12345v1', [], include_body=True)
        self.assertEqual(result['resolved_url'], 'https://cdn.example/document.pdf')
        self.assertEqual(result['failed_attempts'], 0)
        self.assertEqual(result['content_scope'], 'full_text')


if __name__ == '__main__':
    unittest.main()
