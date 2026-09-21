"""Account health, computed from what the app already records.

Bought customer-success platforms start at roughly $12 000 a year and work by
scoring signals from customer behaviour over time. This scores the same three
signals from the ledger and the tables beside it, which is where that history
already lives -- and does it before there is a book of business large enough
to justify buying anything.

Three signals, chosen because each one maps to a decision somebody can act on
this week:

* **Dormant** -- nothing made recently. The strongest churn signal there is,
  and the earliest: an account stops using a product long before it cancels.
* **Under-using** -- paying for an allowance they are not spending. They will
  notice at renewal even if they have not yet.
* **Empty seats** -- a five-seat plan with one active person is a Team 5
  renewal that will not happen, visible months before the date.

And one that is not a risk at all:

* **At the cap** -- spending everything and topping up. That is an upgrade
  conversation, and missing it costs as much as missing a churn.

Every signal carries the sentence that explains it. A number nobody can
argue with is a number nobody acts on.
"""

from __future__ import annotations

import datetime as dt
import sqlite3
from dataclasses import dataclass, field

from . import billing, plans

#: Nothing made in this long is the first thing worth a phone call. Short
#: enough to act on, long enough not to flag an account that took a fortnight
#: off over the December shutdown.
DORMANT_DAYS = 21

#: Spending less than this share of the monthly allowance.
UNDER_USING = 0.25

#: Active seats as a share of paid seats.
EMPTY_SEATS = 0.5

#: Approaching the allowance. Deliberately below 1.0: waiting until an account
#: is actually blocked means having the upgrade conversation after they have
#: already been told no, which is the worst moment to ask for money.
NEAR_CAP = 0.85


def _days_since(stamp: str | None, now: dt.datetime | None = None) -> int | None:
    if not stamp:
        return None
    moment = dt.datetime.fromisoformat(stamp)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=dt.timezone.utc)
    return ((now or dt.datetime.now(dt.timezone.utc)) - moment).days


@dataclass
class Signals:
    org_id: int
    name: str
    plan: str
    tokens_used: int
    tokens_included: int
    seats_active: int
    seats_paid: int
    days_since_video: int | None
    videos_all_time: int
    topped_up_recently: bool
    risks: list[str] = field(default_factory=list)
    opportunities: list[str] = field(default_factory=list)

    @property
    def usage(self) -> float:
        return self.tokens_used / self.tokens_included if self.tokens_included else 0.0

    @property
    def seat_take_up(self) -> float:
        return self.seats_active / self.seats_paid if self.seats_paid else 0.0

    @property
    def paying(self) -> bool:
        return plans.PLANS[self.plan].cents > 0

    @property
    def verdict(self) -> str:
        if self.risks:
            return "at risk"
        if self.opportunities:
            return "upgrade"
        return "healthy"


#: The window "active" and "recent" are measured over.
ACTIVITY_DAYS = 30
TOP_UP_WINDOW_DAYS = 60


def signals(conn: sqlite3.Connection, org: sqlite3.Row,
            now: dt.datetime | None = None) -> Signals:
    """The three signals for one organisation, with their explanations."""
    plan = plans.PLANS[org["plan"]]
    moment = now or dt.datetime.now(dt.timezone.utc)
    since_active = (moment - dt.timedelta(days=ACTIVITY_DAYS)).isoformat()
    since_top_up = (moment - dt.timedelta(days=TOP_UP_WINDOW_DAYS)).isoformat()

    last_video = conn.execute(
        "SELECT created_at FROM videos WHERE org_id = ? ORDER BY id DESC LIMIT 1",
        (org["id"],),
    ).fetchone()
    total_videos = conn.execute(
        "SELECT COUNT(*) AS n FROM videos WHERE org_id = ?", (org["id"],)
    ).fetchone()["n"]

    # An active seat is a member who has made something this period, not one
    # who merely accepted an invitation -- a seat nobody uses is the thing
    # being measured.
    active = conn.execute(
        "SELECT COUNT(DISTINCT created_by) AS n FROM videos"
        " WHERE org_id = ? AND created_by IS NOT NULL AND created_at >= ?",
        (org["id"], since_active),
    ).fetchone()["n"]

    topped_up = conn.execute(
        "SELECT COUNT(*) AS n FROM ledger"
        " WHERE org_id = ? AND kind = 'tokens_bought' AND created_at >= ?",
        (org["id"], since_top_up),
    ).fetchone()["n"]

    found = Signals(
        org_id=org["id"],
        name=org["name"] or f"org {org['id']}",
        plan=org["plan"],
        tokens_used=int(org["used"]),
        tokens_included=plan.tokens,
        seats_active=int(active),
        seats_paid=plan.seats,
        days_since_video=_days_since(last_video["created_at"] if last_video else None, moment),
        videos_all_time=int(total_videos),
        topped_up_recently=bool(topped_up),
    )

    if found.videos_all_time == 0:
        found.risks.append(
            "Never made a video. Onboarding did not land — the most recoverable "
            "state there is, and the shortest-lived."
        )
    elif found.days_since_video is not None and found.days_since_video >= DORMANT_DAYS:
        found.risks.append(
            f"Nothing made in {found.days_since_video} days. Accounts go quiet "
            "long before they cancel."
        )

    if found.paying and found.usage < UNDER_USING and found.videos_all_time:
        found.risks.append(
            f"Using {found.usage:.0%} of the allowance they pay for. They will "
            "notice at renewal if they have not already."
        )

    if found.seats_paid > 1 and found.seat_take_up < EMPTY_SEATS:
        found.risks.append(
            f"{found.seats_active} of {found.seats_paid} seats used in the last "
            f"{ACTIVITY_DAYS} days. A team plan one person uses is a renewal "
            "that will not happen."
        )

    if found.paying and (found.usage >= NEAR_CAP or found.topped_up_recently):
        upgrade = plans.next_plan(found.plan)
        if upgrade is not None:
            where = ("Past the allowance already" if found.usage >= 1.0
                     else f"At {found.usage:.0%} of the allowance with the month "
                          "still running")
            found.opportunities.append(
                f"{where}. {upgrade.name} is {upgrade.rand}/mo for "
                f"{upgrade.tokens} tokens — ask before they are blocked, not after."
            )

    return found


def for_all(conn: sqlite3.Connection, now: dt.datetime | None = None) -> list[Signals]:
    """Every organisation, most worrying first."""
    rows = conn.execute("SELECT * FROM organisations ORDER BY id").fetchall()
    found = [signals(conn, row, now) for row in rows]
    order = {"at risk": 0, "upgrade": 1, "healthy": 2}
    return sorted(found, key=lambda s: (order[s.verdict], -len(s.risks), s.org_id))


# --------------------------------------------------------------------------
# retention

@dataclass
class Cohort:
    month: str
    signed_up: int
    still_paying: int

    @property
    def retained(self) -> float:
        return self.still_paying / self.signed_up if self.signed_up else 0.0


def cohorts(conn: sqlite3.Connection) -> list[Cohort]:
    """Sign-ups by month, and how many of each month still pay.

    The number worth watching is month five: with the build given away up
    front, that is roughly where an account has repaid what it cost to win.
    """
    rows = conn.execute(
        "SELECT substr(created_at, 1, 7) AS month, id, plan FROM organisations"
        " ORDER BY created_at"
    ).fetchall()
    by_month: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        by_month.setdefault(row["month"], []).append(row)
    return [
        Cohort(month=month,
               signed_up=len(orgs),
               still_paying=sum(1 for o in orgs if plans.PLANS[o["plan"]].cents > 0))
        for month, orgs in sorted(by_month.items())
    ]
