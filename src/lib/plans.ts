/**
 * The four tiers, in one place.
 *
 * Every rand figure in the product comes from here -- the landing page, the
 * dashboard meter, the upgrade prompt sent over WhatsApp, and the Paystack
 * plan codes. Prices duplicated into a component drift away from the ones
 * actually charged, and the customer sees the stale one.
 *
 * Money is in cents throughout. Paystack takes cents, and cents are exact
 * where floating-point rands are not.
 */

export type PlanKey = "starter" | "basic" | "growth" | "scale";

export interface Plan {
  key: PlanKey;
  name: string;
  cents: number;
  conversations: number;
  /** null means unlimited. */
  numbers: number | null;
  calendar: boolean;
  afterHoursBooking: boolean;
  nurtureDays: number;
  blurb: string;
  features: string[];
}

export const PLANS: Record<PlanKey, Plan> = {
  starter: {
    key: "starter",
    name: "Starter",
    cents: 30000,
    conversations: 50,
    numbers: 1,
    calendar: false,
    afterHoursBooking: false,
    nurtureDays: 0,
    blurb: "One number, answered properly.",
    features: [
      "50 conversations a month",
      "1 WhatsApp number",
      "Answers in English, Afrikaans, isiZulu and Setswana",
      "Handover to a human whenever the customer asks",
    ],
  },
  basic: {
    key: "basic",
    name: "Basic",
    cents: 65000,
    conversations: 150,
    numbers: 1,
    calendar: true,
    afterHoursBooking: false,
    nurtureDays: 0,
    blurb: "Adds the diary, so enquiries become appointments.",
    features: [
      "150 conversations a month",
      "1 WhatsApp number",
      "Calendar booking",
      "Everything in Starter",
    ],
  },
  growth: {
    key: "growth",
    name: "Growth",
    cents: 125000,
    conversations: 400,
    numbers: 2,
    calendar: true,
    afterHoursBooking: true,
    nurtureDays: 7,
    blurb: "Books while you sleep and follows up for a week.",
    features: [
      "400 conversations a month",
      "2 WhatsApp numbers",
      "24/7 booking, including after hours",
      "7-day follow-up for enquiries that go quiet",
      "Everything in Basic",
    ],
  },
  scale: {
    key: "scale",
    name: "Scale",
    cents: 250000,
    conversations: 1000,
    numbers: null,
    calendar: true,
    afterHoursBooking: true,
    nurtureDays: 7,
    blurb: "Every branch, every number, one assistant.",
    features: [
      "1 000 conversations a month",
      "Unlimited WhatsApp numbers",
      "Everything in Growth",
      "Priority support",
    ],
  },
};

export const ORDER: PlanKey[] = ["starter", "basic", "growth", "scale"];
export const DEFAULT_PLAN: PlanKey = "starter";

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && value in PLANS;
}

export function planOf(key: string | null | undefined): Plan {
  return isPlanKey(key) ? PLANS[key] : PLANS[DEFAULT_PLAN];
}

/** The next tier up, or null at the top. */
export function nextPlan(key: PlanKey): Plan | null {
  const i = ORDER.indexOf(key);
  return i >= 0 && i < ORDER.length - 1 ? PLANS[ORDER[i + 1]] : null;
}

/** Cents per conversation at a tier's full allowance. */
export function ratePerConversation(plan: Plan): number {
  return plan.cents / plan.conversations;
}

/**
 * "R1 250" -- space-grouped, the way rands are written here.
 *
 * Grouped by hand rather than with toLocaleString("en-ZA"), which returns a
 * non-breaking space. That renders identically and compares unequal, so any
 * code checking the output -- a test, a WhatsApp message, a snapshot -- fails
 * against a string that looks right on screen. ICU data also varies between
 * Node builds and browsers, and the price is the pitch here.
 */
export function rands(cents: number): string {
  const whole = Math.round(cents / 100);
  const sign = whole < 0 ? "-" : "";
  const digits = Math.abs(whole).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}R${grouped}`;
}

/** "R3,13" -- for per-conversation rates, where the cents matter. */
export function randsExact(cents: number): string {
  return "R" + (cents / 100).toFixed(2).replace(".", ",");
}

export function numbersLabel(plan: Plan): string {
  if (plan.numbers === null) return "Unlimited numbers";
  return plan.numbers === 1 ? "1 number" : `${plan.numbers} numbers`;
}
