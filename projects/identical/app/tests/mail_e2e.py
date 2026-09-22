"""Point the app at a real SMTP server and read what lands in the inbox."""
import sys, threading, time, email, io, contextlib, tempfile, pathlib, re, os, asyncore, smtpd
import urllib.request, urllib.parse, http.cookiejar
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
PORT = 8456
B = f"http://localhost:{PORT}"
out, fails, inbox = sys.stderr, [], []
def check(label, ok):
    if not ok: fails.append(label)
    print(f"  {'PASS' if ok else 'FAIL'}  {label}", file=out)
def body_of(msg):
    """What a mail client shows: the decoded plain-text part."""
    part = msg.get_payload(0) if msg.is_multipart() else msg
    return part.get_payload(decode=True).decode()

class Catcher(smtpd.SMTPServer):
    def process_message(self, peer, mailfrom, rcpttos, data, **kw):
        inbox.append(email.message_from_bytes(data))

Catcher(("127.0.0.1", 8031), None)
threading.Thread(target=asyncore.loop, kwargs={"timeout": 0.5}, daemon=True).start()

# The base URL has to be the address this test actually reaches, not a
# pretend production one: an https base marks session cookies Secure, and a
# client will then refuse to keep them over the plain http this server
# speaks -- which is the protection working, and makes the run impossible.
# That https links come out https is asserted in tests/test_mail.py instead.
os.environ["IDENTICAL_BASE_URL"] = B
os.environ["IDENTICAL_SECRET"] = "test-secret-not-for-anything-real"
from app import mail, server as appserver

class Plain(mail.SmtpMailer):
    """The local catcher speaks plain SMTP; everything else is the real path."""
    def send(self, message):
        import smtplib
        from email.message import EmailMessage
        m = EmailMessage()
        m["From"], m["To"], m["Subject"] = self.sender, message.to, message.subject
        m.set_content(message.text)
        if message.html:
            m.add_alternative(message.html, subtype="html")
        try:
            with smtplib.SMTP(self.host, self.port, timeout=5) as s:
                s.send_message(m)
        except OSError as exc:
            raise mail.MailError(str(exc)) from exc

appserver.MAILER = Plain(host="127.0.0.1", port=8031,
                         sender="IDENTICAL <no-reply@identical.africa>")
DB = pathlib.Path(tempfile.mkdtemp())/"mail.db"
log = io.StringIO()
def run():
    with contextlib.redirect_stdout(log):
        appserver.serve(PORT, str(DB))
threading.Thread(target=run, daemon=True).start()
time.sleep(0.8)

o = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
g = lambda p: o.open(B+p).read().decode()
pp = lambda p, **d: o.open(B+p, urllib.parse.urlencode(d).encode()).read().decode()

print("\n--- sign-in email ---", file=out)
page = pp("/signin", email="thandi@sandtonmutual.co.za"); time.sleep(0.4)
check("page says check your email", "Link sent" in page)
check("no dev shortcut once a mail server is configured", "console" not in page)
check("one message delivered", len(inbox) == 1)
msg = inbox[-1]
check("subject is clear", "sign-in link" in msg["Subject"].lower())
check("from the configured sender", "no-reply@identical.africa" in msg["From"])
text = body_of(msg)
url = re.search(rf"{re.escape(B)}/signin/\S+", text)
check("link is absolute, not a bare path", url is not None
      and url.group(0).startswith("http"))
check("link fits on one line", url and len(url.group(0)) < 78)
check("expiry stated", "20 minutes" in text)
check("reassurance for someone who did not ask", "did not ask" in text)

print("\n--- the emailed link signs you in ---", file=out)
o.open(url.group(0))
pp("/org", name="Sandton Mutual")
check("signed in and organisation created", "Sandton Mutual" in g("/"))

print("\n--- invitation email ---", file=out)
# Seats, not payments, are what this test is about -- move the plan directly
# rather than through checkout.
import sqlite3 as _s
_c = _s.connect(str(DB)); _c.execute("UPDATE organisations SET plan='premium'"); _c.commit(); _c.close()
pp("/team/invite", email="pr@sandtonmutual.co.za"); time.sleep(0.4)
check("second message delivered", len(inbox) == 2)
inv = inbox[-1]
check("subject names the inviter and the organisation",
      "Sandton Mutual" in inv["Subject"] and "invited you" in inv["Subject"])
itext = body_of(inv)
check("body explains who invited them and to what",
      "Sandton Mutual" in itext and "seat" in itext)
ilink = re.search(rf"{re.escape(B)}/invite/\S+", itext)
check("invite link absolute and short", ilink and len(ilink.group(0)) < 78)
check("seat is held while it is outstanding", "2 of 3 seats used" in g("/team"))

print("\n--- the invitation actually works ---", file=out)
guest = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
guest.open(B + "/signin", urllib.parse.urlencode({"email": "pr@sandtonmutual.co.za"}).encode())
time.sleep(0.4)
guest.open(re.search(rf"{re.escape(B)}/signin/\S+",
                     body_of(inbox[-1])).group(0))
guest.open(ilink.group(0))
check("colleague joined the organisation",
      "Sandton Mutual" in guest.open(B + "/").read().decode())

print("\n--- a failed send must not hold a seat ---", file=out)
appserver.MAILER = mail.MemoryMailer(fail=True)
page = pp("/team/invite", email="another@sandtonmutual.co.za")
check("failure reported to the owner", "Invitation not sent" in page)
check("seat released again", "2 of 3 seats used" in g("/team"))
check("that address can be invited again",
      "already has a seat" not in pp("/team/invite", email="another@sandtonmutual.co.za"))

print(f"\n{len(fails)} failure(s)" + (": " + "; ".join(fails) if fails else ""), file=out)
sys.exit(1 if fails else 0)
