import Link from "next/link";
import { ORDER, PLANS } from "@/lib/plans";
import { PlanCard } from "@/components/PlanCard";

export default function Landing() {
  return (
    <main>
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-4">
          <span className="text-lg font-bold text-emerald-ink">SwiftInbox</span>
          <Link href="/login" className="text-sm font-semibold text-emerald-ink hover:underline">
            Sign in
          </Link>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-5 pb-10 pt-12 sm:pt-16">
        <p className="label text-whatsapp-700">Krugersdorp &amp; the West Rand</p>
        <h1 className="mt-3 max-w-2xl text-balance text-4xl font-extrabold leading-[1.05] text-emerald-ink sm:text-5xl">
          Your WhatsApp, answered while you work.
        </h1>
        <p className="mt-4 max-w-xl text-lg text-muted">
          Customers message. SwiftInbox answers — in English, Afrikaans, isiZulu or
          Setswana, on the number you already use. Bookings get taken at eleven at
          night. You read the thread in the morning.
        </p>

        <div className="mt-7 flex flex-wrap gap-3">
          <Link href="/login" className="btn-go">
            Start on Starter — R300
          </Link>
          <a href="#pricing" className="btn-quiet">
            See the plans
          </a>
        </div>

        <dl className="mt-12 grid gap-4 sm:grid-cols-3">
          {[
            ["Answers in seconds", "Not when you get back to the shop."],
            ["Your languages", "It replies in whichever one the customer opened with."],
            ["Hands over", "Asks for a person? It stops and tells you."],
          ].map(([t, d]) => (
            <div key={t} className="card">
              <dt className="font-semibold text-emerald-ink">{t}</dt>
              <dd className="mt-1 text-sm text-muted">{d}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section id="pricing" className="mx-auto max-w-5xl px-5 py-12">
        <h2 className="text-2xl font-bold text-emerald-ink">Plans</h2>
        <p className="mt-1 text-muted">
          Prepaid, in rands. A conversation is one customer over 24 hours — twenty
          messages sorting out one booking counts once.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ORDER.map((key) => (
            <PlanCard
              key={key}
              plan={PLANS[key]}
              featured={key === "growth"}
              canCheckout={false}
            />
          ))}
        </div>

        <p className="mt-6 max-w-2xl text-sm text-muted">
          Run out mid-month and your customers still get a polite holding reply —
          they are never left on read. You get a WhatsApp telling you, and can move
          up a plan in a minute.
        </p>
      </section>

      <footer className="border-t border-line bg-white">
        <div className="mx-auto max-w-5xl px-5 py-8 text-sm text-muted">
          SwiftInbox · Krugersdorp, Gauteng · Paid in rands through Paystack
        </div>
      </footer>
    </main>
  );
}
