"""The IDENTICAL portal. Standard library only.

Nothing here is reachable without signing in. The only anonymous pages are
the sign-in form and the link that completes it -- every other route resolves
a user from the session cookie and an organisation from that user's
membership, and refuses if either is missing.

That is not belt-and-braces. An organisation's avatars are real people's
likenesses and its consent register is the thing we sell; a portal that can be
read without an account is a portal that cannot honestly claim either.
"""

from __future__ import annotations

import hashlib
import hmac
import html
import http.cookies
import json
import os
import secrets
import sqlite3
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import approvals, auth, billing, mail, payments, plans, teams
from .db import Pool, log, now
from .provider import StubProvider, share_encode

def _secret() -> bytes:
    """The key that signs session cookies.

    Generated per run when unset, which is right for development and wrong
    everywhere else: a new key signs everybody out on restart, and two
    machines with different keys cannot read each other's sessions at all.
    So a deployment serving https must set it, and is refused if it has not.
    """
    configured = os.environ.get("IDENTICAL_SECRET", "").strip()
    if configured:
        return configured.encode()
    if mail.base_url().startswith("https://"):
        raise SystemExit(
            "IDENTICAL_SECRET is not set. Without it every restart signs all "
            "users out, and a second machine cannot read the first's sessions.\n"
            "Generate one with:  python -c \"import secrets;print(secrets.token_hex(32))\""
        )
    return secrets.token_hex(32).encode()


SECRET = _secret()

#: Cookies must not travel in the clear once the site is served over https.
#: Set from the base URL rather than a separate switch, so it cannot drift
#: out of step with how the site is actually reached.
COOKIE_FLAGS = ("Path=/; HttpOnly; SameSite=Lax; Secure"
                if mail.base_url().startswith("https://")
                else "Path=/; HttpOnly; SameSite=Lax")

PROVIDER = StubProvider()
POOL: Pool | None = None

#: How links reach people. With no SMTP host configured this prints to the
#: console, which is what development wants and production must not have.
MAILER = mail.from_env()

#: Paystack when a secret key is set, otherwise a stub that treats every
#: checkout as paid -- which is what development wants and production must
#: never have.
GATEWAY = payments.from_env()


def db() -> sqlite3.Connection:
    return POOL.conn


def sign(user_id: int) -> str:
    mac = hmac.new(SECRET, str(user_id).encode(), hashlib.sha256).hexdigest()[:32]
    return f"{user_id}.{mac}"


def unsign(token: str) -> int | None:
    try:
        raw, mac = token.split(".", 1)
    except ValueError:
        return None
    if hmac.compare_digest(mac, hmac.new(SECRET, raw.encode(), hashlib.sha256).hexdigest()[:32]):
        return int(raw)
    return None


def e(text: object) -> str:
    return html.escape(str(text))


def rand(cents: int) -> str:
    return f"R{cents // 100:,}".replace(",", " ")


STYLE = (Path(__file__).resolve().parent / "app.css").read_text(encoding="utf-8")


def page(body: str, member: sqlite3.Row | None = None, tab: str = "") -> bytes:
    nav = ""
    if member is not None:
        items = [("/", "⌂", "Home", "home"), ("/create", "＋", "Create", "create"),
                 ("/reviews", "✓", "Approvals", "reviews"),
                 ("/team", "◉", "Team", "team"), ("/plan", "◷", "Plan", "plan")]
        nav = '<nav class="nav">' + "".join(
            f'<a href="{href}"{" aria-current=page" if key == tab else ""}>'
            f'<span class="glyph" aria-hidden="true">{glyph}</span>{label}</a>'
            for href, glyph, label, key in items
        ) + "</nav>"
    return (
        "<!doctype html><html lang=en><head><meta charset=utf-8>"
        '<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">'
        "<title>IDENTICAL</title>"
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
        "family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&"
        'family=Public+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap">'
        f"<style>{STYLE}</style></head><body>"
        f'<main class="app">{body}</main>{nav}</body></html>'
    ).encode("utf-8")


# --------------------------------------------------------------------------
# views

