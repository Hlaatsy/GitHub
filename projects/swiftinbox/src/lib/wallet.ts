import { nextPlan, numbersLabel, planOf, rands, type PlanKey } from "./plans.ts";

/**
 * The prepaid wallet: what the numbers mean, and what gets said when they
 * run out.
 *
 * Pure functions, no database and no network, so the arithmetic and the
 * wording can both be tested directly. The atomic part -- deciding whether
 * this particular message is allowed -- lives in consume_conversation() in
 * supabase/schema.sql, because it has to happen under a row lock.
 */

export interface Usage {
  used: number;
  limit: number;
  periodEnd: string | Date;
}

export interface UsageView {
  used: number;
  limit: number;
  left: number;
  percent: number;
  daysLeft: number;
  /** 'ok' | 'warn' at 80% | 'full' at the cap */
  state: "ok" | "warn" | "full";
}

export function describeUsage(u: Usage, now: Date = new Date()): UsageView {
  const limit = Math.max(0, u.limit);
  const used = Math.max(0, u.used);
  const left = Math.max(0, limit - used);
  const percent = limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));

  const end = u.periodEnd instanceof Date ? u.periodEnd : new Date(u.periodEnd);
  const ms = end.getTime() - now.getTime();
  const daysLeft = Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 86_400_000)) : 0;

  const state: UsageView["state"] = used >= limit ? "full" : percent >= 80 ? "warn" : "ok";
  return { used, limit, left, percent, daysLeft, state };
}

/**
 * What the business's *customer* sees when the business has run out.
 *
 * Deliberately says nothing about plans, limits or billing. The person on
 * the other end is a member of the public who messaged a shop in
 * Krugersdorp; telling them the shop has not paid its software bill
 * embarrasses the customer we are actually selling to, and tells a stranger
 * something about their finances. They get a normal holding reply, and the
 * owner gets the nudge instead.
 */
export function holdingMessage(businessName: string): string {
  return (
    `Thanks for messaging ${businessName}. ` +
    `We have your message and someone will come back to you shortly.`
  );
}

/** What the *owner* gets, on their own number, when the wallet is empty. */
export function upgradeMessage(opts: {
  businessName: string;
  planKey: PlanKey;
  used: number;
  missed: number;
  dashboardUrl: string;
}): string {
  const plan = planOf(opts.planKey);
  const up = nextPlan(plan.key);

  const lines = [
    `SwiftInbox: ${opts.businessName} has used all ${plan.conversations} conversations on ${plan.name} this month.`,
    "",
    opts.missed === 1
      ? "1 customer has messaged since then and got a holding reply instead of an answer."
      : `${opts.missed} customers have messaged since then and got a holding reply instead of an answer.`,
  ];

  if (up) {
    const extra = up.conversations - plan.conversations;
    lines.push(
      "",
      `${up.name} is ${rands(up.cents)} a month for ${up.conversations} conversations ` +
        `(${extra} more) and ${numbersLabel(up).toLowerCase()}.`,
      `Upgrade: ${opts.dashboardUrl}`,
    );
  } else {
    lines.push(
      "",
      `You are on ${plan.name}, our largest plan. Reply here and we will sort out a bigger allowance.`,
    );
  }

  return lines.join("\n");
}

/**
 * Whether to nudge the owner now.
 *
 * Once every 24 hours. A busy shop that hits its cap on the 3rd can take
 * another sixty messages that day, and sixty identical "you have run out"
 * messages is how a useful warning becomes something the owner mutes.
 */
export function shouldNotifyOwner(lastNoticeAt: string | Date | null, now: Date = new Date()): boolean {
  if (!lastNoticeAt) return true;
  const last = lastNoticeAt instanceof Date ? lastNoticeAt : new Date(lastNoticeAt);
  if (Number.isNaN(last.getTime())) return true;
  return now.getTime() - last.getTime() >= 24 * 60 * 60 * 1000;
}
