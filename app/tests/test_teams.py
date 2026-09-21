"""Seats, invitations and roles.

A seat is an accepted invitation. These tests are mostly about what must not
work, because that is where the promise on the pricing page is kept or broken.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import auth, billing, plans, teams  # noqa: E402
from app.db import connect, now  # noqa: E402


class TeamTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.conn = connect(Path(self._tmp.name) / "t.db")
        self.owner_id = self.sign_in("owner@co.za")
        self.org_id = teams.create_organisation(self.conn, self.owner_id, "Sandton Mutual")
        self.conn.execute("UPDATE organisations SET plan = 'team5' WHERE id = ?",
                          (self.org_id,))
        self.conn.commit()

    def sign_in(self, email: str) -> int:
        return auth.complete_sign_in(self.conn, auth.start_sign_in(self.conn, email))

    def org(self):
        return self.conn.execute(
            "SELECT * FROM organisations WHERE id = ?", (self.org_id,)
        ).fetchone()

    def owner(self):
        return teams.membership(self.conn, self.owner_id)

    # -- creation ---------------------------------------------------------

    def test_creator_becomes_the_owner_and_takes_a_seat(self):
        member = self.owner()
        self.assertEqual(member["role"], teams.OWNER)
        self.assertEqual(member["status"], teams.ACTIVE)
        self.assertEqual(teams.seats_taken(self.conn, self.org_id), 1)

    # -- invitations ------------------------------------------------------

    def test_an_invitation_reserves_a_seat_before_it_is_accepted(self):
        """Otherwise fifty invites go out on a five-seat plan and all are accepted."""
        before = teams.seats_left(self.conn, self.org())
        teams.invite(self.conn, self.org(), self.owner(), "new@co.za")
        self.assertEqual(teams.seats_left(self.conn, self.org()), before - 1)

    def test_accepting_an_invitation_grants_access(self):
        token = teams.invite(self.conn, self.org(), self.owner(), "new@co.za")
        user_id = self.sign_in("new@co.za")
        self.assertEqual(teams.accept(self.conn, token, user_id), self.org_id)
        member = teams.membership(self.conn, user_id)
        self.assertEqual(member["org_id"], self.org_id)
        self.assertEqual(member["role"], teams.MEMBER)

    def test_a_forwarded_invitation_does_not_work(self):
        """The link is addressed to one person; a seat must not be transferable."""
        token = teams.invite(self.conn, self.org(), self.owner(), "intended@co.za")
        someone_else = self.sign_in("stranger@elsewhere.com")
        with self.assertRaises(teams.InviteError):
            teams.accept(self.conn, token, someone_else)

    def test_an_invitation_cannot_be_accepted_twice(self):
        token = teams.invite(self.conn, self.org(), self.owner(), "new@co.za")
        user_id = self.sign_in("new@co.za")
        teams.accept(self.conn, token, user_id)
        with self.assertRaises(teams.InviteError):
            teams.accept(self.conn, token, user_id)

    def test_a_withdrawn_invitation_cannot_be_accepted(self):
        token = teams.invite(self.conn, self.org(), self.owner(), "new@co.za")
        pending = [m for m in teams.members(self.conn, self.org_id)
                   if m["invited_email"] == "new@co.za"][0]
        teams.revoke(self.conn, self.org(), self.owner(), pending["id"])
        with self.assertRaises(teams.InviteError):
            teams.accept(self.conn, token, self.sign_in("new@co.za"))

    def test_inviting_the_same_person_twice_is_refused(self):
        teams.invite(self.conn, self.org(), self.owner(), "new@co.za")
        with self.assertRaises(teams.InviteError):
            teams.invite(self.conn, self.org(), self.owner(), "new@co.za")

    def test_a_forged_token_is_refused(self):
        forged = auth.make_token({"org": self.org_id, "email": "x@y.z", "kind": "invite"}, 600)
        with self.assertRaises(teams.InviteError):
            teams.accept(self.conn, forged, self.sign_in("x@y.z"))

    # -- the seat limit ---------------------------------------------------

    def test_seats_run_out_at_the_plan_limit(self):
        seats = plans.PLANS["team5"].seats
        for index in range(seats - 1):        # owner already holds one
            teams.invite(self.conn, self.org(), self.owner(), f"p{index}@co.za")
        self.assertEqual(teams.seats_left(self.conn, self.org()), 0)
        with self.assertRaises(teams.SeatLimitReached):
            teams.invite(self.conn, self.org(), self.owner(), "one.too.many@co.za")

    def test_revoking_frees_the_seat(self):
        token = teams.invite(self.conn, self.org(), self.owner(), "new@co.za")
        user_id = self.sign_in("new@co.za")
        teams.accept(self.conn, token, user_id)
        member = teams.membership(self.conn, user_id)
        before = teams.seats_left(self.conn, self.org())
        teams.revoke(self.conn, self.org(), self.owner(), member["id"])
        self.assertEqual(teams.seats_left(self.conn, self.org()), before + 1)
        self.assertIsNone(teams.membership(self.conn, user_id), "access is withdrawn too")

    def test_starter_is_a_single_seat_and_cannot_invite(self):
        self.conn.execute("UPDATE organisations SET plan = 'starter' WHERE id = ?",
                          (self.org_id,))
        self.conn.commit()
        with self.assertRaises(teams.SeatLimitReached):
            teams.invite(self.conn, self.org(), self.owner(), "nope@co.za")

    # -- roles ------------------------------------------------------------

    def test_a_member_cannot_invite_or_revoke(self):
        token = teams.invite(self.conn, self.org(), self.owner(), "new@co.za")
        user_id = self.sign_in("new@co.za")
        teams.accept(self.conn, token, user_id)
        plain = teams.membership(self.conn, user_id)
        with self.assertRaises(teams.NotPermitted):
            teams.invite(self.conn, self.org(), plain, "another@co.za")
        with self.assertRaises(teams.NotPermitted):
            teams.revoke(self.conn, self.org(), plain, plain["id"])

    def test_the_owner_cannot_be_removed(self):
        """An organisation nobody can manage is worse than one seat too many."""
        with self.assertRaises(teams.NotPermitted):
            teams.revoke(self.conn, self.org(), self.owner(), self.owner()["id"])

    def test_a_revoked_members_work_stays_attributed(self):
        token = teams.invite(self.conn, self.org(), self.owner(), "new@co.za")
        user_id = self.sign_in("new@co.za")
        teams.accept(self.conn, token, user_id)
        avatar_id = self.conn.execute(
            "INSERT INTO avatars (org_id, name, source, created_at)"
            " VALUES (?, 'Presenter', 'photo', ?)", (self.org_id, now()),
        ).lastrowid
        self.conn.execute(
            "INSERT INTO videos (org_id, avatar_id, created_by, title, script, created_at)"
            " VALUES (?, ?, ?, 'Their video', 'x', ?)",
            (self.org_id, avatar_id, user_id, now()),
        )
        self.conn.commit()
        teams.revoke(self.conn, self.org(), self.owner(),
                     teams.membership(self.conn, user_id)["id"])
        row = self.conn.execute("SELECT created_by FROM videos").fetchone()
        self.assertEqual(row["created_by"], user_id,
                         "removing someone must not rewrite what they did")


class DowngradeTests(unittest.TestCase):
    """Moving down a plan must not leave an organisation over its limits."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.conn = connect(Path(self._tmp.name) / "t.db")
        owner_id = auth.complete_sign_in(self.conn, auth.start_sign_in(self.conn, "o@co.za"))
        self.owner_id = owner_id
        self.org_id = teams.create_organisation(self.conn, owner_id, "Co")
        self.conn.execute("UPDATE organisations SET plan = 'team5' WHERE id = ?",
                          (self.org_id,))
        self.conn.commit()

    def org(self):
        return self.conn.execute(
            "SELECT * FROM organisations WHERE id = ?", (self.org_id,)
        ).fetchone()

    def test_downgrade_is_refused_while_seats_are_in_use(self):
        owner = teams.membership(self.conn, self.owner_id)
        token = teams.invite(self.conn, self.org(), owner, "second@co.za")
        teams.accept(self.conn, token,
                     auth.complete_sign_in(self.conn, auth.start_sign_in(self.conn, "second@co.za")))
        with self.assertRaises(teams.SeatLimitReached) as caught:
            teams.check_downgrade(self.conn, self.org(), "starter")
        self.assertIn("Remove 1", str(caught.exception))

    def test_downgrade_is_allowed_once_seats_are_freed(self):
        teams.check_downgrade(self.conn, self.org(), "starter")

    def test_downgrade_is_refused_while_too_many_avatars_exist(self):
        for _ in range(3):
            self.conn.execute(
                "INSERT INTO avatars (org_id, name, source, created_at)"
                " VALUES (?, 'P', 'photo', ?)", (self.org_id, now()),
            )
        self.conn.commit()
        with self.assertRaises(teams.SeatLimitReached):
            teams.check_downgrade(self.conn, self.org(), "starter")

    def test_bought_slots_can_make_a_downgrade_possible(self):
        for _ in range(3):
            self.conn.execute(
                "INSERT INTO avatars (org_id, name, source, created_at)"
                " VALUES (?, 'P', 'photo', ?)", (self.org_id, now()),
            )
        self.conn.commit()
        billing.add_avatar_slots(self.conn, self.org_id, plans.AVATAR_PACKS[1])
        teams.check_downgrade(self.conn, self.org(), "starter")