def view_signin(sent_to: str = "", link: str = "", error: str = "") -> str:
    if error:
        # Delivery failed, so say so. "Check your email" when nothing was sent
        # leaves someone waiting on a message that will never arrive.
        return (
            '<header class="hero"><div class="eyebrow">Not sent</div>'
            "<h1>We could not send that email</h1>"
            "<p>Something is wrong at our end, not yours. Try again in a minute — "
            "if it keeps failing, tell us.</p></header>"
            f'<div class="warn">{e(error)}</div>'
            '<a class="act ghost" href="/">Back</a>'
        )
    if sent_to:
        shown = (
            f'<div class="warn">Development build: mail goes to the console. '
            f'<a href="{e(link)}">Open the sign-in link</a>.</div>' if link else ""
        )
        return (
            '<header class="hero"><div class="eyebrow">Check your email</div>'
            f"<h1>Link sent to {e(sent_to)}</h1>"
            f"<p>It signs you in once and expires in "
            f"{auth.LINK_TTL_SECONDS // 60} minutes. No password to remember, "
            "and nothing for us to lose.</p></header>" + shown
        )
    tiers = "".join(
        f'<div class="tier{" pick" if key == "starter" else ""}">'
        f'<div class="tier-name">{e(plans.PLANS[key].name)}</div>'
        f'<div class="price">{plans.PLANS[key].rand}<span>/mo</span></div>'
        f'<div class="quota"><b>{plans.PLANS[key].tokens - plans.AVATAR_TOKENS} videos</b>'
        f'<small>after your avatar · {plans.PLANS[key].tokens} tokens</small>'
        "</div></div>"
        for key in plans.ORDER
    )
    return (
        '<header class="hero"><div class="eyebrow">Made in South Africa</div>'
        "<h1>Post every day without filming every day.</h1>"
        "<p>Send one photo. Get an avatar that speaks your script, in your voice, "
        "for R149 a month — a third of what the overseas tools charge, and billed "
        "in rands.</p></header>"
        f'<section class="tiers">{tiers}</section>'
        '<form method="post" action="/signin" class="card">'
        "<h2>Start free</h2>"
        "<p class=sub>An avatar and three videos, no card. We email you a link — "
        "no password to remember.</p>"
        '<label class=fld>Your email<input name=email type=email required '
        'autocomplete="email"></label>'
        '<button class="act">Email me a link</button></form>'
    )


def view_new_org(user: sqlite3.Row) -> str:
    return (
        f'<h1 class="app-h">Welcome, {e(user["name"] or user["email"])}</h1>'
        '<form method="post" action="/org" class="card">'
        "<h2>What should we call your account?</h2>"
        "<p class=sub>Your name or your business name — either is fine. Avatars and "
        "videos belong to the account, so anyone you add later shares them.</p>"
        '<label class=fld>Name<input name=name required '
        'placeholder="e.g. Thandi Mokoena, or Mokoena Consulting"></label>'
        '<button class="act">Create it</button></form>'
    )


def meter(conn: sqlite3.Connection, org: sqlite3.Row) -> str:
    """One meter, because there is one pool."""
    plan = plans.PLANS[org["plan"]]
    included = billing.allowance_left(org)
    topped = billing.live_tokens(conn, org["id"])
    total = included + topped
    pct = (included / plan.tokens * 100) if plan.tokens else 0
    extra = f" · plus {topped} topped up" if topped else ""
    return (
        '<div class="meter"><div class="meter-top">'
        f'<span class="meter-n">{total} tokens</span>'
        f'<span class="meter-plan">{e(plan.name)} · {plan.rand}</span></div>'
        f'<div class="track"><div class="fill{"" if total else " out"}" '
        f'style="width:{pct:.0f}%"></div></div>'
        f"<small>{included} of {plan.tokens} included left{extra} · "
        f"a video is {plans.VIDEO_TOKENS}, an avatar is {plans.AVATAR_TOKENS}</small></div>"
    )


