"""Test oracle (read-only): url_audit.py classes and compare.py normalize_url, printed as JSON.

  python3 url_audit_export.py classes   -> [{sid, turn, raw, cls, closest}] for the fixed window 2026-10-13..2026-10-26
  python3 url_audit_export.py normalize -> reads a JSON list of URLs on stdin, prints [normalize_url(u)]
"""
import datetime as dt
import json
import os
import sys

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


if __name__ == '__main__':
    if sys.argv[1] == 'classes':
        json.dump(classes(), sys.stdout, ensure_ascii=False)
    elif sys.argv[1] == 'normalize':
        json.dump([normalize_url(u) for u in json.load(sys.stdin)], sys.stdout, ensure_ascii=False)
