"""SQLite storage. Standard library only, like the rest of this repository.

SQLite is the right size for a launch: one file, no server to run or pay for,
and it will carry this product well past its first thousand customers. The
schema is written so a move to Postgres later is a migration, not a rewrite --
no SQLite-only types, explicit foreign keys, UTC ISO-8601 timestamps.
"""

from __future__ import annotations

import datetime as dt
import sqlite3
import threading
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "identical.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    plan          TEXT NOT NULL DEFAULT 'free',
    period_start  TEXT NOT NULL,
    used          INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS twins (
    id          INTEGER PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id),
    name        TEXT NOT NULL,
    source      TEXT NOT NULL,            -- photo | video | library
    guided      INTEGER NOT NULL DEFAULT 0,
    voice_kind  TEXT NOT NULL DEFAULT 'stock',
    provider_ref TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);

-- A consent record per twin built from a real person. Written at build time,
-- never backfilled: the compliance pillar is worth nothing if our own product
-- cannot show who agreed to what.
CREATE TABLE IF NOT EXISTS consents (
    id           INTEGER PRIMARY KEY,
    twin_id      INTEGER NOT NULL REFERENCES twins(id),
    subject_name TEXT NOT NULL,
    scope        TEXT NOT NULL,
    retention_until TEXT NOT NULL,
    agreed_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
    id           INTEGER PRIMARY KEY,
    account_id   INTEGER NOT NULL REFERENCES accounts(id),
    twin_id      INTEGER NOT NULL REFERENCES twins(id),
    title        TEXT NOT NULL,
    script       TEXT NOT NULL,
    seconds      INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'queued',   -- queued|rendering|ready|failed
    paid_with    TEXT NOT NULL DEFAULT '',         -- allowance|credit
    bytes        INTEGER NOT NULL DEFAULT 0,
    provider_ref TEXT NOT NULL DEFAULT '',
    error        TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL
);

-- Credits are bought in batches so each carries its own expiry date, and the
-- oldest usable batch is always spent first.
CREATE TABLE IF NOT EXISTS credit_batches (
    id          INTEGER PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id),
    bought      INTEGER NOT NULL,
    remaining   INTEGER NOT NULL,
    cents       INTEGER NOT NULL,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- Append-only. Every movement of money or quota, so a billing dispute is
-- answered from data rather than from memory.
CREATE TABLE IF NOT EXISTS ledger (
    id          INTEGER PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id),
    kind        TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '',
    cents       INTEGER NOT NULL DEFAULT 0,
    videos      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);

-- Sign-in links are single use. Recording the jti is what makes that true:
-- without it a link works until it expires, and links get forwarded.
CREATE TABLE IF NOT EXISTS sign_in_tokens (
    id          INTEGER PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id),
    jti         TEXT NOT NULL UNIQUE,
    used_at     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);

-- Phone verification. Only the hash of the code is stored, and attempts are
-- counted, so a six-digit code cannot be walked through.
CREATE TABLE IF NOT EXISTS otps (
    id          INTEGER PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id),
    phone       TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_videos_account ON videos(account_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_jti ON sign_in_tokens(jti);
CREATE INDEX IF NOT EXISTS idx_otps_account ON otps(account_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_batches_account ON credit_batches(account_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger(account_id, id DESC);
"""


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


#: Columns added to ``accounts`` after the first release. CREATE TABLE IF NOT
#: EXISTS leaves an existing table alone, so new columns need adding
#: explicitly or an upgraded deployment reads a schema it does not have.
ACCOUNT_COLUMNS = (
    ("email_verified", "INTEGER NOT NULL DEFAULT 0"),
    ("phone", "TEXT NOT NULL DEFAULT ''"),
    ("phone_verified", "INTEGER NOT NULL DEFAULT 0"),
)


def migrate(conn: sqlite3.Connection) -> None:
    """Add columns missing from an older database. Safe to run every start."""
    have = {row["name"] for row in conn.execute("PRAGMA table_info(accounts)")}
    for name, spec in ACCOUNT_COLUMNS:
        if name not in have:
            conn.execute(f"ALTER TABLE accounts ADD COLUMN {name} {spec}")
    conn.commit()


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path or DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # Readers do not block the writer, which matters as soon as more than one
    # request is in flight.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    migrate(conn)
    return conn


class Pool:
    """One SQLite connection per thread.

    SQLite connections belong to the thread that opened them, and the server
    handles each request on its own thread -- so a single shared connection
    raises as soon as two requests arrive. A thread-local connection is the
    small correct fix; ``check_same_thread=False`` would only move the race
    somewhere harder to see.
    """

    def __init__(self, path: Path | str | None = None) -> None:
        self.path = path
        self._local = threading.local()

    @property
    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._local.conn = connect(self.path)
        return conn


def log(conn: sqlite3.Connection, account_id: int, kind: str, detail: str = "",
        cents: int = 0, videos: int = 0) -> None:
    conn.execute(
        "INSERT INTO ledger (account_id, kind, detail, cents, videos, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (account_id, kind, detail, cents, videos, now()),
    )
