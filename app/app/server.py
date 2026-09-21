"""The IDENTICAL web app. Standard library only.

Mobile web first, not native iOS: no review queue, no install, no storage cost
to the user, one codebase. The audience this is built for lives on a phone
with a metered data bundle, and a web app reaches them today.
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

from . import billing, plans
from .db import Pool, log, now
from .provider import StubProvider, share_encode

#: Signs the session cookie. A real deployment sets this; a dev run gets a
#: random one, so restarting signs everybody out rather than shipping a
#: guessable default that would let anyone forge an account id.
SECRET = os.environ.get("IDENTICAL_SECRET", secrets.token_hex(32)).encode()

PROVIDER = StubProvider()
POOL: Pool | None = None


def db() -> sqlite3.Connection:
    """This thread's connection."""
    return POOL.conn


# --------------------------------------------------------------------------
# sessions

def sign(account_id: int) -> str:
    mac = hmac.new(SECRET, str(account_id).encode(), hashlib.sha256).hexdigest()[:32]
    return f"{account_id}.{mac}"


def unsign(token: str) -> int | None:
    try:
        raw, mac = token.split(".", 1)
    except ValueError:
        return None
    if hmac.compare_digest(mac, hmac.new(SECRET, raw.encode(), hashlib.sha256).hexdigest()[:32]):
        return int(raw)
    return None


# --------------------------------------------------------------------------
# rendering

STYLE = (Path(__file__).resolve().parent / "app.css").read_text(encoding="utf-8")


def page(body: str, account: sqlite3.Row | None = None, tab: str = "") -> bytes:
    nav = ""
    if account is not None:
        items = [("/", "⌂", "Home", "home"), ("/create", "＋", "Create", "create"),
                 ("/plan", "◷", "Plan", "plan")]
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


def e(text: object) -> str:
    return html.escape(str(text))


def meter(conn: sqlite3.Connection, account: sqlite3.Row) -> str:
    plan = plans.PLANS[account["plan"]]
    left = billing.allowance_left(account)
    credits = billing.live_credits(conn, account["id"])
    pct = (left / plan.videos * 100) if plan.videos else 0
    extra = f" · plus {credits} credit{'s' if credits != 1 else ''}" if credits else ""
    return (
        '<div class="meter"><div class="meter-top">'
        f'<span class="meter-n">{left} of {plan.videos}</span>'
        f'<span class="meter-plan">{e(plan.name)} · {plan.rand}</span></div>'
        f'<div class="track"><div class="fill{"" if left else " out"}" style="width:{pct:.0f}%"></div></div>'
        f"<small>videos left this month{extra}</small></div>"
    )


# --------------------------------------------------------------------------
# views

def view_landing() -> str:
    tiers = "".join(
        f'<div class="tier{" pick" if key == "starter" else ""}">'
        f'<div class="tier-name">{e(plans.PLANS[key].name)}</div>'
        f'<div class="price">{plans.PLANS[key].rand}<span>/mo</span></div>'
        f'<div class="quota"><b>{plans.PLANS[key].videos} videos</b>'
        f"<small>up to {plans.PLANS[key].max_minutes} min</small></div></div>"
        for key in plans.ORDER
    )
    return (
        '<header class="hero"><div class="eyebrow">South Africa</div>'
        "<h1>Your avatar, built free. From R149 a month.</h1>"
        "<p>Record once. Your avatar makes the videos from then on — in your voice, "
        "in your language, on your phone.</p></header>"
        f'<section class="tiers">{tiers}</section>'
        '<form method="post" action="/signup" class="card">'
        "<h2>Start free</h2><p class=sub>2 videos a month, no card.</p>"
        '<label class=fld>Your name<input name=name required autocomplete="name"></label>'
        '<label class=fld>Email<input name=email type=email required autocomplete="email"></label>'
        '<button class="act">Create my account</button></form>'
    )


