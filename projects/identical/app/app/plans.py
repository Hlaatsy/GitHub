"""Plans, credits and the rules that hold the pricing together.

Single source of truth for anything with a price on it. The numbers here must
match ``docs/monetisation.md``; ``test_plans.py`` fails if the invariants that
document relies on stop holding.

Money is in whole cents throughout. Floats lose rands at scale, and every
figure here ends up on an invoice.
"""

from __future__ import annotations

from dataclasses import dataclass, field

#: Longest single video, on every plan. Keeps a flat per-video price honest:
#: without it, one user rendering forty-minute webinars on the entry tier
#: erases the tier's margin.
MAX_VIDEO_SECONDS = 120

#: Credits stay usable across months but not forever -- an unexpiring credit is
#: an open-ended liability against platform cost. Stated at purchase.
CREDIT_EXPIRY_DAYS = 365


@dataclass(frozen=True)
class Plan:
    key: str
    name: str
    cents: int
    videos: int
    twins: int
    custom_voice: bool
    guided_build: bool
    watermark: bool
    features: tuple[str, ...] = ()

    @property
    def rand(self) -> str:
        return f"R{self.cents // 100:,}".replace(",", " ")

    @property
    def cents_per_video(self) -> int | None:
        """What a video costs on this plan, or None when the plan is free."""
        if not self.cents or not self.videos:
            return None
        return round(self.cents / self.videos)

    @property
    def max_minutes(self) -> int:
        return self.videos * MAX_VIDEO_SECONDS // 60


PLANS: dict[str, Plan] = {
    "free": Plan(
        key="free",
        name="Free",
        cents=0,
        videos=2,
        twins=1,
        custom_voice=False,
        # The guided build is human time. Giving it away to accounts that may
        # never pay is the one cost that does not scale -- free accounts get
        # the automated photo-to-twin instead.
        guided_build=False,
        watermark=True,
        features=("Library avatar or photo twin", "Standard voices"),
    ),
    "starter": Plan(
        key="starter",
        name="Starter",
        cents=14900,
        videos=7,
        twins=1,
        custom_voice=True,
        guided_build=True,
        watermark=False,
        features=("Guided twin build, free", "Your own custom AI voice", "Consent record on file"),
    ),
    "pro": Plan(
        key="pro",
        name="Pro",
        cents=29900,
        videos=16,
        twins=3,
        custom_voice=True,
        guided_build=True,
        watermark=False,
        features=("Everything in Starter", "3 twins", "Voice cloning", "Video translation"),
    ),
    "premium": Plan(
        key="premium",
        name="Premium",
        cents=44900,
        videos=28,
        twins=10,
        custom_voice=True,
        guided_build=True,
        watermark=False,
        features=("Everything in Pro", "10 twins", "Team seats", "Priority render queue"),
    ),
}

ORDER = ("free", "starter", "pro", "premium")
PAID = ORDER[1:]


@dataclass(frozen=True)
class CreditPack:
    credits: int
    cents: int

    @property
    def cents_per_video(self) -> int:
        return round(self.cents / self.credits)


CREDIT_PACKS: tuple[CreditPack, ...] = (
    CreditPack(credits=1, cents=3500),
    CreditPack(credits=5, cents=14900),
    CreditPack(credits=15, cents=39900),
)


def next_plan(key: str) -> Plan | None:
    """The plan above this one, or None at the top."""
    index = ORDER.index(key)
    return PLANS[ORDER[index + 1]] if index + 1 < len(ORDER) else None


def cheapest_credit_rate() -> int:
    return min(pack.cents_per_video for pack in CREDIT_PACKS)


def dearest_plan_rate() -> int:
    rates = [PLANS[key].cents_per_video for key in PAID]
    return max(rate for rate in rates if rate is not None)


def credits_stay_dearer_than_plans() -> bool:
    """The load-bearing rule: topping up must never beat subscribing.

    If a credit is cheaper per video than a plan, nobody upgrades -- they top
    up forever, and the subscription tiers stop meaning anything. This is
    checked in tests rather than trusted, because it breaks silently when any
    single price moves.
    """
    return cheapest_credit_rate() > dearest_plan_rate()


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
    packs = tuple(pack for pack in CREDIT_PACKS if pack.credits >= 1)

    if upgrade is None:
        return Advice(packs=packs, upgrade=None, verdict="You are on the top plan -- credits it is.")

    # Cheapest way to buy `wanted` videos from whole packs, largest first.
    remaining, spend = wanted, 0
    for pack in sorted(CREDIT_PACKS, key=lambda p: -p.credits):
        while remaining >= pack.credits:
            spend += pack.cents
            remaining -= pack.credits
    if remaining:
        smallest = min(CREDIT_PACKS, key=lambda p: p.credits)
        spend += smallest.cents * remaining

    extra = upgrade.videos - plan.videos

    # Compare against what upgrading actually costs *extra* per month, not the
    # whole plan price -- they are already paying for the plan underneath. At
    # R149 vs R299 the full-price comparison makes credits look like the
    # bargain when the upgrade buys nine more videos a month for R150.
    marginal = upgrade.cents - plan.cents

    noun = "video" if wanted == 1 else "videos"
    if spend >= marginal:
        verdict = (
            f"{wanted} more {noun} in credits is {_rand(spend)}, once. "
            f"Moving to {upgrade.name} is {_rand(marginal)} more a month and gives you "
            f"{extra} more videos, every month. "
            "We would rather move you up a plan than take the difference."
        )
        if extra < wanted:
            verdict += (
                f" ({upgrade.name} adds {extra}, so you would still need "
                f"{wanted - extra} on credit this month.)"
            )
    else:
        verdict = (
            f"{wanted} more {noun} in credits is {_rand(spend)} this month only. "
            f"{upgrade.name} is {_rand(marginal)} more a month for {extra} extra -- "
            "better value the moment this stops being a one-off."
        )
    return Advice(packs=packs, upgrade=upgrade, verdict=verdict)


def _rand(cents: int) -> str:
    return f"R{cents // 100:,}".replace(",", " ")
