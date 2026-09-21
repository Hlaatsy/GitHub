"""Organisations, memberships and invitations.

A seat is an accepted invitation, not a number on a pricing page. That
distinction is the whole point of this module: a five-seat plan with no
enforcement is a one-seat plan that five people share a password to, and you
find out at renewal.

Two rules worth stating because they are easy to get wrong:

* **A pending invitation holds a seat.** Counting only accepted members would
  let fifty invitations go out on a five-seat plan and all be accepted, with
  the limit biting long after the promise was made.
* **A revoked member keeps their history.** Videos and ledger entries stay
  attributed to them. Removing someone from a team is not the same as
  removing what they did, and for an audit it must not be.
"""

from __future__ import annotations

import sqlite3

from . import auth, plans
from .db import log, now

INVITE_TTL_SECONDS = 14 * 24 * 60 * 60

OWNER, MEMBER = "owner", "member"
INVITED, ACTIVE, REVOKED = "invited", "active", "revoked"


class SeatLimitReached(Exception):
    """The plan's seats are all taken or reserved by pending invitations."""


class NotPermitted(Exception):
    """This member's role does not allow this action."""


class InviteError(Exception):
    """The invitation is unknown, expired, already used or withdrawn."""


# --------------------------------------------------------------------------
# reading

def membership(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row | None:
    """The user's active membership, or None if they belong to no organisation."""
    return conn.execute(
        "SELECT * FROM memberships WHERE user_id = ? AND status = ? ORDER BY id LIMIT 1",
        (user_id, ACTIVE),
    ).fetchone()


def members(conn: sqlite3.Connection, org_id: int) -> list[sqlite3.Row]:
    """Everyone holding or reserving a seat, plus their email. Revoked excluded."""
    return conn.execute(
        "SELECT m.*, u.name AS user_name, u.email AS user_email"
        " FROM memberships m LEFT JOIN users u ON u.id = m.user_id"
        " WHERE m.org_id = ? AND m.status != ? ORDER BY m.id",
        (org_id, REVOKED),
    ).fetchall()


def seats_taken(conn: sqlite3.Connection, org_id: int) -> int:
    """Active members plus outstanding invitations."""
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND status IN (?, ?)",
        (org_id, ACTIVE, INVITED),
    ).fetchone()
    return int(row["n"])


def seats_left(conn: sqlite3.Connection, org: sqlite3.Row) -> int:
    return max(0, plans.PLANS[org["plan"]].seats - seats_taken(conn, org["id"]))


def require_owner(member: sqlite3.Row | None) -> None:
    if member is None or member["role"] != OWNER:
        raise NotPermitted("only an owner can manage the team or the plan")


# --------------------------------------------------------------------------
# creating

def create_organisation(conn: sqlite3.Connection, user_id: int, name: str = "") -> int:
    """A new organisation with this user as its owner."""
    org_id = conn.execute(
        "INSERT INTO organisations (name, plan, period_start, created_at)"
        " VALUES (?, ?, ?, ?)", (name, plans.DEFAULT_PLAN, now(), now()),
    ).lastrowid
    email = conn.execute("SELECT email FROM users WHERE id = ?", (user_id,)).fetchone()["email"]
    conn.execute(
        "INSERT INTO memberships (org_id, user_id, invited_email, role, status,"
        " invited_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (org_id, user_id, email, OWNER, ACTIVE, now(), now()),
    )
    log(conn, org_id, "org_created", detail=name, user_id=user_id)
    conn.commit()
    return org_id