def view_home(conn: sqlite3.Connection, org: sqlite3.Row, member: sqlite3.Row,
              user: sqlite3.Row) -> str:
    plan = plans.PLANS[org["plan"]]
    avatars = conn.execute(
        "SELECT * FROM avatars WHERE org_id = ? ORDER BY id", (org["id"],)
    ).fetchall()
    videos = conn.execute(
        "SELECT v.*, u.name AS author FROM videos v LEFT JOIN users u ON u.id = v.created_by"
        " WHERE v.org_id = ? ORDER BY v.id DESC LIMIT 6", (org["id"],)
    ).fetchall()
    spare = billing.avatars_affordable(conn, org)

    cards = "".join(
        f'<div class="avatar"><div class="face"></div><div>'
        f'<div class="avatar-name">{e(a["name"])}</div>'
        f'<div class="sub">'
        f'{"real person · consent on file" if a["source"] == "upload" else "generated · synthetic"}'
        f' · {e(a["voice_kind"])} voice</div></div></div>'
        for a in avatars
    )

    if spare > 0:
        build = (
            '<form method="post" action="/avatar" class="avatar-new">'
            f'<h2>{"Build your first avatar" if not avatars else "Add an avatar"}</h2>'
            f'<p class=sub>Either way it is {plans.AVATAR_TOKENS} tokens from the '
            f'same pool as your videos — no separate fee.</p>'
            '<label class=fld>How'
            '<select name=source>'
            '<option value="upload">Upload a photo or footage of a real person</option>'
            '<option value="generated">Generate a presenter — no real person</option>'
            "</select></label>"
            '<label class=fld>Whose avatar is this'
            '<input name=name placeholder="Name of the presenter" required></label>'
            '<button class="act cool">Build it</button></form>'
        )
    else:
        build = (
            f'<div class="warn">An avatar is {plans.AVATAR_TOKENS} tokens and you '
            f'have {billing.tokens_left(conn, org)}. '
            f'<a href="/plan">Top up or move up a plan</a>.</div>'
        )

    count = (
        f'<div class="sub">{len(avatars)} avatar{"s" if len(avatars) != 1 else ""}'
        f'{f" · tokens for {spare} more" if spare else " · not enough tokens for another"}'
        "</div>"
    ) if avatars else ""

    left = billing.videos_left(conn, org)
    rows = "".join(
        f'<div class="vid"><div class="thumb">{"▶" if v["status"] == "ready" else "◷"}</div>'
        f'<div><div class="vid-t">{e(v["title"])}</div>'
        f'<div class="vid-m">{v["seconds"]}s · {round(v["bytes"]/1048576, 1)} MB · '
        f'{e(v["author"] or "—")}</div></div></div>'
        for v in videos
    ) or '<p class="sub">Nothing yet.</p>'

    return (
        f'<h1 class="app-h">{e(org["name"] or "Your organisation")}</h1>'
        f'<div class="sub">Signed in as {e(user["email"])} · {e(member["role"])}</div>'
        f"{count}{cards}{build}{meter(conn, org)}"
        + ('<a class="act" href="/create">New video</a>' if left and avatars
           else '<a class="act" href="/plan">Out of videos — see options</a>' if avatars
           else "")
        + f'<section><div class="sub" style="margin-bottom:4px">Recent</div>{rows}</section>'
    )


def view_create(conn: sqlite3.Connection, org: sqlite3.Row, error: str = "") -> str:
    plan = plans.PLANS[org["plan"]]
    avatars = conn.execute(
        "SELECT * FROM avatars WHERE org_id = ? ORDER BY id", (org["id"],)
    ).fetchall()
    picker = ""
    if len(avatars) > 1:
        picker = ("<label class=fld>Presented by<select name=avatar>" + "".join(
            f'<option value="{a["id"]}">{e(a["name"])}</option>' for a in avatars
        ) + "</select></label>")
    voices = ["Cloned voice"] if plan.custom_voice else []
    voices += ["Thandi — SA English", "Sipho — isiZulu"]
    options = "".join(f"<option>{e(v)}</option>" for v in voices)
    warn = f'<div class="warn">{e(error)}</div>' if error else ""
    return (
        '<h1 class="app-h">New video</h1>' + warn +
        '<form method="post" action="/create" class="card">' + picker +
        '<label class=fld>Title<input name=title required '
        'placeholder="What is this one for?"></label>'
        "<label class=fld>Script"
        '<textarea name=script rows=8 required '
        'placeholder="Type or paste what your avatar should say…"></textarea></label>'
        f'<div class="est">Up to {plans.MAX_VIDEO_SECONDS // 60} minutes — about '
        f'{plans.MAX_VIDEO_SECONDS * 145 // 60} words</div>'
        f"<label class=fld>Voice<select name=voice>{options}</select></label>"
        '<button class="act cool">Generate video</button></form>'
    )


