import crypto from "node:crypto";
import { optional, required } from "./env.ts";
import { PLANS, type PlanKey } from "./plans.ts";

/**
 * Paystack, in rands, for the four subscriptions.
 *
 * Paystack is used rather than Stripe because the customer is a Krugersdorp
 * SME: they pay by South African card, EFT or instant EFT, and a price in
 * rands that can only be paid by international card is not an affordable
 * price.
 */

const API = "https://api.paystack.co";

function secretKey(): string {
  return required("PAYSTACK_SECRET_KEY");
}

/**
 * Paystack plan codes, created once in the Paystack dashboard and put in the
 * environment. They are not derivable from our own keys, so a missing one is
 * a configuration error worth naming.
 */
export function planCode(key: PlanKey): string {
  const map: Record<PlanKey, string> = {
    starter: "PAYSTACK_PLAN_STARTER",
    basic: "PAYSTACK_PLAN_BASIC",
    growth: "PAYSTACK_PLAN_GROWTH",
    scale: "PAYSTACK_PLAN_SCALE",
  };
  return required(map[key]);
}

export interface InitResult {
  authorizationUrl: string;
  reference: string;
}

/**
 * Start a subscription. Paystack creates the subscription itself once the
 * first charge on a plan succeeds, so this is a transaction initialise with
 * a plan code attached rather than a separate subscription call.
 */
export async function initializeSubscription(opts: {
  email: string;
  planKey: PlanKey;
  clientId: string;
  callbackUrl: string;
}): Promise<InitResult> {
  const plan = PLANS[opts.planKey];

  const res = await fetch(`${API}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: opts.email,
      amount: plan.cents,
      currency: "ZAR",
      plan: planCode(opts.planKey),
      callback_url: opts.callbackUrl,
      metadata: {
        client_id: opts.clientId,
        plan_key: opts.planKey,
        cancel_action: opts.callbackUrl,
      },
    }),
  });

  const data = (await res.json()) as any;
  if (!res.ok || !data?.status) {
    throw new Error(`Paystack initialise failed: ${data?.message ?? res.status}`);
  }
  return {
    authorizationUrl: data.data.authorization_url,
    reference: data.data.reference,
  };
}

/** Confirm a transaction with Paystack rather than trusting the browser. */
export async function verifyTransaction(reference: string) {
  const res = await fetch(`${API}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secretKey()}` },
  });
  const data = (await res.json()) as any;
  if (!res.ok || !data?.status) {
    throw new Error(`Paystack verify failed: ${data?.message ?? res.status}`);
  }
  return data.data;
}

/**
 * Paystack signs webhooks with HMAC-SHA512 of the raw body, keyed on the
 * secret key, in the x-paystack-signature header.
 *
 * Without this check anyone who learns the endpoint can post themselves a
 * Scale subscription, so a missing or malformed signature is a rejection,
 * never a pass.
 */
export function verifyWebhookSignature(rawBody: string, header: string | null): boolean {
  if (!header) return false;
  const expected = crypto.createHmac("sha512", secretKey()).update(rawBody, "utf8").digest();
  let given: Buffer;
  try {
    given = Buffer.from(header, "hex");
  } catch {
    return false;
  }
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

/** Map a Paystack plan code back to our tier. */
export function planKeyFromCode(code: string | null | undefined): PlanKey | null {
  if (!code) return null;
  for (const key of Object.keys(PLANS) as PlanKey[]) {
    if (optional(`PAYSTACK_PLAN_${key.toUpperCase()}`) === code) return key;
  }
  return null;
}
