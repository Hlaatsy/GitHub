"""Taking money.

Weighted towards the ways money goes wrong quietly: a replayed webhook, a
tampered amount, an unsigned request, a reference we never issued.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import auth, billing, payments, plans, teams  # noqa: E402
from app.db import connect  # noqa: E402


class GatewaySelectionTests(unittest.TestCase):
    def setUp(self):
        self._saved = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved)

    def test_no_key_means_the_stub(self):
        os.environ.pop("PAYSTACK_SECRET_KEY", None)
        self.assertIsInstance(payments.from_env(), payments.StubGateway)

    def test_a_key_selects_paystack(self):
        os.environ["PAYSTACK_SECRET_KEY"] = "sk_test_abc"
        self.assertIsInstance(payments.from_env(), payments.PaystackGateway)

    def test_references_are_unique_and_ours(self):
        made = {payments.new_reference() for _ in range(200)}
        self.assertEqual(len(made), 200)
        self.assertTrue(all(r.startswith("idt_") for r in made))


class SignatureTests(unittest.TestCase):
    """The webhook endpoint is public, so this is the only thing guarding it."""

    def setUp(self):
        self.gateway = payments.PaystackGateway(secret_key="sk_test_secret")
        self.body = json.dumps({"event": "charge.success"}).encode()

    def sign(self, body: bytes, key: str = "sk_test_secret") -> str:
        return hmac.new(key.encode(), body, hashlib.sha512).hexdigest()

    def test_a_correct_signature_passes(self):
        self.assertTrue(self.gateway.signature_ok(self.body, self.sign(self.body)))

    def test_a_wrong_key_fails(self):
        self.assertFalse(
            self.gateway.signature_ok(self.body, self.sign(self.body, "sk_other"))
        )

    def test_a_changed_body_fails(self):
        signature = self.sign(self.body)
        self.assertFalse(self.gateway.signature_ok(self.body + b" ", signature))

    def test_a_missing_signature_fails(self):
        self.assertFalse(self.gateway.signature_ok(self.body, ""))

    def test_sha512_not_sha256(self):
        """Paystack signs with SHA-512; SHA-256 silently never matches."""
        wrong = hmac.new(b"sk_test_secret", self.body, hashlib.sha256).hexdigest()
        self.assertFalse(self.gateway.signature_ok(self.body, wrong))


class SettlementTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.conn = connect(Path(self._tmp.name) / "t.db")
        self.user_id = auth.complete_sign_in(self.conn, auth.start_sign_in(self.conn, "o@co.za"))
        self.org_id = teams.create_organisation(self.conn, self.user_id, "Co")
        self.pack = plans.TOKEN_PACKS[0]
        self.reference = payments.new_reference()
        billing.record_payment(self.conn, self.org_id, self.user_id, self.reference,
                               "tokens", str(self.pack.tokens), self.pack.cents)

    def org(self):
        return self.conn.execute(
            "SELECT * FROM organisations WHERE id = ?", (self.org_id,)
        ).fetchone()

    def test_nothing_is_credited_before_payment(self):
        """Recording what is owed must not hand over the goods."""
        self.assertEqual(billing.live_tokens(self.conn, self.org_id), 0)

    def test_paying_credits_the_tokens(self):
        self.assertEqual(
            billing.apply_payment(self.conn, self.reference, self.pack.cents), "applied"
        )
        self.assertEqual(billing.live_tokens(self.conn, self.org_id), self.pack.tokens)

    def test_applying_twice_credits_once(self):
        """A webhook is delivered more than once by design."""
        billing.apply_payment(self.conn, self.reference, self.pack.cents)
        self.assertEqual(
            billing.apply_payment(self.conn, self.reference, self.pack.cents), "already"
        )
        self.assertEqual(billing.live_tokens(self.conn, self.org_id), self.pack.tokens)

    def test_paying_less_is_refused(self):
        """Otherwise a tampered callback buys fifty tokens for one rand."""
        with self.assertRaises(billing.PaymentMismatch):
            billing.apply_payment(self.conn, self.reference, 100)
        self.assertEqual(billing.live_tokens(self.conn, self.org_id), 0)

    def test_paying_more_is_also_refused(self):
        with self.assertRaises(billing.PaymentMismatch):
            billing.apply_payment(self.conn, self.reference, self.pack.cents + 1)

    def test_an_unknown_reference_does_nothing(self):
        self.assertEqual(
            billing.apply_payment(self.conn, "idt_never_issued", 100), "unknown"
        )

    def test_a_plan_payment_changes_the_plan(self):
        reference = payments.new_reference()
        billing.record_payment(self.conn, self.org_id, self.user_id, reference,
                               "plan", "pro", plans.PLANS["pro"].cents)
        billing.apply_payment(self.conn, reference, plans.PLANS["pro"].cents)
        self.assertEqual(self.org()["plan"], "pro")

    def test_a_settled_payment_is_recorded_as_paid(self):
        billing.apply_payment(self.conn, self.reference, self.pack.cents, "pstk_123")
        row = billing.pending_payment(self.conn, self.reference)
        self.assertEqual(row["status"], "paid")
        self.assertEqual(row["gateway_ref"], "pstk_123")
        self.assertTrue(row["applied_at"])

    def test_the_ledger_records_both_ends(self):
        billing.apply_payment(self.conn, self.reference, self.pack.cents)
        kinds = [r["kind"] for r in
                 self.conn.execute("SELECT kind FROM ledger WHERE org_id = ?",
                                   (self.org_id,))]
        self.assertIn("payment_started", kinds)
        self.assertIn("payment_settled", kinds)


class StubGatewayTests(unittest.TestCase):
    def test_it_remembers_the_amount_it_was_asked_for(self):
        gateway = payments.StubGateway()
        gateway.initialise("idt_x", "a@b.c", 39500, "http://localhost/cb", {})
        self.assertEqual(gateway.verify("idt_x").cents, 39500)

    def test_it_can_simulate_a_failed_payment(self):
        gateway = payments.StubGateway(paid=False)
        gateway.initialise("idt_x", "a@b.c", 100, "http://localhost/cb", {})
        self.assertFalse(gateway.verify("idt_x").paid)


if __name__ == "__main__":
    unittest.main()
