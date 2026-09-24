import test from "node:test";
import assert from "node:assert/strict";
import { PLANS, ORDER, nextPlan, ratePerConversation, rands, randsExact } from "../src/lib/plans.ts";

test("the four tiers are exactly what is advertised", () => {
  assert.deepEqual(
    ORDER.map((k) => [PLANS[k].name, PLANS[k].cents, PLANS[k].conversations, PLANS[k].numbers]),
    [
      ["Starter", 30000, 50, 1],
      ["Basic", 65000, 150, 1],
      ["Growth", 125000, 400, 2],
      ["Scale", 250000, 1000, null],
    ],
  );
});

test("feature gates match the tiers they were sold on", () => {
  assert.equal(PLANS.starter.calendar, false);
  assert.equal(PLANS.basic.calendar, true, "Basic is sold with the calendar");
  assert.equal(PLANS.growth.afterHoursBooking, true, "Growth is sold as 24/7 booking");
  assert.equal(PLANS.growth.nurtureDays, 7, "Growth is sold with a 7-day nurture");
  assert.equal(PLANS.scale.numbers, null, "Scale is sold as unlimited numbers");
});

test("every step up is cheaper per conversation than the one below", () => {
  // The load-bearing invariant. If a tier ever costs more per conversation
  // than the tier beneath it, upgrading is a worse deal than staying put and
  // the whole ladder stops working. Silent when it breaks, so asserted.
  for (let i = 1; i < ORDER.length; i++) {
    const below = PLANS[ORDER[i - 1]];
    const above = PLANS[ORDER[i]];
    assert.ok(
      ratePerConversation(above) < ratePerConversation(below),
      `${above.name} is ${randsExact(ratePerConversation(above))} a conversation against ` +
        `${below.name} at ${randsExact(ratePerConversation(below))}`,
    );
  }
});

test("every step up buys more conversations and never fewer numbers", () => {
  for (let i = 1; i < ORDER.length; i++) {
    const below = PLANS[ORDER[i - 1]];
    const above = PLANS[ORDER[i]];
    assert.ok(above.conversations > below.conversations, `${above.name} adds no conversations`);
    assert.ok(above.cents > below.cents, `${above.name} costs no more`);
    const bn = below.numbers ?? Infinity;
    const an = above.numbers ?? Infinity;
    assert.ok(an >= bn, `${above.name} takes numbers away`);
  }
});

test("nextPlan walks the ladder and stops at the top", () => {
  assert.equal(nextPlan("starter")?.key, "basic");
  assert.equal(nextPlan("growth")?.key, "scale");
  assert.equal(nextPlan("scale"), null);
});

test("rands are written the South African way", () => {
  assert.equal(rands(30000), "R300");
  assert.equal(rands(125000), "R1 250");
  assert.equal(randsExact(ratePerConversation(PLANS.growth)), "R3,13");
});
