"""Sign-in by emailed link, and phone verification.

No passwords. A market where people sign in on a shared or borrowed phone is
a market where stored passwords get reused and written down, and a password
database is a liability we would rather not hold at all. A signed, expiring,
single-use link is less to get wrong.

Phone verification exists for a different reason: email alone lets one person
farm unlimited free accounts, and each free account costs us a avatar build.
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

from .db import now

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

#: Sign-in and invitation links carry a short random selector rather than a
#: self-contained token. A signed payload runs to 130-odd characters, which
#: makes a 170-character URL that email encoding wraps across three lines --
#: recoverable by a compliant client, fragile everywhere else, and impossible
#: to read out to somebody over the phone. A 22-character selector is
#: unguessable, revocable, and fits on one line.
SELECTOR_BYTES = 16


def new_selector() -> str:
    return secrets.token_urlsafe(SELECTOR_BYTES)


def start_sign_in(conn: sqlite3.Connection, email: str, name: str = "") -> str:
    """Issue a sign-in link, creating the user if they are new.

    Creating a *user* is not the same as creating an organisation. Someone
    invited to a team signs in and joins the team that invited them; only a
    user who belongs to nothing gets an organisation of their own.

    The same response goes back whether or not the address is known -- an
    endpoint that says "no such account" enumerates your customers for anyone
    who asks.
    """
    email = email.strip().lower()
    row = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if row is None:
        user_id = conn.execute(
            "INSERT INTO users (email, name, created_at) VALUES (?, ?, ?)",
            (email, name.strip(), now()),
        ).lastrowid
        conn.commit()
    else:
        user_id = row["id"]

    selector = new_selector()
    conn.execute(
        "INSERT INTO sign_in_tokens (user_id, jti, expires_at, created_at)"
        " VALUES (?, ?, ?, ?)",
        (user_id, selector, int(time.time()) + LINK_TTL_SECONDS, now()),
    )
    conn.commit()
    return selector


def complete_sign_in(conn: sqlite3.Connection, selector: str) -> int:
    """Redeem a sign-in link once. Returns the user id."""
    row = conn.execute(
        "SELECT * FROM sign_in_tokens WHERE jti = ?", (selector.strip(),)
    ).fetchone()
    if row is None:
        raise AuthError("unknown or already-used link")
    if row["used_at"]:
        # Mail scanners and link previews follow links, so a second use is not
        # necessarily an attack -- but it is never a sign-in.
        raise AuthError("this link has already been used")
    if row["expires_at"] < time.time():
        raise AuthError("this link has expired -- ask for another")

    conn.execute("UPDATE sign_in_tokens SET used_at = ? WHERE id = ?", (now(), row["id"]))
    conn.execute("UPDATE users SET email_verified = 1 WHERE id = ?", (row["user_id"],))
    conn.commit()
    return int(row["user_id"])


# --------------------------------------------------------------------------
# phone verification

def send_otp(conn: sqlite3.Connection, user_id: int, phone: str) -> str:
    """Issue a one-time code. Returns it so a stub sender can print it."""
    code = f"{secrets.randbelow(1000000):06d}"
    conn.execute(
        "INSERT INTO otps (user_id, phone, code_hash, attempts, expires_at, created_at)"
        " VALUES (?, ?, ?, 0, ?, ?)",
        (user_id, phone, hashlib.sha256(code.encode()).hexdigest(),
         int(time.time()) + OTP_TTL_SECONDS, now()),
    )
    conn.commit()
    return code


def check_otp(conn: sqlite3.Connection, user_id: int, code: str) -> bool:
    """Verify a code, counting attempts so it cannot be brute-forced."""
    row = conn.execute(
        "SELECT * FROM otps WHERE user_id = ? ORDER BY id DESC LIMIT 1", (user_id,)
    ).fetchone()
    if row is None or row["expires_at"] < time.time() or row["attempts"] >= OTP_MAX_ATTEMPTS:
        return False

    conn.execute("UPDATE otps SET attempts = attempts + 1 WHERE id = ?", (row["id"],))
    conn.commit()

    if not hmac.compare_digest(row["code_hash"], hashlib.sha256(code.encode()).hexdigest()):
        return False

    conn.execute(
        "UPDATE users SET phone = ?, phone_verified = 1 WHERE id = ?",
        (row["phone"], user_id),
    )
    conn.commit()
    return True
