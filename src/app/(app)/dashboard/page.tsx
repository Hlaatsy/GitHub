import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";

// Reads auth cookies — always render per request, never prerender at build.
export const dynamic = "force-dynamic";

import { getCurrentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ACCENT, TILES } from "@/lib/tiles";
import type { Family } from "@/lib/types";

export default async function DashboardPage() {
  const { userId, profile } = await getCurrentProfile();

  if (!userId) redirect("/login");
  if (!profile) redirect("/onboarding");

  const supabase = await createClient();
  const { data: familyRow } = await supabase
    .from("families")
    .select("*")
    .eq("id", profile.family_id)
    .maybeSingle();
  const family = familyRow as Family | null;

  const isParent = profile.role === "parent";

  return (
    <>
      <AppHeader
        familyName={family?.name ?? "Your family"}
        displayName={profile.display_name}
        role={profile.role}
      />
      <main className="px-6 py-12">
        <div className="mx-auto max-w-5xl">
          <h1 className="font-serif text-3xl font-bold text-dark">
            Hi {profile.display_name.split(" ")[0]} 👋
          </h1>
          <p className="mt-2 text-dark/60">
            {isParent
              ? "This is your family's home. Features below arrive as we build each phase."
              : "Welcome to your family space. More arrives as each phase ships."}
          </p>

          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {TILES.map((tile) => {
              const accent = ACCENT[tile.accent];
              return (
                <article
                  key={tile.title}
                  className={`rounded-card border-l-4 bg-white p-6 shadow-soft ${accent.border}`}
                >
                  <div className="flex items-center justify-between">
                    <h2 className="text-xl font-semibold">{tile.title}</h2>
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
        </div>
      </main>
    </>
  );
}
