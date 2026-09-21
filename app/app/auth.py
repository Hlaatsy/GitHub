"""Sign-in by emailed link, and phone verification.

No passwords. A market where people sign in on a shared or borrowed phone is
a market where stored passwords get reused and written down, and a password
database is a liability we would rather not hold at all. A signed, expiring,
single-use link is less to get wrong.

Phone verification exists for a different reason: email alone lets one person
farm unlimited free accounts, and each free account costs us a twin build.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time

from . import plans
from .db import log, now

SECRET = os.environ.get("IDENTICAL_SECRET", "").encode() or secrets.token_bytes(32)

#: A sign-in link is short-lived. Long enough to switch to an email app on a
#: slow connection, short enough that a forwarded message is not an account.
LINK_TTL_SECONDS = 20 * 60

OTP_TTL_SECONDS = 10 * 60
OTP_MAX_ATTEMPTS = 5


class AuthError(Exception):
    """Raised when a token or code is invalid, expired or already used."""


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def make_token(payload: dict, ttl: int) -> str:
    """A signed, expiring token. Opaque to the holder, unforgeable without SECRET."""
    body = dict(payload, exp=int(time.time()) + ttl, jti=secrets.token_hex(8))
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True).encode()
    mac = hmac.new(SECRET, raw, hashlib.sha256).digest()
    return f"{_b64(raw)}.{_b64(mac)}"


def read_token(token: str) -> dict:
    """Verify and decode. Raises AuthError rather than returning a falsy value."""
    try:
        body, mac = token.split(".", 1)
        raw = _unb64(body)
    except (ValueError, Exception) as exc:  # malformed base64 raises binascii.Error
        raise AuthError("malformed token") from exc

    expected = hmac.new(SECRET, raw, hashlib.sha256).digest()
    if not hmac.compare_digest(_unb64(mac), expected):
        raise AuthError("bad signature")

    payload = json.loads(raw)
    if payload.get("exp", 0) < time.time():
        raise AuthError("expired")
    return payload


# --------------------------------------------------------------------------
# sign-in links

def start_sign_in(conn: sqlite3.Connection, email: str) -> str:
    """Issue a sign-in link for an email, creating the account if it is new.

    The same response goes back whether or not the address is known -- an
    endpoint that says "no such account" is an endpoint that enumerates your
    customers for anyone who asks.
    """
    email = email.strip().lower()
    row = conn.execute("SELECT id FROM accounts WHERE email = ?", (email,)).fetchone()
    if row is None:
        cursor = conn.execute(
            "INSERT INTO accounts (email, name, plan, period_start, created_at)"
            " VALUES (?, '', ?, ?, ?)", (email, plans.DEFAULT_PLAN, now(), now()),
        )
        conn.commit()
        account_id = cursor.lastrowid
        log(conn, account_id, "signup", detail=email)
    else:
        account_id = row["id"]

    token = make_token({"sub": account_id, "kind": "signin"}, LINK_TTL_SECONDS)
    conn.execute(
        "INSERT INTO sign_in_tokens (account_id, jti, created_at) VALUES (?, ?, ?)",
        (account_id, read_token(token)["jti"], now()),
    )
    log(conn, account_id, "signin_requested")
    conn.commit()
    return token


def complete_sign_in(conn: sqlite3.Connection, token: str) -> int:
    """Redeem a sign-in link once. Returns the account id."""
    payload = read_token(token)
    if payload.get("kind") != "signin":
        raise AuthError("wrong token kind")

    row = conn.execute(
        "SELECT * FROM sign_in_tokens WHERE jti = ?", (payload["jti"],)
    ).fetchone()
    if row is None:
        raise AuthError("unknown token")
    if row["used_at"]:
        # Mail scanners and link previews follow links, so a second use is not
        # necessarily an attack -- but it is never a sign-in.
        raise AuthError("already used")

    conn.execute("UPDATE sign_in_tokens SET used_at = ? WHERE id = ?", (now(), row["id"]))
    conn.execute("UPDATE accounts SET email_verified = 1 WHERE id = ?", (payload["sub"],))
    log(conn, payload["sub"], "signin")
    conn.commit()
    return int(payload["sub"])


# --------------------------------------------------------------------------
# phone verification

def send_otp(conn: sqlite3.Connection, account_id: int, phone: str) -> str:
    """Issue a one-time code. Returns it so a stub sender can print it."""
    code = f"{secrets.randbelow(1000000):06d}"
    conn.execute(
        "INSERT INTO otps (account_id, phone, code_hash, attempts, expires_at, created_at)"
        " VALUES (?, ?, ?, 0, ?, ?)",
        (account_id, phone, hashlib.sha256(code.encode()).hexdigest(),
         int(time.time()) + OTP_TTL_SECONDS, now()),
    )
    log(conn, account_id, "otp_sent", detail=phone[-4:])
    conn.commit()
    return code


def check_otp(conn: sqlite3.Connection, account_id: int, code: str) -> bool:
    """Verify a code, counting attempts so it cannot be brute-forced."""
    row = conn.execute(
        "SELECT * FROM otps WHERE account_id = ? ORDER BY id DESC LIMIT 1", (account_id,)
    ).fetchone()
    if row is None or row["expires_at"] < time.time() or row["attempts"] >= OTP_MAX_ATTEMPTS:
        return False

    conn.execute("UPDATE otps SET attempts = attempts + 1 WHERE id = ?", (row["id"],))
    conn.commit()

    if not hmac.compare_digest(row["code_hash"], hashlib.sha256(code.encode()).hexdigest()):
        return False

    conn.execute(
        "UPDATE accounts SET phone = ?, phone_verified = 1 WHERE id = ?",
        (row["phone"], account_id),
    )
    log(conn, account_id, "phone_verified")
    conn.commit()
    return True
