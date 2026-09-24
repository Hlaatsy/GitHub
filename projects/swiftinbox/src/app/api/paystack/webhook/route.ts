import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { planKeyFromCode, verifyTransaction, verifyWebhookSignature } from "@/lib/paystack";
import { PLANS, isPlanKey, type PlanKey } from "@/lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Paystack webhook.
 *
 * Settlement is idempotent on `payments.applied_at`: Paystack retries, and a
 * replayed charge.success must not add a second month of access. The plan's
 * numbers come from src/lib/plans.ts, never from the webhook body -- a payer
 * does not get to say how many conversations they bought.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();

  if (!verifyWebhookSignature(raw, req.headers.get("x-paystack-signature"))) {
    return new NextResponse("bad signature", { status: 401 });
  }

  const event = JSON.parse(raw) as any;
  const db = supabaseAdmin();

  switch (event?.event) {
    case "charge.success":
      await applyCharge(db, event);
      break;
    case "subscription.create":
      await linkSubscription(db, event);
      break;
    case "subscription.disable":
    case "subscription.not_renew":
      await markPastDue(db, event);
      break;
    default:
      // Everything else is acknowledged and ignored; Paystack retries
      // anything it does not see a 200 for.
      break;
  }

  return NextResponse.json({ ok: true });
}

async function applyCharge(db: ReturnType<typeof supabaseAdmin>, event: any) {
  const reference: string | undefined = event?.data?.reference;
  if (!reference) return;

  // Confirm against Paystack rather than trusting the payload, then use the
  // confirmed amount and plan.
  const verified = await verifyTransaction(reference);
  if (verified?.status !== "success") return;

  const clientId: string | undefined =
    verified?.metadata?.client_id ?? event?.data?.metadata?.client_id;
  const planKey: PlanKey | null =
    (isPlanKey(verified?.metadata?.plan_key) ? verified.metadata.plan_key : null) ??
    planKeyFromCode(verified?.plan?.plan_code ?? verified?.plan);

  if (!clientId || !planKey) {
    console.error("paystack: charge without a client or plan", reference);
    return;
  }

  const plan = PLANS[planKey];

  // Claim the payment. `applied_at is null` in the filter is what makes this
  // idempotent: a replay updates zero rows and stops here.
  const { data: claimed } = await db
    .from("payments")
    .upsert(
      {
        client_id: clientId,
        reference,
        event_id: event?.id ? String(event.id) : null,
        amount_cents: verified.amount,
        plan: planKey,
        status: "success",
        raw: verified,
      },
      { onConflict: "reference", ignoreDuplicates: false },
    )
    .select("id, applied_at")
    .single();

  if (!claimed || claimed.applied_at) return;

  const { data: locked } = await db
    .from("payments")
    .update({ applied_at: new Date().toISOString() })
    .eq("id", claimed.id)
    .is("applied_at", null)
    .select("id")
    .single();

  if (!locked) return; // another delivery got there first

  // Charged amount must match the tier. A mismatch means the plan codes in
  // the environment disagree with plans.ts, and granting access on it would
  // hand out a tier nobody paid for.
  if (verified.amount !== plan.cents) {
    console.error(
      `paystack: ${reference} paid ${verified.amount} but ${planKey} costs ${plan.cents}`,
    );
    await db.from("payments").update({ status: "mismatch" }).eq("id", locked.id);
    return;
  }

  const now = new Date();
  const end = new Date(now);
  end.setMonth(end.getMonth() + 1);

  await db
    .from("clients")
    .update({
      plan: planKey,
      conversation_limit: plan.conversations,
      conversations_used: 0,
      blocked_since_cap: 0,
      upgrade_notice_at: null,
      status: "active",
      period_start: now.toISOString(),
      period_end: end.toISOString(),
      paystack_customer_code: verified?.customer?.customer_code ?? null,
    })
    .eq("id", clientId);
}

async function linkSubscription(db: ReturnType<typeof supabaseAdmin>, event: any) {
  const customerCode = event?.data?.customer?.customer_code;
  const subscriptionCode = event?.data?.subscription_code;
  if (!customerCode || !subscriptionCode) return;

  await db
    .from("clients")
    .update({ paystack_subscription_code: subscriptionCode })
    .eq("paystack_customer_code", customerCode);
}

async function markPastDue(db: ReturnType<typeof supabaseAdmin>, event: any) {
  const subscriptionCode = event?.data?.subscription_code;
  if (!subscriptionCode) return;

  // Not cancelled: they keep the conversations they have already paid for
  // until the period ends. Cutting a shop's WhatsApp off mid-month over a
  // failed card is how you lose the customer rather than the payment.
  await db
    .from("clients")
    .update({ status: "past_due" })
    .eq("paystack_subscription_code", subscriptionCode);
}
