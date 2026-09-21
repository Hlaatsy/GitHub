"""Drive checkout, callback and webhook over HTTP, including the abuse cases.

Not part of the unit suite: it runs a server and speaks HTTP. It exists
because the money paths have failure modes that only appear in the wiring --
a body that can only be read once, a redirect that settles a payment before
anyone has paid, a webhook replayed by the gateway as a matter of course.

    python tests/payments_e2e.py

Exits non-zero on any failure.
"""

import sys, threading, time, io, contextlib, tempfile, pathlib, re, os, json, hmac, hashlib
import urllib.request, urllib.parse, urllib.error, http.cookiejar, sqlite3
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
out, fails = sys.stderr, []
def check(label, ok):
    if not ok: fails.append(label)
    print(f"  {'PASS' if ok else 'FAIL'}  {label}", file=out)

PORT = 8463
B = f"http://localhost:{PORT}"
os.environ["IDENTICAL_BASE_URL"] = B
os.environ["PAYSTACK_SECRET_KEY"] = "sk_test_pretend"

from app import payments, server as appserver

# Paystack's own gateway, but with the two network calls faked so we exercise
# our code end to end without reaching out. Signature checking is the real one.
class FakePaystack(payments.PaystackGateway):
    def __init__(self, key): super().__init__(secret_key=key); self.orders = {}
    def initialise(self, reference, email, cents, callback_url, metadata):
        self.orders[reference] = cents
        self.callback = callback_url
        # Paystack sends the customer to its own hosted page, not back to us.
        # Returning the callback here would settle the payment the instant the
        # browser followed the redirect, which is not what happens.
        return payments.Checkout(reference, f"https://checkout.paystack.test/{reference}")
    def verify(self, reference):
        return payments.Verification(reference, True, self.orders.get(reference, 0),
                                     "ZAR", f"pstk_{reference}")

GATEWAY = FakePaystack("sk_test_pretend")
appserver.GATEWAY = GATEWAY
dbfile = pathlib.Path(tempfile.mkdtemp())/"pay.db"
log = io.StringIO()
def run():
    with contextlib.redirect_stdout(log):
        appserver.serve(PORT, str(dbfile))
threading.Thread(target=run, daemon=True).start(); time.sleep(0.8)

JAR = http.cookiejar.CookieJar()
o = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(JAR))
g = lambda p: o.open(B+p).read().decode()
pp = lambda p, **d: o.open(B+p, urllib.parse.urlencode(d).encode()).read().decode()

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
_nr = urllib.request.build_opener(NoRedirect, urllib.request.HTTPCookieProcessor(JAR))
def pp_noredirect(p, **d):
    """Stop at the redirect, the way a browser would pause at the gateway."""
    try:
        return _nr.open(B+p, urllib.parse.urlencode(d).encode()).read().decode()
    except urllib.error.HTTPError as exc:
        return exc.headers.get("Location", "")
def signin(email):
    pp("/signin", email=email)
    block = [b for b in log.getvalue().split("--- mail to ") if b.startswith(email)][-1]
    o.open(re.search(r"(http\S*/signin/\S+)", block).group(1))
def tokens():
    c = sqlite3.connect(str(dbfile))
    n = c.execute("SELECT COALESCE(SUM(remaining),0) FROM token_batches").fetchone()[0]
    c.close(); return n
def post_hook(payload, signature):
    req = urllib.request.Request(B+"/payments/webhook", data=payload, method="POST",
                                 headers={"x-paystack-signature": signature})
    try:
        return urllib.request.urlopen(req).status
    except urllib.error.HTTPError as exc:
        return exc.code

signin("owner@co.za"); pp("/org", name="Sandton Mutual")
pack = payments.__dict__ and __import__("app.plans", fromlist=["x"]).TOKEN_PACKS[0]

print("\n--- buying tokens goes through the gateway ---", file=out)
pp_noredirect("/tokens", tokens=str(pack.tokens))
ref = list(GATEWAY.orders)[-1]
check("a payment was recorded before any credit", ref in GATEWAY.orders)
check("nothing credited yet", tokens() == 0)
check("gateway asked for the right amount", GATEWAY.orders[ref] == pack.cents)

print("\n--- the customer comes back ---", file=out)
g(f"/payments/callback?reference={ref}")
check("tokens credited once paid", tokens() == pack.tokens)

print("\n--- the webhook arrives for the same payment ---", file=out)
body = json.dumps({"event": "charge.success", "data": {"reference": ref}}).encode()
sig = hmac.new(b"sk_test_pretend", body, hashlib.sha512).hexdigest()
check("signed webhook accepted", post_hook(body, sig) == 200)
check("no double credit", tokens() == pack.tokens)
check("replayed webhook still no double credit",
      post_hook(body, sig) == 200 and tokens() == pack.tokens)

print("\n--- an attacker tries the webhook ---", file=out)
check("unsigned request rejected", post_hook(body, "") == 401)
check("wrongly signed request rejected", post_hook(body, "0"*128) == 401)
forged = json.dumps({"event": "charge.success",
                     "data": {"reference": payments.new_reference()}}).encode()
before = tokens()
check("signed but unknown reference credits nothing",
      post_hook(forged, hmac.new(b"sk_test_pretend", forged, hashlib.sha512).hexdigest()) == 200
      and tokens() == before)

print("\n--- a tampered amount ---", file=out)
pp_noredirect("/tokens", tokens=str(pack.tokens))
ref2 = list(GATEWAY.orders)[-1]
GATEWAY.orders[ref2] = 100          # gateway reports one rand
before = tokens()
page = g(f"/payments/callback?reference={ref2}")
check("mismatch refused", "does not match" in page)
check("nothing credited on a mismatch", tokens() == before)

print("\n--- upgrading a plan is a payment too ---", file=out)
pp_noredirect("/upgrade", plan="pro")
ref3 = list(GATEWAY.orders)[-1]
c = sqlite3.connect(str(dbfile))
plan_now = c.execute("SELECT plan FROM organisations").fetchone()[0]; c.close()
check("plan unchanged until paid", plan_now != "pro")
g(f"/payments/callback?reference={ref3}")
c = sqlite3.connect(str(dbfile))
plan_now = c.execute("SELECT plan FROM organisations").fetchone()[0]; c.close()
check("plan applied after payment", plan_now == "pro")

print("\n--- moving down is free ---", file=out)
orders_before = len(GATEWAY.orders)
pp_noredirect("/upgrade", plan="starter")
c = sqlite3.connect(str(dbfile))
plan_now = c.execute("SELECT plan FROM organisations").fetchone()[0]; c.close()
check("downgrade applied without a charge",
      plan_now == "starter" and len(GATEWAY.orders) == orders_before)

print(f"\n{len(fails)} failure(s)" + (": " + "; ".join(fails) if fails else ""), file=out)
sys.exit(1 if fails else 0)
