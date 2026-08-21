import { getSupabaseEnv } from "@/lib/supabase/env";

type Tile = {
  title: string;
  accent: keyof typeof ACCENT;
  phase: string;
  body: string;
};

const TILES: Tile[] = [
  {
    title: "Check-ins",
    accent: "lavender",
    phase: "Phase 3",
    body: "Daily mood check-ins with private notes and parent responses — sensitive by design.",
  },
  {
    title: "The Couch",
    accent: "coral",
    phase: "Phase 4",
    body: "A shared family agreement. Parents set sections; children can suggest additions for approval.",
  },
  {
    title: "Goals",
    accent: "sage",
    phase: "Phase 5",
    body: "School goals with progress children track themselves and teacher notes parents record.",
  },
  {
    title: "Points & Rewards",
    accent: "gold",
    phase: "Phase 6",
    body: "An honest points ledger that powers a family reward catalogue and redemption requests.",
  },
  {
    title: "Responsibilities",
    accent: "coral",
    phase: "Phase 6.5",
    body: "Parents assign chores; children mark them done for approval, earning points on the same ledger.",
  },
];

const ACCENT = {
  coral: { border: "border-coral", dot: "bg-coral", pill: "text-coral" },
  lavender: {
    border: "border-lavender",
    dot: "bg-lavender",
    pill: "text-lavender",
  },
  sage: { border: "border-sage", dot: "bg-sage", pill: "text-sage" },
  gold: { border: "border-gold", dot: "bg-gold", pill: "text-gold" },
} as const;

export default function Home() {
  const { isConfigured } = getSupabaseEnv();

  return (
    <main className="min-h-screen">
      <header className="bg-gradient-to-br from-dark to-[#2A2A47] px-6 py-20 text-cream">
        <div className="mx-auto max-w-5xl">
          <p className="mb-3 text-sm uppercase tracking-[0.2em] text-cream/60">
            Family operating system
          </p>
          <h1 className="text-5xl font-bold leading-tight sm:text-6xl">
            Kinnect
          </h1>
          <p className="mt-5 max-w-xl text-lg text-cream/80">
            One place for a parent and child to share an agreement, check in on
            how they&rsquo;re doing, keep school goals on track, hand out
            everyday responsibilities, and make effort count.
          </p>
        </div>
      </header>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <div className="mb-8 flex items-baseline justify-between gap-4">
            <h2 className="text-2xl font-semibold">The family dashboard</h2>
            <span className="text-sm text-dark/50">Preview — roadmap</span>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {TILES.map((tile) => {
              const accent = ACCENT[tile.accent];
              return (
                <article
                  key={tile.title}
                  className={`rounded-card border-l-4 bg-white p-6 shadow-soft ${accent.border}`}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-xl font-semibold">{tile.title}</h3>
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs font-medium ${accent.pill}`}
                    >
                      <span className={`h-2 w-2 rounded-full ${accent.dot}`} />
                      {tile.phase}
                    </span>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-dark/70">
                    {tile.body}
                  </p>
                </article>
              );
            })}
          </div>

          <div className="mt-12">
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
        </div>
      </section>
    </main>
  );
}
