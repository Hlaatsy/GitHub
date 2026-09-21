"""Drive the real app in a browser, end to end, and screenshot each step.

Not part of the unit suite -- it needs Playwright and a Chromium, and it takes
seconds rather than milliseconds. It exists because the unit tests test
modules, and a view can therefore reference an attribute that no longer exists
without a single test failing. That is exactly what happened when plans moved
to tokens: the signed-out landing page still read ``plan.avatars`` and nothing
noticed until a browser asked for the page.

    pip install playwright
    python tests/browser_preview.py     # screenshots land in /tmp/claude-0/shots

Run it before shipping a change that touches a view.
"""

import contextlib
import io
import os
import pathlib
import re
import sys
import tempfile
import threading
import time
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

PORT = 8441
B = f"http://localhost:{PORT}"

# Emails carry absolute links, so the app has to know where it answers. Set
# before importing the server, which is also how a deployment does it.
os.environ.setdefault("IDENTICAL_BASE_URL", B)

from app import server  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

out, log = sys.stderr, io.StringIO()
SHOTS = pathlib.Path(os.environ.get("SHOTS", "/tmp/identical-shots"))
SHOTS.mkdir(parents=True, exist_ok=True)


def run():
    with contextlib.redirect_stdout(log):
        server.serve(PORT, str(pathlib.Path(tempfile.mkdtemp())/"preview.db"))
threading.Thread(target=run, daemon=True).start()
time.sleep(1.0)

def link(email, kind="/signin/"):
    """Pull a link out of what the console mailer printed.

    The console mailer prints the whole message, so find the block addressed
    to this recipient and take the first matching URL inside it.
    """
    blocks = log.getvalue().split("--- mail to ")
    for block in reversed(blocks):
        if block.startswith(email):
            found = re.search(rf"(\S*{re.escape(kind)}\S+)", block)
            if found:
                # Absolute in the email; the test navigates with a path.
                return found.group(1).replace(B, "") or None
    return None

fails = []
def check(label, ok):
    if not ok: fails.append(label)
    print(f"  {'PASS' if ok else 'FAIL'}  {label}", file=out)

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
    # A phone, because that is what this product is for.
    ctx = browser.new_context(viewport={"width": 420, "height": 880}, device_scale_factor=2)
    page = ctx.new_page()
    shot = lambda name: page.screenshot(path=str(SHOTS/f"{name}.png"), full_page=True)

    print("\n--- 1. signed out ---", file=out)
    page.goto(B)
    check("shows tiers and a sign-in form, no data",
          page.get_by_role("heading", name=re.compile("compliance", re.I)).is_visible()
          and page.locator("text=Team 5").first.is_visible())
    shot("01-signed-out")

    print("\n--- 2. sign in by emailed link ---", file=out)
    page.fill('input[name=email]', "thandi@sandtonmutual.co.za")
    page.click('button:has-text("Email me a link")')
    check("link sent, nothing leaked", page.locator("text=Link sent").is_visible())
    check("expiry is stated on the page",
          page.locator("text=20 minutes").is_visible())
    shot("02-link-sent")
    page.goto(B + link("thandi@sandtonmutual.co.za"))

    print("\n--- 3. name the organisation ---", file=out)
    check("prompted to create an organisation",
          page.locator("text=Name your organisation").is_visible())
    shot("03-new-org")
    page.fill('input[name=name]', "Sandton Mutual")
    page.click('button:has-text("Create it")')

    print("\n--- 4. the portal ---", file=out)
    check("trial starts with 8 tokens", page.locator("text=8 tokens").is_visible())
    check("meter states both prices", page.locator("text=a video is 1, an avatar is 5").is_visible())
    shot("04-empty-portal")

    print("\n--- 5. build an avatar from an upload ---", file=out)
    page.fill('input[name=name]', "Thandi Mokoena")
    page.select_option('select[name=source]', "upload")
    page.click('button:has-text("Build it")')
    check("avatar cost 5 tokens", page.locator("text=3 tokens").is_visible())
    check("marked as a real person with consent",
          page.locator("text=real person · consent on file").is_visible())
    shot("05-avatar-built")

    print("\n--- 6. make a video ---", file=out)
    page.click('a:has-text("New video")')
    page.fill('input[name=title]', "Premium increase explainer")
    page.fill('textarea[name=script]',
              "Good morning. From the first of November our premiums change, and I want "
              "to explain exactly what that means for your policy before you see it on "
              "your statement.")
    shot("06-create-video")
    page.click('button:has-text("Generate video")')
    check("renders with a WhatsApp-safe file size",
          page.locator("text=fits WhatsApp").is_visible())
    shot("07-video-ready")

    print("\n--- 7. spend down to nothing ---", file=out)
    for n in range(2):
        page.goto(B + "/create")
        page.fill('input[name=title]', f"Policy note {n}")
        page.fill('textarea[name=script]', "A short update for our policyholders this week.")
        page.click('button:has-text("Generate video")')
    page.goto(B)
    check("tokens exhausted", page.locator("text=0 tokens").first.is_visible())
    check("avatar refused, and says the price",
          page.locator("text=An avatar is 5 tokens and you have 0").is_visible())
    shot("08-out-of-tokens")

    print("\n--- 8. the plan page ---", file=out)
    page.goto(B + "/plan")
    check("top-ups offered with per-token rates", page.locator("text=R79 each").first.is_visible()
          or page.locator("text=20 tokens").first.is_visible())
    check("advice compares topping up against upgrading",
          page.locator("text=Starter").first.is_visible())
    shot("09-plan")

    print("\n--- 9. top up ---", file=out)
    page.click('form:has-text("20 tokens") button:has-text("Buy")')
    page.goto(B)
    check("pool restored", page.locator("text=20 tokens").first.is_visible())
    shot("10-topped-up")

    print("\n--- 10. a generated presenter ---", file=out)
    page.fill('input[name=name]', "Studio presenter")
    page.select_option('select[name=source]', "generated")
    page.click('button:has-text("Build it")')
    check("marked synthetic, no consent subject",
          page.locator("text=generated · synthetic").is_visible())
    check("both kinds side by side",
          page.locator("text=real person · consent on file").is_visible())
    shot("11-two-avatars")

    print("\n--- 11. team and seats ---", file=out)
    page.goto(B + "/plan")
    page.click('button:has-text("Move to Starter")')
    page.goto(B + "/team")
    check("Starter is one seat, so no invites", page.locator("text=1 of 1 seats used").is_visible())
    shot("12-team-starter")

    browser.close()

print(f"\n{len(fails)} failure(s)" + (": " + "; ".join(fails) if fails else ""), file=out)
sys.exit(1 if fails else 0)
