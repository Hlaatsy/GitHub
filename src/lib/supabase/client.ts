import { createBrowserClient } from "@supabase/ssr";
import { requireSupabaseEnv } from "./env";

/**
 * Browser-side Supabase client. Safe to call from Client Components.
 * Auth is layered on in Phase 2.
 */
export function createClient() {
  const { url, anonKey } = requireSupabaseEnv();
  return createBrowserClient(url, anonKey);
}