def view_ready(conn: sqlite3.Connection, video: sqlite3.Row,
               member: sqlite3.Row | None = None, org: sqlite3.Row | None = None) -> str:
    megabytes = round(video["bytes"] / 1048576, 1)
    fits = video["bytes"] <= 16 * 1024 * 1024
    state = video["approval"]

    if approvals.publishable(video):
        gate = ('<div class="share"><button type=button>WhatsApp</button>'
                "<button type=button>Download</button></div>")
        if state == approvals.APPROVED:
            last = approvals.history(conn, video["id"])
            who = last[0]["decided_name"] or last[0]["decided_email"] if last else "an owner"
            gate = (f'<div class="ok">Approved by {e(who)}.</div>' + gate)
    elif state == approvals.PENDING:
        gate = ('<div class="warn">Waiting for approval. It cannot be shared or '
                "downloaded until an owner clears it.</div>")
    else:
        note = approvals.history(conn, video["id"])
        reason = note[0]["note"] if note else ""
        gate = (f'<div class="warn">Not approved.{" " + e(reason) if reason else ""}'
                "</div>"
                '<form method="post" action="/approve">'
                f'<input type=hidden name=video value="{video["id"]}">'
                '<input type=hidden name=decision value="resubmit">'
                '<button class="act ghost">Send back for review</button></form>')

    decide = ""
    if member is not None and org is not None and state == approvals.PENDING:
        allowed, why = approvals.can_decide(conn, org, member, video)
        if allowed:
            decide = (
                '<form method="post" action="/approve" class="card">'
                f'<input type=hidden name=video value="{video["id"]}">'
                '<label class=fld>Note (required to reject)'
                '<input name=note placeholder="What needs changing?"></label>'
                '<button class="act cool" name=decision value="approved">Approve</button>'
                '<button class="act ghost" name=decision value="rejected">Reject</button>'
                "</form>"
            )
        else:
            decide = f'<p class="sub">{e(why)}</p>'

    return (
        '<div class="done"><div class="player">▶</div>'
        f'<h1 class="app-h">{e(video["title"])}</h1>'
        f'<div class="filemeta">H.264 · 720p · {megabytes} MB'
        f"{' — fits WhatsApp' if fits else ' — too big for WhatsApp'}</div>"
        f'<div class="sub">Paid with your {e(video["paid_with"])}.</div>'
        f"{gate}{decide}"
        '<a class="act ghost" href="/">Done</a></div>'
    )


def view_reviews(conn: sqlite3.Connection, org: sqlite3.Row,
                 member: sqlite3.Row) -> str:
    """The queue an owner works through."""
    pending = approvals.waiting(conn, org["id"])
    if not approvals.required(org):
        return ('<h1 class="app-h">Approvals</h1>'
                '<p class="sub">Approval is off for this organisation. Turn it on '
                "and every new video waits for an owner before it can be shared.</p>"
                '<form method="post" action="/approvals/settings">'
                '<input type=hidden name=require value="1">'
                '<button class="act cool">Require approval</button></form>')

    rows = "".join(
        f'<a class="vid" href="/video/{v["id"]}" style="text-decoration:none">'
        f'<div class="thumb">◷</div><div><div class="vid-t">{e(v["title"])}</div>'
        f'<div class="vid-m">{e(v["author_name"] or v["author_email"] or "—")} · '
        f'{v["seconds"]}s</div></div></a>'
        for v in pending
    ) or '<p class="sub">Nothing waiting. Everything made has been cleared.</p>'

    four = (
        '<form method="post" action="/approvals/settings">'
        f'<input type=hidden name=four_eyes value="{0 if org["four_eyes"] else 1}">'
        f'<button class="mini">{"Turn off" if org["four_eyes"] else "Turn on"} '
        "four-eyes</button></form>"
    )
    return (
        '<h1 class="app-h">Waiting for approval</h1>'
        f'<div class="sub">{len(pending)} waiting · four-eyes '
        f'{"on — nobody clears their own work" if org["four_eyes"] else "off"}</div>'
        f'<div class="maths">{rows}</div>'
        + (four if member["role"] == teams.OWNER else "")
    )


def view_team(conn: sqlite3.Connection, org: sqlite3.Row, member: sqlite3.Row,
              error: str = "", link: str = "") -> str:
    plan = plans.PLANS[org["plan"]]
    people = teams.members(conn, org["id"])
    spare = teams.seats_left(conn, org)
    is_owner = member["role"] == teams.OWNER

    rows = "".join(
        '<div class="m-row"><span>'
        f'{e(row["user_name"] or row["invited_email"])}'
        f'{" <small>(invited)</small>" if row["status"] == teams.INVITED else ""}'
        f'</span><b>{e(row["role"])}</b>'
        + (f'<form method="post" action="/team/revoke" style="margin:0">'
           f'<input type=hidden name=id value="{row["id"]}">'
           f'<button class="mini">Remove</button></form>'
           if is_owner and row["role"] != teams.OWNER else "")
        + "</div>"
        for row in people
    )

    invite = ""
    if is_owner:
        if spare > 0:
            invite = (
                '<form method="post" action="/team/invite" class="card">'
                "<h2>Invite someone</h2>"
                f'<p class=sub>{spare} of {plan.seats} seats free. An invitation holds a '
                "seat until it is accepted or withdrawn.</p>"
                '<label class=fld>Their work email<input name=email type=email required>'
                "</label><button class=\"act cool\">Send invitation</button></form>"
            )
        else:
            invite = (
                f'<div class="warn">All {plan.seats} seats are taken or invited. '
                f'<a href="/plan">Move up a plan</a> to add more.</div>'
            )
    else:
        invite = '<p class="sub">Only an owner can invite or remove people.</p>'

    shown = (f'<div class="warn">Development build: mail goes to the console. '
             f'<a href="{e(link)}">Open the invitation link</a>.</div>' if link else "")
    warn = f'<div class="warn">{e(error)}</div>' if error else ""

    return (
        '<h1 class="app-h">Team</h1>'
        f'<div class="sub">{teams.seats_taken(conn, org["id"])} of {plan.seats} seats used</div>'
        + warn + shown +
        f'<div class="maths">{rows}</div>{invite}'
    )


