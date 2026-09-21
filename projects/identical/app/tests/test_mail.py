"""What gets sent, and what happens when it cannot be.

A link that never arrives is indistinguishable from a broken product, so most
of these are about the failure path and about the message being something a
recipient will actually trust.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import mail  # noqa: E402


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self._saved = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved)

    def test_no_smtp_host_means_the_console(self):
        """Development must not silently need a mail server."""
        os.environ.pop("IDENTICAL_SMTP_HOST", None)
        self.assertIsInstance(mail.from_env(), mail.ConsoleMailer)

    def test_an_smtp_host_selects_real_delivery(self):
        os.environ["IDENTICAL_SMTP_HOST"] = "smtp.example.net"
        mailer = mail.from_env()
        self.assertIsInstance(mailer, mail.SmtpMailer)
        self.assertEqual(mailer.port, 587, "STARTTLS submission by default")

    def test_port_and_credentials_are_read(self):
        os.environ.update({
            "IDENTICAL_SMTP_HOST": "smtp.example.net",
            "IDENTICAL_SMTP_PORT": "465",
            "IDENTICAL_SMTP_USER": "apikey",
            "IDENTICAL_SMTP_PASSWORD": "secret",
        })
        mailer = mail.from_env()
        self.assertEqual(mailer.port, 465)
        self.assertEqual(mailer.username, "apikey")

    def test_base_url_defaults_to_localhost_and_loses_a_trailing_slash(self):
        os.environ["IDENTICAL_BASE_URL"] = "https://app.identical.africa/"
        self.assertEqual(mail.base_url(), "https://app.identical.africa")
        os.environ.pop("IDENTICAL_BASE_URL")
        self.assertTrue(mail.base_url().startswith("http://localhost"))


class MessageTests(unittest.TestCase):
    def test_sign_in_carries_an_absolute_link(self):
        """A relative link works in the app and is dead in an inbox."""
        message = mail.sign_in_message("a@b.c", "https://app.identical.africa/signin/t", 20)
        self.assertIn("https://app.identical.africa/signin/t", message.text)
        self.assertIn("https://app.identical.africa/signin/t", message.html)

    def test_sign_in_states_the_expiry_and_reassures(self):
        message = mail.sign_in_message("a@b.c", "https://x/y", 20)
        self.assertIn("20 minutes", message.text)
        self.assertIn("did not ask", message.text)

    def test_invitation_names_the_organisation_and_the_person(self):
        """An unexplained link to an unknown product reads as phishing."""
        message = mail.invitation_message(
            "pr@co.za", "https://x/invite/t", "Sandton Mutual", "Thandi Mokoena", 14)
        for expected in ("Sandton Mutual", "Thandi Mokoena", "14 days"):
            self.assertIn(expected, message.text)
        self.assertIn("Sandton Mutual", message.subject)

    def test_both_messages_have_a_plain_text_body(self):
        """Some clients never render the HTML, and filters distrust HTML-only."""
        for message in (mail.sign_in_message("a@b.c", "https://x/y", 20),
                        mail.invitation_message("a@b.c", "https://x/y", "Co", "Someone", 14)):
            self.assertTrue(message.text.strip())
            self.assertTrue(message.html.strip())


class MemoryMailerTests(unittest.TestCase):
    def test_records_what_was_sent(self):
        mailer = mail.MemoryMailer()
        mailer.send(mail.sign_in_message("a@b.c", "https://x/y", 20))
        self.assertEqual(len(mailer.sent), 1)
        self.assertEqual(mailer.last_to("a@b.c").to, "a@b.c")

    def test_can_simulate_a_failure(self):
        mailer = mail.MemoryMailer(fail=True)
        with self.assertRaises(mail.MailError):
            mailer.send(mail.sign_in_message("a@b.c", "https://x/y", 20))

    def test_nothing_is_recorded_when_sending_fails(self):
        mailer = mail.MemoryMailer(fail=True)
        with self.assertRaises(mail.MailError):
            mailer.send(mail.sign_in_message("a@b.c", "https://x/y", 20))
        self.assertEqual(mailer.sent, [])


class SmtpFailureTests(unittest.TestCase):
    def test_an_unreachable_server_raises_mail_error_not_a_socket_error(self):
        """The caller catches one exception type, whatever the network did."""
        mailer = mail.SmtpMailer(host="127.0.0.1", port=1)
        with self.assertRaises(mail.MailError):
            mailer.send(mail.sign_in_message("a@b.c", "https://x/y", 20))

    def test_the_timeout_is_short_enough_not_to_hold_a_request(self):
        self.assertLessEqual(mail.SMTP_TIMEOUT_SECONDS, 15)


if __name__ == "__main__":
    unittest.main()
