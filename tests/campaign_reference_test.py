"""Offline campaign discovery contracts; every provider response is local or mocked."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'scripts/mathematics/reference-search'
FIXTURES = ROOT / 'tests/fixtures/campaign-reference'
sys.path.insert(0, str(SCRIPTS))
import campaign_reference as adapter


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def research_double():
    research = SimpleNamespace(__file__=__file__, calls=[], mock_web=[], refs={})
    research.workspace = SimpleNamespace(search_id=lambda request: hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest())
    research.base = SimpleNamespace(_get=lambda url: (_ for _ in ()).throw(AssertionError('unmocked request: ' + url)),
                                    _clean=lambda value, limit: ' '.join(value.split())[:limit],
                                    _url_ok=lambda url: url.startswith(('http://', 'https://')))
    research._provider_config = lambda plan: {'implementation_sha256': 'base-fixture'}
    research._academic_search_enabled = lambda: True
    research._outcome_errors = lambda rows: [row for row in rows if row['status'] == 'error']

    def call(provider, operation, outcomes, *, request):
        research.calls.append((provider, request))
        try:
            cards = operation()
            outcomes.append({'provider': provider, 'request': request, 'status': 'ok' if cards else 'empty'})
            return cards
        except Exception as error:
            outcomes.append({'provider': provider, 'request': request, 'status': 'error', 'error': str(error)})
            return []

    research._call_provider = call
    research._rank_discovery = lambda cards, query, limit, target=None, diagnostics=None: [dict(card) for card in cards if research.base._url_ok(card['url'])][:limit]

    def gaps(cards, query, limit, target=None):
        covered = set(adapter.words(' '.join(card.get('title', '') + ' ' + card.get('snippet', '') for card in cards)))
        return (['too_few_distinct_documents'] if len(cards) < min(2, limit) else []) + (['need_terms_missing_from_results'] if set(adapter.words(query)) - covered else [])

    research._recall_gaps = gaps

    def direct(query, limit=8, target=None):
        outcomes, cards = [], list(research.mock_web)
        if research._academic_search_enabled():
            for name, operation in [('arxiv', research._arxiv), ('openalex', research._openalex_exact)]:
                cards.extend(call(name, lambda operation=operation: operation(query, 2), outcomes, request={'query': query, 'limit': 2}))
        return {'query': query, 'results': research._rank_discovery(cards, query, limit, target),
                'provider_results': outcomes, 'discovery_diagnostics': {}}

    research._search_direct = direct
    research._search_base_execute = lambda query, limit, mode, artifact, target: research._search_direct(query, limit, target)

    def public(result):
        rows = []
        for card in result['results']:
            ref = 'REF-' + hashlib.sha256(card['url'].encode()).hexdigest()[:16]
            research.refs[ref] = card['url']
            rows.append({key: value for key, value in {**card, 'ref': ref, 'evidence_status': 'unread_lead', 'citable': False}.items() if key != 'url'})
        return {**result, 'results': rows, 'next_action': '', 'status': result.get('status', 'ok')}

    research._public_leads = public
    return research


EMPTY = '<feed xmlns="http://www.w3.org/2005/Atom" />'


class QueryTests(unittest.TestCase):
    def test_preserves_concept_and_object_without_topic_special_cases(self):
        examples = [
            ('PSD rank perfect matching polytope superpolynomial lower bound odd cut slack matrix', '"psd rank"', '"perfect matching polytope"'),
            ('semidefinite extension complexity perfect matching polytope lower bound spectrahedron', '"semidefinite extension complexity"', '"perfect matching polytope"'),
            ('spectral radius random regular graph lower bound', '"spectral radius"', '"random regular graph"'),
        ]
        for query, concept, subject in examples:
            with self.subTest(query=query):
                plan = adapter.query_plan(query)
                self.assertEqual(plan[0]['query'], concept + ' ' + subject)
                self.assertIn({'stage': 'concept-only', 'query': concept}, plan)
                self.assertIn({'stage': 'subject-only', 'query': subject}, plan)
                self.assertLessEqual(len(plan), 3)
                self.assertIn('all:' + concept, adapter.arxiv_query(query))

    def test_explicit_phrase_and_target_are_preserved_and_work_is_bounded(self):
        plan = adapter.query_plan('"heat kernel" estimates asymptotics', 'compact Riemannian manifold')
        self.assertEqual(plan[0]['query'], '"heat kernel" "compact riemannian manifold"')
        self.assertLessEqual(len(adapter.query_plan(' '.join(['word'] * 10000))), 3)
        self.assertEqual(adapter.query_plan(''), [])

    def test_replay_saved_responses_and_xml_recovers_academic_background(self):
        saved = json.loads((FIXTURES / 'saved-searches.json').read_text())
        for index, case in enumerate(saved):
            research = research_double()
            research.mock_web = [row for row in case['results'] if row['engine'] != 'openalex']
            urls = []

            def get(url):
                urls.append(url)
                parsed = urlsplit(url)
                if parsed.netloc == 'export.arxiv.org':
                    query = parse_qs(parsed.query)['search_query'][0]
                    phrase = 'all:"psd rank"' if index == 0 else 'all:"semidefinite extension complexity"'
                    body = (FIXTURES / ('psdrank1.xml' if index == 0 else 'sdpext.xml')).read_text() if query == phrase else EMPTY
                    return body, url
                if parsed.netloc == 'api.openalex.org':
                    rows = [{'display_name': row['title'], 'external_id': row['url'], 'hint': row['snippet'].split(' | ')[0]}
                            for row in case['results'] if row['engine'] == 'openalex']
                    return json.dumps({'results': rows}), url
                raise AssertionError('unmocked host ' + url)

            research.base._get = get
            adapter.install(research)
            result = research._search_base_execute(case['request']['query'], case['request']['limit'], 'direct', None, None)
            public = research._public_leads(result)
            self.assertTrue(public['results'])
            self.assertTrue(all(row['engine'] in ('arxiv', 'openalex') for row in public['results']))
            self.assertTrue(all(row['relevance'] == 'low' for row in public['low_relevance_results']))
            self.assertEqual(public['status'], 'partial')
            self.assertIn('no_research_subject_match', public['recall_checks']['remaining_gaps'])
            self.assertLessEqual(len(research.calls), 2 + adapter.MAX_FALLBACK_REQUESTS)
            self.assertEqual(result['discovery_diagnostics']['academic_recall']['fallback_requests'], 4)
            self.assertTrue(any('"perfect matching polytope"' in request['query'] for _, request in research.calls))
            self.assertTrue(any(parse_qs(urlsplit(url).query).get('q') == [adapter.query_plan(case['request']['query'])[0]['query'].replace('"', '')] for url in urls))
            self.assertTrue(all(not row['citable'] for row in public['results']))

    def test_only_unrelated_web_cards_are_separate_and_do_not_close_recall_gap(self):
        case = json.loads((FIXTURES / 'saved-searches.json').read_text())[0]
        research = research_double()
        research._academic_search_enabled = lambda: False
        research.mock_web = case['results']
        adapter.install(research)
        result = research._search_base_execute(case['request']['query'], 6, 'direct', None, None)
        public = research._public_leads(result)
        self.assertEqual(public['results'], [])
        self.assertEqual(len(public['low_relevance_results']), 6)
        self.assertEqual(public['status'], 'partial')
        self.assertIn('no_research_subject_match', public['recall_checks']['remaining_gaps'])

    def test_citation_follow_without_search_question_keeps_existing_leads(self):
        research = research_double()
        adapter.install(research)
        output = research._public_leads({'results': [{'url': 'https://arxiv.org/abs/2401.12345', 'title': 'Cited primary source'}]})
        self.assertEqual(len(output['results']), 1)
        self.assertNotIn('low_relevance_results', output)

    def test_mock_new_subject_keeps_matching_summary_hits_and_does_not_fallback(self):
        research = research_double()
        query = 'spectral radius random regular graph lower bound'
        # The phrase occurs in the summary, not the title: it must survive the
        # old title-only screening that dropped useful arXiv search responses.
        feed = '<feed xmlns="http://www.w3.org/2005/Atom">' + ''.join(
            f'<entry><id>https://arxiv.org/abs/2401.1234{i}v1</id><title>A note on sparse operators {i}</title>'
            '<summary>We prove a spectral radius lower bound for a random regular graph.</summary></entry>' for i in range(2)) + '</feed>'
        research.base._get = lambda url: (feed if 'arxiv.org' in url else '{"results": []}', url)
        adapter.install(research)
        result = research._search_base_execute(query, 2, 'direct', None, None)
        self.assertEqual(len(result['results']), 2)
        self.assertEqual(len(research.calls), 2)
        self.assertEqual(result['discovery_diagnostics']['academic_recall']['fallback_requests'], 0)

    def test_all_empty_and_error_retries_are_bounded_and_visible(self):
        research = research_double()
        def get(url):
            if 'openalex.org' in url:
                raise RuntimeError('mock timeout')
            return EMPTY, url
        research.base._get = get
        adapter.install(research)
        result = research._search_direct('heat kernel compact manifold estimates', 8)
        self.assertEqual(len(research.calls), 6)
        self.assertEqual(len(result['provider_errors']), 3)
        self.assertEqual(result['results'], [])

    def test_paper_versions_merge_without_title_only_false_merge(self):
        research = research_double()
        adapter.install(research)
        title = 'On the existence of polytopes with high extension complexity'
        rows = [
            {'url': 'https://arxiv.org/abs/1305.3268v1', 'title': title, 'engine': 'arxiv', 'doi': '10.1007/example', 'snippet': 'semidefinite extension complexity'},
            {'url': 'https://arxiv.org/pdf/1305.3268v3.pdf', 'title': title, 'engine': 'arxiv', 'snippet': 'semidefinite extension complexity'},
            {'url': 'https://doi.org/10.1007/example', 'title': title, 'engine': 'openalex', 'snippet': 'semidefinite extension complexity'},
            {'url': 'https://example.org/other', 'title': title, 'engine': 'openalex', 'snippet': 'Other Author | cited by 2'},
        ]
        result = research._rank_discovery(rows, 'semidefinite extension complexity', 8)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]['alias_count'], 2)
        self.assertEqual(len(research._rank_discovery(result + [rows[2]], 'semidefinite extension complexity', 8)), 2)
        saved = json.loads((FIXTURES / 'saved-searches.json').read_text())[1]
        academic = [row for row in saved['results'] if row['engine'] == 'openalex']
        self.assertEqual(len(research._rank_discovery(academic, saved['request']['query'], 8)), 1)

    def test_legacy_search_key_is_kept_and_new_cache_and_old_ref_both_work(self):
        research = research_double()
        request = {'query': 'heat kernel compact manifold', 'limit': 2}
        old_id = research.workspace.search_id(request)
        cache, bodies = {old_id: 'old low-relevance cards'}, {'REF-old': 'previous permitted source body'}
        adapter.install(research)
        new_id = research.workspace.search_id(request)
        self.assertNotEqual(new_id, old_id)
        self.assertNotIn(new_id, cache)
        cache[new_id] = 'repaired discovery'
        self.assertEqual(cache[research.workspace.search_id(request)], 'repaired discovery')
        self.assertEqual(cache[old_id], 'old low-relevance cards')
        self.assertEqual(bodies['REF-old'], 'previous permitted source body')
        self.assertIn('campaign_reference_base_sha256', research._provider_config([]))


class SourcePolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = load('campaign_source_policy_test', SCRIPTS / 'reference-search-policy.py')

    def test_encoded_answer_paths_and_labels_are_banned(self):
        for source, label in [('https://github.com/openai/Math', ''),
                              ('https://mirror.example/openai%252fmath/answers', ''),
                              ('https://mirror.example/page', 'OpenAI Math benchmark solutions'),
                              ('/home/lzh/openai-math-upstream/Answers.lean', '')]:
            self.assertTrue(self.policy.forbidden_source(source, label))
        self.assertFalse(self.policy.forbidden_source('https://arxiv.org/abs/2401.12345'))

    def test_redirect_and_cached_metadata_are_checked_before_send_or_body(self):
        research = research_double()
        sends, reads = [], []
        class Session:
            def send(self, request, **kwargs):
                sends.append(request.url)
                return request.url
        research.base.requests = SimpleNamespace(sessions=SimpleNamespace(Session=Session))
        research.read_page = lambda url: {'url': url, 'resolved_url': 'https://github.com/openai/Math/answers'}
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            research.workspace._source_dir = lambda ref, run_root=None: folder
            research.workspace.load_source = lambda ref, version=None, run_root=None: reads.append(ref)
            self.policy.install_source_policy(research)
            Session().send(SimpleNamespace(url='https://arxiv.org/abs/2401.12345'))
            with self.assertRaises(PermissionError):
                Session().send(SimpleNamespace(url='https://github.com/openai/Math/answers'))
            with self.assertRaises(PermissionError):
                research.read_page('https://allowed.example/redirect')
            (folder / 'metadata.json').write_text(json.dumps({'url': 'https://github.com/openai/Math/answers'}))
            with self.assertRaises(PermissionError):
                research.workspace.load_source('REF-unsafe')
            self.assertEqual(reads, [])
            self.assertEqual(len(sends), 1)

    def test_installer_pins_base_and_launcher_handles_spaces(self):
        installer = load('campaign_reference_installer', SCRIPTS / 'install.py')
        with tempfile.TemporaryDirectory() as directory:
            source, dest = Path(directory) / 'source', Path(directory) / 'installed tools'
            source.mkdir()
            for name in installer.BASE_SCRIPTS:
                (source / name).write_text('# frozen helper\n')
            original_argv = sys.argv
            try:
                sys.argv = ['install.py', '--dest', str(dest), '--research-script', str(source / 'research.py'), '--python', sys.executable]
                self.assertEqual(installer.main(), 0)
            finally:
                sys.argv = original_argv
            (source / 'research.py').write_text('# changed global helper\n')
            config = json.loads((dest / 'reference-search-config.json').read_text())
            self.assertEqual(Path(config['researchScript']).read_text(), '# frozen helper\n')
            manifest = json.loads((dest / 'reference-search-manifest.json').read_text())
            self.assertEqual(len(manifest['baseSourceHashes']), 15)
            # Parsing --help imports the real installed entry point without a search.
            installed_policy = load('installed_policy_test', dest / 'reference-search-policy.py')
            self.assertEqual(installed_policy.RESEARCH_SCRIPT, dest / 'base/research.py')
            self.assertTrue(os.access(dest / 'reference-search', os.X_OK))
            self.assertIn('reference-search-policy.py" "$@"', (dest / 'reference-search').read_text())


if __name__ == '__main__':
    unittest.main()
