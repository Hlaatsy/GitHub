import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";

/**
 * Loads the current authenticated user and their profile (if onboarding is
 * complete). Returns nulls rather than throwing so callers can redirect.
 */
export async function getCurrentProfile(): Promise<{
  userId: string | null;
  profile: Profile | null;
}> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { userId: null, profile: null };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  return { userId: user.id, profile: (profile as Profile) ?? null };
}
