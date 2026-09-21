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


class AvatarCostTests(unittest.TestCase):
    """Avatars are paid for from the same pool as videos, with no extra fee."""

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

    def test_there_is_no_avatar_limit_beyond_the_tokens(self):
        """Starter can have several avatars if it spends its tokens on them."""
        for _ in range(plans.PLANS["starter"].tokens // plans.AVATAR_TOKENS):
            billing.claim_avatar(self.conn, self.org())
            billing.spend(self.conn, self.org(), plans.AVATAR_TOKENS, "avatar")
        with self.assertRaises(billing.OutOfTokens):
            billing.claim_avatar(self.conn, self.org())

    def test_topping_up_buys_more_avatars(self):
        self.conn.execute("UPDATE organisations SET used = ? WHERE id = ?",
                          (plans.PLANS["starter"].tokens, self.org_id))
        self.conn.commit()
        with self.assertRaises(billing.OutOfTokens):
            billing.claim_avatar(self.conn, self.org())
        billing.add_tokens(self.conn, self.org_id, plans.TOKEN_PACKS[0])
        billing.claim_avatar(self.conn, self.org())

    def test_an_uploaded_avatar_gets_a_consent_record(self):
        """A real person's likeness, so the register must name them."""
        avatar_id = self.conn.execute(
            "INSERT INTO avatars (org_id, name, source, created_at)"
            " VALUES (?, 'Thandi Mokoena', 'upload', ?)", (self.org_id, now()),
        ).lastrowid
        self.conn.execute(
            "INSERT INTO consents (avatar_id, subject_name, scope, retention_until,"
            " agreed_at) VALUES (?, 'Thandi Mokoena', 'x', ?, ?)",
            (avatar_id, now(), now()),
        )
        self.conn.commit()
        row = self.conn.execute(
            "SELECT * FROM consents WHERE avatar_id = ?", (avatar_id,)
        ).fetchone()
        self.assertEqual(row["subject_name"], "Thandi Mokoena")

    def test_a_generated_avatar_has_no_consent_subject(self):
        """Recording one would put a fictional name in the regulator's register."""
        avatar_id = self.conn.execute(
            "INSERT INTO avatars (org_id, name, source, created_at)"
            " VALUES (?, 'Studio presenter', 'generated', ?)", (self.org_id, now()),
        ).lastrowid
        self.conn.commit()
        rows = self.conn.execute(
            "SELECT * FROM consents WHERE avatar_id = ?", (avatar_id,)
        ).fetchall()
        self.assertEqual(rows, [])

    def test_both_routes_cost_the_same_tokens(self):
        """Upload or generate is a consent question, not a pricing one."""
        for _ in range(2):
            billing.claim_avatar(self.conn, self.org())
            billing.spend(self.conn, self.org(), plans.AVATAR_TOKENS, "avatar")
        self.assertEqual(
            billing.allowance_left(self.org()),
            plans.PLANS["starter"].tokens - 2 * plans.AVATAR_TOKENS,
        )

    def test_affordable_count_is_reported(self):
        expected = plans.PLANS["starter"].tokens // plans.AVATAR_TOKENS
        self.assertEqual(billing.avatars_affordable(self.conn, self.org()), expected)


if __name__ == "__main__":
    unittest.main()
