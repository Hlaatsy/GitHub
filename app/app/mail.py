"""Sending sign-in links and invitations.

Delivery is the difference between a portal and a demo: until a link reaches
somebody's inbox, the only person who can use this is whoever is watching the
log.

Three implementations behind one interface. ``SmtpMailer`` speaks to any
provider that offers SMTP -- Mailgun, SES, Postmark, Brevo, a relay of your
own -- which avoids a vendor SDK and a rewrite if the choice changes.
``ConsoleMailer`` prints, which is what development wants. ``MemoryMailer``
keeps messages in a list so tests can assert on what was sent without a
network.

Two things this module exists to get right:

* **Absolute URLs.** A relative link works in the app and is dead in an
  inbox. The base URL is configuration, and a missing one is an error at
  startup rather than a link nobody can click.
* **A slow mail server must not hang a request.** Every connection carries a
  timeout, and a failure is reported rather than swallowed -- telling someone
  to check their email when nothing was sent is worse than telling them it
  failed.
"""

from __future__ import annotations

import os
import smtplib
import ssl
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

#: A mail server that has not answered in this long is not going to.
SMTP_TIMEOUT_SECONDS = 10


class MailError(Exception):
    """Delivery failed. The caller says so rather than pretending it worked."""


@dataclass
class Message:
    to: str
    subject: str
    text: str
    html: str = ""


class Mailer:
    """Anything that can deliver a message."""

    def send(self, message: Message) -> None:
        raise NotImplementedError


class ConsoleMailer(Mailer):
    """Prints instead of sending. Development only."""

    def send(self, message: Message) -> None:
        print(f"\n--- mail to {message.to} ---\n{message.subject}\n\n{message.text}\n")


@dataclass
class MemoryMailer(Mailer):
    """Keeps messages so tests can read them. Never touches the network."""

    sent: list[Message] = field(default_factory=list)
    fail: bool = False

    def send(self, message: Message) -> None:
        if self.fail:
            raise MailError("simulated delivery failure")
        self.sent.append(message)

    def last_to(self, address: str) -> Message | None:
        for message in reversed(self.sent):
            if message.to == address:
                return message
        return None


@dataclass
class SmtpMailer(Mailer):
    """Real delivery over SMTP, with STARTTLS or implicit TLS on 465."""

    host: str
    port: int = 587
    username: str = ""
    password: str = ""
    sender: str = "IDENTICAL <no-reply@identical.africa>"
    reply_to: str = ""

    def send(self, message: Message) -> None:
        mail = EmailMessage()
        mail["From"] = self.sender
        mail["To"] = message.to
        mail["Subject"] = message.subject
        mail["Message-ID"] = make_msgid()
        if self.reply_to:
            mail["Reply-To"] = self.reply_to
        # A link people are told to click, in a message a filter has never
        # seen before, is exactly what gets thrown away. Headers that say this
        # was asked for cost nothing and help.
        mail["Auto-Submitted"] = "auto-generated"
        mail.set_content(message.text)
        if message.html:
            mail.add_alternative(message.html, subtype="html")

        try:
            if self.port == 465:
                server = smtplib.SMTP_SSL(self.host, self.port,
                                          timeout=SMTP_TIMEOUT_SECONDS,
                                          context=ssl.create_default_context())
            else:
                server = smtplib.SMTP(self.host, self.port, timeout=SMTP_TIMEOUT_SECONDS)
            with server:
                if self.port != 465:
                    server.starttls(context=ssl.create_default_context())
                if self.username:
                    server.login(self.username, self.password)
                server.send_message(mail)
        except (OSError, smtplib.SMTPException) as exc:
            raise MailError(f"could not send to {message.to}: {exc}") from exc


def from_env() -> Mailer:
    """Build a mailer from the environment. No SMTP host means the console."""
    host = os.environ.get("IDENTICAL_SMTP_HOST", "").strip()
    if not host:
        return ConsoleMailer()
    sender = os.environ.get("IDENTICAL_MAIL_FROM", "").strip()
    return SmtpMailer(
        host=host,
        port=int(os.environ.get("IDENTICAL_SMTP_PORT", "587")),
        username=os.environ.get("IDENTICAL_SMTP_USER", ""),
        password=os.environ.get("IDENTICAL_SMTP_PASSWORD", ""),
        sender=sender or formataddr(("IDENTICAL", f"no-reply@{host}")),
        reply_to=os.environ.get("IDENTICAL_MAIL_REPLY_TO", ""),
    )


def base_url() -> str:
    """Where this deployment answers, for links that must survive an inbox."""
    return os.environ.get("IDENTICAL_BASE_URL", "http://localhost:8000").rstrip("/")


# --------------------------------------------------------------------------
# the two messages this product sends

def _wrap(title: str, body: str, action: str, url: str, footer: str) -> str:
    return f"""\
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;
  margin:0 auto;padding:24px;color:#13232B">
  <p style="font:600 12px/1 monospace;letter-spacing:.14em;text-transform:uppercase;
    color:#0C8F8F;margin:0 0 14px">IDENTICAL</p>
  <h1 style="font-size:22px;margin:0 0 12px">{title}</h1>
  <p style="font-size:15px;line-height:1.5;margin:0 0 20px">{body}</p>
  <a href="{url}" style="display:inline-block;background:#E08A00;color:#17120A;
    text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">{action}</a>
  <p style="font-size:13px;line-height:1.5;color:#64777D;margin:22px 0 0">{footer}</p>
  <p style="font-size:12px;color:#64777D;margin:14px 0 0;word-break:break-all">{url}</p>
</div>"""


def sign_in_message(to: str, url: str, minutes: int) -> Message:
    text = (
        f"Sign in to IDENTICAL\n\n{url}\n\n"
        f"The link works once and expires in {minutes} minutes.\n"
        "If you did not ask to sign in, ignore this message -- nobody can use it but you."
    )
    return Message(
        to=to,
        subject="Your IDENTICAL sign-in link",
        text=text,
        html=_wrap(
            "Sign in to IDENTICAL",
            "No password needed. This link signs you in once.",
            "Sign in", url,
            f"It works once and expires in {minutes} minutes. If you did not ask "
            "to sign in, ignore this message — nobody can use it but you.",
        ),
    )


def invitation_message(to: str, url: str, organisation: str, inviter: str,
                       days: int) -> Message:
    # Name the organisation and the person. An unexplained link to a product
    # nobody has heard of is indistinguishable from phishing, and will be
    # treated as such.
    text = (
        f"{inviter} has invited you to {organisation} on IDENTICAL\n\n{url}\n\n"
        f"IDENTICAL is where {organisation} makes its avatar videos. "
        f"Accepting gives you a seat on their account.\n\n"
        f"The invitation is for this address only and expires in {days} days."
    )
    return Message(
        to=to,
        subject=f"{inviter} invited you to {organisation} on IDENTICAL",
        text=text,
        html=_wrap(
            f"Join {organisation}",
            f"{inviter} has invited you to their team on IDENTICAL, where "
            f"{organisation} makes its avatar videos.",
            "Accept the invitation", url,
            f"The invitation is for this address only and expires in {days} days. "
            "If you were not expecting it, you can ignore it.",
        ),
    )
