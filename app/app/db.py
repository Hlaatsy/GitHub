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
-- An organisation holds the plan, the quota and the avatars. People belong to
-- it through memberships. Splitting the two is what makes a seat a real thing
-- rather than a number on a pricing page: a seat is an accepted invitation.
CREATE TABLE IF NOT EXISTS organisations (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL DEFAULT '',
    plan          TEXT NOT NULL DEFAULT 'trial',
    period_start  TEXT NOT NULL,
    used          INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY,
    email          TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL DEFAULT '',
    email_verified INTEGER NOT NULL DEFAULT 0,
    phone          TEXT NOT NULL DEFAULT '',
    phone_verified INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
);

-- status: invited -> active, or revoked. An invitation reserves a seat from
-- the moment it is sent: otherwise fifty invites could all be accepted on a
-- five-seat plan and the limit would only bite afterwards, which is too late.
CREATE TABLE IF NOT EXISTS memberships (
    id            INTEGER PRIMARY KEY,
    org_id        INTEGER NOT NULL REFERENCES organisations(id),
    user_id       INTEGER REFERENCES users(id),
    invited_email TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'member',   -- owner | member
    status        TEXT NOT NULL DEFAULT 'invited',  -- invited | active | revoked
    invite_jti    TEXT NOT NULL DEFAULT '',
    invited_at    TEXT NOT NULL,
    accepted_at   TEXT NOT NULL DEFAULT '',
    revoked_at    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS avatars (
    id           INTEGER PRIMARY KEY,
    org_id       INTEGER NOT NULL REFERENCES organisations(id),
    name         TEXT NOT NULL,
    source       TEXT NOT NULL,            -- photo | video | library
    guided       INTEGER NOT NULL DEFAULT 0,
    voice_kind   TEXT NOT NULL DEFAULT 'stock',
    provider_ref TEXT NOT NULL DEFAULT '',
    created_by   INTEGER REFERENCES users(id),
    created_at   TEXT NOT NULL
);

-- A consent record per avatar built from a real person. Written at build
-- time, never backfilled: the compliance pillar is worth nothing if our own
-- product cannot show who agreed to what.
CREATE TABLE IF NOT EXISTS consents (
    id              INTEGER PRIMARY KEY,
    avatar_id       INTEGER NOT NULL REFERENCES avatars(id),
    subject_name    TEXT NOT NULL,
    scope           TEXT NOT NULL,
    retention_until TEXT NOT NULL,
    agreed_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
    id           INTEGER PRIMARY KEY,
    org_id       INTEGER NOT NULL REFERENCES organisations(id),
    avatar_id    INTEGER NOT NULL REFERENCES avatars(id),
    created_by   INTEGER REFERENCES users(id),
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

-- Video credits, bought in batches so each carries its own expiry, oldest
-- usable batch spent first.
CREATE TABLE IF NOT EXISTS credit_batches (
    id          INTEGER PRIMARY KEY,
    org_id      INTEGER NOT NULL REFERENCES organisations(id),
    bought      INTEGER NOT NULL,
    remaining   INTEGER NOT NULL,
    cents       INTEGER NOT NULL,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- Purchased avatar slots. These raise the avatar cap and nothing else -- not
-- seats, not videos -- so buying slots can never substitute for a tier.
-- Permanent rather than monthly, because the guided build behind each one is
-- work done once.
CREATE TABLE IF NOT EXISTS avatar_grants (
    id          INTEGER PRIMARY KEY,
    org_id      INTEGER NOT NULL REFERENCES organisations(id),
    extra       INTEGER NOT NULL,
    cents       INTEGER NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sign_in_tokens (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    jti         TEXT NOT NULL UNIQUE,
    used_at     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otps (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    phone       TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
    id          INTEGER PRIMARY KEY,
    org_id      INTEGER NOT NULL REFERENCES organisations(id),
    user_id     INTEGER,
    kind        TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '',
    cents       INTEGER NOT NULL DEFAULT 0,
    videos      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_videos_org ON videos(org_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_batches_org ON credit_batches(org_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_ledger_org ON ledger(org_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_members_org ON memberships(org_id, status);
CREATE INDEX IF NOT EXISTS idx_members_user ON memberships(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tokens_jti ON sign_in_tokens(jti);
"""


def now() -> str:
    """UTC, ISO-8601, to the second. One timestamp format everywhere."""
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def rename_legacy(conn: sqlite3.Connection) -> None:
    """Migrations that must run BEFORE the schema script.

    ``CREATE TABLE IF NOT EXISTS`` leaves an existing table alone, so a rename
    has to happen first or the new empty table is created beside the old one
    still holding every row -- and the app comes up looking like the data is
    gone.
    """
    tables = {row["name"] for row in
              conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if not tables:
        return  # fresh database

    # "twin" became "avatar".
    if "twins" in tables and "avatars" not in tables:
        conn.execute("ALTER TABLE twins RENAME TO avatars")
        tables.add("avatars")
    for table in ("videos", "consents"):
        if table in tables:
            columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
            if "twin_id" in columns and "avatar_id" not in columns:
                conn.execute(f"ALTER TABLE {table} RENAME COLUMN twin_id TO avatar_id")

    # One "accounts" row used to be both the organisation and the person. It
    # becomes an organisation; the person is lifted out into users, and a
    # membership joins them as owner. Done as a rename plus inserts so no
    # avatar, video or credit is orphaned.
    if "accounts" in tables and "organisations" not in tables:
        conn.execute("ALTER TABLE accounts RENAME TO organisations")
        for table in ("avatars", "videos", "credit_batches", "ledger"):
            if table in tables:
                columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
                if "account_id" in columns and "org_id" not in columns:
                    conn.execute(f"ALTER TABLE {table} RENAME COLUMN account_id TO org_id")
    conn.commit()


def split_out_users(conn: sqlite3.Connection) -> None:
    """Second half of the accounts split, run AFTER the schema exists.

    Every organisation carried over from the old model has an email on it and
    no owner. Lift that email into a user and make them the owner, or the
    organisation has no one who can sign in to it.
    """
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(organisations)")}
    if "email" not in columns:
        return  # already split

    rows = conn.execute(
        "SELECT id, email, name FROM organisations WHERE email != ''"
    ).fetchall()
    for org in rows:
        existing = conn.execute(
            "SELECT id FROM users WHERE email = ?", (org["email"],)
        ).fetchone()
        if existing:
            user_id = existing["id"]
        else:
            user_id = conn.execute(
                "INSERT INTO users (email, name, email_verified, created_at)"
                " VALUES (?, ?, 1, ?)", (org["email"], org["name"] or "", now()),
            ).lastrowid
        already = conn.execute(
            "SELECT id FROM memberships WHERE org_id = ? AND user_id = ?",
            (org["id"], user_id),
        ).fetchone()
        if not already:
            conn.execute(
                "INSERT INTO memberships (org_id, user_id, invited_email, role, status,"
                " invited_at, accepted_at) VALUES (?, ?, ?, 'owner', 'active', ?, ?)",
                (org["id"], user_id, org["email"], now(), now()),
            )
    # SQLite cannot drop a UNIQUE column cleanly on older versions; blanking it
    # is enough to make this migration idempotent and keeps the data readable.
    conn.execute("UPDATE organisations SET email = '' WHERE email != ''")
    conn.commit()


def migrate(conn: sqlite3.Connection) -> None:
    """Data fixes that run AFTER the schema script. Safe every start."""
    split_out_users(conn)

    # Plan keys from the consumer model no longer exist; without this every
    # lookup against PLANS raises and the organisation cannot load at all.
    from .plans import RENAMED

    for old, new in RENAMED.items():
        conn.execute("UPDATE organisations SET plan = ? WHERE plan = ?", (new, old))
    conn.commit()


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path or DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # Readers do not block the writer, which matters as soon as more than one
    # request is in flight.
    conn.execute("PRAGMA journal_mode = WAL")
    rename_legacy(conn)
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


def log(conn: sqlite3.Connection, org_id: int, kind: str, detail: str = "",
        cents: int = 0, videos: int = 0, user_id: int | None = None) -> None:
    """Append to the ledger. Records who as well as what, so an audit can name
    the person who spent the quota, not just the organisation."""
    conn.execute(
        "INSERT INTO ledger (org_id, user_id, kind, detail, cents, videos, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (org_id, user_id, kind, detail, cents, videos, now()),
    )
