import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { PLANS, planOf, rands } from "@/lib/plans";

export const dynamic = "force-dynamic";

/**
 * Every client's usage on one screen.
 *
 * The role check below is a redirect, not the protection: the underlying
 * rows are guarded by RLS, so a non-manager who reached this page anyway
 * would see their own business and nothing more.
 */
export default async function Manager() {
  const supabase = supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .single();

  if (profile?.role !== "manager") redirect("/dashboard");

  const { data: rows } = await supabase
    .from("client_usage")
    .select("*")
    .order("percent_used", { ascending: false });

  const clients = rows ?? [];
  const mrrCents = clients
    .filter((c) => c.status === "active")
    .reduce((sum, c) => sum + planOf(c.plan).cents, 0);
  const atCap = clients.filter((c) => c.conversations_used >= c.conversation_limit);
  const quiet = clients.filter(
    (c) => c.conversation_limit > 0 && c.conversations_used / c.conversation_limit < 0.25,
  );

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-emerald-ink text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <span className="text-lg font-bold">SwiftInbox · Manager</span>
          <Link href="/dashboard" className="text-sm font-semibold hover:underline">
            Back to my business
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-7">
        <div className="grid gap-4 sm:grid-cols-4">
          {[
            ["Clients", String(clients.length), null],
            ["Monthly recurring", rands(mrrCents), "active subscriptions only"],
            ["At their cap", String(atCap.length), "turning customers away now"],
            ["Under 25% used", String(quiet.length), "the ones who churn"],
          ].map(([label, value, note]) => (
            <div key={label as string} className="card">
              <div className="label">{label}</div>
              <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{value}</div>
              {note && <div className="mt-0.5 text-xs text-muted">{note}</div>}
            </div>
          ))}
        </div>

        <div className="card mt-5 overflow-x-auto p-0">
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                {["Business", "Plan", "Used", "%", "Days left", "Status", "Last message"].map((h) => (
                  <th key={h} className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {clients.map((c) => {
                const pct = Number(c.percent_used ?? 0);
                return (
                  <tr key={c.id}>
                    <td className="px-4 py-3">
                      <div className="font-semibold">{c.name}</div>
                      {c.suburb && <div className="text-xs text-muted">{c.suburb}</div>}
                    </td>
                    <td className="px-4 py-3">{PLANS[c.plan as keyof typeof PLANS]?.name ?? c.plan}</td>
                    <td className="px-4 py-3 font-mono tabular-nums">
                      {c.conversations_used} / {c.conversation_limit}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-20 overflow-hidden rounded-full bg-emerald-wash">
                          <div
                            className={`h-full ${pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-400" : "bg-whatsapp"}`}
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </div>
                        <span className="font-mono text-xs tabular-nums">{pct}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums">{c.days_left}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          c.status === "active"
                            ? "bg-whatsapp-wash text-emerald-ink"
                            : c.status === "past_due"
                              ? "bg-amber-100 text-amber-900"
                              : "bg-emerald-wash text-muted"
                        }`}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {c.last_message_at
                        ? new Date(c.last_message_at).toLocaleDateString("en-ZA")
                        : "never"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {clients.length === 0 && (
          <p className="mt-4 text-sm text-muted">No clients yet.</p>
        )}
      </main>
    </div>
  );
}
