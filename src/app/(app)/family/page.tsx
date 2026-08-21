import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { InviteButton } from "@/components/family/InviteButton";

// Reads auth cookies — always render per request, never prerender at build.
export const dynamic = "force-dynamic";

import { getCurrentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Family, Invite, Profile } from "@/lib/types";

export default async function FamilyPage() {
  const { userId, profile } = await getCurrentProfile();
  if (!userId) redirect("/login");
  if (!profile) redirect("/onboarding");
  // Invite management is parent-only; the database enforces it too.
  if (profile.role !== "parent") redirect("/dashboard");

  const supabase = await createClient();

  const [{ data: family }, { data: members }, { data: invites }] =
    await Promise.all([
      supabase
        .from("families")
        .select("*")
        .eq("id", profile.family_id)
        .maybeSingle(),
      supabase
        .from("profiles")
        .select("*")
        .eq("family_id", profile.family_id)
        .order("created_at", { ascending: true }),
      supabase
        .from("invites")
        .select("*")
        .is("claimed_by", null)
        .order("created_at", { ascending: false }),
    ]);

  const familyRow = family as Family | null;
  const memberList = (members as Profile[]) ?? [];
  const openInvites = ((invites as Invite[]) ?? []).filter(
    (i) => new Date(i.expires_at) > new Date()
  );

  return (
    <>
      <AppHeader
        familyName={familyRow?.name ?? "Your family"}
        displayName={profile.display_name}
        role={profile.role}
      />
      <main className="px-6 py-12">
        <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-2">
          <section>
            <h1 className="font-serif text-2xl font-bold text-dark">Members</h1>
            <ul className="mt-4 space-y-3">
              {memberList.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between rounded-card bg-white p-4 shadow-soft"
                >
                  <span className="font-medium text-dark">
                    {m.avatar_emoji ? `${m.avatar_emoji} ` : ""}
                    {m.display_name}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      m.role === "parent"
                        ? "bg-coral/15 text-coral"
                        : "bg-lavender/20 text-lavender"
                    }`}
                  >
                    {m.role === "parent" ? "Parent" : "Child"}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h1 className="font-serif text-2xl font-bold text-dark">
              Invite a child
            </h1>
            <p className="mt-2 text-sm text-dark/60">
              Generate a code, then have them choose{" "}
              <span className="font-medium">Join with a code</span> at sign-up.
              Codes expire after 7 days.
            </p>
            <div className="mt-4 rounded-card bg-white p-6 shadow-soft">
              <InviteButton />
            </div>

            {openInvites.length > 0 ? (
              <div className="mt-6">
                <h2 className="text-sm font-semibold text-dark/70">
                  Open invites
                </h2>
                <ul className="mt-3 space-y-2">
                  {openInvites.map((inv) => (
                    <li
                      key={inv.id}
                      className="flex items-center justify-between rounded-xl bg-white px-4 py-3 shadow-soft"
                    >
                      <span className="font-mono text-lg font-bold tracking-widest text-dark">
                        {inv.code}
                      </span>
                      <span className="text-xs text-dark/50">
                        expires {new Date(inv.expires_at).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        </div>
      </main>
    </>
  );
}
