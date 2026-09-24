import { createClient } from "@supabase/supabase-js";
import { PUBLIC_SUPABASE_URL, required } from "../env.ts";

/**
 * Supabase as the service role. Bypasses RLS entirely.
 *
 * Only for webhook routes, which have no signed-in user: WhatsApp and
 * Paystack are talking to us, not a customer. Never import this into
 * anything that renders, and never into a "use client" file -- the key would
 * be bundled and shipped to the browser.
 */
export function supabaseAdmin() {
  return createClient(PUBLIC_SUPABASE_URL(), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