def view_plan(conn: sqlite3.Connection, org: sqlite3.Row, member: sqlite3.Row) -> str:
    advice = plans.advise_at_cap(org["plan"])
    plan = plans.PLANS[org["plan"]]
    is_owner = member["role"] == teams.OWNER

    packs = "".join(
        '<form method="post" action="/tokens" class="m-row">'
        f'<input type=hidden name=tokens value="{pack.tokens}">'
        f"<span>{pack.tokens} tokens<small> · {rand(pack.cents_per_token)} each</small></span>"
        f"<b>{rand(pack.cents)}</b>"
        + ('<button class="mini">Buy</button>' if is_owner else "")
        + "</form>"
        for pack in plans.TOKEN_PACKS
    )
    upgrade = ""
    if advice.upgrade is not None and is_owner:
        upgrade = (
            '<form method="post" action="/upgrade">'
            f'<input type=hidden name=plan value="{advice.upgrade.key}">'
            f'<button class="act cool">Move to {e(advice.upgrade.name)} — '
            f"{advice.upgrade.rand}/mo</button></form>"
        )

    return (
        f'<h1 class="app-h">{e(plan.name)}</h1>{meter(conn, org)}'
        f'<div class="sub">{plan.seats} seat{"s" if plan.seats != 1 else ""} · '
        f'{plan.tokens} tokens a month · a video is {plans.VIDEO_TOKENS}, '
        f'an avatar is {plans.AVATAR_TOKENS}</div>'
        f'<div class="cap"><h2>Top up</h2><div class="maths">{packs}</div>'
        f'<p class="verdict">{e(advice.verdict)}</p></div>'
        '<p class="sub">Tokens pay for everything you make — videos and avatars '
        "alike. Topped-up tokens do not expire at month end, and there is no "
        "separate charge for creating an avatar.</p>"
        f"{upgrade}"
        + ("" if is_owner else '<p class="sub">Only an owner can change the plan.</p>')
        + '<a class="act ghost" href="/">Back</a>'
    )


# --------------------------------------------------------------------------
# request handling

