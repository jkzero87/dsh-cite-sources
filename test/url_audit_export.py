"""Test oracle (read-only): url_audit.py classes and compare.py normalize_url, printed as JSON.

  python3 url_audit_export.py classes   -> [{sid, turn, raw, cls, closest}] for the fixed window 2026-10-13..2026-10-26
  python3 url_audit_export.py normalize -> reads a JSON list of URLs on stdin, prints [normalize_url(u)]
  python3 url_audit_export.py canonical -> reads [{sid, raw}] on stdin, prints for each the sorted list of
                                           decoded spellings of the seen URLs whose normalize_url equals the cited one
"""
import base64
import datetime as dt
import html
import json
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.expanduser('~/dsh-compare'))
from compare import normalize_url, read_session, session_files, urls_in  # noqa: E402
from url_audit import DESKTOP_ROOT, classify, collect  # noqa: E402

START = dt.datetime(2026, 10, 13)
END = dt.datetime(2026, 10, 27)


def classes():
    start_ms, end_ms = START.timestamp() * 1000, END.timestamp() * 1000
    rows = []
    for path in sorted(session_files(DESKTOP_ROOT)):
        if os.stat(path).st_mtime * 1000 < start_ms:
            continue
        events, _bad = read_session(path)
        if not events:
            continue
        sid = events[0].get('id')
        bodies, sources, answers = collect(events, start_ms, end_ms)
        for turn, answer in sorted(answers.items(), key=lambda kv: kv[0] or 0):
            for raw in sorted(urls_in(answer)):
                cls, closest, _note = classify(raw, bodies, sources)
                rows.append({'sid': sid, 'turn': turn, 'raw': raw, 'cls': cls, 'closest': closest})
    return rows


def decoded(url):
    """HTML-unescaped URL with a Bing (u=a1<base64>) or DuckDuckGo (uddg) redirect replaced by its target."""
    url = html.unescape(url).strip().rstrip('.,;:*>')
    parsed = urllib.parse.urlsplit(url)
    host = (parsed.hostname or '').lower()
    if host.endswith('bing.com') and parsed.path.startswith('/ck/a'):
        target = urllib.parse.parse_qs(parsed.query).get('u', [''])[0]
        if target.startswith('a1'):
            encoded = target[2:]
            url = base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)).decode('utf-8')
            parsed = urllib.parse.urlsplit(url)
            host = (parsed.hostname or '').lower()
    if host.endswith('duckduckgo.com') and parsed.path.startswith('/l/'):
        url = urllib.parse.parse_qs(parsed.query).get('uddg', [url])[0]
    return url


def canonical(requests):
    by_sid = {}
    for path in session_files(DESKTOP_ROOT):
        sid = os.path.basename(os.path.dirname(path))
        if any(r['sid'] == sid for r in requests):
            by_sid[sid] = read_session(path)[0]
    out = []
    for r in requests:
        bodies, sources, _answers = collect(by_sid[r['sid']], 0, float('inf'))
        seen = set(sources)
        for body in bodies:
            seen |= urls_in(body)
        target = normalize_url(r['raw'])
        out.append(sorted({decoded(s) for s in seen if target is not None and normalize_url(s) == target}))
    return out


def _session_events(sid_prefix, file_path):
    """(bodies, sources) for the session whose id starts with `sid_prefix`.

    Finds the session the same way `test/sessions.js sessionPath()` does: the id is the
    `session-<id>` DIRECTORY name, not the zstd file name, and it may sit in any session root
    (desktop or the dsh-scratch working session, `--home-jkzero-dsh-scratch--`). Falls back to a
    plain `.jsonl` decoded session under `~/dsh-scratch`."""
    import json as _json
    candidates = []
    for root in (DESKTOP_ROOT, os.path.join(os.path.expanduser('~'), '.dsh', 'sessions')):
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, _files in os.walk(root):
            if os.path.basename(dirpath).startswith(f'session-{sid_prefix}'):
                zstd = os.path.join(dirpath, 'session.v4.jsonl.zstd')
                if os.path.exists(zstd):
                    candidates.append(zstd)
                    break
    if not candidates:
        fallback = os.path.expanduser(file_path) if file_path else None
        if fallback and fallback.endswith('.jsonl') and os.path.exists(fallback):
            events = []
            with open(fallback, encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line:
                        events.append(_json.loads(line))
            bodies, sources, _answers = collect(events, 0, float('inf'))
            return bodies, sources
        raise SystemExit(f'no session {sid_prefix}')
    events, _bad = read_session(candidates[0])
    bodies, sources, _answers = collect(events, 0, float('inf'))
    return bodies, sources


def answer_classes(sid_prefix, answer, file_path=None):
    """url_audit classes for an arbitrary answer text (e.g. the plugin-rewritten one) of a session."""
    bodies, sources = _session_events(sid_prefix, file_path)
    rows = []
    for raw in sorted(urls_in(answer)):
        cls, closest, _note = classify(raw, bodies, sources)
        rows.append({'turn': None, 'raw': raw, 'cls': cls, 'closest': closest})
    return rows


if __name__ == '__main__':
    if sys.argv[1] == 'classes':
        json.dump(classes(), sys.stdout, ensure_ascii=False)
    elif sys.argv[1] == 'normalize':
        json.dump([normalize_url(u) for u in json.load(sys.stdin)], sys.stdout, ensure_ascii=False)
    elif sys.argv[1] == 'canonical':
        json.dump(canonical(json.load(sys.stdin)), sys.stdout, ensure_ascii=False)
    elif sys.argv[1] == 'answer-classes':
        payload = json.load(sys.stdin)
        json.dump(answer_classes(payload['sid'], payload['answer']), sys.stdout, ensure_ascii=False)
