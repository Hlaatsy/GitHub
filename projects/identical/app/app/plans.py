"""Plans, tokens and the rules that hold the pricing together.

Single source of truth for anything with a price on it. The numbers here must
match ``docs/monetisation.md``; ``test_plans.py`` fails if the invariants that
document relies on stop holding.

Money is in whole cents throughout. Floats lose rands at scale, and every
figure here ends up on an invoice.
"""

from __future__ import annotations

from dataclasses import dataclass, field

#: What each thing costs from the token pool. A video is the unit; an avatar
#: is a voice clone and a build, which is materially more compute than one
#: render -- but not so much that it swallows a whole month on the entry tier.
VIDEO_TOKENS = 1
AVATAR_TOKENS = 5

#: Longest single video, on every plan. Keeps a flat per-video price honest:
#: without it, one user rendering forty-minute webinars on the entry tier
#: erases the tier's margin.
MAX_VIDEO_SECONDS = 120

#: Tokens stay usable across months but not forever -- an unexpiring credit is
#: an open-ended liability against platform cost. Stated at purchase.
TOKEN_EXPIRY_DAYS = 365


@dataclass(frozen=True)
class Plan:
    key: str
    name: str
    cents: int
    tokens: int
    seats: int
    custom_voice: bool
    guided_build: bool
    watermark: bool
    shared_library: bool = False
    approvals: bool = False
    features: tuple[str, ...] = ()

    @property
    def rand(self) -> str:
        return f"R{self.cents // 100:,}".replace(",", " ")

    @property
    def cents_per_token(self) -> int | None:
        """What a token costs on this plan, or None when the plan is free."""
        if not self.cents or not self.tokens:
            return None
        return round(self.cents / self.tokens)

    @property
    def videos(self) -> int:
        """Tokens expressed as videos, which is how a buyer reads the plan."""
        return self.tokens // VIDEO_TOKENS

    @property
    def cents_per_seat(self) -> int | None:
        if not self.cents or not self.seats:
            return None
        return round(self.cents / self.seats)

    @property
    def tokens_per_seat(self) -> float:
        return self.tokens / self.seats if self.seats else 0

    @property
    def max_minutes(self) -> int:
        """If every token went on a full-length video."""
        return self.tokens * MAX_VIDEO_SECONDS // 60


PLANS: dict[str, Plan] = {
    "free": Plan(
        key="free",
        name="Free",
        cents=0,
        # An avatar is 5 tokens, so anything less than this and a free account
        # cannot make the one thing it exists to show.
        tokens=8,
        seats=1,
        custom_voice=False,
        guided_build=False,
        watermark=True,
        features=("Your avatar and 3 videos", "Standard voices", "Watermarked"),
    ),
    "starter": Plan(
        key="starter",
        name="Starter",
        cents=14900,
        tokens=12,
        seats=1,
        custom_voice=True,
        guided_build=True,
        watermark=False,
        features=("Your avatar built free", "Your own voice", "No watermark"),
    ),
    "pro": Plan(
        key="pro",
        name="Pro",
        cents=29900,
        tokens=28,
        seats=2,
        custom_voice=True,
        guided_build=True,
        watermark=False,
        shared_library=True,
        features=("Everything in Starter", "Voice cloning", "Translation",
                  "A second seat"),
    ),
    "premium": Plan(
        key="premium",
        name="Premium",
        cents=44900,
        tokens=48,
        seats=3,
        custom_voice=True,
        guided_build=True,
        watermark=False,
        shared_library=True,
        # Approvals stay in the code and off by default: a solopreneur has
        # nobody to approve anything. A three-seat account can switch it on.
        approvals=True,
        features=("Everything in Pro", "3 seats", "Priority queue"),
    ),
}


ORDER = ("free", "starter", "pro", "premium")

#: What a new account starts on.
DEFAULT_PLAN = "free"

#: Plan keys from the consumer model, mapped to their B2B equivalent. An
#: account created before the change still carries the old key, and every
#: lookup against PLANS would raise without this.
RENAMED = {"trial": "free", "team5": "premium", "business": "premium"}
PAID = ORDER[1:]