class Handler(BaseHTTPRequestHandler):
    server_version = "identical"

    # -- context ----------------------------------------------------------

    def user(self) -> sqlite3.Row | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        cookie = http.cookies.SimpleCookie(raw)
        if "sid" not in cookie:
            return None
        user_id = unsign(cookie["sid"].value)
        if user_id is None:
            return None
        return db().execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()

    def context(self):
        """(user, membership, organisation). Any may be None; callers check."""
        user = self.user()
        if user is None:
            return None, None, None
        member = teams.membership(db(), user["id"])
        if member is None:
            return user, None, None
        org = db().execute(
            "SELECT * FROM organisations WHERE id = ?", (member["org_id"],)
        ).fetchone()
        return user, member, billing.roll_period(db(), org)

    # -- plumbing ---------------------------------------------------------

    def send(self, body: bytes, status: int = 200, cookie: str = "") -> None:
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, where: str, cookie: str = "") -> None:
        self.send_response(303)
        self.send_header("Location", where)
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def read_body(self) -> bytes:
        """The request body, as bytes. Readable once per request."""
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def form(self) -> dict[str, str]:
        raw = self.read_body().decode("utf-8")
        return {k: v[0] for k, v in urllib.parse.parse_qs(raw).items()}

    def log_message(self, *args: object) -> None:
        """Quiet. The ledger is the record that matters."""

    # -- GET --------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path == "/healthz":
            self.send(b"ok")
            return

        if path == "/payments/callback":
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            reference = (query.get("reference") or [""])[0]
            problem = self.settle(reference) if reference else "No payment reference."
            if problem:
                self.send(page(f'<div class="warn">{e(problem)}</div>'
                               '<a class="act ghost" href="/plan">Back</a>'))
                return
            self.redirect("/plan")
            return

        # The two anonymous routes, and nothing else.
        if path.startswith("/signin/"):
            try:
                user_id = auth.complete_sign_in(db(), path.split("/", 2)[2])
            except auth.AuthError as exc:
                self.send(page(f'<div class="warn">{e(exc)}</div>' + view_signin()))
                return
            self.redirect("/", f"sid={sign(user_id)}; {COOKIE_FLAGS}")
            return
        if path == "/signout":
            self.redirect("/", f"sid=; Max-Age=0; {COOKIE_FLAGS}")
            return

        user, member, org = self.context()
        if user is None:
            self.send(page(view_signin()))
            return
        if member is None:
            # Signed in, belongs to nothing yet.
            if path.startswith("/invite/"):
                self.accept_invite(path.split("/", 2)[2], user)
                return
            self.send(page(view_new_org(user)))
            return

        if path.startswith("/invite/"):
            self.accept_invite(path.split("/", 2)[2], user)
        elif path == "/":
            self.send(page(view_home(db(), org, member, user), member, "home"))
        elif path == "/create":
            if billing.videos_left(db(), org) <= 0:
                self.redirect("/plan")
                return
            self.send(page(view_create(db(), org), member, "create"))
        elif path == "/reviews":
            self.send(page(view_reviews(db(), org, member), member, "reviews"))
        elif path == "/team":
            self.send(page(view_team(db(), org, member), member, "team"))
        elif path == "/plan":
            self.send(page(view_plan(db(), org, member), member, "plan"))
        elif path.startswith("/video/"):
            video = db().execute(
                "SELECT * FROM videos WHERE id = ? AND org_id = ?",
                (path.rsplit("/", 1)[-1], org["id"]),
            ).fetchone()
            if video is None:
                self.send(page('<h1 class="app-h">Not found</h1>', member), 404)
                return
            self.send(page(view_ready(db(), video, member, org), member, "home"))
        else:
            self.send(page('<h1 class="app-h">Not found</h1>', member), 404)

    def start_payment(self, org, user, member, purpose: str, detail: str,
                      cents: int) -> None:
        """Record what is owed, then send the customer to the gateway."""
        reference = payments.new_reference()
        billing.record_payment(db(), org["id"], user["id"], reference,
                               purpose, detail, cents)
        try:
            checkout = GATEWAY.initialise(
                reference=reference,
                email=user["email"],
                cents=cents,
                callback_url=mail.base_url() + "/payments/callback",
                metadata={"org": org["id"], "purpose": purpose, "detail": detail},
            )
        except payments.PaymentError as exc:
            self.send(page(view_plan(db(), org, member).replace(
                '<h1 class="app-h">',
                f'<div class="warn">Could not start the payment: {e(exc)}</div>'
                '<h1 class="app-h">', 1), member, "plan"))
            return
        self.redirect(checkout.url)

    def settle(self, reference: str) -> str:
        """Verify with the gateway, then apply. Safe to call more than once."""
        try:
            result = GATEWAY.verify(reference)
        except payments.PaymentError as exc:
            return f"could not verify: {exc}"
        if not result.paid:
            return "That payment did not go through. Nothing has been charged."
        try:
            outcome = billing.apply_payment(db(), reference, result.cents,
                                            result.gateway_ref)
        except billing.PaymentMismatch as exc:
            # Either a tampered callback or a genuine mismatch. Neither is
            # something to credit; both are worth a human looking.
            print(f"PAYMENT MISMATCH {exc}")
            return "That payment does not match what was ordered. We have not applied it."
        return "" if outcome in ("applied", "already") else "Unknown payment reference."

    def accept_invite(self, token: str, user: sqlite3.Row) -> None:
        try:
            teams.accept(db(), token, user["id"])
        except (teams.InviteError, teams.NotPermitted) as exc:
            self.send(page(f'<div class="warn">{e(exc)}</div>'
                           '<a class="act ghost" href="/">Continue</a>'))
            return
        self.redirect("/")

    # -- POST -------------------------------------------------------------

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path

        # The webhook needs the body as bytes, and the request body can only
        # be read once -- so this branch comes before the form parsing, not
        # after it.
        if path == "/payments/webhook":
            # Public endpoint: nothing here is trusted until the signature
            # verifies against the raw body exactly as received.
            raw = self.read_body()
            signature = self.headers.get("x-paystack-signature", "")
            if not GATEWAY.signature_ok(raw, signature):
                self.send(b"", 401)
                return
            try:
                event = json.loads(raw.decode())
            except ValueError:
                self.send(b"", 400)
                return
            if event.get("event") == "charge.success":
                reference = (event.get("data") or {}).get("reference", "")
                if reference:
                    # Verify with the API rather than believing the payload,
                    # then apply -- which is idempotent, so a repeat delivery
                    # changes nothing.
                    self.settle(reference)
            # Acknowledge anything signed, or Paystack retries for days.
            self.send(b"", 200)
            return

        data = self.form()

        if path == "/signin":
            email = data.get("email", "").strip().lower()
            if not email:
                self.redirect("/")
                return
            token = auth.start_sign_in(db(), email)
            path_only = f"/signin/{token}"
            try:
                MAILER.send(mail.sign_in_message(
                    email, mail.base_url() + path_only, auth.LINK_TTL_SECONDS // 60))
            except mail.MailError as exc:
                self.send(page(view_signin(error=str(exc))))
                return
            # In development the console mailer has already printed it; the
            # in-page link saves a trip to the terminal. It is never rendered
            # once a real mail server is configured.
            shortcut = path_only if isinstance(MAILER, mail.ConsoleMailer) else ""
            self.send(page(view_signin(sent_to=email, link=shortcut)))
            return

        user, member, org = self.context()
        if user is None:
            self.redirect("/")
            return

        if path == "/org":
            if member is not None:
                self.redirect("/")
                return
            teams.create_organisation(db(), user["id"], data.get("name", "").strip())
            self.redirect("/")
            return

        if member is None:
            self.redirect("/")
            return

        if path == "/avatar":
            try:
                billing.claim_avatar(db(), org)
            except billing.OutOfTokens:
                # The form is hidden when the tokens will not stretch, but a
                # hidden form is not a limit -- the route has to refuse too.
                self.redirect("/plan")
                return
            plan = plans.PLANS[org["plan"]]
            source = "generated" if data.get("source") == "generated" else "upload"
            ref = PROVIDER.build_avatar(source, b"")
            name = data.get("name", "").strip() or "Presenter"
            avatar_id = db().execute(
                "INSERT INTO avatars (org_id, name, source, guided, voice_kind,"
                " provider_ref, created_by, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (org["id"], name, source, int(plan.guided_build),
                 "cloned" if plan.custom_voice else "stock", ref, user["id"], now()),
            ).lastrowid
            # An uploaded avatar is a real person, so a consent record is
            # written with it and never backfilled. A generated one has no
            # subject to consent -- recording one anyway would put a fictional
            # name in the register the organisation shows its regulator.
            if source == "upload":
                db().execute(
                    "INSERT INTO consents (avatar_id, subject_name, scope,"
                    " retention_until, agreed_at) VALUES (?, ?, ?, ?, ?)",
                    (avatar_id, name,
                     "Videos this organisation creates, until withdrawn", now(), now()),
                )
            billing.spend(db(), org, plans.AVATAR_TOKENS, "avatar", user_id=user["id"])
            db().commit()
            self.redirect("/")

        elif path == "/create":
            script = data.get("script", "").strip()
            try:
                seconds = billing.check_length(script)
            except billing.TooLong as exc:
                self.send(page(view_create(db(), org, str(exc)), member, "create"))
                return
            chosen = data.get("avatar", "")
            avatar = db().execute(
                "SELECT * FROM avatars WHERE org_id = ? AND (? = '' OR id = ?)"
                " ORDER BY id LIMIT 1", (org["id"], chosen, chosen),
            ).fetchone()
            if avatar is None:
                self.redirect("/")
                return
            try:
                paid_with = billing.spend(db(), org, plans.VIDEO_TOKENS, "video",
                                          user_id=user["id"])
            except billing.OutOfTokens:
                self.redirect("/plan")
                return
            render = share_encode(
                PROVIDER.render(avatar["provider_ref"], script, seconds, data.get("voice", ""))
            )
            video_id = db().execute(
                "INSERT INTO videos (org_id, avatar_id, created_by, title, script, seconds,"
                " status, approval, paid_with, bytes, provider_ref, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)",
                (org["id"], avatar["id"], user["id"],
                 data.get("title", "Untitled").strip() or "Untitled",
                 script, seconds, approvals.initial_state(org), paid_with,
                 render.bytes, render.ref, now()),
            ).lastrowid
            db().commit()
            self.redirect(f"/video/{video_id}")

        elif path == "/approve":
            video = db().execute(
                "SELECT * FROM videos WHERE id = ? AND org_id = ?",
                (data.get("video", 0), org["id"]),
            ).fetchone()
            if video is None:
                self.redirect("/reviews")
                return
            decision = data.get("decision", "")
            try:
                if decision == "resubmit":
                    approvals.resubmit(db(), org, video)
                else:
                    approvals.decide(db(), org, member, video, decision,
                                     data.get("note", ""))
            except (approvals.NotPermitted, approvals.NotPending) as exc:
                fresh = db().execute("SELECT * FROM videos WHERE id = ?",
                                     (video["id"],)).fetchone()
                self.send(page(f'<div class="warn">{e(exc)}</div>'
                               + view_ready(db(), fresh, member, org), member, "home"))
                return
            self.redirect(f"/video/{video['id']}")

        elif path == "/approvals/settings":
            try:
                teams.require_owner(member)
            except teams.NotPermitted:
                self.redirect("/reviews")
                return
            if "require" in data:
                db().execute("UPDATE organisations SET require_approval = ? WHERE id = ?",
                             (int(data["require"]), org["id"]))
                log(db(), org["id"], "approval_setting",
                    detail=f"require={data['require']}", user_id=user["id"])
            if "four_eyes" in data:
                db().execute("UPDATE organisations SET four_eyes = ? WHERE id = ?",
                             (int(data["four_eyes"]), org["id"]))
                log(db(), org["id"], "approval_setting",
                    detail=f"four_eyes={data['four_eyes']}", user_id=user["id"])
            db().commit()
            self.redirect("/reviews")

        elif path == "/team/invite":
            invited = data.get("email", "").strip().lower()
            try:
                token = teams.invite(db(), org, member, invited)
            except (teams.SeatLimitReached, teams.InviteError, teams.NotPermitted) as exc:
                self.send(page(view_team(db(), org, member, error=str(exc)), member, "team"))
                return
            path_only = f"/invite/{token}"
            try:
                MAILER.send(mail.invitation_message(
                    invited, mail.base_url() + path_only,
                    org["name"] or "their team",
                    user["name"] or user["email"],
                    teams.INVITE_TTL_SECONDS // 86400))
            except mail.MailError as exc:
                # The seat is already reserved. Free it again rather than
                # holding a seat for an invitation nobody received.
                teams.withdraw_unsent(db(), token)
                self.send(page(view_team(db(), org, member,
                                         error=f"Invitation not sent: {exc}"),
                               member, "team"))
                return
            shortcut = path_only if isinstance(MAILER, mail.ConsoleMailer) else ""
            self.send(page(view_team(db(), org, member, link=shortcut), member, "team"))

        elif path == "/team/revoke":
            try:
                teams.revoke(db(), org, member, int(data.get("id", 0)))
            except (teams.InviteError, teams.NotPermitted) as exc:
                self.send(page(view_team(db(), org, member, error=str(exc)), member, "team"))
                return
            self.redirect("/team")

        elif path == "/tokens":
            try:
                teams.require_owner(member)
            except teams.NotPermitted:
                self.redirect("/plan")
                return
            wanted = int(data.get("tokens", 0))
            pack = next((p for p in plans.TOKEN_PACKS if p.tokens == wanted), None)
            if pack is None:
                self.redirect("/plan")
                return
            self.start_payment(org, user, member, "tokens", str(pack.tokens), pack.cents)

        elif path == "/upgrade":
            try:
                teams.require_owner(member)
            except teams.NotPermitted:
                self.redirect("/plan")
                return
            key = data.get("plan", "")
            if key not in plans.PLANS:
                self.redirect("/plan")
                return
            try:
                teams.check_downgrade(db(), org, key)
            except teams.SeatLimitReached as exc:
                self.send(page(view_plan(db(), org, member).replace(
                    '<h1 class="app-h">', f'<div class="warn">{e(exc)}</div>'
                    '<h1 class="app-h">', 1), member, "plan"))
                return
            target = plans.PLANS[key]
            if target.cents == 0 or target.cents < plans.PLANS[org["plan"]].cents:
                # Moving down, or to the free trial, costs nothing to take.
                db().execute(
                    "UPDATE organisations SET plan = ?, used = 0, period_start = ?"
                    " WHERE id = ?", (key, now(), org["id"]),
                )
                log(db(), org["id"], "plan_change", detail=key, cents=target.cents,
                    user_id=user["id"])
                db().commit()
                self.redirect("/")
                return
            self.start_payment(org, user, member, "plan", key, target.cents)

        else:
            self.redirect("/")


def serve(port: int | None = None, db_path: str | None = None) -> None:
    """Start the server. PORT from the environment wins, as hosts expect."""
    global POOL
    port = port or int(os.environ.get("PORT", "8000"))
    POOL = Pool(db_path)
    POOL.conn  # fail fast rather than on the first request
    print(f"IDENTICAL running on http://localhost:{port}")
    ThreadingHTTPServer(("", port), Handler).serve_forever()