def invite(conn: sqlite3.Connection, org: sqlite3.Row, actor: sqlite3.Row,
           email: str) -> str:
    """Invite someone to a seat. Returns the token for the invitation link."""
    require_owner(actor)
    email = email.strip().lower()
    if not email:
        raise InviteError("an email address is required")

    existing = conn.execute(
        "SELECT * FROM memberships WHERE org_id = ? AND invited_email = ? AND status != ?",
        (org["id"], email, REVOKED),
    ).fetchone()
    if existing:
        raise InviteError(f"{email} already has a seat or a pending invitation")

    if seats_left(conn, org) <= 0:
        allowed = plans.PLANS[org["plan"]].seats
        raise SeatLimitReached(
            f"{plans.PLANS[org['plan']].name} includes {allowed} "
            f"seat{'s' if allowed != 1 else ''}, and all of them are taken or invited"
        )

    token = auth.make_token({"org": org["id"], "email": email, "kind": "invite"},
                            INVITE_TTL_SECONDS)
    conn.execute(
        "INSERT INTO memberships (org_id, user_id, invited_email, role, status,"
        " invite_jti, invited_at) VALUES (?, NULL, ?, ?, ?, ?, ?)",
        (org["id"], email, MEMBER, INVITED, auth.read_token(token)["jti"], now()),
    )
    log(conn, org["id"], "member_invited", detail=email, user_id=actor["user_id"])
    conn.commit()
    return token


def accept(conn: sqlite3.Connection, token: str, user_id: int) -> int:
    """Take up an invitation. Returns the organisation id."""
    try:
        payload = auth.read_token(token)
    except auth.AuthError as exc:
        raise InviteError(str(exc)) from exc
    if payload.get("kind") != "invite":
        raise InviteError("wrong token kind")

    row = conn.execute(
        "SELECT * FROM memberships WHERE invite_jti = ?", (payload["jti"],)
    ).fetchone()
    if row is None:
        raise InviteError("unknown invitation")
    if row["status"] == REVOKED:
        raise InviteError("this invitation was withdrawn")
    if row["status"] == ACTIVE:
        raise InviteError("this invitation has already been accepted")

    user = conn.execute("SELECT email FROM users WHERE id = ?", (user_id,)).fetchone()
    if user is None or user["email"] != row["invited_email"]:
        # The link is addressed to one person. Forwarding it must not work, or
        # a seat can be handed to anyone and the consent register stops
        # reflecting who actually has access.
        raise InviteError("this invitation was sent to a different address")

    conn.execute(
        "UPDATE memberships SET user_id = ?, status = ?, accepted_at = ? WHERE id = ?",
        (user_id, ACTIVE, now(), row["id"]),
    )
    log(conn, row["org_id"], "member_joined", detail=row["invited_email"], user_id=user_id)
    conn.commit()
    return int(row["org_id"])


def check_downgrade(conn: sqlite3.Connection, org: sqlite3.Row, target: str) -> None:
    """Refuse a downgrade that would leave the organisation over its limits.

    Silently allowing it puts an account permanently above its plan -- five
    people on a one-seat plan, with no rule to bring it back. Auto-removing
    people would be worse: nobody should lose access to their work because a
    billing page was clicked. So the owner is asked to remove members first,
    which is the only version of this that is honest to everyone involved.
    """
    from . import billing

    plan = plans.PLANS[target]
    taken = seats_taken(conn, org["id"])
    if taken > plan.seats:
        raise SeatLimitReached(
            f"{plan.name} includes {plan.seats} seat{'s' if plan.seats != 1 else ''} "
            f"and {taken} are in use. Remove {taken - plan.seats} before moving down."
        )
    avatars = billing.avatars_used(conn, org["id"])
    allowed = plan.avatars + billing.avatars_granted(conn, org["id"])
    if avatars > allowed:
        raise SeatLimitReached(
            f"{plan.name} allows {allowed} avatar{'s' if allowed != 1 else ''} "
            f"and {avatars} exist. Buying avatar slots keeps them."
        )


def revoke(conn: sqlite3.Connection, org: sqlite3.Row, actor: sqlite3.Row,
           membership_id: int) -> None:
    """Remove a member or withdraw an invitation, freeing the seat."""
    require_owner(actor)
    row = conn.execute(
        "SELECT * FROM memberships WHERE id = ? AND org_id = ?", (membership_id, org["id"])
    ).fetchone()
    if row is None:
        raise InviteError("no such member")
    if row["role"] == OWNER:
        # Otherwise an organisation can be left with nobody able to manage it.
        raise NotPermitted("the owner cannot be removed")

    conn.execute(
        "UPDATE memberships SET status = ?, revoked_at = ? WHERE id = ?",
        (REVOKED, now(), membership_id),
    )
    log(conn, org["id"], "member_revoked", detail=row["invited_email"],
        user_id=actor["user_id"])
    conn.commit()
