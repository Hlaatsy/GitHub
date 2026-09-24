"use client";

import { createBrowserClient } from "@supabase/ssr";
import { PUBLIC_SUPABASE_ANON, PUBLIC_SUPABASE_URL } from "../env.ts";

export function supabaseBrowser() {
  return createBrowserClient(PUBLIC_SUPABASE_URL(), PUBLIC_SUPABASE_ANON());
}
