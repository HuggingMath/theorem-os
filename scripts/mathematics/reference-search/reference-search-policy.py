"""Campaign source exclusions around the installed research CLI; no answer corpus is loaded."""
import importlib.util
import json
import os
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


def decoded_source(source):
    value = str(source).strip()
    for _ in range(3):
        decoded = unquote(value)
        if decoded == value:
            break
        value = decoded
    return value.replace('\\', '/')


def source_identifiers(source, metadata=None):
    """Compare public identifiers without dereferencing a DOI or opening a body."""
    values = [source]
    metadata = metadata or {}
    values.extend(metadata.get(key, '') for key in ('url', 'resolved_url', 'citation_url', 'doi', 'openalex_id'))
    values.extend(row.get('url', '') for row in metadata.get('alternate_sources') or [] if isinstance(row, dict))
    identifiers = set()
    for value in values:
        value = decoded_source(value)
        doi = re.fullmatch(r'(?:doi:\s*|https?://(?:www\.)?(?:dx\.)?doi\.org/)?(10\.\d{4,9}/[^\s?#]+)(?:[?#].*)?', value, re.I)
        if doi:
            identifiers.add('doi:' + doi[1].casefold().rstrip('/'))
        try:
            parsed = urlsplit(value)
            port = parsed.port
        except ValueError:
            continue
        if parsed.scheme.casefold() in ('http', 'https') and parsed.hostname:
            host = parsed.hostname.casefold()
            if port is not None and (parsed.scheme.casefold(), port) not in (('http', 80), ('https', 443)):
                host += ':' + str(port)
            identifiers.add('url:' + host + parsed.path.rstrip('/') + ('?' + parsed.query if parsed.query else ''))
    return identifiers


def load_source_provenance(file):
    data = json.loads(Path(file).read_text())
    if data.get('schema') != 'theorem-os.reference-source-provenance.v1' or not isinstance(data.get('records'), list):
        raise ValueError('invalid reference source provenance registry')
    records = []
    for row in data['records']:
        if not isinstance(row, dict) or row.get('status') != 'unverified' or not isinstance(row.get('id'), str) or \
                not isinstance(row.get('identifiers'), list) or not row['identifiers'] or not all(isinstance(value, str) for value in row['identifiers']):
            raise ValueError('invalid reference source provenance record')
        identifiers = set().union(*(source_identifiers(value) for value in row['identifiers']))
        if not identifiers:
            raise ValueError('reference source provenance record needs a public identifier')
        records.append({**row, '_identifiers': identifiers})
    return records


SOURCE_PROVENANCE_FILE = Path(__file__).with_name('reference-source-provenance.json')
SOURCE_PROVENANCE = load_source_provenance(SOURCE_PROVENANCE_FILE)


def unverified_source(source, metadata=None):
    identifiers = source_identifiers(source, metadata)
    return next((record for record in SOURCE_PROVENANCE if identifiers & record['_identifiers']), None)


def forbidden_source(source, label=''):
    value = decoded_source(source)
    if REPOSITORY.search(value) or REPOSITORY_ALIAS.search(value) or LABELLED_ANSWERS.search(str(label)):
        return True
    if not value.startswith(('http://', 'https://', 'REF-')):
        path = Path(urlsplit(value).path if value.startswith('file:') else value).expanduser().resolve()
        return any(path == root or root in path.parents for root in FORBIDDEN_LOCAL_ROOTS)
    return False


def require_permitted(source, label='', metadata=None):
    if forbidden_source(source, label):
        raise PermissionError('reference_source_forbidden: OpenAI Math answers, copies and mirrors are excluded')
    if unverified_source(source, metadata):
        raise PermissionError('reference_source_provenance_unverified: establish permitted provenance from metadata before reading')


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
        require_permitted(result.get('resolved_url') or result.get('url') or url, result.get('title', ''), result)
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
                    require_permitted(metadata[key], metadata.get('title', ''), metadata)
            require_permitted('', metadata.get('title', ''), metadata)
        return original_load(ref, version, run_root=run_root)

    research.workspace.load_source = load_source
    original_leads = research._public_leads

    def public_leads(result):
        rows = result.get('results', [])
        permitted, unresolved, forbidden_count = [], [], 0
        for row in rows:
            if not isinstance(row, dict):
                continue
            label = str(row.get('title', '')) + ' ' + str(row.get('snippet', ''))
            sources = [row.get('url', ''), *(item.get('url', '') for item in row.get('alternate_sources') or [] if isinstance(item, dict))]
            if any(forbidden_source(source, label) for source in sources):
                forbidden_count += 1
                continue
            provenance = unverified_source(row.get('url', ''), row)
            if provenance:
                unresolved.append({'title': row.get('title', ''), 'engine': row.get('engine'),
                                   'provenance_record': provenance['id'], 'source_status': 'unverified', 'citable': False})
                continue
            permitted.append(row)
        output = original_leads({**result, 'results': permitted})
        output['source_policy'] = 'public_references_excluding_openai_math_answers'
        output['excluded_source_count'] = forbidden_count + len(unresolved)
        output['forbidden_source_count'] = forbidden_count
        output['unverified_source_count'] = len(unresolved)
        if unresolved:
            output['unverified_sources'] = unresolved
            output['next_action'] += ' Some source identities need permitted provenance established from metadata; they have not been registered as readable REFs.'
        return output

    research._public_leads = public_leads


def load_research():
    spec = importlib.util.spec_from_file_location('campaign_public_research', RESEARCH_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def configure_run_directory(argv):
    """An explicit anchor keeps changing cwd from selecting a campaign-global store."""
    args = list(argv)
    run_directory = None
    if args[:1] == ['--run-dir']:
        if len(args) < 2 or not args[1]:
            raise ValueError('reference_run_directory_required: --run-dir requires an absolute worker-local directory')
        run_directory, args = args[1], args[2:]
    if not args or args[0] in ('-h', '--help'):
        return args
    run_directory = run_directory or os.environ.get('DRBENCH_RUN_DIR') or os.environ.get('DEEP_RESEARCH_RUN_DIR')
    if not run_directory or not Path(run_directory).is_absolute():
        raise ValueError('reference_run_directory_required: use --run-dir /absolute/worker/.scratch/reference-search before the command')
    # The base helper gives DRBENCH_RUN_DIR precedence. Set both so an explicit
    # command anchor cannot be silently redirected by an inherited environment.
    os.environ['DRBENCH_RUN_DIR'] = run_directory
    os.environ['DEEP_RESEARCH_RUN_DIR'] = run_directory
    return args


def main():
    try:
        sys.argv[1:] = configure_run_directory(sys.argv[1:])
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    if sys.argv[1:] == ['--help']:
        print('Campaign option: --run-dir /absolute/worker/.scratch/reference-search precedes the command.\n')
    if len(sys.argv) > 2 and sys.argv[1] == 'search':
        require_permitted(sys.argv[2], sys.argv[2])
    research = load_research()
    from campaign_reference import install
    install(research)
    install_source_policy(research)
    return research.main()


if __name__ == '__main__':
    raise SystemExit(main())
