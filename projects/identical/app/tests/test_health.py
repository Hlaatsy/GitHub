"""Account health signals.

Each test is a situation somebody would act on, so the assertions are about
whether the right account is flagged for the right reason -- not about a
score. A number nobody can argue with is a number nobody acts on.
"""

from __future__ import annotations

import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import auth, billing, health, plans, teams  # noqa: E402
from app.db import connect, log, now  # noqa: E402

UTC = dt.timezone.utc


class HealthTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.conn = connect(Path(self._tmp.name) / "t.db")
        self.owner_id = self.user("owner@co.za")
        self.org_id = teams.create_organisation(self.conn, self.owner_id, "Sandton Mutual")
        self.avatar_id = self.conn.execute(
            "INSERT INTO avatars (org_id, name, source, created_at)"
            " VALUES (?, 'Presenter', 'upload', ?)", (self.org_id, now()),
        ).lastrowid
        self.conn.commit()

    def user(self, email):
        return auth.complete_sign_in(self.conn, auth.start_sign_in(self.conn, email))

    def org(self):
        return self.conn.execute(
            "SELECT * FROM organisations WHERE id = ?", (self.org_id,)
        ).fetchone()

    def plan(self, key):
        self.conn.execute("UPDATE organisations SET plan = ? WHERE id = ?",
                          (key, self.org_id))
        self.conn.commit()

    def video(self, days_ago=0, by=None):
        when = (dt.datetime.now(UTC) - dt.timedelta(days=days_ago)).isoformat()
        self.conn.execute(
            "INSERT INTO videos (org_id, avatar_id, created_by, title, script,"
            " created_at) VALUES (?, ?, ?, 'v', 's', ?)",
            (self.org_id, self.avatar_id, by or self.owner_id, when),
        )
        self.conn.commit()

    def signals(self):
        return health.signals(self.conn, self.org())

    # -- dormancy ---------------------------------------------------------

    def test_an_account_that_never_made_anything_is_flagged(self):
        """Onboarding did not land -- the most recoverable state there is."""
        found = self.signals()
        self.assertEqual(found.verdict, "at risk")
        self.assertIn("Never made a video", found.risks[0])

    def test_a_quiet_account_is_flagged(self):
        self.video(days_ago=health.DORMANT_DAYS + 3)
        found = self.signals()
        self.assertEqual(found.verdict, "at risk")
        self.assertTrue(any("Nothing made in" in r for r in found.risks))

    def test_a_recently_active_account_is_not_flagged_as_dormant(self):
        self.plan("starter")
        for _ in range(5):
            self.video(days_ago=2)
        self.conn.execute("UPDATE organisations SET used = 5 WHERE id = ?", (self.org_id,))
        self.conn.commit()
        self.assertFalse(any("Nothing made" in r for r in self.signals().risks))

    def test_the_boundary_is_not_off_by_one(self):
        self.video(days_ago=health.DORMANT_DAYS - 1)
        self.assertFalse(any("Nothing made" in r for r in self.signals().risks))

    # -- under-using ------------------------------------------------------

    def test_paying_for_an_allowance_they_do_not_spend_is_flagged(self):
        self.plan("pro")                       # 40 tokens
        self.video(days_ago=1)
        self.conn.execute("UPDATE organisations SET used = 2 WHERE id = ?", (self.org_id,))
        self.conn.commit()
        self.assertTrue(any("of the allowance they pay for" in r
                            for r in self.signals().risks))

    def test_a_trial_is_not_flagged_for_under_using(self):
        """They are not paying for it, so there is nothing to resent."""
        self.video(days_ago=1)
        self.assertFalse(any("allowance they pay for" in r for r in self.signals().risks))

    # -- empty seats ------------------------------------------------------

    def test_a_team_plan_one_person_uses_is_flagged(self):
        self.plan("premium")                     # 5 seats
        for _ in range(30):
            self.video(days_ago=1)
        self.conn.execute("UPDATE organisations SET used = 60 WHERE id = ?", (self.org_id,))
        self.conn.commit()
        self.assertTrue(any("seats used in the last" in r for r in self.signals().risks))

    def test_a_team_plan_the_team_uses_is_not_flagged(self):
        self.plan("premium")
        colleague = self.user("second@co.za")
        third = self.user("third@co.za")
        for who in (self.owner_id, colleague, third):
            self.video(days_ago=1, by=who)
        self.conn.execute("UPDATE organisations SET used = 60 WHERE id = ?", (self.org_id,))
        self.conn.commit()
        self.assertFalse(any("seats used" in r for r in self.signals().risks))

    def test_a_single_seat_plan_is_never_flagged_for_seats(self):
        self.plan("starter")
        self.video(days_ago=1)
        self.conn.execute("UPDATE organisations SET used = 8 WHERE id = ?", (self.org_id,))
        self.conn.commit()
        self.assertFalse(any("seats used" in r for r in self.signals().risks))

    # -- the opportunity --------------------------------------------------

    def test_an_account_at_its_cap_is_an_upgrade_not_a_risk(self):
        self.plan("starter")
        self.video(days_ago=1)
        self.conn.execute("UPDATE organisations SET used = ? WHERE id = ?",
                          (plans.PLANS["starter"].tokens, self.org_id))
        self.conn.commit()
        found = self.signals()
        self.assertEqual(found.verdict, "upgrade")
        self.assertIn("Pro", found.opportunities[0])

    def test_approaching_the_cap_is_flagged_before_they_are_blocked(self):
        """Asking after someone has been told no is the worst moment to ask."""
        self.plan("pro")
        self.video(days_ago=1)
        for who in (self.user("b@co.za"), self.user("c@co.za")):
            self.video(days_ago=1, by=who)
        near = int(plans.PLANS["pro"].tokens * health.NEAR_CAP) + 1
        self.conn.execute("UPDATE organisations SET used = ? WHERE id = ?",
                          (near, self.org_id))
        self.conn.commit()
        found = self.signals()
        self.assertEqual(found.verdict, "upgrade")
        self.assertIn("still running", found.opportunities[0])

    def test_a_trial_is_not_pitched_an_upgrade_for_usage(self):
        """A trial is meant to be spent; that is not a buying signal."""
        self.video(days_ago=1)
        self.conn.execute("UPDATE organisations SET used = ? WHERE id = ?",
                          (plans.PLANS["free"].tokens, self.org_id))
        self.conn.commit()
        self.assertEqual(self.signals().opportunities, [])

    def test_recent_topping_up_is_an_upgrade_signal(self):
        self.plan("starter")
        self.video(days_ago=1)
        self.conn.execute("UPDATE organisations SET used = 8 WHERE id = ?", (self.org_id,))
        self.conn.commit()
        billing.add_tokens(self.conn, self.org_id, plans.TOKEN_PACKS[0])
        self.assertTrue(self.signals().opportunities)

    def test_the_top_plan_gets_no_upgrade_pitch(self):
        self.plan("premium")
        self.video(days_ago=1)
        self.conn.execute("UPDATE organisations SET used = 200 WHERE id = ?", (self.org_id,))
        self.conn.commit()
        self.assertEqual(self.signals().opportunities, [])

    # -- every risk explains itself ---------------------------------------

    def test_every_flag_carries_a_sentence_somebody_can_act_on(self):
        self.plan("premium")
        self.video(days_ago=60)
        found = self.signals()
        self.assertTrue(found.risks)
        for line in found.risks + found.opportunities:
            self.assertGreater(len(line.split()), 6, f"too terse to act on: {line}")
            self.assertTrue(line.endswith("."), f"not a sentence: {line}")


class OrderingTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.conn = connect(Path(self._tmp.name) / "t.db")

    def make(self, email, name, plan_key, used, videos):
        user_id = auth.complete_sign_in(self.conn, auth.start_sign_in(self.conn, email))
        org_id = teams.create_organisation(self.conn, user_id, name)
        self.conn.execute("UPDATE organisations SET plan = ?, used = ? WHERE id = ?",
                          (plan_key, used, org_id))
        avatar_id = self.conn.execute(
            "INSERT INTO avatars (org_id, name, source, created_at)"
            " VALUES (?, 'P', 'upload', ?)", (org_id, now()),
        ).lastrowid
        for _ in range(videos):
            self.conn.execute(
                "INSERT INTO videos (org_id, avatar_id, created_by, title, script,"
                " created_at) VALUES (?, ?, ?, 'v', 's', ?)",
                (org_id, avatar_id, user_id, now()),
            )
        self.conn.commit()
        return org_id

    def test_accounts_at_risk_come_first(self):
        self.make("healthy@co.za", "Healthy", "starter", 8, 8)
        self.make("risky@co.za", "Risky", "starter", 0, 0)
        found = health.for_all(self.conn)
        self.assertEqual(found[0].name, "Risky")
        self.assertEqual(found[0].verdict, "at risk")


class CohortTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.conn = connect(Path(self._tmp.name) / "t.db")

    def test_cohorts_count_sign_ups_and_who_still_pays(self):
        for index, plan_key in enumerate(("starter", "free", "pro")):
            self.conn.execute(
                "INSERT INTO organisations (name, plan, period_start, created_at)"
                " VALUES (?, ?, ?, '2026-03-14T00:00:00+00:00')",
                (f"Co {index}", plan_key, now()),
            )
        self.conn.commit()
        found = health.cohorts(self.conn)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].month, "2026-03")
        self.assertEqual(found[0].signed_up, 3)
        self.assertEqual(found[0].still_paying, 2, "a trial is not a paying account")
        self.assertAlmostEqual(found[0].retained, 2 / 3)

    def test_no_accounts_means_no_cohorts_rather_than_a_crash(self):
        self.assertEqual(health.cohorts(self.conn), [])


if __name__ == "__main__":
    unittest.main()
