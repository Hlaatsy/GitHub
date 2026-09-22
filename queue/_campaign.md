# IDENTICAL launch campaign

A draft note, not a post: `linkedin/queue.py` skips files starting with `_`.

IDENTICAL is its own project (`projects/identical/`) with its own queue,
archive, assets and docs. `project.conf` sets `profile: identical`, so every
post here publishes through IDENTICAL's own app without naming it per file.

Six live posts for the **IDENTICAL** page, plus four offer drafts held back
until the pricing is confirmed.

IDENTICAL publishes through its own LinkedIn app and its own page. KhutsoGRC
and StoreBurst are separate projects with separate apps and separate tokens;
their pages are untouched by this campaign.

The strategy behind the copy is in `../docs/positioning.md`, the revenue
model in `../docs/monetisation.md`, and what the product must do to work in
these markets in `../docs/product.md`.

## Scheduled

All at 07:00 UTC (09:00 SAST), on weekdays, inside the workflow's
05:00-15:00 UTC cron window and the run window that ends 2026-11-18.

| Date | File | Pillar |
| --- | --- | --- |
| Mon 21 Sep | `identical-01-launch.md` | Launch — all five differentiators |
| Wed 23 Sep | `identical-02-how-it-works.md` | Done-for-you, not do-it-yourself |
| Fri 25 Sep | `identical-03-ios-2.md` | Mobile-first, no production day |
| Tue 29 Sep | `identical-04-avatar-4.md` | Avatar quality, leads to Avatar Setup |
| Thu 01 Oct | `identical-05-translation.md` | SA languages, repurposing |
| Tue 06 Oct | `identical-06-compliance.md` | Consent and POPIA — the wedge |

Every live post ends with the same free offer: send a photo, get a 60-second
avatar video back. That is the conversion step, and it costs minutes rather
than a price you have not set yet.

## Held as drafts

Underscore-prefixed, so they cannot publish by accident. Each carries a
proposed price from `docs/monetisation.md`. Set your real numbers, drop the
underscore, and they schedule into the slots below.

| Suggested date | File | Offer |
| --- | --- | --- |
| Thu 08 Oct | `_draft-offer-pricing.md` | R149/mo, avatar built free |
| Tue 13 Oct | `_draft-offer-content-engine.md` | Done-for-you from R1 499/mo |
| Tue 20 Oct | `_draft-offer-white-label.md` | Agency partner programme |
| Tue 27 Oct | `_draft-offer-workshop.md` | R450 seat / R9 500 in-house |

Sequence matters. The offers land after six posts of demonstrating the thing,
not before. And the white-label post should not go out until the retainer has
run for a real client — a partner reselling an unproven process damages two
reputations at once.

## Blocker: the IDENTICAL app

Every post carries `profile: identical`, which reads `LINKEDIN_IDENTICAL_*`
credentials and never falls back to another brand's token. Until those
exist, these posts fail with a named variable and the rest of the queue
publishes normally.

Setup is in `/linkedin/README.md` under "Three separate apps". Check state
with:

    python -m linkedin profiles      # all three brands, and what is missing

Watch for `page  not set` against `identical`. It means the token exists but
`LINKEDIN_IDENTICAL_AUTHOR_URN` is empty, and posts would publish to the
authorising person's own profile rather than the IDENTICAL page. It is the
one misroute the tooling cannot fail on, because posting as yourself is a
legitimate configuration.

**Community Management API approval is the risk to the 21 September date.**
It is a LinkedIn review, granted per app, and a new app starts it from zero.
Nothing you do speeds it up. Create the app and request approval today --
steps 1, 2 and 4 in the README cost nothing and can be done immediately. If
approval has not landed by the 19th, move the dates rather than publishing
IDENTICAL from another brand's app.

## The harder problem: a new page has no audience

This matters more than the approval, and no amount of good copy fixes it.

A brand-new IDENTICAL page starts with zero followers. Six well-written
posts to zero followers reach zero people. LinkedIn shows company-page posts
to followers first, and organic reach for a page with no following and no
engagement history is close to nothing -- so the campaign as scheduled will
look like a failure that is actually a distribution problem.

Do these before the 21st, or the launch is shouting into an empty room:

- **Invite connections to follow the page.** LinkedIn gives page admins a
  monthly allocation of follow invites. This is the single highest-value
  thing available, it is free, and the allocation is capped -- so start
  early rather than spending it all in one week.
- **Post from personal profiles, not just the page.** A person's profile
  almost always out-reaches a young company page. The page post is the
  canonical version; the personal post is what people actually see. Whoever
  is behind IDENTICAL should share each post the morning it goes out, in
  their own words, linking to the page.
- **Have StoreBurst and KhutsoGRC reshare.** They are separate brands with
  their own audiences, and a reshare is legitimate cross-promotion rather
  than the same text posted twice. This is what the other two pages are
  worth to this launch.
