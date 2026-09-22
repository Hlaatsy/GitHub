"""Sign-off before a video leaves the building.

Sold as a Team 5 feature and, until now, sold without being built. It is also
the feature a communications lead is personally accountable for: nothing goes
out under the company name without a named person clearing it, and "somebody
approved it" is only an answer if the record names them.

Two decisions worth stating, because both could reasonably have gone the
other way:

**Approval gates use, not rendering.** A video is rendered first and cleared
afterwards. You cannot approve something you have not watched, and a script
reads differently from the same words in someone's mouth. The cost of that is
tokens spent on videos that are then rejected -- real, and the honest answer
is that the provider charged us either way.

**The maker can be the approver, unless four-eyes is on.** In a small
marketing team the person writing the script is often the person accountable
for it, and blocking that by default would make the feature something people
turn off. Organisations that need separation of duties switch it on, and then
nobody clears their own work.
"""

from __future__ import annotations

import sqlite3

from . import teams
from .db import log, now

#: A video's approval state. Separate from its render status: finished and
#: cleared to publish are different questions.
NOT_REQUIRED, PENDING, APPROVED, REJECTED = (
    "not_required", "pending", "approved", "rejected",
)


class NotPermitted(Exception):
    """This member may not decide this video."""


class NotPending(Exception):
    """This video is not waiting on a decision."""


def required(org: sqlite3.Row) -> bool:
    return bool(org["require_approval"])


def initial_state(org: sqlite3.Row) -> str:
    """What a newly rendered video starts as."""
    return PENDING if required(org) else NOT_REQUIRED


def publishable(video: sqlite3.Row) -> bool:
    """Whether this video may be shared, downloaded or published.

    A video needing approval and not yet having it is finished but not
    releasable -- which is the entire point of the feature.
    """
    return video["approval"] in (NOT_REQUIRED, APPROVED)


def waiting(conn: sqlite3.Connection, org_id: int) -> list[sqlite3.Row]:
    """Videos waiting on a decision, oldest first -- a queue, not a list."""
    return conn.execute(
        "SELECT v.*, u.name AS author_name, u.email AS author_email"
        " FROM videos v LEFT JOIN users u ON u.id = v.created_by"
        " WHERE v.org_id = ? AND v.approval = ? ORDER BY v.id",
        (org_id, PENDING),
    ).fetchall()


def can_decide(conn: sqlite3.Connection, org: sqlite3.Row, member: sqlite3.Row,
               video: sqlite3.Row) -> tuple[bool, str]:
    """Whether this member may decide this video, and why not if they cannot."""
    if member["role"] != teams.OWNER:
        return False, "Only an owner can approve or reject."
    if video["approval"] != PENDING:
        return False, "This video is not waiting on a decision."
    if org["four_eyes"] and video["created_by"] == member["user_id"]:
        return False, (
            "Four-eyes approval is on for this organisation, so nobody clears "
            "their own work. Ask another owner."
        )
    return True, ""


def decide(conn: sqlite3.Connection, org: sqlite3.Row, member: sqlite3.Row,
           video: sqlite3.Row, decision: str, note: str = "") -> None:
    """Approve or reject, and write down who did it."""
    if decision not in (APPROVED, REJECTED):
        raise NotPending(f"unknown decision {decision!r}")
    allowed, why = can_decide(conn, org, member, video)
    if not allowed:
        raise (NotPending(why) if video["approval"] != PENDING else NotPermitted(why))

    if decision == REJECTED and not note.strip():
        # A rejection without a reason sends somebody back to a blank page.
        raise NotPending("A rejection needs a reason, so it can be acted on.")

    conn.execute("UPDATE videos SET approval = ? WHERE id = ?", (decision, video["id"]))
    conn.execute(
        "INSERT INTO approvals (video_id, org_id, decided_by, decision, note, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (video["id"], org["id"], member["user_id"], decision, note.strip(), now()),
    )
    log(conn, org["id"], f"video_{decision}", detail=video["title"],
        user_id=member["user_id"])
    conn.commit()


def resubmit(conn: sqlite3.Connection, org: sqlite3.Row, video: sqlite3.Row) -> None:
    """Put a rejected video back in the queue after it has been dealt with."""
    if video["approval"] != REJECTED:
        raise NotPending("Only a rejected video can be resubmitted.")
    conn.execute("UPDATE videos SET approval = ? WHERE id = ?", (PENDING, video["id"]))
    conn.commit()


def history(conn: sqlite3.Connection, video_id: int) -> list[sqlite3.Row]:
    """Every decision ever made on this video, newest first. Never pruned."""
    return conn.execute(
        "SELECT a.*, u.name AS decided_name, u.email AS decided_email"
        " FROM approvals a LEFT JOIN users u ON u.id = a.decided_by"
        " WHERE a.video_id = ? ORDER BY a.id DESC",
        (video_id,),
    ).fetchall()
