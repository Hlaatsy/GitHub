import Link from "next/link";
import { signOut } from "@/app/actions/auth";
import type { FamilyRole } from "@/lib/types";

export function AppHeader({
  familyName,
  displayName,
  role,
}: {
  familyName: string;
  displayName: string;
  role: FamilyRole;
}) {
  const isParent = role === "parent";
  return (
    <header className="bg-gradient-to-br from-dark to-[#2A2A47] px-6 py-8 text-cream">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4">
        <div>
          <Link href="/dashboard" className="font-serif text-2xl font-bold">
            Kinnect
          </Link>
          <p className="mt-1 text-sm text-cream/70">{familyName}</p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
              isParent ? "bg-coral/20 text-coral" : "bg-lavender/25 text-lavender"
            }`}
          >
            {displayName} · {isParent ? "Parent" : "Child"}
          </span>
          {isParent ? (
            <Link
              href="/family"
              className="rounded-full border border-cream/30 px-3 py-1 text-xs font-medium text-cream/90 transition hover:bg-cream/10"
            >
              Family
            </Link>
          ) : null}
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-full border border-cream/30 px-3 py-1 text-xs font-medium text-cream/90 transition hover:bg-cream/10"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
