"use client";

import { useState } from "react";
import { numbersLabel, rands, randsExact, ratePerConversation, type Plan } from "@/lib/plans";

export function PlanCard({
  plan,
  current,
  featured,
  canCheckout = true,
}: {
  plan: Plan;
  current?: boolean;
  featured?: boolean;
  canCheckout?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function checkout() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/paystack/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: plan.key }),
      });
      const data = await res.json();
      if (!res.ok || !data?.url) throw new Error(data?.error ?? "could not start checkout");
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <div
      className={`card flex flex-col gap-4 ${
        featured ? "border-whatsapp ring-2 ring-whatsapp/25" : ""
      }`}
    >
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-bold text-emerald-ink">{plan.name}</h3>
          {featured && (
            <span className="rounded-full bg-whatsapp-wash px-2 py-0.5 text-[11px] font-semibold text-emerald-ink">
              Most chosen
            </span>
          )}
          {current && (
            <span className="rounded-full bg-emerald-wash px-2 py-0.5 text-[11px] font-semibold text-emerald-ink">
              Your plan
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted">{plan.blurb}</p>
      </div>

      <div>
        <div className="font-mono text-3xl font-bold tabular-nums text-ink">
          {rands(plan.cents)}
          <span className="font-sans text-sm font-normal text-muted">/month</span>
        </div>
        <div className="mt-1 text-sm text-muted">
          {plan.conversations} conversations · {numbersLabel(plan)}
        </div>
        <div className="mt-0.5 font-mono text-xs text-muted">
          {randsExact(ratePerConversation(plan))} a conversation
        </div>
      </div>

      <ul className="flex flex-col gap-1.5 text-sm">
        {plan.features.map((f) => (
          <li key={f} className="flex gap-2">
            <span aria-hidden className="mt-0.5 text-whatsapp-700">✓</span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto">
        {current ? (
          <div className="btn-quiet w-full cursor-default opacity-70">Current plan</div>
        ) : canCheckout ? (
          <button className="btn-go w-full" onClick={checkout} disabled={busy}>
            {busy ? "Opening Paystack…" : `Choose ${plan.name}`}
          </button>
        ) : (
          <a className="btn-go w-full" href="/login">
            Choose {plan.name}
          </a>
        )}
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