- **Seed the first posts with real engagement.** Comments in the first hour
  determine how far a post travels. Ask colleagues and friendly clients
  directly, before the post goes out, not after.
- **Consider running the first two posts as paid.** A small budget against
  a defined audience is the only reliable way to put a new page in front of
  strangers. The launch and the pricing post are the two worth spending on.

If none of this is possible before Monday, the honest move is to delay the
campaign by two or three weeks and spend that time building the follower
base. The posts do not expire. A launch that nobody sees cannot be run
again.

## Open: is this launch South African or pan-African?

The six scheduled posts are written for a South African audience — rands,
POPIA, "twelve official languages", #SouthAfrica. That is right for a first
market and wrong as a permanent frame, now that Nigeria, Kenya and Ghana are
in scope.

Nothing needs rewriting yet. A launch aimed at one market you can actually
serve beats a regional launch you cannot, and the SA framing is an asset
while the page has no followers anywhere. But decide which of these it is:

- **SA-first, region later.** Keep this campaign as written. Plan a second
  campaign per market, in that market's currency and idiom, once the payment
  rails and language testing for it exist. Regional claims stay out of the
  copy until then.
- **Pan-African from day one.** Posts 1 and 5 need rewriting — the rand
  pricing becomes "priced in your own currency", the POPIA post widens to
  data protection across the region (Nigeria's NDPA, Kenya's DPA), and the
  language post leads on code-mixing rather than SA's twelve languages. Only
  do this if you can actually take a Kenyan customer's M-Pesa payment on the
  day the post runs.

Recommended: SA-first. The product work in `../docs/product.md` — WhatsApp,
payment rails, code-mixing tests — is what makes the other markets real, and
none of it is done. Posting to a market you cannot serve converts nobody and
spends credibility you have not built yet.

## Claims corrected after market research

Three things in this campaign and the docs behind it were wrong, and were
checkable in under a minute by anyone who cared to:

- **"Platforms start at forty or fifty dollars — roughly R900."** HeyGen
  Creator and Synthesia entry are both about **$29**, near R520, against our
  R499. There is no meaningful price advantage at entry, and the pricing post
  now argues on what the money buys rather than on being cheaper.
- **"A R40 000-R80 000 studio day."** A short corporate video in South Africa
  is **R5 000-R25 000**, with day rates of R5 500-R25 000. Still a strong
  comparison, but the number as written would have lost us the room with any
  marketing manager who has actually commissioned video.
- **African language quality as a moat.** EqualyzAI already ships voice AI
  built around code-switching in African languages, and the Masakhane hub is
  funding twenty-six more projects with Microsoft and Google behind them. The
  honest claim is that we listen before it ships, not that we are the only
  ones who can.

None of the six scheduled posts carried the first claim -- it was in the
pricing draft, which has not run. Worth noting how close it came.

## Claims to make true before publishing

The copy asserts things about how you operate. Each is defensible, but only
if it is actually the case on the day the post goes out:

- **"From R149/mo, no setup fee, avatar built free."** Posts 1, 2 and 4 now
  state this, so it is live from Monday — before the pricing post runs. The
  price list must exist by then, and the free avatar build must be something
  you can actually deliver at volume without an hour of labour per customer.
  Check the entry-tier arithmetic in `docs/monetisation.md` first.
- **Payment methods.** An affordable price payable only by international
  card is not affordable. Confirm EFT, debit order or a local gateway before
  the pricing post, and list the methods wherever the price appears.
- **"We build the avatar with you / we produce the videos."** Posts 1, 2 and 4
  sell a service. If that service is not ready to take a client in the week
  of 21 September, move those posts back rather than softening them.
- **"Checked by people who speak the language."** Post 5. Only true if you
  have someone to check isiZulu, isiXhosa, Sesotho and Afrikaans output
  before it ships. If not, cut that line — it is the one claim in the set
  that a single bad video disproves publicly. `../docs/product.md` section 1
  has the test set this depends on, and it is not built yet.
- **The training pitch needs SCORM first.** Pillar 4 in `../docs/positioning.md`
  is the strongest use case we have, and a training buyer will ask for LMS
  delivery in the first meeting. Until `../docs/product.md` section 6 is
  built, pitch training as a conversation rather than a product.
- **Nothing from the roadmap.** The WhatsApp pipeline, regional avatar
  presets, bandwidth-optimised exports and subtitles are all planned and none
  are live. They are the most tempting things in the whole product to post
  about and the easiest to be caught on. Keep them out until they work on a
  real device.
- **"We help you put consent forms and retention terms in place."** Post 6.
  Have the templates before the post runs, because this one will generate
  direct enquiries. The post no longer claims IDENTICAL *is* a governance
  business -- that leaned on KhutsoGRC's identity, and IDENTICAL is its own
  brand. If the three are openly connected, say so on the IDENTICAL page's
  About section and this becomes the strongest post in the set, because the
  claim becomes checkable. See `../docs/positioning.md`.
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