class AvatarSlotTests(unittest.TestCase):
    """Bought slots raise the avatar cap, and nothing else."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.conn = connect(Path(self._tmp.name) / "t.db")
        user_id = auth.complete_sign_in(self.conn, auth.start_sign_in(self.conn, "o@co.za"))
        self.org_id = teams.create_organisation(self.conn, user_id, "Co")
        self.conn.execute("UPDATE organisations SET plan = 'starter' WHERE id = ?",
                          (self.org_id,))
        self.conn.commit()

    def org(self):
        return self.conn.execute(
            "SELECT * FROM organisations WHERE id = ?", (self.org_id,)
        ).fetchone()

    def add_avatar(self):
        self.conn.execute(
            "INSERT INTO avatars (org_id, name, source, created_at)"
            " VALUES (?, 'P', 'photo', ?)", (self.org_id, now()),
        )
        self.conn.commit()

    def test_a_pack_raises_the_cap(self):
        self.add_avatar()
        with self.assertRaises(billing.AvatarLimitReached):
            billing.claim_avatar(self.conn, self.org())
        billing.add_avatar_slots(self.conn, self.org_id, plans.AVATAR_PACKS[0])
        billing.claim_avatar(self.conn, self.org())

    def test_packs_accumulate(self):
        billing.add_avatar_slots(self.conn, self.org_id, plans.AVATAR_PACKS[0])
        billing.add_avatar_slots(self.conn, self.org_id, plans.AVATAR_PACKS[1])
        self.assertEqual(billing.avatars_granted(self.conn, self.org_id), 4)
        self.assertEqual(billing.avatars_allowed(self.conn, self.org()),
                         plans.PLANS["starter"].avatars + 4)

    def test_slots_do_not_add_seats_or_videos(self):
        """A pack must never substitute for moving up a tier."""
        before_seats = teams.seats_left(self.conn, self.org())
        before_videos = billing.videos_left(self.conn, self.org())
        billing.add_avatar_slots(self.conn, self.org_id, plans.AVATAR_PACKS[2])
        self.assertEqual(teams.seats_left(self.conn, self.org()), before_seats)
        self.assertEqual(billing.videos_left(self.conn, self.org()), before_videos)

    def test_bigger_packs_cost_less_each(self):
        rates = [pack.cents_each for pack in plans.AVATAR_PACKS]
        self.assertEqual(rates, sorted(rates, reverse=True))

    def test_a_pack_is_recorded_in_the_ledger(self):
        billing.add_avatar_slots(self.conn, self.org_id, plans.AVATAR_PACKS[0])
        kinds = [r["kind"] for r in self.conn.execute("SELECT kind FROM ledger")]
        self.assertIn("avatar_slots_bought", kinds)


if __name__ == "__main__":
    unittest.main()