def view_home(conn: sqlite3.Connection, account: sqlite3.Row) -> str:
    plan = plans.PLANS[account["plan"]]
    avatars = conn.execute(
        "SELECT * FROM avatars WHERE account_id = ? ORDER BY id", (account["id"],)
    ).fetchall()
    videos = conn.execute(
        "SELECT * FROM videos WHERE account_id = ? ORDER BY id DESC LIMIT 6", (account["id"],)
    ).fetchall()
    spare = billing.avatars_left(conn, account)

    cards = "".join(
        f'<div class="avatar"><div class="face"></div><div>'
        f'<div class="avatar-name">{e(a["name"])}</div>'
        f'<div class="sub">{e(a["source"])} · {e(a["voice_kind"])} voice'
        f'{" · guided build" if a["guided"] else ""}</div></div></div>'
        for a in avatars
    )

    if spare > 0:
        build = (
            '<form method="post" action="/avatar" class="avatar-new">'
            f'<h2>{"Build your avatar" if not avatars else "Add another avatar"}</h2>'
            f"<p class=sub>{'One photo is enough, and the guided build is included.' if plan.guided_build else 'A photo avatar is included. Upgrade for the guided build and a cloned voice.'}</p>"
            '<label class=fld>Whose avatar is this'
            '<input name=name value="" placeholder="Name of the presenter" required></label>'
            '<button class="act cool">Build it</button></form>'
        )
    else:
        # At the limit. Say what the limit is and what clears it, rather than
        # removing the button and leaving people to guess.
        build = (
            f'<div class="warn">{plan.name} includes {plan.avatars} '
            f'avatar{"s" if plan.avatars != 1 else ""}, and all of them are in use. '
            f'<a href="/plan">See plans</a> to add more.</div>'
        )

    avatar_count = (
        f'<div class="sub">{len(avatars)} of {plan.avatars} avatars'
        f'{" · " + str(spare) + " left" if spare else " · at your limit"}</div>'
    ) if avatars else ""

    left = billing.videos_left(conn, account)
    rows = "".join(
        f'<div class="vid"><div class="thumb">{"▶" if v["status"] == "ready" else "◷"}</div>'
        f'<div><div class="vid-t">{e(v["title"])}</div>'
        f'<div class="vid-m">{v["seconds"]}s · {round(v["bytes"]/1048576, 1)} MB · '
        f'{e(v["paid_with"] or v["status"])}</div></div></div>'
        for v in videos
    ) or '<p class="sub">Nothing yet. Make your first one.</p>'

    return (
        f'<h1 class="app-h">Hello, {e(account["name"] or "there")}</h1>'
        f"{avatar_count}{cards}{build}{meter(conn, account)}"
        + ('<a class="act" href="/create">New video</a>' if left and avatars
           else '<a class="act" href="/plan">Out of videos — see options</a>' if avatars
           else "")
        + f'<section><div class="sub" style="margin-bottom:4px">Recent</div>{rows}</section>'
    )


def view_create(conn: sqlite3.Connection, account: sqlite3.Row, error: str = "") -> str:
    plan = plans.PLANS[account["plan"]]
    avatars = conn.execute(
        "SELECT * FROM avatars WHERE account_id = ? ORDER BY id", (account["id"],)
    ).fetchall()
    picker = ""
    if len(avatars) > 1:
        picker = ("<label class=fld>Presented by<select name=avatar>" + "".join(
            f'<option value="{a["id"]}">{e(a["name"])}</option>' for a in avatars
        ) + "</select></label>")
    voices = ["Your cloned voice"] if plan.custom_voice else []
    voices += ["Thandi — SA English", "Sipho — isiZulu"]
    options = "".join(f"<option>{e(v)}</option>" for v in voices)
    warn = f'<div class="warn">{e(error)}</div>' if error else ""
    return (
        '<h1 class="app-h">New video</h1>' + warn +
        '<form method="post" action="/create" class="card">' + picker +
        '<label class=fld>Title<input name=title required placeholder="What is this one for?"></label>'
        "<label class=fld>Script"
        '<textarea name=script rows=8 required '
        'placeholder="Type or paste what your avatar should say…"></textarea></label>'
        f'<div class="est">Up to {plans.MAX_VIDEO_SECONDS // 60} minutes — about '
        f'{plans.MAX_VIDEO_SECONDS * 145 // 60} words</div>'
        f"<label class=fld>Voice<select name=voice>{options}</select></label>"
        '<button class="act cool">Generate video</button></form>'
    )


