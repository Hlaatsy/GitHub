# IDENTICAL

AI avatar video for Sub-Saharan Africa. Send one photo, get an avatar that
speaks your script, in your voice.

South Africa is the first market, not the only one. Nigeria, Kenya and Ghana
are next, and the pricing and product decisions are made to extend rather
than be redone — see `docs/monetisation.md` and `docs/product.md`.

    app/      the running web app
    docs/     product requirements, positioning, revenue model
    assets/   artwork, and the prompts that generated it

## Who it is for

People, not organisations. Solopreneurs, creators, small business owners, and
the marketer who is the entire marketing department.

The business market was tried and was not there. This is a volume business:
many small customers, low touch, and a price somebody decides in one sitting
rather than through a procurement process.

## The app

`app/` is a real web app, not a prototype — accounts, plans, tokens, consent
records, approvals, payments and the cap logic, with the video generation
vendor behind a stub so the whole thing runs end to end before a contract
exists. Python standard library only; no pip install.

    cd app && python -m app

```sh
cd app
python -m unittest discover -s tests   # 149 unit tests
python tests/browser_preview.py        # drives the real app in Chromium
python tests/payments_e2e.py
python tests/mail_e2e.py
```

Run all four before pushing anything that touches a view. The unit tests
test modules, so a template can reference an attribute that no longer exists
and every one of them still passes — which is exactly what happened when
plans moved to tokens.

See `app/README.md` for what is bought versus built. The short version:
everything except the talking-face model itself.

## Pricing

One pool pays for everything: **a video is 1 token, an avatar is 5.**

| Tier | Price | Tokens | Videos after your avatar |
| --- | --- | --- | --- |
| Free | R0 | 8 | 3 |
| Starter | R149/mo | 12 | 7 |
| Pro | R299/mo | 28 | 23 |
| Premium | R449/mo | 48 | 43 |

Top-ups: 5 for R99, 20 for R349, 50 for R799.

**A topped-up token must always cost more than a subscribed one**, or nobody
upgrades. It runs R15.98–R19.80 against a dearest tier rate of R12.42. This
has broken twice on a price change, both times silently, so it is asserted in
the test suite rather than trusted. Prices live only in `app/app/plans.py`.

## Two open questions

**What a video actually costs us.** `app/app/provider.py` reports `None` for
the per-video platform cost deliberately, because it is not known. At R12.42
a token there is far less room than the old business pricing allowed, and a
per-minute API rate near $3 would put every full-length video under water.
This is the most urgent thing here, not the least.

**Free-to-Starter is the weak rung.** Free includes 8 tokens and Starter 12,
so R149 buys 4 more — R37 each, dearer than any top-up. The tier rate is
fine; the marginal rate is not, and the app says so rather than claiming the
upgrade is better value. Either narrow Free or widen Starter, but decide it
deliberately: raising Free from 2 tokens to 8 was right for onboarding and is
what created this.

## Reading order

1. `docs/positioning.md` — why the copy says what it says.
2. `docs/monetisation.md` — tiers, tokens, payment rails, revenue model.
3. `docs/product.md` — what the product must do to work across African
   markets, and which parts depend on the underlying platform rather than us.

## The LinkedIn campaign

Not in this repository. IDENTICAL's queued launch posts stay in the
`Hlaatsy/GitHub` repository alongside the publisher that sends them, which is
shared with KhutsoGRC and StoreBurst. Splitting the publisher would have left
two copies to drift apart.

Nothing in this repository depends on it, and nothing there reaches into the
app.
