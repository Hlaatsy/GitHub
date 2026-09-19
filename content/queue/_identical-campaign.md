# IDENTICAL launch campaign

A draft note, not a post: `linkedin/queue.py` skips files starting with `_`.

Six live posts for the **StoreBurst** page, plus four offer drafts held back
until the pricing is confirmed. IDENTICAL launches under StoreBurst, not
KhutsoGRC, so every post in this campaign carries `profile: storeburst` and publishes
through StoreBurst's own LinkedIn app. KhutsoGRC's app, token and page stay
untouched and keep serving that page's own content. The strategy behind the copy is in
`docs/positioning.md`; the revenue model is in `docs/monetisation.md`.

## Scheduled

All at 07:00 UTC (09:00 SAST), on weekdays, inside the workflow's
05:00-15:00 UTC cron window and the run window that ends 2026-11-18.

| Date | File | Pillar |
| --- | --- | --- |
| Mon 21 Sep | `identical-01-launch.md` | Launch — all five differentiators |
| Wed 23 Sep | `identical-02-how-it-works.md` | Done-for-you, not do-it-yourself |
| Fri 25 Sep | `identical-03-ios-2.md` | Mobile-first, no production day |
| Tue 29 Sep | `identical-04-avatar-4.md` | Twin quality, leads to Twin Setup |
| Thu 01 Oct | `identical-05-translation.md` | SA languages, repurposing |
| Tue 06 Oct | `identical-06-compliance.md` | Consent and POPIA — the wedge |

Every live post ends with the same free offer: send a photo, get a 60-second
twin video back. That is the conversion step, and it costs minutes rather
than a price you have not set yet.

## Held as drafts

Underscore-prefixed, so they cannot publish by accident. Each carries a
proposed price from `docs/monetisation.md`. Set your real numbers, drop the
underscore, and they schedule into the slots below.

| Suggested date | File | Offer |
| --- | --- | --- |
| Thu 08 Oct | `_draft-offer-pricing.md` | R149/mo, twin built free |
| Tue 13 Oct | `_draft-offer-content-engine.md` | Done-for-you from R1 499/mo |
| Tue 20 Oct | `_draft-offer-white-label.md` | Agency partner programme |
| Tue 27 Oct | `_draft-offer-workshop.md` | R450 seat / R9 500 in-house |

Sequence matters. The offers land after six posts of demonstrating the thing,
not before. And the white-label post should not go out until the retainer has
run for a real client — a partner reselling an unproven process damages two
reputations at once.

## Blocker: the StoreBurst app

IDENTICAL publishes through its own LinkedIn app, separate from KhutsoGRC's.
Every post in this campaign carries `profile: storeburst`, which reads
`LINKEDIN_STOREBURST_*` credentials and never falls back to the default
app's token. Until those exist, these posts fail with a named variable and
the rest of the queue publishes normally.

Setup is in `linkedin/README.md` under "StoreBurst: a second app". The short
version:

    python -m linkedin.auth --profile storeburst
    python -m linkedin --profile storeburst pages    # StoreBurst must appear
    python -m linkedin queue                         # shows each post's target

Watch for `-> the token holder (no page set)` in that last command. It means
the token exists but `LINKEDIN_STOREBURST_AUTHOR_URN` is empty, and the post
would publish to the authorising person's own profile instead of the
StoreBurst page. It is the one misroute the tooling cannot fail on, because
posting as yourself is a legitimate configuration -- so read the target line
before the 21st rather than trusting it.

**The Community Management API approval is the risk to the 21 September
date.** It is a LinkedIn review, not a setting, it is granted per app, and a
new app starts that review from zero. Nothing you do speeds it up.

So decide now, not on the 20th:

- **Start the app creation and approval request today.** Steps 1, 2 and 4 in
  the README can be done immediately and cost nothing.
- **If approval has not landed by the 19th, move the dates.** Publishing
  IDENTICAL from KhutsoGRC's app to hit a date defeats the separation --
  it puts IDENTICAL's launch on the GRC page's app and its approval at risk
  for a marketing deadline. Moving six dates costs nothing by comparison.
- A member-scope token (see the README) lets you rehearse the whole queue on
  your own profile meanwhile, so nothing is idle while the review runs.

## Claims to make true before publishing

The copy asserts things about how you operate. Each is defensible, but only
if it is actually the case on the day the post goes out:

- **"From R149/mo, no setup fee, twin built free."** Posts 1, 2 and 4 now
  state this, so it is live from Monday — before the pricing post runs. The
  price list must exist by then, and the free twin build must be something
  you can actually deliver at volume without an hour of labour per customer.
  Check the entry-tier arithmetic in `docs/monetisation.md` first.
- **Payment methods.** An affordable price payable only by international
  card is not affordable. Confirm EFT, debit order or a local gateway before
  the pricing post, and list the methods wherever the price appears.
- **"We build the twin with you / we produce the videos."** Posts 1, 2 and 4
  sell a service. If that service is not ready to take a client in the week
  of 21 September, move those posts back rather than softening them.
- **"Checked by people who speak the language."** Post 5. Only true if you
  have someone to check isiZulu, isiXhosa, Sesotho and Afrikaans output
  before it ships. If not, cut that line — it is the one claim in the set
  that a single bad video disproves publicly.
- **"We help you put consent forms and retention terms in place."** Post 6.
  Have the templates before the post runs, because this one will generate
  direct enquiries. The post no longer claims IDENTICAL *is* a governance
  business -- that leaned on KhutsoGRC's identity, which is not the brand
  launching. If StoreBurst and KhutsoGRC are connected, say so publicly and
  this becomes the strongest post in the set. See `docs/positioning.md`.
- **The free 60-second demo.** Every live post offers it. Decide who fulfils
  it and how fast, before Monday. An unanswered demo request is worse than
  never offering one.

## Legal and admin

- **Your own terms and privacy policy**, on your own domain, covering
  likeness, biometric data and retention. Do not point buyers at a third
  party's legal pages for a product you are selling — it undercuts the
  positioning in `docs/positioning.md` and leaves you without a document you
  control.
- **Check your reseller or platform agreement** before the white-label post.
  Reselling, white-labelling and partner distribution are three separate
  permissions.
- **VAT**: decide inclusive or exclusive and state it wherever a price
  appears.
- **No named competitor comparisons** in the published copy. The reasoning is
  in `docs/positioning.md` under "If you do want to name them".

## Dry run

    python -m linkedin queue              # confirms order and dates
    python -m linkedin publish --dry-run  # confirms nothing is due yet
