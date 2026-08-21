import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { requireSupabaseEnv } from "./env";

/**
 * Server-side Supabase client for Server Components, Route Handlers, and
 * Server Actions. Reads/writes the Supabase auth cookies so sessions persist.
 *
 * The full auth wiring (middleware refresh, sign-in/out) lands in Phase 2;
 * this establishes the cookie-aware client the rest of the app builds on.
 */
export async function createClient() {
  const { url, anonKey } = requireSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(
        cookiesToSet: {
          name: string;
          value: string;
          options: CookieOptions;
        }[]
      ) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component without a mutable cookie store.
          // Safe to ignore when middleware is responsible for refreshing
          // the session (added in Phase 2).
        }
      },
    },
  });
}
