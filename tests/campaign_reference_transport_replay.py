"""Replay provider HTTP transport with real bundle metrics and fake responses.

No sockets, model calls or sleeps are used. Synthetic HTTP responses exercise
the installed timeout adapter, source guard, budgets and provider recovery.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from threading import Barrier, Lock
from unittest.mock import patch
from urllib.parse import urlsplit


DDG = 'https://html.duckduckgo.com/html/?q=synthetic'
ARXIV = 'https://export.arxiv.org/api/query?search_query=synthetic'
MIRROR = 'https://www.emergentmind.com/openai-math-explorer/papers/355.pdf?v=synthetic'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    sys.path.insert(0, str(bundle))
    spec = importlib.util.spec_from_file_location('transport_replay_policy',
                                                bundle / 'reference-search-policy.py')
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    unexpected_network = []

    def no_network(*args, **kwargs):
        unexpected_network.append('network attempted')
        raise AssertionError('network disabled in transport replay')

    socket.create_connection = no_network
    socket.socket.connect = no_network
    research = policy.load_research()
    research.base.requests.sessions.Session.send = no_network
    research.base._url_ok = lambda url: url.startswith(('https://', 'http://'))
    from campaign_reference import install
    install(research)
    policy.install_source_policy(research)
    requests = research.base.requests

    class Response:
        def __init__(self, url, body=b'synthetic response', *, status=200, headers=None,
                     encoding='utf-8'):
            self.url, self.content, self.status_code = url, body, status
            self.headers, self.encoding = headers or {}, encoding
            self.cookies = requests.cookies.RequestsCookieJar()
            self.request = self.raw = None
            self.closed = False

        def raise_for_status(self):
            if self.status_code >= 400:
                raise requests.exceptions.HTTPError('synthetic status')

        def close(self):
            self.closed = True

    @contextmanager
    def run_directory():
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                'DEEP_RESEARCH_RUN_DIR': directory, 'DRBENCH_RUN_DIR': directory,
                'DEEP_RESEARCH_SOURCE_POLICY': 'mixed', 'DRBENCH_MAX_REQUESTS': '0',
                'DEEP_RESEARCH_MAX_REQUESTS': '0', 'DRBENCH_ACADEMIC_SEARCH': '0',
                'DRBENCH_PRACTITIONER_SEARCH': '0'}):
            yield

    def endpoint_timeouts():
        calls, responses = [], []

        def get(url, **kwargs):
            calls.append((url, kwargs))
            response = Response(url, b'caf\xe9', encoding='latin-1')
            responses.append(response)
            return response

        requests.get = get
        short = [DDG, 'https://html.duckduckgo.com/html?q=synthetic',
                 'https://html.duckduckgo.com:443/html/?q=synthetic']
        unchanged = [ARXIV, 'https://www.bing.com/search?q=synthetic',
                     'https://html.duckduckgo.com/other?q=synthetic',
                     'https://html.duckduckgo.com:444/html/?q=synthetic',
                     'http://html.duckduckgo.com/html/?q=synthetic',
                     'https://example.org/html/?q=synthetic']
        for url in short + unchanged:
            text, resolved = research.base._get(url)
            assert text == 'caf\xe9' and resolved == url
        assert [kwargs['timeout'] for _, kwargs in calls] == [4] * len(short) + [15] * len(unchanged), calls
        assert research.base.TIMEOUT == 15
        assert all(not kwargs['allow_redirects'] and kwargs['headers']['User-Agent'] == research.base.UA
                   for _, kwargs in calls)
        assert all(response.closed for response in responses)
        # Response truncation is still the original byte-based bound.
        requests.get = lambda url, **kwargs: Response(url, b'x' * (research.base.MAX_BYTES + 10))
        assert len(research.base._get(DDG)[0]) == research.base.MAX_BYTES
        assert research._provider_config([])['campaign_duckduckgo_timeout_seconds'] == 4
        return {'short_endpoint_count': len(short), 'unchanged_endpoint_count': len(unchanged),
                'base_timeout': research.base.TIMEOUT, 'encoding_and_byte_limit_preserved': True}

    def failure_budget():
        calls = []

        def get(url, **kwargs):
            calls.append(kwargs['timeout'])
            raise requests.exceptions.ReadTimeout('synthetic timeout')

        requests.get = get
        os.environ['DRBENCH_MAX_REQUESTS'] = '1'
        try:
            research.base._get(DDG)
            raise AssertionError('expected transport timeout')
        except requests.exceptions.ReadTimeout:
            pass
        try:
            research.base._get(DDG)
            raise AssertionError('expected request budget rejection')
        except RuntimeError as error:
            assert 'requests budget exhausted' in str(error), error
        counts = research.base.metrics.snapshot()
        assert calls == [4], calls
        assert counts['requests'] == 1 and counts['request_errors'] == 1 and counts['blocked'] == 1, counts
        assert counts['request_seconds'] >= 0 and counts['read'] == 0, counts
        return {'sender_timeouts': calls, 'metrics': counts}

    def redirects():
        calls, responses = [], []
        destination = {'url': 'https://example.org/search-result'}

        def get(url, **kwargs):
            calls.append((url, kwargs['timeout']))
            response = (Response(url, status=302, headers={'Location': destination['url']})
                        if url == DDG else Response(url))
            responses.append(response)
            return response

        requests.get = get
        assert research.base._get(DDG)[1] == destination['url']
        destination['url'] = MIRROR
        try:
            research.base._get(DDG)
            raise AssertionError('expected forbidden redirect destination rejection')
        except (ValueError, PermissionError) as error:
            assert 'blocked' in str(error) or 'reference_source_forbidden' in str(error), error
        counts = research.base.metrics.snapshot()
        assert len(calls) == 3 and all(timeout == 4 for _, timeout in calls), calls
        assert all(url != MIRROR for url, _ in calls), calls
        assert all(response.closed for response in responses)
        assert counts['requests'] == 3 and counts['redirects'] == 2, counts
        return {'sent_urls': [url for url, _ in calls], 'metrics': counts,
                'forbidden_destination_never_sent': True}

    def provider_recovery():
        query, calls = 'heat kernel estimates', []
        recovering = {'enabled': False}

        def get(url, **kwargs):
            calls.append((urlsplit(url).hostname, kwargs['timeout']))
            if urlsplit(url).hostname == 'html.duckduckgo.com':
                if not recovering['enabled']:
                    raise requests.exceptions.ReadTimeout('synthetic provider timeout')
                body = ''.join('<div class="result"><a class="result__a" href="https://arxiv.org/abs/2401.2600'
                               + str(index) + 'v1">Heat kernel estimates ' + str(index)
                               + '</a><span class="result__snippet">Synthetic heat kernel estimates</span></div>'
                               for index in (2, 3))
            elif urlsplit(url).hostname == 'www.bing.com':
                body = '<rss><channel>' + ''.join('<item><title>Heat kernel estimates '
                                                + str(index) + '</title><link>https://arxiv.org/abs/2401.2600'
                                                + str(index) + 'v1</link><description>Synthetic heat kernel estimates</description></item>'
                                                for index in (0, 1)) + '</channel></rss>'
            else:
                raise AssertionError('unexpected provider URL: ' + url)
            return Response(url, body.encode())

        requests.get = get
        arguments = (query, 4, None, None, None, 'direct')
        first = research._ref_search(*arguments)
        assert first['status'] == 'partial' and len(first['results']) == 2, first
        before_cached = list(calls)
        assert research._ref_search(*arguments)['cache_hit'] and calls == before_cached
        recovering['enabled'] = True
        recovered = research._ref_search(*arguments, retry_failed=True)
        assert calls == [('html.duckduckgo.com', 4), ('www.bing.com', 15), ('html.duckduckgo.com', 4)], calls
        assert len(recovered['results']) == 4 and not recovered.get('provider_errors'), recovered
        assert recovered['recovery']['retried_requests'] == 1 and recovered['recovery']['deferred_new_requests'] == 0
        saved = research.workspace.load_search({'query': query, 'limit': 4, 'target': None,
                                                'artifact': None, 'proof': None, 'provider': 'direct'})['result']
        records = saved['provider_execution']['records']
        assert len(records) == 2 and all(row['request'] == {'query': query, 'limit': 8} for row in records), records
        assert research._ref_search(*arguments)['cache_hit'] and len(calls) == 3
        counts = research.base.metrics.snapshot()
        assert counts['requests'] == 3 and counts['request_errors'] == 1, counts
        return {'http_calls': calls, 'recovery': recovered['recovery'],
                'source_count': len(recovered['results']), 'provider_request_identity_preserved': True,
                'cache_reused_without_requests': True}

    def concurrent_isolation():
        barrier, lock, calls = Barrier(2), Lock(), []

        def get(url, **kwargs):
            with lock:
                calls.append((url, kwargs['timeout'], research.base.TIMEOUT))
            barrier.wait(timeout=2)
            return Response(url)

        requests.get = get
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(research.base._get, (DDG, ARXIV)))
        assert len(responses) == 2
        assert {url: timeout for url, timeout, _ in calls} == {DDG: 4, ARXIV: 15}, calls
        assert all(global_timeout == 15 for _, _, global_timeout in calls) and research.base.TIMEOUT == 15, calls
        counts = research.base.metrics.snapshot()
        assert counts['requests'] == 2 and counts['request_errors'] == 0, counts
        return {'calls': calls, 'base_timeout_unchanged_during_overlap': True, 'metrics': counts}

    reports = []
    for name, operation in [('endpoint_timeouts', endpoint_timeouts), ('failure_budget', failure_budget),
                            ('redirects_and_source_guard', redirects), ('provider_retry_identity', provider_recovery),
                            ('concurrent_timeout_isolation', concurrent_isolation)]:
        try:
            with run_directory():
                report = operation()
            reports.append({'name': name, 'status': 'passed', **report})
        except Exception as error:
            reports.append({'name': name, 'status': 'failed', 'error': str(error)[:2000]})
    passed = all(row['status'] == 'passed' for row in reports) and not unexpected_network
    result = {'status': 'passed' if passed else 'failed', 'network': 'disabled', 'models_invoked': False,
              'fixture_provenance': 'Synthetic requests.get responses and failures; real installed metrics and provider cache.',
              'base_script': str(policy.RESEARCH_SCRIPT), 'cases': reports,
              'unexpected_network': unexpected_network}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'cases': len(reports), 'output': str(args.output),
                      'failed_cases': [row['name'] for row in reports if row['status'] != 'passed']}))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
