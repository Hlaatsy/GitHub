# IDENTICAL — revenue model

Internal. Every rand figure is a **proposal to confirm** against your real
per-video platform cost, which I do not know. See "Before any of this is
public" at the bottom.

## The decision that shapes everything

**Entry at R149/mo. No setup fee. The twin is built free on every plan.**

This is the right call for this market. A R2 500 once-off in front of a
product nobody has tried is a wall, not a price — and in a market where most
small businesses are deciding between your subscription and something else
they also need this month, the wall is where you lose them.

But it moves the risk. The twin build is real skilled work, and it now
happens before a single rand arrives. At R149/mo, an hour of setup labour
takes months of subscription to repay. So the model only works if two things
are true:

1. **Setup has to get cheap to deliver.** Guided self-service with a template,
   a checklist and one review pass — not an hour of hand-holding per customer.
   If every twin costs you an hour, R149 is a loss leader with no back end.
2. **Retention has to be real.** Payback is around month four or five. A
   customer who leaves at month two cost you money. Annual prepay and the
   done-for-you ladder below are how that risk gets managed — not by adding
   the fee back.

Sell the absence of the fee. "No setup fee, your twin built free" is a
stronger line than anything in the feature list, because every competitor
either charges for it or makes you do it yourself badly.

## Market

Sub-Saharan Africa, not South Africa alone. South Africa is the first market
because it is where the team and the first customers are, not because the
model stops there. Nigeria, Kenya and Ghana are the next three, and the
pricing below is built to extend rather than be redesigned.

Western SaaS pricing does not transplant here. A $25-50/month tier runs into
card transaction limits, foreign exchange volatility and software budgets set
in a different currency. The structure that works is a low local-currency
entry tier plus credit packs, paid through the rails people actually use.

## Self-serve tiers — South Africa

| Tier | Price | Videos/mo | Per video | Custom AI voice |
| --- | --- | --- | --- | --- |
| **Free** | R0 | 2 | — | No — standard voices only |
| **Starter** | **R149/mo** | 7 | R21.29 | Yes |
| **Pro** | **R299/mo** | 16 | R18.69 | Yes, 3 twins, translation |
| **Premium** | **R449/mo** | 28 | R16.04 | Yes, 10 twins, team seats |

Cost per video falls at every step (R21 → R19 → R16), each paid upgrade is
R150, and the marginal cost of the extra videos falls too: R16.67 each going
to Pro, R12.50 going to Premium. Nothing is unlimited.

### Two open questions on this table

**1. Videos or minutes?** This table counts videos. Counting *minutes* is
fairer — a 20-second clip and a three-minute explainer cost very different
amounts to render, and charging the same for both means short-form users
subsidise long-form ones. It also tracks platform cost directly.

The cost is comprehension. "7 videos" is a number a customer can picture;
"20 minutes" makes them do arithmetic before they know what they are buying.

Recommended: **price in videos, cap the length.** Seven videos of up to two
minutes each. The customer reads a number they understand, and the cap
protects the margin that minute-billing would protect. Revisit if long-form
turns out to be common.

**2. Is the allowance right?** Seven videos for R149 is one view; a suggested
alternative was 15-20 minutes for roughly the same money, which is two to
three times more generous. Both are defensible and the difference is not a
matter of taste — it is whether your per-video platform cost leaves margin at
R21.29. Work that number out and let it decide. The prices are the promise to
the market; the allowances are the lever.

### The free tier earns its place with the voice, not the video count

Two videos a month is not what makes Free convert. The missing custom AI
voice is.

A free user makes two videos in a stock voice, and every time they watch one
back it sounds like someone else. That is a better upgrade argument than a
counter reading 0 of 2, because it is felt rather than enforced — and it
gates the feature that genuinely costs money per user. Voice cloning is
per-user compute; stock TTS is not.

### The question Free forces: who gets the twin build?

"No setup fee, your twin built free" is the sharpest line in the positioning,
and it was already an acquisition cost paid before revenue. A free tier means
paying it for people who may never pay at all.

**Recommendation: Free does not get the guided build.**

| | What they get | What it costs you |
| --- | --- | --- |
| Free | Library avatar, or automated photo-to-twin from an upload | Compute only |
| Paid | The guided build — recording direction, iterations until it looks like them, consent record on file | Templated human time |

