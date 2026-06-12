"""SQLite-backed response cache.

The single most important piece for iteration speed: the first cohort run pays
the full Last.fm API cost, every subsequent re-score reads from disk and is
effectively free. Cache keys exclude the api_key so rotating it never busts the
cache, and exclude nothing else — same request params → same cached body.
"""
from __future__ import annotations
import pathlib
import sqlite3
import threading


class Cache:
    def __init__(self, path: pathlib.Path, enabled: bool = True):
        self.enabled = enabled
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY, body TEXT)"
        )
        self.conn.commit()
        self.lock = threading.Lock()

    def get(self, key: str) -> str | None:
        if not self.enabled:
            return None
        with self.lock:
            row = self.conn.execute(
                "SELECT body FROM responses WHERE key=?", (key,)
            ).fetchone()
        return row[0] if row else None

    def set(self, key: str, body: str) -> None:
        if not self.enabled:
            return
        with self.lock:
            self.conn.execute(
                "INSERT OR REPLACE INTO responses (key, body) VALUES (?, ?)",
                (key, body),
            )
            self.conn.commit()

    def stats(self) -> int:
        with self.lock:
            return self.conn.execute("SELECT COUNT(*) FROM responses").fetchone()[0]
