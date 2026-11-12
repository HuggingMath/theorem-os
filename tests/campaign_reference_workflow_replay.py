"""Exercise target discovery and HTML follow through an installed base helper.

All transport responses and saved text are synthetic fixtures. Real CLI parsing,
REF/cache storage, provider recovery and citation graph parsing remain active.
"""
import argparse
from collections import Counter
from contextlib import contextmanager, redirect_stdout
from html import escape
import importlib.util
from io import StringIO
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlsplit


QUERY, TARGET = '"heat kernel" estimates', 'compact Riemannian manifold'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    sys.path.insert(0, str(bundle))
    spec = importlib.util.spec_from_file_location('workflow_replay_policy', bundle / 'reference-search-policy.py')
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    unexpected_network = []

    def no_network(*args, **kwargs):
        unexpected_network.append('network attempted')
        raise AssertionError('network disabled in workflow replay')

    socket.create_connection = no_network
    socket.socket.connect = no_network
    from campaign_reference import install

    def load_research():
        research = policy.load_research()
        research.base.requests.sessions.Session.send = no_network
        research.base._url_ok = lambda url: url.startswith(('http://', 'https://'))
        install(research)
        policy.install_source_policy(research)
        return research

    @contextmanager
    def run_directory():
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                'DEEP_RESEARCH_RUN_DIR': directory, 'DRBENCH_RUN_DIR': directory,
                'DEEP_RESEARCH_SOURCE_POLICY': 'mixed', 'DRBENCH_ACADEMIC_SEARCH': '1',
                'DRBENCH_PRACTITIONER_SEARCH': '0'}):
            yield

    def card(index, target=TARGET):
        return {'url': f'https://arxiv.org/abs/2401.2710{index}v1',
                'title': f'Heat kernel estimates on {target}, synthetic note {index}',
                'snippet': 'Synthetic discovery metadata, not proof evidence.',
                'engine': 'anysearch', 'source_type': 'primary_or_academic'}

    def feed(cards):
        return '<feed xmlns="http://www.w3.org/2005/Atom">' + ''.join(
            '<entry><id>' + escape(row['url']) + '</id><title>' + escape(row['title'])
            + '</title><summary>' + escape(row['snippet']) + '</summary></entry>'
            for row in cards) + '</feed>'

    def target_search():
        research, calls, urls = load_research(), Counter(), []
        phase = {'recovering': False, 'target': TARGET}

        def get(url):
            host = urlsplit(url).hostname
            calls[host] += 1
            urls.append(url)
            if host == 'export.arxiv.org':
                if not phase['recovering']:
                    raise TimeoutError('synthetic recorded target search timeout')
                return feed([card(2, phase['target']), card(3, 'hyperbolic surfaces')]), url
            if host == 'api.openalex.org':
                return json.dumps({'results': [{'external_id': row['url'], 'display_name': row['title'],
                                                'hint': row['snippet']}
                                               for row in [card(0, phase['target']), card(1, phase['target'])]]}), url
            raise AssertionError('unexpected provider URL: ' + url)

        research.base._get = get
        research._duckduckgo = no_network
        research.base._bing = no_network
        capture = StringIO()
        with patch.object(sys, 'argv', ['reference-search', 'search', QUERY, '--target', TARGET,
                                       '--provider', 'direct', '--limit', '6']), redirect_stdout(capture):
            code = research.main()
        first = json.loads(capture.getvalue())
        assert code == 0 and len(first['results']) == 2 and first['status'] == 'partial', first
        assert first['research_target'] == TARGET and all(row['relevance'] == 'matching' for row in first['results']), first
        initial_calls = calls.copy()
        assert initial_calls == Counter({'export.arxiv.org': 1, 'api.openalex.org': 1}), calls
        sent_arxiv = parse_qs(urlsplit(urls[0]).query)['search_query'][0]
        assert sent_arxiv == 'all:"heat kernel" AND all:estimates AND all:"compact riemannian manifold"', sent_arxiv
        assert parse_qs(urlsplit(urls[1]).query)['q'] == ['heat kernel estimates compact riemannian manifold']
        arguments = (QUERY, 6, TARGET, None, None, 'direct')
        assert research._ref_search(*arguments)['cache_hit'] and calls == initial_calls
        phase['recovering'] = True
        recovered = research._ref_search(*arguments, retry_failed=True)
        assert calls - initial_calls == Counter({'export.arxiv.org': 1}), calls
        assert recovered['recovery']['retried_requests'] == 1 and recovered['recovery']['deferred_new_requests'] == 0
        assert len(recovered['results']) == 4 and recovered['results'][-1]['relevance'] == 'background', recovered
        assert all(row['relevance'] == 'matching' for row in recovered['results'][:-1]), recovered
        saved = research.workspace.load_search({'query': QUERY, 'limit': 6, 'target': TARGET,
                                                'artifact': None, 'proof': None, 'provider': 'direct'})['result']
        requests = [row['request'] for row in saved['provider_execution']['records']]
        assert requests == [{'query': QUERY.casefold() + ' "' + TARGET.casefold() + '"', 'limit': 2}] * 2, requests
        before_cached = calls.copy()
        assert research._ref_search(*arguments)['cache_hit'] and calls == before_cached
        phase['target'] = 'noncompact hyperbolic manifold'
        other = research._ref_search(QUERY, 6, phase['target'], None, None, 'direct')
        assert not other['cache_hit'] and other['search_id'] != first['search_id']
        return {'cli_exit_code': code, 'initial_calls': dict(initial_calls), 'recovery': recovered['recovery'],
                'source_count_after_recovery': len(recovered['results']), 'target_rank_preserved': True,
                'provider_query_and_request_identity_preserved': True,
                'target_specific_cache_and_failed_only_retry': True}

    def original_routes():
        research, artifacts = load_research(), []
        research._search_anysearch = lambda *args: [card(0), card(1)]
        plain = research.search('heat kernel estimates', 2, provider='anysearch')
        assert plain['research_target'] is None and len(plain['results']) == 2, plain
        original_artifact = research._search_artifact

        def artifact(*values):
            artifacts.append(values)
            return {'query': values[0], 'results': []}

        research._search_artifact = artifact
        research.search(QUERY, 4, TARGET, 'paper', 'a bound', 'direct')
        assert artifacts == [(QUERY, 4, TARGET, 'paper', 'a bound', 'direct')], artifacts
        research._search_artifact = original_artifact
        before = research.base.metrics.snapshot()
        invalid = [(QUERY, '', None, None), (QUERY, TARGET, 'paper', None),
                   (QUERY, TARGET, None, 'a bound'), (QUERY, None, 'paper', 'a bound')]
        for query, target, requested_artifact, proof in invalid:
            try:
                research.search(query, 4, target, requested_artifact, proof, 'direct')
                raise AssertionError('incomplete route unexpectedly accepted')
            except ValueError:
                pass
        assert research.base.metrics.snapshot() == before
        return {'no_target_route_preserved': True, 'complete_artifact_route_preserved': True,
                'invalid_routes_rejected_without_requests': len(invalid)}

    def html_follow():
        research, graph_calls = load_research(), []
        seed = 'https://arxiv.org/html/2401.27123v3#proof'
        registered = research._public_leads({'results': [{'url': seed, 'title': 'Synthetic saved HTML seed'}]})
        seed_ref = registered['results'][0]['ref']
        body = 'Synthetic previously saved HTML body, not mathematical evidence.\n'
        research.workspace.save_source(seed_ref, {'url': seed, 'resolved_url': seed, 'content_scope': 'full_text'}, body)
        registry = json.loads((bundle / 'reference-source-provenance.json').read_text())['records'][0]
        permitted_url = 'https://arxiv.org/html/2401.27124v1'
        rows = [
            {'title': 'Permitted referenced geometry', 'openAccessPdf': {'url': permitted_url}},
            {'title': 'Permitted DOI reference', 'externalIds': {'DOI': '10.5555/general-note'}},
            {'title': 'Forbidden mirror metadata', 'openAccessPdf': {
                'url': 'https://www.emergentmind.com/openai-math-explorer/papers/355.pdf?v=synthetic'}},
            {'title': registry['metadata']['title'], 'openAccessPdf': {'url': registry['identifiers'][0]}},
        ]

        def fetch_bytes(url):
            graph_calls.append(url)
            assert urlsplit(url).hostname == 'api.semanticscholar.org'
            assert parse_qs(urlsplit(url).query)['limit'] == ['4']
            return json.dumps({'data': [{'citedPaper': row} for row in rows], 'next': 4}).encode(), url, 'application/json'

        research.v1._fetch_bytes = fetch_bytes
        first = research._follow_papers(seed, 'references', 0, 4)
        assert first['seed_paper'] == 'ARXIV:2401.27123v3' and not first['cache_hit'], first
        assert len(first['results']) == 2 and first['forbidden_source_count'] == 1 and first['unverified_source_count'] == 1, first
        assert all(row['evidence_status'] == 'unread_lead' and not row['citable'] for row in first['results'])
        assert all(row['parent_paper'] == 'ARXIV:2401.27123v3' for row in first['results'])
        assert '/ARXIV:2401.27123v3/references' in unquote(urlsplit(graph_calls[0]).path)
        for alias in [seed_ref, 'https://arxiv.org/abs/2401.27123v3']:
            cached = research._follow_papers(alias, 'references', 0, 4)
            assert cached['cache_hit'] and cached['search_id'] == first['search_id'], cached
        with patch.dict(os.environ, {'DEEP_RESEARCH_SOURCE_POLICY': 'local_only'}):
            assert research._follow_papers(seed_ref, 'references', 0, 4)['cache_hit']
        assert len(graph_calls) == 1 and research.workspace.load_source(seed_ref)[1] == body
        newer = research._follow_papers('https://arxiv.org/html/2401.27123v4', 'references', 0, 4)
        assert newer['seed_paper'] == 'ARXIV:2401.27123v4' and newer['search_id'] != first['search_id']
        assert len(graph_calls) == 2
        for existing, expected in [('https://doi.org/10.5555/general-note', 'DOI:10.5555/general-note'),
                                    ('https://arxiv.org/pdf/2401.27123v3', 'ARXIV:2401.27123v3')]:
            assert research.citation_graph.paper_id(existing) == expected
        for invalid in ['https://arxiv.org/html/not-a-paper', 'https://arxiv.org.example/html/2401.27123v3']:
            try:
                research.citation_graph.paper_id(invalid)
                raise AssertionError('invalid source unexpectedly accepted')
            except ValueError:
                pass
        return {'graph_calls': graph_calls, 'source_count': len(first['results']),
                'html_url_and_saved_ref_followed': True, 'canonical_cache_and_version_identity_preserved': True,
                'source_policy_and_unread_status_preserved': True, 'saved_body_preserved': True}

    reports = []
    for name, operation in [('target_only_cli_cache_retry', target_search), ('original_search_contracts', original_routes),
                            ('html_url_ref_graph_cache', html_follow)]:
        try:
            with run_directory():
                report = operation()
            reports.append({'name': name, 'status': 'passed', **report})
        except Exception as error:
            reports.append({'name': name, 'status': 'failed', 'error': str(error)[:3000]})
    passed = all(row['status'] == 'passed' for row in reports) and not unexpected_network
    result = {'status': 'passed' if passed else 'failed', 'network': 'disabled', 'models_invoked': False,
              'base_script': str(policy.RESEARCH_SCRIPT), 'cases': reports,
              'fixture_provenance': 'Synthetic search and graph response fixtures, plus metadata-only installed held-source registry.',
              'unexpected_network': unexpected_network}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'output': str(args.output), 'cases': len(reports),
                      'failed_cases': [row['name'] for row in reports if row['status'] != 'passed']}))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
