import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { PUBLIC_SUPABASE_ANON, PUBLIC_SUPABASE_URL } from "../env.ts";

/** Supabase as the signed-in user. Every read through this obeys RLS. */
export function supabaseServer() {
  const store = cookies();
  return createServerClient(PUBLIC_SUPABASE_URL(), PUBLIC_SUPABASE_ANON(), {
    cookies: {
      get: (name: string) => store.get(name)?.value,
      set(name: string, value: string, options: CookieOptions) {
        try {
          store.set({ name, value, ...options });
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Middleware refreshes the session instead.
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          store.set({ name, value: "", ...options });
        } catch {
          /* as above */
        }
      },
    },
  });
}
