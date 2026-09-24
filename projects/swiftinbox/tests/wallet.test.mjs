import test from "node:test";
import assert from "node:assert/strict";
import {
  describeUsage,
  holdingMessage,
  upgradeMessage,
  shouldNotifyOwner,
} from "../src/lib/wallet.ts";

const DAY = 86_400_000;
const now = new Date("2026-03-10T09:00:00Z");

test("usage reads the way the dashboard shows it", () => {
  const u = describeUsage({ used: 120, limit: 150, periodEnd: new Date(now.getTime() + 5 * DAY) }, now);
  assert.equal(u.left, 30);
  assert.equal(u.percent, 80);
  assert.equal(u.daysLeft, 5);
  assert.equal(u.state, "warn");
});

test("warns from 80% and not before", () => {
  const end = new Date(now.getTime() + DAY);
  assert.equal(describeUsage({ used: 119, limit: 150, periodEnd: end }, now).state, "ok");
  assert.equal(describeUsage({ used: 120, limit: 150, periodEnd: end }, now).state, "warn");
});

test("at the cap is full, and over the cap does not read past 100%", () => {
  const end = new Date(now.getTime() + DAY);
  assert.equal(describeUsage({ used: 50, limit: 50, periodEnd: end }, now).state, "full");

  // Shouldn't happen -- the lock prevents it -- but if a row ever went over,
  // the meter must not draw a bar wider than its track or report 104%.
  const over = describeUsage({ used: 52, limit: 50, periodEnd: end }, now);
  assert.equal(over.percent, 100);
  assert.equal(over.left, 0);
  assert.equal(over.state, "full");
});

test("a finished period reads zero days, never negative", () => {
  const u = describeUsage({ used: 10, limit: 50, periodEnd: new Date(now.getTime() - 3 * DAY) }, now);
  assert.equal(u.daysLeft, 0);
});

test("the customer is never told the business has run out", () => {
  // The person messaging is a member of the public who messaged a shop. The
  // shop's billing is not their business, and saying so embarrasses the
  // customer we are actually selling to.
  const text = holdingMessage("Kruger Tyres").toLowerCase();
  for (const leak of ["plan", "limit", "upgrade", "conversations", "r300", "paid", "subscription"]) {
    assert.ok(!text.includes(leak), `holding reply leaks "${leak}": ${text}`);
  }
  assert.ok(text.includes("kruger tyres"));
});

test("the owner gets the numbers and the next tier", () => {
  const text = upgradeMessage({
    businessName: "Kruger Tyres",
    planKey: "basic",
    used: 150,
    missed: 4,
    dashboardUrl: "https://swiftinbox.co.za/dashboard/billing",
  });
  assert.ok(text.includes("150"), "says what the allowance was");
  assert.ok(text.includes("4 customers"), "says what it is costing");
  assert.ok(text.includes("Growth"), "names the next tier up");
  assert.ok(text.includes("R1 250"), "and its price");
  assert.ok(text.includes("250 more"), "and what the step actually buys");
});

test("one missed customer is not '1 customers'", () => {
  const text = upgradeMessage({
    businessName: "Kruger Tyres",
    planKey: "starter",
    used: 50,
    missed: 1,
    dashboardUrl: "https://x",
  });
  assert.ok(text.includes("1 customer has"), text);
  assert.ok(!text.includes("1 customers"));
});

test("the top tier is not sold an upgrade that does not exist", () => {
  const text = upgradeMessage({
    businessName: "Kruger Tyres",
    planKey: "scale",
    used: 1000,
    missed: 2,
    dashboardUrl: "https://x",
  });
  assert.ok(!text.includes("undefined"));
  assert.ok(text.includes("largest plan"));
});

test("the owner is nudged once a day, not once a message", () => {
  assert.equal(shouldNotifyOwner(null, now), true);
  assert.equal(shouldNotifyOwner(new Date(now.getTime() - 60_000), now), false);
  assert.equal(shouldNotifyOwner(new Date(now.getTime() - 23 * 3_600_000), now), false);
  assert.equal(shouldNotifyOwner(new Date(now.getTime() - 25 * 3_600_000), now), true);
  assert.equal(shouldNotifyOwner("not a date", now), true, "a bad value must not silence the nudge");
});
