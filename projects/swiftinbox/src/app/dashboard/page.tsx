import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/server";
import { Meter } from "@/components/Meter";
import { numbersLabel, planOf, rands } from "@/lib/plans";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const supabase = supabaseServer();

  // RLS means this returns the caller's own business and nothing else, so
  // there is no client id to pass and none to get wrong.
  const { data: client } = await supabase
    .from("clients")
    .select(
      "id, name, suburb, plan, conversation_limit, conversations_used, status, period_end, owner_wa_id",
    )
    .limit(1)
    .maybeSingle();

  if (!client) {
    return (
      <div className="card">
        <h1 className="text-xl font-bold text-emerald-ink">Almost there</h1>
        <p className="mt-2 text-muted">
          Your sign-in works, but this account is not linked to a business yet.
          Send us the WhatsApp number you want answered and we will connect it.
        </p>
      </div>
    );
  }

  const plan = planOf(client.plan);

  const { count: conversationCount } = await supabase
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("client_id", client.id);

  const { data: recent } = await supabase
    .from("messages")
    .select("id, direction, body, blocked, created_at")
    .eq("client_id", client.id)
    .order("created_at", { ascending: false })
    .limit(8);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-emerald-ink">{client.name}</h1>
          <p className="text-sm text-muted">
            {plan.name} · {rands(plan.cents)}/month · {numbersLabel(plan)}
            {client.suburb ? ` · ${client.suburb}` : ""}
          </p>
        </div>
        {client.status === "past_due" && (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">
            Payment needs attention
          </span>
        )}
      </div>

      <Meter
        used={client.conversations_used}
        limit={client.conversation_limit}
        periodEnd={client.period_end}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="card">
          <div className="label">Conversations, all time</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">
            {conversationCount ?? 0}
          </div>
        </div>
        <div className="card">
          <div className="label">Owner alerts go to</div>
          <div className="mt-1 font-mono text-lg">
            {client.owner_wa_id ?? <span className="text-muted">Not set</span>}
          </div>
          {!client.owner_wa_id && (
            <p className="mt-1 text-xs text-muted">
              Without this we cannot tell you when you run out.
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-emerald-ink">Latest messages</h2>
          <Link href="/dashboard/billing" className="text-sm font-semibold text-whatsapp-700 hover:underline">
            Change plan
          </Link>
        </div>

        {!recent?.length ? (
          <p className="mt-3 text-sm text-muted">Nothing yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {recent.map((m) => (
              <li key={m.id} className="flex gap-3 py-2.5">
                <span
                  aria-hidden
                  className={`mt-1 h-2 w-2 flex-none rounded-full ${
                    m.blocked ? "bg-red-400" : m.direction === "inbound" ? "bg-emerald-ink" : "bg-whatsapp"
                  }`}
                />
                <div className="min-w-0">
                  <p className="truncate text-sm">{m.body}</p>
                  <p className="font-mono text-[11px] text-muted">
                    {m.direction === "inbound" ? "customer" : "assistant"}
                    {m.blocked ? " · holding reply, over limit" : ""} ·{" "}
                    {new Date(m.created_at).toLocaleString("en-ZA")}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
