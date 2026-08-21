"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { Invite } from "@/lib/types";

export type InviteState = { error?: string; code?: string };

/**
 * Parent generates an invite code for their family. Authorization is enforced
 * in the database (create_invite raises unless the caller is a parent); this
 * action just surfaces the result.
 */
export async function createInvite(): Promise<InviteState> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_invite", {
    p_role: "child",
  });

  if (error) return { error: error.message };

  revalidatePath("/family");
  return { code: (data as Invite)?.code };
}
