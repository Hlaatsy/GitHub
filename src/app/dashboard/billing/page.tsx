import { supabaseServer } from "@/lib/supabase/server";
import { PlanCard } from "@/components/PlanCard";
import { ORDER, PLANS, planOf, rands } from "@/lib/plans";
import { describeUsage } from "@/lib/wallet";

export const dynamic = "force-dynamic";

export default async function Billing({
  searchParams,
}: {
  searchParams: { checkout?: string };
}) {
  const supabase = supabaseServer();

  const { data: client } = await supabase
    .from("clients")
    .select("id, name, plan, conversation_limit, conversations_used, status, period_end")
    .limit(1)
    .maybeSingle();

  const { data: payments } = await supabase
    .from("payments")
    .select("reference, amount_cents, plan, status, applied_at, created_at")
    .order("created_at", { ascending: false })
    .limit(6);

  const plan = planOf(client?.plan);
  const usage = client
    ? describeUsage({
        used: client.conversations_used,
        limit: client.conversation_limit,
        periodEnd: client.period_end,
      })
    : null;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold text-emerald-ink">Your plan</h1>
        {usage && (
          <p className="text-sm text-muted">
            On {plan.name}, {usage.used} of {usage.limit} conversations used,{" "}
            {usage.daysLeft === 1 ? "1 day" : `${usage.daysLeft} days`} to go.
          </p>
        )}
      </div>

      {searchParams.checkout === "done" && (
        <p className="rounded-xl bg-whatsapp-wash px-4 py-3 text-sm">
          Thanks — Paystack has your payment. The new allowance appears here the
          moment they confirm it, usually within a minute.
        </p>
      )}

      {client?.status === "past_due" && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Your last payment did not go through. You keep the conversations you
          have already paid for until the month ends — nothing switches off today.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {ORDER.map((key) => (
          <PlanCard
            key={key}
            plan={PLANS[key]}
            current={client?.plan === key}
            featured={key === "growth"}
          />
        ))}
      </div>

      <div className="card">
        <h2 className="font-bold text-emerald-ink">Payments</h2>
        {!payments?.length ? (
          <p className="mt-2 text-sm text-muted">Nothing yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {payments.map((p) => (
              <li key={p.reference} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="font-semibold">
                    {p.plan ? PLANS[p.plan as keyof typeof PLANS]?.name ?? p.plan : "—"}
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted">
                    {p.reference} · {new Date(p.created_at).toLocaleDateString("en-ZA")}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono font-semibold tabular-nums">
                    {rands(p.amount_cents)}
                  </div>
                  <div className="text-[11px] text-muted">
                    {p.applied_at ? "applied" : p.status}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
