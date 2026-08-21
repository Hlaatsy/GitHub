import { getSupabaseEnv } from "@/lib/supabase/env";

const PILLARS = [
  {
    title: "The Couch",
    accent: "coral",
    body: "A shared family agreement. Parents set sections; children can suggest additions for approval.",
  },
  {
    title: "Check-ins",
    accent: "lavender",
    body: "Daily mood check-ins with private notes and parent responses — kept sensitive by design.",
  },
  {
    title: "Goals",
    accent: "sage",
    body: "School goals with progress children track themselves and teacher notes parents record.",
  },
  {
    title: "Points & Rewards",
    accent: "gold",
    body: "An honest points ledger that powers a family reward catalogue and redemption requests.",
  },
] as const;

const ACCENT: Record<string, string> = {
  coral: "border-coral",
  lavender: "border-lavender",
  sage: "border-sage",
  gold: "border-gold",
};

export default function Home() {
  const { isConfigured } = getSupabaseEnv();

  return (
    <main className="min-h-screen">
      <header className="bg-gradient-to-br from-dark to-[#2A2A47] px-6 py-20 text-cream">
        <div className="mx-auto max-w-3xl">
          <p className="mb-3 text-sm uppercase tracking-[0.2em] text-cream/60">
            Family operating system
          </p>
          <h1 className="text-5xl font-bold leading-tight sm:text-6xl">
            Kinnect
          </h1>
          <p className="mt-5 max-w-xl text-lg text-cream/80">
            One place for a parent and child to share an agreement, check in on
            how they&rsquo;re doing, keep school goals on track, and make
            everyday effort count.
          </p>
        </div>
      </header>

      <section className="px-6 py-16">
        <div className="mx-auto grid max-w-3xl gap-6 sm:grid-cols-2">
          {PILLARS.map((pillar) => (
            <article
              key={pillar.title}
              className={`rounded-card border-l-4 bg-white p-6 shadow-soft ${
                ACCENT[pillar.accent]
              }`}
            >
              <h2 className="text-xl font-semibold">{pillar.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-dark/70">
                {pillar.body}
              </p>
            </article>
          ))}
        </div>

        <div className="mx-auto mt-12 max-w-3xl">
          <div className="rounded-card bg-white/60 p-5 text-sm text-dark/70 shadow-soft">
            <span className="font-semibold">Phase 1 — Foundation.</span>{" "}
            Deploy pipeline check:{" "}
            {isConfigured ? (
              <span className="font-medium text-sage">
                Supabase environment variables detected.
              </span>
            ) : (
              <span className="font-medium text-coral">
                Supabase environment variables not set yet.
              </span>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