Avatar 4 makes this workable: a single photo becomes a talking twin with no
human involved. Free users get a real product and a real result. They do not
get the part with a person attached to it. "No setup fee" stays true for
every paying customer, which is who it was aimed at.

### Decide before launch

- **Two videos per month, or two ever?** Per month is an ongoing cost with no
  ceiling on how long someone sits there. Recommend per month, with the voice
  restriction doing the conversion work — but know what it costs at a
  thousand users.
- **Watermark free videos.** Every free video becomes distribution, and it is
  a second upgrade trigger that costs nothing to implement.
- **Cap free accounts per person.** Email-only signup lets one person farm
  unlimited free twins. Phone verification is the usual answer, and it is
  cheap in markets where everyone has a number.
- **What happens to a free user's twin if they never pay?** Storage cost and
  a POPIA answer. Decide the period, say it at signup.

## Other markets

Same shape, different numbers. Three rules:

1. **Price in local currency, not a USD conversion.** A price that moves with
   the exchange rate is the friction this whole model exists to remove — and
   "priced in your own money" is a positioning pillar, not a convenience.
   Set each market's number as a round local figure and review it quarterly.
2. **Anchor to the market, not to the rand.** R149 ≈ $8. Today ₦12 000 and
   KSh 1 200 are close to the same thing; in a year they will not be. Each
   market's entry price should be the right price *there*, judged against
   local buying power and local competitors, and allowed to drift from the
   others.
3. **Re-derive the allowance per market if costs differ.** If rendering costs
   the same everywhere but prices differ, margin differs. Know which markets
   subsidise which.

Indicative entry pricing, to be set properly per market before launch:

| Market | Entry tier | Rough USD |
| --- | --- | --- |
| South Africa | R149 | ~$8 |
| Nigeria | ₦12 000 | ~$8 |
| Kenya | KSh 1 200 | ~$9 |
| Ghana | to set | ~$8 |

## Credit packs

Many buyers here will not commit to a recurring debit at all — a freelancer
or an SME running a campaign this month and nothing next month wants to pay
when they need it. Credit packs serve them, and they serve subscribers who
overshoot their allowance.

One credit is one video.

| Pack | Price | Per video |
| --- | --- | --- |
| 1 credit | R35 | R35.00 |
| 5 credits | R149 | R29.80 |
| 15 credits | R399 | R26.60 |

**Credits do not expire monthly.** They sit in the account until used,
subject to the outer expiry below. Nothing resets on the 1st, because a
campaign-driven buyer's month is not the calendar's.

### The rule that keeps the model standing

**A credit must always cost more per video than the most expensive
subscription tier.**

Credits run R26.60-R35. Subscription tiers run R16.04-R21.29. Buying past the
cap is deliberately the expensive route, which is what tells a customer with
sustained volume that a plan is cheaper — in numbers they can check
themselves.

**This is where the suggested $0.50-$1.00 per video pricing breaks the
model.** At roughly R9-R18 a video, credits would undercut every subscription
tier, including the R149 entry. A rational customer would then never
subscribe: they would buy credits forever, and you would have a
pay-as-you-go business carrying a subscription's support burden and a free
tier's acquisition cost. The number looks attractively low precisely because
it is below the price that sustains the rest of the structure.

If you want an entry point nearer that level, cut the *subscription* price or
raise its allowance — never the credit price below it. Re-check this ordering
every time any price moves, in every market.

### At the cap

The moment someone hits their limit is the highest-intent moment in the
product.

- **Stop, do not silently queue.** A video that will not render with no
  explanation reads as broken software, and they churn rather than ask.
- **Show both options with real arithmetic.** "You have used 7 of 7. 5
  credits is R149. Pro gives you 16 every month for R299."
- **Say when topping up stops making sense.** Two 5-credit packs is R298 —
  about the price of Pro, for fewer videos. Saying so earns more than the
  margin is worth, and converts the customer to recurring revenue.

### Decide before launch

- **Outer expiry.** Credits should not expire monthly, but unexpiring credits
  are an open-ended liability against your platform costs. Recommend 12
  months from purchase, stated on the purchase screen rather than in the
  terms page.
- **Consumption order.** Spend the monthly allowance first, credits only
  after. Burning purchased credits while free allowance sits unused is
  indefensible once a customer notices, and they do.
