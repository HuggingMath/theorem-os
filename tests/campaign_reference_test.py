"""Offline campaign discovery contracts; every provider response is local or mocked."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from contextvars import ContextVar
from types import SimpleNamespace
import unittest
from unittest.mock import patch
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
    research.v1 = SimpleNamespace(read_page=lambda *args, **kwargs: {}, _is_english_query=lambda _: True)
    research.workspace = SimpleNamespace(search_id=lambda request: hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest())
    research.base = SimpleNamespace(_get=lambda url: (_ for _ in ()).throw(AssertionError('unmocked request: ' + url)),
                                    _clean=lambda value, limit: ' '.join(value.split())[:limit],
                                    _url_ok=lambda url: url.startswith(('http://', 'https://')),
                                    _bing=lambda *args, **kwargs: [])
    research._ACTIVE_SEARCH = ContextVar('campaign_reference_test_execution', default=None)
    research._practitioner_search_enabled = lambda _: False
    research._recovery_has = lambda *args: False
    research._duckduckgo = lambda *args, **kwargs: list(research.mock_web)
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
                self.assertEqual(plan[0]['query'], query.casefold())
                self.assertIn({'stage': 'concept-only', 'query': concept.strip('"')}, plan)
                self.assertIn({'stage': 'subject-only', 'query': subject.strip('"')}, plan)
                self.assertLessEqual(len(plan), 3)
                self.assertTrue(all('all:' + term in adapter.arxiv_query(query)
                                    for term in query.casefold().split()))

    def test_explicit_phrase_and_target_are_preserved_and_work_is_bounded(self):
        plan = adapter.query_plan('"heat kernel" estimates asymptotics', 'compact Riemannian manifold')
        self.assertEqual(plan[0]['query'], '"heat kernel" estimates asymptotics "compact riemannian manifold"')
        self.assertLessEqual(len(adapter.query_plan(' '.join(['word'] * 10000))), 3)
        self.assertEqual(adapter.query_plan(''), [])

    def test_explicit_phrases_keep_connecting_words_and_all_named_objects(self):
        query = '"rank of a matrix" "nonnegative factorization" "extension complexity"'
        self.assertEqual(adapter.query_plan(query)[0]['query'], query)
        self.assertIn('all:"rank of a matrix"', adapter.arxiv_query(query))
        self.assertIn('all:"extension complexity"', adapter.arxiv_query(query))

    def test_explicit_research_target_is_not_cut_after_four_words(self):
        target = 'finite dimensional normed spaces with an unconditional basis'
        self.assertIn('"' + target + '"', adapter.query_plan('"projection constants"', target)[0]['query'])

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
                    phrase = adapter.arxiv_query('psd rank' if index == 0 else 'semidefinite extension complexity')
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
            self.assertLessEqual(len(research.calls), 4 + adapter.MAX_FALLBACK_REQUESTS)
            self.assertEqual(result['discovery_diagnostics']['academic_recall']['fallback_requests'], 4)
            self.assertTrue(any('perfect matching polytope' in request['query'] for _, request in research.calls))
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
        self.assertEqual(len(research.calls), 8)
        self.assertEqual(len(result['provider_errors']), 3)
        self.assertEqual(result['results'], [])

    def test_paper_versions_stay_separate_and_same_version_aliases_merge(self):
        research = research_double()
        adapter.install(research)
        title = 'On the existence of polytopes with high extension complexity'
        rows = [
            {'url': 'https://arxiv.org/abs/1305.3268v1', 'title': title, 'engine': 'arxiv', 'doi': '10.1007/example', 'snippet': 'semidefinite extension complexity'},
            {'url': 'https://arxiv.org/pdf/1305.3268v1.pdf', 'title': title, 'engine': 'arxiv', 'doi': '10.1007/example', 'snippet': 'semidefinite extension complexity'},
            {'url': 'https://arxiv.org/pdf/1305.3268v3.pdf', 'title': title, 'engine': 'arxiv', 'snippet': 'semidefinite extension complexity'},
            {'url': 'https://arxiv.org/abs/1305.3268', 'title': title, 'engine': 'arxiv', 'snippet': 'semidefinite extension complexity'},
            {'url': 'https://doi.org/10.1007/example', 'title': title, 'engine': 'openalex', 'snippet': 'semidefinite extension complexity'},
            {'url': 'https://example.org/other', 'title': title, 'engine': 'openalex', 'snippet': 'Other Author | cited by 2'},
        ]
        result = research._rank_discovery(rows, 'semidefinite extension complexity', 8)
        self.assertEqual(len(result), 5)
        self.assertEqual(result[0]['alias_count'], 1)
        self.assertEqual(result[0]['alternate_sources'][0]['url'], rows[1]['url'])
        self.assertEqual(len(research._rank_discovery(result + [rows[2]], 'semidefinite extension complexity', 8)), 5)
        saved = json.loads((FIXTURES / 'saved-searches.json').read_text())[1]
        academic = [row for row in saved['results'] if row['engine'] == 'openalex']
        self.assertEqual(len(research._rank_discovery(academic, saved['request']['query'], 8)), 2)

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

    def test_provenance_registry_normalizes_dois_and_explicit_uri_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'provenance.json'
            file.write_text(json.dumps({'schema': 'theorem-os.reference-source-provenance.v1', 'records': [
                {'id': 'synthetic-review', 'status': 'unverified',
                 'identifiers': ['doi:10.5555/Unresolved-Proof', 'https://preprint.example/notes/proof'],
                 'metadata': {'authors': ['Example Institute']}}
            ]}))
            self.policy.SOURCE_PROVENANCE = self.policy.load_source_provenance(file)
        for source in ['10.5555/unresolved-proof', 'https://doi.org/10.5555/UNRESOLVED-PROOF',
                       'https://DX.DOI.ORG/10.5555%252fUnresolved-Proof#section',
                       'https://PREPRINT.EXAMPLE/notes/proof#theorem']:
            with self.subTest(source=source), self.assertRaisesRegex(PermissionError, 'provenance_unverified'):
                self.policy.require_permitted(source)
        self.assertIsNotNone(self.policy.unverified_source('https://journal.example/abstract',
                                                          {'doi': '10.5555/unresolved-proof'}))
        # Matching authors, title words or DOI prefixes are not themselves a ban.
        self.policy.require_permitted('https://doi.org/10.5555/general-paper', 'Example Institute: general mathematics')
        self.policy.require_permitted('https://arxiv.org/abs/2401.12345', 'OpenAI: A general mathematics paper')

    def test_unverified_discovery_read_redirect_and_cache_share_the_registry(self):
        ids = self.policy.source_identifiers('https://doi.org/10.5555/synthetic-note')
        self.policy.SOURCE_PROVENANCE = [{'id': 'synthetic-source', 'status': 'unverified', '_identifiers': ids}]
        research = research_double()
        sent, bodies = [], []
        class Session:
            def send(self, request, **kwargs):
                sent.append(request.url)
                return request.url
        research.base.requests = SimpleNamespace(sessions=SimpleNamespace(Session=Session))
        research.read_page = lambda url: bodies.append(url) or {'url': url}
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            research.workspace._source_dir = lambda ref, run_root=None: folder
            research.workspace.load_source = lambda ref, version=None, run_root=None: bodies.append(ref)
            self.policy.install_source_policy(research)
            public = research._public_leads({'results': [
                {'url': 'https://journal.example/abstract', 'doi': '10.5555/synthetic-note', 'title': 'Unresolved metadata'},
                {'url': 'https://arxiv.org/abs/2401.12345', 'title': 'General mathematics', 'snippet': 'OpenAI | cited by 4'},
                {'url': 'https://mirror.example/other', 'title': 'Alias',
                 'alternate_sources': [{'url': 'https://dx.doi.org/10.5555/synthetic-note'}]}
            ]})
            self.assertEqual(public['excluded_source_count'], 2)
            self.assertEqual(public['unverified_source_count'], 2)
            self.assertEqual(public['forbidden_source_count'], 0)
            self.assertEqual(len(research.refs), 1)
            self.assertEqual(public['results'][0]['title'], 'General mathematics')
            with self.assertRaisesRegex(PermissionError, 'provenance_unverified'):
                research.read_page('https://doi.org/10.5555/synthetic-note')
            Session().send(SimpleNamespace(url='https://allowed.example/redirect'))
            with self.assertRaisesRegex(PermissionError, 'provenance_unverified'):
                Session().send(SimpleNamespace(url='https://dx.doi.org/10.5555/synthetic-note'))
            (folder / 'metadata.json').write_text(json.dumps({'url': 'https://journal.example/abstract',
                                                             'doi': '10.5555/synthetic-note'}))
            with self.assertRaisesRegex(PermissionError, 'provenance_unverified'):
                research.workspace.load_source('REF-synthetic')
            self.assertEqual(bodies, [])
            self.assertEqual(sent, ['https://allowed.example/redirect'])

    def test_observed_cards_are_held_as_unverified_not_asserted_to_be_answers(self):
        data = json.loads((SCRIPTS / 'reference-source-provenance.json').read_text())
        for row in data['records']:
            self.assertEqual(row['status'], 'unverified')
            self.assertIsNotNone(self.policy.unverified_source(row['identifiers'][0]))
        self.assertEqual({row['metadata']['snippet'] for row in data['records']}, {'OpenAI | cited by 0'})

    def test_held_candidates_cannot_close_discovery_or_displace_permitted_documents(self):
        research = research_double()
        class Session:
            def send(self, request, **kwargs):
                raise AssertionError('unexpected network')
        research.base.requests = SimpleNamespace(sessions=SimpleNamespace(Session=Session))
        research.read_page = lambda *args, **kwargs: {}
        research.workspace.load_source = lambda *args, **kwargs: None
        adapter.install(research)
        self.policy.install_source_policy(research)
        held = [dict(row['metadata'], url=row['identifiers'][0]) for row in self.policy.SOURCE_PROVENANCE]
        query = 'variance random SAT hitting time'
        self.assertIn('too_few_distinct_documents', research._recall_gaps(held, query, 2))
        allowed = [{'url': f'https://arxiv.org/abs/2401.1234{index}',
                    'title': 'Variance of random SAT hitting time estimates',
                    'snippet': '', 'engine': 'arxiv'} for index in range(2)]
        ranked = research._rank_discovery(held + allowed, query, 2)
        self.assertEqual({card['url'] for card in ranked}, {card['url'] for card in allowed})
        public = research._public_leads({'query': query, 'results': held, 'status': 'ok'})
        self.assertEqual(public['results'], [])
        self.assertEqual(public['status'], 'partial')
        self.assertEqual(public['unverified_source_count'], 2)
        self.assertEqual(research.refs, {})

    def test_explicit_absolute_run_anchor_wins_over_cwd_and_inherited_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = Path(directory) / 'worker with spaces' / '.scratch/reference-search'
            with patch.dict(os.environ, {'DRBENCH_RUN_DIR': '/wrong/campaign', 'DEEP_RESEARCH_RUN_DIR': '/wrong/other'}, clear=True):
                self.assertEqual(self.policy.configure_run_directory(['--run-dir', str(worker), 'search', 'heat kernel']),
                                 ['search', 'heat kernel'])
                self.assertEqual(os.environ['DRBENCH_RUN_DIR'], str(worker))
                self.assertEqual(os.environ['DEEP_RESEARCH_RUN_DIR'], str(worker))
                self.assertFalse(worker.exists())
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(ValueError, 'reference_run_directory_required'):
                    self.policy.configure_run_directory(['search', 'heat kernel'])
                with self.assertRaisesRegex(ValueError, 'reference_run_directory_required'):
                    self.policy.configure_run_directory(['--run-dir', '.scratch/reference-search', 'search', 'heat kernel'])
                self.assertEqual(self.policy.configure_run_directory(['--help']), ['--help'])
                self.assertEqual(self.policy.configure_run_directory(['search', '--help']), ['search', '--help'])
            with patch.dict(os.environ, {'DEEP_RESEARCH_RUN_DIR': str(worker)}, clear=True):
                self.assertEqual(self.policy.configure_run_directory(['read', 'REF-old']), ['read', 'REF-old'])

    def test_cli_without_anchor_fails_before_loading_helper_or_writing_cwd(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = {key: value for key, value in os.environ.items() if key not in ('DEEP_RESEARCH_RUN_DIR', 'DRBENCH_RUN_DIR')}
            result = subprocess.run([sys.executable, '-B', str(SCRIPTS / 'reference-search-policy.py'), 'search', 'heat kernel'],
                                    cwd=directory, env=environment, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 2)
            self.assertIn('reference_run_directory_required', result.stderr)
            self.assertNotIn('Traceback', result.stderr)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_installer_pins_base_and_launcher_handles_spaces(self):
        installer = load('campaign_reference_installer', SCRIPTS / 'install.py')
        with tempfile.TemporaryDirectory() as directory:
            source, dest = Path(directory) / 'source', Path(directory) / 'installed tools'
            source.mkdir()
            for name in installer.BASE_SCRIPTS:
                (source / name).write_text('# frozen helper\n')
            registry = Path(directory) / 'source-provenance.json'
            registry.write_text(json.dumps({'schema': 'theorem-os.reference-source-provenance.v1', 'records': [
                {'id': 'installed-synthetic', 'status': 'unverified', 'identifiers': ['doi:10.5555/installed-note']}
            ]}))
            original_argv = sys.argv
            try:
                sys.argv = ['install.py', '--dest', str(dest), '--research-script', str(source / 'research.py'), '--python', sys.executable,
                            '--source-provenance', str(registry)]
                self.assertEqual(installer.main(), 0)
            finally:
                sys.argv = original_argv
            (source / 'research.py').write_text('# changed global helper\n')
            registry.write_text('{}')
            config = json.loads((dest / 'reference-search-config.json').read_text())
            self.assertEqual(Path(config['researchScript']).read_text(), '# frozen helper\n')
            manifest = json.loads((dest / 'reference-search-manifest.json').read_text())
            self.assertEqual(len(manifest['baseSourceHashes']), 15)
            self.assertIn('reference-source-provenance.json', manifest['files'])
            self.assertIn('academic_read.py', manifest['files'])
            self.assertNotIn('$PWD', (dest / 'reference-search').read_text())
            # Parsing --help imports the real installed entry point without a search.
            installed_policy = load('installed_policy_test', dest / 'reference-search-policy.py')
            self.assertEqual(installed_policy.RESEARCH_SCRIPT, dest / 'base/research.py')
            self.assertEqual(installed_policy.unverified_source('https://doi.org/10.5555/installed-note')['id'],
                             'installed-synthetic')
            self.assertTrue(os.access(dest / 'reference-search', os.X_OK))
            self.assertIn('reference-search-policy.py" "$@"', (dest / 'reference-search').read_text())


if __name__ == '__main__':
    unittest.main()
