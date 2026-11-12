"""Exercise an installed bundle's real CLI/cache/REF code with network disabled.

Run with the bundle's dependency-complete Python interpreter. Fixtures belong to
the repository; --bundle chooses the separately installed, frozen base helper.
"""
import argparse
from collections import Counter
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
from urllib.parse import parse_qs, urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    fixtures = Path(__file__).with_name('fixtures') / 'campaign-reference'
    sys.path.insert(0, str(bundle))
    spec = importlib.util.spec_from_file_location('installed_campaign_policy', bundle / 'reference-search-policy.py')
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)

    def no_network(*args, **kwargs):
        raise AssertionError('network is disabled in campaign reference replay')

    socket.create_connection = no_network
    socket.socket.connect = no_network
    research = policy.load_research()
    research.base.requests.sessions.Session.send = no_network
    old_search_id = research.workspace.search_id
    from campaign_reference import arxiv_query, install
    install(research)
    policy.install_source_policy(research)
    empty = '<feed xmlns="http://www.w3.org/2005/Atom" />'
    cases = json.loads((fixtures / 'saved-searches.json').read_text())
    reports = []
    for index, case in enumerate(cases):
        with tempfile.TemporaryDirectory() as directory:
            os.environ['DEEP_RESEARCH_RUN_DIR'] = directory
            os.environ['DEEP_RESEARCH_SOURCE_POLICY'] = 'mixed'
            os.environ.pop('DRBENCH_RUN_DIR', None)
            request = case['request']
            # Put an authentic old request-shaped record in the unversioned slot.
            old_id = old_search_id(request)
            old_file = research.workspace.root() / 'searches' / (old_id + '.json')
            old_record = {'id': old_id, 'request': request, 'result': case, 'searched_at': '2026-11-10T17:22:23+00:00'}
            research.workspace._write_json(old_file, old_record)
            previous_body = 'A previously saved permitted reference about spectral radius.\n'
            previous_url = 'https://arxiv.org/abs/2401.12345'
            previous_ref = research._source_ref(previous_url)
            research.workspace.save_source(previous_ref, {'url': previous_url, 'resolved_url': previous_url,
                                                          'title': 'Saved reference', 'content_scope': 'full_text'}, previous_body)
            research._save_refs({previous_ref: previous_url})
            calls = Counter()
            failing = {'enabled': True}

            def get(url):
                parsed = urlsplit(url)
                calls[parsed.netloc] += 1
                if parsed.netloc == 'export.arxiv.org':
                    query = parse_qs(parsed.query)['search_query'][0]
                    phrase = arxiv_query('psd rank' if index == 0 else 'semidefinite extension complexity')
                    body = (fixtures / ('psdrank1.xml' if index == 0 else 'sdpext.xml')).read_text() if query == phrase else empty
                    return body, url
                if parsed.netloc == 'api.openalex.org':
                    return json.dumps({'results': [{'display_name': row['title'], 'external_id': row['url'],
                                                    'hint': row['snippet'].split(' | ')[0]}
                                                   for row in case['results'] if row['engine'] == 'openalex']}), url
                raise AssertionError('unmocked provider: ' + url)

            def anysearch(*args):
                calls['anysearch'] += 1
                if failing['enabled']:
                    raise RuntimeError('saved no-parseable-cards failure')
                return []

            def duckduckgo(*args):
                calls['duckduckgo'] += 1
                if failing['enabled']:
                    raise RuntimeError('saved timeout')
                return []

            def bing(*args, **kwargs):
                calls['bing'] += 1
                return [row for row in case['results'] if row['engine'] != 'openalex']

            research.base._get = get
            research._search_anysearch, research._duckduckgo, research.base._bing = anysearch, duckduckgo, bing
            arguments = (request['query'], request['limit'], None, None, None, request['provider'])
            first = research._ref_search(*arguments)
            assert not first['cache_hit'] and first['search_id'] != old_id
            assert first['results'] and all(row['relevance'] in ('matching', 'background') for row in first['results'])
            assert all(row['engine'] in ('arxiv', 'openalex') for row in first['results'])
            before_cached = calls.copy()
            cached = research._ref_search(*arguments)
            assert cached['cache_hit'] and calls == before_cached
            assert json.loads(old_file.read_text()) == old_record
            assert research.workspace.load_source(previous_ref)[1] == previous_body
            read = research._ref_read(previous_ref, ['spectral'], 650)
            assert read['cache_hit'] and read['ref'] == previous_ref
            failing['enabled'] = False
            before_recovery = calls.copy()
            recovered = research._ref_search(*arguments, retry_failed=True)
            assert calls['export.arxiv.org'] == before_recovery['export.arxiv.org']
            assert calls['api.openalex.org'] == before_recovery['api.openalex.org']
            assert recovered['recovery']['deferred_new_requests'] == 0
            assert recovered['recovery']['retried_requests'] == (2 if request['provider'] == 'auto' else 1)
            assert research.workspace.load_source(previous_ref)[1] == previous_body
            reports.append({'query': request['query'], 'old_search_id': old_id, 'new_search_id': first['search_id'],
                            'first_cache_hit': first['cache_hit'], 'second_cache_hit': cached['cache_hit'],
                            'previous_cache_preserved': True, 'previous_ref_read': True,
                            'mock_calls': dict(calls), 'remaining_gaps': first['recall_checks']['remaining_gaps'],
                            'relevance_summary': first['relevance_summary'], 'recovery': recovered['recovery'],
                            'academic_recall': first['discovery_diagnostics']['academic_recall'], 'status': first['status']})
    help_result = subprocess.run([str(bundle / 'reference-search'), '--help'], text=True, capture_output=True)
    assert help_result.returncode == 0, help_result.stderr
    output = {'network': 'disabled', 'base_script': str(policy.RESEARCH_SCRIPT), 'cli_help': 'passed', 'cases': reports}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'output': str(args.output), 'cases': len(reports), 'network': 'disabled', 'cli_help': 'passed'}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
