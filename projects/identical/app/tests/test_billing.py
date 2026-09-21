"""Quota and credit behaviour -- the rules customers notice when broken."""

from __future__ import annotations

import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import billing, plans  # noqa: E402
from app.db import connect, now  # noqa: E402


class BillingTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.conn = connect(Path(self._tmp.name) / "t.db")
        self.conn.execute(
            "INSERT INTO organisations (id, name, plan, period_start, created_at)"
            " VALUES (1, 'Test Co', 'starter', ?, ?)", (now(), now()),
        )
        self.conn.commit()

    def account(self):
        return self.conn.execute("SELECT * FROM organisations WHERE id = 1").fetchone()

    def test_allowance_is_spent_before_credits(self):
        """Burning paid credits while included videos sit unused is indefensible."""
        pack = plans.CREDIT_PACKS[1]
        billing.add_credits(self.conn, 1, pack)
        for _ in range(plans.PLANS["starter"].videos):
            self.assertEqual(billing.spend_one(self.conn, self.account()), "allowance")
        self.assertEqual(billing.live_credits(self.conn, 1), pack.credits)
        self.assertEqual(billing.spend_one(self.conn, self.account()), "credit")
        self.assertEqual(billing.live_credits(self.conn, 1), pack.credits - 1)

    def test_running_out_raises_rather_than_rendering(self):
        for _ in range(plans.PLANS["starter"].videos):
            billing.spend_one(self.conn, self.account())
        with self.assertRaises(billing.OutOfQuota):
            billing.spend_one(self.conn, self.account())

    def test_expired_credits_do_not_count(self):
        past = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).isoformat()
        self.conn.execute(
            "INSERT INTO credit_batches (org_id, bought, remaining, cents, expires_at,"
            " created_at) VALUES (1, 5, 5, 14900, ?, ?)", (past, now()),
        )
        self.conn.commit()
        self.assertEqual(billing.live_credits(self.conn, 1), 0)

    def test_oldest_credits_are_spent_first(self):
        soon = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=5)).isoformat()
        later = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=300)).isoformat()
        self.conn.execute(
            "INSERT INTO credit_batches (id, org_id, bought, remaining, cents, expires_at,"
            " created_at) VALUES (10, 1, 1, 1, 3500, ?, ?)", (later, now()))
        self.conn.execute(
            "INSERT INTO credit_batches (id, org_id, bought, remaining, cents, expires_at,"
            " created_at) VALUES (11, 1, 1, 1, 3500, ?, ?)", (soon, now()))
        self.conn.execute("UPDATE organisations SET used = ? WHERE id = 1",
                          (plans.PLANS["starter"].videos,))
        self.conn.commit()
        billing.spend_one(self.conn, self.account())
        expiring = self.conn.execute("SELECT remaining FROM credit_batches WHERE id = 11").fetchone()
        self.assertEqual(expiring["remaining"], 0, "the batch expiring soonest should go first")

    def test_allowance_resets_after_a_month_but_credits_do_not(self):
        billing.add_credits(self.conn, 1, plans.CREDIT_PACKS[0])
        self.conn.execute("UPDATE organisations SET used = ?, period_start = ? WHERE id = 1",
                          (plans.PLANS["starter"].videos,
                           (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=31)).isoformat()))
        self.conn.commit()
        account = billing.roll_period(self.conn, self.account())
        self.assertEqual(billing.allowance_left(account), plans.PLANS["starter"].videos)
        self.assertEqual(billing.live_credits(self.conn, 1), 1, "credits were paid for separately")

    def test_unused_allowance_does_not_roll_over(self):
        self.conn.execute("UPDATE organisations SET used = 0, period_start = ? WHERE id = 1",
                          ((dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=31)).isoformat(),))
        self.conn.commit()
        account = billing.roll_period(self.conn, self.account())
        self.assertEqual(billing.allowance_left(account), plans.PLANS["starter"].videos)

    def test_every_movement_is_recorded(self):
        billing.add_credits(self.conn, 1, plans.CREDIT_PACKS[0])
        billing.spend_one(self.conn, self.account())
        kinds = [r["kind"] for r in
                 self.conn.execute("SELECT kind FROM ledger WHERE org_id = 1").fetchall()]
        self.assertIn("credits_bought", kinds)
        self.assertIn("video_allowance", kinds)


class LengthTests(unittest.TestCase):
    def test_a_long_script_is_refused(self):
        with self.assertRaises(billing.TooLong):
            billing.check_length("word " * 600)

    def test_a_normal_script_passes(self):
        self.assertLessEqual(billing.check_length("word " * 100), plans.MAX_VIDEO_SECONDS)


