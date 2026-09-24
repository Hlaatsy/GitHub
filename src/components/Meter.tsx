import { describeUsage } from "@/lib/wallet";

/**
 * The number the customer actually logs in to see: how much of this month's
 * allowance is gone.
 */
export function Meter({
  used,
  limit,
  periodEnd,
}: {
  used: number;
  limit: number;
  periodEnd: string;
}) {
  const u = describeUsage({ used, limit, periodEnd });

  const bar =
    u.state === "full"
      ? "bg-red-500"
      : u.state === "warn"
        ? "bg-amber-400"
        : "bg-whatsapp";

  return (
    <div className="card">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="label">Conversations this month</div>
          <div className="mt-1 font-mono text-3xl font-semibold tabular-nums">
            {u.used}
            <span className="text-muted"> / {u.limit}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl font-semibold tabular-nums">{u.percent}%</div>
          <div className="text-xs text-muted">used</div>
        </div>
      </div>

      <div
        className="mt-4 h-2.5 overflow-hidden rounded-full bg-emerald-wash"
        role="progressbar"
        aria-valuenow={u.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Conversations used this month"
      >
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${u.percent}%` }} />
      </div>

      <div className="mt-3 flex flex-wrap justify-between gap-2 text-sm text-muted">
        <span>
          {u.state === "full" ? (
            <strong className="text-red-600">No conversations left</strong>
          ) : (
            <>
              <strong className="text-ink">{u.left}</strong> left
            </>
          )}
        </span>
        <span>
          {u.daysLeft === 0
            ? "Renews today"
            : u.daysLeft === 1
              ? "1 day left in this month"
              : `${u.daysLeft} days left in this month`}
        </span>
      </div>

      {u.state === "warn" && (
        <p className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          You are past 80%. If you run out, customers still get a holding reply —
          but the assistant stops answering them properly.
        </p>
      )}
      {u.state === "full" && (
        <p className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900">
          Customers messaging you now get a holding reply instead of an answer.
          Moving up a plan starts them being answered again immediately.
        </p>
      )}
    </div>
  );
}