- **Refunds on cancellation.** Unused credits refundable or forfeited?
  Consumer protection rules bite; decide deliberately rather than in a
  dispute.
- **VAT and local sales taxes** apply to credit purchases as much as to
  subscriptions, and differ per market. If prices are advertised inclusive,
  they must be inclusive everywhere they are advertised.

## Payment rails

An affordable price payable only by international credit card is not
affordable. This is not a detail to settle after launch — in several of these
markets it decides whether the product can be bought at all.

**Integrate a local aggregator rather than a card processor alone.** Paystack
or Flutterwave cover the region and carry the rails that matter:

| Market | What people actually pay with |
| --- | --- |
| South Africa | EFT, debit order, Ozow, SnapScan, card |
| Kenya | M-Pesa |
| Nigeria | Bank transfer, USSD, card |
| Ghana | MTN Mobile Money, AirtelTigo, Telecel Cash |

Mobile money is not a fallback for people without cards. In Kenya it is the
default way to pay for anything, and a checkout that treats M-Pesa as an
alternative option reads as a foreign product.

**Requirements this places on the build:**

- **Mobile money must work inside the WhatsApp flow.** If a user records a
  voice note in WhatsApp, they must be able to pay without leaving the thread
  for a browser. See `product.md` section 3.
- **Budget the fees.** Aggregator and mobile-money fees are materially higher
  than card rates in some corridors, and they come off a R149 entry tier.
  Check the effective margin per market, not the headline price.
- **Handle failed recurring collections gracefully.** Debit orders and mobile
  money subscriptions fail more often than cards, usually for lack of funds
  rather than intent. Retry on a schedule, keep the account alive, and tell
  the customer plainly — treating a failed collection as a cancellation
  throws away customers who meant to stay.

## Done-for-you ladder

The service layer is still where the business is.

| Offer | Proposed | What it is |
| --- | --- | --- |
| Scripts Only | R899/mo | 8 scripts written for your twin; you record and post |
| **Done-For-You Starter** | R1 499/mo | 4 videos a month, scripted and produced |
| **Content Engine** | R3 499/mo | 12 videos a month, calendar, captions, clips |
| Content Engine+ | R6 499/mo | 30 videos, translation, priority turnaround |

**The gap worth watching.** With Premium at R449, the step to Done-For-You
at R1 499 is more than triple — where the subscription ladder rises R150 at
a time. Some of that gap is justified: these are different products, and the
cost is a person writing scripts rather than compute. But R449 to R1 499 is
where upgrades will stall, and nobody climbs a ladder with one rung missing.

Scripts Only is the proposed bridge, and it targets the actual failure. The
reason Starter customers go quiet is never the software — it is that nobody
wrote anything. Selling the writing alone, at half the price of full
production, meets that customer where they are: they already have a twin and
know how to use it. It is also the cheapest service to deliver, since there
is no production or revision cycle attached.

Treat it as optional. If the gap turns out not to cost you upgrades, drop
it — an extra tier is a real cost in explanation and support.

R149 → R449 → R1 499 → R3 499 is a ladder someone can actually climb. The
upgrade conversation happens when a customer hits the video cap or admits
they have not written a script in six weeks — both of which you can see.

Cap revisions in writing. The cost in this tier is script writing and client
back-and-forth, never compute. Uncapped revisions is how a good client
becomes an unprofitable one.

## Enterprise

Custom pricing, annual contracts. Fintechs, banks, telecoms, insurers and
public agencies.

| What they need | Why it is not in the self-serve tiers |
| --- | --- |
| API access | Their systems generate the videos, not a person in an app |
| Custom corporate avatars | Their own staff or brand presenters, built and consented properly |
| SLAs | Uptime and turnaround they can put in a contract |
| Data handling commitments | Where footage and voice data live, for how long, under whose law |

This is where the compliance pillar converts into contract value rather than
a blog post. A bank cannot buy avatar video without answering the consent,
retention and biometric questions — and the vendors who can only discuss
model quality lose that deal at legal review, not at the demo.

Price on annual value, never per video. The self-serve arithmetic is
irrelevant at this size; what matters is the cost of the alternative, which
is a production agency on retainer.

