#!/usr/bin/env python3
"""Install the versioned campaign adapter into an explicitly chosen directory."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil

BASE_SCRIPTS = ('research.py', 'search_candidate.py', 'search.py', 'run_metrics.py',
                'anysearch_provider.py', 'workspace.py', 'reporting.py', 'citation_graph.py',
                'evaluation.py', 'calibration.py', 'paired_evaluation.py', 'claim_review.py',
                'fixed_corpus.py', 'search_feedback.py', 'provider_cache.py')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dest', type=Path, required=True)
    parser.add_argument('--research-script', type=Path, required=True)
    parser.add_argument('--python', type=Path, required=True, dest='interpreter')
    parser.add_argument('--forbidden-local-root', action='append', default=[])
    parser.add_argument('--source-provenance', type=Path,
                        default=Path(__file__).with_name('reference-source-provenance.json'),
                        help='Versioned metadata-only registry of unresolved public source identities')
    args = parser.parse_args()
    script, interpreter = args.research_script.resolve(), args.interpreter.absolute()
    if not script.is_file() or not interpreter.is_file() or not os.access(interpreter, os.X_OK):
        parser.error('research-script and executable Python interpreter must exist')
    missing = [name for name in BASE_SCRIPTS if not script.with_name(name).is_file()]
    if missing:
        parser.error('research helper dependency missing: ' + ', '.join(missing))
    policy_spec = importlib.util.spec_from_file_location('campaign_install_source_policy', Path(__file__).with_name('reference-search-policy.py'))
    policy = importlib.util.module_from_spec(policy_spec)
    policy_spec.loader.exec_module(policy)
    policy.load_source_provenance(args.source_provenance)
    dest = args.dest.resolve()
    dest.mkdir(parents=True, exist_ok=True)
    base = dest / 'base'
    base.mkdir(exist_ok=True)
    hashes = {}
    for name in BASE_SCRIPTS:
        source = script.with_name(name)
        data = source.read_bytes()
        hashes[name] = hashlib.sha256(data).hexdigest()
        (base / name).write_bytes(data)
    for name in ('campaign_reference.py', 'reference-search-policy.py'):
        shutil.copyfile(Path(__file__).with_name(name), dest / name)
    shutil.copyfile(args.source_provenance, dest / 'reference-source-provenance.json')
    config = {'researchScript': str(base / script.name), 'forbiddenLocalRoots': args.forbidden_local_root}
    (dest / 'reference-search-config.json').write_text(json.dumps(config, indent=2) + '\n')
    launcher = '''#!/bin/sh
export PYTHONDONTWRITEBYTECODE=1
export DEEP_RESEARCH_SOURCE_POLICY=mixed
export DEEP_RESEARCH_SEARCH_PROVIDER="${DEEP_RESEARCH_SEARCH_PROVIDER:-auto}"
exec ''' + shlex.quote(str(interpreter)) + ''' -B "$(dirname "$0")/reference-search-policy.py" "$@"
'''
    (dest / 'reference-search').write_text(launcher)
    (dest / 'reference-search').chmod(0o755)
    manifest = {'sourceResearchScript': str(script), 'baseSourceHashes': hashes,
                'python': str(interpreter), 'files': {str(p.relative_to(dest)): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in sorted(dest.rglob('*')) if p.is_file() and p.name != 'reference-search-manifest.json'}}
    (dest / 'reference-search-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'directory': str(dest), 'manifest': str(dest / 'reference-search-manifest.json')}, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
