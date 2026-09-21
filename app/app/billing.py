"""Quota, credits and the rules for spending them.

Two rules decide almost everything here, and both are the kind that look like
details until a customer notices them:

1. **Allowance before credits.** Burning a credit somebody paid for while
   their included videos sit unused is indefensible, and they do check.
2. **Oldest credits first**, so a batch about to expire is used rather than
   wasted.
"""

from __future__ import annotations

import datetime as dt
import sqlite3

from . import plans
from .db import log, now


class OutOfQuota(Exception):
    """Raised instead of silently queueing a video nobody can pay for."""


class TooLong(Exception):
    """Script exceeds the per-video length cap."""


class AvatarLimitReached(Exception):
    """Account already has as many avatars as its plan allows."""


def _today() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def period_start(account: sqlite3.Row) -> dt.datetime:
    return dt.datetime.fromisoformat(account["period_start"])


def roll_period(conn: sqlite3.Connection, account: sqlite3.Row) -> sqlite3.Row:
    """Reset the monthly allowance once a month has passed.

    Included videos do not roll over -- that is what a cap means. Credits are
    untouched, because they were paid for separately.
    """
    start = period_start(account)
    if _today() < start + dt.timedelta(days=30):
        return account
    periods = (_today() - start).days // 30
    conn.execute(
        "UPDATE accounts SET used = 0, period_start = ? WHERE id = ?",
        ((start + dt.timedelta(days=30 * periods)).isoformat(timespec="seconds"), account["id"]),
    )
    log(conn, account["id"], "period_reset", detail=f"{periods} period(s)")
    conn.commit()
    return conn.execute("SELECT * FROM accounts WHERE id = ?", (account["id"],)).fetchone()


def live_credits(conn: sqlite3.Connection, account_id: int) -> int:
    """Credits that have not been spent and have not expired."""
    row = conn.execute(
        "SELECT COALESCE(SUM(remaining), 0) AS n FROM credit_batches"
        " WHERE account_id = ? AND remaining > 0 AND expires_at > ?",
        (account_id, now()),
    ).fetchone()
    return int(row["n"])


def allowance_left(account: sqlite3.Row) -> int:
    plan = plans.PLANS[account["plan"]]
    return max(0, plan.videos - int(account["used"]))


def videos_left(conn: sqlite3.Connection, account: sqlite3.Row) -> int:
    return allowance_left(account) + live_credits(conn, account["id"])


def add_credits(conn: sqlite3.Connection, account_id: int, pack: plans.CreditPack) -> None:
    expires = _today() + dt.timedelta(days=plans.CREDIT_EXPIRY_DAYS)
    conn.execute(
        "INSERT INTO credit_batches (account_id, bought, remaining, cents, expires_at, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (account_id, pack.credits, pack.credits, pack.cents,
         expires.isoformat(timespec="seconds"), now()),
    )
    log(conn, account_id, "credits_bought", detail=f"{pack.credits} credits",
        cents=pack.cents, videos=pack.credits)
    conn.commit()


def spend_one(conn: sqlite3.Connection, account: sqlite3.Row) -> str:
    """Consume one video. Returns what paid for it: 'allowance' or 'credit'.

    Raises OutOfQuota rather than rendering something unpaid -- the caller
    turns that into the upgrade conversation, which is the whole point of
    having a cap.
    """
    if allowance_left(account) > 0:
        conn.execute("UPDATE accounts SET used = used + 1 WHERE id = ?", (account["id"],))
        log(conn, account["id"], "video_allowance", videos=1)
        conn.commit()
        return "allowance"

    batch = conn.execute(
        "SELECT * FROM credit_batches WHERE account_id = ? AND remaining > 0 AND expires_at > ?"
        " ORDER BY expires_at ASC LIMIT 1",
        (account["id"], now()),
    ).fetchone()
    if batch is None:
        raise OutOfQuota("no allowance and no live credits")

    conn.execute("UPDATE credit_batches SET remaining = remaining - 1 WHERE id = ?", (batch["id"],))
    log(conn, account["id"], "video_credit", detail=f"batch {batch['id']}", videos=1)
    conn.commit()
    return "credit"


def avatars_used(conn: sqlite3.Connection, account_id: int) -> int:
    return int(conn.execute(
        "SELECT COUNT(*) AS n FROM avatars WHERE account_id = ?", (account_id,)
    ).fetchone()["n"])


def avatars_left(conn: sqlite3.Connection, account: sqlite3.Row) -> int:
    allowed = plans.PLANS[account["plan"]].avatars
    return max(0, allowed - avatars_used(conn, account["id"]))


def claim_avatar(conn: sqlite3.Connection, account: sqlite3.Row) -> None:
    """Check the plan allows another avatar. Raises AvatarLimitReached if not.

    Avatars are capped for three reasons, and only the first is about money:

    * each one is a guided build, which is human time we sell as a service;
    * a cloned voice carries a per-avatar cost with the provider;
    * every avatar is a real person's likeness, so an uncapped account is an
      uncapped consent surface -- more faces on file than anyone is tracking
      is precisely the failure the compliance pillar exists to prevent.
    """
    if avatars_left(conn, account) <= 0:
        allowed = plans.PLANS[account["plan"]].avatars
        raise AvatarLimitReached(
            f"{plans.PLANS[account['plan']].name} includes {allowed} "
            f"avatar{'s' if allowed != 1 else ''}"
        )


def estimate_seconds(script: str, words_per_minute: int = 145) -> int:
    """Rough spoken length. Deliberately conservative: better to warn early."""
    words = len(script.split())
    return round(words / words_per_minute * 60)


def check_length(script: str) -> int:
    seconds = estimate_seconds(script)
    if seconds > plans.MAX_VIDEO_SECONDS:
        raise TooLong(f"{seconds}s is over the {plans.MAX_VIDEO_SECONDS}s limit")
    return seconds
