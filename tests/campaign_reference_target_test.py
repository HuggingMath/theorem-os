"""Target-only discovery dispatch, independent of transport fixtures."""
import unittest
from unittest.mock import Mock

from campaign_reference_test import adapter, research_double


class TargetSearchTests(unittest.TestCase):
    def research(self):
        research = research_double()
        research.search = Mock(return_value={'route': 'original'})
        research._search_base = Mock(return_value={'route': 'target'})
        original = research.search
        adapter.install(research)
        return research, original

    def test_target_without_artifact_uses_target_aware_discovery_and_recovery(self):
        research, original = self.research()
        recovery = {'synthetic': 'saved execution'}
        result = research.search('  "heat kernel" estimates  ', 6, ' compact Riemannian manifold ',
                                 None, None, 'direct', _recovery=recovery)
        self.assertEqual(result, {'route': 'target'})
        research._search_base.assert_called_once_with('"heat kernel" estimates', 6, provider='direct',
                                                     target='compact Riemannian manifold', _recovery=recovery)
        original.assert_not_called()

    def test_empty_query_or_target_is_rejected_before_discovery(self):
        for query, target in [('heat kernel', ''), ('heat kernel', '   '), (' ', 'compact manifold')]:
            with self.subTest(query=query, target=target):
                research, original = self.research()
                with self.assertRaises(ValueError):
                    research.search(query, target=target)
                original.assert_not_called()
                research._search_base.assert_not_called()

    def test_default_and_artifact_contracts_delegate_unchanged(self):
        for target, artifact, proof in [(None, None, None), ('compact manifold', 'paper', 'bound'),
                                        ('compact manifold', 'paper', None), ('compact manifold', None, 'bound'),
                                        (None, 'paper', 'bound'), ('compact manifold', None, '')]:
            with self.subTest(target=target, artifact=artifact, proof=proof):
                research, original = self.research()
                recovery = {'synthetic': 'original-route recovery'}
                result = research.search('heat kernel', 4, target, artifact, proof, 'auto', _recovery=recovery)
                self.assertEqual(result, {'route': 'original'})
                original.assert_called_once_with('heat kernel', 4, target, artifact, proof, 'auto', _recovery=recovery)
                research._search_base.assert_not_called()


if __name__ == '__main__':
    unittest.main()
