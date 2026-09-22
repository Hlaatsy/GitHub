# IDENTICAL — revenue model

Internal. Every rand figure is a **proposal to confirm** against the real
per-video platform cost, which is still unknown. See "Before any of this is
public" at the bottom.

## Who this is sold to

People, not organisations. Solopreneurs, creators, small business owners, and
the marketer who is the entire marketing department.

The business market was tried and was not there. This is a volume business:
many small customers, low touch, and a price somebody decides in one sitting
rather than through a procurement process.

That changes what matters. There is no pilot, no proposal and no six-week
sales cycle — there is a signup page, and either it converts or it does not.

## Subscription tiers

One currency. A plan buys tokens each month, and everything made spends them:
**a video is 1 token, an avatar is 5.**

| Tier | Price | Tokens | Videos after your avatar | Per token |
| --- | --- | --- | --- | --- |
| **Free** | R0 | 8 | 3 | — |
| **Starter** | **R149/mo** | 12 | 7 | R12.42 |
| **Pro** | **R299/mo** | 28 | 23 | R10.68 |
| **Premium** | **R449/mo** | 48 | 43 | R9.35 |

Every video up to 2 minutes. Cost per token falls at each step and each
upgrade is R150 — a ladder somebody climbs without a budget meeting.

### R149 is the number, on its own

R149 a month, in rands, with the avatar built free. That is the whole pitch
and it needs no second half.

Earlier versions of this document argued the price by comparison against
other platforms. That is out: a price defended by comparison is a price
somebody re-checks the moment the other one moves, and it points a customer
at a name they had not thought about.

### What the free tier is for

Eight tokens: an avatar and three videos, watermarked, standard voices. It
exists so somebody can watch their own face talking before deciding anything,
which is the only thing that really sells this.

The avatar build is given away there, which is a real cost carried before any
revenue. It works only if the build is automated rather than a person's
afternoon — see `product.md`.

## Topping up

When the monthly tokens run out.

| Pack | Price | Per token |
| --- | --- | --- |
| 5 tokens | R99 | R19.80 |
| 20 tokens | R349 | R17.45 |
| 50 tokens | R799 | R15.98 |

**The rule still holds:** top-ups run R15.98–R19.80 a token against a dearest
tier rate of R12.42, so buying past the allowance is always dearer than moving
up a tier. Reversed, nobody upgrades. This has broken twice on a price change,
both times silently, and is asserted in the test suite rather than trusted.

Topped-up tokens do not expire monthly — twelve months from purchase, stated
at purchase. Subscribed tokens do not roll over.

## What is no longer in the model

The done-for-you ladder, the white-label partner programme, corporate
workshops and the compliance products were all built for an organisational
buyer. They are removed rather than left in as aspiration: a consumer model
that quietly carries a R7 500 retainer in its revenue plan is not a consumer
model, and the forecast would be fiction.

They are recoverable from git if the business market is ever revisited.
Nothing was wrong with them except the buyer.

One exception to hold in mind rather than in the plan: a customer who asks
you to make the videos for them is telling you something. Count how often it
happens. If it happens constantly, the business is asking to become a service
again — and that should be a decision, not a drift.

## The funnel

Short, self-serve, measured in conversion rather than conversations.

1. **Attention** — LinkedIn, TikTok, Facebook, WhatsApp. Every post can be
   made with the product, so the advertisement is also the proof.
2. **The free tier.** Eight tokens, no card. They watch their own face talk,
   which is the moment that sells this.
3. **R149.** Small enough to decide alone, in one sitting.
4. **The cap.** Everyone on Starter meets it. Top up for a spike, upgrade for
   a habit — and the arithmetic in the app says which.
5. **Month five.** Where the free avatar build has repaid what it cost.

### What to measure

- **Free to paid conversion.** The single number this model lives on.
- **Did they make a second video?** A first video is curiosity; a second is a
  habit, and habit is what renews.
- **Month-2 and month-5 retention**, from `python -m app health`.
- **How often somebody asks you to make the videos for them** — the signal
  described above.

## Before any of this is public

- **Cost a video properly.** Everything rests on the per-video platform cost,
  still unknown — `app/provider.py` reports None for it deliberately. At
  R12.42 a token there is far less room than the business pricing allowed, and
  a per-minute API rate near $3 would put every full-length video under water.
  This is now the most urgent open question here, not the least.
- **Check the top-up ordering** every time any price moves.
- **The Free-to-Starter step is the weak rung.** Free includes 8 tokens and
  Starter 12, so R149 buys 4 more tokens -- R37 each, dearer than any top-up.
  The tier rate (R12.42) is fine; the *marginal* rate is not, and the app now
  says so rather than claiming the upgrade is better value. Starter still
  sells on the watermark, the custom voice and the free build. Either narrow
  the free tier or widen Starter, but decide it deliberately: raising Free
  from 2 tokens to 8 was right for onboarding and is what created this.
- **Payment rails.** An affordable price payable only by international card is
  not affordable. EFT, debit order, Ozow and SnapScan through Paystack.
- **The free tier's cost at a thousand accounts.** Model it before opening
  signups: each free account carries an avatar build.
- **VAT.** Consumer-facing, so advertise inclusive and say so.

The draft posts in `projects/identical/queue/_draft-*.md` carry these numbers
in public copy and stay unpublishable until the figures are confirmed.
