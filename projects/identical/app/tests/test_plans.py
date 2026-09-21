"""The pricing invariants. These fail loudly when a price moves badly."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import plans  # noqa: E402


class InvariantTests(unittest.TestCase):
    def test_credits_cost_more_per_video_than_every_plan(self):
        """The load-bearing rule: if credits undercut a plan, nobody subscribes."""
        for pack in plans.CREDIT_PACKS:
            for key in plans.PAID:
                plan = plans.PLANS[key]
                self.assertGreater(
                    pack.cents_per_video, plan.cents_per_video,
                    f"{pack.credits}-credit pack undercuts {plan.name}",
                )

    def test_cost_per_video_falls_as_plans_get_bigger(self):
        rates = [plans.PLANS[key].cents_per_video for key in plans.PAID]
        self.assertEqual(rates, sorted(rates, reverse=True))

    def test_bigger_packs_are_better_value(self):
        rates = [pack.cents_per_video for pack in plans.CREDIT_PACKS]
        self.assertEqual(rates, sorted(rates, reverse=True))

    def test_free_plan_withholds_the_costly_features(self):
        free = plans.PLANS["free"]
        self.assertFalse(free.custom_voice, "voice cloning is per-user compute")
        self.assertFalse(free.guided_build, "the guided build is human time")
        self.assertTrue(free.watermark)

    def test_every_paid_plan_includes_the_guided_build(self):
        for key in plans.PAID:
            self.assertTrue(plans.PLANS[key].guided_build, f"{key} must honour 'no setup fee'")

    def test_no_plan_is_unlimited(self):
        for plan in plans.PLANS.values():
            self.assertGreater(plan.videos, 0)


class AdviceTests(unittest.TestCase):
    def test_recommends_the_upgrade_when_credits_cost_more(self):
        advice = plans.advise_at_cap("starter", wanted=10)
        self.assertIn("rather move you up", advice.verdict)
        self.assertEqual(advice.upgrade.key, "pro")

    def test_does_not_oversell_a_one_off(self):
        advice = plans.advise_at_cap("starter", wanted=5)
        self.assertIn("one-off", advice.verdict)

    def test_top_plan_has_no_upgrade_to_push(self):
        advice = plans.advise_at_cap("premium")
        self.assertIsNone(advice.upgrade)

    def test_minutes_match_the_published_table(self):
        self.assertEqual(plans.PLANS["starter"].max_minutes, 14)
        self.assertEqual(plans.PLANS["pro"].max_minutes, 32)
        self.assertEqual(plans.PLANS["premium"].max_minutes, 56)


if __name__ == "__main__":
    unittest.main()