class AvatarLimitTests(unittest.TestCase):
    """Avatars are capped per plan. A hidden form is not a limit."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.conn = connect(Path(self._tmp.name) / "t.db")
        self.conn.execute(
            "INSERT INTO organisations (id, name, plan, period_start, created_at)"
            " VALUES (1, 'Test Co', 'starter', ?, ?)", (now(), now()),
        )
        self.conn.commit()

    def account(self):
        return self.conn.execute("SELECT * FROM organisations WHERE id = 1").fetchone()

    def add_avatar(self, name="Presenter"):
        self.conn.execute(
            "INSERT INTO avatars (org_id, name, source, created_at)"
            " VALUES (1, ?, 'photo', ?)", (name, now()),
        )
        self.conn.commit()

    def test_a_fresh_account_may_build_its_first(self):
        billing.claim_avatar(self.conn, self.account())

    def test_starter_stops_at_one(self):
        self.add_avatar()
        with self.assertRaises(billing.AvatarLimitReached):
            billing.claim_avatar(self.conn, self.account())

    def test_team5_allows_five_and_refuses_a_sixth(self):
        self.conn.execute("UPDATE organisations SET plan = 'team5' WHERE id = 1")
        self.conn.commit()
        for index in range(plans.PLANS["team5"].avatars):
            billing.claim_avatar(self.conn, self.account())
            self.add_avatar(f"Presenter {index}")
        with self.assertRaises(billing.AvatarLimitReached):
            billing.claim_avatar(self.conn, self.account())

    def test_upgrading_raises_the_limit(self):
        self.add_avatar()
        with self.assertRaises(billing.AvatarLimitReached):
            billing.claim_avatar(self.conn, self.account())
        self.conn.execute("UPDATE organisations SET plan = 'pro' WHERE id = 1")
        self.conn.commit()
        billing.claim_avatar(self.conn, self.account())

    def test_remaining_count_is_reported(self):
        self.conn.execute("UPDATE organisations SET plan = 'pro' WHERE id = 1")
        self.conn.commit()
        self.assertEqual(billing.avatars_left(self.conn, self.account()), 3)
        self.add_avatar()
        self.assertEqual(billing.avatars_left(self.conn, self.account()), 2)

    def test_the_error_names_the_plan_and_its_allowance(self):
        self.add_avatar()
        with self.assertRaises(billing.AvatarLimitReached) as caught:
            billing.claim_avatar(self.conn, self.account())
        self.assertIn("Starter", str(caught.exception))
        self.assertIn("1 avatar", str(caught.exception))


class LegacyDatabaseTests(unittest.TestCase):
    """An installation from before the split must survive the upgrade."""

    def test_accounts_become_an_organisation_with_an_owner(self):
        import sqlite3

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "legacy.db"

        old = sqlite3.connect(str(path))
        old.executescript(
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE,"
            " name TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'free',"
            " period_start TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,"
            " created_at TEXT NOT NULL);"
            "CREATE TABLE twins (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL,"
            " name TEXT NOT NULL, source TEXT NOT NULL, guided INTEGER NOT NULL DEFAULT 0,"
            " voice_kind TEXT NOT NULL DEFAULT 'stock', provider_ref TEXT NOT NULL DEFAULT '',"
            " created_at TEXT NOT NULL);"
        )
        old.execute("INSERT INTO accounts (email, name, plan, period_start, created_at)"
                    " VALUES ('owner@co.za', 'Old Owner', 'premium', '2026-09-01', '2026-09-01')")
        old.execute("INSERT INTO twins (account_id, name, source, created_at)"
                    " VALUES (1, 'Brand presenter', 'photo', '2026-09-01')")
        old.commit()
        old.close()

        conn = connect(path)

        avatars = conn.execute("SELECT * FROM avatars").fetchall()
        self.assertEqual(len(avatars), 1, "the avatar must survive both renames")
        self.assertEqual(avatars[0]["org_id"], 1)

        org = conn.execute("SELECT * FROM organisations WHERE id = 1").fetchone()
        self.assertEqual(org["plan"], "team5", "old plan keys migrate")

        user = conn.execute("SELECT * FROM users WHERE email = 'owner@co.za'").fetchone()
        self.assertIsNotNone(user, "the account holder becomes a user")

        member = conn.execute(
            "SELECT * FROM memberships WHERE org_id = 1 AND user_id = ?", (user["id"],)
        ).fetchone()
        self.assertIsNotNone(member, "and an owner of the organisation")
        self.assertEqual(member["role"], "owner")
        self.assertEqual(member["status"], "active")

    def test_running_the_migration_twice_is_harmless(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "twice.db"
        connect(path).close()
        conn = connect(path)
        self.assertEqual(
            conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"], 0
        )


if __name__ == "__main__":
    unittest.main()
