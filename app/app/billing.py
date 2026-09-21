"""Tokens, and the rules for spending them.

One pool pays for everything an organisation makes. A video is one token, an
avatar is five. There is no separate charge for creating an avatar and no
per-plan avatar limit: when the tokens run out, you top up, and that single
rule covers every kind of content.

Two smaller rules decide almost everything else, and both look like details
until a customer notices them:

1. **Subscribed tokens before topped-up ones.** Charging a top-up somebody
   paid for while their included tokens sit unused is indefensible, and they
   do check.
2. **Oldest batch first**, so tokens about to expire are used rather than
   wasted.
"""

from __future__ import annotations

import datetime as dt
import sqlite3

from . import plans
from .db import log, now


class OutOfTokens(Exception):
    """Raised instead of making something nobody has paid for."""


#: Old name, kept so existing callers keep working.
OutOfQuota = OutOfTokens


class TooLong(Exception):
    """Script exceeds the per-video length cap."""


class AvatarLimitReached(Exception):
    """Kept for callers that still catch it; avatars now run out of tokens."""


def _today() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def period_start(org: sqlite3.Row) -> dt.datetime:
    return dt.datetime.fromisoformat(org["period_start"])


def roll_period(conn: sqlite3.Connection, org: sqlite3.Row) -> sqlite3.Row:
    """Reset the monthly allowance once a month has passed.

    Included videos do not roll over -- that is what a cap means. Credits are
    untouched, because they were paid for separately.
    """
    start = period_start(org)
    if _today() < start + dt.timedelta(days=30):
        return org
    periods = (_today() - start).days // 30
    conn.execute(
        "UPDATE organisations SET used = 0, period_start = ? WHERE id = ?",
        ((start + dt.timedelta(days=30 * periods)).isoformat(timespec="seconds"), org["id"]),
    )
    log(conn, org["id"], "period_reset", detail=f"{periods} period(s)")
    conn.commit()
    return conn.execute("SELECT * FROM organisations WHERE id = ?", (org["id"],)).fetchone()


def live_tokens(conn: sqlite3.Connection, org_id: int) -> int:
    """Credits that have not been spent and have not expired."""
    row = conn.execute(
        "SELECT COALESCE(SUM(remaining), 0) AS n FROM token_batches"
        " WHERE org_id = ? AND remaining > 0 AND expires_at > ?",
        (org_id, now()),
    ).fetchone()
    return int(row["n"])


def allowance_left(org: sqlite3.Row) -> int:
    plan = plans.PLANS[org["plan"]]
    return max(0, plan.videos - int(org["used"]))


def tokens_left(conn: sqlite3.Connection, org: sqlite3.Row) -> int:
    """Subscribed tokens not yet used, plus live topped-up ones."""
    return allowance_left(org) + live_tokens(conn, org["id"])


def videos_left(conn: sqlite3.Connection, org: sqlite3.Row) -> int:
    """Tokens expressed as videos, which is how the meter reads."""
    return tokens_left(conn, org) // plans.VIDEO_TOKENS


def add_tokens(conn: sqlite3.Connection, org_id: int, pack: plans.TokenPack,
               user_id: int | None = None) -> None:
    expires = _today() + dt.timedelta(days=plans.TOKEN_EXPIRY_DAYS)
    conn.execute(
        "INSERT INTO token_batches (org_id, bought, remaining, cents, expires_at, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (org_id, pack.tokens, pack.tokens, pack.cents,
         expires.isoformat(timespec="seconds"), now()),
    )
    log(conn, org_id, "tokens_bought", detail=f"{pack.tokens} tokens",
        cents=pack.cents, videos=pack.tokens, user_id=user_id)
    conn.commit()


def spend(conn: sqlite3.Connection, org: sqlite3.Row, tokens: int, what: str,
          user_id: int | None = None) -> str:
    """Spend tokens on one thing. Returns how it was paid: included/topup/both.

    Subscribed tokens go first, then topped-up ones, oldest batch first.
    Charging a top-up somebody paid for while their included tokens sit unused
    is indefensible, and customers check.

    Raises OutOfTokens rather than making something nobody paid for -- that
    refusal is the top-up conversation, which is the point of having a limit.
    """
    if tokens_left(conn, org) < tokens:
        raise OutOfTokens(f"{what} costs {tokens} tokens and "
                          f"{tokens_left(conn, org)} are left")

    from_allowance = min(tokens, allowance_left(org))
    if from_allowance:
        conn.execute("UPDATE organisations SET used = used + ? WHERE id = ?",
                     (from_allowance, org["id"]))

    remaining = tokens - from_allowance
    while remaining > 0:
        batch = conn.execute(
            "SELECT * FROM token_batches WHERE org_id = ? AND remaining > 0 AND expires_at > ?"
            " ORDER BY expires_at ASC LIMIT 1", (org["id"], now()),
        ).fetchone()
        take = min(remaining, batch["remaining"])
        conn.execute("UPDATE token_batches SET remaining = remaining - ? WHERE id = ?",
                     (take, batch["id"]))
        remaining -= take

    paid = ("included" if not tokens - from_allowance
            else "topup" if not from_allowance else "both")
    log(conn, org["id"], f"{what}_created", detail=f"{tokens} tokens ({paid})",
        videos=tokens, user_id=user_id)
    conn.commit()
    return paid


def avatars_used(conn: sqlite3.Connection, org_id: int) -> int:
    return int(conn.execute(
        "SELECT COUNT(*) AS n FROM avatars WHERE org_id = ?", (org_id,)
    ).fetchone()["n"])


def avatars_affordable(conn: sqlite3.Connection, org: sqlite3.Row) -> int:
    """How many more avatars the remaining tokens will pay for."""
    return tokens_left(conn, org) // plans.AVATAR_TOKENS


def claim_avatar(conn: sqlite3.Connection, org: sqlite3.Row) -> None:
    """Check an avatar can be paid for. Raises OutOfTokens if not.

    There is no separate charge for an avatar and no per-plan avatar limit.
    One pool pays for everything the organisation makes, so the only question
    is whether there are enough tokens left -- which is the same question a
    video asks, with a bigger number.
    """
    if tokens_left(conn, org) < plans.AVATAR_TOKENS:
        raise OutOfTokens(
            f"an avatar is {plans.AVATAR_TOKENS} tokens and "
            f"{tokens_left(conn, org)} are left"
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