def view_ready(video: sqlite3.Row) -> str:
    megabytes = round(video["bytes"] / 1048576, 1)
    fits = video["bytes"] <= 16 * 1024 * 1024
    return (
        '<div class="done"><div class="player">▶</div>'
        f'<h1 class="app-h">{e(video["title"])}</h1>'
        f'<div class="filemeta">H.264 · 720p · {megabytes} MB'
        f"{' — fits WhatsApp' if fits else ' — too big for WhatsApp'}</div>"
        f'<div class="sub">Paid with your {e(video["paid_with"])}.</div>'
        '<div class="share"><button type=button>WhatsApp</button>'
        "<button type=button>TikTok</button><button type=button>Save</button></div>"
        '<a class="act ghost" href="/">Done</a></div>'
    )


def view_plan(conn: sqlite3.Connection, account: sqlite3.Row) -> str:
    advice = plans.advise_at_cap(account["plan"])
    plan = plans.PLANS[account["plan"]]
    left = billing.videos_left(conn, account)

    packs = "".join(
        f'<form method="post" action="/credits" class="m-row">'
        f'<input type=hidden name=credits value="{pack.credits}">'
        f"<span>{pack.credits} credit{'s' if pack.credits > 1 else ''}</span>"
        f"<b>R{pack.cents // 100}</b>"
        f'<button class="mini">Buy</button></form>'
        for pack in advice.packs
    )
    upgrade = ""
    if advice.upgrade is not None:
        upgrade = (
            f'<form method="post" action="/upgrade">'
            f'<input type=hidden name=plan value="{advice.upgrade.key}">'
            f'<button class="act cool">Move to {e(advice.upgrade.name)} — '
            f"{advice.upgrade.rand}/mo</button></form>"
        )
    headline = "You have used everything" if not left else "Your plan"
    return (
        f'<h1 class="app-h">{headline}</h1>{meter(conn, account)}'
        f'<div class="cap"><h2>Buying more</h2><div class="maths">{packs}</div>'
        f'<p class="verdict">{e(advice.verdict)}</p></div>{upgrade}'
        f'<p class="sub">Credits do not expire at month end. They last '
        f"{plans.CREDIT_EXPIRY_DAYS // 365} year from purchase. "
        f"Every video up to {plans.MAX_VIDEO_SECONDS // 60} minutes on {e(plan.name)}.</p>"
        '<a class="act ghost" href="/">Back</a>'
    )


# --------------------------------------------------------------------------
# request handling

