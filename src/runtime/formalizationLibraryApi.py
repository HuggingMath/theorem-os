"""Inspect installed declaration names and types inside one formalization role."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        'Names are exact and case-sensitive. Queries are literal, case-insensitive '
        'substrings of installed declaration names, not mathematical or proof search. '
        'Queries return names and module metadata only; use --name for full types and fields. '
        'Batch related lookups in one invocation. No match does not establish that '
        'a mathematical concept is absent. Types are advisory, not proof acceptance.'))
    parser.add_argument('--name', action='append', default=[], help='Exact name to inspect full types and fields (repeatable, up to 32).')
    parser.add_argument('--query', action='append', default=[], help='Name fragment to discover names and module metadata (repeatable, up to 8).')
    parser.add_argument('--limit', type=int, default=4, help='Matches per query, 1..8 (default 4).')
    args = parser.parse_args()
    if not args.name and not args.query:
        parser.error('At least one --name or --query is required.')
    if len(args.name) > 32 or len(args.query) > 8 or not 1 <= args.limit <= 8:
        parser.error('Use at most 32 names, 8 queries and --limit 1..8.')
    for value in args.name + args.query:
        if not value.strip() or len(value.encode('utf-8')) > 512:
            parser.error('Each name or query must be nonempty and at most 512 UTF-8 bytes.')
    directory = Path(__file__).resolve().parent
    # All paths and the Lean program are host-mounted read-only. Query strings
    # remain JSON data; they are never interpolated into Lean or shell commands.
    with tempfile.TemporaryDirectory(prefix='library-api-') as temporary:
        work = Path(temporary)
        (work / '.lake').mkdir()
        (work / '.lake/library-api-query.json').write_text(json.dumps({
            'names': list(dict.fromkeys(args.name)), 'queries': list(dict.fromkeys(args.query)),
            'limit': args.limit}), encoding='utf-8')
        result = subprocess.run(['/opt/lean/bin/lean', str(directory / 'library-api.lean')],
                                cwd=work, capture_output=True, text=True, timeout=90)
        if result.returncode:
            sys.stderr.write((result.stdout + result.stderr)[:16000])
            return result.returncode
        output = work / '.lake/library-api.json'
        if not output.is_file():
            raise RuntimeError('Lean did not export library API observations.')
        if output.stat().st_size > 256000:
            raise RuntimeError('Library API output exceeds 256000 bytes; request fewer names or a smaller --limit.')
        # Reject invalid JSON rather than reporting a successful empty lookup.
        value = json.loads(output.read_text(encoding='utf-8'))
        print(json.dumps(value, ensure_ascii=False, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
