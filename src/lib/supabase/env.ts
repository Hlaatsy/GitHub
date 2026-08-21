/**
 * Reads and lightly validates the public Supabase environment variables.
 *
 * These two values are safe to expose to the browser (they are the project
 * URL and the anon key, which is protected by Row Level Security). Never read
 * the service-role key in client-reachable code.
 */
export function getSupabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  return {
    url,
    anonKey,
    isConfigured: Boolean(url && anonKey),
  };
}

/**
 * Same as {@link getSupabaseEnv} but throws if the values are missing.
 * Use this from code paths that genuinely need a live client.
 */
export function requireSupabaseEnv() {
  const { url, anonKey, isConfigured } = getSupabaseEnv();

  if (!isConfigured || !url || !anonKey) {
    throw new Error(
      "Missing Supabase environment variables. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (see .env.example)."
    );
  }

  return { url, anonKey };
}
