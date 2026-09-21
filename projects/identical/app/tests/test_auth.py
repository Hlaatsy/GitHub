"""Sign-in links and phone verification.

These decide who gets into an account, so the tests are about what must NOT
work as much as what must.
"""

from __future__ import annotations

import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import auth  # noqa: E402
from app.db import connect  # noqa: E402


class TokenTests(unittest.TestCase):
    def test_round_trips(self):
        token = auth.make_token({"sub": 7, "kind": "signin"}, 60)
        self.assertEqual(auth.read_token(token)["sub"], 7)

    def test_tampering_is_rejected(self):
        token = auth.make_token({"sub": 7, "kind": "signin"}, 60)
        body, mac = token.split(".", 1)
        forged = auth._b64(b'{"sub":8,"kind":"signin","exp":99999999999,"jti":"x"}')
        with self.assertRaises(auth.AuthError):
            auth.read_token(f"{forged}.{mac}")

    def test_expired_is_rejected(self):
        with self.assertRaises(auth.AuthError):
            auth.read_token(auth.make_token({"sub": 1}, -1))

    def test_garbage_is_rejected(self):
        for bad in ("", "nodot", "a.b", "...."):
            with self.assertRaises(auth.AuthError):
                auth.read_token(bad)


class SignInTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.conn = connect(Path(self._tmp.name) / "t.db")

    def test_first_sign_in_creates_the_account(self):
        token = auth.start_sign_in(self.conn, "New@Example.com ")
        account_id = auth.complete_sign_in(self.conn, token)
        row = self.conn.execute("SELECT * FROM users WHERE id = ?", (account_id,)).fetchone()
        self.assertEqual(row["email"], "new@example.com", "email should be normalised")
        self.assertEqual(row["email_verified"], 1)

    def test_signing_in_does_not_create_an_organisation(self):
        """An invited colleague joins a team; they do not get one of their own."""
        auth.complete_sign_in(self.conn, auth.start_sign_in(self.conn, "invitee@co.za"))
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) AS n FROM organisations").fetchone()["n"], 0
        )

    def test_returning_user_keeps_the_same_account(self):
        first = auth.complete_sign_in(self.conn, auth.start_sign_in(self.conn, "a@b.c"))
        second = auth.complete_sign_in(self.conn, auth.start_sign_in(self.conn, "a@b.c"))
        self.assertEqual(first, second)

    def test_a_link_works_only_once(self):
        """Mail scanners follow links. A second use must never be a sign-in."""
        token = auth.start_sign_in(self.conn, "a@b.c")
        auth.complete_sign_in(self.conn, token)
        with self.assertRaises(auth.AuthError):
            auth.complete_sign_in(self.conn, token)

    def test_a_token_we_never_issued_is_rejected(self):
        forged = auth.make_token({"sub": 1, "kind": "signin"}, 60)
        with self.assertRaises(auth.AuthError):
            auth.complete_sign_in(self.conn, forged)

    def test_wrong_kind_is_rejected(self):
        token = auth.make_token({"sub": 1, "kind": "something-else"}, 60)
        with self.assertRaises(auth.AuthError):
            auth.complete_sign_in(self.conn, token)


class OtpTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.conn = connect(Path(self._tmp.name) / "t.db")
        self.account_id = auth.complete_sign_in(self.conn, auth.start_sign_in(self.conn, "a@b.c"))

    def test_correct_code_verifies_the_phone(self):
        code = auth.send_otp(self.conn, self.account_id, "+27821234567")
        self.assertTrue(auth.check_otp(self.conn, self.account_id, code))
        row = self.conn.execute(
            "SELECT * FROM users WHERE id = ?", (self.account_id,)
        ).fetchone()
        self.assertEqual(row["phone_verified"], 1)
        self.assertEqual(row["phone"], "+27821234567")

    def test_wrong_code_fails(self):
        auth.send_otp(self.conn, self.account_id, "+27821234567")
        self.assertFalse(auth.check_otp(self.conn, self.account_id, "000000"))

    def test_the_code_itself_is_never_stored(self):
        code = auth.send_otp(self.conn, self.account_id, "+27821234567")
        row = self.conn.execute("SELECT code_hash FROM otps").fetchone()
        self.assertNotIn(code, row["code_hash"])

    def test_guessing_is_capped(self):
        """Six digits falls quickly without an attempt limit."""
        code = auth.send_otp(self.conn, self.account_id, "+27821234567")
        for _ in range(auth.OTP_MAX_ATTEMPTS):
            auth.check_otp(self.conn, self.account_id, "000000")
        self.assertFalse(auth.check_otp(self.conn, self.account_id, code),
                         "the correct code must not work after too many attempts")

    def test_expired_code_fails(self):
        auth.send_otp(self.conn, self.account_id, "+27821234567")
        self.conn.execute("UPDATE otps SET expires_at = ?", (int(time.time()) - 1,))
        self.conn.commit()
        self.assertFalse(auth.check_otp(self.conn, self.account_id, "123456"))


if __name__ == "__main__":
    unittest.main()