@dataclass(frozen=True)
class TokenPack:
    tokens: int
    cents: int

    @property
    def cents_per_token(self) -> int:
        return round(self.cents / self.tokens)


#: Top-ups, bought when the monthly tokens run out. Priced above every
#: subscription tier's per-token rate on purpose -- see
#: ``top_ups_stay_dearer_than_plans``.
TOKEN_PACKS: tuple[TokenPack, ...] = (
    TokenPack(tokens=5, cents=9900),
    TokenPack(tokens=20, cents=34900),
    TokenPack(tokens=50, cents=79900),
)


def next_plan(key: str) -> Plan | None:
    """The plan above this one, or None at the top."""
    index = ORDER.index(key)
    return PLANS[ORDER[index + 1]] if index + 1 < len(ORDER) else None


def cheapest_top_up_rate() -> int:
    return min(pack.cents_per_token for pack in TOKEN_PACKS)


def dearest_plan_rate() -> int:
    rates = [PLANS[key].cents_per_token for key in PAID]
    return max(rate for rate in rates if rate is not None)


def top_ups_stay_dearer_than_plans() -> bool:
    """The load-bearing rule: topping up must never beat subscribing.

    If a topped-up token is cheaper than a subscribed one, nobody upgrades --
    they top up forever, and the tiers stop meaning anything. Checked in tests
    rather than trusted, because it breaks silently when any single price
    moves, and it has broken twice already.
    """
    return cheapest_top_up_rate() > dearest_plan_rate()


@dataclass
class Advice:
    """What to tell someone who has run out, at the moment they run out."""

    packs: tuple[CreditPack, ...] = field(default_factory=tuple)
    upgrade: Plan | None = None
    verdict: str = ""


def advise_at_cap(plan_key: str, wanted: int = 5) -> Advice:
    """Compare buying ``wanted`` more videos against moving up a plan.

    Says plainly when the upgrade is the better deal, including when that
    means talking someone out of a purchase they were about to make. A
    customer who notices we took the worse-value option for them silently is
    a customer who leaves.
    """
    plan = PLANS[plan_key]
    upgrade = next_plan(plan_key)
    packs = tuple(pack for pack in TOKEN_PACKS if pack.tokens >= 1)

    if upgrade is None:
        return Advice(packs=packs, upgrade=None,
                      verdict="You are on the top plan -- topping up it is.")

    # Cheapest way to buy `wanted` videos from whole packs, largest first.
    remaining, spend = wanted, 0
    for pack in sorted(TOKEN_PACKS, key=lambda p: -p.tokens):
        while remaining >= pack.tokens:
            spend += pack.cents
            remaining -= pack.tokens
    if remaining:
        smallest = min(TOKEN_PACKS, key=lambda p: p.tokens)
        spend += smallest.cents * remaining

    extra = upgrade.tokens - plan.tokens

    # Compare against what upgrading actually costs *extra* per month, not the
    # whole plan price -- they are already paying for the plan underneath. At
    # The full-price comparison makes topping up look like the bargain when
    # the upgrade buys far more tokens every month for the difference.
    marginal = upgrade.cents - plan.cents

    noun = "token" if wanted == 1 else "tokens"
    if spend >= marginal:
        verdict = (
            f"{wanted} more {noun} topped up is {_rand(spend)}, once. "
            f"Moving to {upgrade.name} is {_rand(marginal)} more a month and gives you "
            f"{extra} more videos, every month. "
            "We would rather move you up a plan than take the difference."
        )
        if extra < wanted:
            verdict += (
                f" ({upgrade.name} adds {extra}, so you would still top up "
                f"{wanted - extra} this month.)"
            )
    else:
        verdict = (
            f"{wanted} more {noun} topped up is {_rand(spend)} this month only. "
            f"{upgrade.name} is {_rand(marginal)} more a month for {extra} extra -- "
            "better value the moment this stops being a one-off."
        )
    return Advice(packs=packs, upgrade=upgrade, verdict=verdict)


def _rand(cents: int) -> str:
    return f"R{cents // 100:,}".replace(",", " ")
