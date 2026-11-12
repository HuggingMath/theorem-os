"""Read known academic documents before falling back to their abstracts.

The outer research reader still owns REF lookup and snapshots. This adapter uses
the existing reader's request, extraction, policy and budget helpers; it does not
search for another paper or invent publisher URLs.
"""
from __future__ import annotations

import json
import os
import re
from urllib.parse import quote, urlencode, urlsplit

MAX_OPEN_ACCESS_CANDIDATES = 2
ARXIV_ID = r'(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*/\d{7})(?:v\d+)?'


def arxiv_identity(url):
    parsed = urlsplit(url)
    if parsed.hostname in ('doi.org', 'www.doi.org', 'dx.doi.org'):
        match = re.fullmatch(r'/10\.48550/arxiv\.(' + ARXIV_ID + r')/?', parsed.path, re.I)
        return ('abs', match[1]) if match else None
    if parsed.hostname not in ('arxiv.org', 'www.arxiv.org', 'export.arxiv.org'):
        return None
    match = re.fullmatch(r'/(abs|pdf|html)/(' + ARXIV_ID + r')(?:\.pdf)?/?', parsed.path, re.I)
    return (match[1].casefold(), match[2]) if match else None


def _arxiv_candidates(url, identity):
    kind, identifier = identity
    canonical = 'https://arxiv.org/'
    candidates = ([(url, 'arxiv_html'), (canonical + 'pdf/' + identifier, 'arxiv_pdf')]
                  if kind == 'html' else
                  [(url if kind == 'pdf' else canonical + 'pdf/' + identifier, 'arxiv_pdf'),
                   (canonical + 'html/' + identifier, 'arxiv_html')])
    candidates.append((url if kind == 'abs' else canonical + 'abs/' + identifier, 'arxiv_abstract'))
    return candidates


def _open_access_urls(record):
    locations = [record.get('best_oa_location'), record.get('primary_location')]
    locations.extend(record.get('locations') or [])
    candidates = []
    for location in locations:
        if not isinstance(location, dict) or location.get('is_oa') is not True:
            continue
        for key in ('pdf_url', 'landing_page_url'):
            value = location.get(key)
            if isinstance(value, str) and value.startswith(('http://', 'https://')) and value not in candidates:
                candidates.append(value)
    opened = record.get('open_access') or {}
    value = opened.get('oa_url') if opened.get('is_oa') is True else None
    if isinstance(value, str) and value.startswith(('http://', 'https://')) and value not in candidates:
        candidates.append(value)
    return candidates[:MAX_OPEN_ACCESS_CANDIDATES]


