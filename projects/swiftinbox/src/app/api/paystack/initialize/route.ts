import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { initializeSubscription } from "@/lib/paystack";
import { isPlanKey } from "@/lib/plans";
import { SITE_URL } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a checkout for the signed-in user's own business.
 *
 * The plan comes from the request but the client id never does -- it is read
 * from the session. Taking it from the body would let anyone upgrade, or
 * downgrade, somebody else's account.
 */
export async function POST(req: NextRequest) {
  const supabase = supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const planKey = body?.plan;
  if (!isPlanKey(planKey)) {
    return NextResponse.json({ error: "unknown plan" }, { status: 400 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("client_id")
    .eq("id", auth.user.id)
    .single();

  if (!profile?.client_id) {
    return NextResponse.json({ error: "no business on this account" }, { status: 400 });
  }

  try {
    const init = await initializeSubscription({
      email: auth.user.email ?? "",
      planKey,
      clientId: profile.client_id,
      callbackUrl: `${SITE_URL()}/dashboard/billing?checkout=done`,
    });

    // Recorded now so the webhook has something to settle against, and so a
    // started-but-abandoned checkout is visible rather than invisible.
    await supabaseAdmin().from("payments").insert({
      client_id: profile.client_id,
      reference: init.reference,
      amount_cents: 0,
      plan: planKey,
      status: "pending",
    });

    return NextResponse.json({ url: init.authorizationUrl });
  } catch (err) {
    console.error("paystack initialise", err);
    return NextResponse.json({ error: "could not start checkout" }, { status: 502 });
  }
}
