/**
 * Environment access that fails loudly.
 *
 * A missing secret should stop the request with a named variable, not
 * surface three frames away as "cannot read property of undefined" or, worse,
 * as a signature check that quietly passes because the secret was "".
 */

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function optional(name: string, fallback = ""): string {
  return process.env[name] || fallback;
}

export const PUBLIC_SUPABASE_URL = () => required("NEXT_PUBLIC_SUPABASE_URL");
export const PUBLIC_SUPABASE_ANON = () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
export const SITE_URL = () => optional("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