class Handler(BaseHTTPRequestHandler):
    server_version = "identical"

    def account(self) -> sqlite3.Row | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        cookie = http.cookies.SimpleCookie(raw)
        if "sid" not in cookie:
            return None
        account_id = unsign(cookie["sid"].value)
        if account_id is None:
            return None
        row = db().execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
        return billing.roll_period(db(), row) if row else None

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

    def form(self) -> dict[str, str]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8")
        return {k: v[0] for k, v in urllib.parse.parse_qs(raw).items()}

    def log_message(self, *args: object) -> None:
        """Quiet by default; the ledger is the record that matters."""

    # -- GET ---------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        account = self.account()

        if path == "/healthz":
            self.send(b"ok")
            return
        if account is None:
            self.send(page(view_landing()))
            return
        if path == "/":
            self.send(page(view_home(db(), account), account, "home"))
        elif path == "/create":
            if billing.videos_left(db(), account) <= 0:
                self.redirect("/plan")
                return
            self.send(page(view_create(db(), account), account, "create"))
        elif path == "/plan":
            self.send(page(view_plan(db(), account), account, "plan"))
        elif path.startswith("/video/"):
            video = db().execute(
                "SELECT * FROM videos WHERE id = ? AND account_id = ?",
                (path.rsplit("/", 1)[-1], account["id"]),
            ).fetchone()
            if video is None:
                self.send(page("<h1 class=app-h>Not found</h1>", account), 404)
                return
            self.send(page(view_ready(video), account, "home"))
        else:
            self.send(page("<h1 class=app-h>Not found</h1>", account), 404)

    # -- POST --------------------------------------------------------------

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        data = self.form()
        account = self.account()

        if path == "/signup":
            email = data.get("email", "").strip().lower()
            if not email:
                self.redirect("/")
                return
            row = db().execute("SELECT * FROM accounts WHERE email = ?", (email,)).fetchone()
            if row is None:
                cursor = db().execute(
                    "INSERT INTO accounts (email, name, plan, period_start, created_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (email, data.get("name", "").strip(), plans.DEFAULT_PLAN, now(), now()),
                )
                db().commit()
                account_id = cursor.lastrowid
                log(db(), account_id, "signup", detail=email)
                db().commit()
            else:
                account_id = row["id"]
            self.redirect("/", f"sid={sign(account_id)}; Path=/; HttpOnly; SameSite=Lax")
            return

        if account is None:
            self.redirect("/")
            return

        if path == "/avatar":
            plan = plans.PLANS[account["plan"]]
            try:
                billing.claim_avatar(db(), account)
            except billing.AvatarLimitReached:
                # The form is hidden at the limit, but a hidden form is not a
                # limit -- the endpoint has to refuse too.
                self.redirect("/plan")
                return
            ref = PROVIDER.build_avatar("photo", b"")
            cursor = db().execute(
                "INSERT INTO avatars (account_id, name, source, guided, voice_kind,"
                " provider_ref, created_at) VALUES (?, ?, 'photo', ?, ?, ?, ?)",
                (account["id"], data.get("name", "My avatar").strip() or "My avatar",
                 int(plan.guided_build), "cloned" if plan.custom_voice else "stock",
                 ref, now()),
            )
            # A consent record is written with the avatar, never afterwards.
            db().execute(
                "INSERT INTO consents (avatar_id, subject_name, scope, retention_until, agreed_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (cursor.lastrowid, account["name"] or account["email"],
                 "Videos this account creates, until consent is withdrawn",
                 now(), now()),
            )
            log(db(), account["id"], "avatar_built", detail=ref)
            db().commit()
            self.redirect("/")

        elif path == "/create":
            script = data.get("script", "").strip()
            try:
                seconds = billing.check_length(script)
            except billing.TooLong as exc:
                self.send(page(view_create(db(), account, str(exc)), account, "create"))
                return
            # Which avatar presents this video. Defaults to the first, so a
            # single-avatar account never has to choose.
            chosen = data.get("avatar", "")
            avatar = db().execute(
                "SELECT * FROM avatars WHERE account_id = ? AND (? = '' OR id = ?)"
                " ORDER BY id LIMIT 1",
                (account["id"], chosen, chosen),
            ).fetchone()
            if avatar is None:
                self.redirect("/")
                return
            try:
                paid_with = billing.spend_one(db(), account)
            except billing.OutOfQuota:
                self.redirect("/plan")
                return

            render = share_encode(
                PROVIDER.render(avatar["provider_ref"], script, seconds, data.get("voice", ""))
            )
            cursor = db().execute(
                "INSERT INTO videos (account_id, avatar_id, title, script, seconds, status,"
                " paid_with, bytes, provider_ref, created_at)"
                " VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)",
                (account["id"], avatar["id"], data.get("title", "Untitled").strip() or "Untitled",
                 script, seconds, paid_with, render.bytes, render.ref, now()),
            )
            db().commit()
            self.redirect(f"/video/{cursor.lastrowid}")

        elif path == "/credits":
            wanted = int(data.get("credits", 0))
            pack = next((p for p in plans.CREDIT_PACKS if p.credits == wanted), None)
            if pack is not None:
                # A real deployment takes payment here -- Paystack or
                # Flutterwave, so EFT and mobile money work, not cards alone.
                billing.add_credits(db(), account["id"], pack)
            self.redirect("/plan")

        elif path == "/upgrade":
            key = data.get("plan", "")
            if key in plans.PLANS:
                db().execute(
                    "UPDATE accounts SET plan = ?, used = 0, period_start = ? WHERE id = ?",
                    (key, now(), account["id"]),
                )
                log(db(), account["id"], "plan_change", detail=key, cents=plans.PLANS[key].cents)
                db().commit()
            self.redirect("/")

        else:
            self.redirect("/")


def serve(port: int = 8000, db_path: str | None = None) -> None:
    global POOL
    POOL = Pool(db_path)
    POOL.conn  # fail fast here rather than on the first request
    print(f"IDENTICAL running on http://localhost:{port}")
    ThreadingHTTPServer(("", port), Handler).serve_forever()
