"""Campaign source exclusions around the installed research CLI; no answer corpus is loaded."""
import importlib.util
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

CONFIG_FILE = Path(__file__).with_name('reference-search-config.json')
CONFIG = json.loads(CONFIG_FILE.read_text()) if CONFIG_FILE.exists() else {}
RESEARCH_SCRIPT = Path(CONFIG.get('researchScript', Path.home() / '.codex/skills/deep-research/scripts/research.py'))
FORBIDDEN_LOCAL_ROOTS = (
    Path('/home/lzh/openai-math-upstream'),
    Path('/home/lzh/reports/openai-math-difficulty-2026-10-22/sources'),
) + tuple(Path(root).expanduser().resolve() for root in CONFIG.get('forbiddenLocalRoots', []))
REPOSITORY = re.compile(r'(?:^|[/\s:=?&])openai/math(?:$|[/\s.?#&])', re.I)
REPOSITORY_ALIAS = re.compile(r'/openai[-_]math(?:$|[/._?#&])', re.I)
LABELLED_ANSWERS = re.compile(
    r'\bopenai[ _-]+math\b.{0,100}\b(?:answers?|solutions?|benchmark|mirror|fork)\b|'
    r'\b(?:answers?|solutions?|mirror|fork)\b.{0,100}\bopenai[ _-]+math\b|'
    r'openai\s*(?:的\s*)?math.{0,30}(?:答案|解答|镜像)', re.I)


def forbidden_source(source, label=''):
    value = str(source)
    for _ in range(3):
        decoded = unquote(value)
        if decoded == value:
            break
        value = decoded
    value = value.replace('\\', '/')
    if REPOSITORY.search(value) or REPOSITORY_ALIAS.search(value) or LABELLED_ANSWERS.search(str(label)):
        return True
    if not value.startswith(('http://', 'https://', 'REF-')):
        path = Path(urlsplit(value).path if value.startswith('file:') else value).expanduser().resolve()
        return any(path == root or root in path.parents for root in FORBIDDEN_LOCAL_ROOTS)
    return False


def require_permitted(source, label=''):
    if forbidden_source(source, label):
        raise PermissionError('reference_source_forbidden: OpenAI Math answers, copies and mirrors are excluded')


def install_source_policy(research):
    original_url_ok = research.base._url_ok
    research.base._url_ok = lambda url: not forbidden_source(url) and original_url_ok(url)

    # requests follows redirects through Session.send, so reject each destination before sending.
    requests = research.base.requests
    original_send = requests.sessions.Session.send

    def send(session, request, **kwargs):
        require_permitted(request.url)
        return original_send(session, request, **kwargs)

    requests.sessions.Session.send = send
    original_read = research.read_page

    def read_page(url, *args, **kwargs):
        require_permitted(url)
        result = original_read(url, *args, **kwargs)
        require_permitted(result.get('resolved_url') or result.get('url') or url, result.get('title', ''))
        return result

    research.read_page = read_page
    original_load = research.workspace.load_source

    def load_source(ref, version=None, *, run_root=None):
        # Check metadata before the original loader opens the cached body (read/open/find).
        folder = research.workspace._source_dir(ref, run_root=run_root)
        if version is not None and not re.fullmatch(r'[0-9a-f]{64}', version):
            raise ValueError('invalid source snapshot version')
        metadata_file = folder / (f'{version}.json' if version else 'metadata.json')
        if metadata_file.exists():
            metadata = json.loads(metadata_file.read_text())
            for key in ('url', 'resolved_url', 'citation_url'):
                if metadata.get(key):
                    require_permitted(metadata[key], metadata.get('title', ''))
        return original_load(ref, version, run_root=run_root)

    research.workspace.load_source = load_source
    original_leads = research._public_leads

    def public_leads(result):
        rows = result.get('results', [])
        permitted = [row for row in rows if isinstance(row, dict) and not forbidden_source(
            row.get('url', ''), str(row.get('title', '')) + ' ' + str(row.get('snippet', '')))]
        output = original_leads({**result, 'results': permitted})
        output['source_policy'] = 'public_references_excluding_openai_math_answers'
        output['excluded_source_count'] = len(rows) - len(permitted)
        return output

    research._public_leads = public_leads


def load_research():
    spec = importlib.util.spec_from_file_location('campaign_public_research', RESEARCH_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if len(sys.argv) > 2 and sys.argv[1] == 'search':
        require_permitted(sys.argv[2], sys.argv[2])
    research = load_research()
    from campaign_reference import install
    install(research)
    install_source_policy(research)
    return research.main()


if __name__ == '__main__':
    raise SystemExit(main())
