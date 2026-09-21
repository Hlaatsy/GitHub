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


class TokenTests(unittest.TestCase):
    """One pool pays for everything. These are the rules customers notice."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.conn = connect(Path(self._tmp.name) / "t.db")
        self.conn.execute(
            "INSERT INTO organisations (id, name, plan, period_start, created_at)"
            " VALUES (1, 'Test Co', 'starter', ?, ?)", (now(), now()),
        )
        self.conn.commit()

    def org(self):
        return self.conn.execute("SELECT * FROM organisations WHERE id = 1").fetchone()

    def test_a_video_costs_one_token(self):
        before = billing.tokens_left(self.conn, self.org())
        billing.spend(self.conn, self.org(), plans.VIDEO_TOKENS, "video")
        self.assertEqual(billing.tokens_left(self.conn, self.org()),
                         before - plans.VIDEO_TOKENS)

    def test_an_avatar_costs_more_but_comes_from_the_same_pool(self):
        """No separate fee: an avatar is just a dearer thing to buy."""
        before = billing.tokens_left(self.conn, self.org())
        billing.spend(self.conn, self.org(), plans.AVATAR_TOKENS, "avatar")
        self.assertEqual(billing.tokens_left(self.conn, self.org()),
                         before - plans.AVATAR_TOKENS)
        self.assertGreater(plans.AVATAR_TOKENS, plans.VIDEO_TOKENS)

    def test_included_tokens_are_spent_before_topped_up_ones(self):
        pack = plans.TOKEN_PACKS[0]
        billing.add_tokens(self.conn, 1, pack)
        for _ in range(plans.PLANS["starter"].tokens):
            self.assertEqual(billing.spend(self.conn, self.org(), 1, "video"), "included")
        self.assertEqual(billing.live_tokens(self.conn, 1), pack.tokens)
        self.assertEqual(billing.spend(self.conn, self.org(), 1, "video"), "topup")

    def test_a_spend_may_straddle_both(self):
        """Five tokens with two included left should use both, not refuse."""
        self.conn.execute("UPDATE organisations SET used = ? WHERE id = 1",
                          (plans.PLANS["starter"].tokens - 2,))
        self.conn.commit()
        billing.add_tokens(self.conn, 1, plans.TOKEN_PACKS[0])
        self.assertEqual(
            billing.spend(self.conn, self.org(), plans.AVATAR_TOKENS, "avatar"), "both"
        )
        self.assertEqual(billing.allowance_left(self.org()), 0)

    def test_running_out_refuses_rather_than_making_it_anyway(self):
        for _ in range(plans.PLANS["starter"].tokens):
            billing.spend(self.conn, self.org(), 1, "video")
        with self.assertRaises(billing.OutOfTokens):
            billing.spend(self.conn, self.org(), 1, "video")

    def test_an_avatar_is_refused_when_tokens_will_not_stretch(self):
        self.conn.execute("UPDATE organisations SET used = ? WHERE id = 1",
                          (plans.PLANS["starter"].tokens - 1,))
        self.conn.commit()
        with self.assertRaises(billing.OutOfTokens):
            billing.claim_avatar(self.conn, self.org())
        self.assertEqual(billing.allowance_left(self.org()), 1,
                         "a refused spend must not consume anything")

    def test_topping_up_makes_a_refused_avatar_possible(self):
        self.conn.execute("UPDATE organisations SET used = ? WHERE id = 1",
                          (plans.PLANS["starter"].tokens,))
        self.conn.commit()
        with self.assertRaises(billing.OutOfTokens):
            billing.claim_avatar(self.conn, self.org())
        billing.add_tokens(self.conn, 1, plans.TOKEN_PACKS[0])
        billing.claim_avatar(self.conn, self.org())

    def test_expired_tokens_do_not_count(self):
        past = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).isoformat()
        self.conn.execute(
            "INSERT INTO token_batches (org_id, bought, remaining, cents, expires_at,"
            " created_at) VALUES (1, 5, 5, 39500, ?, ?)", (past, now()),
        )
        self.conn.commit()
        self.assertEqual(billing.live_tokens(self.conn, 1), 0)

    def test_oldest_batch_is_spent_first(self):
        soon = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=5)).isoformat()
        later = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=300)).isoformat()
        self.conn.execute(
            "INSERT INTO token_batches (id, org_id, bought, remaining, cents, expires_at,"
            " created_at) VALUES (10, 1, 1, 1, 7900, ?, ?)", (later, now()))
        self.conn.execute(
            "INSERT INTO token_batches (id, org_id, bought, remaining, cents, expires_at,"
            " created_at) VALUES (11, 1, 1, 1, 7900, ?, ?)", (soon, now()))
        self.conn.execute("UPDATE organisations SET used = ? WHERE id = 1",
                          (plans.PLANS["starter"].tokens,))
        self.conn.commit()
        billing.spend(self.conn, self.org(), 1, "video")
        expiring = self.conn.execute(
            "SELECT remaining FROM token_batches WHERE id = 11").fetchone()
        self.assertEqual(expiring["remaining"], 0, "the batch expiring soonest goes first")

    def test_monthly_tokens_reset_but_topped_up_ones_do_not(self):
        billing.add_tokens(self.conn, 1, plans.TOKEN_PACKS[0])
        self.conn.execute(
            "UPDATE organisations SET used = ?, period_start = ? WHERE id = 1",
            (plans.PLANS["starter"].tokens,
             (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=31)).isoformat()))
        self.conn.commit()
        org = billing.roll_period(self.conn, self.org())
        self.assertEqual(billing.allowance_left(org), plans.PLANS["starter"].tokens)
        self.assertEqual(billing.live_tokens(self.conn, 1), plans.TOKEN_PACKS[0].tokens,
                         "topped-up tokens were paid for separately")

    def test_unused_monthly_tokens_do_not_roll_over(self):
        self.conn.execute(
            "UPDATE organisations SET used = 0, period_start = ? WHERE id = 1",
            ((dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=31)).isoformat(),))
        self.conn.commit()
        org = billing.roll_period(self.conn, self.org())
        self.assertEqual(billing.allowance_left(org), plans.PLANS["starter"].tokens)

    def test_allowance_counts_tokens_not_videos(self):
        """They are equal only while a video costs one token."""
        original = plans.VIDEO_TOKENS
        try:
            plans.VIDEO_TOKENS = 2
            self.assertEqual(billing.allowance_left(self.org()),
                             plans.PLANS["starter"].tokens)
        finally:
            plans.VIDEO_TOKENS = original

    def test_every_movement_is_recorded(self):
        billing.add_tokens(self.conn, 1, plans.TOKEN_PACKS[0])
        billing.spend(self.conn, self.org(), plans.AVATAR_TOKENS, "avatar")
        kinds = [r["kind"] for r in
                 self.conn.execute("SELECT kind FROM ledger WHERE org_id = 1").fetchall()]
        self.assertIn("tokens_bought", kinds)
        self.assertIn("avatar_created", kinds)


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