Sell this last. An enterprise pilot that goes badly because the pipeline was
not ready costs more than the contract was worth, and these buyers talk to
each other.

## White-label partners

**Proposed: R4 999/mo flat, or 25% revenue share.**

Agencies, PR firms, training providers and HR consultancies resell under
their own brand; you run production behind them. One partner selling to ten
clients beats ten direct clients for the same effort.

Build this after the done-for-you tiers have run for real clients. A partner
reselling an unproven process damages two reputations at once.

## Training

| Offer | Proposed |
| --- | --- |
| Public workshop seat | R450 |
| In-house corporate half-day | R9 500 |

R450 puts a seat within reach of the solopreneur who is the target customer
anyway, and every room is full of done-for-you buyers who have just watched
you demonstrate competence for half a day. The corporate session is where the
margin is.

## Compliance products

The pillar no competitor offers, billed directly:

| Offer | Proposed |
| --- | --- |
| Likeness consent pack — forms, retention terms, register | R1 500 |
| Internal AI content policy | R3 500 |

The consent pack is now *cheaper* than the old setup fee, and it is the
thing that gets IDENTICAL past an enterprise buyer's legal review, so it is
worth more than it costs.

Distribution note: these were priced assuming warm introductions into an
existing compliance client base. IDENTICAL is its own brand with its own
page, so that only holds if it can reach KhutsoGRC's accounts — through a
shared team, a referral arrangement, or a co-marketing line. Agree which it
is before counting this revenue: a referral arrangement between two brands
is a conversation to have once, not an assumption to discover later. If
there is no route, these two products still sell, but cold, and they should
not carry the early forecast.

## The funnel

1. LinkedIn posts (`projects/identical/queue/`) — attention and proof,
   since every post can be made with the product.
2. Free 60-second demo twin from a photo they send. Minutes to fulfil,
   converts because they see their own face talking.
3. **R149/mo, twin built free.** The first transaction, and now a small
   enough yes to make on the spot.
4. **The cap.** Every Starter customer meets it, by design. Tokens for the
   occasional spike, Pro or Premium for sustained volume — and the token
   price is set so the arithmetic recommends the upgrade itself.
5. Done-for-you when they stop writing scripts. This is the margin.
6. White-label or training — leverage, once 5 is running.

Instrument step 3 to 4, and watch two numbers specifically: **how many
Starter customers hit the cap**, and **what they do next**. If almost nobody
reaches it, the cap is too generous and the tiers above have no pull. If
people reach it and churn instead of upgrading or topping up, the price step
to Pro is too steep or the prompt at the cap is doing its job badly.

With no setup fee, the other conversion that matters is no longer "will they
pay to start" — it is "are they still here in month five". Track month-2 and month-5 retention from the first cohort. If month-5
retention is under half, fix the onboarding before spending another rand on
reach.

## Before any of this is public

- **Cost the entry tier properly.** R149 with a free twin build only works if
  setup is templated and the video cap is set against real per-video cost.
  This is the number to check first, before the post goes out.
- **Cap everything.** Videos per tier, revisions per retainer. No
  "unlimited".
- **Check the token-to-tier ratio.** A token must cost more per video than
  the next tier up, or the tiers stop meaning anything. Re-check whenever any
  price moves.
- **Token terms on the purchase screen**: expiry, roll-over, consumption
  order, refund on cancellation. Not buried in the terms page.
- **Payment rails before prices.** See the payment rails section. In Kenya
  and Ghana this decides whether the product can be bought at all, not merely
  how conveniently.
- **Check the credit-to-tier ordering** in every market, every time a price
  moves. It is the load-bearing rule and it breaks silently.
- **Month-to-month, cancel anytime.** Say it explicitly. A lock-in contract
  undoes the trust the low price buys, and annual prepay should be chosen for
  the discount, never required.
- **VAT and local sales tax.** Decide inclusive or exclusive and say which
  wherever a price appears. Rules differ per market; a single global answer
  will be wrong somewhere. For a consumer-facing R149, advertise inclusive.
- **Confirm you may resell** before the white-label post. Reselling,
  white-labelling and partner distribution are three separate permissions.

The draft posts in `projects/identical/queue/_draft-*.md` carry these
numbers in public
copy. They stay underscore-prefixed, and therefore unpublishable, until the
figures are yours rather than mine.
