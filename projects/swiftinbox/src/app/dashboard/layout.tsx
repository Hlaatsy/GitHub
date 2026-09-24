import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", auth.user.id)
    .single();

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-5 py-4">
          <Link href="/dashboard" className="text-lg font-bold text-emerald-ink">
            SwiftInbox
          </Link>
          <nav className="flex items-center gap-4 text-sm font-semibold">
            <Link href="/dashboard" className="text-emerald-ink hover:underline">
              Usage
            </Link>
            <Link href="/dashboard/billing" className="text-emerald-ink hover:underline">
              Plan
            </Link>
            {profile?.role === "manager" && (
              <Link href="/manager" className="text-emerald-ink hover:underline">
                Manager
              </Link>
            )}
            <form action="/auth/signout" method="post">
              <button className="text-muted hover:underline">Sign out</button>
            </form>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-5 py-7">{children}</main>
    </div>
  );
}
