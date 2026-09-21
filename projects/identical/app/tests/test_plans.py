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

    def test_trial_withholds_the_costly_features(self):
        trial = plans.PLANS["trial"]
        self.assertFalse(trial.custom_voice, "voice cloning is per-user compute")
        self.assertFalse(trial.guided_build, "the guided build is a paid service")
        self.assertTrue(trial.watermark)

    def test_seats_grow_with_the_tiers(self):
        seats = [plans.PLANS[key].seats for key in plans.ORDER]
        self.assertEqual(seats, sorted(seats))

    def test_team_bundle_is_five_seats_with_team_features(self):
        """The marketing and PR bundle is the tier this model is built around."""
        team = plans.PLANS["team5"]
        self.assertEqual(team.seats, 5)
        self.assertTrue(team.shared_library)
        self.assertTrue(team.approvals, "approval workflow is what the comms lead buys")

    def test_team_seats_carry_more_capacity_than_pro_seats(self):
        """Per-seat price rises at Team 5; this is what justifies it."""
        self.assertGreater(
            plans.PLANS["team5"].videos_per_seat, plans.PLANS["pro"].videos_per_seat
        )

    def test_every_paid_plan_includes_the_guided_build(self):
        for key in plans.PAID:
            self.assertTrue(plans.PLANS[key].guided_build, f"{key} must honour 'no setup fee'")

    def test_no_plan_is_unlimited(self):
        for plan in plans.PLANS.values():
            self.assertGreater(plan.videos, 0)


class AdviceTests(unittest.TestCase):
    def test_recommends_the_upgrade_when_overage_costs_more(self):
        biggest = max(pack.credits for pack in plans.CREDIT_PACKS)
        advice = plans.advise_at_cap("starter", wanted=biggest)
        self.assertIn("rather move you up", advice.verdict)
        self.assertEqual(advice.upgrade.key, "pro")

    def test_does_not_oversell_a_one_off(self):
        advice = plans.advise_at_cap("starter", wanted=1)
        self.assertIn("one-off", advice.verdict)

    def test_top_plan_has_no_upgrade_to_push(self):
        advice = plans.advise_at_cap(plans.ORDER[-1])
        self.assertIsNone(advice.upgrade)

    def test_minutes_match_the_published_table(self):
        self.assertEqual(plans.PLANS["starter"].max_minutes, 20)
        self.assertEqual(plans.PLANS["pro"].max_minutes, 80)
        self.assertEqual(plans.PLANS["team5"].max_minutes, 240)


if __name__ == "__main__":
    unittest.main()
