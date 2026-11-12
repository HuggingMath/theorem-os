"""Metadata-only regressions for the observed answer-mirror namespace.

The observed URL is never fetched. Requests and cached body loaders are doubles.
"""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from campaign_reference_test import SCRIPTS, load, research_double


OBSERVED_MIRROR = 'https://www.emergentmind.com/openai-math-explorer/papers/355.pdf?v=adc7f12'
ALLOWED_PAPER = 'https://arxiv.org/abs/2401.12345'


class MirrorPolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = load('campaign_mirror_policy_test', SCRIPTS / 'reference-search-policy.py')

    def research(self):
        research = research_double()
        sent, bodies = [], []

        class Session:
            def send(self, request, **kwargs):
                sent.append(request.url)
                return request.url

        research.base.requests = SimpleNamespace(sessions=SimpleNamespace(Session=Session))
        research.read_page = lambda url: bodies.append(url) or {'url': url}
        research.workspace.load_source = lambda ref, version=None, run_root=None: bodies.append(ref)
        self.policy.install_source_policy(research)
        return research, Session, sent, bodies

    def test_observed_namespace_and_encoded_mirrors_are_forbidden(self):
        for source in [
            OBSERVED_MIRROR,
            'https://mirror.example/openai-math-explorer/',
            'https://mirror.example/openai_math_explorer/papers/355.pdf',
            'https://mirror.example/openai%252dmath%252dexplorer/papers/355.pdf',
            'https://mirror.example/openai-math%252fanswers/355.pdf',
            'https://redirect.example/?next=https%3A%2F%2Fwww.emergentmind.com%2Fopenai-math-explorer%2Fpapers%2F355.pdf',
        ]:
            with self.subTest(source=source):
                self.assertTrue(self.policy.forbidden_source(source))
                with self.assertRaisesRegex(PermissionError, 'reference_source_forbidden'):
                    self.policy.require_permitted(source)

    def test_legitimate_academic_pages_and_distinct_namespaces_remain_permitted(self):
        for source in [
            ALLOWED_PAPER,
            'https://doi.org/10.1000/general-mathematics',
            'https://www.emergentmind.com/papers/2401.12345',
            'https://www.emergentmind.com/topics/optimal-transport',
            'https://example.org/openai-math-explorerology/paper',
            'https://example.org/openai-math-research/paper',
            'https://example.org/openai-mathematics/paper',
        ]:
            with self.subTest(source=source):
                self.assertFalse(self.policy.forbidden_source(source))
                self.policy.require_permitted(source, 'General mathematics from OpenAI')

    def test_known_source_metadata_and_aliases_share_the_read_guard(self):
        metadata_cases = [
            {'url': OBSERVED_MIRROR},
            {'resolved_url': OBSERVED_MIRROR},
            {'citation_url': OBSERVED_MIRROR},
            {'alternate_sources': [{'url': OBSERVED_MIRROR}]},
        ]
        for metadata in metadata_cases:
            with self.subTest(metadata=metadata):
                with self.assertRaisesRegex(PermissionError, 'reference_source_forbidden'):
                    self.policy.require_permitted(ALLOWED_PAPER, 'General notes', metadata)
                self.assertEqual(self.policy.candidate_source_status(
                    {'url': ALLOWED_PAPER, 'title': 'General notes', **metadata})[0], 'forbidden')

    def test_mirror_cards_and_aliases_are_excluded_before_ref_registration(self):
        research, _, _, _ = self.research()
        output = research._public_leads({'status': 'ok', 'results': [
            {'url': OBSERVED_MIRROR, 'title': 'Observed metadata'},
            {'url': 'https://example.org/notes', 'title': 'Alias metadata',
             'alternate_sources': [{'url': OBSERVED_MIRROR}]},
            {'url': 'https://example.org/other', 'title': 'Resolved metadata',
             'resolved_url': OBSERVED_MIRROR},
            {'url': ALLOWED_PAPER, 'title': 'Permitted mathematics'},
        ]})
        self.assertEqual(output['forbidden_source_count'], 3)
        self.assertEqual(len(output['results']), 1)
        self.assertEqual(set(research.refs.values()), {ALLOWED_PAPER})
        self.assertFalse(research._campaign_reference_candidate_permitted(
            {'url': ALLOWED_PAPER, 'alternate_sources': [{'url': OBSERVED_MIRROR}]}))

    def test_redirect_destination_is_rejected_before_the_request_is_sent(self):
        research, Session, sent, bodies = self.research()
        Session().send(SimpleNamespace(url=ALLOWED_PAPER))
        with self.assertRaisesRegex(PermissionError, 'reference_source_forbidden'):
            Session().send(SimpleNamespace(url=OBSERVED_MIRROR))
        with self.assertRaisesRegex(PermissionError, 'reference_source_forbidden'):
            research.read_page(OBSERVED_MIRROR)
        self.assertEqual(sent, [ALLOWED_PAPER])
        self.assertEqual(bodies, [])

    def test_cached_current_and_versioned_aliases_are_rejected_before_body_open(self):
        research, _, _, bodies = self.research()
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            research.workspace._source_dir = lambda ref, run_root=None: folder
            for version in (None, 'a' * 64):
                file = folder / (f'{version}.json' if version else 'metadata.json')
                file.write_text(json.dumps({'url': ALLOWED_PAPER,
                                            'alternate_sources': [{'url': OBSERVED_MIRROR}]}))
                with self.subTest(version=version), self.assertRaisesRegex(
                        PermissionError, 'reference_source_forbidden'):
                    research.workspace.load_source('REF-cached', version)
        self.assertEqual(bodies, [])

    def test_resolved_read_metadata_is_rejected_before_returning_a_source(self):
        research = research_double()

        class Session:
            def send(self, request, **kwargs):
                raise AssertionError('network must not be used')

        research.base.requests = SimpleNamespace(sessions=SimpleNamespace(Session=Session))
        research.read_page = lambda url: {'url': url, 'alternate_sources': [{'url': OBSERVED_MIRROR}]}
        research.workspace.load_source = lambda *args, **kwargs: None
        self.policy.install_source_policy(research)
        with self.assertRaisesRegex(PermissionError, 'reference_source_forbidden'):
            research.read_page(ALLOWED_PAPER)


if __name__ == '__main__':
    unittest.main()