def install(research):
    reader = research.v1
    if getattr(reader, '_campaign_academic_reader', False):
        return
    reader._campaign_academic_reader = True
    original = reader.read_page

    def read_page(url, terms, window=650, max_windows=5, *, include_body=False):
        identity = arxiv_identity(url)
        openalex_id = reader._openalex_id_from_url(url)
        doi = reader._doi_from_url(url)
        if not identity and not openalex_id and not doi:
            return original(url, terms, window, max_windows, include_body=include_body)
        policy = (os.environ.get('DEEP_RESEARCH_SOURCE_POLICY') or
                  os.environ.get('DRBENCH_SOURCE_POLICY', 'web_allowed')).strip().casefold()
        if policy not in ('local_only', 'web_allowed', 'mixed'):
            raise ValueError('unsupported source policy: ' + policy)
        if policy == 'local_only':
            raise RuntimeError('web reading is disabled by source_policy=local_only')
        reader.base._reserve('read')
        attempts, errors = [], []
        abstract = None
        page = None
        if identity:
            candidates = _arxiv_candidates(url, identity)
        else:
            identifier = openalex_id or 'https://doi.org/' + doi
            metadata_url = 'https://api.openalex.org/works/' + quote(identifier, safe='') + '?' + urlencode({
                'select': 'id,display_name,doi,abstract_inverted_index,best_oa_location,open_access,primary_location,locations'})
            record = {}
            try:
                body, resolved = reader.base._get(metadata_url)
                record = json.loads(body)
                if not isinstance(record, dict):
                    raise ValueError('unexpected OpenAlex document metadata')
                attempts.append({'url': metadata_url, 'status': 'metadata'})
                text = reader._normalise_text(reader._abstract(record))
                if text:
                    abstract = (reader.base._clean(record.get('display_name') or '', 240), text,
                                resolved, 'openalex_abstract', 'openalex_abstract', {}, 'abstract')
            except Exception as error:
                record = {}
                message = str(error)[:1000]
                attempts.append({'url': metadata_url, 'status': 'error', 'error': message})
                errors.append(metadata_url + ': ' + message)
            candidates = [(value, 'openalex_open_access') for value in _open_access_urls(record)]
            # OpenAlex work pages contain metadata; a DOI may resolve to the actual paper.
            if doi:
                candidates.append((url, 'direct'))
            else:
                recorded_doi = record.get('doi')
                if isinstance(recorded_doi, str) and urlsplit(recorded_doi).hostname in (
                        'doi.org', 'www.doi.org', 'dx.doi.org') and reader._doi_from_url(recorded_doi):
                    candidates.append((recorded_doi, 'openalex_doi'))
        seen = set()
        selected = None
        for target, label in candidates:
            if target in seen:
                continue
            seen.add(target)
            details = {}
            try:
                raw, fetched_url, mime = reader._fetch_bytes(target)
                if raw.startswith(b'%PDF') or 'application/pdf' in mime.casefold():
                    title, text = reader._pdf_text(raw, details)
                    content_type = 'pdf'
                elif mime.split(';', 1)[0].casefold() in ('text/plain', 'text/markdown', 'application/json'):
                    title, text = '', reader._document_text(raw.decode('utf-8', errors='replace'))
                    content_type = 'text'
                else:
                    encoding = re.search(r'charset=([^; ]+)', mime, re.I)
                    title, text = reader._html_text(raw, encoding[1].strip('\"\'') if encoding else 'utf-8',
                                                    base_url=fetched_url)
                    content_type = 'html'
                    if reader._soft_error_page(title, text) or reader._content_shell(title, text):
                        raise RuntimeError('unreadable content shell (' + (title or 'untitled') + ')')
                if not text:
                    raise RuntimeError('empty text')
                fetched_identity = arxiv_identity(fetched_url)
                if content_type == 'pdf' or content_type == 'html' and fetched_identity and fetched_identity[0] == 'html':
                    scope = 'full_text'
                elif fetched_identity and fetched_identity[0] == 'abs':
                    scope = 'abstract'
                else:
                    # Reading an entire publisher page does not establish that it
                    # contains the entire paper, even when a proof term matches.
                    scope = 'page_text'
                result = (title, text, fetched_url, content_type, label, details, scope)
                attempts.append({'url': target, 'resolved_url': fetched_url, 'status': scope})
                if scope == 'abstract':
                    abstract = result
                    continue
                if scope == 'page_text':
                    page = page or result
                    continue
                selected = result
                break
            except Exception as error:
                message = str(error)[:1000]
                attempts.append({'url': target, 'status': 'error', 'error': message})
                errors.append(target + ': ' + message)
        selected = selected or page or abstract
        if selected is None:
            raise RuntimeError('; '.join(errors) or 'no readable text: ' + url)
        title, text, final_url, content_type, fallback, details, scope = selected
        truncated = bool(details.get('truncated')) or len(text) > reader.MAX_TEXT_CHARS
        text = text[:reader.MAX_TEXT_CHARS]
        result = {'url': url, 'resolved_url': final_url, 'title': title,
                  'windows': reader._windows(text, terms, window, max_windows),
                  'content_type': content_type, 'extracted_chars': len(text),
                  'source_type': 'primary_or_academic' if scope == 'abstract' else reader._source_type(final_url),
                  'fallback': fallback, 'failed_attempts': len(errors), 'content_scope': scope,
                  'truncated': truncated, 'pages': details.get('pages', []) if content_type == 'pdf' else [],
                  'academic_read_attempts': attempts}
        if scope == 'abstract':
            result['full_text_unavailable'] = True
        reader.base._record_event('read', result)
        if include_body:
            result['_body'] = text
        return result

    reader.read_page = read_page
